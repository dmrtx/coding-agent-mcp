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
  ManagedStartInput,
  ManagedStartResult,
  ManagedContinueInput,
  ManagedContinueResult,
  ManagedCancelInput,
  ManagedCancelResult,
} from "../../src/domain/agent.js";
import { AppConfig } from "../../src/config/schema.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition");
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

type CancelBehavior =
  | { kind: "acknowledged" }
  | { kind: "fallback" }
  | { kind: "failed" }
  | { kind: "throw" };

// Stub managed agent with gate-controlled run hooks: runManagedStart /
// runManagedContinue stay pending until the test resolves them, so cancelTask
// can race an in-flight managed run deterministically.
class ControllableManagedAgent implements CodingAgent {
  public readonly id = "stub-managed-cancel";
  public readonly displayName = "Stub Managed Cancel Agent";
  public startCalls: ManagedStartInput[] = [];
  public continueCalls: ManagedContinueInput[] = [];
  public cancelCalls: ManagedCancelInput[] = [];
  public cancelBehavior: CancelBehavior = { kind: "acknowledged" };
  private readonly startGates: Array<Deferred<ManagedStartResult>> = [];
  private readonly continueGates: Array<Deferred<ManagedContinueResult>> = [];

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
    const gate = new Deferred<ManagedStartResult>();
    this.startGates.push(gate);
    return gate.promise;
  }

  async runManagedContinue(input: ManagedContinueInput): Promise<ManagedContinueResult> {
    this.continueCalls.push(input);
    const gate = new Deferred<ManagedContinueResult>();
    this.continueGates.push(gate);
    return gate.promise;
  }

  async cancelManagedTask(input: ManagedCancelInput): Promise<ManagedCancelResult> {
    this.cancelCalls.push(input);
    const behavior = this.cancelBehavior;
    if (behavior.kind === "throw") throw new Error("stub cancel hook boom");
    if (behavior.kind === "failed") {
      return {
        status: "failed",
        failure: { code: "INTERNAL_ERROR", message: "stub cancel failed" },
      };
    }
    return { status: behavior.kind };
  }

  public resolveNextStart(result: ManagedStartResult): void {
    const gate = this.startGates.shift();
    assert.ok(gate, "expected a pending managed start");
    gate.resolve(result);
  }

  public resolveNextContinue(result: ManagedContinueResult): void {
    const gate = this.continueGates.shift();
    assert.ok(gate, "expected a pending managed continue");
    gate.resolve(result);
  }
}

class SpyProcessManager extends ProcessManager {
  public cancelCalls: string[] = [];
  public override async cancelProcess(taskId: string): Promise<boolean> {
    this.cancelCalls.push(taskId);
    return super.cancelProcess(taskId);
  }
}

function setupEnv(opts: { maxConcurrent?: number } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-managed-cancel-"));
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
  const processManager = new SpyProcessManager(100);

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

function completedStartResult(sessionId: string): ManagedStartResult {
  return {
    sessionId,
    sessionResumable: true,
    assistantText: "late done",
    status: "completed",
    stopReason: "end_turn",
  };
}

test("acknowledged managed cancel skips ProcessManager and survives late managed completion", async () => {
  const env = setupEnv();
  const stub = new ControllableManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "long work",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    const taskId = stub.startCalls[0].taskId;

    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });

    // Managed hook runs; ProcessManager is never consulted.
    assert.equal(stub.cancelCalls.length, 1);
    assert.deepEqual(env.processManager.cancelCalls, []);
    const hookInput = stub.cancelCalls[0];
    assert.equal(hookInput.taskId, taskId);
    assert.equal(hookInput.repositoryRoot, fs.realpathSync(env.repoDir));
    assert.ok(hookInput.workspaceRoot.length > 0);
    assert.equal(hookInput.sessionId, undefined);
    assert.equal(hookInput.mode, "implement");
    assert.equal(typeof hookInput.environment, "object");
    assert.equal(hookInput.graceTimeoutMs, 1000);

    let task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    let audits = env.readAudits().filter((e) => e.taskId === taskId);
    assert.equal(audits.filter((e) => e.type === "task.cancel_requested").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);

    // Late natural completion must not overwrite the terminal state.
    stub.resolveNextStart(completedStartResult("sess-cancel-1"));
    const settled = await startPromise;
    assert.equal(settled.status, "cancelled");

    task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    audits = env.readAudits().filter((e) => e.taskId === taskId);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("fallback managed cancel routes through ProcessManager.cancelProcess", async () => {
  const env = setupEnv();
  const stub = new ControllableManagedAgent();
  stub.cancelBehavior = { kind: "fallback" };
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "long work",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    const taskId = stub.startCalls[0].taskId;

    // No ProcessManager worker exists for a managed run: cancelProcess
    // returns false, but the task still settles cancelled safely.
    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: false });
    assert.equal(stub.cancelCalls.length, 1);
    assert.deepEqual(env.processManager.cancelCalls, [taskId]);

    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    stub.resolveNextStart(completedStartResult("sess-cancel-1"));
    const settled = await startPromise;
    assert.equal(settled.status, "cancelled");

    const audits = env.readAudits().filter((e) => e.taskId === taskId);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("throwing managed cancel hook falls back without surfacing INTERNAL_ERROR", async () => {
  const env = setupEnv();
  const stub = new ControllableManagedAgent();
  stub.cancelBehavior = { kind: "throw" };
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "long work",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    const taskId = stub.startCalls[0].taskId;

    // The hook throw must not propagate: same fallback as an explicit
    // fallback result, and no worker means cancelled:false.
    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: false });
    assert.equal(stub.cancelCalls.length, 1);
    assert.deepEqual(env.processManager.cancelCalls, [taskId]);

    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    assert.notEqual(task.failure?.code, "INTERNAL_ERROR");

    stub.resolveNextStart(completedStartResult("sess-cancel-1"));
    const settled = await startPromise;
    assert.equal(settled.status, "cancelled");
  } finally {
    env.cleanup();
  }
});

test("repeat cancel after terminal state keeps the TASK_NOT_RUNNING contract", async () => {
  const env = setupEnv();
  const stub = new ControllableManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "long work",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    const taskId = stub.startCalls[0].taskId;

    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });

    stub.resolveNextStart(completedStartResult("sess-cancel-1"));
    const settled = await startPromise;
    assert.equal(settled.status, "cancelled");

    const auditsBefore = env.readAudits().filter((e) => e.taskId === taskId);

    // Re-cancelling a terminal task is rejected, not silently idempotent:
    // the existing TASK_NOT_RUNNING contract holds for managed cancels too.
    await assert.rejects(
      () => env.taskManager.cancelTask(taskId),
      (err: any) => err.code === "TASK_NOT_RUNNING"
    );

    // The rejected repeat cancel mutates nothing and re-enters no hook.
    assert.equal(stub.cancelCalls.length, 1);
    assert.deepEqual(env.processManager.cancelCalls, []);
    const task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    const auditsAfter = env.readAudits().filter((e) => e.taskId === taskId);
    assert.equal(auditsAfter.length, auditsBefore.length);
  } finally {
    env.cleanup();
  }
});

test("managed run finally owns slot cleanup: cancel must not release it early", async () => {
  const env = setupEnv({ maxConcurrent: 1 });
  const stub = new ControllableManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromiseA = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "task A",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    const taskIdA = stub.startCalls[0].taskId;

    const cancelled = await env.taskManager.cancelTask(taskIdA);
    assert.deepEqual(cancelled, { task_id: taskIdA, cancelled: true });

    // The slot is still held while the managed runner is in flight: cancel
    // must not release it (or drop the in-flight entry) ahead of the finally.
    await assert.rejects(
      () =>
        env.taskManager.startTask({
          repository: "test-repo",
          agent: stub.id,
          instruction: "task B blocked",
          mode: "implement",
        }),
      (err: any) => err.code === "CONCURRENCY_LIMIT_REACHED"
    );

    // Once the managed run finally settles, the slot is released exactly once
    // and the terminal state is preserved.
    stub.resolveNextStart(completedStartResult("sess-A"));
    const settledA = await startPromiseA;
    assert.equal(settledA.status, "cancelled");

    const startPromiseB = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "task B",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 2);
    stub.resolveNextStart(completedStartResult("sess-B"));
    const startedB = await startPromiseB;
    assert.equal(startedB.status, "completed");

    // A late operation on A is terminal-only: it never re-enters the hook,
    // so the settled run is no longer treated as in flight.
    await assert.rejects(
      () => env.taskManager.cancelTask(taskIdA),
      (err: any) => err.code === "TASK_NOT_RUNNING"
    );
    assert.equal(stub.cancelCalls.length, 1);
  } finally {
    env.cleanup();
  }
});

test("legacy process-based agent cancel path is unchanged", async () => {
  const env = setupEnv();
  env.agentRegistry.registerAgent(new FakeAgentAdapter());
  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "fake-agent",
      instruction: "legacy sleep 5000",
    });
    assert.equal(started.status, "running");

    const cancelled = await env.taskManager.cancelTask(started.task_id);
    assert.equal(cancelled.task_id, started.task_id);
    // A live worker exists for legacy runs, so cancellation is effective.
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(env.processManager.cancelCalls, [started.task_id]);

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.ok(audits.some((e) => e.type === "task.cancel_requested"));
    assert.ok(audits.some((e) => e.type === "task.cancelled"));

    // Let the SIGTERM exit handler run before tearing down the temp dir.
    await waitFor(() => !env.processManager.isProcessRunning(started.task_id));
  } finally {
    env.cleanup();
  }
});

test("cancellation during managed continue invokes the hook and survives late continuation", async () => {
  const env = setupEnv();
  const stub = new ControllableManagedAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const startPromise = env.taskManager.startTask({
      repository: "test-repo",
      agent: stub.id,
      instruction: "initial work",
      mode: "implement",
    });
    await waitFor(() => stub.startCalls.length === 1);
    stub.resolveNextStart(completedStartResult("sess-cancel-1"));
    const started = await startPromise;
    assert.equal(started.status, "completed");

    const continuePromise = env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up",
    });
    await waitFor(() => stub.continueCalls.length === 1);
    const taskId = stub.continueCalls[0].taskId;

    const cancelled = await env.taskManager.cancelTask(taskId);
    assert.deepEqual(cancelled, { task_id: taskId, cancelled: true });

    // The hook sees the live continuation session; no worker exists to kill.
    assert.equal(stub.cancelCalls.length, 1);
    assert.deepEqual(env.processManager.cancelCalls, []);
    assert.equal(stub.cancelCalls[0].sessionId, "sess-cancel-1");
    assert.equal(stub.cancelCalls[0].mode, "implement");

    let task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");

    // Late continuation result must not overwrite the cancel.
    stub.resolveNextContinue({
      sessionId: "sess-cancel-2",
      sessionResumable: true,
      assistantText: "late continue done",
      status: "completed",
      stopReason: "end_turn",
    });
    const continued = await continuePromise;
    assert.equal(continued.status, "cancelled");

    task = env.taskManager.getTask(taskId);
    assert.equal(task.status, "cancelled");
    assert.equal(task.failure?.code, "TASK_CANCELLED");
    assert.equal(task.sessionId, "sess-cancel-1");
    const audits = env.readAudits().filter((e) => e.taskId === taskId);
    assert.equal(audits.filter((e) => e.type === "task.cancelled").length, 1);
    // Only the start's completion audit exists; the continuation never settles.
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 1);
  } finally {
    env.cleanup();
  }
});
