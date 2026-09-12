import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgyAcpAdapter } from "../../src/agents/agy-acp-adapter.js";
import { AcpClient } from "../../src/agents/acp/client.js";
import { CodingAgentError, ErrorCodes } from "../../src/domain/errors.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    acp_executable: process.execPath,
    auth_method: "oauth-personal",
    mode: "default",
    allow_write_worktree: false,
    state_dir: fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-")),
    default_timeout_seconds: 60,
    env_allowlist: ["HOME", "PATH", "TMPDIR"],
    ...overrides,
  } as any;
}

function authRequiredError(method: string): CodingAgentError {
  return new CodingAgentError(
    ErrorCodes.INTERNAL_ERROR,
    `ACP request '${method}' failed: Authentication required (code -32000)`,
    {
      method,
      requestId: 2,
      code: -32000,
      data: "call authenticate (supports oauth-personal, gemini-api-key, agent-platform) or set auth.type",
    }
  );
}

function unrelated32000Error(): CodingAgentError {
  return new CodingAgentError(
    ErrorCodes.INTERNAL_ERROR,
    "ACP request 'session/new' failed: quota exceeded (code -32000)",
    { method: "session/new", requestId: 2, code: -32000, data: "quota exceeded" }
  );
}

function makeWorkspace(): { workspace: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");
  return { workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test("persistent GEMINI_HOME is shared across task IDs while HOME stays per-task", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-profile-"));
  try {
    const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
    const a = adapter.buildIsolatedEnv("task_alpha_1", {});
    const b = adapter.buildIsolatedEnv("task_beta_2", {});

    assert.notEqual(a.homeDir, b.homeDir);
    assert.notEqual(a.env.HOME, b.env.HOME);
    assert.equal(a.geminiHome, b.geminiHome);
    assert.equal(a.env.GEMINI_HOME, b.env.GEMINI_HOME);
    assert.equal(a.env.GEMINI_HOME, path.join(stateDir, "profile", ".gemini"));
    assert.equal(a.profileDir, path.join(stateDir, "profile"));
    assert.equal(a.homeDir, path.join(stateDir, "tasks", "task_alpha_1", "home"));
    assert.equal(b.homeDir, path.join(stateDir, "tasks", "task_beta_2", "home"));
    assert.ok(fs.existsSync(a.homeDir) && fs.existsSync(b.homeDir));
    assert.ok(fs.existsSync(a.geminiHome));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(a.homeDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(a.profileDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(a.geminiHome).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("persistent profile strips host credentials and forces file storage", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-profile-creds-"));
  try {
    const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
    const { env, homeDir, geminiHome } = adapter.buildIsolatedEnv("task_host_1", {
      PATH: "/usr/bin:/bin",
      HOME: "/evil-home",
      GEMINI_HOME: "/evil-gemini",
      GOOGLE_API_KEY: "secret-google",
      GEMINI_API_KEY: "secret-gemini",
      GOOGLE_APPLICATION_CREDENTIALS: "/host/creds.json",
      ANTIGRAVITY_TOKEN: "secret-antigravity",
      AGY_ACP_FORCE_FILE_STORAGE: "0",
      CUSTOM_KEEP: "keep-me",
    });
    assert.equal(env.HOME, homeDir);
    assert.notEqual(env.HOME, "/evil-home");
    assert.equal(env.GEMINI_HOME, geminiHome);
    assert.notEqual(env.GEMINI_HOME, "/evil-gemini");
    assert.equal(env.GOOGLE_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env.ANTIGRAVITY_TOKEN, undefined);
    assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.equal(env.CUSTOM_KEEP, "keep-me");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("session/new auth-required authenticates once with oauth-personal and retries", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-new-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const origNew = AcpClient.prototype.sessionNew;
  const origAuth = AcpClient.prototype.authenticate;
  let newCalls = 0;
  const authParams: unknown[] = [];
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    newCalls += 1;
    if (newCalls === 1) return Promise.reject(authRequiredError("session/new"));
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    authParams.push(params);
    return origAuth.call(this, params ?? {}, options as never);
  };
  try {
    const result = await adapter.runAcpTurn({
      executable: process.execPath,
      args: [FIXTURE],
      prompt: "read the readme",
      timeoutMs: 15_000,
      workspaceRoot: workspace,
      mode: "implement",
    });
    assert.equal(newCalls, 2);
    assert.equal(authParams.length, 1);
    assert.deepEqual(authParams[0], { methodId: "oauth-personal" });
    assert.ok(result.sessionId.startsWith("sess-"));
    assert.equal(result.stopReason, "end_turn");
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = origAuth;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("gemini-api-key authenticates before session/new even when a session would already open", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-gemini-"));
  const adapter = new AgyAcpAdapter(
    makeConfig({
      state_dir: stateDir,
      auth_method: "gemini-api-key",
    })
  );
  const origNew = AcpClient.prototype.sessionNew;
  const origAuth = AcpClient.prototype.authenticate;
  const calls: string[] = [];
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    calls.push("session/new");
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    calls.push(`authenticate:${String(params?.methodId)}`);
    return origAuth.call(this, params ?? {}, options as never);
  };
  try {
    const result = await adapter.runAcpTurn({
      executable: process.execPath,
      args: [FIXTURE],
      prompt: "read the readme",
      timeoutMs: 15_000,
      workspaceRoot: workspace,
      mode: "implement",
      baseEnv: { GEMINI_API_KEY: "explicit-test-key" },
    });
    assert.deepEqual(calls.slice(0, 2), ["authenticate:gemini-api-key", "session/new"]);
    assert.equal(calls.filter((call) => call.startsWith("authenticate:")).length, 1);
    assert.ok(result.sessionId.startsWith("sess-"));
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = origAuth;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unrelated -32000 on session/new never triggers authenticate", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-unrelated-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const origNew = AcpClient.prototype.sessionNew;
  const origAuth = AcpClient.prototype.authenticate;
  let newCalls = 0;
  let authCalls = 0;
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function () {
    newCalls += 1;
    return Promise.reject(unrelated32000Error());
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    authCalls += 1;
    return origAuth.call(this, params ?? {}, options as never);
  };
  try {
    await assert.rejects(
      () =>
        adapter.runAcpTurn({
          executable: process.execPath,
          args: [FIXTURE],
          prompt: "read the readme",
          timeoutMs: 15_000,
          workspaceRoot: workspace,
          mode: "implement",
        }),
      (err: any) => {
        assert.ok(err instanceof CodingAgentError);
        assert.ok(String(err.message).includes("quota exceeded"));
        assert.equal((err.details as any)?.code, -32000);
        return true;
      }
    );
    assert.equal(newCalls, 1);
    assert.equal(authCalls, 0);
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = origAuth;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("authenticate failure surfaces without a session/new retry", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-fail-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const origNew = AcpClient.prototype.sessionNew;
  const origAuth = AcpClient.prototype.authenticate;
  let newCalls = 0;
  let authCalls = 0;
  const authFailure = new CodingAgentError(
    ErrorCodes.INTERNAL_ERROR,
    "ACP request 'authenticate' failed: oauth browser cancelled (code -32000)",
    { method: "authenticate", requestId: 3, code: -32000 }
  );
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    newCalls += 1;
    if (newCalls === 1) return Promise.reject(authRequiredError("session/new"));
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = function () {
    authCalls += 1;
    return Promise.reject(authFailure);
  };
  try {
    await assert.rejects(
      () =>
        adapter.runAcpTurn({
          executable: process.execPath,
          args: [FIXTURE],
          prompt: "read the readme",
          timeoutMs: 15_000,
          workspaceRoot: workspace,
          mode: "implement",
        }),
      (err: any) => {
        assert.ok(err instanceof CodingAgentError);
        assert.ok(String(err.message).includes("browser cancelled"));
        return true;
      }
    );
    assert.equal(authCalls, 1);
    assert.equal(newCalls, 1);
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = origAuth;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("session/resume auth-required reauthenticates once and keeps the same session id", async () => {
  assert.ok(fs.existsSync(FIXTURE));
  const { workspace, cleanup } = makeWorkspace();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-auth-resume-"));
  const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
  const requested = "sess-keep-123";
  const origResume = AcpClient.prototype.sessionResume;
  const origPrompt = AcpClient.prototype.sessionPrompt;
  const origAuth = AcpClient.prototype.authenticate;
  const origNew = AcpClient.prototype.sessionNew;
  let resumeCalls: unknown[] = [];
  let newCalls = 0;
  const authParams: unknown[] = [];
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    newCalls += 1;
    return origNew.call(this, params, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionResume = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    resumeCalls.push(params);
    if (resumeCalls.length === 1) return Promise.reject(authRequiredError("session/resume"));
    return Promise.resolve({ sessionId: requested, resumed: true });
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = function (
    this: AcpClient,
    params?: Record<string, unknown>,
    options?: unknown
  ) {
    authParams.push(params);
    return origAuth.call(this, params ?? {}, options as never);
  };
  (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = function () {
    return Promise.resolve({
      stopReason: "end_turn",
      sessionId: requested,
      assistantText: "resumed ok",
    });
  };
  try {
    const result = await adapter.runAcpTurn({
      executable: process.execPath,
      args: [FIXTURE],
      prompt: "follow up",
      timeoutMs: 15_000,
      workspaceRoot: workspace,
      mode: "implement",
      sessionId: requested,
    });
    assert.equal(newCalls, 0);
    assert.equal(resumeCalls.length, 2);
    assert.deepEqual(resumeCalls[0], { sessionId: requested });
    assert.deepEqual(resumeCalls[1], { sessionId: requested });
    assert.equal(authParams.length, 1);
    assert.deepEqual(authParams[0], { methodId: "oauth-personal" });
    assert.equal(result.sessionId, requested);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.assistantText, "resumed ok");
  } finally {
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionResume = origResume;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionPrompt = origPrompt;
    (AcpClient.prototype as unknown as Record<string, unknown>).authenticate = origAuth;
    (AcpClient.prototype as unknown as Record<string, unknown>).sessionNew = origNew;
    cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
