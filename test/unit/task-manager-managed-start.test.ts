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
import { FakeAgentAdapter } from "../../src/agents/fake-agent-adapter.js";
import {
  CodingAgent,
  AgentDescriptor,
  AgentStartInput,
  AgentProcessSpawnInfo,
  ManagedStartInput,
  ManagedStartResult,
} from "../../src/domain/agent.js";
import { AppConfig } from "../../src/config/schema.js";

// Tiny stub managed agent. Deliberately NOT AgyAcpAdapter.
type StubBehavior =
  | { kind: "success" }
  | { kind: "failure" }
  | { kind: "cancel" };

class StubManagedAgent implements CodingAgent {
  public readonly id = "stub-managed";
  public readonly displayName = "Stub Managed Agent";
  public seenInput?: ManagedStartInput;
  public prepareStartCalled = false;
  private readonly behavior: StubBehavior;

  constructor(behavior: StubBehavior = { kind: "success" }) {
    this.behavior = behavior;
  }

  async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      capabilities: ["modify_files"],
    };
  }

  async prepareStart(_input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    this.prepareStartCalled = true;
    throw new Error("managed path must not call prepareStart");
  }

  async runManagedStart(input: ManagedStartInput): Promise<ManagedStartResult> {
    this.seenInput = input;
    input.onOutput?.("stub managed line one");
    input.onOutput?.("stub managed line two");
    if (this.behavior.kind === "success") {
      return {
        sessionId: "sess-stub-123",
        sessionResumable: true,
        assistantText: "stub assistant done",
        outputLines: ["stub output line"],
        status: "completed",
        stopReason: "end_turn",
      };
    }
    if (this.behavior.kind === "failure") {
      return {
        status: "failed",
        stopReason: "error",
        failureCode: "POLICY_DENIED",
        failureMessage: "stub denied write",
        failureDetails: { denied: ["write /etc/passwd"] },
      };
    }
    return {
      status: "cancelled",
      stopReason: "cancelled",
    };
  }
}

function setupEnv(opts: { outputLimitBytes?: number } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-managed-test-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "init.txt"), "hello\n");
  execSync("git add init.txt && git commit -m init", { cwd: repoDir, stdio: "ignore" });

  const dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(dataDir);

  const config: AppConfig = {
    server: {
      data_dir: dataDir,
      max_concurrent_tasks: 2,
      default_task_timeout_seconds: 30,
      output_limit_bytes: opts.outputLimitBytes ?? 5000000,
      workspace_grace_period_ms: 1000,
    },
    agents: {},
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

  const readAudits = (): Array<Record<string, any>> => {
    const p = path.join(dataDir, "audit.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  };

  return {
    tmpDir,
    repoDir,
    dataDir,
    config,
    taskStore,
    taskManager,
    processManager,
    agentRegistry,
    readAudits,
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function waitForTerminal(
  taskManager: import("../../src/orchestration/task-manager.js").TaskManager,
  taskId: string,
  timeoutMs = 8000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = taskManager.getTask(taskId);
    if (task.status !== "running" && task.status !== "starting") return task;
    if (Date.now() > deadline) throw new Error(`timed out waiting for terminal ${taskId}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("legacy path still works when managed hook is absent", async () => {
  const env = setupEnv();
  env.agentRegistry.registerAgent(new FakeAgentAdapter());
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "fake-agent",
      instruction: "legacy feature",
    });
    assert.equal(started.status, "running");

    let task = env.taskManager.getTask(started.task_id);
    const deadline = Date.now() + 8000;
    while (task.status === "running" || task.status === "starting") {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(started.task_id);
    }
    assert.equal(task.status, "completed");
    assert.equal(env.processManager.getRunningProcessCount(), 0);

    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.ok(
      audits.some((e) => e.type === "agent.process_spawned"),
      "legacy path must emit agent.process_spawned"
    );
    assert.ok(audits.some((e) => e.type === "task.completed"));
  } finally {
    env.cleanup();
  }
});

test("managed start completes, persists session, and captures output", async () => {
  const env = setupEnv();
  const stub = new StubManagedAgent({ kind: "success" });
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "do managed work",
      mode: "implement",
    });

    // Managed start is asynchronous: startTask returns running promptly and
    // the detached settlement completes shortly after.
    assert.equal(started.status, "running");
    assert.equal(stub.prepareStartCalled, false);

    // Hook input contract.
    assert.ok(stub.seenInput);
    assert.equal(stub.seenInput.taskId, started.task_id);
    assert.ok(stub.seenInput.workspaceRoot.length > 0);
    assert.equal(stub.seenInput.instruction, "do managed work");
    assert.equal(stub.seenInput.mode, "implement");
    assert.ok((stub.seenInput.timeoutMs ?? 0) > 0);

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.sessionId, "sess-stub-123");
    assert.equal(task.sessionResumable, true);

    // Output callback + structured text land in the log contract.
    assert.ok(fs.existsSync(task.logPath));
    const output = env.taskManager.getTaskOutput(started.task_id, 0, 20000);
    assert.ok(output.output.includes("stub managed line one"));
    assert.ok(output.output.includes("stub managed line two"));
    assert.ok(output.output.includes("stub assistant done"));
    assert.ok(output.output.includes("stub output line"));
    assert.ok(fs.existsSync(`${task.logPath}.stdout`));

    // Slot released, single terminal audit, no process spawn.
    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 1);
    assert.equal(
      audits.filter((e) => e.type === "agent.process_spawned").length,
      0,
      "managed path must not emit agent.process_spawned"
    );
  } finally {
    env.cleanup();
  }
});

test("managed failure maps supplied code/message/details", async () => {
  const env = setupEnv();
  env.agentRegistry.registerAgent(new StubManagedAgent({ kind: "failure" }));
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "do failing work",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "POLICY_DENIED");
    assert.equal(task.failure?.message, "stub denied write");
    assert.deepEqual(task.failure?.details, { denied: ["write /etc/passwd"] });

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("managed cancel maps to cancelled", async () => {
  const env = setupEnv();
  env.agentRegistry.registerAgent(new StubManagedAgent({ kind: "cancel" }));
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "do cancellable work",
    });
    assert.equal(started.status, "running");

    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("managed completion releases slot with no double completion/audit race", async () => {
  const env = setupEnv();
  env.agentRegistry.registerAgent(new StubManagedAgent({ kind: "success" }));
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "race check",
    });
    assert.equal(started.status, "running");
    await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(env.processManager.getRunningProcessCount(), 0);

    // Post-completion cancel must be rejected and must not mutate/audit.
    const auditsBefore = env.readAudits().filter((e) => e.taskId === started.task_id);
    await assert.rejects(
      () => env.taskManager.cancelTask(started.task_id),
      (err: any) => err.code === "TASK_NOT_RUNNING"
    );
    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "completed");
    const auditsAfter = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(auditsAfter.length, auditsBefore.length);
    assert.equal(
      auditsAfter.filter((e) => e.type === "task.completed").length,
      1,
      "exactly one task.completed audit"
    );

    // Slot is free: a second start succeeds.
    const second = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "second race check",
    });
    assert.equal(second.status, "running");
    await waitForTerminal(env.taskManager, second.task_id);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("managed output respects existing output-limit accounting", async () => {
  const env = setupEnv({ outputLimitBytes: 40 });
  env.agentRegistry.registerAgent(new StubManagedAgent({ kind: "success" }));
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "stub-managed",
      instruction: "limit check",
    });
    assert.equal(started.status, "running");
    const task = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(task.outputTruncated, true);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.ok(audits.some((e) => e.type === "agent.output_truncated"));
    const stat = fs.statSync(task.logPath);
    assert.ok(stat.size <= 500, "log must stay bounded near the limit plus warning");
  } finally {
    env.cleanup();
  }
});
