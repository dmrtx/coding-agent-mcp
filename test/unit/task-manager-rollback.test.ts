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
import { CodingAgent, AgentDescriptor, AgentStartInput, AgentProcessSpawnInfo } from "../../src/domain/agent.js";
import { AppConfig } from "../../src/config/schema.js";

// Failing agent that errors during prepareStart
class FailingAgent implements CodingAgent {
  public readonly id = "failing-agent";
  public readonly displayName = "Failing Agent";

  async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      capabilities: ["modify_files"],
    };
  }

  async prepareStart(_input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    throw new Error("Simulated agent preparation error");
  }

  async prepareContinue(_input: any): Promise<AgentProcessSpawnInfo> {
    throw new Error("Simulated continue agent error");
  }
}

class MissingBinaryAgent implements CodingAgent {
  public readonly id = "missing-binary-agent";
  public readonly displayName = "Missing Binary Agent";

  async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      capabilities: ["modify_files"],
    };
  }

  async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    return {
      command: "/definitely/missing/binary",
      args: ["--param"],
      cwd: input.workspaceRoot,
      env: input.environment,
    };
  }
}

class QuickInPlaceAgent implements CodingAgent {
  public readonly id = "quick-inplace-agent";
  public readonly displayName = "Quick In-Place Agent";

  async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: true,
      capabilities: ["modify_files"],
    };
  }

  async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    return {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId: "session-quick-1",
    };
  }

  async prepareContinue(input: any): Promise<AgentProcessSpawnInfo> {
    return {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId: input.sessionId,
    };
  }
}

function setupRollbackEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-rollback-test-"));
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
  const processManager = new ProcessManager(1000);

  agentRegistry.registerAgent(new FailingAgent());

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
    repoDir,
    dataDir,
    taskManager,
    taskStore,
    processManager,
    workspaceManager,
    repoRegistry,
    agentRegistry,
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("TaskManager rolls back workspace when agent startup fails", async () => {
  const env = setupRollbackEnvironment();

  try {
    await assert.rejects(
      () =>
        env.taskManager.startTask({
          repository: "test-repo",
          agent: "failing-agent",
          instruction: "will fail",
        }),
      /Simulated agent preparation error/
    );

    // Verify workspace was cleaned up and does not linger in workspaces directory
    const workspacesDir = path.join(env.dataDir, "workspaces");
    if (fs.existsSync(workspacesDir)) {
      const items = fs.readdirSync(workspacesDir);
      assert.equal(items.length, 0, "Failed workspace should be cleaned up immediately on startup failure");
    }

    // Verify task is recorded as failed
    const tasks = env.taskStore.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "failed");
    assert.ok(tasks[0].failure?.message.includes("Simulated agent preparation error"));
  } finally {
    env.cleanup();
  }
});

test("TaskManager rolls back task state and followUpInstructions when continueTask fails", async () => {
  const env = setupRollbackEnvironment();

  try {
    // Manually insert a completed task into the taskStore
    const fakeTask = {
      id: "task-rollback-continue",
      repositoryId: "test-repo",
      agentId: "failing-agent",
      status: "completed" as const,
      instruction: "initial instruction",
      followUpInstructions: [],
      mode: "implement" as const,
      workspaceStrategy: "worktree" as const,
      workspaceRoot: env.tmpDir,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
      exitCode: 0,
      logPath: path.join(env.dataDir, "task.log"),
      sessionResumable: true,
      sessionId: "session-123",
    };
    env.taskStore.saveTask(fakeTask);

    await assert.rejects(
      () =>
        env.taskManager.continueTask({
          task_id: fakeTask.id,
          instruction: "do something that will fail",
        }),
      /Simulated continue agent error/
    );

    // Verify rollback: task is back to completed, exitCode is 0, followUpInstructions was popped
    const restored = env.taskStore.getTask(fakeTask.id);
    assert.ok(restored);
    assert.equal(restored.status, "completed");
    assert.equal(restored.exitCode, 0);
    assert.equal(restored.followUpInstructions.length, 0);
  } finally {
    env.cleanup();
  }
});

test("TaskManager handles ENOENT for missing binary cleanly without unhandled error or server crash", async () => {
  const env = setupRollbackEnvironment();
  env.agentRegistry.registerAgent(new MissingBinaryAgent());

  try {
    await assert.rejects(
      () =>
        env.taskManager.startTask({
          repository: "test-repo",
          agent: "missing-binary-agent",
          instruction: "try run missing binary",
        }),
      (err: any) => err.code === "PROCESS_START_FAILED"
    );

    // Concurrency slot must be cleanly released
    assert.equal(env.processManager.getRunningProcessCount(), 0);

    // Workspace worktree directory must be cleaned up
    const workspacesDir = path.join(env.dataDir, "workspaces");
    if (fs.existsSync(workspacesDir)) {
      const items = fs.readdirSync(workspacesDir);
      assert.equal(items.length, 0, "Failed workspace must be cleaned up on missing binary");
    }

    // Task must be recorded as failed with PROCESS_START_FAILED
    const tasks = env.taskStore.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, "failed");
    assert.equal(tasks[0].failure?.code, "PROCESS_START_FAILED");
  } finally {
    env.cleanup();
  }
});

test("TaskManager enforces in_place one-shot non-resumable policy and releases lock upon exit", async () => {
  const env = setupRollbackEnvironment();
  // Enable allow_in_place on test-repo
  const repoConfig = env.repoRegistry.getRepository("test-repo");
  (repoConfig as any).allow_in_place = true;
  env.agentRegistry.registerAgent(new QuickInPlaceAgent());

  try {
    const started = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "quick-inplace-agent",
      instruction: "run in place",
      workspace_strategy: "in_place",
    });

    const task = env.taskStore.getTask(started.task_id)!;
    // Must be marked non-resumable
    assert.equal(task.sessionResumable, false, "in_place tasks must not be resumable");

    // Wait for task process to finish
    await new Promise((r) => setTimeout(r, 400));
    const completedTask = env.taskStore.getTask(started.task_id)!;
    assert.equal(completedTask.status, "completed");

    // continueTask must be strictly rejected
    await assert.rejects(
      () =>
        env.taskManager.continueTask({
          task_id: started.task_id,
          instruction: "continue in place",
        }),
      (err: any) => err.code === "TASK_NOT_RESUMABLE"
    );

    // Lock must have been released upon task completion, allowing a second in_place task!
    const secondStarted = await env.taskManager.startTask({
      repository: "test-repo",
      agent: "quick-inplace-agent",
      instruction: "second in place task",
      workspace_strategy: "in_place",
    });
    assert.ok(secondStarted.task_id);

    await new Promise((r) => setTimeout(r, 400));
    const secondTask = env.taskStore.getTask(secondStarted.task_id)!;
    assert.equal(secondTask.status, "completed");
  } finally {
    env.cleanup();
  }
});
