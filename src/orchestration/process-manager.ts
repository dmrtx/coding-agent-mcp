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
  maxOutputBytes?: number;
  onExit?: (exitCode: number | null, signal: string | null, timedOut: boolean) => void;
  onOutput?: (chunk: string, isStderr: boolean) => void;
  onOutputTruncated?: () => void;
}

export interface ActiveProcess {
  taskId: string;
  pid: number;
  child: ChildProcess;
  logStream: fs.WriteStream;
  stdoutStream: fs.WriteStream;
  stderrStream: fs.WriteStream;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  bytesWritten: number;
  startTime: number;
}

export class ProcessManager {
  private readonly activeProcesses: Map<string, ActiveProcess> = new Map();
  private readonly gracePeriodMs: number;
  private readonly pidFilePath?: string;

  constructor(gracePeriodMs = 3000, dataDir?: string) {
    this.gracePeriodMs = gracePeriodMs;
    if (dataDir) {
      this.pidFilePath = path.join(dataDir, "active-pids.json");
      this.cleanupDanglingPids();
    }
  }

  public spawnProcess(options: SpawnProcessOptions): number {
    fs.mkdirSync(path.dirname(options.logPath), { recursive: true });
    const logStream = fs.createWriteStream(options.logPath, { flags: "a" });
    const stdoutStream = fs.createWriteStream(`${options.logPath}.stdout`, { flags: "a" });
    const stderrStream = fs.createWriteStream(`${options.logPath}.stderr`, { flags: "a" });

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
      stdoutStream.end();
      stderrStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to spawn process '${options.command}': ${err.message}`,
        { command: options.command, cwd: options.cwd }
      );
    }

    if (!child.pid) {
      logStream.end();
      stdoutStream.end();
      stderrStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to get PID for spawned process '${options.command}'`
      );
    }

    const pid = child.pid;
    const maxOutputBytes = options.maxOutputBytes ?? 5_000_000;

    const active: ActiveProcess = {
      taskId: options.taskId,
      pid,
      child,
      logStream,
      stdoutStream,
      stderrStream,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      bytesWritten: 0,
      startTime: Date.now(),
    };

    this.activeProcesses.set(options.taskId, active);
    this.saveActivePids();

    const handleChunk = (data: Buffer, isStderr: boolean) => {
      const text = data.toString("utf-8");
      if (options.onOutput) {
        options.onOutput(text, isStderr);
      }

      if (active.bytesWritten + data.length > maxOutputBytes) {
        if (!active.outputTruncated) {
          active.outputTruncated = true;
          const warning = "\n[coding-agent-mcp] Output limit exceeded. Truncating further stream log.\n";
          logStream.write(warning);
          if (isStderr) stderrStream.write(warning);
          else stdoutStream.write(warning);
          options.onOutputTruncated?.();
        }
        return;
      }

      active.bytesWritten += data.length;
      logStream.write(data);
      if (isStderr) {
        stderrStream.write(data);
      } else {
        stdoutStream.write(data);
      }
    };

    child.stdout?.on("data", (data: Buffer) => handleChunk(data, false));
    child.stderr?.on("data", (data: Buffer) => handleChunk(data, true));

    if (options.timeoutMs > 0) {
      active.timeoutTimer = setTimeout(() => {
        active.timedOut = true;
        this.killProcessTree(pid, "SIGTERM");

        // Safe force kill timer with verification of PID identity
        active.forceKillTimer = setTimeout(() => {
          const current = this.activeProcesses.get(options.taskId);
          if (current && current.pid === pid) {
            this.killProcessTree(pid, "SIGKILL");
          }
        }, this.gracePeriodMs);
      }, options.timeoutMs);
    }

    child.on("error", (err) => {
      logStream.write(`\n[coding-agent-mcp ERROR] Process error: ${err.message}\n`);
    });

    child.on("close", (code, signal) => {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);

      logStream.end();
      stdoutStream.end();
      stderrStream.end();

      this.activeProcesses.delete(options.taskId);
      this.saveActivePids();

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
    if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
    if (active.forceKillTimer) clearTimeout(active.forceKillTimer);

    // Graceful termination
    this.killProcessTree(active.pid, "SIGTERM");

    // After grace period, force SIGKILL if still running
    await new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));

    const current = this.activeProcesses.get(taskId);
    if (current && current.pid === active.pid) {
      this.killProcessTree(active.pid, "SIGKILL");
    }

    return true;
  }

  public async shutdown(): Promise<void> {
    const pids = Array.from(this.activeProcesses.values()).map((a) => a.pid);

    for (const active of this.activeProcesses.values()) {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.killProcessTree(active.pid, "SIGTERM");
    }

    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));
      for (const pid of pids) {
        this.killProcessTree(pid, "SIGKILL");
      }
    }

    for (const active of this.activeProcesses.values()) {
      active.logStream.end();
      active.stdoutStream.end();
      active.stderrStream.end();
    }

    this.activeProcesses.clear();
    this.saveActivePids();
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

  private saveActivePids(): void {
    if (!this.pidFilePath) return;
    try {
      const pids = Array.from(this.activeProcesses.values()).map((a) => ({
        taskId: a.taskId,
        pid: a.pid,
      }));
      fs.writeFileSync(this.pidFilePath, JSON.stringify(pids), "utf-8");
    } catch {
      // Non-blocking pid file write error
    }
  }

  private cleanupDanglingPids(): void {
    if (!this.pidFilePath || !fs.existsSync(this.pidFilePath)) return;
    try {
      const raw = fs.readFileSync(this.pidFilePath, "utf-8");
      const pids: Array<{ taskId: string; pid: number }> = JSON.parse(raw);
      for (const item of pids) {
        try {
          this.killProcessTree(item.pid, "SIGKILL");
        } catch {
          // Process was already dead
        }
      }
      fs.unlinkSync(this.pidFilePath);
    } catch {
      // Non-blocking cleanup error
    }
  }
}
