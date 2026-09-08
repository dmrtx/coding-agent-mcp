import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../../src/config/config-loader.js";
import { CodingAgentError } from "../../src/domain/errors.js";

function writeConfig(
  tmpDir: string,
  opts: { dataDir: string; stateDir?: string; repoRoot: string; alias?: string }
): string {
  const alias = opts.alias ?? "test-repo";
  const acpBlock =
    opts.stateDir === undefined
      ? ""
      : `  agy-acp:\n    state_dir: ${opts.stateDir}\n`;
  const configPath = path.join(tmpDir, `config-${process.hrtime.bigint()}.yaml`);
  fs.writeFileSync(
    configPath,
    `server:\n  data_dir: ${opts.dataDir}\nagents:\n${acpBlock}repositories:\n  ${alias}:\n    root: ${opts.repoRoot}\n`,
    "utf-8"
  );
  return configPath;
}

function expectStateDirDenied(configPath: string, alias: string): void {
  assert.throws(
    () => loadConfig(configPath),
    (err: any) => {
      assert.ok(err instanceof CodingAgentError, "expected CodingAgentError");
      assert.equal(err.code, "POLICY_DENIED");
      assert.ok(
        err.message.includes("state_dir"),
        `error message must mention state_dir: ${err.message}`
      );
      assert.ok(
        err.message.includes(alias),
        `error message must include repository alias '${alias}': ${err.message}`
      );
      assert.equal(err.details?.repository, alias);
      return true;
    }
  );
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

function setupBase(): { tmpDir: string; dataDir: string; repoDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-statedir-"));
  const dataDir = path.join(tmpDir, "data");
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });
  return { tmpDir, dataDir, repoDir };
}

test("loadConfig rejects state_dir equal to a repository root", () => {
  const { tmpDir, dataDir, repoDir } = setupBase();
  try {
    expectStateDirDenied(
      writeConfig(tmpDir, { dataDir, stateDir: repoDir, repoRoot: repoDir }),
      "test-repo"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects state_dir inside a repository root", () => {
  const { tmpDir, dataDir, repoDir } = setupBase();
  try {
    expectStateDirDenied(
      writeConfig(tmpDir, { dataDir, stateDir: path.join(repoDir, "acp-state"), repoRoot: repoDir }),
      "test-repo"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a repository root inside state_dir", () => {
  const { tmpDir, dataDir } = setupBase();
  const stateDir = path.join(tmpDir, "acp-state");
  const repoDir = path.join(stateDir, "checkout");
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    expectStateDirDenied(
      writeConfig(tmpDir, { dataDir, stateDir, repoRoot: repoDir }),
      "test-repo"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects state_dir that resolves inside a repo through a symlink", (t) => {
  const { tmpDir, dataDir, repoDir } = setupBase();
  try {
    const linkDir = path.join(tmpDir, "link-to-repo");
    if (!trySymlink(t, repoDir, linkDir)) {
      return;
    }
    expectStateDirDenied(
      writeConfig(tmpDir, { dataDir, stateDir: path.join(linkDir, "acp-state"), repoRoot: repoDir }),
      "test-repo"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts state_dir under data_dir disjoint from repos", () => {
  const { tmpDir, dataDir, repoDir } = setupBase();
  try {
    const stateDir = path.join(dataDir, "agy-acp");
    const config = loadConfig(writeConfig(tmpDir, { dataDir, stateDir, repoRoot: repoDir }));
    assert.equal(config.agents["agy-acp"]?.state_dir, path.resolve(stateDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig accepts an explicit agents subset without agy-acp", () => {
  const { tmpDir, dataDir, repoDir } = setupBase();
  try {
    const configPath = path.join(tmpDir, "config-subset.yaml");
    fs.writeFileSync(
      configPath,
      `server:\n  data_dir: ${dataDir}\nagents:\n  agy:\n    enabled: true\nrepositories:\n  test-repo:\n    root: ${repoDir}\n`,
      "utf-8"
    );
    const config = loadConfig(configPath);
    assert.deepEqual(Object.keys(config.agents), ["agy"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
