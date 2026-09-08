import { execFile } from "node:child_process";
import crypto from "node:crypto";
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
    const sessionId = input.sessionId || crypto.randomUUID();

    const args: string[] = [
      "--print",
      input.instruction,
      "--dangerously-skip-permissions",
    ];

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId,
    };
  }

  public async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    const executable = this.config.executable || "agy";

    const args: string[] = [
      "--print",
      input.instruction,
      "--dangerously-skip-permissions",
    ];

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

  public extractSessionId(stdout: string, stderr: string): string | undefined {
    // AGY conversation ID matching if present
    const match = stdout.match(/(?:conversation|session)[-_ ]id[:=\s]+([a-f0-9-]{8,36})/i);
    return match ? match[1] : undefined;
  }
}
