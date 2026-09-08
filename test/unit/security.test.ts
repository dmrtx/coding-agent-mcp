import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assertPathContained, sanitizeRelativePath } from "../../src/security/path-policy.js";
import { sanitizeEnvironment } from "../../src/security/environment-policy.js";
import { validateCommandExecution } from "../../src/security/process-policy.js";
import { CodingAgentError } from "../../src/domain/errors.js";

test("PathPolicy prevents directory traversal escape", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-test-"));
  const realTmpDir = fs.realpathSync(tmpDir);
  const subDir = path.join(tmpDir, "sub");
  fs.mkdirSync(subDir);

  // Normal inside
  const allowed = assertPathContained(path.join(subDir, "file.txt"), tmpDir);
  assert.ok(allowed.startsWith(realTmpDir));

  // Traversal outside
  assert.throws(
    () => assertPathContained(path.join(tmpDir, "../escape.txt"), subDir),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("PathPolicy prevents symlink escape", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-symlink-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-outside-"));
  const symlinkPath = path.join(tmpDir, "escape_link");

  fs.symlinkSync(outsideDir, symlinkPath);

  assert.throws(
    () => assertPathContained(symlinkPath, tmpDir),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test("EnvironmentPolicy strips sensitive parent variables", () => {
  process.env.TEST_SECRET_KEY = "super_secret_123";
  process.env.PATH = "/usr/bin:/bin";

  const sanitized = sanitizeEnvironment(["PATH"]);
  assert.equal(sanitized.PATH, "/usr/bin:/bin");
  assert.equal(sanitized.TEST_SECRET_KEY, undefined);

  delete process.env.TEST_SECRET_KEY;
});

test("ProcessPolicy blocks forbidden and destructive commands", () => {
  assert.throws(
    () => validateCommandExecution("sudo", ["apt", "update"]),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  assert.throws(
    () => validateCommandExecution("/bin/su", []),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  assert.throws(
    () => validateCommandExecution("git", ["reset", "--hard", "HEAD~1"]),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  assert.throws(
    () => validateCommandExecution("git", ["clean", "-fdx"]),
    (err: any) => err instanceof CodingAgentError && err.code === "POLICY_DENIED"
  );

  // Allowed normal commands
  assert.doesNotThrow(() => validateCommandExecution("npm", ["test"]));
  assert.doesNotThrow(() => validateCommandExecution("git", ["status"]));
});
