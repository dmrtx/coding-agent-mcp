import test from "node:test";
import assert from "node:assert/strict";
import { MuseAdapter } from "../../src/agents/muse-adapter.js";
import { AgyAdapter } from "../../src/agents/agy-adapter.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { AppConfigSchema } from "../../src/config/schema.js";

test("MuseAdapter constructs safe headless arguments without --yolo", async () => {
  const adapter = new MuseAdapter({
    enabled: true,
    executable: "muse",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const spawnInfo = await adapter.prepareStart({
    taskId: "task-test-muse",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "fix bug",
    mode: "implement",
    timeoutMs: 60000,
    environment: {},
    sessionId: "11111111-2222-3333-4444-555555555555",
  });

  // Verify critical safety flags
  assert.ok(!spawnInfo.args.includes("--yolo"), "Muse must NOT be executed with --yolo (disables sandbox)");
  assert.ok(spawnInfo.args.includes("--trust-workspace"), "Muse must use --trust-workspace to avoid interactive prompts");
  assert.ok(spawnInfo.args.includes("--disable-approval"), "Muse must use --disable-approval for headless execution");
  assert.ok(spawnInfo.args.includes("--approval-mode"), "Muse must specify approval-mode");
  assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--approval-mode") + 1], "never");
  assert.ok(spawnInfo.args.includes("--session-id"));
  assert.equal(
    spawnInfo.args[spawnInfo.args.indexOf("--session-id") + 1],
    "11111111-2222-3333-4444-555555555555"
  );
  assert.ok(spawnInfo.args.includes("fix bug"));

  // Review mode disables write and shell
  const reviewSpawn = await adapter.prepareStart({
    taskId: "task-test-muse-review",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "review changes",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(reviewSpawn.args.includes("--disable-write"), "Review mode must include --disable-write");
  assert.ok(reviewSpawn.args.includes("--disable-shell"), "Review mode must include --disable-shell");

  // Continuation preserves trust-workspace and session-id
  const contSpawn = await adapter.prepareContinue({
    taskId: "task-test-muse",
    workspaceRoot: "/workspace",
    sessionId: "11111111-2222-3333-4444-555555555555",
    instruction: "follow-up fix",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(contSpawn.args.includes("--trust-workspace"));
  assert.ok(contSpawn.args.includes("--disable-write"));
  assert.ok(contSpawn.args.includes("--disable-shell"));
});

test("AgyAdapter constructs safe headless arguments with sandbox and json output", async () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const spawnInfo = await adapter.prepareStart({
    taskId: "task-test-agy",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "create feature",
    mode: "implement",
    timeoutMs: 60000,
    environment: {},
  });

  assert.ok(spawnInfo.args.includes("--sandbox"), "AGY must be executed with --sandbox enabled");
  assert.ok(spawnInfo.args.includes("--output-format"), "AGY must specify output-format");
  assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--output-format") + 1], "json");
  assert.ok(spawnInfo.args.includes("--dangerously-skip-permissions"));
  assert.ok(spawnInfo.args.includes("create feature"));
  // Must NOT have invented arbitrary sessionId
  assert.equal(spawnInfo.sessionId, undefined);

  // Review mode uses plan
  const reviewSpawn = await adapter.prepareStart({
    taskId: "task-test-agy-review",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "review feature",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(reviewSpawn.args.includes("--mode"));
  assert.equal(reviewSpawn.args[reviewSpawn.args.indexOf("--mode") + 1], "plan");

  // Continuation uses real conversation id and does not use --continue
  const continueSpawn = await adapter.prepareContinue({
    taskId: "task-test-agy",
    workspaceRoot: "/workspace",
    sessionId: "conv-real-9999",
    instruction: "address review feedback",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(continueSpawn.args.includes("--conversation"));
  assert.equal(
    continueSpawn.args[continueSpawn.args.indexOf("--conversation") + 1],
    "conv-real-9999"
  );
  assert.ok(!continueSpawn.args.includes("--continue"), "AGY continue must not fall back to global --continue");
  assert.ok(continueSpawn.args.includes("--mode"));
  assert.equal(continueSpawn.args[continueSpawn.args.indexOf("--mode") + 1], "plan");

  // Continuation without sessionId is strictly rejected
  await assert.rejects(
    () =>
      adapter.prepareContinue({
        taskId: "task-test-agy",
        workspaceRoot: "/workspace",
        sessionId: undefined,
        instruction: "address feedback",
        timeoutMs: 60000,
        environment: {},
      }),
    (err: any) => err.code === "TASK_NOT_RESUMABLE"
  );
});

test("AgyAdapter extracts conversation_id from JSON and stream-json", () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  // Single JSON object
  const singleJson = JSON.stringify({
    conversation_id: "conv-abc-123",
    result: "completed successfully",
  });
  assert.equal(adapter.extractSessionId(singleJson, ""), "conv-abc-123");

  // camelCase conversationId
  const camelJson = JSON.stringify({
    conversationId: "conv-def-456",
    status: "ok",
  });
  assert.equal(adapter.extractSessionId(camelJson, ""), "conv-def-456");

  // Stream-json NDJSON lines
  const streamJson = [
    JSON.stringify({ type: "init", conversation_id: "conv-stream-789" }),
    JSON.stringify({ type: "progress", message: "working..." }),
  ].join("\n");
  assert.equal(adapter.extractSessionId(streamJson, ""), "conv-stream-789");

  // Empty or invalid returns undefined
  assert.equal(adapter.extractSessionId("", ""), undefined);
  assert.equal(adapter.extractSessionId("just plain text without id", ""), undefined);
});

test("AgentRegistry blocks disabled and unavailable agents", async () => {
  const config = AppConfigSchema.parse({
    agents: {
      disabled_agent: {
        enabled: false,
        executable: "none",
      },
    },
  });

  const registry = new AgentRegistry(config);
  // Disabled agent
  await assert.rejects(
    () => registry.validateAgentAvailable("disabled_agent"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );

  // Unregistered agent
  await assert.rejects(
    () => registry.validateAgentAvailable("unknown_agent"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );
});
