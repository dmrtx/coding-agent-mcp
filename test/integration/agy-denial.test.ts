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
import { AgyAdapter } from "../../src/agents/agy-adapter.js";
import {
  CodingAgent,
  AgentDescriptor,
  AgentStartInput,
  AgentContinueInput,
  AgentProcessSpawnInfo,
} from "../../src/domain/agent.js";
import { CodingTask } from "../../src/domain/task.js";
import { AppConfig } from "../../src/config/schema.js";

const DENIAL_JSON = fs
  .readFileSync(path.join(import.meta.dirname, "..", "fixtures", "agy-denial-result.json"), "utf-8")
  .trim();

const SUCCESS_JSON = JSON.stringify({
  conversation_id: "conv-stub-1",
  status: "SUCCESS",
  response: "done",
  duration_seconds: 0.1,
  num_turns: 1,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 15,
  },
});

// Stub that behaves like AGY on the wire (single JSON envelope on stdout,
// real conversation_id extraction) but delegates verdicts to the real
// AgyAdapter interpreter, so this exercises the genuine
// ProcessManager -> capture files -> TaskManager -> interpreter path.
class StubJsonAgent implements CodingAgent {
  public readonly id = "stub-json-agent";
  public readonly displayName = "Stub JSON Agent";
  private readonly agy = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 30,
  });

  async describe(): Promise<AgentDescriptor> {
    return { id: this.id, displayName: this.displayName, available: true, capabilities: ["modify_files"] };
  }

  private spawnFor(workspaceRoot: string, env: Record<string, string>, instruction: string): AgentProcessSpawnInfo {
    const payload = instruction.includes("deny") ? DENIAL_JSON : SUCCESS_JSON;
    return {
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(payload + "\n")});`],
      cwd: workspaceRoot,
      env,
    };
  }

  async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    return this.spawnFor(input.workspaceRoot, input.environment, input.instruction);
  }

  async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    return this.spawnFor(input.workspaceRoot, input.environment, input.instruction);
  }

  public extractSessionId(stdout: string, _stderr: string): string | undefined {
    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed && typeof parsed === "object" && typeof parsed.conversation_id === "string") {
        return parsed.conversation_id;
      }
    } catch {
      // Fall through to regex
    }
    const match = stdout.match(/"conversation_id"\s*:\s*"([^"]+)"/);
    return match ? match[1] : undefined;
  }

  public interpretResult(stdout: string, stderr: string) {
    return this.agy.interpretResult(stdout, stderr);
  }
}

function setupDenialEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-denial-e2e-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);

  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Project\n");
  execSync("git add README.md && git commit -m 'Initial commit'", { cwd: repoDir, stdio: "ignore" });

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
  agentRegistry.registerAgent(new StubJsonAgent());
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

  const waitForTerminal = async (taskId: string): Promise<CodingTask> => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const task = taskManager.getTask(taskId);
      if (task.status !== "running" && task.status !== "starting") return task;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for task ${taskId} to finish`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  return {
    taskManager,
    waitForTerminal,
    cleanup: () => {
      taskStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Exit-0 denial JSON through the real spawn path becomes failed/POLICY_DENIED", async () => {
  const env = setupDenialEnvironment();
  try {
    const started = await env.taskManager.startTask({
      repository: "sample-repo",
      agent: "stub-json-agent",
      instruction: "please deny this run",
    });

    const task = await env.waitForTerminal(started.task_id);

    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0, "exitCode must be preserved as 0");
    assert.equal(task.failure?.code, "POLICY_DENIED");

    // The verdict came from the flushed capture file, not the merged log
    const captured = fs.readFileSync(`${task.logPath}.stdout`, "utf-8");
    assert.ok(captured.includes("68ed6e74-9f0d-4f99-b4df-c452c0e90cc1"));
    assert.ok(captured.includes("denied_actions"));
  } finally {
    env.cleanup();
  }
});

test("Continuation exit-0 denial shares the same interpreter path and fails", async () => {
  const env = setupDenialEnvironment();
  try {
    const started = await env.taskManager.startTask({
      repository: "sample-repo",
      agent: "stub-json-agent",
      instruction: "please succeed",
    });

    let task = await env.waitForTerminal(started.task_id);
    assert.equal(task.status, "completed");
    assert.equal(task.sessionId, "conv-stub-1", "session must be captured for continuation");

    await env.taskManager.continueTask({
      task_id: started.task_id,
      instruction: "now deny this follow-up",
    });

    task = await env.waitForTerminal(started.task_id);
    assert.equal(task.status, "failed");
    assert.equal(task.exitCode, 0);
    assert.equal(task.failure?.code, "POLICY_DENIED");
  } finally {
    env.cleanup();
  }
});
