import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../../src/config/config-loader.js";
import { AppConfigSchema, AgyAcpConfigSchema } from "../../src/config/schema.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";

test("agy-acp config is disabled by default with safe values", () => {
  const parsed = AppConfigSchema.parse({});
  const acp = parsed.agents["agy-acp"];
  assert.equal(acp.enabled, false);
  assert.equal(acp.acp_executable, "agy_acp_server");
  assert.deepEqual(acp.acp_args, []);
  assert.equal(acp.auth_method, "oauth-personal");
  assert.equal(acp.model, undefined);
  assert.equal(acp.mode, "default");
  assert.equal(acp.allow_write_worktree, false);
  assert.ok(typeof acp.state_dir === "string" && acp.state_dir.length > 0);
  assert.equal(acp.default_timeout_seconds, 1800);
  assert.ok(Array.isArray(acp.env_allowlist) && acp.env_allowlist.includes("PATH"));
});

test("existing agents.agy behavior is unchanged by agy-acp defaults", () => {
  const parsed = AppConfigSchema.parse({});
  assert.equal(parsed.agents.agy.enabled, true);
  assert.equal(parsed.agents.agy.executable, "agy");
  assert.equal(parsed.agents.agy.sandbox, true);
  assert.equal(parsed.agents.muse.enabled, true);
  assert.equal(parsed.agents.muse.executable, "muse");
});

test("agy-acp rejects mode=yolo unless allow_write_worktree=true", () => {
  assert.throws(
    () => AgyAcpConfigSchema.parse({ mode: "yolo" }),
    (err: any) => {
      const text = String(err?.message ?? err);
      return text.includes("yolo") && text.includes("allow_write_worktree");
    }
  );
  assert.throws(
    () => AgyAcpConfigSchema.parse({ mode: "yolo", allow_write_worktree: false }),
    /yolo/
  );
  // Full AppConfig path reports the nested location.
  assert.throws(
    () => AppConfigSchema.parse({ agents: { "agy-acp": { mode: "yolo" } } }),
    (err: any) =>
      Array.isArray(err?.issues) &&
      err.issues.some((issue: any) => issue.path.join(".").includes("agy-acp"))
  );

  const gated = AgyAcpConfigSchema.parse({ mode: "yolo", allow_write_worktree: true });
  assert.equal(gated.mode, "yolo");
  assert.equal(gated.allow_write_worktree, true);
});

test("agy-acp rejects invalid auth_method and mode values", () => {
  assert.throws(() => AgyAcpConfigSchema.parse({ auth_method: "password" }));
  assert.throws(() => AgyAcpConfigSchema.parse({ mode: "turbo" }));
  for (const method of ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"] as const) {
    assert.equal(AgyAcpConfigSchema.parse({ auth_method: method }).auth_method, method);
  }
  const withModel = AgyAcpConfigSchema.parse({ model: "antigravity-gemini-3-pro" });
  assert.equal(withModel.model, "antigravity-gemini-3-pro");
  const wrapped = AgyAcpConfigSchema.parse({
    acp_args: ["--agy-path", "/opt/bin/agy_acp_server", "--"],
  });
  assert.deepEqual(wrapped.acp_args, ["--agy-path", "/opt/bin/agy_acp_server", "--"]);
});

test("loadConfig parses an agy-acp YAML block and absolutizes state_dir", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  fs.writeFileSync(
    configPath,
    `server:\n  data_dir: ${tmpDir}/data\nagents:\n  agy-acp:\n    enabled: false\n    acp_executable: /opt/bin/agy_acp_server\n    auth_method: gemini-api-key\n    model: test-model\n    mode: auto_edit\n    allow_write_worktree: false\n    state_dir: ${tmpDir}/acp-state\n    default_timeout_seconds: 60\nrepositories:\n  test-repo:\n    root: ${repoDir}\n`,
    "utf-8"
  );
  try {
    const config = loadConfig(configPath);
    const acp = config.agents["agy-acp"];
    assert.equal(acp.enabled, false);
    assert.equal(acp.acp_executable, "/opt/bin/agy_acp_server");
    assert.equal(acp.auth_method, "gemini-api-key");
    assert.equal(acp.model, "test-model");
    assert.equal(acp.mode, "auto_edit");
    assert.equal(acp.allow_write_worktree, false);
    assert.equal(acp.state_dir, path.join(tmpDir, "acp-state"));
    assert.ok(path.isAbsolute(acp.state_dir));
    assert.equal(acp.default_timeout_seconds, 60);
    // This file lists only agy-acp: omitted agents must NOT be backfilled.
    assert.equal(config.agents.agy, undefined);
    assert.equal(config.agents.muse, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("explicit agents:{} stays empty (no default backfill)", () => {
  const parsed = AppConfigSchema.parse({ agents: {} });
  assert.deepEqual(Object.keys(parsed.agents), []);
});

test("explicit agy-only subset does not inject enabled muse or agy-acp", () => {
  const parsed = AppConfigSchema.parse({ agents: { agy: { enabled: true, executable: "agy" } } });
  assert.deepEqual(Object.keys(parsed.agents), ["agy"]);
  assert.equal(parsed.agents.muse, undefined);
  assert.equal((parsed.agents as Record<string, unknown>)["agy-acp"], undefined);
});

test("explicit custom-only subset keeps legacy generic parsing without backfill", () => {
  const parsed = AppConfigSchema.parse({ agents: { mybot: { enabled: false, executable: "mybot" } } });
  assert.deepEqual(Object.keys(parsed.agents), ["mybot"]);
  const mybot = parsed.agents.mybot as { enabled: boolean; executable?: string };
  assert.equal(mybot.enabled, false);
  assert.equal(mybot.executable, "mybot");
});

test("AgentRegistry does not gain muse from an agy-only config", () => {
  const parsed = AppConfigSchema.parse({ agents: { agy: { enabled: true, executable: "agy" } } });
  const registry = new AgentRegistry(parsed);
  assert.throws(
    () => registry.getAgent("muse"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );
});

test("omitted agents section keeps whole-agents defaults including disabled agy-acp", () => {
  const parsed = AppConfigSchema.parse({});
  assert.ok(parsed.agents.muse);
  assert.ok(parsed.agents.agy);
  assert.equal(parsed.agents["agy-acp"].enabled, false);
});

test("loadConfig rejects unsafe yolo YAML with a validation error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-config-"));
  const configPath = path.join(tmpDir, "config.yaml");
  fs.writeFileSync(
    configPath,
    `server:\n  data_dir: ${tmpDir}/data\nagents:\n  agy-acp:\n    mode: yolo\n`,
    "utf-8"
  );
  try {
    assert.throws(() => loadConfig(configPath), /yolo/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
