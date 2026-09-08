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
} from "../domain/agent.js";
import { AgentConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

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

      const settings = {
        enableTerminalSandbox: true,
        toolPermission: "proceed-in-sandbox",
        allowNonWorkspaceAccess: false,
        trustedWorkspaces: [workspaceRoot],
        permissions: {
          allow: [
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
}
