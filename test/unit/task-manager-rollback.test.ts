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
  const processManager = new ProcessManager(1000, dataDir);

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
    dataDir,
    taskManager,
    taskStore,
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
