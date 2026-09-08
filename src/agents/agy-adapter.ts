import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import {
  CodingAgent,
  AgentDescriptor,
  AgentStartInput,
  AgentContinueInput,
  AgentProcessSpawnInfo,
  AgentResultInterpretation,
} from "../domain/agent.js";
import { AgentConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import type { ErrorCode } from "../domain/errors.js";

export class AgyAdapter implements CodingAgent {
  public readonly id = "agy";
  public readonly displayName = "AGY";
  private readonly config: AgentConfig;
  private readonly dataDir?: string;

  constructor(config: AgentConfig, dataDir?: string) {
    this.config = config;
    this.dataDir = dataDir;
  }

  public async describe(): Promise<AgentDescriptor> {
    if (!this.config.enabled) {
      return {
        id: this.id,
        displayName: this.displayName,
        available: false,
        capabilities: ["modify_files", "resume_session"],
      };
    }

    const executable = this.config.executable || "agy";
    let available = false;
    let version: string | undefined = undefined;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(executable, ["--version"], (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      available = true;
      version = output;
    } catch {
      available = false;
    }

    return {
      id: this.id,
      displayName: this.displayName,
      available,
      version,
      capabilities: ["modify_files", "resume_session"],
    };
  }

  private setupAgySettings(
    taskId: string,
    workspaceRoot: string,
    baseEnv: Record<string, string>
  ): Record<string, string> {
    try {
      const dataDir = this.dataDir || path.join(os.tmpdir(), "coding-agent-mcp");
      const configDir = path.join(dataDir, "agent-homes", "agy", taskId);
      const agyCliDir = path.join(configDir, ".gemini", "antigravity-cli");
      fs.mkdirSync(agyCliDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(configDir, 0o700);
        fs.chmodSync(path.join(configDir, ".gemini"), 0o700);
        fs.chmodSync(agyCliDir, 0o700);
      } catch {
        // Non-blocking chmod on non-POSIX filesystems
      }

      // `read_file(.)` grants recursive reads confined to the workspace root.
      // Per the official AGY permissions docs, rule targets match absolute
      // paths or paths relative to workspace roots. This adapter configures
      // exactly one trusted workspace and spawns with cwd set to it, so `.`
      // resolves unambiguously to the assigned workspace under every
      // documented resolution — and no operator-controlled path characters
      // (')', whitespace, control codes) ever enter the rule string.
      const settings = {
        enableTerminalSandbox: true,
        toolPermission: "proceed-in-sandbox",
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [workspaceRoot],
        permissions: {
          allow: [
            "read_file(.)",
            "command(git)",
            "command(npm test)",
            "command(npm run lint)",
            "command(npm run build)",
            "command(node)",
            "command(python3)",
            "command(pytest)",
          ],
        },
      };

      const settingsPath = path.join(agyCliDir, "settings.json");
      fs.writeFileSync(
        settingsPath,
        JSON.stringify(settings, null, 2),
        { encoding: "utf-8", mode: 0o600 }
      );
      try {
        fs.chmodSync(settingsPath, 0o600);
      } catch {
        // Non-blocking
      }

      // Copy authentication token from host if available
      const userHome = process.env.HOME || os.homedir();
      const hostToken = path.join(userHome, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      if (fs.existsSync(hostToken)) {
        const destToken = path.join(agyCliDir, "antigravity-oauth-token");
        fs.copyFileSync(hostToken, destToken);
        try {
          fs.chmodSync(destToken, 0o600);
        } catch {
          // Non-blocking
        }
      }

      return {
        ...baseEnv,
        HOME: configDir,
      };
    } catch (err: any) {
      // Fail-closed: Never fall back to host HOME
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Failed to initialize secure isolated AGY configuration for task '${taskId}': ${err.message}`,
        { taskId, workspaceRoot, error: err.message }
      );
    }
  }

  public async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    const executable = this.config.executable || "agy";

    // Setup strict bounded permissions configuration (no --dangerously-skip-permissions)
    const env = this.setupAgySettings(input.taskId, input.workspaceRoot, input.environment);

    const args: string[] = [
      "--print",
      input.instruction,
      "--output-format",
      "json",
    ];

    if (this.config.sandbox !== false) {
      args.push("--sandbox");
    }

    if (input.mode === "review" || input.mode === "investigate") {
      args.push("--mode", "plan");
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env,
      sessionId: undefined, // Will be extracted from real JSON output after run
    };
  }

  public async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    if (!input.sessionId) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RESUMABLE,
        "Cannot continue AGY task: no valid conversation_id was captured from previous execution. Blind continuation is prohibited."
      );
    }

    const executable = this.config.executable || "agy";

    const env = this.setupAgySettings(input.taskId, input.workspaceRoot, input.environment);

    const args: string[] = [
      "--print",
      input.instruction,
      "--output-format",
      "json",
      "--conversation",
      input.sessionId,
    ];

    if (this.config.sandbox !== false) {
      args.push("--sandbox");
    }

    if (input.mode === "review" || input.mode === "investigate") {
      args.push("--mode", "plan");
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env,
      sessionId: input.sessionId,
    };
  }

  public extractSessionId(stdout: string, _stderr: string): string | undefined {
    if (!stdout || stdout.trim().length === 0) {
      return undefined;
    }

    // 1. Try full JSON parse
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.conversation_id) return String(parsed.conversation_id);
      if (parsed.conversationId) return String(parsed.conversationId);
      if (parsed.id) return String(parsed.id);
      if (parsed.session_id) return String(parsed.session_id);
    } catch {
      // Not a single JSON blob; try lines
    }

    // 2. Try line-by-line JSON (stream-json or mixed logging)
    const lines = stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
      try {
        const item = JSON.parse(trimmed);
        if (item.conversation_id) return String(item.conversation_id);
        if (item.conversationId) return String(item.conversationId);
        if (item.id) return String(item.id);
      } catch {
        // continue searching
      }
    }

    // 3. Fallback regex search
    const regexMatch = stdout.match(/(?:"conversation_id"|"conversationId")\s*:\s*"([^"]+)"/);
    if (regexMatch) {
      return regexMatch[1];
    }

    return undefined;
  }

  public interpretResult(stdout: string, _stderr: string): AgentResultInterpretation {
    // Only affirmative structured evidence in recognizable AGY result
    // envelopes blocks. Deliberately ignores stderr, empty output, prose,
    // unknown status keys, agent-payload JSON without envelope markers, and
    // JSON text nested inside the model's response string (top-level keys of
    // envelope objects are inspected; nested strings are never parsed).
    if (!stdout || stdout.trim().length === 0) {
      return { blocked: false };
    }

    const candidates: Record<string, unknown>[] = [];
    const trimmed = stdout.trim();

    // 1. Try full-blob JSON parse
    try {
      const parsed: unknown = JSON.parse(trimmed);
      collectAgyObjects(parsed, candidates);
    } catch {
      // Not a single JSON blob; fall through to line-delimited parsing
    }

    // 2. Try line-delimited JSON (NDJSON / stream-json)
    for (const line of stdout.split("\n")) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed.startsWith("{") || !lineTrimmed.endsWith("}")) continue;
      try {
        collectAgyObjects(JSON.parse(lineTrimmed), candidates);
      } catch {
        // Not JSON; ignore prose lines
      }
    }

    for (const candidate of candidates) {
      if (isAgyResultEnvelope(candidate)) {
        const evidence = findAgyDenialEvidence(candidate);
        if (evidence) {
          return {
            blocked: true,
            reason: evidence.reason,
            details: evidence.details,
            failureCode: evidence.failureCode,
          };
        }
      }
      // Documented stream-json terminal line: {"event":"result","result":{...}}.
      // The inner result object carries the envelope markers and is examined
      // on its own; nothing else is descended into.
      if (candidate.event === "result") {
        const inner = candidate.result;
        if (isRecord(inner) && isAgyResultEnvelope(inner)) {
          const evidence = findAgyDenialEvidence(inner);
          if (evidence) {
            return {
              blocked: true,
              reason: evidence.reason,
              details: evidence.details,
              failureCode: evidence.failureCode,
            };
          }
        }
      }
    }

    return { blocked: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectAgyObjects(parsed: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (isRecord(item)) out.push(item);
    }
  } else if (isRecord(parsed)) {
    out.push(parsed);
  }
}

// Recognizably an AGY result envelope per the documented headless shapes:
// `--output-format json` emits {conversation_id, status, ...}, and
// stream-json terminal lines carry event:"result". Anything else — including
// agent-payload JSON the model itself printed — is not interpreted.
function isAgyResultEnvelope(obj: Record<string, unknown>): boolean {
  const conversationId = obj.conversation_id ?? obj.conversationId;
  if (typeof conversationId === "string" && conversationId.length > 0) {
    return true;
  }
  return obj.event === "result";
}

const AGY_DENIED_LIST_KEYS = [
  "denied_actions",
  "deniedActions",
  "denied_tools",
  "deniedTools",
];

const AGY_STATUS_KEYS = ["status", "state", "outcome"];

const AGY_DENIED_STATUSES = new Set(["denied", "blocked", "permission_denied"]);

function normalizeAgyStatus(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function isNonEmptyDenialList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return value > 0;
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

function findAgyDenialEvidence(
  obj: Record<string, unknown>
): { reason: string; details: Record<string, unknown>; failureCode?: ErrorCode } | undefined {
  // Non-empty denied action/tool lists: unambiguous permission denial.
  for (const key of AGY_DENIED_LIST_KEYS) {
    if (key in obj && isNonEmptyDenialList(obj[key])) {
      return {
        reason: `AGY run reported non-empty '${key}'`,
        details: { key, value: obj[key] },
      };
    }
  }

  // Structured terminal status indicating denial (not a generic error).
  for (const key of AGY_STATUS_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && AGY_DENIED_STATUSES.has(normalizeAgyStatus(value))) {
      return {
        reason: `AGY run reported structured status '${value}'`,
        details: { key, value },
      };
    }
  }

  // Explicit numeric denied/permission-denied counts > 0.
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && value > 0 && key.toLowerCase().includes("denied")) {
      return {
        reason: `AGY run reported denied count '${key}' = ${value}`,
        details: { key, value },
      };
    }
  }

  // A bare envelope ERROR status without any denial-specific evidence is a
  // genuine failure, but it must not be mislabeled as a policy denial.
  for (const key of AGY_STATUS_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && normalizeAgyStatus(value) === "error") {
      return {
        reason: `AGY run reported structured status '${value}' without denial evidence`,
        details: { key, value },
        failureCode: ErrorCodes.INTERNAL_ERROR,
      };
    }
  }

  return undefined;
}
