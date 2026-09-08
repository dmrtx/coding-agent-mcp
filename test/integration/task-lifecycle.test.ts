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
import { AppConfig } from "../../src/config/schema.js";

function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-life-test-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);

  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });

  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Project\n");
  execSync("git add README.md && git commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "ignore",
  });

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
    agents: {
      "fake-agent": {
        enabled: true,
        default_timeout_seconds: 30,
        env_allowlist: ["PATH", "HOME"],
      },
    },
    repositories: {
      "sample-repo": {
        root: repoDir,
        writable: true,
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

  const fakeAgent = new FakeAgentAdapter();
  agentRegistry.registerAgent(fakeAgent);

  const processManager = new ProcessManager(1000);

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
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("TaskManager runs task to completion, captures output, and continues", async () => {
  const env = setupTestEnv();

  try {
    const started = await env.taskManager.startTask({
      repository: "sample-repo",
      agent: "fake-agent",
      instruction: "add test feature",
    });

    assert.ok(started.task_id);
    assert.equal(started.repository, "sample-repo");

    // Wait for task completion
    let task = env.taskManager.getTask(started.task_id);
    const deadline = Date.now() + 5000;
    while (task.status === "running" || task.status === "starting") {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(started.task_id);
    }

    assert.equal(task.status, "completed");
    assert.equal(task.exitCode, 0);

    // Verify task workspace file modification
    const wsFile = path.join(task.workspaceRoot, "agent-output.txt");
    assert.ok(fs.existsSync(wsFile));
    const wsContent = fs.readFileSync(wsFile, "utf-8");
    assert.ok(wsContent.includes("add test feature"));

    // Verify getTaskOutput
    const outputResult = env.taskManager.getTaskOutput(started.task_id, 0, 1000);
    assert.ok(outputResult.output.includes("FakeAgent started"));
    assert.equal(outputResult.truncated, false);

    // Continue task
    const continued = await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "follow up change",
    });
    assert.equal(continued.status, "running");

    // Wait for continuation completion
    task = env.taskManager.getTask(started.task_id);
    while (task.status === "running") {
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(started.task_id);
    }

    assert.equal(task.status, "completed");
    const continuedContent = fs.readFileSync(wsFile, "utf-8");
    assert.ok(continuedContent.includes("follow up change"));
  } finally {
    env.cleanup();
  }
});

test("TaskManager cancels a long running task", async () => {
  const env = setupTestEnv();

  try {
    const started = await env.taskManager.startTask({
      repository: "sample-repo",
      agent: "fake-agent",
      instruction: "sleep 10000",
    });

    await new Promise((r) => setTimeout(r, 100));
    const cancelRes = await env.taskManager.cancelTask(started.task_id);
    assert.equal(cancelRes.cancelled, true);

    const task = env.taskManager.getTask(started.task_id);
    assert.equal(task.status, "cancelled");
  } finally {
    env.cleanup();
  }
});
