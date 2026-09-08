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

export class MuseAdapter implements CodingAgent {
  public readonly id = "muse";
  public readonly displayName = "Muse";
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

    const executable = this.config.executable || "muse";
    let available = false;
    let version: string | undefined = undefined;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(executable, ["-V"], (err, stdout) => {
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
    const executable = this.config.executable || "muse";
    const sessionId = input.sessionId || crypto.randomUUID();

    // Do NOT use --yolo: --yolo disables the sandbox!
    // Instead use --trust-workspace and --disable-approval with --approval-mode never
    // so approvals are bypassed for headless execution while the OS/filesystem/network sandbox remains ACTIVE.
    const args: string[] = [
      "exec",
      "--workspace",
      input.workspaceRoot,
      "--trust-workspace",
      "--approval-mode",
      "never",
      "--disable-approval",
      "--session-id",
      sessionId,
    ];

    if (input.mode === "review" || input.mode === "investigate") {
      // For true read-only review, disable both non-shell writes and shell execution
      args.push("--disable-write", "--disable-shell");
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    args.push(input.instruction);

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId,
    };
  }

  public async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    const executable = this.config.executable || "muse";
    const sessionId = input.sessionId;

    const args: string[] = [
      "exec",
      "--workspace",
      input.workspaceRoot,
      "--trust-workspace",
      "--approval-mode",
      "never",
      "--disable-approval",
    ];

    if (sessionId) {
      args.push("--session-id", sessionId);
    }

    if (input.mode === "review" || input.mode === "investigate") {
      args.push("--disable-write", "--disable-shell");
    }

    if (this.config.extra_args && this.config.extra_args.length > 0) {
      args.push(...this.config.extra_args);
    }

    args.push(input.instruction);

    return {
      command: executable,
      args,
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId,
    };
  }

  public extractSessionId(stdout: string, stderr: string): string | undefined {
    const match = stdout.match(/session[- ]id[:=\s]+([a-f0-9-]{36})/i);
    return match ? match[1] : undefined;
  }
}
