import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  decideAcpToolPermission,
  type AcpTaskMode,
  type AcpToolCallShape,
} from "../../src/agents/acp/permission-policy.js";

let workspace = "";
let outside = "";

test.before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-policy-ws-"));
  fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sub", "file.txt"), "hello\n");
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "acp-policy-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
});

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function decide(mode: AcpTaskMode, toolCall: AcpToolCallShape, allowWriteWorktree = false) {
  return decideAcpToolPermission({ workspaceRoot: workspace, mode, allowWriteWorktree, toolCall });
}

function assertVerdict(
  decision: ReturnType<typeof decideAcpToolPermission>,
  allowed: boolean,
  reasonFragment: string
): void {
  assert.equal(decision.allowed, allowed);
  assert.ok(typeof decision.reason === "string" && decision.reason.length > 0, "reason must suit transcript/audit");
  assert.ok(
    decision.reason.toLowerCase().includes(reasonFragment.toLowerCase()),
    `reason '${decision.reason}' should mention '${reasonFragment}'`
  );
}

test("in-workspace read/search/think are allowed in every task mode", () => {
  const inFile = path.join(workspace, "sub", "file.txt");
  for (const mode of ["implement", "review", "investigate"] as const) {
    assertVerdict(decide(mode, { tool: "read", paths: [inFile] }), true, "inside workspace");
    assertVerdict(decide(mode, { tool: "grep", paths: [workspace] }), true, "inside workspace");
  }
  assertVerdict(decide("implement", { tool: "think" }), true, "pure reasoning");
  assertVerdict(decide("review", { tool: "think" }), true, "pure reasoning");
});

test("relative in-workspace paths resolve against the workspace root", () => {
  assertVerdict(decide("implement", { tool: "read", path: "sub/file.txt" }), true, "inside workspace");
});

test("out-of-workspace reads are denied in every mode", () => {
  const secret = path.join(outside, "secret.txt");
  for (const mode of ["implement", "review", "investigate"] as const) {
    const decision = decide(mode, { tool: "read", paths: [secret] });
    assertVerdict(decision, false, "outside workspace");
    assert.deepEqual(decision.details.outsideWorkspace, [secret]);
  }
});

test("mixed inside/outside path sets are denied", () => {
  const decision = decide("implement", {
    tool: "read_many",
    paths: [path.join(workspace, "sub", "file.txt"), path.join(outside, "secret.txt")],
  });
  assertVerdict(decision, false, "outside workspace");
});

test("traversal escapes are denied", () => {
  assertVerdict(decide("implement", { tool: "read", path: "../escape.txt" }), false, "outside workspace");
  assertVerdict(
    decide("implement", { tool: "read", path: path.join(workspace, "sub", "..", "..", "escape.txt") }),
    false,
    "outside workspace"
  );
});

test("review and investigate deny writes even when contained and gated", () => {
  const target = path.join(workspace, "sub", "new.txt");
  for (const mode of ["review", "investigate"] as const) {
    assertVerdict(decide(mode, { tool: "write", paths: [target] }, true), false, "read-only");
    assertVerdict(decide(mode, { tool: "edit", paths: [target] }, true), false, "read-only");
  }
});

test("review and investigate deny execute/delete/move/fetch/other", () => {
  const target = path.join(workspace, "sub", "file.txt");
  for (const mode of ["review", "investigate"] as const) {
    assertVerdict(decide(mode, { tool: "bash", command: "ls" }), false, "read-only");
    assertVerdict(decide(mode, { tool: "delete", paths: [target] }), false, "read-only");
    assertVerdict(decide(mode, { tool: "move", path: target }), false, "read-only");
    assertVerdict(decide(mode, { tool: "fetch", url: "https://example.com" }), false, "read-only");
    assertVerdict(decide(mode, { tool: "frobnicate", paths: [target] }), false, "read-only");
  }
});

test("implement denies writes by default and allows them only when gated and contained", () => {
  const target = path.join(workspace, "sub", "new.txt");
  assertVerdict(decide("implement", { tool: "write", paths: [target] }), false, "allow_write_worktree");
  assertVerdict(decide("implement", { tool: "edit", paths: [target] }), false, "allow_write_worktree");
  assertVerdict(decide("implement", { tool: "write", paths: [target] }, true), true, "inside workspace");
  assertVerdict(decide("implement", { tool: "edit", paths: [target] }, true), true, "inside workspace");
});

test("implement denies gated writes outside the workspace", () => {
  const secret = path.join(outside, "secret.txt");
  assertVerdict(decide("implement", { tool: "write", paths: [secret] }, true), false, "outside workspace");
});

test("implement always denies execute/delete/move/fetch/other, even gated and contained", () => {
  const target = path.join(workspace, "sub", "file.txt");
  assertVerdict(decide("implement", { tool: "bash", command: "ls" }, true), false, "only contained read");
  assertVerdict(decide("implement", { tool: "delete", paths: [target] }, true), false, "only contained read");
  assertVerdict(decide("implement", { tool: "move", paths: [target] }, true), false, "only contained read");
  assertVerdict(decide("implement", { tool: "fetch", url: "https://example.com" }, true), false, "only contained read");
  assertVerdict(decide("implement", { tool: "frobnicate", paths: [target] }, true), false, "only contained read");
});

test("unrecognized and pathless read/write shapes deny fail-closed", () => {
  assertVerdict(decide("implement", {}), false, "unknown");
  assertVerdict(decide("implement", { tool: "read" }), false, "no auditable");
  assertVerdict(decide("implement", { tool: "edit", paths: [] }, true), false, "no auditable");
  assertVerdict(decide("implement", { tool: "read", paths: ["sub/file.txt"], command: "id" }), false, "command");
});

test("think carrying paths or payloads is denied", () => {
  assertVerdict(
    decide("implement", { tool: "think", path: "sub/file.txt" }),
    false,
    "must not carry paths"
  );
});

test("invalid task modes fail closed even if TypeScript is bypassed", () => {
  const target = `${workspace}/sub/file.txt`;
  for (const mode of ["yolo", "whatever", "", "IMPLEMENT"] as const) {
    const decision = decideAcpToolPermission({
      workspaceRoot: workspace,
      mode: mode as unknown as AcpTaskMode,
      allowWriteWorktree: true,
      toolCall: { tool: "edit", paths: [target] },
    });
    assert.equal(decision.allowed, false);
    assert.ok(decision.reason.includes("unknown task mode"), `reason was: ${decision.reason}`);
  }
  // Even pure reads deny under an unknown mode.
  const readDecision = decideAcpToolPermission({
    workspaceRoot: workspace,
    mode: "yolo" as unknown as AcpTaskMode,
    allowWriteWorktree: true,
    toolCall: { tool: "read", paths: [`${workspace}/sub/file.txt`] },
  });
  assert.equal(readDecision.allowed, false);
});

test("think with paths hidden in nested input is denied (review repro)", () => {
  const decision = decide("implement", {
    tool: "think",
    input: { path: `${workspace}/../outside.txt` },
  } as unknown as AcpToolCallShape);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reason.includes("think"), `reason was: ${decision.reason}`);
});

test("think with any opaque nested structure is denied", () => {
  assert.equal(
    decide("implement", { tool: "think", metadata: { note: "harmless" } } as unknown as AcpToolCallShape).allowed,
    false
  );
  assert.equal(
    decide("implement", { tool: "think", input: { command: "id" } } as unknown as AcpToolCallShape).allowed,
    false
  );
  // Flat scalar extras are still fine for think.
  assertVerdict(decide("implement", { tool: "think", title: "planning" }), true, "pure reasoning");
});

test("nested outside paths deny reads that look contained on top", () => {
  const decision = decide("implement", {
    tool: "read",
    path: "sub/file.txt",
    extra: { path: `${workspace}/../escape.txt` },
  } as unknown as AcpToolCallShape);
  assertVerdict(decision, false, "outside workspace");
});

test("nested command payloads deny every kind, including gated implement edits", () => {
  const target = `${workspace}/sub/new.txt`;
  assertVerdict(
    decide("implement", { tool: "read", path: "sub/file.txt", run: { command: "id" } } as unknown as AcpToolCallShape),
    false,
    "command"
  );
  assertVerdict(
    decide("implement", { tool: "edit", paths: [target], run: { command: "id" } } as unknown as AcpToolCallShape, true),
    false,
    "never auto-allowed"
  );
});
