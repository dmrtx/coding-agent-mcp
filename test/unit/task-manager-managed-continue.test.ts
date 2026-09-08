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
  AgentContinueInput,
  AgentProcessSpawnInfo,
  ManagedStartInput,
  ManagedStartResult,
  ManagedContinueInput,
  ManagedContinueResult,
} from "../../src/domain/agent.js";
import { CodingAgentError } from "../../src/domain/errors.js";
import { AppConfig } from "../../src/config/schema.js";

// Stub managed agent. Deliberately NOT AgyAcpAdapter: it exercises the generic
// TaskManager managed-continue plumbing only.
type ContinueBehavior =
  | { kind: "success"; sessionId?: string }
  | { kind: "failure" }
  | { kind: "cancel" }
  | { kind: "timed_out" }
  | { kind: "throw" };

class StubManagedContinueAgent implements CodingAgent {
  public readonly id = "stub-managed-continue";
  public readonly displayName = "Stub Managed Continue Agent";
  public seenStartInput?: ManagedStartInput;
  public seenContinueInput?: ManagedContinueInput;
  public prepareStartCalled = false;
  public prepareContinueCalled = false;
  public continueBehavior: ContinueBehavior = { kind: "success" };

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

  async prepareContinue(_input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    this.prepareContinueCalled = true;
    throw new Error("managed path must not call prepareContinue");
  }

  async runManagedStart(input: ManagedStartInput): Promise<ManagedStartResult> {
    this.seenStartInput = input;
    input.onOutput?.("start line one");
    return {
      sessionId: "sess-stub-continue-1",
      sessionResumable: true,
      assistantText: "start assistant done",
      outputLines: ["start output line"],
      status: "completed",
      stopReason: "end_turn",
    };
  }

  async runManagedContinue(input: ManagedContinueInput): Promise<ManagedContinueResult> {
    this.seenContinueInput = input;
    const behavior = this.continueBehavior;
    if (behavior.kind === "throw") {
      throw new CodingAgentError("INTERNAL_ERROR", "stub continue handoff failure", {
        phase: "continue",
      });
    }
    if (behavior.kind === "failure") {
      input.onOutput?.("continue partial line");
      return {
        status: "failed",
        stopReason: "error",
        failureCode: "POLICY_DENIED",
        failureMessage: "stub continue denied",
        failureDetails: { denied: ["continue"] },
      };
    }
    if (behavior.kind === "cancel") {
      return {
        status: "cancelled",
        stopReason: "cancelled",
      };
    }
    if (behavior.kind === "timed_out") {
      return {
        status: "timed_out",
        stopReason: "timed_out",
        failureCode: "TASK_TIMEOUT",
        failureMessage: "stub continue timed out",
      };
    }
    input.onOutput?.("continue line one");
    return {
      ...(behavior.sessionId !== undefined ? { sessionId: behavior.sessionId } : {}),
      sessionResumable: true,
      assistantText: "continue assistant done",
      outputLines: ["continue output line"],
      status: "completed",
      stopReason: "end_turn",
    };
  }
}

function setupEnv(opts: { outputLimitBytes?: number } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-managed-continue-"));
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

async function startManaged(env: ReturnType<typeof setupEnv>, stub: StubManagedContinueAgent) {
  const started = await env.taskManager.startTask({
    repository: "test-repo",
    agent: stub.id,
    instruction: "do managed work",
    mode: "implement",
  });
  assert.equal(started.status, "completed");
  return started;
}

test("managed continue succeeds after managed start and preserves session; output appended", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up one",
    });
    assert.equal(continued.status, "completed");
    assert.equal(continued.instruction, "follow up one");
    assert.equal(stub.prepareContinueCalled, false, "managed path must not call prepareContinue");

    // Hook input contract: existing session is handed through.
    assert.ok(stub.seenContinueInput);
    assert.equal(stub.seenContinueInput.taskId, started.task_id);
    assert.equal(stub.seenContinueInput.sessionId, "sess-stub-continue-1");
    assert.equal(stub.seenContinueInput.instruction, "follow up one");
    assert.equal(stub.seenContinueInput.mode, "implement");
    assert.ok(stub.seenContinueInput.workspaceRoot.length > 0);
    assert.ok((stub.seenContinueInput.timeoutMs ?? 0) > 0);

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);
    // No replacement id returned: the existing session is preserved.
    assert.equal(task.sessionId, "sess-stub-continue-1");
    assert.equal(task.sessionResumable, true);
    assert.equal(task.followUpInstructions.length, 1);
    assert.equal(task.followUpInstructions[0].text, "follow up one");

    // Start output is still present: continuation appends, never overwrites.
    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100000).output;
    assert.ok(output.includes("start line one"));
    assert.ok(output.includes("start assistant done"));
    assert.ok(output.includes("continue line one"));
    assert.ok(output.includes("continue assistant done"));
    assert.ok(output.includes("continue output line"));
    assert.ok(fs.existsSync(`${task.logPath}.stdout`));

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 2);
    assert.equal(audits.filter((e) => e.type === "agent.process_spawned").length, 0);
  } finally {
    env.cleanup();
  }
});

test("managed continue adopts a replacement sessionId when returned", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  stub.continueBehavior = { kind: "success", sessionId: "sess-stub-continue-2" };
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);
    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up with rotation",
    });
    assert.equal(continued.status, "completed");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.sessionId, "sess-stub-continue-2");
    assert.equal(task.sessionResumable, true);
  } finally {
    env.cleanup();
  }
});

test("managed continue hook throw rolls back task and follow-ups", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);
    stub.continueBehavior = { kind: "throw" };

    await assert.rejects(
      () =>
        env.taskManager.continueTask({
          task_id: started.task_id,
          instruction: "failing follow up",
        }),
      (err: any) => err instanceof CodingAgentError && err.code === "INTERNAL_ERROR"
    );

    const restored = env.taskManager.getTask(started.task_id);
    assert.equal(restored.status, "completed");
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.followUpInstructions.length, 0);
    assert.equal(restored.failure, undefined);
    assert.equal(restored.sessionId, "sess-stub-continue-1");

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.completed").length, 1);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 0);
  } finally {
    env.cleanup();
  }
});

test("managed continue structured failure maps code/message/details", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);
    stub.continueBehavior = { kind: "failure" };

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "denied follow up",
    });
    assert.equal(continued.status, "failed");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.failure?.code, "POLICY_DENIED");
    assert.equal(task.failure?.message, "stub continue denied");
    assert.deepEqual(task.failure?.details, { denied: ["continue"] });

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100000).output;
    assert.ok(output.includes("continue partial line"));

    assert.equal(env.processManager.getRunningProcessCount(), 0);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.equal(audits.filter((e) => e.type === "task.failed").length, 1);
  } finally {
    env.cleanup();
  }
});

test("managed continue cancel and timeout map to terminal states", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);
    stub.continueBehavior = { kind: "cancel" };
    const cancelled = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "cancelled follow up",
    });
    assert.equal(cancelled.status, "cancelled");
    const cancelledTask = env.taskManager.getTask(started.task_id);
    assert.equal(cancelledTask.status, "cancelled");
    assert.equal(cancelledTask.failure?.code, "TASK_CANCELLED");
  } finally {
    env.cleanup();
  }

  const env2 = setupEnv();
  const stub2 = new StubManagedContinueAgent();
  env2.agentRegistry.registerAgent(stub2);
  try {
    const started = await startManaged(env2, stub2);
    stub2.continueBehavior = { kind: "timed_out" };
    const timedOut = await env2.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "slow follow up",
    });
    assert.equal(timedOut.status, "timed_out");
    const timedOutTask = env2.taskManager.getTask(started.task_id);
    assert.equal(timedOutTask.status, "timed_out");
    assert.equal(timedOutTask.failure?.code, "TASK_TIMEOUT");
  } finally {
    env2.cleanup();
  }
});

test("managed continue rejects without sessionId or resumability", async () => {
  const env = setupEnv();
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);

    // Strip the session: the managed hook must never be reached.
    const stored = env.taskStore.getTask(started.task_id)!;
    stored.sessionId = undefined;
    env.taskStore.saveTask(stored);

    await assert.rejects(
      () =>
        env.taskManager.continueTask({
          task_id: started.task_id,
          instruction: "follow up without session",
        }),
      (err: any) => err instanceof CodingAgentError && err.code === "TASK_NOT_RESUMABLE"
    );
    assert.equal(stub.seenContinueInput, undefined);
    assert.equal(env.processManager.getRunningProcessCount(), 0);

    // A non-completed task is equally unresumable.
    const failed = env.taskStore.getTask(started.task_id)!;
    failed.status = "failed";
    failed.sessionId = "sess-stub-continue-1";
    failed.sessionResumable = true;
    env.taskStore.saveTask(failed);
    await assert.rejects(
      () =>
        env.taskManager.continueTask({
          task_id: started.task_id,
          instruction: "follow up on failed task",
        }),
      (err: any) => err.code === "TASK_NOT_RESUMABLE"
    );
  } finally {
    env.cleanup();
  }
});

test("managed continue output shares the cumulative output cap with start", async () => {
  const env = setupEnv({ outputLimitBytes: 60 });
  const stub = new StubManagedContinueAgent();
  env.agentRegistry.registerAgent(stub);
  try {
    const started = await startManaged(env, stub);
    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up over the limit",
    });
    assert.equal(continued.status, "completed");

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.outputTruncated, true);
    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.ok(audits.some((e) => e.type === "agent.output_truncated"));

    // Start output survives; the log stays bounded near the shared limit.
    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100000).output;
    assert.ok(output.includes("start line one"));
    const stat = fs.statSync(task.logPath);
    assert.ok(stat.size <= 500, "log must stay bounded near the limit plus warning");
  } finally {
    env.cleanup();
  }
});

test("legacy continue path without the managed hook is unchanged", async () => {
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

    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "legacy follow up",
    });
    assert.equal(continued.status, "running");

    task = env.taskManager.getTask(started.task_id);
    while (task.status === "running") {
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(started.task_id);
    }
    assert.equal(task.status, "completed");
    assert.equal(task.followUpInstructions.length, 1);

    const output = env.taskManager.getTaskOutput(started.task_id, 0, 100000).output;
    assert.ok(output.includes("FakeAgent started"));
    assert.ok(output.includes("FakeAgent continued"));

    const audits = env.readAudits().filter((e) => e.taskId === started.task_id);
    assert.ok(audits.some((e) => e.type === "agent.process_spawned"));
  } finally {
    env.cleanup();
  }
});
