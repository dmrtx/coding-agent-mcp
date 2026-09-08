import { execFile } from "node:child_process";
import {
  CodingAgent,
  AgentDescriptor,
  AgentStartInput,
  AgentContinueInput,
  AgentProcessSpawnInfo,
} from "../domain/agent.js";
import { AgentConfig } from "../config/schema.js";

export class AgyAdapter implements CodingAgent {
  public readonly id = "agy";
  public readonly displayName = "AGY";
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
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

  public async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    const executable = this.config.executable || "agy";

    // Launch with sandbox enabled and requesting json output to capture the real conversation_id
    const args: string[] = [
      "--print",
      input.instruction,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
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
      env: input.environment,
      sessionId: undefined, // Will be extracted from real JSON output after run
    };
  }

  public async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    const executable = this.config.executable || "agy";

    const args: string[] = [
      "--print",
      input.instruction,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ];

    if (this.config.sandbox !== false) {
      args.push("--sandbox");
    }

    if (input.sessionId) {
      args.push("--conversation", input.sessionId);
    } else {
      args.push("--continue");
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env: input.environment,
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
