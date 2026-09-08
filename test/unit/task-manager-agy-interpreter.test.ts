import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskManager } from "../../src/orchestration/task-manager.js";
import { ProcessManager } from "../../src/orchestration/process-manager.js";
import { TaskStore } from "../../src/persistence/task-store.js";
import { AuditStore } from "../../src/persistence/audit-store.js";
import { GitService } from "../../src/repositories/git-service.js";
import { WorkspaceManager } from "../../src/repositories/workspace-manager.js";
import { RepositoryRegistry } from "../../src/repositories/repository-registry.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { AgyAdapter } from "../../src/agents/agy-adapter.js";
import { CodingAgent, AgentDescriptor, AgentStartInput, AgentProcessSpawnInfo } from "../../src/domain/agent.js";
import { CodingTask } from "../../src/domain/task.js";
import { AppConfig } from "../../src/config/schema.js";

// Agent without an interpretResult hook: exit-0 must always complete.
class NoInterpreterAgent implements CodingAgent {
  public readonly id = "no-interpreter-agent";
  public readonly displayName = "No Interpreter Agent";

  async describe(): Promise<AgentDescriptor> {
    return { id: this.id, displayName: this.displayName, available: true, capabilities: ["modify_files"] };
  }

  async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    return { command: process.execPath, args: ["-e", "process.exit(0)"], cwd: input.workspaceRoot, env: input.environment };
  }
}

function setupInterpreterEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-agy-interp-test-"));
  const dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir);
  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(logDir);

  const config: AppConfig = {
    server: {
      data_dir: dataDir,
      max_concurrent_tasks: 2,
      default_task_timeout_seconds: 30,
      output_limit_bytes: 5000000,
      workspace_grace_period_ms: 1000,
    },
    agents: {},
    repositories: {},
  };

  const taskStore = new TaskStore(dataDir);
  const auditStore = new AuditStore(dataDir);
  const gitService = new GitService();
  const workspaceManager = new WorkspaceManager(dataDir, gitService);
  const repoRegistry = new RepositoryRegistry(config);
  const agentRegistry = new AgentRegistry(config);
  const processManager = new ProcessManager(1000);
  const agy = new AgyAdapter({ enabled: true, executable: "agy", sandbox: true, default_timeout_seconds: 30 });

  const taskManager = new TaskManager(
    config,
    repoRegistry,
    workspaceManager,
    agentRegistry,
    processManager,
    taskStore,
    auditStore
  );

  let counter = 0;
  const makeTask = (): CodingTask => {
    counter += 1;
    const logPath = path.join(logDir, `task-interp-${counter}.log`);
    return {
      id: `task-interp-${counter}`,
      repositoryId: "test-repo",
      agentId: "agy",
      status: "running",
      instruction: "test instruction",
      followUpInstructions: [],
      mode: "implement",
      workspaceStrategy: "worktree",
      workspaceRoot: tmpDir,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      logPath,
    };
  };

  const finishWithOutput = async (
    task: CodingTask,
    code: number | null,
    agent: CodingAgent | undefined,
    stdout: string,
    stderr: string
  ): Promise<CodingTask> => {
    fs.writeFileSync(`${task.logPath}.stdout`, stdout, "utf-8");
    fs.writeFileSync(`${task.logPath}.stderr`, stderr, "utf-8");
    await (taskManager as any).handleProcessExit(task, code, null, false, agent);
    return task;
  };

  const readAuditEvents = (): Array<Record<string, any>> => {
    const auditPath = path.join(dataDir, "audit.jsonl");
    if (!fs.existsSync(auditPath)) return [];
    return fs
      .readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  };

  return {
    tmpDir,
    dataDir,
    taskManager,
    agy,
    makeTask,
    finishWithOutput,
    readAuditEvents,
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("TaskManager marks exit-0 structured denial as failed/POLICY_DENIED with exitCode 0 and audit event", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    await env.finishWithOutput(
      task,
      0,
      env.agy,
      JSON.stringify({ status: "ok", conversation_id: "conv-1", denied_actions: ["read /etc/passwd"] }),
      ""
    );

    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0, "exitCode must be preserved as 0");
    assert.equal(task.failure?.code, "POLICY_DENIED");

    const failedEvents = env.readAuditEvents().filter((e) => e.type === "task.failed" && e.taskId === task.id);
    assert.equal(failedEvents.length, 1, "a task.failed audit event must be written");
    assert.equal(failedEvents[0].details?.exitCode, 0);
  } finally {
    env.cleanup();
  }
});

test("TaskManager detects NDJSON denial on exit 0 via the interpreter", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    const ndjson = [
      JSON.stringify({ event: "init", conversation_id: "conv-1" }),
      JSON.stringify({ event: "step_update", step_update: { state: "DONE" } }),
      JSON.stringify({ conversation_id: "conv-1", status: "SUCCESS", deniedActions: ["write /etc/hosts"] }),
    ].join("\n");
    await env.finishWithOutput(task, 0, env.agy, ndjson, "");

    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.failure?.code, "POLICY_DENIED");
  } finally {
    env.cleanup();
  }
});

test("TaskManager completes exit-0 valid success JSON", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    await env.finishWithOutput(
      task,
      0,
      env.agy,
      JSON.stringify({ status: "ok", conversation_id: "conv-2", result: "done" }),
      ""
    );

    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.failure, undefined);

    const completedEvents = env
      .readAuditEvents()
      .filter((e) => e.type === "task.completed" && e.taskId === task.id);
    assert.equal(completedEvents.length, 1);
  } finally {
    env.cleanup();
  }
});

test("TaskManager does not false-fail exit-0 plain, empty, or stderr-only noise output", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const plain = env.makeTask();
    await env.finishWithOutput(plain, 0, env.agy, "Finished investigation, see summary above.", "");
    assert.equal(plain.status, "completed", "plain prose must complete");

    const empty = env.makeTask();
    await env.finishWithOutput(empty, 0, env.agy, "", "");
    assert.equal(empty.status, "completed", "empty output must complete");

    const stderrNoise = env.makeTask();
    await env.finishWithOutput(
      stderrNoise,
      0,
      env.agy,
      "all done",
      "permission denied: sandbox blocked open of /etc/shadow"
    );
    assert.equal(stderrNoise.status, "completed", "stderr-only 'permission denied' must not fail");
  } finally {
    env.cleanup();
  }
});

test("TaskManager non-zero exit behavior is unchanged by the interpreter", async () => {
  const env = setupInterpreterEnvironment();
  try {
    // Non-zero exit with denial-looking stdout still uses the legacy path
    const denied = env.makeTask();
    await env.finishWithOutput(
      denied,
      1,
      env.agy,
      JSON.stringify({ conversation_id: "conv-1", status: "denied", denied_actions: ["read /etc/passwd"] }),
      ""
    );
    assert.equal(denied.status, "failed");
    assert.equal(denied.exitCode, 1);
    assert.equal(denied.failure?.code, "INTERNAL_ERROR");

    // Plain non-zero exit is unchanged
    const plainFail = env.makeTask();
    await env.finishWithOutput(plainFail, 2, env.agy, "boom", "");
    assert.equal(plainFail.status, "failed");
    assert.equal(plainFail.failure?.code, "INTERNAL_ERROR");
  } finally {
    env.cleanup();
  }
});

test("TaskManager proves the observed denial fixture yields failed/POLICY_DENIED with exitCode 0", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const fixture = fs.readFileSync(
      path.join(import.meta.dirname, "..", "fixtures", "agy-denial-result.json"),
      "utf-8"
    );
    // Sanity: the fixture carries the real observed fields
    const parsed = JSON.parse(fixture);
    assert.equal(parsed.conversation_id, "68ed6e74-9f0d-4f99-b4df-c452c0e90cc1");
    assert.equal(parsed.status, "SUCCESS");
    assert.equal(parsed.denied_actions.length, 1);

    const task = env.makeTask();
    await env.finishWithOutput(task, 0, env.agy, fixture, "");

    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0, "exitCode must be preserved as 0");
    assert.equal(task.failure?.code, "POLICY_DENIED");
  } finally {
    env.cleanup();
  }
});

test("TaskManager maps a bare envelope ERROR without denial evidence to INTERNAL_ERROR", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    await env.finishWithOutput(
      task,
      0,
      env.agy,
      JSON.stringify({ conversation_id: "conv-err-1", status: "ERROR", response: "", error: "model overloaded" }),
      ""
    );

    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.failure?.code, "INTERNAL_ERROR", "generic errors must not be mislabeled POLICY_DENIED");
  } finally {
    env.cleanup();
  }
});

test("TaskManager skips interpretation when the stdout capture is unavailable", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    // No .stdout/.stderr files at all: merged-log contents must never be fed
    // to the interpreter, so the run completes.
    await (env.taskManager as any).handleProcessExit(task, 0, null, false, env.agy);

    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
  } finally {
    env.cleanup();
  }
});

test("TaskManager preserves completed behavior for agents without an interpreter", async () => {
  const env = setupInterpreterEnvironment();
  try {
    const task = env.makeTask();
    await env.finishWithOutput(task, 0, new NoInterpreterAgent(), "any output", "");
    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
  } finally {
    env.cleanup();
  }
});
