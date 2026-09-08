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
  type ManagedStartInput,
  type ManagedStartResult,
  type ManagedContinueInput,
  type ManagedContinueResult,
  type ManagedCancelInput,
  type ManagedCancelResult,
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
 * - Isolated per-task `HOME` under `state_dir` with a persistent
 *   provider profile (`<state_dir>/profile/.gemini` as `GEMINI_HOME`)
 *   shared across tasks, restrictive permissions, ambient Google
 *   credential stripping, and forced file credential storage. No host
 *   `HOME` credential reuse.
 * - One adapter-level ACP runtime helper (`runAcpTurn`) that spawns an
 *   ACP kernel over stdio (used with the existing fake kernel fixture in
 *   tests) and drives `initialize -> session/new -> session/prompt`
 *   (or `initialize -> session/resume -> session/prompt` for continues).
 *   On the official kernel's narrow auth-required failure (JSON-RPC
 *   -32000 mentioning authentication/`authenticate`), exactly one ACP
 *   `authenticate` (`{ methodId: <configured auth_method> }`) is sent
 *   and the session call is retried exactly once; never preemptively,
 *   never in a loop. Inbound `session/request_permission` probes are
 *   answered with the real phase-1 `decideAcpToolPermission` policy
 *   (fail-closed when the mode/policy context is missing); there is no
 *   allow-all placeholder.
 */

export interface AgyAcpIsolatedEnv {
  env: Record<string, string>;
  taskDir: string;
  homeDir: string;
  geminiHome: string;
  /** Persistent provider profile dir (`<state_dir>/profile`); `geminiHome` lives inside it. */
  profileDir: string;
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
   * Existing session id to resume via `session/resume` instead of creating
   * a new session via `session/new`. When omitted, a new session is created.
   * When present, it must be non-empty after trimming.
   */
  sessionId?: string;
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

/**
 * Live-turn context owned by `runAcpTurn` for managed cancellation. Only
 * carries what `cancelManagedTask` needs: the kernel child, the protocol
 * client once constructed, the current session id once established, and a
 * turn-settled signal resolved exactly once at settle time.
 */
interface ActiveAcpTurn {
  child: ChildProcess;
  client?: AcpClient;
  sessionId?: string;
  settled: Promise<void>;
  markSettled: () => void;
  /** True once a `session/cancel` RPC has been attempted (no duplicate RPCs). */
  cancelRpcSent: boolean;
  /** Kernel acknowledgement of the cancel RPC, when one was attempted. */
  cancelAcknowledged?: boolean;
  /** The single per-turn SIGKILL escalation timer, when armed. */
  killEscalation?: ReturnType<typeof setTimeout>;
}

/** Resolve true when `settled` resolves first, false on timeout. Never hangs. */
function waitForTurnSettled(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([settled.then(() => true), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
 * Narrow official-kernel auth-required detector for `session/new` and
 * `session/resume` failures.
 *
 * True only when ALL hold:
 * - a typed `CodingAgentError` from the ACP client,
 * - JSON-RPC `code === -32000` in `details`,
 * - `details.method` is `session/new` or `session/resume` (never
 *   `authenticate` itself, so an authenticate failure cannot retrigger),
 * - the message and/or `details.data` mentions authentication (covers
 *   `Authentication required`, `call authenticate ...`, and the official
 *   `auth.type` hint).
 *
 * Any other `-32000` (quota, unknown method, unrelated kernel errors)
 * returns false and must surface unchanged without an `authenticate` call.
 */
export function isAcpAuthRequiredError(err: unknown): boolean {
  if (!(err instanceof CodingAgentError)) return false;
  const details = (err.details ?? {}) as Record<string, unknown>;
  if (details.code !== -32000) return false;
  const method = details.method;
  if (method !== "session/new" && method !== "session/resume") return false;
  const parts: string[] = [];
  if (typeof err.message === "string" && err.message.length > 0) parts.push(err.message);
  const data = details.data;
  if (typeof data === "string") {
    parts.push(data);
  } else if (data !== undefined) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      parts.push(String(data));
    }
  }
  const hay = parts.join("\n").toLowerCase();
  return hay.includes("authenticat") || hay.includes("auth.type") || hay.includes("auth required");
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
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();

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
   * Layout: `<state_dir>/tasks/<taskId>/home` becomes per-task `HOME`;
   * `GEMINI_HOME` is one persistent provider profile at
   * `<state_dir>/profile/.gemini` shared across tasks so official-kernel
   * OAuth credentials survive per-task isolation. All directories are
   * created `0700` (best-effort chmod on non-POSIX filesystems).
   *
   * Ambient `GOOGLE_*` / `GEMINI_*` / `ANTIGRAVITY_*` variables are
   * stripped (including any host `GEMINI_HOME`) and host `HOME`
   * credentials are never copied or reused. File credential storage is
   * always forced via `AGY_ACP_FORCE_FILE_STORAGE=1`.
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
    const profileDir = path.join(stateDir, "profile");
    const geminiHome = path.join(profileDir, ".gemini");

    try {
      fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
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
    chmodBestEffort(profileDir, 0o700);
    chmodBestEffort(geminiHome, 0o700);

    const env: Record<string, string> = stripCredentialEnv(baseEnv);
    // Explicit overrides win over anything ambient; host HOME is never reused.
    env.HOME = homeDir;
    env.GEMINI_HOME = geminiHome;
    // T3 Code parity: the isolated kernel always uses file credential
    // storage; a host-provided value must never override this.
    env.AGY_ACP_FORCE_FILE_STORAGE = "1";
    return { env, taskDir, homeDir, geminiHome, profileDir };
  }

  /** Alias kept for test discoverability; identical to `buildIsolatedEnv`. */
  public createIsolatedEnv(
    taskId: string,
    baseEnv: Record<string, string> = {}
  ): AgyAcpIsolatedEnv {
    return this.buildIsolatedEnv(taskId, baseEnv);
  }

  /** Configured ACP auth method id forwarded to `authenticate` (defaults to oauth-personal). */
  private getAuthMethodId(): string {
    const raw = (this.config as { auth_method?: unknown }).auth_method;
    return typeof raw === "string" && raw.length > 0 ? raw : "oauth-personal";
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
   * `initialize -> session/new -> session/prompt` turn, or
   * `initialize -> session/resume -> session/prompt` when
   * `options.sessionId` names an existing session.
   *
   * Authentication is lazy, never preemptive: `session/new` (or
   * `session/resume`) is attempted normally first. Only when it fails
   * with the official kernel's narrow auth-required condition (JSON-RPC
   * -32000 mentioning authentication/`authenticate`; see
   * {@link isAcpAuthRequiredError}), one ACP `authenticate`
   * (`{ methodId: <configured auth_method> }`) is sent and the same
   * session call is retried exactly once with the same session id. A
   * resume retry never invents a new session via `session/new`. Any
   * `authenticate` or retry failure surfaces unchanged; unrelated
   * `-32000` errors never trigger `authenticate`.
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
    // A resume request names an existing session; validate before spawning.
    let resumeSessionId: string | undefined;
    if (options.sessionId !== undefined) {
      resumeSessionId = (options.sessionId ?? "").trim();
      if (resumeSessionId.length === 0) {
        throw new CodingAgentError(
          ErrorCodes.TASK_NOT_RESUMABLE,
          "AgyAcpAdapter requires a non-empty existing sessionId to resume a session",
          { agent: this.id }
        );
      }
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
    // The spawned kernel always uses file credential storage; host values
    // via env/baseEnv cannot override it.
    spawnEnv.AGY_ACP_FORCE_FILE_STORAGE = "1";
    if (!spawnEnv.PATH && process.env.PATH) spawnEnv.PATH = process.env.PATH;

    const turnKey =
      typeof options.taskId === "string" && options.taskId.length > 0
        ? options.taskId
        : undefined;
    if (turnKey !== undefined && this.activeTurns.has(turnKey)) {
      throw new CodingAgentError(
        ErrorCodes.INTERNAL_ERROR,
        `AgyAcpAdapter already has an active turn for task '${turnKey}'`,
        { agent: this.id, taskId: turnKey }
      );
    }

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

    // Install the cancel context immediately after spawning. The
    // check-and-set is synchronous (no await in between), so a concurrent
    // turn for the same task id cannot slip past the pre-spawn guard.
    let activeTurn: ActiveAcpTurn | undefined;
    if (turnKey !== undefined) {
      if (this.activeTurns.has(turnKey)) {
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
        throw new CodingAgentError(
          ErrorCodes.INTERNAL_ERROR,
          `AgyAcpAdapter already has an active turn for task '${turnKey}'`,
          { agent: this.id, taskId: turnKey }
        );
      }
      let markSettled!: () => void;
      const settledPromise = new Promise<void>((resolveSettled) => {
        markSettled = resolveSettled;
      });
      activeTurn = {
        child,
        client: undefined,
        sessionId: undefined,
        settled: settledPromise,
        markSettled,
        cancelRpcSent: false,
      };
      this.activeTurns.set(turnKey, activeTurn);
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
      if (activeTurn) activeTurn.client = client;

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
        // A cancel-owned fallback arms the same per-turn timer, so a
        // managed cancel racing this cleanup can never double-arm SIGKILL.
        if (activeTurn) {
          this.scheduleKillEscalation(activeTurn);
        } else {
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
        }
      };

      // Mark the turn settled and drop the cancel-registry entry BEFORE
      // transport teardown: a concurrent cancel waiter must observe
      // settlement and can never hang on a removed-but-unmarked turn.
      const settleTurnContext = (): void => {
        if (turnKey === undefined || !activeTurn) return;
        if (this.activeTurns.get(turnKey) === activeTurn) {
          activeTurn.markSettled();
          this.activeTurns.delete(turnKey);
        }
      };

      const settleResolve = (value: AcpTurnResult): void => {
        if (settled) return;
        settled = true;
        settleTurnContext();
        cleanup();
        resolve(value);
      };
      const settleReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        settleTurnContext();
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
          const authMethodId = this.getAuthMethodId();
          const authenticateOnce = (): Promise<unknown> =>
            client.authenticate({ methodId: authMethodId });
          let sessionId: string;
          if (resumeSessionId !== undefined) {
            // Continue path: resume the existing session. `session/new`
            // must NOT be called here — including on the auth retry path.
            const resumeOnce = (): Promise<Record<string, unknown>> =>
              client.sessionResume({
                sessionId: resumeSessionId,
              }) as unknown as Promise<Record<string, unknown>>;
            let resumed: Record<string, unknown>;
            try {
              resumed = await resumeOnce();
            } catch (err) {
              if (!isAcpAuthRequiredError(err)) throw err;
              // One lazy authenticate, then exactly one resume retry
              // with the same session id. Never loops; an authenticate
              // or retry failure surfaces unchanged.
              await authenticateOnce();
              resumed = await resumeOnce();
            }
            const returnedId = resumed.sessionId;
            if (
              typeof returnedId === "string" &&
              returnedId.trim().length > 0 &&
              returnedId.trim() !== resumeSessionId
            ) {
              throw new CodingAgentError(
                ErrorCodes.INTERNAL_ERROR,
                `ACP session/resume returned a different sessionId ('${returnedId.trim()}') than requested ('${resumeSessionId}')`,
                { agent: this.id, requestedSessionId: resumeSessionId }
              );
            }
            sessionId = resumeSessionId;
          } else {
            const newOnce = (): Promise<Record<string, unknown>> =>
              client.sessionNew({
                cwd,
                mcpServers: [],
                ...(model ? { model } : {}),
              }) as unknown as Promise<Record<string, unknown>>;
            let created: Record<string, unknown>;
            try {
              created = await newOnce();
            } catch (err) {
              if (!isAcpAuthRequiredError(err)) throw err;
              // One lazy authenticate, then exactly one session/new
              // retry. Never preemptive, never loops; an authenticate or
              // retry failure surfaces unchanged.
              await authenticateOnce();
              created = await newOnce();
            }
            const rawSessionId = (created as Record<string, unknown>).sessionId;
            if (typeof rawSessionId !== "string" || rawSessionId.trim().length === 0) {
              throw new CodingAgentError(
                ErrorCodes.INTERNAL_ERROR,
                "ACP session/new did not return a sessionId",
                { agent: this.id }
              );
            }
            sessionId = rawSessionId.trim();
          }
          if (activeTurn) activeTurn.sessionId = sessionId;
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

  /**
   * Managed-start hook (thin wrapper around `runAcpTurn`).
   *
   * Maps `ManagedStartInput` onto `runAcpTurn` options, streams only
   * normalized assistant text plus permission decision lines through
   * `onOutput` (never raw protocol), and normalizes the turn outcome to
   * a `ManagedStartResult`.
   */
  public async runManagedStart(input: ManagedStartInput): Promise<ManagedStartResult> {
    const onOutput = input.onOutput;
    const decisions: AcpPermissionAnswer[] = [];
    const boundDecide = this.decidePermissionRequest.bind(this);
    const wrappedDecide = (
      params: unknown,
      context: AcpPermissionContext
    ): AcpPermissionAnswer => {
      const answer = boundDecide(params, context);
      decisions.push(answer);
      try {
        onOutput?.(answer.reason);
      } catch {
        // Observer-only; a failing sink must not break the turn.
      }
      return answer;
    };
    const hadOwn = Object.prototype.hasOwnProperty.call(
      this,
      "decidePermissionRequest"
    );
    const prevOwn = (this as unknown as Record<string, unknown>)
      .decidePermissionRequest;
    (this as unknown as Record<string, unknown>).decidePermissionRequest =
      wrappedDecide;
    try {
      let turn: AcpTurnResult;
      try {
        turn = await this.runAcpTurn({
          prompt: input.instruction,
          taskId: input.taskId,
          workspaceRoot: input.workspaceRoot,
          cwd: input.workspaceRoot,
          mode: input.mode,
          timeoutMs: input.timeoutMs,
          baseEnv: input.environment,
          allowWriteWorktree: this.config.allow_write_worktree ?? false,
        });
      } catch (err) {
        if (err instanceof CodingAgentError) {
          return {
            status: "failed",
            stopReason: "error",
            failureCode: err.code,
            failureMessage: err.message,
            ...(err.details !== undefined
              ? { failureDetails: err.details }
              : {}),
          };
        }
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          stopReason: "error",
          failureCode: ErrorCodes.INTERNAL_ERROR,
          failureMessage: message || "Managed ACP start failed",
        };
      }

      const sessionId =
        typeof turn.sessionId === "string" ? turn.sessionId : "";
      const assistantText =
        typeof turn.assistantText === "string" ? turn.assistantText : "";
      const stopReason =
        typeof turn.stopReason === "string" && turn.stopReason.length > 0
          ? turn.stopReason
          : "unknown";
      const rawOutcome = (turn as unknown as Record<string, unknown>)
        .permissionOutcome;
      const outcome =
        typeof rawOutcome === "string" ? rawOutcome.trim().toLowerCase() : "";
      const lowerStop = stopReason.trim().toLowerCase();
      const isDenyOutcome = outcome === "deny" || outcome === "denied";
      const isDenialStop =
        lowerStop === "deny" ||
        lowerStop === "denied" ||
        lowerStop === "permission_denied" ||
        lowerStop === "permission-denied" ||
        lowerStop === "policy_denied" ||
        lowerStop === "policy-denied";
      const hadDenyDecision = decisions.some((d) => d.decision === "deny");

      if (assistantText.length > 0) {
        try {
          onOutput?.(assistantText);
        } catch {
          // Observer-only; ignore sink failures.
        }
      }

      if (
        stopReason === "cancelled" ||
        lowerStop === "cancelled" ||
        lowerStop === "canceled" ||
        lowerStop === "cancel"
      ) {
        return {
          status: "cancelled",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          ...(assistantText.length > 0 ? { assistantText } : {}),
        };
      }

      if (isDenyOutcome || isDenialStop) {
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.POLICY_DENIED,
          failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
            ...(typeof rawOutcome === "string" && rawOutcome.length > 0
              ? { permissionOutcome: rawOutcome }
              : {}),
          },
        };
      }

      if (stopReason === "end_turn" && assistantText.trim().length > 0) {
        return {
          status: "completed",
          sessionId,
          sessionResumable: true,
          assistantText,
          stopReason,
        };
      }

      if (stopReason === "end_turn") {
        if (hadDenyDecision) {
          return {
            status: "failed",
            ...(sessionId ? { sessionId } : {}),
            stopReason,
            failureCode: ErrorCodes.POLICY_DENIED,
            failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
            failureDetails: {
              stopReason,
              ...(sessionId ? { sessionId } : {}),
            },
          };
        }
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.INTERNAL_ERROR,
          failureMessage: "ACP turn completed with empty assistant text",
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
          },
        };
      }

      if (hadDenyDecision) {
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.POLICY_DENIED,
          failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
          },
        };
      }
      return {
        status: "failed",
        ...(sessionId ? { sessionId } : {}),
        stopReason,
        failureCode: ErrorCodes.INTERNAL_ERROR,
        failureMessage: `ACP turn ended with stopReason '${stopReason}'`,
        failureDetails: {
          stopReason,
          ...(sessionId ? { sessionId } : {}),
        },
      };
    } finally {
      if (hadOwn) {
        (this as unknown as Record<string, unknown>).decidePermissionRequest =
          prevOwn;
      } else {
        delete (this as unknown as Record<string, unknown>)
          .decidePermissionRequest;
      }
    }
  }

  /**
   * Managed-continue hook (thin wrapper around `runAcpTurn` with resume).
   *
   * Maps `ManagedContinueInput` onto `runAcpTurn` options exactly like
   * `runManagedStart`, plus the existing `sessionId`, which is resumed via
   * `initialize -> session/resume -> session/prompt` (`session/new` is
   * never called on this path). Streams only normalized assistant text
   * plus permission decision lines through `onOutput` (never raw
   * protocol), with result mapping identical to `runManagedStart`.
   */
  public async runManagedContinue(input: ManagedContinueInput): Promise<ManagedContinueResult> {
    const requested = (input.sessionId ?? "").trim();
    if (requested.length === 0) {
      return {
        status: "failed",
        stopReason: "error",
        failureCode: ErrorCodes.TASK_NOT_RESUMABLE,
        failureMessage: "AgyAcpAdapter requires a non-empty existing sessionId to continue",
        failureDetails: { taskId: input.taskId },
      };
    }
    const onOutput = input.onOutput;
    const decisions: AcpPermissionAnswer[] = [];
    const boundDecide = this.decidePermissionRequest.bind(this);
    const wrappedDecide = (
      params: unknown,
      context: AcpPermissionContext
    ): AcpPermissionAnswer => {
      const answer = boundDecide(params, context);
      decisions.push(answer);
      try {
        onOutput?.(answer.reason);
      } catch {
        // Observer-only; a failing sink must not break the turn.
      }
      return answer;
    };
    const hadOwn = Object.prototype.hasOwnProperty.call(
      this,
      "decidePermissionRequest"
    );
    const prevOwn = (this as unknown as Record<string, unknown>)
      .decidePermissionRequest;
    (this as unknown as Record<string, unknown>).decidePermissionRequest =
      wrappedDecide;
    try {
      let turn: AcpTurnResult;
      try {
        turn = await this.runAcpTurn({
          prompt: input.instruction,
          taskId: input.taskId,
          workspaceRoot: input.workspaceRoot,
          cwd: input.workspaceRoot,
          mode: input.mode,
          timeoutMs: input.timeoutMs,
          baseEnv: input.environment,
          allowWriteWorktree: this.config.allow_write_worktree ?? false,
          sessionId: requested,
        });
      } catch (err) {
        if (err instanceof CodingAgentError) {
          return {
            status: "failed",
            stopReason: "error",
            failureCode: err.code,
            failureMessage: err.message,
            ...(err.details !== undefined
              ? { failureDetails: err.details }
              : {}),
          };
        }
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          status: "failed",
          stopReason: "error",
          failureCode: ErrorCodes.INTERNAL_ERROR,
          failureMessage: message || "Managed ACP continue failed",
        };
      }

      const sessionId =
        typeof turn.sessionId === "string" ? turn.sessionId : "";
      const assistantText =
        typeof turn.assistantText === "string" ? turn.assistantText : "";
      const stopReason =
        typeof turn.stopReason === "string" && turn.stopReason.length > 0
          ? turn.stopReason
          : "unknown";
      const rawOutcome = (turn as unknown as Record<string, unknown>)
        .permissionOutcome;
      const outcome =
        typeof rawOutcome === "string" ? rawOutcome.trim().toLowerCase() : "";
      const lowerStop = stopReason.trim().toLowerCase();
      const isDenyOutcome = outcome === "deny" || outcome === "denied";
      const isDenialStop =
        lowerStop === "deny" ||
        lowerStop === "denied" ||
        lowerStop === "permission_denied" ||
        lowerStop === "permission-denied" ||
        lowerStop === "policy_denied" ||
        lowerStop === "policy-denied";
      const hadDenyDecision = decisions.some((d) => d.decision === "deny");

      if (assistantText.length > 0) {
        try {
          onOutput?.(assistantText);
        } catch {
          // Observer-only; ignore sink failures.
        }
      }

      if (
        stopReason === "cancelled" ||
        lowerStop === "cancelled" ||
        lowerStop === "canceled" ||
        lowerStop === "cancel"
      ) {
        return {
          status: "cancelled",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          ...(assistantText.length > 0 ? { assistantText } : {}),
        };
      }

      if (isDenyOutcome || isDenialStop) {
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.POLICY_DENIED,
          failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
            ...(typeof rawOutcome === "string" && rawOutcome.length > 0
              ? { permissionOutcome: rawOutcome }
              : {}),
          },
        };
      }

      if (stopReason === "end_turn" && assistantText.trim().length > 0) {
        return {
          status: "completed",
          sessionId,
          sessionResumable: true,
          assistantText,
          stopReason,
        };
      }

      if (stopReason === "end_turn") {
        if (hadDenyDecision) {
          return {
            status: "failed",
            ...(sessionId ? { sessionId } : {}),
            stopReason,
            failureCode: ErrorCodes.POLICY_DENIED,
            failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
            failureDetails: {
              stopReason,
              ...(sessionId ? { sessionId } : {}),
            },
          };
        }
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.INTERNAL_ERROR,
          failureMessage: "ACP turn completed with empty assistant text",
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
          },
        };
      }

      if (hadDenyDecision) {
        return {
          status: "failed",
          ...(sessionId ? { sessionId } : {}),
          stopReason,
          failureCode: ErrorCodes.POLICY_DENIED,
          failureMessage: `ACP turn denied by permission policy (stopReason '${stopReason}')`,
          failureDetails: {
            stopReason,
            ...(sessionId ? { sessionId } : {}),
          },
        };
      }
      return {
        status: "failed",
        ...(sessionId ? { sessionId } : {}),
        stopReason,
        failureCode: ErrorCodes.INTERNAL_ERROR,
        failureMessage: `ACP turn ended with stopReason '${stopReason}'`,
        failureDetails: {
          stopReason,
          ...(sessionId ? { sessionId } : {}),
        },
      };
    } finally {
      if (hadOwn) {
        (this as unknown as Record<string, unknown>).decidePermissionRequest =
          prevOwn;
      } else {
        delete (this as unknown as Record<string, unknown>)
          .decidePermissionRequest;
      }
    }
  }

  /**
   * Arm the single per-turn SIGKILL escalation timer. Shared by the turn
   * `cleanup()` and the cancel fallback so a cancel racing settle can never
   * double-arm it. The kernel runs attached (no detached process group),
   * so a group kill is never used: it would endanger the server itself.
   */
  private scheduleKillEscalation(turn: ActiveAcpTurn): void {
    try {
      if (turn.killEscalation) return;
      turn.killEscalation = setTimeout(() => {
        try {
          if (turn.child.exitCode === null) turn.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 3000);
      (turn.killEscalation as unknown as { unref?: () => void }).unref?.();
    } catch {
      // ignore
    }
  }

  /**
   * Adapter-owned process fallback: the established teardown sequence
   * (close client so the pending prompt settles, destroy stdin, SIGTERM).
   * Returns true when termination was initiated (or the child already
   * exited, in which case the exit handler settles the turn).
   */
  private terminateTurnChild(turn: ActiveAcpTurn): boolean {
    try {
      turn.client?.close("agy-acp managed cancel fallback");
    } catch {
      // ignore: close is idempotent; transport teardown continues below.
    }
    try {
      turn.child.stdin?.destroy();
    } catch {
      // ignore
    }
    try {
      turn.child.kill();
      return true;
    } catch {
      try {
        return turn.child.exitCode !== null || turn.child.signalCode !== null;
      } catch {
        return false;
      }
    }
  }

  /**
   * Managed-cancel hook.
   *
   * Cooperative cancel first: when the active turn for `taskId` has a known
   * session id and an open client, `session/cancel` is sent BEFORE any
   * process signal is touched, bounded by `graceTimeoutMs` (floored to a
   * small positive so a degenerate grace cannot long-block). The turn is
   * then awaited up to `graceTimeoutMs`; a settled turn reports
   * `acknowledged`. Otherwise the adapter falls back to its own process
   * teardown (SIGTERM plus the single per-turn SIGKILL escalation) and
   * still reports `acknowledged`, because the adapter itself owns
   * termination. Unknown task ids report `fallback` so TaskManager can use
   * its legacy path. Structured `failed` is reserved for a fallback that
   * cannot even be initiated.
   */
  public async cancelManagedTask(input: ManagedCancelInput): Promise<ManagedCancelResult> {
    const taskId = input.taskId;
    const turn = typeof taskId === "string" ? this.activeTurns.get(taskId) : undefined;
    if (!turn) {
      return { status: "fallback" };
    }

    const MIN_CANCEL_GRACE_MS = 100;
    const rawGrace = input.graceTimeoutMs;
    const graceMs =
      typeof rawGrace === "number" && Number.isFinite(rawGrace)
        ? Math.max(MIN_CANCEL_GRACE_MS, Math.floor(rawGrace))
        : MIN_CANCEL_GRACE_MS;

    // Cooperative path first: no process signal may precede this attempt
    // whenever a session id and an open client are available. A duplicate
    // concurrent cancel skips the RPC (already attempted) but still shares
    // the settle wait and fallback below.
    const sessionId = typeof turn.sessionId === "string" ? turn.sessionId.trim() : "";
    const client = turn.client;
    if (!turn.cancelRpcSent && sessionId.length > 0 && client && !client.isClosed) {
      turn.cancelRpcSent = true;
      try {
        const result = await client.sessionCancel({ sessionId }, { timeoutMs: graceMs });
        turn.cancelAcknowledged =
          result === null || typeof result !== "object"
            ? true
            : (result as { cancelled?: unknown }).cancelled !== false;
      } catch {
        turn.cancelAcknowledged = false;
      }
    }

    if (await waitForTurnSettled(turn.settled, graceMs)) {
      return { status: "acknowledged" };
    }

    if (this.activeTurns.get(taskId) !== turn) {
      // Settled concurrently with the grace expiry (cleanup already ran):
      // nothing left to terminate.
      return { status: "acknowledged" };
    }

    const terminated = this.terminateTurnChild(turn);
    this.scheduleKillEscalation(turn);
    if (!terminated) {
      return {
        status: "failed",
        failure: {
          code: ErrorCodes.INTERNAL_ERROR,
          message: `Failed to terminate ACP kernel for task '${taskId}'`,
          details: { taskId },
        },
      };
    }
    return { status: "acknowledged" };
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
