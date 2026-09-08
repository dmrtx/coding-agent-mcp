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
import {
  CodingAgent,
  AgentDescriptor,
  ManagedStartInput,
  ManagedStartResult,
  ManagedCancelInput,
  ManagedCancelResult,
} from "../../src/domain/agent.js";
import { CodingAgentError } from "../../src/domain/errors.js";
import { AppConfig } from "../../src/config/schema.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 8000,
  message = "timed out waiting for test condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(10);
  }
}

async function waitForTerminal(
  taskManager: TaskManager,
  taskId: string,
  timeoutMs = 8000
): Promise<ReturnType<TaskManager["getTask"]>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = taskManager.getTask(taskId);
    if (task.status !== "running" && task.status !== "starting") return task;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for terminal state of ${taskId}`);
    }
    await sleep(10);
  }
}

class Deferred<T> {
  public readonly promise: Promise<T>;
  public resolve!: (value: T) => void;
  public reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

class BlockedManagedAgent implements CodingAgent {
  public readonly id = "stub-managed-async";
  public readonly displayName = "Stub Managed Async Agent";
  public startCalls: ManagedStartInput[] = [];
  public cancelCalls: ManagedCancelInput[] = [];
  private readonly gates: Array<Deferred<ManagedStartResult>> = [];
  public streamPartialLine = true;

  async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      capabilities: ["modify_files"],
    };
  }

  async runManagedStart(input: ManagedStartInput): Promise<ManagedStartResult> {
    this.startCalls.push(input);
    if (this.streamPartialLine) {
      try {
        input.onOutput?.("async partial line");
      } catch {
        // ignore sink errors in test
      }
    }
    const gate = new Deferred<ManagedStartResult>();
    this.gates.push(gate);
    return gate.promise;
  }

  async cancelManagedTask(input: ManagedCancelInput): Promise<ManagedCancelResult> {
    this.cancelCalls.push(input);
    return { status: "acknowledged" };
  }

  public pendingCount(): number {
    return this.gates.length;
  }

  public resolveNext(result: ManagedStartResult): void {
    const gate = this.gates.shift();
    assert.ok(gate, "expected a pending managed start gate");
    gate.resolve(result);
  }

  public rejectNext(err: unknown): void {
    const gate = this.gates.shift();
    assert.ok(gate, "expected a pending managed start gate");
    gate.reject(err);
  }
}

function setupEnv(opts: { maxConcurrent?: number } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-managed-async-"));
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
      max_concurrent_tasks: opts.maxConcurrent ?? 2,
      default_task_timeout_seconds: 30,
      output_limit_bytes: 5000000,
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
    dataDir,
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

function completedResult(sessionId: string): ManagedStartResult {
  return {
    sessionId,
    sessionResumable: true,
    assistantText: "async assistant done",
    outputLines: ["async output line"],
    status: "completed",
    stopReason: "end_turn",
  };
}

test("managed startTask returns promptly while hook blocked; task observable as running", async () => {
  const env = setupEnv();
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "long agy work",
      mode: "implement",
    });
    // Must resolve promptly even though the managed hook never resolves yet.
    const started = await Promise.race([
      startPromise,
      sleep(2000).then(() => {
        throw new Error("startTask did not return promptly while managed hook blocked");
      }),
    ]);
    assert.equal(started.status, "running");
    assert.ok(started.task_id.length > 0);

    // Hook is still in flight and the task is observable as running.
    await waitFor(() => stub.startCalls.length === 1);
    assert.equal(stub.pendingCount(), 1);
    const observed = env.taskManager.getTask(started.task_id);
    assert.equal(observed.status, "running");
    assert.equal(env.processManager.getRunningProcessCount(), 1);

    // No terminal audit yet.
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 0);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 0);
    assert.ok(audits.some((e) => e.type === "task.started"));

    // Late completion settles without any further startTask await.
    stub.resolveNext(completedResult("sess-async-1"));
    const terminal = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.sessionId, "sess-async-1");
    assert.equal(terminal.sessionResumable, true);
    assert.equal(terminal.exitCode, 0);

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100000).output;
    assert.ok(output.includes("async partial line"));
    assert.ok(output.includes("async assistant done"));
    assert.ok(output.includes("async output line"));

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const settledAudits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(settledAudits.filter((e) => e.type === "task.completed").length, 1);
  } finally {
    env.cleanup();
  }
});

test("managed async failure later persists typed failure and releases slot", async () => {
  const env = setupEnv();
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "denied work",
    });
    assert.equal(started.status, "running");
    await waitFor(() => stub.startCalls.length === 1);

    stub.resolveNext({
      status: "failed",
      stopReason: "error",
      failureCode: "POLICY_DENIED",
      failureMessage: "async denied write",
      failureDetails: { denied: ["write /etc/passwd"] },
    });

    const terminal = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure?.code, "POLICY_DENIED");
    assert.equal(terminal.failure?.message, "async denied write");
    assert.deepEqual(terminal.failure?.details, { denied: ["write /etc/passwd"] });

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("managed async hook throw settles typed failure without unhandled rejection", async () => {
  const env = setupEnv();
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "throwing work",
    });
    assert.equal(started.status, "running");
    await waitFor(() => stub.startCalls.length === 1);

    stub.rejectNext(new CodingAgentError("AGENT_NOT_AVAILABLE", "async hook boom"));
    const terminal = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure?.code, "AGENT_NOT_AVAILABLE");
    assert.ok(terminal.failure?.message.includes("async hook boom"));

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 1);

    await sleep(50);
    assert.equal(unhandled.length, 0, "background hook throw must not surface as unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    env.cleanup();
  }
});

test("cancellation while blocked routes hook and yields exactly one terminal audit", async () => {
  const env = setupEnv();
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "cancellable work",
      mode: "implement",
    });
    assert.equal(started.status, "running");
    await waitFor(() => stub.startCalls.length === 1);

    // Cancel hook can see the active turn (in-flight entry present).
    const cancelled = await env.taskManager.cancelTask(started.task_id);
    assert.deepEqual(cancelled, { task_id: started.task_id, cancelled: true });
    assert.equal(stub.cancelCalls.length, 1);
    assert.equal(stub.cancelCalls[0].taskId, started.task_id);

    let task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    let audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);

    // Late natural completion must not overwrite or double-audit.
    stub.resolveNext(completedResult("sess-late-1"));
    await sleep(100);
    task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});

test("no duplicate terminal transition when completion races cancel", async () => {
  const env = setupEnv();
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "racing work",
    });
    assert.equal(started.status, "running");
    await waitFor(() => stub.startCalls.length === 1);

    // Completion wins first.
    stub.resolveNext(completedResult("sess-race-1"));
    const terminal = await waitForTerminal(env.taskManager, started.task_id);
    assert.equal(terminal.status, "completed");

    const auditsBefore = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(auditsBefore.filter((e) => e.type === "task.completed").length, 1);

    // Late cancel is rejected and mutates nothing.
    await assert.rejects(
      () => env.taskManager.cancelTask(started.task_id),
      (err: any) => err.code === "TASK_NOT_RUNNING"
    );
    assert.equal(stub.cancelCalls.length, 0);
    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "completed");
    const auditsAfter = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(auditsAfter.length, auditsBefore.length);
    assert.equal(env.processManager.getRunningProcessCount(), 0);

    // Slot is free for the next task.
    const second = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "next work",
    });
    assert.equal(second.status, "running");
    await waitFor(() => stub.startCalls.length === 2);
    stub.resolveNext(completedResult("sess-race-2"));
    const secondTerminal = await waitForTerminal(env.taskManager, second.task_id);
    assert.equal(secondTerminal.status, "completed");
  } finally {
    env.cleanup();
  }
});

test("blocked managed run holds its concurrency slot until late settlement", async () => {
  const env = setupEnv({ maxConcurrent: 1 });
  const stub = new BlockedManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const first = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "first blocked",
    });
    assert.equal(first.status, "running");
    await waitFor(() => stub.startCalls.length === 1);

    await assert.rejects(
      () =>
        env.taskManager.startTask({
          repository: "test-repo",
          agent: stub.id,
          instruction: "second blocked",
        }),
      (err: any) => err.code === "CONCURRENCY_LIMIT_REACHED"
    );

    stub.resolveNext(completedResult("sess-slot-1"));
    const terminal = await waitForTerminal(env.taskManager, first.task_id);
    assert.equal(terminal.status, "completed");

    const second = await env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "second after release",
    });
    assert.equal(second.status, "running");
    await waitFor(() => stub.startCalls.length === 2);
    stub.resolveNext(completedResult("sess-slot-2"));
    const secondTerminal = await waitForTerminal(env.taskManager, second.task_id);
    assert.equal(secondTerminal.status, "completed");
    assert.equal(env.processManager.getRunningProcessCount(), 0);
  } finally {
    env.cleanup();
  }
});
