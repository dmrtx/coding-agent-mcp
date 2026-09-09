import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideAcpToolPermission,
  resolveAcpSessionScratchRoot,
  type AcpTaskMode,
  type AcpToolCallShape,
} from "../../src/agents/acp/permission-policy.js";
import { AgyAcpAdapter } from "../../src/agents/agy-acp-adapter.js";

let workspace = "";
let outside = "";
let geminiHome = "";

test.before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-compat-ws-"));
  fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sub", "file.txt"), "hello\n");
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "acp-compat-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), "acp-compat-gemini-"));
});

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(geminiHome, { recursive: true, force: true });
});

const SESSION = "sess-abc123";
function scratchRoot(): string {
  const root = resolveAcpSessionScratchRoot(geminiHome, SESSION);
  assert.ok(typeof root === "string", "scratch root must resolve");
  return root as string;
}

function decide(
  mode: AcpTaskMode,
  toolCall: AcpToolCallShape,
  extra: { allowWriteWorktree?: boolean; internalScratchRoot?: string } = {}
) {
  return decideAcpToolPermission({
    workspaceRoot: workspace,
    mode,
    allowWriteWorktree: extra.allowWriteWorktree ?? false,
    toolCall,
    ...(extra.internalScratchRoot !== undefined
      ? { internalScratchRoot: extra.internalScratchRoot }
      : {}),
  });
}

test("pathless native search is allowed in all modes when query-only", () => {
  for (const mode of ["implement", "review", "investigate"] as const) {
    const d = decide(mode, { tool: "search", query: "flash high" } as unknown as AcpToolCallShape);
    assert.equal(d.allowed, true, `search should allow in ${mode}: ${d.reason}`);
    assert.ok(d.reason.includes("workspace-scoped native search"), `reason was: ${d.reason}`);
    const grep = decide(mode, { tool: "grep", query: "x", title: "native probe" } as unknown as AcpToolCallShape);
    assert.equal(grep.allowed, true, `grep should allow in ${mode}: ${grep.reason}`);
  }
});

test("pathless read stays denied in every mode", () => {
  for (const mode of ["implement", "review", "investigate"] as const) {
    const d = decide(mode, { tool: "read" });
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes("no auditable"), `reason was: ${d.reason}`);
  }
});

test("pathless search with command/url payload is denied", () => {
  assert.equal(
    decide("implement", { tool: "search", query: "x", command: "id" } as unknown as AcpToolCallShape).allowed,
    false
  );
  assert.equal(
    decide("implement", { tool: "search", url: "https://example.com" } as unknown as AcpToolCallShape).allowed,
    false
  );
  const nested = decide(
    "implement",
    { tool: "search", query: "x", run: { command: "id" } } as unknown as AcpToolCallShape
  );
  assert.equal(nested.allowed, false);
  assert.ok(nested.reason.includes("command"), `reason was: ${nested.reason}`);
});

test("pathless search with opaque nested structure is denied", () => {
  const d = decide(
    "implement",
    { tool: "search", query: "x", input: { note: "harmless" } } as unknown as AcpToolCallShape
  );
  assert.equal(d.allowed, false);
  assert.ok(d.reason.includes("no auditable"), `reason was: ${d.reason}`);
});

test("search with a nested outside path is denied by containment", () => {
  const d = decide(
    "implement",
    {
      tool: "search",
      query: "x",
      extra: { path: path.join(outside, "secret.txt") },
    } as unknown as AcpToolCallShape
  );
  assert.equal(d.allowed, false);
  assert.ok(d.reason.includes("outside workspace"), `reason was: ${d.reason}`);
});

test("scratch root derives from GEMINI_HOME and exact sessionId", () => {
  assert.equal(
    resolveAcpSessionScratchRoot(geminiHome, SESSION),
    path.join(geminiHome, "antigravity-acp", "brain", SESSION, "scratch")
  );
  assert.equal(resolveAcpSessionScratchRoot(geminiHome, "../evil"), undefined);
  assert.equal(resolveAcpSessionScratchRoot(geminiHome, "a/b"), undefined);
  assert.equal(resolveAcpSessionScratchRoot(geminiHome, ""), undefined);
  assert.equal(resolveAcpSessionScratchRoot(geminiHome, "  "), undefined);
  assert.equal(resolveAcpSessionScratchRoot("relative/gemini", SESSION), undefined);
  assert.equal(resolveAcpSessionScratchRoot("", SESSION), undefined);
});

test("scratch edit allowed only under exact session scratch root, all modes, no gate", () => {
  const root = scratchRoot();
  const target = path.join(root, "test.txt");
  for (const mode of ["implement", "review", "investigate"] as const) {
    const d = decide(mode, { tool: "write", path: target }, { internalScratchRoot: root });
    assert.equal(d.allowed, true, `scratch write should allow in ${mode}: ${d.reason}`);
    assert.ok(d.reason.includes("agent-internal scratch"), `reason was: ${d.reason}`);
  }
  // create/edit aliases behave identically.
  assert.equal(
    decide("review", { tool: "create", path: path.join(root, "a.txt") }, { internalScratchRoot: root }).allowed,
    true
  );
  assert.equal(
    decide("investigate", { tool: "edit", paths: [path.join(root, "b.txt")] }, { internalScratchRoot: root }).allowed,
    true
  );
});

test("sibling brain/session/profile paths are denied", () => {
  const root = scratchRoot();
  const siblings = [
    path.join(geminiHome, "antigravity-acp", "brain", "other-session", "scratch", "test.txt"),
    path.join(geminiHome, "antigravity-acp", "brain", SESSION, "other.txt"),
    path.join(geminiHome, "antigravity-acp", "brain", "test.txt"),
    path.join(geminiHome, "config.json"),
    geminiHome,
  ];
  for (const target of siblings) {
    const d = decide("implement", { tool: "write", path: target }, { internalScratchRoot: root });
    assert.equal(d.allowed, false, `${target} must deny: ${d.reason}`);
    assert.ok(d.reason.includes("outside workspace"), `reason was: ${d.reason}`);
  }
  // Without the scratch root in context, even the exact scratch path denies.
  const d = decide("implement", { tool: "write", path: path.join(root, "test.txt") }, {});
  assert.equal(d.allowed, false);
  assert.ok(d.reason.includes("outside workspace"), `reason was: ${d.reason}`);
});

test("traversal out of the scratch root is denied", () => {
  const root = scratchRoot();
  const escapes = [
    path.join(root, "..", "other-session", "scratch", "test.txt"),
    path.join(root, "..", "..", "escape.txt"),
    `${root}/../escape.txt`,
  ];
  for (const target of escapes) {
    const d = decide("implement", { tool: "write", path: target }, { internalScratchRoot: root });
    assert.equal(d.allowed, false, `${target} must deny: ${d.reason}`);
  }
});

test("delete/move/execute/fetch under scratch stay denied", () => {
  const root = scratchRoot();
  const target = path.join(root, "test.txt");
  for (const toolCall of [
    { tool: "delete", path: target },
    { tool: "move", path: target },
    { tool: "bash", command: "ls" },
    { tool: "fetch", url: "https://example.com" },
    { tool: "frobnicate", path: target },
  ] as AcpToolCallShape[]) {
    const d = decide("implement", toolCall, { internalScratchRoot: root, allowWriteWorktree: true });
    assert.equal(d.allowed, false, `${JSON.stringify(toolCall)} must deny: ${d.reason}`);
  }
  // Scratch edit carrying a command payload denies.
  const payload = decide(
    "implement",
    { tool: "write", path: target, command: "id" } as unknown as AcpToolCallShape,
    { internalScratchRoot: root }
  );
  assert.equal(payload.allowed, false);
});

test("repository write rules are unchanged", () => {
  const target = path.join(workspace, "sub", "new.txt");
  // Implement still gated.
  assert.equal(decide("implement", { tool: "write", paths: [target] }).allowed, false);
  assert.equal(decide("implement", { tool: "write", paths: [target] }, { allowWriteWorktree: true }).allowed, true);
  // Review/investigate still read-only even when gated.
  for (const mode of ["review", "investigate"] as const) {
    assert.equal(
      decide(mode, { tool: "write", paths: [target] }, { allowWriteWorktree: true }).allowed,
      false
    );
  }
  // Mixed workspace+scratch edits deny (not exclusively inside one root).
  const root = scratchRoot();
  const mixed = decide(
    "implement",
    { tool: "write", paths: [target, path.join(root, "test.txt")] },
    { internalScratchRoot: root, allowWriteWorktree: true }
  );
  assert.equal(mixed.allowed, false);
});

function makeAdapter(): AgyAcpAdapter {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-compat-adapter-"));
  return new AgyAcpAdapter({
    enabled: true,
    acp_executable: process.execPath,
    auth_method: "oauth-personal",
    mode: "default",
    allow_write_worktree: false,
    state_dir: stateDir,
    default_timeout_seconds: 60,
    env_allowlist: ["HOME", "PATH", "TMPDIR"],
  } as any);
}

test("adapter passes the scratch root through to the policy", () => {
  const adapter = makeAdapter();
  const root = scratchRoot();
  const target = path.join(root, "test.txt");
  const params = { sessionId: SESSION, toolCall: { tool: "write", path: target } };
  for (const mode of ["implement", "review", "investigate"] as const) {
    const answer = adapter.decidePermissionRequest(params, {
      workspaceRoot: workspace,
      mode,
      internalScratchRoot: root,
    });
    assert.equal(answer.decision, "allow", `${mode}: ${answer.reason}`);
  }
  const sibling = adapter.decidePermissionRequest(
    { sessionId: SESSION, toolCall: { tool: "write", path: path.join(geminiHome, "config.json") } },
    { workspaceRoot: workspace, mode: "implement", internalScratchRoot: root }
  );
  assert.equal(sibling.decision, "deny");
  const noRoot = adapter.decidePermissionRequest(params, { workspaceRoot: workspace, mode: "implement" });
  assert.equal(noRoot.decision, "deny");
  const pathlessSearch = adapter.decidePermissionRequest(
    { sessionId: SESSION, toolCall: { tool: "search", query: "flash" } },
    { workspaceRoot: workspace, mode: "implement" }
  );
  assert.equal(pathlessSearch.decision, "allow");
});

test("official rawInput query-only search allows in all modes (adapter extraction)", () => {
  const adapter = makeAdapter();
  for (const mode of ["implement", "review", "investigate"] as const) {
    const answer = adapter.decidePermissionRequest(
      { sessionId: SESSION, toolCall: { kind: "search", rawInput: { query: "foo" } } },
      { workspaceRoot: workspace, mode }
    );
    assert.equal(answer.decision, "allow", `${mode}: ${answer.reason}`);
    assert.ok(answer.reason.includes("workspace-scoped native search"), `reason was: ${answer.reason}`);
  }
  // Scalar-only metadata beside the query stays inert.
  const meta = adapter.decidePermissionRequest(
    {
      sessionId: SESSION,
      toolCall: { kind: "search", rawInput: { query: "foo", limit: 10, caseSensitive: false } },
    },
    { workspaceRoot: workspace, mode: "investigate" }
  );
  assert.equal(meta.decision, "allow", `scalar metadata: ${meta.reason}`);
});

test("rawInput search with nested/command/path/array payloads is denied", () => {
  const adapter = makeAdapter();
  const denies: Array<[string, unknown]> = [
    ["nested object", { kind: "search", rawInput: { query: "x", extra: { note: "hi" } } }],
    ["nested command", { kind: "search", rawInput: { query: "x", command: "id" } }],
    ["nested url", { kind: "search", rawInput: { query: "x", url: "https://example.com" } }],
    ["outside path", { kind: "search", rawInput: { query: "x", path: path.join(outside, "secret.txt") } }],
    ["array envelope", { kind: "search", rawInput: [{ query: "x" }] }],
    ["array under unknown key", { kind: "search", rawInput: { query: "x", tags: ["a"] } }],
  ];
  for (const [label, toolCall] of denies) {
    for (const mode of ["implement", "review", "investigate"] as const) {
      const answer = adapter.decidePermissionRequest(
        { sessionId: SESSION, toolCall },
        { workspaceRoot: workspace, mode }
      );
      assert.equal(answer.decision, "deny", `${label} in ${mode} must deny: ${answer.reason}`);
    }
  }
  // The outside-path case denies specifically on containment.
  const outsideAnswer = adapter.decidePermissionRequest(
    {
      sessionId: SESSION,
      toolCall: { kind: "search", rawInput: { query: "x", path: path.join(outside, "secret.txt") } },
    },
    { workspaceRoot: workspace, mode: "implement" }
  );
  assert.ok(outsideAnswer.reason.includes("outside workspace"), `reason was: ${outsideAnswer.reason}`);
});

test("rawInput carrying an in-workspace path behaves as pathed search", () => {
  const d = decide(
    "implement",
    { kind: "search", rawInput: { query: "x", path: "sub/file.txt" } } as unknown as AcpToolCallShape
  );
  assert.equal(d.allowed, true, `in-workspace rawInput path: ${d.reason}`);
  assert.ok(d.reason.includes("inside workspace"), `reason was: ${d.reason}`);
});

test("pathless read with a query-only rawInput stays denied", () => {
  for (const mode of ["implement", "review", "investigate"] as const) {
    const d = decide(
      mode,
      { kind: "read", rawInput: { query: "x" } } as unknown as AcpToolCallShape
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reason.includes("no auditable"), `reason was: ${d.reason}`);
  }
});
