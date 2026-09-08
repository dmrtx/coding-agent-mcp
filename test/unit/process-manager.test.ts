import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProcessManager } from "../../src/orchestration/process-manager.js";

test("ProcessManager shutdown terminates all active worker process groups", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-shutdown-test-"));
  const pm = new ProcessManager(1000);

  const log1 = path.join(tmpDir, "task1.log");
  const log2 = path.join(tmpDir, "task2.log");

  pm.spawnProcess({
    taskId: "task-1",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    cwd: tmpDir,
    env: {},
    timeoutMs: 60000,
    logPath: log1,
  });

  pm.spawnProcess({
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
  pm.spawnProcess({
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
  pm.spawnProcess({
    taskId: "task-out",
    command: process.execPath,
    args: [
      "-e",
      "console.log('stdout message'); console.error('stderr message'); console.log('X'.repeat(500));",
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
