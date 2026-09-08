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
import { AgyAcpAdapter } from "../../src/agents/agy-acp-adapter.js";
import type { AppConfig } from "../../src/config/schema.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");

// Cross-process session persistence in the fake kernel is gated on this var
// so phase-1 tests (real HOME) never write state files. This file runs in its
// own process, and the var is forwarded to kernels via env_allowlist below.
process.env.AGY_ACP_FAKE_PERSIST = "1";

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

function setupEnv(opts: { allowWrite?: boolean } = {}) {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-continue-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(repoDir, "notes.md"), "notes\n");
  execSync("git add README.md notes.md && git commit -m init", { cwd: repoDir, stdio: "ignore" });

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
        allow_write_worktree: opts.allowWrite ?? false,
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

function assertNoRawProtocol(output: string): void {
  assert.ok(!output.includes("jsonrpc"), "output must not contain raw JSON-RPC");
  assert.ok(
    !output.includes("session/request_permission"),
    "output must not contain raw permission method"
  );
  assert.ok(!output.includes("permissionOutcome"), "output must not contain raw outcome");
  assert.ok(!output.includes('"stopReason"'), "output must not contain raw stopReason");
}

/** Isolated per-task HOME the adapter assigns to the fake kernel. */
function isolatedHome(stateDir: string, taskId: string): string {
  return path.join(stateDir, "tasks", taskId, "home");
}

function readTrace(homeDir: string): Array<{ pid: number; method: string }> {
  const tracePath = path.join(homeDir, ".agy-acp-fake-trace.jsonl");
  assert.ok(fs.existsSync(tracePath), `fake kernel trace must exist at ${tracePath}`);
  return fs
    .readFileSync(tracePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function waitForTerminal(
  taskManager: import("../../src/orchestration/task-manager.js").TaskManager,
  taskId: string,
  timeoutMs = 30000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = taskManager.getTask(taskId);
    if (task.status !== "running" && task.status !== "starting") return task;
    if (Date.now() > deadline) throw new Error(`timed out waiting for terminal ${taskId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function startImplement(env: ReturnType<typeof setupEnv>, instruction: string, mode = "implement") {
  const started = await env.taskManager.startTask({
    repository: "test-repo",
    agent: "agy-acp",
    instruction,
    mode: mode as "implement",
  });
  assert.equal(started.status, "running");
  const terminal = await waitForTerminal(env.taskManager, started.task_id);
  assert.equal(terminal.status, "completed");
  return started;
}

test("managed continue resumes the same session and appends output", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await startImplement(env, "read the readme");
    const before = env.taskManager.getTask(started.task_id);
    assert.ok(before.sessionId?.startsWith("sess-"));
    const sessionId = before.sessionId!;
    const outputBefore = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(outputBefore.includes("fake assistant completed turn"));

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up reading",
    });
    assert.equal(continued.status, "completed");
    assert.equal(continued.instruction, "follow up reading");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "completed");
    assert.equal(task.sessionId, sessionId, "continuation must keep the same session id");
    assert.equal(task.sessionResumable, true);
    assert.equal(task.followUpInstructions.length, 1);
    assert.equal(task.followUpInstructions[0].text, "follow up reading");

    // Appended, never overwritten: prior output is a strict prefix.
    const outputAfter = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(outputAfter.startsWith(outputBefore));
    assert.ok(outputAfter.length > outputBefore.length);
    assert.ok(outputAfter.includes("Allowed"));
    assertNoRawProtocol(outputAfter);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed continue uses session/resume, never session/new", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await startImplement(env, "read the readme");
    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up reading",
    });
    assert.equal(continued.status, "completed");

    const trace = readTrace(isolatedHome(env.stateDir, started.task_id));
    const news = trace.filter((e) => e.method === "session/new");
    const resumes = trace.filter((e) => e.method === "session/resume");
    assert.equal(news.length, 1, "exactly one session/new across both turns (the start)");
    assert.equal(resumes.length, 1, "exactly one session/resume (the continuation)");
    assert.notEqual(
      resumes[0].pid,
      news[0].pid,
      "continuation must run in a fresh kernel process"
    );

    // The persisted session file holds the resumed id inside the fake HOME.
    const statePath = path.join(
      isolatedHome(env.stateDir, started.task_id),
      ".agy-acp-fake-sessions.json"
    );
    assert.ok(fs.existsSync(statePath));
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const task = env.taskManager.getTask(started.task_id);
    assert.ok(state.sessions?.[task.sessionId!], "persisted state must hold the session");
  } finally {
    env.cleanup();
  }
});

test("managed continue review + write probe maps POLICY_DENIED with session kept", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await startImplement(env, "read the readme", "review");
    const sessionId = env.taskManager.getTask(started.task_id).sessionId;

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "review this change [[WRITE_PROBE]]",
    });
    assert.equal(continued.status, "failed");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "POLICY_DENIED");
    assert.equal(task.sessionId, sessionId, "terminal denial keeps the session id");
    // Structured failure settles (no hook throw): the attempt is recorded.
    assert.equal(task.followUpInstructions.length, 1);

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(output.includes("Denied"), "output must contain normalized deny line");
    assertNoRawProtocol(output);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed continue empty output maps INTERNAL_ERROR per structured-failure contract", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await startImplement(env, "read the readme");
    const sessionId = env.taskManager.getTask(started.task_id).sessionId;

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "do nothing [[EMPTY_OUTPUT]]",
    });
    assert.equal(continued.status, "failed");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "INTERNAL_ERROR");
    assert.equal(task.sessionId, sessionId);
    // Structured failure (hook returned, not threw): follow-up is kept,
    // matching the managed-start failure contract. Rollback-to-completed
    // applies only to hook throws (covered by generic stub tests).
    assert.equal(task.followUpInstructions.length, 1);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("adapter continue with empty sessionId fails structured without spawning", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cont-val-"));
  try {
    const adapter = new AgyAcpAdapter({
      enabled: true,
      acp_executable: process.execPath,
      auth_method: "oauth-personal",
      mode: "default",
      allow_write_worktree: false,
      state_dir: stateDir,
      default_timeout_seconds: 30,
      env_allowlist: [],
    } as any);
    const result = await adapter.runManagedContinue({
      taskId: "task_validation_only",
      repositoryRoot: "/repo",
      workspaceRoot: "/repo",
      sessionId: "   ",
      instruction: "hi",
      mode: "implement",
      timeoutMs: 1000,
      environment: {},
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "TASK_NOT_RESUMABLE");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
