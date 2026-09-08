import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../../src/persistence/task-store.js";
import { AuditStore } from "../../src/persistence/audit-store.js";
import { CodingTask } from "../../src/domain/task.js";

test("TaskStore persists, retrieves and recovers tasks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskstore-test-"));
  const store = new TaskStore(tmpDir);

  const sampleTask: CodingTask = {
    id: "task-101",
    repositoryId: "repo-a",
    agentId: "muse",
    status: "running",
    instruction: "implement feature",
    followUpInstructions: [],
    mode: "implement",
    workspaceStrategy: "worktree",
    workspaceRoot: "/tmp/fake-workspace",
    createdAt: new Date().toISOString(),
    logPath: "/tmp/fake.log",
    sessionResumable: true,
  };

  store.saveTask(sampleTask);

  const retrieved = store.getTask("task-101");
  assert.ok(retrieved);
  assert.equal(retrieved.id, "task-101");
  assert.equal(retrieved.status, "running");
  assert.equal(retrieved.sessionResumable, true);

  // Recovery test: server restart recovers running tasks to failed
  const recovered = store.recoverOnStartup();
  assert.equal(recovered, 1);

  const afterRecovery = store.getTask("task-101");
  assert.equal(afterRecovery?.status, "failed");
  assert.equal(afterRecovery?.failure?.code, "TASK_CANCELLED");

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("AuditStore writes structured JSON lines", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  const auditStore = new AuditStore(tmpDir);

  auditStore.append({
    type: "task.created",
    taskId: "task-abc",
    details: { foo: "bar" },
  });

  const logFile = path.join(tmpDir, "audit.jsonl");
  assert.ok(fs.existsSync(logFile));

  const content = fs.readFileSync(logFile, "utf-8");
  const event = JSON.parse(content.trim());
  assert.equal(event.type, "task.created");
  assert.equal(event.taskId, "task-abc");
  assert.equal(event.details.foo, "bar");
  assert.ok(event.timestamp);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
