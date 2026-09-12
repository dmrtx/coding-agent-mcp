import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { MuseAdapter } from "../../src/agents/muse-adapter.js";
import { AgyAdapter } from "../../src/agents/agy-adapter.js";
import { AgentRegistry } from "../../src/agents/agent-registry.js";
import { GitService } from "../../src/repositories/git-service.js";
import { AppConfigSchema } from "../../src/config/schema.js";

test("MuseAdapter constructs safe headless arguments without --yolo", async () => {
  const adapter = new MuseAdapter({
    enabled: true,
    executable: "muse",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const spawnInfo = await adapter.prepareStart({
    taskId: "task-test-muse",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "fix bug",
    mode: "implement",
    timeoutMs: 60000,
    environment: {},
    sessionId: "11111111-2222-3333-4444-555555555555",
  });

  // Verify critical safety flags
  assert.ok(!spawnInfo.args.includes("--yolo"), "Muse must NOT be executed with --yolo (disables sandbox)");
  assert.ok(spawnInfo.args.includes("--trust-workspace"), "Muse must use --trust-workspace to avoid interactive prompts");
  assert.ok(spawnInfo.args.includes("--disable-approval"), "Muse must use --disable-approval for headless execution");
  assert.ok(spawnInfo.args.includes("--approval-mode"), "Muse must specify approval-mode");
  assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--approval-mode") + 1], "never");
  assert.ok(spawnInfo.args.includes("--session-id"));
  assert.equal(
    spawnInfo.args[spawnInfo.args.indexOf("--session-id") + 1],
    "11111111-2222-3333-4444-555555555555"
  );
  assert.ok(spawnInfo.args.includes("fix bug"));

  // Review mode disables write and shell
  const reviewSpawn = await adapter.prepareStart({
    taskId: "task-test-muse-review",
    repositoryRoot: "/repo",
    workspaceRoot: "/workspace",
    instruction: "review changes",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(reviewSpawn.args.includes("--disable-write"), "Review mode must include --disable-write");
  assert.ok(reviewSpawn.args.includes("--disable-shell"), "Review mode must include --disable-shell");

  // Continuation preserves trust-workspace and session-id
  const contSpawn = await adapter.prepareContinue({
    taskId: "task-test-muse",
    workspaceRoot: "/workspace",
    sessionId: "11111111-2222-3333-4444-555555555555",
    instruction: "follow-up fix",
    mode: "review",
    timeoutMs: 60000,
    environment: {},
  });
  assert.ok(contSpawn.args.includes("--trust-workspace"));
  assert.ok(contSpawn.args.includes("--disable-write"));
  assert.ok(contSpawn.args.includes("--disable-shell"));
});

test("AgyAdapter constructs safe headless arguments with sandbox and json output", async () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-ws-"));
  try {
    const spawnInfo = await adapter.prepareStart({
      taskId: "task-test-agy",
      repositoryRoot: tmpWorkspace,
      workspaceRoot: tmpWorkspace,
      instruction: "create feature",
      mode: "implement",
      timeoutMs: 60000,
      environment: {},
    });

    assert.ok(spawnInfo.args.includes("--sandbox"), "AGY must be executed with --sandbox enabled");
    assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--add-dir") + 1], tmpWorkspace);
    assert.ok(spawnInfo.args.includes("--output-format"), "AGY must specify output-format");
    assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--output-format") + 1], "json");
    assert.ok(!spawnInfo.args.includes("--dangerously-skip-permissions"), "AGY must NOT include --dangerously-skip-permissions");
    assert.ok(spawnInfo.args.includes("create feature"));
    // Must NOT have invented arbitrary sessionId
    assert.equal(spawnInfo.sessionId, undefined);

    // Check isolated environment settings
    assert.ok(spawnInfo.env.HOME?.includes(path.join("agent-homes", "agy", "task-test-agy")));
    assert.equal(fs.existsSync(path.join(tmpWorkspace, ".gemini-config")), false, "No config inside workspace root");
    assert.equal(fs.existsSync(path.join(tmpWorkspace, ".gemini")), false, "No .gemini inside workspace root");

    const settingsFile = path.join(spawnInfo.env.HOME!, ".gemini", "antigravity-cli", "settings.json");
    assert.ok(fs.existsSync(settingsFile), "settings.json must be created in isolated AGY HOME");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    assert.equal(settings.enableTerminalSandbox, true);
    assert.equal(settings.toolPermission, "proceed-in-sandbox");
    assert.equal(settings.allowNonWorkspaceAccess, false);
    assert.deepEqual(settings.trustedWorkspaces, [tmpWorkspace]);

    // Permissions: 0700 for dir, 0600 for settings file
    const homeStat = fs.statSync(spawnInfo.env.HOME!);
    assert.equal(homeStat.mode & 0o777, 0o700, "Isolated AGY HOME must have 0700 permissions");
    const settingsStat = fs.statSync(settingsFile);
    assert.equal(settingsStat.mode & 0o777, 0o600, "settings.json must have 0600 permissions");

    // Review mode uses plan
    const reviewSpawn = await adapter.prepareStart({
      taskId: "task-test-agy-review",
      repositoryRoot: tmpWorkspace,
      workspaceRoot: tmpWorkspace,
      instruction: "review feature",
      mode: "review",
      timeoutMs: 60000,
      environment: {},
    });
    assert.ok(reviewSpawn.args.includes("--mode"));
    assert.equal(reviewSpawn.args[reviewSpawn.args.indexOf("--mode") + 1], "plan");

    // Continuation uses real conversation id and does not use --continue
    const continueSpawn = await adapter.prepareContinue({
      taskId: "task-test-agy",
      workspaceRoot: tmpWorkspace,
      sessionId: "conv-real-9999",
      instruction: "address review feedback",
      mode: "review",
      timeoutMs: 60000,
      environment: {},
    });
    assert.ok(continueSpawn.args.includes("--conversation"));
    assert.equal(
      continueSpawn.args[continueSpawn.args.indexOf("--conversation") + 1],
      "conv-real-9999"
    );
    assert.ok(!continueSpawn.args.includes("--continue"), "AGY continue must not fall back to global --continue");
    assert.equal(continueSpawn.args[continueSpawn.args.indexOf("--add-dir") + 1], tmpWorkspace);
    assert.ok(continueSpawn.args.includes("--mode"));
    assert.equal(continueSpawn.args[continueSpawn.args.indexOf("--mode") + 1], "plan");

    // Continuation without sessionId is strictly rejected
    await assert.rejects(
      () =>
        adapter.prepareContinue({
          taskId: "task-test-agy",
          workspaceRoot: tmpWorkspace,
          sessionId: undefined,
          instruction: "address feedback",
          timeoutMs: 60000,
          environment: {},
        }),
      (err: any) => err.code === "TASK_NOT_RESUMABLE"
    );
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("account-backed AGY can explicitly reuse host HOME for macOS Keychain", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-host-home-test-"));
  const hostHome = path.join(tmpBase, "real-home");
  fs.mkdirSync(hostHome);
  const adapter = new AgyAdapter(
    {
      enabled: true,
      executable: "agy",
      sandbox: true,
      use_host_home: true,
      default_timeout_seconds: 1800,
      env_allowlist: ["HOME", "PATH"],
    },
    path.join(tmpBase, "data")
  );

  try {
    const spawnInfo = await adapter.prepareStart({
      taskId: "task-host-home",
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      instruction: "inspect only",
      mode: "investigate",
      timeoutMs: 60_000,
      environment: { HOME: hostHome, PATH: "/usr/bin:/bin" },
    });

    assert.equal(spawnInfo.env.HOME, hostHome);
    assert.equal(
      fs.existsSync(path.join(tmpBase, "data", "agent-homes", "agy", "task-host-home")),
      false,
      "host-HOME mode must not create an isolated profile"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("AGY Gemini runs the CLI through Gyro with an isolated API-key profile", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gemini-test-"));
  const adapter = new AgyAdapter(
    {
      enabled: true,
      executable: "/opt/bin/agy-gyro",
      sandbox: true,
      default_timeout_seconds: 1800,
      env_allowlist: ["PATH", "GEMINI_API_KEY"],
      extra_args: ["--model", "gemini-test-model"],
    },
    tmpBase,
    {
      id: "agy-gemini",
      displayName: "AGY Gemini (via Gyro)",
      modelProvider: "gemini",
      commandPrefixArgs: ["--max-retries", "9", "--agy-path", "/opt/bin/agy", "--"],
    }
  );
  try {
    const spawnInfo = await adapter.prepareStart({
      taskId: "task-test-agy-gemini",
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      instruction: "inspect only",
      mode: "review",
      timeoutMs: 60_000,
      environment: {
        PATH: "/usr/bin:/bin",
        GEMINI_API_KEY: "explicit-test-key",
        GOOGLE_API_KEY: "must-not-pass",
        ANTIGRAVITY_TOKEN: "must-not-pass",
      },
    });

    assert.equal(spawnInfo.command, "/opt/bin/agy-gyro");
    assert.deepEqual(spawnInfo.args.slice(0, 6), [
      "--max-retries",
      "9",
      "--agy-path",
      "/opt/bin/agy",
      "--",
      "--add-dir",
    ]);
    assert.deepEqual(spawnInfo.args.slice(6, 9), [
      "/workspace",
      "--print",
      "inspect only",
    ]);
    assert.ok(spawnInfo.args.includes("--model"));
    assert.equal(spawnInfo.args[spawnInfo.args.indexOf("--model") + 1], "gemini-test-model");
    assert.equal(spawnInfo.env.GEMINI_API_KEY, "explicit-test-key");
    assert.equal(spawnInfo.env.GOOGLE_API_KEY, undefined);
    assert.equal(spawnInfo.env.ANTIGRAVITY_TOKEN, undefined);
    assert.ok(spawnInfo.env.HOME.includes(path.join("agent-homes", "agy-gemini")));

    const settingsPath = path.join(
      spawnInfo.env.HOME,
      ".gemini",
      "antigravity-cli",
      "settings.json"
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(settings.modelProvider, "gemini");
    assert.equal(
      fs.existsSync(path.join(path.dirname(settingsPath), "antigravity-oauth-token")),
      false
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("AGY Gemini fails before launch when GEMINI_API_KEY is absent", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gemini-no-key-"));
  const adapter = new AgyAdapter(
    {
      enabled: true,
      executable: "agy-gyro",
      sandbox: true,
      default_timeout_seconds: 1800,
      env_allowlist: ["PATH", "GEMINI_API_KEY"],
    },
    tmpBase,
    { id: "agy-gemini", modelProvider: "gemini" }
  );
  try {
    await assert.rejects(
      () =>
        adapter.prepareStart({
          taskId: "task-test-agy-gemini-no-key",
          repositoryRoot: "/repo",
          workspaceRoot: "/workspace",
          instruction: "inspect only",
          mode: "review",
          timeoutMs: 60_000,
          environment: { PATH: "/usr/bin:/bin" },
        }),
      (err: any) => err.code === "AGENT_NOT_AVAILABLE" && /GEMINI_API_KEY/.test(err.message)
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("AgyAdapter extracts conversation_id from JSON and stream-json", () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  // Single JSON object
  const singleJson = JSON.stringify({
    conversation_id: "conv-abc-123",
    result: "completed successfully",
  });
  assert.equal(adapter.extractSessionId(singleJson, ""), "conv-abc-123");

  // camelCase conversationId
  const camelJson = JSON.stringify({
    conversationId: "conv-def-456",
    status: "ok",
  });
  assert.equal(adapter.extractSessionId(camelJson, ""), "conv-def-456");

  // Stream-json NDJSON lines
  const streamJson = [
    JSON.stringify({ type: "init", conversation_id: "conv-stream-789" }),
    JSON.stringify({ type: "progress", message: "working..." }),
  ].join("\n");
  assert.equal(adapter.extractSessionId(streamJson, ""), "conv-stream-789");

  // Empty or invalid returns undefined
  assert.equal(adapter.extractSessionId("", ""), undefined);
  assert.equal(adapter.extractSessionId("just plain text without id", ""), undefined);
});

test("AgentRegistry blocks disabled and unavailable agents", async () => {
  const config = AppConfigSchema.parse({
    agents: {
      disabled_agent: {
        enabled: false,
        executable: "none",
      },
    },
  });

  const registry = new AgentRegistry(config);
  // Disabled agent
  await assert.rejects(
    () => registry.validateAgentAvailable("disabled_agent"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );

  // Unregistered agent
  await assert.rejects(
    () => registry.validateAgentAvailable("unknown_agent"),
    (err: any) => err.code === "AGENT_NOT_AVAILABLE"
  );
});

test("AgyAdapter isolates auth token outside workspace and keeps workspace git tree clean", async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agy-auth-test-"));
  const mockHome = path.join(tmpBase, "mock-home");
  const hostTokenDir = path.join(mockHome, ".gemini", "antigravity-cli");
  fs.mkdirSync(hostTokenDir, { recursive: true });
  const sentinelToken = "SUPER_SECRET_SENTINEL_TOKEN_12345";
  fs.writeFileSync(path.join(hostTokenDir, "antigravity-oauth-token"), sentinelToken, "utf-8");

  const repoDir = path.join(tmpBase, "repo");
  fs.mkdirSync(repoDir);
  execSync("git init -b main", { cwd: repoDir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello world\n");
  execSync("git add file.txt && git commit -m 'initial'", { cwd: repoDir, stdio: "ignore" });

  const dataDir = path.join(tmpBase, "data");
  const adapter = new AgyAdapter(
    {
      enabled: true,
      executable: "agy",
      sandbox: true,
      default_timeout_seconds: 1800,
    },
    dataDir
  );

  const prevHome = process.env.HOME;
  process.env.HOME = mockHome;
  try {
    const spawnInfo = await adapter.prepareStart({
      taskId: "task-auth-iso",
      repositoryRoot: repoDir,
      workspaceRoot: repoDir,
      instruction: "implement feature",
      mode: "implement",
      timeoutMs: 60000,
      environment: {},
    });

    // 1. HOME is outside workspace and located under dataDir
    assert.ok(spawnInfo.env.HOME?.startsWith(dataDir), "AGY HOME must be under dataDir");
    assert.ok(!spawnInfo.env.HOME?.startsWith(repoDir), "AGY HOME must be outside workspaceRoot");

    // 2. Token was copied to isolated HOME with mode 0600
    const copiedTokenPath = path.join(spawnInfo.env.HOME!, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    assert.ok(fs.existsSync(copiedTokenPath), "Token must exist in isolated HOME");
    assert.equal(fs.readFileSync(copiedTokenPath, "utf-8"), sentinelToken);
    assert.equal(fs.statSync(copiedTokenPath).mode & 0o777, 0o600);

    // 3. Workspace is completely clean (no untracked files, no .gemini-config)
    const statusOutput = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf-8" });
    assert.equal(statusOutput.trim(), "", "Workspace git status must be completely clean");
    assert.equal(fs.existsSync(path.join(repoDir, ".gemini-config")), false);
    assert.equal(fs.existsSync(path.join(repoDir, ".gemini")), false);

    // 4. Git diff contains no token sentinel or .gemini-config
    const gitService = new GitService();
    const diffResult = await gitService.getDiff(repoDir, { workspaceRoot: repoDir });
    assert.ok(!diffResult.diff.includes(sentinelToken), "Diff must NOT leak token");
    assert.ok(!diffResult.diff.includes(".gemini-config"), "Diff must NOT include .gemini-config");
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test("AgyAdapter isolated settings grant workspace-scoped read_file only", async () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-readscope-ws-"));
  try {
    const spawnInfo = await adapter.prepareStart({
      taskId: "task-test-agy-readscope",
      repositoryRoot: tmpWorkspace,
      workspaceRoot: tmpWorkspace,
      instruction: "list files",
      mode: "implement",
      timeoutMs: 60000,
      environment: {},
    });

    const settingsFile = path.join(spawnInfo.env.HOME!, ".gemini", "antigravity-cli", "settings.json");
    const raw = fs.readFileSync(settingsFile, "utf-8");
    const settings = JSON.parse(raw);
    const allow: string[] = settings.permissions.allow;

    // Exactly one workspace-scoped read grant, expressed corruption-proof
    // relative to the single trusted workspace (no absolute path characters
    // in the rule string at all, so ')'/whitespace/control codes in an
    // operator-controlled path cannot corrupt it).
    assert.deepEqual(
      allow.filter((entry) => entry.startsWith("read_file(")),
      ["read_file(.)"]
    );
    assert.ok(!allow.includes("read_file(*)"), "Must never grant read_file(*)");
    for (const entry of allow) {
      assert.ok(!entry.includes("*"), `Settings allowlist must not use globs: ${entry}`);
      assert.ok(!entry.startsWith("write_file"), `Settings must not grant writes: ${entry}`);
    }
    assert.ok(!allow.includes("command(*)"), "Must not grant command(*)");
    assert.ok(!raw.includes("skip-permissions"), "Must not use dangerous skip-permissions");
    assert.ok(!raw.includes("unsandboxed"), "Must not run unsandboxed");
    // The facts that make `read_file(.)` unambiguous: exactly one trusted
    // workspace, and the agent spawns with cwd inside it.
    assert.deepEqual(settings.trustedWorkspaces, [tmpWorkspace]);
    assert.equal(spawnInfo.cwd, tmpWorkspace);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("AgyAdapter investigate mode keeps --mode plan like review mode", async () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });

  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-investigate-ws-"));
  try {
    const investigateSpawn = await adapter.prepareStart({
      taskId: "task-test-agy-investigate",
      repositoryRoot: tmpWorkspace,
      workspaceRoot: tmpWorkspace,
      instruction: "investigate failure",
      mode: "investigate",
      timeoutMs: 60000,
      environment: {},
    });
    assert.ok(investigateSpawn.args.includes("--mode"));
    assert.equal(investigateSpawn.args[investigateSpawn.args.indexOf("--mode") + 1], "plan");

    const continueSpawn = await adapter.prepareContinue({
      taskId: "task-test-agy-investigate",
      workspaceRoot: tmpWorkspace,
      sessionId: "conv-real-1234",
      instruction: "dig deeper",
      mode: "investigate",
      timeoutMs: 60000,
      environment: {},
    });
    assert.ok(continueSpawn.args.includes("--mode"));
    assert.equal(continueSpawn.args[continueSpawn.args.indexOf("--mode") + 1], "plan");
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("AgyAdapter interpretResult detects envelope denials without false-failing", () => {
  const adapter = new AgyAdapter({
    enabled: true,
    executable: "agy",
    sandbox: true,
    default_timeout_seconds: 1800,
    env_allowlist: ["HOME", "PATH"],
  });
  const env = (extra: Record<string, unknown>) => ({ conversation_id: "conv-1", ...extra });

  // Full-blob envelope denials (denial evidence defaults to POLICY_DENIED)
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ status: "SUCCESS", denied_actions: ["read /etc/passwd"] })), "").blocked,
    true
  );
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ deniedActions: ["run rm -rf /"] })), "").blocked,
    true
  );
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ denied_tools: ["shell"] })), "").blocked,
    true
  );
  for (const status of ["denied", "blocked", "permission_denied", "permission-denied", "permissionDenied"]) {
    const result = adapter.interpretResult(JSON.stringify(env({ status })), "");
    assert.equal(result.blocked, true, `status '${status}' must be treated as a denial`);
    assert.equal(result.failureCode, undefined, "denial keeps the default POLICY_DENIED code");
  }
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ status: "SUCCESS", denied_count: 2 })), "").blocked,
    true
  );

  // Bare envelope ERROR without denial evidence fails honestly, not as POLICY_DENIED
  const bareError = adapter.interpretResult(JSON.stringify(env({ status: "ERROR" })), "");
  assert.equal(bareError.blocked, true);
  assert.equal(bareError.failureCode, "INTERNAL_ERROR");

  // The byte-faithful observed denial: SUCCESS envelope with denied_actions
  const fixture = fs.readFileSync(
    path.join(import.meta.dirname, "..", "fixtures", "agy-denial-result.json"),
    "utf-8"
  );
  const observed = adapter.interpretResult(fixture, "");
  assert.equal(observed.blocked, true, "observed denial envelope must block");
  assert.equal(observed.failureCode, undefined, "denial keeps the default POLICY_DENIED code");

  // NDJSON denial on a later envelope line is detected; stream step lines ignored
  const ndjson = [
    JSON.stringify({ event: "init", conversation_id: "conv-1" }),
    JSON.stringify({ event: "step_update", step_update: { state: "DONE" } }),
    JSON.stringify(env({ status: "SUCCESS", denied_actions: ["write /etc/hosts"] })),
  ].join("\n");
  assert.equal(adapter.interpretResult(ndjson, "").blocked, true);

  // Documented stream-json terminal line carries the envelope inside `result`
  const streamResult = [
    JSON.stringify({ event: "init", conversation_id: "conv-1" }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", denied_actions: ["x"] } }),
  ].join("\n");
  assert.equal(adapter.interpretResult(streamResult, "").blocked, true);

  // Non-denials must NOT block
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ status: "SUCCESS", response: "done" })), "").blocked,
    false,
    "valid success envelope must complete"
  );
  assert.equal(adapter.interpretResult("", "").blocked, false, "empty output must not block");
  assert.equal(
    adapter.interpretResult("just some prose output", "").blocked,
    false,
    "plain prose must not block"
  );
  assert.equal(
    adapter.interpretResult("working...", "permission denied: sandbox blocked open").blocked,
    false,
    "stderr-only 'permission denied' must not block"
  );
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ status: "in_progress" })), "").blocked,
    false,
    "unknown status must not block"
  );
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ denied_actions: [] })), "").blocked,
    false,
    "empty denied list must not block"
  );
  assert.equal(
    adapter.interpretResult(JSON.stringify(env({ status: "SUCCESS", denied_count: 0 })), "").blocked,
    false,
    "zero denied count must not block"
  );

  // Envelope/payload confusion: denial-shaped JSON WITHOUT envelope markers
  // is agent output, not an AGY verdict, and must not block.
  assert.equal(
    adapter.interpretResult(JSON.stringify({ status: "error", denied_actions: ["x"] }), "").blocked,
    false,
    "denial keys without a conversation_id must not block"
  );
  // JSON nested inside the model's response string is never parsed.
  const nested = JSON.stringify(
    env({ status: "SUCCESS", response: '{"status":"error","denied_actions":["read /etc/passwd"]}' })
  );
  assert.equal(
    adapter.interpretResult(nested, "").blocked,
    false,
    "denial JSON inside the response string must not block"
  );
});

test("AgyAdapter setupAgySettings fails closed when configuration directory cannot be created", async () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-failclose-ws-"));
  // Create an unwritable file where dataDir would be, so mkdirSync fails
  const invalidDataDir = path.join(tmpWorkspace, "blocked-file");
  fs.writeFileSync(invalidDataDir, "not a directory");

  const adapter = new AgyAdapter(
    {
      enabled: true,
      executable: "agy",
      sandbox: true,
      default_timeout_seconds: 1800,
    },
    invalidDataDir
  );

  const prevHome = process.env.HOME;
  try {
    await assert.rejects(
      () =>
        adapter.prepareStart({
          taskId: "task-fail-closed",
          repositoryRoot: tmpWorkspace,
          workspaceRoot: tmpWorkspace,
          instruction: "try run",
          mode: "implement",
          timeoutMs: 60000,
          environment: { HOME: "/custom/host/home" },
        }),
      (err: any) => {
        assert.equal(err.code, "POLICY_DENIED");
        assert.ok(err.message.includes("Failed to initialize secure isolated AGY configuration"));
        return true;
      }
    );
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});
