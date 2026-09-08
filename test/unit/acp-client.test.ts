import test from "node:test";
import assert from "node:assert/strict";
import { AcpClient, type AcpClientOptions } from "../../src/agents/acp/client.js";
import { NdjsonFramer } from "../../src/agents/acp/framer.js";
import { AcpProtocolError } from "../../src/agents/acp/types.js";
import { CodingAgentError } from "../../src/domain/errors.js";

interface Harness {
  client: AcpClient;
  sent: string[];
  errors: AcpProtocolError[];
  notifications: { method: string; params: unknown }[];
  inbound: { method: string; params: unknown }[];
}

function makeHarness(overrides?: Partial<AcpClientOptions>): Harness {
  const sent: string[] = [];
  const errors: AcpProtocolError[] = [];
  const notifications: Harness["notifications"] = [];
  const inbound: Harness["inbound"] = [];
  const client = new AcpClient({
    sendLine: (line) => {
      sent.push(line);
    },
    onProtocolError: (err) => {
      errors.push(err);
    },
    onNotification: (method, params) => {
      notifications.push({ method, params });
    },
    ...overrides,
  });
  return { client, sent, errors, notifications, inbound };
}

function respondOk(harness: Harness, id: number, result: unknown): void {
  harness.client.receiveChunk(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sentEnvelope(harness: Harness, index: number): Record<string, any> {
  return JSON.parse(harness.sent[index]);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("NdjsonFramer reassembles fragmented chunks and multiple lines", () => {
  const framer = new NdjsonFramer();
  assert.deepEqual(framer.push('{"a":1}\n{"b":'), [{ ok: true, line: '{"a":1}' }]);
  assert.deepEqual(framer.push("2}\n"), [{ ok: true, line: '{"b":2}' }]);
  // Multiple lines in one chunk plus CRLF tolerance.
  assert.deepEqual(framer.push('{"c":3}\r\n{"d":4}\n'), [
    { ok: true, line: '{"c":3}' },
    { ok: true, line: '{"d":4}' },
  ]);
});

test("NdjsonFramer round-trips UTF-8 codepoints split across Buffer chunks", () => {
  const line = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hi 🙂 bye 日本語" } })}\n`;
  const buf = Buffer.from(line, "utf-8");
  // Split inside the emoji (4-byte sequence) and inside a CJK char (3-byte).
  const emojiStart = buf.indexOf(Buffer.from([0xf0]));
  const framer = new NdjsonFramer();
  assert.deepEqual(framer.push(buf.subarray(0, emojiStart + 2)), []);
  const rest = framer.push(buf.subarray(emojiStart + 2));
  assert.equal(rest.length, 1);
  assert.equal(rest[0].ok, true);
  assert.equal((rest[0] as { line: string }).line, line.trim());
});

test("NdjsonFramer reports oversized lines as outcomes without losing earlier lines", () => {
  const framer = new NdjsonFramer(32);
  const good = '{"a":1}';
  const outcomes = framer.push(`${good}\n${"y".repeat(64)}\n${good}\n`);
  assert.equal(outcomes.length, 3);
  assert.deepEqual(outcomes[0], { ok: true, line: good });
  assert.equal(outcomes[1].ok, false);
  assert.ok((outcomes[1] as { error: AcpProtocolError }).error instanceof AcpProtocolError);
  assert.equal((outcomes[1] as { error: AcpProtocolError }).error.kind, "line_too_long");
  assert.deepEqual(outcomes[2], { ok: true, line: good });
});

test("NdjsonFramer flush drains a final unterminated line", () => {
  const framer = new NdjsonFramer();
  assert.deepEqual(framer.push('{"a":1}'), []);
  const flushed = framer.flush();
  assert.deepEqual(flushed, [{ ok: true, line: '{"a":1}' }]);
  assert.deepEqual(framer.flush(), []);
});

test("request/response matching uses numeric ids and resolves out of order", async () => {
  const harness = makeHarness();
  const first = harness.client.request("session/new", { cwd: "/tmp" });
  const second = harness.client.request("initialize", {});
  assert.equal(harness.sent.length, 2);
  const env1 = sentEnvelope(harness, 0);
  const env2 = sentEnvelope(harness, 1);
  assert.equal(typeof env1.id, "number");
  assert.equal(typeof env2.id, "number");
  assert.notEqual(env1.id, env2.id);
  assert.equal(env1.method, "session/new");

  respondOk(harness, env2.id, { protocolVersion: 1 });
  respondOk(harness, env1.id, { sessionId: "sess-1" });
  assert.deepEqual(await second, { protocolVersion: 1 });
  assert.deepEqual(await first, { sessionId: "sess-1" });
  assert.equal(harness.client.pendingCount, 0);
});

test("malformed lines are terminal: observed, client closed, pending failed", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("initialize");
  const done = pending.then(
    () => "resolved",
    (err: any) => `${err.code}`
  );
  harness.client.receiveChunk("this is not json\n");
  assert.equal(harness.errors.length, 1);
  assert.ok(harness.errors[0] instanceof AcpProtocolError);
  assert.equal(harness.errors[0].kind, "malformed_line");
  assert.equal(harness.client.isClosed, true);
  assert.equal(await done, "INTERNAL_ERROR");
  assert.equal(harness.client.pendingCount, 0);
});

test("empty lines are structural errors, never silently skipped", () => {
  const harness = makeHarness();
  harness.client.receiveChunk("\n");
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].kind, "malformed_line");
  assert.equal(harness.client.isClosed, true);
});

test("valid responses settle before a later corruption in the same chunk fails the client", async () => {
  const harness = makeHarness({ maxLineBytes: 64 });
  const first = harness.client.request("session/new", {});
  const second = harness.client.request("initialize", {});
  const firstDone = first.then(
    (v) => ({ settled: "resolved" as const, value: v }),
    (e: any) => ({ settled: "rejected" as const, value: e.code })
  );
  const secondDone = second.then(
    (v) => ({ settled: "resolved" as const, value: v }),
    (e: any) => ({ settled: "rejected" as const, value: e.code })
  );
  const good = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "sess-1" } });
  harness.client.receiveChunk(`${good}\n${"z".repeat(100)}\n`);
  // The valid response keeps its settlement even though the chunk ends corrupt.
  assert.deepEqual(await firstDone, { settled: "resolved", value: { sessionId: "sess-1" } });
  // The unanswered request fails terminally, and the client is closed.
  assert.deepEqual(await secondDone, { settled: "rejected", value: "INTERNAL_ERROR" });
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].kind, "line_too_long");
  assert.equal(harness.client.isClosed, true);
});

test("non-2.0 messages are terminal protocol errors", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("initialize");
  const done = pending.then(
    () => "resolved",
    (err: any) => `${err.code}`
  );
  harness.client.receiveChunk(`${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`);
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].kind, "unexpected_message");
  assert.equal(harness.client.isClosed, true);
  assert.equal(await done, "INTERNAL_ERROR");
});

test("requests time out and clear the pending map", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("session/prompt", { prompt: "hi" }, { timeoutMs: 20 });
  assert.equal(harness.client.pendingCount, 1);
  await assert.rejects(
    pending,
    (err: any) => err instanceof CodingAgentError && err.code === "TASK_TIMEOUT"
  );
  assert.equal(harness.client.pendingCount, 0);
});

test("kernel error responses reject with INTERNAL_ERROR", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("session/new");
  harness.client.receiveChunk(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } })}\n`
  );
  await assert.rejects(
    pending,
    (err: any) => err instanceof CodingAgentError && err.code === "INTERNAL_ERROR" && /Method not found/.test(err.message)
  );
});

test("responses for unknown ids are terminal, not continuable", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("initialize");
  const done = pending.then(
    () => "resolved",
    (err: any) => `${err.code}`
  );
  harness.client.receiveChunk(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}\n`);
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].kind, "unexpected_response_id");
  assert.equal(harness.client.isClosed, true);
  assert.equal(await done, "INTERNAL_ERROR");
});

test("notifications dispatch to onNotification; stderr is never protocol", () => {
  const harness = makeHarness();
  harness.client.receiveChunk(
    `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { chunk: "hi" } })}\n`
  );
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].method, "session/update");

  // Stderr bytes — even valid JSON-RPC — must not dispatch anything.
  harness.client.handleStderrChunk(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update" })}\n`);
  harness.client.handleStderrChunk("plain log line\n");
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.errors.length, 0);
  assert.ok(harness.client.stderrBytes > 0);
  assert.ok(harness.client.getStderrTail().includes("plain log line"));
});

test("inbound requests are answered via onRequest result", async () => {
  const harness = makeHarness({
    onRequest: (method, params) => {
      harness.inbound.push({ method, params });
      return { decision: "allow" };
    },
  });
  harness.client.receiveChunk(
    `${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { tool: "read" } })}\n`
  );
  await tick();
  assert.equal(harness.inbound.length, 1);
  assert.equal(harness.inbound[0].method, "session/request_permission");
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(JSON.parse(harness.sent[0]), {
    jsonrpc: "2.0",
    id: 77,
    result: { decision: "allow" },
  });
});

test("inbound requests without a handler get a method-not-found error, not silence", async () => {
  const sent: string[] = [];
  const client = new AcpClient({ sendLine: (line) => sent.push(line) });
  client.receiveChunk(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/request_permission" })}\n`);
  await tick();
  assert.equal(sent.length, 1);
  const reply = JSON.parse(sent[0]);
  assert.equal(reply.id, 5);
  assert.equal(reply.error.code, -32601);
  client.close("test done");
});

test("sendLine failure while answering is terminal, never an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown) => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onUnhandled);
  const sent: string[] = [];
  const errors: AcpProtocolError[] = [];
  const client = new AcpClient({
    sendLine: (line) => {
      // Requests go out fine; answering the inbound request fails (EPIPE).
      if (line.includes('"result"') || line.includes('"error"')) {
        throw new Error("EPIPE");
      }
      sent.push(line);
    },
    onProtocolError: (err) => {
      errors.push(err);
    },
    onRequest: () => ({ decision: "allow" }),
  });
  try {
    client.receiveChunk(
      `${JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {} })}\n`
    );
    await tick();
    await tick();
    assert.equal(rejections.length, 0, "must not escape as an unhandled rejection");
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /Failed to send ACP response/);
    assert.equal(client.isClosed, true);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    client.close("test done");
  }
});

test("throwing onNotification fails terminally but later valid lines still settle", async () => {
  const errors: AcpProtocolError[] = [];
  const client = new AcpClient({
    sendLine: () => {},
    onProtocolError: (err) => {
      errors.push(err);
    },
    onNotification: () => {
      throw new Error("observer blew up");
    },
  });
  const pending = client.request("initialize");
  const done = pending.then(
    (v) => ({ settled: "resolved" as const, value: v }),
    (e: any) => ({ settled: "rejected" as const, value: e.code })
  );
  client.receiveChunk(
    `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`
  );
  assert.deepEqual(await done, { settled: "resolved", value: { protocolVersion: 1 } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /notification handler failed/);
  assert.equal(client.isClosed, true);
  client.close("test done");
});

test("throwing onProtocolError observers are swallowed; failure still lands", async () => {
  const client = new AcpClient({
    sendLine: () => {},
    onProtocolError: () => {
      throw new Error("observer blew up");
    },
  });
  const pending = client.request("initialize");
  const done = pending.then(
    () => "resolved",
    (err: any) => `${err.code}`
  );
  client.receiveChunk("garbage\n");
  assert.equal(await done, "INTERNAL_ERROR");
  assert.equal(client.isClosed, true);
});

test("flush delivers a final unterminated response at EOF", async () => {
  const harness = makeHarness();
  const pending = harness.client.request("initialize");
  harness.client.receiveChunk(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }));
  harness.client.flush();
  assert.deepEqual(await pending, { protocolVersion: 1 });
  assert.equal(harness.errors.length, 0);
});

test("input after close is ignored", () => {
  const harness = makeHarness();
  harness.client.close("test done");
  harness.client.receiveChunk("garbage\n");
  harness.client.receiveChunk(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.notifications.length, 0);
});

test("close fails all pending requests and rejects new ones", async () => {
  const harness = makeHarness();
  const first = harness.client.request("session/prompt", {});
  const second = harness.client.request("session/new", {});
  first.then(
    () => assert.fail("must reject on close"),
    () => undefined
  );
  second.then(
    () => assert.fail("must reject on close"),
    () => undefined
  );
  harness.client.close("kernel exited");
  assert.equal(harness.client.isClosed, true);
  await assert.rejects(first, (err: any) => err instanceof CodingAgentError && err.code === "TASK_CANCELLED");
  await assert.rejects(second, (err: any) => err instanceof CodingAgentError && err.code === "TASK_CANCELLED");
  assert.equal(harness.client.pendingCount, 0);
  await assert.rejects(
    harness.client.request("initialize"),
    (err: any) => err instanceof CodingAgentError && err.code === "TASK_CANCELLED"
  );
  harness.client.close("idempotent");
});
