import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgyAcpAdapter } from "../../src/agents/agy-acp-adapter.js";
import { AcpClient } from "../../src/agents/acp/client.js";
import { CodingAgentError } from "../../src/domain/errors.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    acp_executable: process.execPath,
    auth_method: "oauth-personal",
    mode: "default",
    allow_write_worktree: false,
    state_dir: fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-")),
    default_timeout_seconds: 60,
    env_allowlist: ["HOME", "PATH", "TMPDIR"],
    ...overrides,
  } as any;
}

function makeWorkspace(): { workspace: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");
  return { workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

function baseTurn(workspace: string) {
  return {
    executable: process.execPath,
    args: [FIXTURE],
    workspaceRoot: workspace,
    mode: "implement" as const,
  };
}

test("session/prompt uses the managed turn timeoutMs, not the 120s default", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-timeout-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const origPrompt = AcpClient.prototype.sessionPrompt;
  const origNew = AcpClient.prototype.sessionNew;
  let promptTimeout: unknown;
  let newOptions: unknown;
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    promptTimeout = (options as Record<string, unknown> | undefined)?.timeoutMs;
    return origPrompt.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown,
  ) {
    newOptions = options;
    return origNew.call(this, params, options as never);
  };
  try {
    const result = await adapter.runAcpTurn({
      ...baseTurn(workspace),
      prompt: "read the readme",
      timeoutMs: 1_800_000,
    });
    assert.ok(result.sessionId.startsWith("sess-"));
    assert.ok(
      typeof promptTimeout === "number" && promptTimeout > 120_000,
      `prompt request timeout must exceed 120s default, got ${String(promptTimeout)}`,
    );
    assert.ok(
      (promptTimeout as number) <= 1_800_000,
      `prompt timeout must stay within the turn budget, got ${String(promptTimeout)}`,
    );
    // initialize/new/auth keep the generic path: no long per-request override.
    assert.ok(
      newOptions === undefined ||
        (typeof (newOptions as Record<string, unknown>).timeoutMs !== "number" ||
          ((newOptions as Record<string, unknown>).timeoutMs as number) <= 120_000),
      "session/new must not inherit the long prompt timeout",
    );
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = origPrompt;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("configured advertised model causes exactly one set_config_option before prompt", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-ok-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir, model: "test-model" }));
  const origPrompt = AcpClient.prototype.sessionPrompt;
  const origSet = AcpClient.prototype.sessionSetConfigOption;
  const origNew = AcpClient.prototype.sessionNew;
  const order: string[] = [];
  let setParams: unknown;
  let newParams: unknown;
  let setCount = 0;
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown,
  ) {
    newParams = params;
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    setCount += 1;
    setParams = params;
    order.push("set_config_option");
    return origSet.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    order.push("prompt");
    return origPrompt.call(this, params, options as never);
  };
  try {
    const result = await adapter.runAcpTurn({
      ...baseTurn(workspace),
      prompt: "read the readme",
      timeoutMs: 15_000,
    });
    assert.ok(result.sessionId.startsWith("sess-"));
    assert.equal(setCount, 1, "exactly one set_config_option");
    assert.deepEqual(order, ["set_config_option", "prompt"], "model must be applied before prompt");
    const params = setParams as Record<string, unknown>;
    assert.equal(params.sessionId, result.sessionId);
    assert.equal(params.configId, "model", "must use the actual selector id as configId");
    assert.equal(params.value, "test-model");
    // No ad-hoc model inside session/new params anymore.
    assert.ok(newParams !== null && typeof newParams === "object");
    assert.equal((newParams as Record<string, unknown>).model, undefined);
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = origPrompt;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = origSet;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unset model sends no set_config_option", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-unset-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const origSet = AcpClient.prototype.sessionSetConfigOption;
  let setCount = 0;
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    setCount += 1;
    return origSet.call(this, params, options as never);
  };
  try {
    const result = await adapter.runAcpTurn({
      ...baseTurn(workspace),
      prompt: "read the readme",
      timeoutMs: 15_000,
    });
    assert.ok(result.sessionId.startsWith("sess-"));
    assert.equal(setCount, 0, "unset model must send no set_config_option");
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = origSet;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unavailable model fails closed before prompt with INTERNAL_ERROR", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-bad-"));
  const adapter = new AgyAcpAdapter(
    makeConfig({ state_dir: stateDir, model: "no-such-model-xyz" }),
  );
  const origPrompt = AcpClient.prototype.sessionPrompt;
  const origSet = AcpClient.prototype.sessionSetConfigOption;
  let promptCount = 0;
  let setCount = 0;
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    promptCount += 1;
    return origPrompt.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    setCount += 1;
    return origSet.call(this, params, options as never);
  };
  try {
    await assert.rejects(
      () =>
        adapter.runAcpTurn({
          ...baseTurn(workspace),
          prompt: "read the readme",
          timeoutMs: 15_000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof CodingAgentError, "must be a typed CodingAgentError");
        assert.equal(err.code, "INTERNAL_ERROR");
        assert.ok(
          String(err.message).includes("no-such-model-xyz"),
          "error must name the configured model",
        );
        assert.ok(
          String(err.message).toLowerCase().includes("not among") ||
            String(err.message).toLowerCase().includes("not advertised"),
          "error must explain the fail-closed reason",
        );
        return true;
      },
    );
    assert.equal(promptCount, 0, "prompt must never run after a model mismatch");
    assert.equal(setCount, 0, "no set_config_option on mismatch (validation precedes the call)");
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = origPrompt;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = origSet;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("resume applies the configured model to the same session", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const prevPersist = process.env.AGY_ACP_FAKE_PERSIST;
  process.env.AGY_ACP_FAKE_PERSIST = "1";
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-model-resume-"));
  const taskId = "resume_model_task_1";
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir, model: "test-model" }));
  const origNew = AcpClient.prototype.sessionNew;
  const origResume = AcpClient.prototype.sessionResume;
  const origSet = AcpClient.prototype.sessionSetConfigOption;
  let newCount = 0;
  let resumeCount = 0;
  const setCalls: Array<Record<string, unknown>> = [];
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown,
  ) {
    newCount += 1;
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionResume = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    resumeCount += 1;
    return origResume.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = function (
    this: AcpClient,
    params: Record<string, unknown>,
    options?: unknown,
  ) {
    setCalls.push(params);
    return origSet.call(this, params, options as never);
  };
  try {
    const first = await adapter.runAcpTurn({
      ...baseTurn(workspace),
      prompt: "read the readme",
      timeoutMs: 15_000,
      taskId,
      baseEnv: { AGY_ACP_FAKE_PERSIST: "1" },
    });
    assert.ok(first.sessionId.startsWith("sess-"));
    assert.equal(newCount, 1);
    assert.equal(setCalls.length, 1);
    assert.equal(setCalls[0].sessionId, first.sessionId);
    assert.equal(setCalls[0].configId, "model");
    assert.equal(setCalls[0].value, "test-model");

    setCalls.length = 0;
    newCount = 0;
    resumeCount = 0;
    const second = await adapter.runAcpTurn({
      ...baseTurn(workspace),
      prompt: "follow up reading",
      timeoutMs: 15_000,
      taskId,
      baseEnv: { AGY_ACP_FAKE_PERSIST: "1" },
      sessionId: first.sessionId,
    });
    assert.equal(second.sessionId, first.sessionId, "resume must preserve the same session id");
    assert.equal(newCount, 0, "resume must never call session/new");
    assert.equal(resumeCount, 1, "resume must call session/resume once");
    assert.equal(setCalls.length, 1, "resume must apply the configured model once");
    assert.equal(setCalls[0].sessionId, first.sessionId);
    assert.equal(setCalls[0].configId, "model");
    assert.equal(setCalls[0].value, "test-model");
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionResume = origResume;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionSetConfigOption = origSet;
    if (prevPersist === undefined) delete process.env.AGY_ACP_FAKE_PERSIST;
    else process.env.AGY_ACP_FAKE_PERSIST = prevPersist;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
