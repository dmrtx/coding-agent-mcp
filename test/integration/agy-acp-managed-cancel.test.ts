import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { TaskManager } from "../../src/orchestration/task-manager.js";
import { ProcessManager } from "../../src/orchestration/process-manager.js";
import { TaskStore } from "../../src/persistence/task-store.js";
import { AuditStore } from "../../src/persistence/audit-store.js";
import { GitService } from "../../src/repositories/git-service.js";
import { WorkspaceManager } from "../../src/repositories/workspace-manager.js";
import { RepositoryRegistry } from "../../src/repositories/repository-registry.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import type { AppConfig } from "../../src/config/schema.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");

// Cross-process trace in the fake kernel is gated on this var so phase-1
// tests (real HOME) never write state files. Forwarded to kernels via
// env_allowlist below.
process.env.AGY_ACP_FAKE_PERSIST = "1";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeWrapper(tmpDir: string): string {
  const wrapper = path.join(tmpDir, "fake-acp");
  const content = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`;
  fs.writeFileSync(wrapper, content, { mode: 0o755 });
  try {
    fs.chmodSync(wrapper, 0o755);
  } catch {
    // Non-POSIX: best effort.
  }
  return wrapper;
}

function setupEnv() {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cancel-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  execSync("git add README.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });

  const dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir);
  const stateDir = path.join(tmpDir, "acp-state");
  fs.mkdirSync(stateDir);

  const config: AppConfig = {
    server: {
      data_dir: dataDir,
      max_concurrent_tasks: 2,
      default_task_timeout_seconds: 30,
      output_limit_bytes: 5_000_000,
      workspace_grace_period_ms: 1000,
    },
    agents: {
      "agy-acp": {
        enabled: true,
        acp_executable: makeWrapper(tmpDir),
        auth_method: "oauth-personal",
        mode: "default",
        allow_write_worktree: false,
        state_dir: stateDir,
        default_timeout_seconds: 30,
        env_allowlist: [
          "HOME",
          "PATH",
          "TMPDIR",
          "USER",
          "SHELL",
          "LANG",
          "LC_ALL",
          "TERM",
          "AGY_ACP_FAKE_PERSIST",
        ],
      },
    },
    repositories: {
      "test-repo": {
        root: repoDir,
        writable: true,
        allow_in_place: false,
        default_workspace_strategy: "worktree",
        verification_profiles: {},
      },
    },
  };

  const taskStore = new TaskStore(dataDir);
  const auditStore = new AuditStore(dataDir);
  const gitService = new GitService();
  const workspaceManager = new WorkspaceManager(dataDir, gitService);
  const repoRegistry = new RepositoryRegistry(config);
  const agentRegistry = new AgentRegistry(config);
  const processManager = new ProcessManager(100);
  const taskManager = new TaskManager(
    config,
    repoRegistry,
    workspaceManager,
    agentRegistry,
    processManager,
    taskStore,
    auditStore
  );

  return {
    tmpDir,
    dataDir,
    stateDir,
    config,
    taskStore,
    taskManager,
    processManager,
    cleanup: () => {
      try {
        taskStore.close();
      } catch {
        // ignore
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Isolated per-task HOME the adapter assigns to the fake kernel. */
function isolatedHome(stateDir: string, taskId: string): string {
  return path.join(stateDir, "tasks", taskId, "home");
}

interface TraceEntry {
  pid: number;
  method: string;
}

function readTraceIfExists(homeDir: string): TraceEntry[] {
  const tracePath = path.join(homeDir, ".agy-acp-fake-trace.jsonl");
  if (!fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function readAudits(dataDir: string): Array<Record<string, any>> {
  const p = path.join(dataDir, "audit.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * The startTask promise resolves only after the managed run settles, so the
 * task id is undiscoverable from its return while blocked. Poll the adapter
 * state dir for the task whose kernel trace proves session/prompt is active.
 */
async function waitForTaskWithActivePrompt(
  stateDir: string,
  minPromptCount = 1,
  timeoutMs = 20000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const base = path.join(stateDir, "tasks");
  for (;;) {
    if (fs.existsSync(base)) {
      for (const dir of fs.readdirSync(base)) {
        const trace = readTraceIfExists(path.join(base, dir, "home"));
        if (trace.filter((e) => e.method === "session/prompt").length >= minPromptCount) {
          return dir;
        }
      }
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for an active session/prompt in the fake kernel trace");
    }
    await sleep(50);
  }
}

async function waitForPidGone(pid: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let gone = false;
    try {
      process.kill(pid, 0);
    } catch (err: any) {
      if (err?.code === "ESRCH") gone = true;
      else throw new Error(`cannot confirm kernel pid ${pid} exited (kill error ${err?.code ?? "unknown"})`);
    }
    if (gone) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for kernel pid ${pid} to exit (possible orphan)`);
    }
    await sleep(50);
  }
}

test("managed start BLOCK_UNTIL_CANCEL cancels cooperatively with a single terminal audit", async () => {
  const env = setupEnv();
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "long job [[BLOCK_UNTIL_CANCEL]]",
      mode: "implement",
    });
    const taskId = await waitForTaskWithActivePrompt(env.stateDir);

    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });

    const settled = await startPromise;
    assert.equal(settled.task_id, taskId);
    assert.equal(settled.status, "cancelled");

    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    const audits = readAudits(env.dataDir).filter((e) => e.taskId === taskId);
    assert.equal(
      audits.filter((e) => e.type === "task.cancelled").length,
      1,
      "exactly one task.cancelled audit"
    );

    const trace = readTraceIfExists(isolatedHome(env.stateDir, taskId));
    const methods = trace.map((e) => e.method);
    assert.ok(methods.includes("session/prompt"), "trace must show session/prompt");
    assert.ok(methods.includes("session/cancel"), "trace must show session/cancel");
    assert.ok(
      methods.indexOf("session/prompt") < methods.indexOf("session/cancel"),
      "session/cancel must arrive after session/prompt"
    );
    assert.equal(
      methods.filter((m) => m === "session/new").length,
      1,
      "no second session/new"
    );

    // The kernel exits via normal adapter teardown: no orphan remains.
    const kernelPid = trace.find((e) => e.method === "session/prompt")!.pid;
    await waitForPidGone(kernelPid);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed start IGNORE_CANCEL falls back to adapter-owned termination", async () => {
  const env = setupEnv();
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "stuck job [[IGNORE_CANCEL]]",
      mode: "implement",
    });
    const taskId = await waitForTaskWithActivePrompt(env.stateDir);

    // The adapter owns the fallback kill, so TaskManager still reports
    // acknowledged/true even though the kernel never settles the prompt.
    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });

    const settled = await startPromise;
    assert.equal(settled.task_id, taskId);
    assert.equal(settled.status, "cancelled");

    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    const audits = readAudits(env.dataDir).filter((e) => e.taskId === taskId);
    assert.equal(
      audits.filter((e) => e.type === "task.cancelled").length,
      1,
      "exactly one task.cancelled audit"
    );

    const trace = readTraceIfExists(isolatedHome(env.stateDir, taskId));
    const methods = trace.map((e) => e.method);
    const promptIdx = methods.indexOf("session/prompt");
    const cancelIdx = methods.indexOf("session/cancel");
    assert.ok(promptIdx !== -1, "trace must show session/prompt");
    assert.ok(cancelIdx !== -1, "trace must show the session/cancel attempt");
    assert.ok(promptIdx < cancelIdx, "session/cancel attempt must precede fallback");

    // The kernel is actually gone within a bounded time: no orphan remains.
    const kernelPid = trace[promptIdx].pid;
    await waitForPidGone(kernelPid, 2000);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("cancel during managed continue keeps the session and the cancelled state", async () => {
  const env = setupEnv();
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "read the readme",
      mode: "implement",
    });
    assert.equal(started.status, "completed");
    const sessionId = env.taskManager.getTask(started.task_id).sessionId;
    assert.ok(typeof sessionId === "string" && sessionId.length > 0);

    const continuePromise = env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up [[BLOCK_UNTIL_CANCEL]]",
    });
    // The continuation runs in a fresh kernel but the same isolated HOME,
    // so its session/prompt is the second prompt entry in the shared trace.
    const home = isolatedHome(env.stateDir, started.task_id);
    const deadline = Date.now() + 20000;
    for (;;) {
      if (
        readTraceIfExists(home).filter((e) => e.method === "session/prompt").length >= 2
      ) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for the continuation session/prompt");
      }
      await sleep(50);
    }

    const cancelled = await env.taskManager.cancelTask(started.task_id);
    assert.deepEqual(cancelled, { task_id: started.task_id, cancelled: true });

    const continued = await continuePromise;
    assert.equal(continued.status, "cancelled");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    assert.equal(task.sessionId, sessionId, "cancel must not rotate the session");

    const audits = readAudits(env.dataDir).filter((e) => e.taskId === started.task_id);
    // The start completed once; the continuation must never complete late.
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 1);

    const trace = readTraceIfExists(home);
    const methods = trace.map((e) => e.method);
    assert.ok(methods.includes("session/cancel"), "trace must show session/cancel");
    assert.equal(
      methods.filter((m) => m === "session/new").length,
      1,
      "continuation must resume, never session/new"
    );
  } finally {
    env.cleanup();
  }
});

test("duplicate cancel after terminal keeps TASK_NOT_RUNNING with no extra audit", async () => {
  const env = setupEnv();
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "long job [[BLOCK_UNTIL_CANCEL]]",
      mode: "implement",
    });
    const taskId = await waitForTaskWithActivePrompt(env.stateDir);

    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });
    const settled = await startPromise;
    assert.equal(settled.status, "cancelled");

    const auditsBefore = readAudits(env.dataDir).filter((e) => e.taskId === taskId);

    // Deterministic form of the concurrent-cancel race: the first cancel
    // wins, the second is rejected by the existing terminal-state contract.
    await assert.rejects(
      () => env.taskManager.cancelTask(taskId),
      (err: any) => err.code === "TASK_NOT_RUNNING"
    );

    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    const auditsAfter = readAudits(env.dataDir).filter((e) => e.taskId === taskId);
    assert.equal(auditsAfter.length, auditsBefore.length, "no duplicate terminal audit");
  } finally {
    env.cleanup();
  }
});
