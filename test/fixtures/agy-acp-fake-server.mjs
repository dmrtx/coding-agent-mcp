#!/usr/bin/env node
// Fake ACP kernel fixture for phase 1 protocol-library tests (no TaskManager
// integration). Node stdio NDJSON responder supporting exactly:
//   initialize, authenticate, session/new, session/prompt, session/cancel,
//   session/resume, session/set_config_option
// plus one inbound `session/request_permission` round-trip per prompt so
// tests can exercise client-side permission handling at protocol level.
//
// Zero dependencies; only used by tests. Not shipped (lives under test/).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

let sessionCounter = 0;
let permissionCounter = 9000;
const sessions = new Map(); // sessionId -> { sessionId, cwd, model, options }
const pendingPrompts = new Map(); // permissionRequestId -> { origId, sessionId }
// Cancel-test markers (phase 2A cancel slice, test-only):
// - [[BLOCK_UNTIL_CANCEL]]: session/prompt stays pending until session/cancel
//   for the same session arrives; the cancel is acked and the prompt then
//   completes with a cancelled stopReason.
// - [[IGNORE_CANCEL]]: session/prompt stays pending forever, even across
//   session/cancel, forcing the adapter's process-fallback path.
const blockedPrompts = new Map(); // sessionId -> { origId }
const ignoredPrompts = new Map(); // sessionId -> { origId }

// Test-only cross-process session persistence for managed-continue tests.
// A managed continue spawns a FRESH kernel process, so in-memory sessions
// alone cannot survive across turns. Enabled solely via
// AGY_ACP_FAKE_PERSIST=1; state lives under $HOME (the isolated task HOME
// in managed runs), so nothing is ever written outside the fake HOME.
const PERSIST_ENABLED = process.env.AGY_ACP_FAKE_PERSIST === "1";

function persistPaths() {
  const home = process.env.HOME;
  if (typeof home !== "string" || home.length === 0) return null;
  return {
    sessions: path.join(home, ".agy-acp-fake-sessions.json"),
    trace: path.join(home, ".agy-acp-fake-trace.jsonl"),
  };
}

/** Append-only per-process method trace (test evidence; never protocol). */
function traceMethod(method) {
  if (!PERSIST_ENABLED) return;
  try {
    const paths = persistPaths();
    if (!paths) return;
    fs.appendFileSync(paths.trace, `${JSON.stringify({ pid: process.pid, method })}\n`);
  } catch {
    // Test-only; never break protocol handling.
  }
}

function loadPersistedSessions() {
  if (!PERSIST_ENABLED) return;
  try {
    const paths = persistPaths();
    if (!paths || !fs.existsSync(paths.sessions)) return;
    const data = JSON.parse(fs.readFileSync(paths.sessions, "utf-8"));
    if (!isRecord(data)) return;
    if (typeof data.sessionCounter === "number" && data.sessionCounter > sessionCounter) {
      sessionCounter = data.sessionCounter;
    }
    if (isRecord(data.sessions)) {
      for (const [id, entry] of Object.entries(data.sessions)) {
        if (!sessions.has(id) && isRecord(entry)) {
          sessions.set(id, { cwd: null, model: null, options: {}, ...entry, sessionId: id });
        }
      }
    }
  } catch {
    // Corrupt state must never break the fake kernel.
  }
}

function persistSessions() {
  if (!PERSIST_ENABLED) return;
  try {
    const paths = persistPaths();
    if (!paths) return;
    const tmp = `${paths.sessions}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sessionCounter, sessions: Object.fromEntries(sessions) }));
    fs.renameSync(tmp, paths.sessions);
  } catch {
    // Test-only; never break protocol handling.
  }
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errorTo(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  const p = isRecord(params) ? params : {};
  traceMethod(method);

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          serverInfo: { name: "agy-acp-fake", version: "0.1.0-phase1" },
        },
      });
      return;

    case "authenticate": {
      // Minimal official-kernel compat: accept ACP/T3 `{ methodId }` and
      // report success. Test-only failure injection via
      // AGY_ACP_FAKE_AUTH_FAIL=1 (surfaces as a typed request failure so
      // the adapter must propagate it without a session retry).
      if (process.env.AGY_ACP_FAKE_AUTH_FAIL === "1") {
        errorTo(id, -32000, "Authentication failed: oauth browser cancelled");
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          success: true,
          methodId: typeof p.methodId === "string" ? p.methodId : null,
        },
      });
      return;
    }

    case "session/new": {
      // Load first so ids never collide with another process sharing HOME.
      loadPersistedSessions();
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      sessions.set(sessionId, {
        sessionId,
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        model: typeof p.model === "string" ? p.model : null,
        options: {},
      });
      persistSessions();
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }

    case "session/prompt": {
      const sessionId = p.sessionId;
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        errorTo(id, -32002, `Unknown session: ${String(sessionId)}`);
        return;
      }
      const rawPrompt = p.prompt;
      const promptText =
        typeof rawPrompt === "string"
          ? rawPrompt
          : Array.isArray(rawPrompt)
            ? rawPrompt
                .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
                .join("\n")
            : "";
      sessions.get(sessionId).lastPrompt = promptText.length > 0 ? promptText : null;
      // Marker for cooperative cancel: hold the prompt open until the
      // client sends session/cancel for this session (handled below).
      if (promptText.includes("[[BLOCK_UNTIL_CANCEL]]")) {
        blockedPrompts.set(sessionId, { origId: id });
        return;
      }
      // Marker for fallback cancel: hold the prompt open forever, even
      // across session/cancel, so the adapter must terminate the kernel.
      if (promptText.includes("[[IGNORE_CANCEL]]")) {
        ignoredPrompts.set(sessionId, { origId: id });
        return;
      }
      // Marker for empty output: complete end_turn with no assistant text
      // and no permission round-trip (isolates INTERNAL_ERROR mapping).
      if (promptText.includes("[[EMPTY_OUTPUT]]")) {
        send({
          jsonrpc: "2.0",
          id,
          result: { stopReason: "end_turn", sessionId },
        });
        return;
      }
      // Marker for write probe: request a contained edit permission; final
      // permissionOutcome mirrors the client reply and assistant text is
      // only included when allowed (deny requires no success text).
      if (promptText.includes("[[WRITE_PROBE]]")) {
        permissionCounter += 1;
        const permId = permissionCounter;
        pendingPrompts.set(permId, { origId: id, sessionId, kind: "write" });
        send({
          jsonrpc: "2.0",
          id: permId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: `tc-${permId}`, tool: "edit", paths: ["notes.md"] },
            reason: "fake kernel probe: edit notes.md",
          },
        });
        return;
      }
      // Default/read prompt: assistant text notification plus one
      // in-workspace read permission; final end_turn mirrors the client
      // allow/deny as permissionOutcome with non-empty assistant text.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "fake assistant update: reading README.md" },
          },
        },
      });
      // Emit one inbound permission request; the prompt result follows once
      // the client answers (allow, deny, or JSON-RPC error — all complete).
      permissionCounter += 1;
      const permId = permissionCounter;
      pendingPrompts.set(permId, { origId: id, sessionId, kind: "read" });
      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: `tc-${permId}`, tool: "read", paths: ["README.md"] },
          reason: "fake kernel probe: read README.md",
        },
      });
      return;
    }

    case "session/cancel": {
      const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
      send({ jsonrpc: "2.0", id, result: { cancelled: true, sessionId } });
      // Release a cooperatively blocked prompt with a cancelled stopReason.
      // IGNORE_CANCEL prompts are deliberately never settled: the adapter
      // must fall back to process termination (verified by cancel tests).
      // Afterwards the kernel stays alive for normal adapter teardown
      // (SIGTERM/stdin-end exits below), so no orphan can remain.
      if (typeof sessionId === "string") {
        const blocked = blockedPrompts.get(sessionId);
        if (blocked) {
          blockedPrompts.delete(sessionId);
          send({
            jsonrpc: "2.0",
            id: blocked.origId,
            result: {
              stopReason: "cancelled",
              sessionId,
              assistantText: "fake assistant cancelled turn",
            },
          });
        }
      }
      return;
    }

    case "session/resume": {
      const sessionId = p.sessionId;
      if (typeof sessionId === "string" && !sessions.has(sessionId)) {
        // Cross-process resume: a previous kernel process may have persisted
        // this session under the shared fake HOME.
        loadPersistedSessions();
      }
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        errorTo(id, -32002, `Unknown session: ${String(sessionId)}`);
        return;
      }
      send({ jsonrpc: "2.0", id, result: { sessionId, resumed: true } });
      return;
    }

    case "session/set_config_option": {
      if (typeof p.key !== "string" || p.key.length === 0) {
        errorTo(id, -32602, "Invalid params: 'key' is required");
        return;
      }
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
      if (sessionId !== null) {
        if (!sessions.has(sessionId)) {
          errorTo(id, -32002, `Unknown session: ${sessionId}`);
          return;
        }
        sessions.get(sessionId).options[p.key] = p.value ?? null;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: { updated: true, key: p.key, value: p.value ?? null, sessionId },
      });
      return;
    }

    default:
      errorTo(id, -32601, `Method not found: ${method}`);
  }
}

function handleResponse(msg) {
  const pending = pendingPrompts.get(msg.id);
  if (!pending) return; // Unknown response id: ignore (client tests cover strictness).
  pendingPrompts.delete(msg.id);
  let outcome = "error";
  if (isRecord(msg.result)) {
    if (typeof msg.result.decision === "string") outcome = msg.result.decision;
    else if (typeof msg.result.outcome === "string") outcome = msg.result.outcome;
    else outcome = "ok";
  } else if (msg.result !== undefined) {
    outcome = "ok";
  }
  if (pending.kind === "write") {
    if (outcome === "allow") {
      send({
        jsonrpc: "2.0",
        id: pending.origId,
        result: {
          stopReason: "end_turn",
          sessionId: pending.sessionId,
          permissionOutcome: outcome,
          assistantText: "fake assistant completed write probe",
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: pending.origId,
        result: { stopReason: "end_turn", sessionId: pending.sessionId, permissionOutcome: outcome },
      });
    }
    return;
  }
  send({
    jsonrpc: "2.0",
    id: pending.origId,
    result: {
      stopReason: "end_turn",
      sessionId: pending.sessionId,
      permissionOutcome: outcome,
      assistantText: "fake assistant completed turn for read probe",
    },
  });
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      errorTo(null, -32700, "Parse error");
      continue;
    }
    if (!isRecord(msg)) {
      errorTo(null, -32600, "Invalid Request");
      continue;
    }
    if (typeof msg.method === "string" && msg.id !== undefined && msg.id !== null) {
      handleRequest(msg);
    } else if (msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
      handleResponse(msg);
    } else if ("method" in msg) {
      // Notification: acknowledged by ignoring (no response per JSON-RPC).
    } else {
      errorTo(msg.id ?? null, -32600, "Invalid Request");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => {
  // Test evidence: cancel tests assert fallback SIGTERM lands after the
  // session/cancel attempt (trace order), and that no orphan remains.
  traceMethod("signal/SIGTERM");
  process.exit(0);
});
