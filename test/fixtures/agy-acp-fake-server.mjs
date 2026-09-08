#!/usr/bin/env node
// Fake ACP kernel fixture for phase 1 protocol-library tests (no TaskManager
// integration). Node stdio NDJSON responder supporting exactly:
//   initialize, session/new, session/prompt, session/cancel, session/resume,
//   session/set_config_option
// plus one inbound `session/request_permission` round-trip per prompt so
// tests can exercise client-side permission handling at protocol level.
//
// Zero dependencies; only used by tests. Not shipped (lives under test/).
import process from "node:process";

let sessionCounter = 0;
let permissionCounter = 9000;
const sessions = new Map(); // sessionId -> { sessionId, cwd, model, options }
const pendingPrompts = new Map(); // permissionRequestId -> { origId, sessionId }

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

    case "session/new": {
      sessionCounter += 1;
      const sessionId = `sess-${sessionCounter}`;
      sessions.set(sessionId, {
        sessionId,
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        model: typeof p.model === "string" ? p.model : null,
        options: {},
      });
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      return;
    }

    case "session/prompt": {
      const sessionId = p.sessionId;
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        errorTo(id, -32002, `Unknown session: ${String(sessionId)}`);
        return;
      }
      const promptText = typeof p.prompt === "string" ? p.prompt : "";
      sessions.get(sessionId).lastPrompt = typeof p.prompt === "string" ? p.prompt : null;
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
      return;
    }

    case "session/resume": {
      const sessionId = p.sessionId;
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
process.on("SIGTERM", () => process.exit(0));
