import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgyAcpAdapter } from "../../src/agents/agy-acp-adapter.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { AppConfigSchema } from "../../src/config/schema.js";
import { CodingAgentError } from "../../src/domain/errors.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");
const MISSING_EXE = "/nonexistent/definitely-missing-agy-acp-binary";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    acp_executable: process.execPath,
    auth_method: "oauth-personal",
    mode: "default",
    allow_write_worktree: false,
    state_dir: fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-adapter-")),
    default_timeout_seconds: 60,
    env_allowlist: ["HOME", "PATH", "TMPDIR"],
    ...overrides,
  } as any;
}

test("agy-acp is NOT registered when disabled", () => {
  const parsed = AppConfigSchema.parse({ agents: { "agy-acp": { enabled: false } } });
  const registry = new AgentRegistry(parsed);
  assert.throws(
    () => registry.getAgent("agy-acp"),
    (err: any) => err instanceof CodingAgentError && err.code === "AGENT_NOT_AVAILABLE"
  );
});

test("agy-acp is NOT registered when omitted or defaults (disabled by default)", () => {
  const omitted = AppConfigSchema.parse({ agents: { agy: { enabled: true } } });
  assert.throws(
    () => new AgentRegistry(omitted).getAgent("agy-acp"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );

  const defaults = AppConfigSchema.parse({});
  assert.equal(defaults.agents["agy-acp"].enabled, false);
  assert.throws(
    () => new AgentRegistry(defaults).getAgent("agy-acp"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );
});

test("agy-acp IS registered when enabled, legacy muse/agy unchanged", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-reg-"));
  try {
    const parsed = AppConfigSchema.parse({
      agents: {
        muse: { enabled: true, executable: "muse" },
        agy: { enabled: true, executable: "agy" },
        "agy-acp": { enabled: true, acp_executable: process.execPath, state_dir: stateDir },
      },
    });
    const registry = new AgentRegistry(parsed);
    const adapter = registry.getAgent("agy-acp");
    assert.equal(adapter.id, "agy-acp");
    // Legacy agents still resolve.
    assert.equal(registry.getAgent("muse").id, "muse");
    assert.equal(registry.getAgent("agy").id, "agy");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("describe reports unavailable when disabled or binary missing; available when present", async () => {
  const disabled = new AgyAcpAdapter(makeConfig({ enabled: false }));
  assert.equal((await disabled.describe()).available, false);

  const missing = new AgyAcpAdapter(makeConfig({ enabled: true, acp_executable: MISSING_EXE }));
  const missingDesc = await missing.describe();
  assert.equal(missingDesc.id, "agy-acp");
  assert.equal(missingDesc.available, false);
  assert.equal(await missing.isExecutableAvailable(), false);

  const present = new AgyAcpAdapter(makeConfig({ enabled: true, acp_executable: process.execPath }));
  assert.equal(await present.isExecutableAvailable(), true);
  assert.equal((await present.describe()).available, true);

  // A directory is not a runnable binary.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-dir-exe-"));
  try {
    const dirExe = new AgyAcpAdapter(makeConfig({ enabled: true, acp_executable: dir }));
    assert.equal(await dirExe.isExecutableAvailable(), false);
    assert.equal((await dirExe.describe()).available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing executable fails typed without falling back to legacy agy", async () => {
  const adapter = new AgyAcpAdapter(makeConfig({ enabled: true, acp_executable: MISSING_EXE }));
  await assert.rejects(
    () => adapter.runAcpTurn({ prompt: "hello", timeoutMs: 5000 }),
    (err: any) => {
      assert.ok(err instanceof CodingAgentError, "must be a typed CodingAgentError");
      assert.equal(err.code, "AGENT_NOT_AVAILABLE");
      assert.ok(String(err.message).includes("agy-acp"), "error must name agy-acp");
      assert.ok(!String(err.message).includes("legacy"), "should not mention fallback success");
      return true;
    }
  );
  // prepareStart/Continue fail closed (slice 2 wires TaskManager).
  await assert.rejects(
    () =>
      adapter.prepareStart({
        taskId: "t",
        repositoryRoot: "/repo",
        workspaceRoot: "/repo",
        instruction: "hi",
        mode: "implement",
        timeoutMs: 1000,
        environment: {},
      }),
    (err: any) => err.code === "INTERNAL_ERROR"
  );
});

test("isolated env uses per-task HOME/GEMINI_HOME under state_dir with 0700 and stripped credentials", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-env-"));
  try {
    const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
    const { env, homeDir, geminiHome, taskDir } = adapter.buildIsolatedEnv("task_123_abc", {
      PATH: "/usr/bin:/bin",
      HOME: "/host/home-should-not-be-reused",
      GOOGLE_API_KEY: "secret-google",
      GEMINI_API_KEY: "secret-gemini",
      GOOGLE_APPLICATION_CREDENTIALS: "/host/creds.json",
      ANTIGRAVITY_TOKEN: "secret-antigravity",
      CUSTOM_KEEP: "keep-me",
    });

    assert.ok(homeDir.startsWith(stateDir), "HOME must live under state_dir");
    assert.ok(geminiHome.startsWith(stateDir), "GEMINI_HOME must live under state_dir");
    assert.ok(taskDir.startsWith(stateDir), "task dir must live under state_dir");
    assert.equal(env.HOME, homeDir);
    assert.equal(env.GEMINI_HOME, geminiHome);
    assert.notEqual(env.HOME, "/host/home-should-not-be-reused");
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(env.CUSTOM_KEEP, "keep-me");
    assert.equal(env.GOOGLE_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env.ANTIGRAVITY_TOKEN, undefined);

    assert.ok(fs.existsSync(homeDir) && fs.existsSync(geminiHome));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(homeDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(geminiHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(taskDir).mode & 0o777, 0o700);
    }
    // No host HOME credential reuse: nothing copied from host HOME.
    assert.equal(fs.existsSync(path.join(geminiHome, "antigravity-oauth-token")), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("isolated env never copies host HOME credentials", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-nohost-"));
  const mockHome = path.join(tmpBase, "mock-home");
  fs.mkdirSync(path.join(mockHome, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(mockHome, ".gemini", "antigravity-oauth-token"), "HOST_SECRET", "utf-8");
  const stateDir = path.join(tmpBase, "state");
  const prevHome = process.env.HOME;
  process.env.HOME = mockHome;
  try {
    const adapter = new AgyAcpAdapter(makeConfig({ state_dir: stateDir }));
    const { env, homeDir } = adapter.buildIsolatedEnv("task_notoken_1", {});
    assert.notEqual(homeDir, mockHome);
    assert.notEqual(env.HOME, mockHome);
    const tokenPath = path.join(homeDir, ".gemini", "antigravity-oauth-token");
    assert.equal(fs.existsSync(tokenPath), false, "host token must never be copied");
    if (fs.existsSync(tokenPath)) {
      assert.ok(!fs.readFileSync(tokenPath, "utf-8").includes("HOST_SECRET"));
    }
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("fake-kernel turn captures sessionId, assistant text, and stopReason", async () => {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-turn-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");
  try {
    const adapter = new AgyAcpAdapter(makeConfig({ acp_executable: process.execPath }));
    const result = await adapter.runAcpTurn({
      executable: process.execPath,
      args: [FIXTURE],
      prompt: "read the readme",
      timeoutMs: 15_000,
      workspaceRoot: workspace,
      mode: "implement",
    });
    assert.ok(result.sessionId.startsWith("sess-"), `expected sess-* id, got ${result.sessionId}`);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(typeof result.assistantText, "string");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("fake-kernel turn still completes fail-closed without policy context", async () => {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);
  const adapter = new AgyAcpAdapter(makeConfig({ acp_executable: process.execPath }));
  // No workspaceRoot/mode: the permission probe is denied, but the fake
  // kernel finishes on any answer so the turn lifecycle still completes.
  const result = await adapter.runAcpTurn({
    executable: process.execPath,
    args: [FIXTURE],
    prompt: "read the readme",
    timeoutMs: 15_000,
  });
  assert.ok(result.sessionId.startsWith("sess-"));
  assert.equal(result.stopReason, "end_turn");
});

// Exact fake-kernel probe envelope: { sessionId, toolCall, reason }.
function fakeProbe(toolCall: Record<string, unknown>) {
  return { sessionId: "sess-1", toolCall, reason: "fake kernel probe" };
}

function policyAdapter(overrides: Record<string, unknown> = {}) {
  return new AgyAcpAdapter(makeConfig(overrides));
}

function policyWorkspace(): { workspace: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pol-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");
  fs.writeFileSync(path.join(workspace, "notes.md"), "notes\n");
  return { workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

test("policy: in-workspace read is allowed in implement mode", () => {
  const { workspace, cleanup } = policyWorkspace();
  try {
    const adapter = policyAdapter({ allow_write_worktree: false });
    const answer = adapter.decidePermissionRequest(
      fakeProbe({ toolCallId: "tc-1", tool: "read", paths: ["README.md"] }),
      { workspaceRoot: workspace, mode: "implement" }
    );
    assert.equal(answer.decision, "allow");
    assert.ok(answer.reason.length > 0);
  } finally {
    cleanup();
  }
});

test("policy: review write is denied even when gated and contained", () => {
  const { workspace, cleanup } = policyWorkspace();
  try {
    const adapter = policyAdapter({ allow_write_worktree: true });
    const answer = adapter.decidePermissionRequest(
      fakeProbe({ toolCallId: "tc-2", tool: "write", paths: ["notes.md"] }),
      { workspaceRoot: workspace, mode: "review", allowWriteWorktree: true }
    );
    assert.equal(answer.decision, "deny");
  } finally {
    cleanup();
  }
});

test("policy: implement write is denied by default (gate off)", () => {
  const { workspace, cleanup } = policyWorkspace();
  try {
    const adapter = policyAdapter({ allow_write_worktree: false });
    const answer = adapter.decidePermissionRequest(
      { tool: "edit", paths: ["notes.md"] },
      { workspaceRoot: workspace, mode: "implement" }
    );
    assert.equal(answer.decision, "deny");
  } finally {
    cleanup();
  }
});

test("policy: implement write allowed only when gated and contained", () => {
  const { workspace, cleanup } = policyWorkspace();
  try {
    const gated = policyAdapter({ allow_write_worktree: true });
    const allowed = gated.decidePermissionRequest(
      { tool: "edit", paths: ["notes.md"] },
      { workspaceRoot: workspace, mode: "implement", allowWriteWorktree: true }
    );
    assert.equal(allowed.decision, "allow");

    // Gated but outside the workspace: still denied.
    const outside = gated.decidePermissionRequest(
      { tool: "edit", paths: ["/etc/passwd"] },
      { workspaceRoot: workspace, mode: "implement", allowWriteWorktree: true }
    );
    assert.equal(outside.decision, "deny");

    // Contained but gate off via per-turn override: denied.
    const ungated = gated.decidePermissionRequest(
      { tool: "edit", paths: ["notes.md"] },
      { workspaceRoot: workspace, mode: "implement", allowWriteWorktree: false }
    );
    assert.equal(ungated.decision, "deny");
  } finally {
    cleanup();
  }
});

test("policy: fail-closed without mode, workspace, or auditable payload", () => {
  const { workspace, cleanup } = policyWorkspace();
  try {
    const adapter = policyAdapter();
    const read = fakeProbe({ toolCallId: "tc-9", tool: "read", paths: ["README.md"] });

    assert.equal(
      adapter.decidePermissionRequest(read, { workspaceRoot: workspace }).decision,
      "deny",
      "missing mode must deny"
    );
    assert.equal(
      adapter.decidePermissionRequest(read, { mode: "implement" }).decision,
      "deny",
      "missing workspaceRoot must deny"
    );
    assert.equal(
      adapter.decidePermissionRequest(read, { workspaceRoot: workspace, mode: "yolo" as any }).decision,
      "deny",
      "unknown mode must deny"
    );
    assert.equal(
      adapter.decidePermissionRequest({ sessionId: "sess-1" }, { workspaceRoot: workspace, mode: "implement" }).decision,
      "deny",
      "unauditable payload must deny"
    );
    assert.equal(
      adapter.decidePermissionRequest(null, { workspaceRoot: workspace, mode: "implement" }).decision,
      "deny",
      "null payload must deny"
    );
  } finally {
    cleanup();
  }
});
