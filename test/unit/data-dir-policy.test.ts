import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../../src/config/config-loader.js";
import { CodingAgentError } from "../../src/domain/errors.js";

function writeConfig(tmpDir: string, dataDir: string, repoRoot: string, alias = "test-repo"): string {
  const configPath = path.join(tmpDir, `config-${process.hrtime.bigint()}.yaml`);
  fs.writeFileSync(
    configPath,
    `server:\n  data_dir: ${dataDir}\nrepositories:\n  ${alias}:\n    root: ${repoRoot}\n`,
    "utf-8"
  );
  return configPath;
}

function trySymlink(t: TestContext, target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    t.skip("symlinks cannot be created in this environment");
    return false;
  }
}

function expectPolicyDenied(configPath: string, alias: string): void {
  assert.throws(
    () => loadConfig(configPath),
    (err: any) => {
      assert.ok(err instanceof CodingAgentError, "expected CodingAgentError");
      assert.equal(err.code, "POLICY_DENIED");
      assert.ok(
        err.message.includes(alias),
        `error message must include repository alias '${alias}': ${err.message}`
      );
      assert.equal(err.details?.repository, alias);
      return true;
    }
  );
}

test("loadConfig rejects data_dir inside a repository root", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const repoDir = path.join(tmpDir, "repo");
    const dataDir = path.join(repoDir, "data");
    fs.mkdirSync(repoDir, { recursive: true });
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a repository root inside data_dir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const dataDir = path.join(tmpDir, "data");
    const repoDir = path.join(dataDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects data_dir equal to a repository root", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const shared = path.join(tmpDir, "shared");
    fs.mkdirSync(shared, { recursive: true });
    expectPolicyDenied(writeConfig(tmpDir, shared, shared), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects data_dir that resolves inside a repo through a symlink", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const linkDir = path.join(tmpDir, "link-to-repo");
    if (!trySymlink(t, repoDir, linkDir)) {
      return;
    }
    // Lexically outside the repo, but realpath resolves inside it.
    const dataDir = path.join(linkDir, "data");
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a repo root that resolves inside data_dir through a symlink", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const dataDir = path.join(tmpDir, "data");
    const innerDir = path.join(dataDir, "inner");
    fs.mkdirSync(innerDir, { recursive: true });
    const linkRepo = path.join(tmpDir, "link-to-inner");
    if (!trySymlink(t, innerDir, linkRepo)) {
      return;
    }
    // Lexically outside data_dir, but realpath resolves inside it.
    expectPolicyDenied(writeConfig(tmpDir, dataDir, linkRepo), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects data_dir that is itself a dangling symlink into a repo", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    // Target does not exist yet: a plain existsSync-based walk would treat
    // the link as a missing name and miss the overlap.
    const dataDir = path.join(tmpDir, "dangling-data");
    if (!trySymlink(t, path.join(repoDir, "future-sub"), dataDir)) {
      return;
    }
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a repo root that is itself a dangling symlink into data_dir", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const repoDir = path.join(tmpDir, "dangling-repo");
    if (!trySymlink(t, path.join(dataDir, "future-sub"), repoDir)) {
      return;
    }
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects data_dir nested below a dangling symlink into a repo", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    // Mid-path link whose target does not exist; data_dir extends below it.
    const linkDir = path.join(tmpDir, "link-to-future");
    if (!trySymlink(t, path.join(repoDir, "future-sub"), linkDir)) {
      return;
    }
    const dataDir = path.join(linkDir, "deep", "data");
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a repo root nested below a dangling symlink into data_dir", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const linkRepo = path.join(tmpDir, "link-to-future");
    if (!trySymlink(t, path.join(dataDir, "future-sub"), linkRepo)) {
      return;
    }
    const repoDir = path.join(linkRepo, "deep", "checkout");
    expectPolicyDenied(writeConfig(tmpDir, dataDir, repoDir), "test-repo");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts a disjoint data_dir and repository root", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datadir-policy-"));
  try {
    const dataDir = path.join(tmpDir, "data");
    const repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    const config = loadConfig(writeConfig(tmpDir, dataDir, repoDir));
    assert.equal(config.server.data_dir, path.resolve(dataDir));
    assert.equal(config.repositories["test-repo"].root, path.resolve(repoDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
