import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { VerificationService } from "../../src/verification/verification-service.js";

test("VerificationService executes command and reports pass/fail", async () => {
  const vs = new VerificationService(5, 5000);

  // Success
  const successRes = await vs.runVerification(
    "echo-test",
    { command: [process.execPath, "-e", "console.log('test passed')"], timeoutSeconds: 5 },
    os.tmpdir()
  );
  assert.equal(successRes.passed, true);
  assert.equal(successRes.exit_code, 0);
  assert.ok(successRes.stdout.includes("test passed"));

  // Failure
  const failRes = await vs.runVerification(
    "fail-test",
    { command: [process.execPath, "-e", "console.error('error occurred'); process.exit(2)"], timeoutSeconds: 5 },
    os.tmpdir()
  );
  assert.equal(failRes.passed, false);
  assert.equal(failRes.exit_code, 2);
  assert.ok(failRes.stderr.includes("error occurred"));
});

test("VerificationService enforces timeout", async () => {
  const vs = new VerificationService(1, 5000);

  await assert.rejects(
    () =>
      vs.runVerification(
        "sleep-test",
        {
          command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
          timeoutSeconds: 1,
        },
        os.tmpdir()
      ),
    (err: any) => err.code === "VERIFICATION_TIMEOUT"
  );
});

test("VerificationService caps large output", async () => {
  const vs = new VerificationService(5, 100); // 100 bytes max

  const res = await vs.runVerification(
    "large-output",
    {
      command: [process.execPath, "-e", "console.log('A'.repeat(500))"],
      timeoutSeconds: 5,
    },
    os.tmpdir()
  );

  assert.equal(res.truncated, true);
  assert.ok(res.stdout.length <= 100);
});
