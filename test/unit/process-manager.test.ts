import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ProcessManager, getProcessStartTime, getProcessCwd } from "../../src/orchestration/process-manager.js";

test("ProcessManager safely recovers verifiable orphaned workers on startup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-recovery-test-"));
  const pm = new ProcessManager(1000, tmpDir);

  // Spawn a real long-running worker process
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: tmpDir,
    detached: true,
    stdio: "ignore",
  });
  const workerPid = worker.pid!;
  const osStartTime = getProcessStartTime(workerPid) || undefined;
  const workerCwd = getProcessCwd(workerPid) || tmpDir;

  // Write verifiable identity as if left behind by a hard crash
  const identityFile = path.join(tmpDir, "active-workers.json");
  fs.writeFileSync(
    identityFile,
    JSON.stringify([
      {
        taskId: "task-orphaned-1",
        pid: workerPid,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 60000)"],
        cwd: workerCwd,
        startedAt: Date.now(),
        osStartTime,
      },
    ])
  );

  // Startup recovery
  const recovered = await pm.recoverOrphanedWorkers();
  assert.equal(recovered, 1);

  // Verify worker is dead
  let alive = true;
  try {
    process.kill(workerPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "Orphaned worker must be terminated");
  assert.equal(fs.existsSync(identityFile), false, "active-workers.json must be removed after successful recovery");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ProcessManager skips unverified workers and retains them in active-workers.json", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-unverified-test-"));
  const pm = new ProcessManager(1000, tmpDir);

  // Spawn an active worker
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: tmpDir,
    detached: true,
    stdio: "ignore",
  });
  const workerPid = worker.pid!;

  try {
    const identityFile = path.join(tmpDir, "active-workers.json");
    // Identity is missing osStartTime -> cannot be verified
    fs.writeFileSync(
      identityFile,
      JSON.stringify([
        {
          taskId: "task-unverified-1",
          pid: workerPid,
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 60000)"],
          cwd: tmpDir,
          startedAt: Date.now(),
        },
      ])
    );

    const recovered = await pm.recoverOrphanedWorkers();
    assert.equal(recovered, 0, "Unverified worker must NOT be killed");

    // Verify worker is still running
    let alive = true;
    try {
      process.kill(workerPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "Worker process must still be running");

    // Verify active-workers.json retains the unverified entry
    assert.equal(fs.existsSync(identityFile), true, "active-workers.json must NOT be deleted");
    const retained = JSON.parse(fs.readFileSync(identityFile, "utf-8"));
    assert.equal(retained.length, 1);
    assert.equal(retained[0].taskId, "task-unverified-1");
  } finally {
    try {
      process.kill(workerPid, "SIGKILL");
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ProcessManager shutdown terminates all active worker process groups", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shutdown-test-"));
  const pm = new ProcessManager(1000);

  const log1 = path.join(tmpDir, "task1.log");
  const log2 = path.join(tmpDir, "task2.log");

  await pm.spawnProcess({
    taskId: "task-1",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 60000,
    logPath: log1,
  });

  await pm.spawnProcess({
    taskId: "task-2",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 60000,
    logPath: log2,
  });

  assert.equal(pm.getRunningProcessCount(), 2);

  // Invoke shutdown
  await pm.shutdown();

  assert.equal(pm.getRunningProcessCount(), 0);
  assert.equal(pm.isProcessRunning("task-1"), false);
  assert.equal(pm.isProcessRunning("task-2"), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ProcessManager cleans up timers and doesn't fire forceKill on early exit", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-timer-test-"));
  const pm = new ProcessManager(2000);
  const log = path.join(tmpDir, "task.log");

  let exited = false;
  await pm.spawnProcess({
    taskId: "task-fast",
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 100)"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 1000,
    logPath: log,
    onExit: () => {
      exited = true;
    },
  });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(exited, true);
  assert.equal(pm.isProcessRunning("task-fast"), false);

  // Wait beyond timeout to ensure no unhandled errors or stale force-kills
  await new Promise((r) => setTimeout(r, 1200));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ProcessManager bounds output and writes separate stdout/stderr files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-output-test-"));
  const pm = new ProcessManager(1000);
  const log = path.join(tmpDir, "task-output.log");

  let truncated = false;
  await pm.spawnProcess({
    taskId: "task-out",
    command: process.execPath,
    args: [
      "-e",
      "console.log('stdout message'); console.error('stderr message'); setTimeout(() => console.log('X'.repeat(500)), 50);",
    ],
    cwd: tmpDir,
    env: {},
    timeoutMs: 5000,
    logPath: log,
    maxOutputBytes: 100, // Capped at 100 bytes
    onOutputTruncated: () => {
      truncated = true;
    },
  });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(truncated, true);

  // Check stdout stream file
  const stdoutLog = `${log}.stdout`;
  assert.ok(fs.existsSync(stdoutLog));
  const stdoutContent = fs.readFileSync(stdoutLog, "utf-8");
  assert.ok(stdoutContent.includes("stdout message"));

  // Check stderr stream file
  const stderrLog = `${log}.stderr`;
  assert.ok(fs.existsSync(stderrLog));
  const stderrContent = fs.readFileSync(stderrLog, "utf-8");
  assert.ok(stderrContent.includes("stderr message"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ProcessManager reserves and releases concurrency slots atomically", () => {
  const pm = new ProcessManager(1000);

  // Reserve slot 1 with limit 2
  pm.reserveSlot("task-1", 2);
  assert.equal(pm.getRunningProcessCount(), 1);

  // Reserve slot 2 with limit 2
  pm.reserveSlot("task-2", 2);
  assert.equal(pm.getRunningProcessCount(), 2);

  // Third reservation must fail with CONCURRENCY_LIMIT_REACHED
  assert.throws(
    () => pm.reserveSlot("task-3", 2),
    (err: any) => err.code === "CONCURRENCY_LIMIT_REACHED"
  );

  // Releasing a slot allows new reservation
  pm.releaseSlot("task-1");
  assert.equal(pm.getRunningProcessCount(), 1);
  pm.reserveSlot("task-3", 2);
  assert.equal(pm.getRunningProcessCount(), 2);
});

test("ProcessManager enforces cumulative per-task output cap across continuations", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cum-output-"));
  const pm = new ProcessManager(1000);
  const log = path.join(tmpDir, "task-cum.log");

  // First run: writes 60 bytes (limit 100)
  await pm.spawnProcess({
    taskId: "task-cum",
    command: process.execPath,
    args: ["-e", "process.stdout.write('A'.repeat(60));"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 5000,
    logPath: log,
    maxOutputBytes: 100,
  });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.statSync(log).size >= 60, true);

  // Second run (continuation on same task log): writes another 60 bytes
  let continuationTruncated = false;
  await pm.spawnProcess({
    taskId: "task-cum",
    command: process.execPath,
    args: ["-e", "process.stdout.write('B'.repeat(60));"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 5000,
    logPath: log,
    maxOutputBytes: 100,
    onOutputTruncated: () => {
      continuationTruncated = true;
    },
  });

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(continuationTruncated, true, "Continuation must trigger output truncation when task cumulative limit is reached");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});


test("ProcessManager does NOT kill recycled PID with same binary but different start time or cwd", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-recycled-test-"));
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-other-dir-"));
  const pm = new ProcessManager(1000, tmpDir);

  // Spawn an innocent process (node) running in otherDir
  const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    cwd: otherDir,
    detached: true,
    stdio: "ignore",
  });
  const innocentPid = innocent.pid!;

  try {
    // Write stale identity claiming this PID belonged to a different task with different start time and cwd
    const identityFile = path.join(tmpDir, "active-workers.json");
    fs.writeFileSync(
      identityFile,
      JSON.stringify([
        {
          taskId: "task-stale-recycled",
          pid: innocentPid,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000);"],
          cwd: tmpDir, // Different cwd!
          startedAt: Date.now() - 1000000,
          osStartTime: "Mon Jan  1 00:00:00 2020", // Different start time!
        },
      ])
    );

    // Startup recovery must NOT touch the innocent recycled PID
    const recovered = await pm.recoverOrphanedWorkers();
    assert.equal(recovered, 0, "Recycled PID must not be recovered or terminated");

    // Verify innocent process is STILL alive
    let alive = true;
    try {
      process.kill(innocentPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "Innocent process must still be running");
  } finally {
    try {
      process.kill(-innocentPid, "SIGKILL");
    } catch {
      try {
        process.kill(innocentPid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test("Inline watchdog terminates worker process when parent server is abruptly killed with SIGKILL", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-watchdog-test-"));
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const parentScript = path.join(tmpDir, "parent.ts");
  const readyFile = path.join(tmpDir, "ready.json");

  fs.writeFileSync(
    parentScript,
    `
    import { ProcessManager } from ${JSON.stringify(path.resolve("src/orchestration/process-manager.ts"))};
    import fs from "node:fs";
    import path from "node:path";

    const pm = new ProcessManager(500, ${JSON.stringify(tmpDir)});
    async function run() {
      const pid = await pm.spawnProcess({
        taskId: "task-watchdog-target",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: ${JSON.stringify(tmpDir)},
        env: {},
        timeoutMs: 60000,
        logPath: path.join(${JSON.stringify(tmpDir)}, "target.log"),
      });
      fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ parentPid: process.pid, workerPid: pid }));
    }
    run();
    `
  );

  spawn(process.execPath, [tsxCli, parentScript], {
    cwd: tmpDir,
    stdio: "ignore",
  });

  // Wait for worker PID file to be written
  let parentPid: number | null = null;
  let workerPid: number | null = null;
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(readyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(readyFile, "utf-8"));
        if (data.parentPid && data.workerPid) {
          parentPid = Number(data.parentPid);
          workerPid = Number(data.workerPid);
          break;
        }
      } catch {
        // Retry
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.ok(parentPid, "Parent PID should have been reported");
  assert.ok(workerPid, "Worker PID should have been reported");

  // Verify worker is alive initially
  let workerAliveBefore = true;
  try {
    process.kill(workerPid, 0);
  } catch {
    workerAliveBefore = false;
  }
  assert.equal(workerAliveBefore, true, "Worker must be running initially");

  // Abruptly kill the parent process with SIGKILL (simulating hard crash)
  process.kill(parentPid, "SIGKILL");

  // Wait up to 4 seconds for inline watchdog to detect parent termination and kill the worker
  let workerAliveAfter = true;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(workerPid, 0);
    } catch {
      workerAliveAfter = false;
      break;
    }
  }

  assert.equal(workerAliveAfter, false, "Watchdog must terminate worker when parent is killed with SIGKILL");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

