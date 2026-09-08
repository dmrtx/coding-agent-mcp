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
import { CodingAgentError } from "../../src/domain/errors.js";
import type { AppConfig } from "../../src/config/schema.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");
const MISSING_EXE = "/nonexistent/definitely-missing-agy-acp-binary";

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

function setupEnv(opts: { allowWrite?: boolean; acpExecutable?: string } = {}) {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-managed-"));
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

  const acpExecutable = opts.acpExecutable ?? makeWrapper(tmpDir);

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
        acp_executable: acpExecutable,
        auth_method: "oauth-personal",
        mode: "default",
        allow_write_worktree: opts.allowWrite ?? false,
        state_dir: stateDir,
        default_timeout_seconds: 30,
        env_allowlist: ["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"],
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

test("managed start via TaskManager completes with session and normalized output", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "read the readme",
      mode: "implement",
    });
    // Managed start is async: returns running promptly, settles in background.
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "completed");
    assert.ok(
      typeof task.sessionId === "string" && task.sessionId.length > 0,
      "task must have non-empty sessionId"
    );
    assert.ok(task.sessionId!.startsWith("sess-"), `expected sess-* id, got ${task.sessionId}`);
    assert.equal(task.sessionResumable, true);

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(output.includes("fake assistant completed turn"), "output must contain assistant text");
    assert.ok(output.includes("Allowed"), "output must contain normalized permission allow line");
    assertNoRawProtocol(output);

    const stdoutPath = `${task.logPath}.stdout`;
    assert.ok(fs.existsSync(stdoutPath), "stdout capture must exist");
    const stdout = fs.readFileSync(stdoutPath, "utf-8");
    assert.ok(stdout.includes("fake assistant completed turn"));
    assertNoRawProtocol(stdout);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed start with missing executable fails typed with no agy fallback", async () => {
  const env = setupEnv({ acpExecutable: MISSING_EXE });
  try {
    await assert.rejects(
      () =>
        env.taskManager.startTask({
          repository: "test-repo",
          agent: "agy-acp",
          instruction: "read the readme",
          mode: "implement",
        }),
      (err: any) => {
        assert.ok(err instanceof CodingAgentError, "must be a typed CodingAgentError");
        assert.equal(err.code, "AGENT_NOT_AVAILABLE");
        assert.ok(String(err.message).includes("agy-acp"), "error must name agy-acp");
        return true;
      }
    );
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed start review + write probe maps terminal denial to POLICY_DENIED", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "review this change [[WRITE_PROBE]]",
      mode: "review",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "POLICY_DENIED");

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(output.includes("Denied"), "output must contain normalized deny line");
    assertNoRawProtocol(output);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed start implement + write probe with gate off denies", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "edit notes [[WRITE_PROBE]]",
      mode: "implement",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "POLICY_DENIED");

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(output.includes("Denied"), "output must contain normalized deny line");
    assertNoRawProtocol(output);
  } finally {
    env.cleanup();
  }
});

test("managed start implement + write probe with gate on and contained path completes", async () => {
  const env = setupEnv({ allowWrite: true });
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "edit notes [[WRITE_PROBE]]",
      mode: "implement",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "completed");
    assert.ok(typeof task.sessionId === "string" && task.sessionId.length > 0);
    assert.equal(task.sessionResumable, true);

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100_000).output;
    assert.ok(output.includes("fake assistant completed write probe"));
    assert.ok(output.includes("Allowed"));
    assertNoRawProtocol(output);
  } finally {
    env.cleanup();
  }
});

test("managed start empty output maps to INTERNAL_ERROR", async () => {
  const env = setupEnv({ allowWrite: false });
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "agy-acp",
      instruction: "do nothing [[EMPTY_OUTPUT]]",
      mode: "implement",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "INTERNAL_ERROR");
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});
