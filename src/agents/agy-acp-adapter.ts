import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CodingAgent,
  AgentDescriptor,
  AgentProcessSpawnInfo,
  AgentStartInput,
  AgentContinueInput,
} from "../domain/agent.js";
import type { AgyAcpConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { AcpClient } from "./acp/client.js";
import {
  decideAcpToolPermission,
  type AcpTaskMode,
  type AcpToolCallShape,
} from "./acp/permission-policy.js";

/**
 * Phase 2A slice 1: experimental `agy-acp` adapter (NOT wired into
 * TaskManager/ProcessManager yet).
 *
 * Scope of this slice:
 * - Registered only when `agents.agy-acp.enabled === true` (see
 *   `AgentRegistry`); legacy `muse`/`agy` behavior is unchanged.
 * - Safe executable availability via the configured `acp_executable`.
 *   A missing binary reports `available: false` and every runtime use
 *   fails with a typed `CodingAgentError`. This adapter NEVER falls back
 *   to the legacy `agy` binary.
 * - Isolated per-task `HOME`/`GEMINI_HOME` under `state_dir` with
 *   restrictive permissions and ambient Google credential stripping.
 *   No host `HOME` credential reuse, no OAuth UI, no real auth yet.
 * - One adapter-level ACP runtime helper (`runAcpTurn`) that spawns an
 *   ACP kernel over stdio (used with the existing fake kernel fixture in
 *   tests) and drives `initialize -> session/new -> session/prompt`.
 *   Inbound `session/request_permission` probes are answered with the
 *   real phase-1 `decideAcpToolPermission` policy (fail-closed when the
 *   mode/policy context is missing); there is no allow-all placeholder.
 */

export interface AgyAcpIsolatedEnv {
  env: Record<string, string>;
  taskDir: string;
  homeDir: string;
  geminiHome: string;
}

export interface AcpTurnResult {
  sessionId: string;
  assistantText: string;
  stopReason: string;
}

export interface AcpTurnOptions {
  /** User instruction sent as the `session/prompt` prompt. Required. */
  prompt: string;
  /** ACP kernel binary. Defaults to the configured `acp_executable`. */
  executable?: string;
  /** Extra argv for the kernel. Defaults to `[]`. */
  args?: string[];
  /** Working directory for the kernel process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Overall turn timeout. Defaults to `default_timeout_seconds * 1000`. */
  timeoutMs?: number;
  /** When set, the kernel is spawned with an isolated per-task env. */
  taskId?: string;
  /** Base env merged under the isolated overrides (or used as-is). */
  baseEnv?: Record<string, string>;
  /** Full explicit env for the kernel (takes precedence over taskId env). */
  env?: Record<string, string>;
  /** Optional model hint forwarded to `session/new`. */
  model?: string;
  /**
   * Workspace root the permission policy contains tool calls to. When
   * omitted, every inbound permission request is denied (fail-closed).
   */
  workspaceRoot?: string;
  /**
   * Task mode driving the permission policy (`implement` allows gated
   * contained writes; `review`/`investigate` are read-only). When omitted
   * or unrecognized, every inbound permission request is denied.
   */
  mode?: AcpTaskMode;
  /** Write gate; defaults to the configured `allow_write_worktree`. */
  allowWriteWorktree?: boolean;
}

/** Fail-closed context for answering an inbound permission request. */
export interface AcpPermissionContext {
  workspaceRoot?: unknown;
  mode?: unknown;
  allowWriteWorktree?: boolean;
}

export interface AcpPermissionAnswer {
  decision: "allow" | "deny";
  reason: string;
}

function expandHomeDir(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function isValidTaskId(taskId: string): boolean {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) return false;
  return true;
}

/** Env prefixes stripped from isolated task environments (no host reuse). */
const STRIPPED_ENV_PREFIXES = ["GOOGLE_", "GEMINI_", "ANTIGRAVITY_"] as const;

function shouldStripEnvKey(key: string): boolean {
  return STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Copy an env mapping minus ambient cloud-credential variables. */
function stripCredentialEnv(source: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (shouldStripEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Safe availability probe for the configured ACP executable. Filesystem
 * only — never spawns the kernel, never touches the network, never falls
 * back to another binary.
 *
 * - Paths containing a separator must be an existing regular file
 *   (directories and other non-files report unavailable).
 * - Bare commands must resolve to an executable on `PATH` (`X_OK`).
 */
export async function isAcpExecutableAvailable(executable: string): Promise<boolean> {
  const trimmed = (executable ?? "").trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("/") || trimmed.includes(path.sep)) {
    try {
      const stat = await fs.promises.stat(path.resolve(expandHomeDir(trimmed)));
      return stat.isFile();
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      await fs.promises.access(path.join(dir, trimmed), fs.constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

function chmodBestEffort(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Non-POSIX filesystems: permissions are best-effort, isolation is not.
  }
}

function extractAssistantText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "";
  const record = result as Record<string, unknown>;
  for (const key of ["assistantText", "text", "message", "output", "response"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const content = record.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block !== null && typeof block === "object" && !Array.isArray(block)) {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string" && text.length > 0) parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

export class AgyAcpAdapter implements CodingAgent {
  public readonly id = "agy-acp";
  public readonly displayName = "Antigravity ACP";
  private readonly config: AgyAcpConfig;

  constructor(config: AgyAcpConfig) {
    this.config = config;
  }

  public async describe(): Promise<AgentDescriptor> {
    const capabilities: AgentDescriptor["capabilities"] = ["modify_files", "resume_session"];
    if (!this.config.enabled) {
      return { id: this.id, displayName: this.displayName, available: false, capabilities };
    }
    const executable = (this.config.acp_executable ?? "").trim() || "agy_acp_server";
    const available = await isAcpExecutableAvailable(executable);
    return { id: this.id, displayName: this.displayName, available, capabilities };
  }

  /** Public probe used by tests and by `describe()`. */
  public async isExecutableAvailable(): Promise<boolean> {
    const executable = (this.config.acp_executable ?? "").trim() || "agy_acp_server";
    return isAcpExecutableAvailable(executable);
  }

  /**
   * Build an isolated per-task environment under `state_dir`.
   *
   * Layout: `<state_dir>/tasks/<taskId>/home` becomes `HOME`, with
   * `GEMINI_HOME` at `<home>/.gemini`. Directories are created `0700`
   * (best-effort chmod on non-POSIX filesystems).
   *
   * Ambient `GOOGLE_*` / `GEMINI_*` / `ANTIGRAVITY_*` variables are
   * stripped and host `HOME` credentials are never copied or reused.
   * No OAuth UI or real auth is performed in this slice.
   */
  public buildIsolatedEnv(
    taskId: string,
    baseEnv: Record<string, string> = {}
  ): AgyAcpIsolatedEnv {
    if (!isValidTaskId(taskId)) {
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Invalid task id for agy-acp isolated environment: '${taskId}'`,
        { taskId }
      );
    }
    const stateDirRaw = this.config.state_dir || "~/.coding-agent-mcp/agy-acp";
    const stateDir = path.resolve(expandHomeDir(stateDirRaw));
    const taskDir = path.join(stateDir, "tasks", taskId);
    const homeDir = path.join(taskDir, "home");
    const geminiHome = path.join(homeDir, ".gemini");

    try {
      fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Failed to initialize isolated agy-acp environment for task '${taskId}': ${err?.message ?? String(err)}`,
        { taskId, stateDir }
      );
    }
    chmodBestEffort(taskDir, 0o700);
    chmodBestEffort(homeDir, 0o700);
    chmodBestEffort(geminiHome, 0o700);

    const env: Record<string, string> = stripCredentialEnv(baseEnv);
    // Explicit overrides win over anything ambient; host HOME is never reused.
    env.HOME = homeDir;
    env.GEMINI_HOME = geminiHome;
    return { env, taskDir, homeDir, geminiHome };
  }

  /** Alias kept for test discoverability; identical to `buildIsolatedEnv`. */
  public createIsolatedEnv(
    taskId: string,
    baseEnv: Record<string, string> = {}
  ): AgyAcpIsolatedEnv {
    return this.buildIsolatedEnv(taskId, baseEnv);
  }

  private static extractToolCall(params: unknown): AcpToolCallShape | undefined {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      return undefined;
    }
    const record = params as Record<string, unknown>;
    const nested = record.toolCall;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as AcpToolCallShape;
    }
    // Some kernels may send the tool call itself as the request params.
    if (typeof record.tool === "string" || typeof record.kind === "string") {
      return record as unknown as AcpToolCallShape;
    }
    return undefined;
  }

  /**
   * Answer one inbound `session/request_permission` payload with the real
   * phase-1 `decideAcpToolPermission` policy. Fail-closed: a missing or
   * unrecognized `mode`, a missing `workspaceRoot`, or an unauditable
   * (missing/unshaped) tool call is denied without consulting anything
   * else. `review`/`investigate` deny all writes; `implement` writes
   * require the explicit `allowWriteWorktree` gate plus containment.
   */
  public decidePermissionRequest(
    params: unknown,
    context: AcpPermissionContext
  ): AcpPermissionAnswer {
    const workspaceRoot = context.workspaceRoot;
    if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
      return {
        decision: "deny",
        reason: "Denied permission request: no workspaceRoot policy context (fail-closed)",
      };
    }
    const mode = context.mode;
    if (mode !== "implement" && mode !== "review" && mode !== "investigate") {
      return {
        decision: "deny",
        reason: `Denied permission request: unknown or missing task mode '${String(mode)}' (fail-closed)`,
      };
    }
    const toolCall = AgyAcpAdapter.extractToolCall(params);
    if (!toolCall) {
      return {
        decision: "deny",
        reason: "Denied permission request: no auditable tool call payload (fail-closed)",
      };
    }
    const verdict = decideAcpToolPermission({
      workspaceRoot,
      mode,
      allowWriteWorktree: context.allowWriteWorktree ?? this.config.allow_write_worktree ?? false,
      toolCall,
    });
    return { decision: verdict.allowed ? "allow" : "deny", reason: verdict.reason };
  }

  /**
   * Spawn an ACP kernel over stdio and drive one
   * `initialize -> session/new -> session/prompt` turn.
   *
   * Inbound `session/request_permission` probes (as emitted by the fake
   * kernel fixture) are answered with the real phase-1
   * `decideAcpToolPermission` policy parameterized by `workspaceRoot`,
   * `mode`, and `allowWriteWorktree`. Missing mode/policy context denies
   * (fail-closed); the turn itself still completes because the fake kernel
   * finishes on any answer. Slice 2 adds TaskManager lifecycle and
   * transcript plumbing. This helper is NOT called by TaskManager yet.
   *
   * A missing binary fails with typed `AGENT_NOT_AVAILABLE` and NEVER
   * falls back to the legacy `agy` binary.
   */
  public async runAcpTurn(options: AcpTurnOptions): Promise<AcpTurnResult> {
    const prompt = options.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new CodingAgentError(ErrorCodes.INTERNAL_ERROR, "AgyAcpAdapter requires a non-empty prompt", {});
    }
    const configured = ((options.executable ?? this.config.acp_executable ?? "agy_acp_server") + "").trim();
    if (configured.length === 0) {
      throw new CodingAgentError(
        ErrorCodes.AGENT_NOT_AVAILABLE,
        "Coding agent 'agy-acp' has no ACP executable configured",
        { agent: this.id }
      );
    }
    // Fail closed: this adapter must never execute the legacy CLI.
    if (configured === "agy" || configured.endsWith("/agy")) {
      throw new CodingAgentError(
        ErrorCodes.INTERNAL_ERROR,
        "AgyAcpAdapter must never fall back to the legacy 'agy' binary; configure acp_executable",
        { agent: this.id, executable: configured }
      );
    }
    if (!(await isAcpExecutableAvailable(configured))) {
      throw new CodingAgentError(
        ErrorCodes.AGENT_NOT_AVAILABLE,
        `Coding agent 'agy-acp' executable '${configured}' was not found or is not runnable`,
        { agent: this.id, executable: configured }
      );
    }
    // `spawn` performs no shell expansion, so resolve `~` the same way the
    // availability probe does; anything else passes through untouched.
    const executable = expandHomeDir(configured);

    const args = options.args ?? [];
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs =
      options.timeoutMs ?? (this.config.default_timeout_seconds ?? 1800) * 1000;
    const model = options.model ?? this.config.model;
    const permissionContext: AcpPermissionContext = {
      workspaceRoot: options.workspaceRoot,
      mode: options.mode,
      allowWriteWorktree: options.allowWriteWorktree,
    };

    let spawnEnv: Record<string, string>;
    if (options.env) {
      spawnEnv = stripCredentialEnv(options.env);
    } else if (options.taskId) {
      spawnEnv = this.buildIsolatedEnv(options.taskId, options.baseEnv ?? {}).env;
    } else {
      spawnEnv = stripCredentialEnv(options.baseEnv ?? {});
    }
    if (!spawnEnv.PATH && process.env.PATH) spawnEnv.PATH = process.env.PATH;

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to spawn ACP executable '${executable}': ${err?.message ?? String(err)}`,
        { agent: this.id, executable, cwd }
      );
    }

    return await new Promise<AcpTurnResult>((resolve, reject) => {
      let settled = false;
      const client = new AcpClient({
        sendLine: (line) => {
          if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
            throw new Error("ACP transport stdin is closed");
          }
          child.stdin.write(`${line}\n`);
        },
        defaultTimeoutMs: Math.max(1000, Math.min(timeoutMs, 120_000)),
        // Real phase-1 policy: the fake kernel's probe shape
        // (`{ toolCall, ... }`) is answered allow/deny per workspaceRoot,
        // mode, and the write gate. Unknown inbound methods are rejected
        // as JSON-RPC errors (fail-closed), never answered blindly.
        onRequest: (method, params) => {
          if (method !== "session/request_permission") {
            throw new Error(`Unsupported inbound ACP request: '${method}'`);
          }
          return this.decidePermissionRequest(params, permissionContext);
        },
      });

      const overallTimer = setTimeout(() => {
        settleReject(
          new CodingAgentError(
            ErrorCodes.TASK_TIMEOUT,
            `ACP turn timed out after ${timeoutMs}ms`,
            { agent: this.id, timeoutMs }
          )
        );
      }, timeoutMs);
      // Neither timer keeps the event loop alive on its own.
      (overallTimer as unknown as { unref?: () => void }).unref?.();
      let killEscalation: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        clearTimeout(overallTimer);
        try {
          client.close("agy-acp turn settled");
        } catch {
          // ignore
        }
        try {
          child.stdin?.destroy();
        } catch {
          // ignore
        }
        try {
          child.kill();
        } catch {
          // ignore
        }
        // A kernel that ignores SIGTERM must not linger: escalate once.
        try {
          clearTimeout(killEscalation);
          killEscalation = setTimeout(() => {
            try {
              if (child.exitCode === null) child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 3000);
          (killEscalation as unknown as { unref?: () => void }).unref?.();
        } catch {
          // ignore
        }
      };

      const settleResolve = (value: AcpTurnResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          client.receiveChunk(chunk);
        } catch {
          // Framing errors are terminal inside the client; the pending
          // request below surfaces them. Nothing else to do here.
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        client.handleStderrChunk(chunk);
      });
      child.on("error", (err: Error) => {
        settleReject(
          new CodingAgentError(
            ErrorCodes.PROCESS_START_FAILED,
            `Failed to spawn ACP executable '${executable}': ${err.message}`,
            { agent: this.id, executable, cwd, error: err.message }
          )
        );
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        // Drain a final unterminated line, if any: a kernel that writes its
        // result without a trailing newline and exits can still complete
        // the in-flight request. The resolve path below is queued before
        // this rejection check, so a rescued result wins.
        try {
          client.flush();
        } catch {
          // Terminal handling lives inside the client; the pending request
          // surfaces it below.
        }
        queueMicrotask(() => {
          if (settled) return;
          settleReject(
            new CodingAgentError(
              ErrorCodes.PROCESS_START_FAILED,
              `ACP kernel exited before the turn completed (code ${String(code)}, signal ${String(signal)})`,
              {
                agent: this.id,
                executable,
                code,
                signal,
                stderrTail: client.getStderrTail().slice(-2000),
              }
            )
          );
        });
      });

      void (async () => {
        try {
          await client.initialize({ protocolVersion: 1 });
          const created = await client.sessionNew({
            cwd,
            ...(model ? { model } : {}),
          });
          const rawSessionId = (created as Record<string, unknown>).sessionId;
          if (typeof rawSessionId !== "string" || rawSessionId.trim().length === 0) {
            throw new CodingAgentError(
              ErrorCodes.INTERNAL_ERROR,
              "ACP session/new did not return a sessionId",
              { agent: this.id }
            );
          }
          const sessionId = rawSessionId.trim();
          const answer = (await client.sessionPrompt({
            sessionId,
            prompt,
          })) as Record<string, unknown>;
          const rawStopReason = answer.stopReason;
          const stopReason =
            typeof rawStopReason === "string" && rawStopReason.trim().length > 0
              ? rawStopReason.trim()
              : "unknown";
          settleResolve({ sessionId, assistantText: extractAssistantText(answer), stopReason });
        } catch (err) {
          settleReject(err);
        }
      })();
    });
  }

  /** Alias kept for test discoverability; identical to `runAcpTurn`. */
  public async runTurn(options: AcpTurnOptions): Promise<AcpTurnResult> {
    return this.runAcpTurn(options);
  }

  // CodingAgent conformance: TaskManager wiring lands in slice 2, so direct
  // lifecycle use fails closed with a typed error instead of silently
  // spawning the wrong binary.
  public async prepareStart(_input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    throw new CodingAgentError(
      ErrorCodes.INTERNAL_ERROR,
      "AgyAcpAdapter is not wired into TaskManager yet (phase 2A slice 2); use runAcpTurn for adapter-level turns",
      { agent: this.id }
    );
  }

  public async prepareContinue(_input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    throw new CodingAgentError(
      ErrorCodes.INTERNAL_ERROR,
      "AgyAcpAdapter is not wired into TaskManager yet (phase 2A slice 2)",
      { agent: this.id }
    );
  }
}
