import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

export interface SpawnProcessOptions {
  taskId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  logPath: string;
  onExit?: (exitCode: number | null, signal: string | null, timedOut: boolean) => void;
  onOutput?: (chunk: string) => void;
}

export interface ActiveProcess {
  taskId: string;
  pid: number;
  child: ChildProcess;
  logStream: fs.WriteStream;
  timeoutTimer?: NodeJS.Timeout;
  timedOut: boolean;
  cancelled: boolean;
  startTime: number;
}

export class ProcessManager {
  private readonly activeProcesses: Map<string, ActiveProcess> = new Map();
  private readonly gracePeriodMs: number;

  constructor(gracePeriodMs = 3000) {
    this.gracePeriodMs = gracePeriodMs;
  }

  public spawnProcess(options: SpawnProcessOptions): number {
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    const logStream = fs.createWriteStream(options.logPath, { flags: "a" });

    let child: ChildProcess;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      logStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to spawn process '${options.command}': ${err.message}`,
        { command: options.command, cwd: options.cwd }
      );
    }

    if (!child.pid) {
      logStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to get PID for spawned process '${options.command}'`
      );
    }

    const pid = child.pid;
    const active: ActiveProcess = {
      taskId: options.taskId,
      pid,
      child,
      logStream,
      timedOut: false,
      cancelled: false,
      startTime: Date.now(),
    };

    this.activeProcesses.set(options.taskId, active);

    const onData = (data: Buffer) => {
      const text = data.toString("utf-8");
      logStream.write(data);
      if (options.onOutput) {
        options.onOutput(text);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    if (options.timeoutMs > 0) {
      active.timeoutTimer = setTimeout(() => {
        active.timedOut = true;
        this.killProcessTree(pid, "SIGTERM");
        setTimeout(() => {
          this.killProcessTree(pid, "SIGKILL");
        }, this.gracePeriodMs);
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      logStream.write(`\n[coding-agent-mcp ERROR] Process error: ${err.message}\n`);
    });

    child.on("close", (code, signal) => {
      if (active.timeoutTimer) {
        clearTimeout(active.timeoutTimer);
      }
      logStream.end();
      this.activeProcesses.delete(options.taskId);

      if (options.onExit) {
        options.onExit(code, signal, active.timedOut);
      }
    });

    return pid;
  }

  public async cancelProcess(taskId: string): Promise<boolean> {
    const active = this.activeProcesses.get(taskId);
    if (!active) {
      return false;
    }

    active.cancelled = true;
    if (active.timeoutTimer) {
      clearTimeout(active.timeoutTimer);
    }

    // Graceful termination
    this.killProcessTree(active.pid, "SIGTERM");

    // After grace period, force SIGKILL if still running
    await new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));

    if (this.activeProcesses.has(taskId)) {
      this.killProcessTree(active.pid, "SIGKILL");
    }

    return true;
  }

  public isProcessRunning(taskId: string): boolean {
    return this.activeProcesses.has(taskId);
  }

  public getRunningProcessCount(): number {
    return this.activeProcesses.size;
  }

  private killProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Process might have exited already
      }
    }
  }
}
