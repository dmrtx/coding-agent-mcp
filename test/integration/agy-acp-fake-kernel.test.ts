import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { AcpClient } from "../../src/agents/acp/client.js";
import { decideAcpToolPermission } from "../../src/agents/acp/permission-policy.js";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "agy-acp-fake-server.mjs");

test("fake ACP kernel: initialize/new/prompt/resume/cancel/model config with permission round-trip", async () => {
  assert.ok(fs.existsSync(FIXTURE), `fake kernel fixture must exist at ${FIXTURE}`);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fake-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# test\n");

  const child: ChildProcess = spawn(process.execPath, [FIXTURE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  let permissionRequests = 0;

  const client = new AcpClient({
    sendLine: (line) => {
      child.stdin!.write(`${line}\n`);
    },
    defaultTimeoutMs: 10_000,
    onRequest: (method, params) => {
      assert.equal(method, "session/request_permission");
      permissionRequests += 1;
      const toolCall = (params as any)?.toolCall ?? {};
      const decision = decideAcpToolPermission({
        workspaceRoot: workspace,
        mode: "implement",
        allowWriteWorktree: false,
        toolCall: { tool: toolCall.tool, paths: toolCall.paths },
      });
      return { decision: decision.allowed ? "allow" : "deny", reason: decision.reason };
    },
  });
  // Deliver kernel stdout byte-by-byte to genuinely exercise incremental
  // framing/reassembly over a live server (chunk boundaries are otherwise
  // OS-controlled and usually message-aligned for small payloads).
  child.stdout!.on("data", (chunk: Buffer) => {
    const bytes = Buffer.from(chunk);
    for (let i = 0; i < bytes.length; i += 1) {
      client.receiveChunk(bytes.subarray(i, i + 1));
    }
  });
  child.stderr!.on("data", (chunk) => {
    client.handleStderrChunk(chunk);
    stderr.push(chunk.toString("utf-8"));
  });

  try {
    const hello = await client.initialize({ protocolVersion: 1 });
    assert.equal(hello.serverInfo?.name, "agy-acp-fake");

    const created = await client.sessionNew({ cwd: workspace });
    assert.ok(created.sessionId?.startsWith("sess-"), `expected session id, got ${created.sessionId}`);
    const sessionId = created.sessionId as string;

    const modelConfig = await client.sessionSetConfigOption({
      sessionId,
      key: "model",
      value: "test-model",
    });
    assert.equal(modelConfig.updated, true);
    assert.equal((modelConfig as Record<string, unknown>).value, "test-model");

    const answer = await client.sessionPrompt({ sessionId, prompt: "read the readme" });
    assert.equal(answer.stopReason, "end_turn");
    assert.equal(permissionRequests, 1, "prompt must perform exactly one permission round-trip");
    assert.equal((answer as Record<string, unknown>).permissionOutcome, "allow");

    const resumed = await client.sessionResume({ sessionId });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.sessionId, sessionId);

    const cancelled = await client.sessionCancel({ sessionId });
    assert.equal(cancelled.cancelled, true);

    // Unknown methods surface as rejections, never hangs.
    await assert.rejects(() => client.request("nope/method", {}, { timeoutMs: 5000 }));

    // Unknown sessions and invalid params surface as kernel error rejections.
    await assert.rejects(
      () => client.sessionResume({ sessionId: "sess-does-not-exist" }, { timeoutMs: 5000 }),
      /Unknown session/
    );
    await assert.rejects(
      () => client.sessionSetConfigOption({ sessionId }, { timeoutMs: 5000 }),
      /'key' is required/
    );

    assert.equal(client.pendingCount, 0);
  } finally {
    client.close("test done");
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
