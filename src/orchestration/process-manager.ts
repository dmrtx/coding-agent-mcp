import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, ChildProcess } from "node:child_process";
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
  watchdog?: ChildProcess;
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

export interface WorkerIdentity {
  taskId: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: number;
  osStartTime?: string;
}

function getProcessStartTime(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function getProcessCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of output.split("\n")) {
      if (line.startsWith("n")) {
        return line.slice(1).trim();
      }
    }
  } catch {
    // Non-blocking fallback
  }
  return null;
}

function canonicalizeDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

export class ProcessManager {
  private readonly activeProcesses: Map<string, ActiveProcess> = new Map();
  private readonly reservedTaskIds: Set<string> = new Set();
  private readonly gracePeriodMs: number;
  private readonly dataDir?: string;

  constructor(gracePeriodMs = 3000, dataDir?: string) {
    this.gracePeriodMs = gracePeriodMs;
    this.dataDir = dataDir;
  }

  public reserveSlot(taskId: string, maxConcurrent: number): void {
    const totalActive = this.activeProcesses.size + this.reservedTaskIds.size;
    if (totalActive >= maxConcurrent) {
      throw new CodingAgentError(
        ErrorCodes.CONCURRENCY_LIMIT_REACHED,
        `Maximum concurrent tasks (${maxConcurrent}) reached. Wait for an active task to finish.`,
        { maxConcurrent, activeTasks: totalActive }
      );
    }

    if (this.activeProcesses.has(taskId) || this.reservedTaskIds.has(taskId)) {
      throw new CodingAgentError(
        ErrorCodes.TASK_NOT_RESUMABLE,
        `Task '${taskId}' is already running or currently being started.`,
        { taskId }
      );
    }

    this.reservedTaskIds.add(taskId);
  }

  public releaseSlot(taskId: string): void {
    this.reservedTaskIds.delete(taskId);
  }

  public async spawnProcess(options: SpawnProcessOptions): Promise<number> {
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
      this.reservedTaskIds.delete(options.taskId);
      logStream.end();
      stdoutStream.end();
      stderrStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to spawn process '${options.command}': ${err.message}`,
        { command: options.command, cwd: options.cwd }
      );
    }

    // Immediately attach error handler and await the spawn/error lifecycle event
    // to catch ENOENT or other immediate spawn failures before they escape into unhandled exceptions
    try {
      await new Promise<void>((resolve, reject) => {
        const onEarlyError = (err: Error) => {
          child.removeListener("spawn", onEarlySpawn);
          reject(err);
        };
        const onEarlySpawn = () => {
          child.removeListener("error", onEarlyError);
          resolve();
        };
        child.once("error", onEarlyError);
        child.once("spawn", onEarlySpawn);
      });
    } catch (err: any) {
      this.reservedTaskIds.delete(options.taskId);
      logStream.write(`\n[coding-agent-mcp ERROR] Process spawn error: ${err.message}\n`);
      logStream.end();
      stdoutStream.end();
      stderrStream.end();
      // Guard against any future unhandled error events
      child.on("error", () => {});
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to spawn process '${options.command}': ${err.message}`,
        { command: options.command, cwd: options.cwd, error: err.message }
      );
    }

    if (!child.pid) {
      this.reservedTaskIds.delete(options.taskId);
      logStream.end();
      stdoutStream.end();
      stderrStream.end();
      throw new CodingAgentError(
        ErrorCodes.PROCESS_START_FAILED,
        `Failed to get PID for spawned process '${options.command}'`
      );
    }

    const pid = child.pid;
    const osStartTime = getProcessStartTime(pid) || undefined;

    // Measure existing cumulative log size for per-task output capping
    let initialBytes = 0;
    try {
      if (fs.existsSync(options.logPath)) {
        initialBytes = fs.statSync(options.logPath).size;
      }
    } catch {
      // Ignore
    }

    const maxOutputBytes = options.maxOutputBytes ?? 5_000_000;
    const isAlreadyTruncated = initialBytes >= maxOutputBytes;

    // Attach inline guardian watchdog process:
    // If parent process dies abruptly (SIGKILL), the pipe closes and watchdog terminates the child process group
    let watchdog: ChildProcess | undefined;
    try {
      const watchdogScript = `
        const [parentPid, childPid] = process.argv.slice(1).map(Number);
        process.stdin.resume();
        let cleanedUp = false;
        process.stdin.on('end', cleanup);
        process.stdin.on('close', cleanup);
        process.stdin.on('error', cleanup);
        const timer = setInterval(() => {
          try { process.kill(parentPid, 0); } catch { cleanup(); }
          try { process.kill(childPid, 0); } catch { clearInterval(timer); process.exit(0); }
        }, 500);
        function cleanup() {
          if (cleanedUp) return;
          cleanedUp = true;
          clearInterval(timer);
          try { process.kill(-childPid, 'SIGTERM'); } catch { try { process.kill(childPid, 'SIGTERM'); } catch {} }
          setTimeout(() => {
            try { process.kill(-childPid, 'SIGKILL'); } catch { try { process.kill(childPid, 'SIGKILL'); } catch {} }
            process.exit(0);
          }, 2000).unref();
        }
      `;
      watchdog = spawn(process.execPath, ["-e", watchdogScript, String(process.pid), String(pid)], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      watchdog.unref();
    } catch {
      // Watchdog is best-effort defense-in-depth
    }

    const active: ActiveProcess = {
      taskId: options.taskId,
      pid,
      child,
      watchdog,
      logStream,
      stdoutStream,
      stderrStream,
      timedOut: false,
      cancelled: false,
      outputTruncated: isAlreadyTruncated,
      bytesWritten: initialBytes,
      startTime: Date.now(),
    };

    this.activeProcesses.set(options.taskId, active);
    this.reservedTaskIds.delete(options.taskId);

    this.saveActiveWorkerIdentity({
      taskId: options.taskId,
      pid,
      command: options.command,
      args: options.args,
      cwd: canonicalizeDir(options.cwd),
      startedAt: Date.now(),
      osStartTime,
    });

    if (isAlreadyTruncated && options.onOutputTruncated) {
      options.onOutputTruncated();
    }

    const handleChunk = (data: Buffer, isStderr: boolean) => {
      const text = data.toString("utf-8");
      if (options.onOutput) {
        options.onOutput(text, isStderr);
      }

      const remaining = maxOutputBytes - active.bytesWritten;
      if (remaining <= 0) {
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

      const toWrite = data.length > remaining ? data.subarray(0, remaining) : data;
      active.bytesWritten += toWrite.length;
      logStream.write(toWrite);
      if (isStderr) {
        stderrStream.write(toWrite);
      } else {
        stdoutStream.write(toWrite);
      }

      if (data.length > remaining) {
        active.outputTruncated = true;
        const warning = "\n[coding-agent-mcp] Output limit exceeded. Truncating further stream log.\n";
        logStream.write(warning);
        if (isStderr) stderrStream.write(warning);
        else stdoutStream.write(warning);
        options.onOutputTruncated?.();
      }
    };

    child.stdout?.on("data", (data: Buffer) => handleChunk(data, false));
    child.stderr?.on("data", (data: Buffer) => handleChunk(data, true));

    if (options.timeoutMs > 0) {
      active.timeoutTimer = setTimeout(() => {
        active.timedOut = true;
        this.killProcessTree(pid, "SIGTERM");

        // Safe force kill timer verifying active process identity before killing
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
      this.removeActiveWorkerIdentity(options.taskId);

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

    // After grace period, force SIGKILL only if this exact active process is still running
    await new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));

    const current = this.activeProcesses.get(taskId);
    if (current && current.pid === active.pid) {
      this.killProcessTree(active.pid, "SIGKILL");
    }

    return true;
  }

  public async shutdown(): Promise<void> {
    // 1. Send SIGTERM gracefully to all active processes
    for (const active of this.activeProcesses.values()) {
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.killProcessTree(active.pid, "SIGTERM");
    }

    // 2. Wait grace period
    if (this.activeProcesses.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.gracePeriodMs));

      // 3. Force kill ONLY processes that are STILL actively registered in this.activeProcesses
      for (const active of this.activeProcesses.values()) {
        this.killProcessTree(active.pid, "SIGKILL");
      }
    }

    for (const active of this.activeProcesses.values()) {
      active.logStream.end();
      active.stdoutStream.end();
      active.stderrStream.end();
    }

    for (const taskId of this.activeProcesses.keys()) {
      this.removeActiveWorkerIdentity(taskId);
    }

    this.activeProcesses.clear();
    this.reservedTaskIds.clear();
  }

  public isProcessRunning(taskId: string): boolean {
    return this.activeProcesses.has(taskId);
  }

  public getRunningProcessCount(): number {
    return this.activeProcesses.size + this.reservedTaskIds.size;
  }

  public async recoverOrphanedWorkers(): Promise<number> {
    if (!this.dataDir) return 0;
    const workers = this.loadActiveWorkerIdentities();
    if (workers.length === 0) return 0;

    let recovered = 0;
    for (const worker of workers) {
      try {
        // 1. Check if PID is alive
        process.kill(worker.pid, 0);
      } catch {
        // Process is already dead
        continue;
      }

      // 2. Strict identity verification against recycled PIDs
      if (worker.osStartTime) {
        const currentStartTime = getProcessStartTime(worker.pid);
        if (!currentStartTime || currentStartTime !== worker.osStartTime) {
          console.error(
            `[coding-agent-mcp] Stale PID ${worker.pid} has recycled start time (expected '${worker.osStartTime}', got '${currentStartTime}'). Skipping.`
          );
          continue;
        }
      }

      if (worker.cwd) {
        const currentCwd = getProcessCwd(worker.pid);
        if (currentCwd && canonicalizeDir(currentCwd) !== canonicalizeDir(worker.cwd)) {
          console.error(
            `[coding-agent-mcp] Stale PID ${worker.pid} has recycled working directory (expected '${worker.cwd}', got '${currentCwd}'). Skipping.`
          );
          continue;
        }
      }

      // 3. Verify verifiable identity: does the PID's actual command match worker?
      try {
        const cmdOutput = execFileSync("ps", ["-p", String(worker.pid), "-o", "command="], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        const matchesCommand =
          cmdOutput.includes(worker.command) ||
          cmdOutput.includes(worker.taskId) ||
          (worker.args && worker.args.some((arg) => arg.length > 3 && cmdOutput.includes(arg)));

        if (!matchesCommand) {
          console.error(
            `[coding-agent-mcp] Stale PID ${worker.pid} has been recycled by another process (${cmdOutput}). Skipping.`
          );
          continue;
        }

        // Identity confirmed: safely terminate orphaned process group
        console.error(
          `[coding-agent-mcp] Terminating orphaned worker PID ${worker.pid} for task ${worker.taskId}...`
        );
        this.killProcessTree(worker.pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, this.gracePeriodMs));
        try {
          process.kill(worker.pid, 0);
          this.killProcessTree(worker.pid, "SIGKILL");
        } catch {
          // Already gone
        }
        recovered++;
      } catch {
        // Process could not be inspected or killed
      }
    }

    try {
      const file = path.join(this.dataDir, "active-workers.json");
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Ignore
    }

    return recovered;
  }

  private saveActiveWorkerIdentity(worker: WorkerIdentity): void {
    if (!this.dataDir) return;
    try {
      const file = path.join(this.dataDir, "active-workers.json");
      const current = this.loadActiveWorkerIdentities();
      current.push(worker);
      fs.writeFileSync(file, JSON.stringify(current, null, 2), "utf-8");
    } catch {
      // Non-blocking
    }
  }

  private removeActiveWorkerIdentity(taskId: string): void {
    if (!this.dataDir) return;
    try {
      const file = path.join(this.dataDir, "active-workers.json");
      const current = this.loadActiveWorkerIdentities();
      const filtered = current.filter((w) => w.taskId !== taskId);
      if (filtered.length > 0) {
        fs.writeFileSync(file, JSON.stringify(filtered, null, 2), "utf-8");
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Non-blocking
    }
  }

  private loadActiveWorkerIdentities(): WorkerIdentity[] {
    if (!this.dataDir) return [];
    try {
      const file = path.join(this.dataDir, "active-workers.json");
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf-8")) as WorkerIdentity[];
      }
    } catch {
      // Non-blocking
    }
    return [];
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
