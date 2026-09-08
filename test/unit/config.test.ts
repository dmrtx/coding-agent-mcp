import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, expandHome } from "../../src/config/config-loader.js";
import { AppConfigSchema } from "../../src/config/schema.js";

test("expandHome expands leading tildes", () => {
  assert.equal(expandHome("~/test"), path.join(os.homedir(), "test"));
  assert.equal(expandHome("/tmp/test"), "/tmp/test");
});

test("AppConfigSchema provides valid defaults", () => {
  const parsed = AppConfigSchema.parse({});
  assert.equal(parsed.server.max_concurrent_tasks, 2);
  assert.ok(parsed.agents.muse);
  assert.ok(parsed.agents.agy);
  assert.deepEqual(parsed.repositories, {});
});

test("loadConfig parses YAML correctly with repository definitions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  const configPath = path.join(tmpDir, "config.yaml");
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);

  const yamlContent = `
server:
  data_dir: ${tmpDir}/data
  max_concurrent_tasks: 4

repositories:
  test-repo:
    root: ${repoDir}
    writable: true
    verification_profiles:
      test:
        command: ["npm", "test"]
        timeout_seconds: 60
`;
  fs.writeFileSync(configPath, yamlContent, "utf-8");

  const config = loadConfig(configPath);
  assert.equal(config.server.max_concurrent_tasks, 4);
  assert.equal(config.repositories["test-repo"].root, repoDir);
  assert.equal(config.repositories["test-repo"].verification_profiles.test.timeout_seconds, 60);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
