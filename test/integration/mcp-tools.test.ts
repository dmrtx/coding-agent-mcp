import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../src/server/mcp-server.js";
import { TaskManager } from "../../src/orchestration/task-manager.js";
import { ProcessManager } from "../../src/orchestration/process-manager.js";
import { TaskStore } from "../../src/persistence/task-store.js";
import { AuditStore } from "../../src/persistence/audit-store.js";
import { GitService } from "../../src/repositories/git-service.js";
import { WorkspaceManager } from "../../src/repositories/workspace-manager.js";
import { RepositoryRegistry } from "../../src/repositories/repository-registry.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { FakeAgentAdapter } from "../../src/agents/fake-agent-adapter.js";
import { VerificationService } from "../../src/verification/verification-service.js";
import { AppConfig } from "../../src/config/schema.js";

function setupTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-test-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);

  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'MCP Tester'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'tester@example.com'", { cwd: repoDir, stdio: "ignore" });

  fs.writeFileSync(path.join(repoDir, "hello.txt"), "hello world\n");
  execSync("git add hello.txt && git commit -m 'Initial commit'", {
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
      "my-project": {
        root: repoDir,
        writable: true,
        default_workspace_strategy: "worktree",
        verification_profiles: {
          test: {
            command: [process.execPath, "-e", "console.log('tests passed')"],
            timeout_seconds: 30,
          },
        },
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
  const verificationService = new VerificationService();

  const taskManager = new TaskManager(
    config,
    repoRegistry,
    workspaceManager,
    agentRegistry,
    processManager,
    taskStore,
    auditStore
  );

  const server = createMcpServer({
    agentRegistry,
    repoRegistry,
    taskManager,
    gitService,
    verificationService,
    workspaceManager,
  });

  return {
    tmpDir,
    server,
    taskManager,
    taskStore,
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("MCP Client can call all 10 tools end-to-end", async () => {
  const env = setupTestEnvironment();

  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await env.server.connect(serverTransport);

    const client = new Client({ name: "test-supervisor", version: "1.0.0" });
    await client.connect(clientTransport);

    // 1. list_agents
    const agentsResult = await client.callTool({ name: "list_agents", arguments: {} });
    const agentsContent = JSON.parse((agentsResult.content as any)[0].text);
    assert.ok(agentsContent.agents);
    assert.ok(agentsContent.agents.some((a: any) => a.id === "fake-agent"));

    // 2. list_repositories
    const reposResult = await client.callTool({ name: "list_repositories", arguments: {} });
    const reposContent = JSON.parse((reposResult.content as any)[0].text);
    assert.ok(reposContent.repositories);
    assert.equal(reposContent.repositories[0].id, "my-project");

    // 3. start_task
    const startResult = await client.callTool({
      name: "start_task",
      arguments: {
        repository: "my-project",
        agent: "fake-agent",
        instruction: "implement new feature",
      },
    });
    const startData = JSON.parse((startResult.content as any)[0].text);
    assert.ok(startData.task_id);
    const taskId = startData.task_id;

    // Wait for task to finish
    let task = env.taskManager.getTask(taskId);
    while (task.status === "running" || task.status === "starting") {
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(taskId);
    }
    assert.equal(task.status, "completed");

    // 4. get_task
    const getTaskResult = await client.callTool({
      name: "get_task",
      arguments: { task_id: taskId },
    });
    const getTaskData = JSON.parse((getTaskResult.content as any)[0].text);
    assert.equal(getTaskData.task_id, taskId);
    assert.equal(getTaskData.status, "completed");

    // 5. get_task_output
    const outputResult = await client.callTool({
      name: "get_task_output",
      arguments: { task_id: taskId, cursor: 0, max_bytes: 1000 },
    });
    const outputData = JSON.parse((outputResult.content as any)[0].text);
    assert.ok(outputData.output.includes("FakeAgent started"));

    // 6. get_repo_status
    const repoStatusResult = await client.callTool({
      name: "get_repo_status",
      arguments: { task_id: taskId },
    });
    const repoStatusData = JSON.parse((repoStatusResult.content as any)[0].text);
    assert.equal(typeof repoStatusData.clean, "boolean");

    // 7. get_diff
    const diffResult = await client.callTool({
      name: "get_diff",
      arguments: { task_id: taskId },
    });
    const diffData = JSON.parse((diffResult.content as any)[0].text);
    assert.equal(typeof diffData.truncated, "boolean");

    // 8. run_verification
    const verifyResult = await client.callTool({
      name: "run_verification",
      arguments: { task_id: taskId, profile: "test" },
    });
    const verifyData = JSON.parse((verifyResult.content as any)[0].text);
    assert.equal(verifyData.passed, true);
    assert.equal(verifyData.exit_code, 0);

    // 9. continue_task
    const continueResult = await client.callTool({
      name: "continue_task",
      arguments: { task_id: taskId, instruction: "correct issue" },
    });
    const continueData = JSON.parse((continueResult.content as any)[0].text);
    assert.equal(continueData.task_id, taskId);

    // Wait for continuation to complete
    task = env.taskManager.getTask(taskId);
    while (task.status === "running") {
      await new Promise((r) => setTimeout(r, 100));
      task = env.taskManager.getTask(taskId);
    }
    assert.equal(task.status, "completed");

    // 10. cancel_task
    const sleepTask = await env.taskManager.startTask({
      repository: "my-project",
      agent: "fake-agent",
      instruction: "sleep 10000",
    });
    const cancelResult = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: sleepTask.task_id },
    });
    const cancelData = JSON.parse((cancelResult.content as any)[0].text);
    assert.equal(cancelData.task_id, sleepTask.task_id);
    assert.equal(cancelData.cancelled, true);

    await client.close();
  } finally {
    env.cleanup();
  }
});
