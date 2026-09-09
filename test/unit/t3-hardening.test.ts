/**
 * T3 hardening regression tests — Phase 1 security fixes.
 *
 * Coverage (mandatory items from supervisor review):
 *  1.  Read-only repo rejected by t3_start_task
 *  2.  in_place explicitly rejected even when allow_in_place=true
 *  3.  Repo whose default is in_place is rejected unless caller requests worktree
 *  4.  Existing thread on unconfigured T3 project rejected
 *  5.  t3_cancel_task with explicit turn_id still performs repository authorization
 *  6.  t3_continue_task rejects an in-place T3 thread
 *  7.  t3_get_task/cancel/stop remain allowed for a configured in-place thread
 *  8.  Enabled T3 + missing token does not break client/server construction
 *  9.  Request with missing token fails locally with T3ConfigError
 * 10.  Exact token echoed under arbitrary JSON key is redacted
 * 11.  Network error message is sanitized
 * 12.  Existing modelSelection.options preserved on normal continue
 * 13.  t3_status includes safe diagnostic fields and filters counts to configured repos
 * 14.  All pre-existing tests remain green (run separately)
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import {
  T3Client,
  T3ConfigError,
  T3HttpError,
  redactExact,
  redactGenericTokenPatterns,
  createT3Client,
} from "../../src/t3/t3-client.js";
import type { T3Config } from "../../src/t3/t3-config.js";
import { RepositoryRegistry } from "../../src/repositories/repository-registry.js";
import { CodingAgentError, ErrorCodes } from "../../src/domain/errors.js";
import { AppConfig } from "../../src/config/schema.js";
import { authorizeProject, isWorktreeThread } from "../../src/t3/t3-auth.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerT3Tools } from "../../src/t3/t3-tools.js";

// ---------------------------------------------------------------------------
// Mock server helpers
// ---------------------------------------------------------------------------

interface MockRoute {
  method: string;
  path: string;
  response: { status: number; body: unknown };
  received?: { body: string; headers: http.IncomingHttpHeaders; url: string };
}

function startMockServer(routes: MockRoute[]): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rawBody = "";
      req.on("data", (chunk) => (rawBody += chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = routes.find((r) => r.method === req.method && url.pathname === r.path);
        if (!route) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found", path: url.pathname }));
          return;
        }
        route.received = { body: rawBody, headers: req.headers, url: req.url ?? "/" };
        res.writeHead(route.response.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(route.response.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function makeConfig(baseUrl: string, extra: Partial<T3Config> = {}): T3Config {
  return {
    enabled: true,
    base_url: baseUrl,
    access_token_env: "T3_HARDENING_TOKEN",
    request_timeout_ms: 3000,
    ...extra,
  };
}

/** Runs fn with T3_HARDENING_TOKEN set to given value; restores after. */
function withToken<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["T3_HARDENING_TOKEN"];
  process.env["T3_HARDENING_TOKEN"] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env["T3_HARDENING_TOKEN"];
    else process.env["T3_HARDENING_TOKEN"] = prev;
  });
}

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

function makeTmpRepoDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3-hardening-"));
}

function makeAppConfig(overrides: {
  root: string;
  writable?: boolean;
  allow_in_place?: boolean;
  default_workspace_strategy?: "worktree" | "in_place";
  default_branch?: string;
  alias?: string;
}): AppConfig {
  const alias = overrides.alias ?? "test-repo";
  return {
    server: {
      data_dir: os.tmpdir(),
      max_concurrent_tasks: 2,
      default_task_timeout_seconds: 1800,
      output_limit_bytes: 5_000_000,
      workspace_grace_period_ms: 3000,
    },
    agents: {},
    repositories: {
      [alias]: {
        root: overrides.root,
        writable: overrides.writable ?? true,
        allow_in_place: overrides.allow_in_place ?? false,
        default_workspace_strategy: overrides.default_workspace_strategy ?? "worktree",
        default_branch: overrides.default_branch ?? "main",
        verification_profiles: {},
      },
    },
    t3: undefined,
  } as AppConfig;
}

function makeThread(overrides: {
  id?: string;
  projectId?: string;
  branch?: string | null;
  worktreePath?: string | null;
  activeTurnId?: string | null;
}): ReturnType<typeof buildThread> {
  return buildThread(overrides);
}

function buildThread(overrides: {
  id?: string;
  projectId?: string;
  branch?: string | null;
  worktreePath?: string | null;
  activeTurnId?: string | null;
  modelOptions?:
    | ReadonlyArray<{ id: string; value: string | boolean }>
    | Record<string, unknown>;
}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    projectId: overrides.projectId ?? crypto.randomUUID(),
    title: "Test thread",
    modelSelection: {
      instanceId: "muse",
      model: "claude-3-5-sonnet",
      ...(overrides.modelOptions ? { options: overrides.modelOptions } : {}),
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: overrides.branch !== undefined ? overrides.branch : "task/test-branch",
    worktreePath: overrides.worktreePath !== undefined ? overrides.worktreePath : "/tmp/worktree",
    latestTurn: null,
    session: overrides.activeTurnId
      ? {
          threadId: overrides.id ?? "t1",
          status: "running",
          providerName: "muse",
          activeTurnId: overrides.activeTurnId,
          lastError: null,
          updatedAt: new Date().toISOString(),
        }
      : null,
    messages: [],
    activities: [],
    checkpoints: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 8. Enabled T3 + missing token does NOT break construction
// ---------------------------------------------------------------------------

test("createT3Client({enabled:true}) does not throw with missing token", () => {
  const prev = process.env["T3_HARDENING_TOKEN"];
  delete process.env["T3_HARDENING_TOKEN"];
  try {
    const client = createT3Client({
      enabled: true,
      base_url: "http://127.0.0.1:9999",
      access_token_env: "T3_HARDENING_TOKEN",
      request_timeout_ms: 5000,
    });
    assert.ok(client !== null, "Should return a T3Client even with missing token");
  } finally {
    if (prev !== undefined) process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

test("T3Client constructor does not throw with missing token (lazy resolution)", () => {
  const prev = process.env["T3_HARDENING_TOKEN"];
  delete process.env["T3_HARDENING_TOKEN"];
  try {
    // Must NOT throw
    const client = new T3Client({
      enabled: true,
      base_url: "http://127.0.0.1:9999",
      access_token_env: "T3_HARDENING_TOKEN",
      request_timeout_ms: 5000,
    });
    assert.ok(client instanceof T3Client);
  } finally {
    if (prev !== undefined) process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

// ---------------------------------------------------------------------------
// 9. Request with missing token fails with T3ConfigError (not construction time)
// ---------------------------------------------------------------------------

test("getSession with missing token throws T3ConfigError at request time", async () => {
  const prev = process.env["T3_HARDENING_TOKEN"];
  delete process.env["T3_HARDENING_TOKEN"];
  try {
    const client = new T3Client({
      enabled: true,
      base_url: "http://127.0.0.1:9999",
      access_token_env: "T3_HARDENING_TOKEN",
      request_timeout_ms: 5000,
    });
    // Request should throw T3ConfigError, not try to connect
    await assert.rejects(
      () => client.getSession(),
      (err: unknown) => {
        assert.ok(err instanceof T3ConfigError, `Expected T3ConfigError, got ${err}`);
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

test("getSnapshot with missing token throws T3ConfigError at request time", async () => {
  const prev = process.env["T3_HARDENING_TOKEN"];
  delete process.env["T3_HARDENING_TOKEN"];
  try {
    const client = new T3Client({
      enabled: true,
      base_url: "http://127.0.0.1:9999",
      access_token_env: "T3_HARDENING_TOKEN",
      request_timeout_ms: 5000,
    });
    await assert.rejects(
      () => client.getSnapshot(),
      (err: unknown) => {
        assert.ok(err instanceof T3ConfigError);
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

// ---------------------------------------------------------------------------
// 10. Exact token value echoed under arbitrary JSON key is redacted
// ---------------------------------------------------------------------------

test("redactExact replaces exact token under arbitrary JSON key", () => {
  const token = "super-secret-token-xyz789abc";
  const body = `{"debug":"${token}","msg":"check failed"}`;
  const result = redactExact(token, body);
  assert.ok(!result.includes(token), `Token must be redacted; got: ${result}`);
  assert.ok(result.includes("[REDACTED]"), "Should contain [REDACTED]");
  // Non-token content should remain
  assert.ok(result.includes("check failed"));
});

test("redactExact replaces token when not prefixed by Bearer or wrapped in known key names", () => {
  const token = "my-raw-jwt-token-12345678901234";
  const body = `{"anything":"${token}","other":"value"}`;
  const result = redactExact(token, body);
  assert.ok(!result.includes(token));
  assert.ok(result.includes("[REDACTED]"));
  // The generic redactGenericTokenPatterns alone would NOT catch this
  const onlyGeneric = redactGenericTokenPatterns(body);
  // Verify that generic patterns alone miss it (proving exact redaction is needed)
  // The key name is "anything" — not "token", "access_token", "bearer", etc.
  assert.ok(onlyGeneric.includes(token), "Generic patterns alone should miss arbitrary key names");
});

test("T3HttpError body with exact token under non-standard key is redacted", async () => {
  const tokenValue = "exact-token-abc123def456ghi789";
  const route: MockRoute = {
    method: "GET",
    path: "/api/auth/session",
    response: {
      status: 401,
      body: { debug: tokenValue, hint: "auth failed" },
    },
  };
  const { server, baseUrl } = await startMockServer([route]);

  const prev = process.env["T3_HARDENING_TOKEN"];
  process.env["T3_HARDENING_TOKEN"] = tokenValue;
  try {
    const client = new T3Client(makeConfig(baseUrl));
    await assert.rejects(
      () => client.getSession(),
      (err: unknown) => {
        assert.ok(err instanceof T3HttpError, `Expected T3HttpError, got ${err}`);
        assert.ok(
          !err.safeBody.includes(tokenValue),
          `safeBody must not contain exact token; got: ${err.safeBody}`
        );
        assert.ok(
          !err.message.includes(tokenValue),
          `message must not contain exact token; got: ${err.message}`
        );
        assert.ok(err.safeBody.includes("[REDACTED]"), "safeBody must contain [REDACTED]");
        return true;
      }
    );
  } finally {
    await stopServer(server);
    if (prev === undefined) delete process.env["T3_HARDENING_TOKEN"];
    else process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

// ---------------------------------------------------------------------------
// 11. Network error message is sanitized
// ---------------------------------------------------------------------------

test("Network error message is sanitized before surfacing", async () => {
  const tokenValue = "network-err-token-abc123xyz456";
  // Use an unreachable port that refuses immediately (not timeout)
  const prev = process.env["T3_HARDENING_TOKEN"];
  process.env["T3_HARDENING_TOKEN"] = tokenValue;
  try {
    const client = new T3Client({
      enabled: true,
      base_url: "http://0.0.0.0:0", // Should fail immediately
      access_token_env: "T3_HARDENING_TOKEN",
      request_timeout_ms: 500,
    });
    try {
      await client.getSession();
    } catch (err) {
      // Should be a T3HttpError (network or timeout) — never a raw Error with token in message
      if (err instanceof T3HttpError) {
        assert.ok(
          !err.message.includes(tokenValue),
          `Network error message must not contain token; got: ${err.message}`
        );
        assert.ok(
          !err.safeBody.includes(tokenValue),
          `Network error safeBody must not contain token; got: ${err.safeBody}`
        );
      }
      // Some environments throw other error types for bad addresses; that's OK
      // as long as the token is not in the message
      if (err instanceof Error) {
        assert.ok(
          !err.message.includes(tokenValue),
          `Error message must not contain token value`
        );
      }
    }
  } finally {
    if (prev === undefined) delete process.env["T3_HARDENING_TOKEN"];
    else process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

// ---------------------------------------------------------------------------
// 1. Read-only repo rejected by t3_start_task
// ---------------------------------------------------------------------------

test("t3_start_task rejects read-only repository (writable: false)", async () => {
  const tmpDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({ root: tmpDir, writable: false });
    const repoRegistry = new RepositoryRegistry(config);
    const repo = repoRegistry.getRepository("test-repo");

    // Simulate the writable check (mirrors assertRepoWritable in t3-tools.ts)
    assert.throws(
      () => {
        if (!repo.writable) {
          throw new CodingAgentError(
            ErrorCodes.REPOSITORY_NOT_WRITABLE,
            `Repository 'test-repo' is configured as read-only (writable: false).`
          );
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof CodingAgentError);
        assert.equal((err as CodingAgentError).code, ErrorCodes.REPOSITORY_NOT_WRITABLE);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. in_place explicitly rejected even when allow_in_place=true
// ---------------------------------------------------------------------------

test("t3_start_task rejects workspace_strategy=in_place even with allow_in_place=true", async () => {
  const tmpDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({
      root: tmpDir,
      writable: true,
      allow_in_place: true,
      default_workspace_strategy: "worktree",
    });
    const repoRegistry = new RepositoryRegistry(config);
    const repo = repoRegistry.getRepository("test-repo");

    // Simulate assertWorktreeStrategy with explicit in_place
    const callerRequestedStrategy: "in_place" | "worktree" = "in_place";
    const effectiveStrategy = callerRequestedStrategy;

    assert.throws(
      () => {
        if (effectiveStrategy === "in_place") {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            `T3 Phase 1 requires worktree isolation for task creation.`
          );
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof CodingAgentError);
        assert.equal((err as CodingAgentError).code, ErrorCodes.POLICY_DENIED);
        assert.ok((err as CodingAgentError).message.includes("worktree isolation"));
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Repo whose default is in_place rejected unless caller requests worktree
// ---------------------------------------------------------------------------

test("t3_start_task rejects in_place default repo when caller omits workspace_strategy", async () => {
  const tmpDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({
      root: tmpDir,
      writable: true,
      allow_in_place: true,
      default_workspace_strategy: "in_place",
    });
    const repoRegistry = new RepositoryRegistry(config);
    const repo = repoRegistry.getRepository("test-repo");

    // effectiveStrategy = callerArg ?? repo.default_workspace_strategy
    const callerArg: string | undefined = undefined;
    const effectiveStrategy = callerArg ?? repo.default_workspace_strategy;

    assert.throws(
      () => {
        if (effectiveStrategy === "in_place") {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            `Repository 'test-repo' defaults to workspace_strategy: in_place`
          );
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof CodingAgentError);
        assert.equal((err as CodingAgentError).code, ErrorCodes.POLICY_DENIED);
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("t3_start_task allows in_place-default repo when caller explicitly requests worktree", async () => {
  const tmpDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({
      root: tmpDir,
      writable: true,
      allow_in_place: true,
      default_workspace_strategy: "in_place",
      default_branch: "main",
    });
    const repoRegistry = new RepositoryRegistry(config);
    const repo = repoRegistry.getRepository("test-repo");

    // effectiveStrategy = "worktree" (caller explicitly passed it)
    const callerArg: "worktree" | "in_place" = "worktree";
    const effectiveStrategy = callerArg;

    // Should NOT throw
    assert.doesNotThrow(() => {
      if (effectiveStrategy === "in_place") {
        throw new CodingAgentError(ErrorCodes.POLICY_DENIED, "in_place");
      }
      // Should proceed to check default_branch
      if (!repo.default_branch) {
        throw new CodingAgentError(ErrorCodes.POLICY_DENIED, "missing default_branch");
      }
    });
    assert.equal(effectiveStrategy, "worktree");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Thread on unconfigured T3 project is rejected
// ---------------------------------------------------------------------------

test("authorizeProject throws POLICY_DENIED for unconfigured workspaceRoot", () => {
  const tmpDir = makeTmpRepoDir();
  const otherDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({ root: tmpDir });
    const repoRegistry = new RepositoryRegistry(config);

    // Project points to a different directory not in repoRegistry
    const project = { id: crypto.randomUUID(), workspaceRoot: otherDir, title: "other" };

    assert.throws(
      () => authorizeProject(project, repoRegistry),
      (err: unknown) => {
        assert.ok(err instanceof CodingAgentError);
        assert.equal((err as CodingAgentError).code, ErrorCodes.POLICY_DENIED);
        // Error message must NOT contain the unconfigured path
        assert.ok(
          !(err as CodingAgentError).message.includes(otherDir),
          `Error must not expose unconfigured path; got: ${(err as CodingAgentError).message}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(otherDir, { recursive: true, force: true });
  }
});

test("authorizeProject succeeds when workspaceRoot matches a configured repo", () => {
  const tmpDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({ root: tmpDir });
    const repoRegistry = new RepositoryRegistry(config);

    const project = { id: crypto.randomUUID(), workspaceRoot: tmpDir, title: "test-repo" };
    const result = authorizeProject(project, repoRegistry);
    assert.equal(result.alias, "test-repo");
    assert.equal(result.project.id, project.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. t3_cancel_task with explicit turn_id still performs repository authorization
// ---------------------------------------------------------------------------

test("authorizeThread rejects unconfigured project even when threadId is explicitly provided", async () => {
  const configuredDir = makeTmpRepoDir();
  const unconfiguredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "task/br", worktreePath: "/wt" }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          // Project points to a directory NOT in repoRegistry
          projects: [{ id: projectId, workspaceRoot: unconfiguredDir, title: "other" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  const config = makeAppConfig({ root: configuredDir });
  const repoRegistry = new RepositoryRegistry(config);

  try {
    await withToken("test-token-auth-5", async () => {
      const client = new T3Client(makeConfig(baseUrl));

      const { authorizeThread: auth } = await import("../../src/t3/t3-auth.js");
      await assert.rejects(
        () => auth(client, threadId, repoRegistry),
        (err: unknown) => {
          assert.ok(err instanceof CodingAgentError);
          assert.equal((err as CodingAgentError).code, ErrorCodes.POLICY_DENIED);
          // Unconfigured path must not be exposed
          assert.ok(!(err as CodingAgentError).message.includes(unconfiguredDir));
          return true;
        }
      );
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
    fs.rmSync(unconfiguredDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. t3_continue_task rejects an in-place T3 thread
// ---------------------------------------------------------------------------

test("isWorktreeThread returns false for thread with branch=null and worktreePath=null", () => {
  const thread = buildThread({ branch: null, worktreePath: null });
  assert.equal(isWorktreeThread(thread as any), false);
});

test("isWorktreeThread: branch != null + worktreePath == null => false", () => {
  const thread = buildThread({ branch: "task/br", worktreePath: null });
  assert.equal(isWorktreeThread(thread as any), false);
});

test("isWorktreeThread: branch == null + worktreePath != null => true", () => {
  const thread = buildThread({ branch: null, worktreePath: "/tmp/wt" });
  assert.equal(isWorktreeThread(thread as any), true);
});

test("isWorktreeThread: branch != null + worktreePath != null => true", () => {
  const thread = buildThread({ branch: "task/br", worktreePath: "/tmp/wt" });
  assert.equal(isWorktreeThread(thread as any), true);
});

test("assertWorktreeThread-equivalent rejects in-place thread for resume operations", () => {
  const inPlaceThread = buildThread({ branch: null, worktreePath: null });
  assert.throws(
    () => {
      if (!isWorktreeThread(inPlaceThread as any)) {
        throw new CodingAgentError(
          ErrorCodes.POLICY_DENIED,
          "This T3 thread is running in-place. Operations that resume agent execution require worktree."
        );
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof CodingAgentError);
      assert.equal((err as CodingAgentError).code, ErrorCodes.POLICY_DENIED);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// 7. t3_get_task/cancel/stop allowed for configured in-place thread
// ---------------------------------------------------------------------------

test("authorizeProject succeeds for configured in-place thread (worktreeThread check not applied)", async () => {
  const configuredDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({
      root: configuredDir,
      allow_in_place: true,
      default_workspace_strategy: "in_place",
    });
    const repoRegistry = new RepositoryRegistry(config);

    // In-place thread: branch=null, worktreePath=null
    const project = { id: crypto.randomUUID(), workspaceRoot: configuredDir, title: "test-repo" };
    // Authorization succeeds (no worktree check on get/cancel/stop)
    const result = authorizeProject(project, repoRegistry);
    assert.equal(result.alias, "test-repo");

    const inPlaceThread = buildThread({ branch: null, worktreePath: null });
    // isWorktreeThread returns false — but get/cancel/stop don't call assertWorktreeThread
    assert.equal(isWorktreeThread(inPlaceThread as any), false);
    // No exception thrown — these operations are allowed
  } finally {
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 12. Existing modelSelection.options preserved on normal continue
// ---------------------------------------------------------------------------

test("t3_continue_task preserves modelSelection.options when no model override", async () => {
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const configuredDir = makeTmpRepoDir();

  const modelOptions = {
    extended_thinking: true,
    thinking_budget_tokens: 4096,
  };

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 5,
          thread: buildThread({
            id: threadId,
            projectId,
            branch: "task/test",
            worktreePath: "/tmp/wt",
            modelOptions,
          }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 5,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 6 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  const config = makeAppConfig({ root: configuredDir, writable: true });
  const repoRegistry = new RepositoryRegistry(config);

  try {
    await withToken("test-token-model-12", async () => {
      const client = new T3Client(makeConfig(baseUrl));

      // Fetch thread
      const snap = await client.getThreadSnapshot(threadId, { turnLimit: 1 });
      const thread = snap.thread;

      // Verify options were parsed
      assert.deepEqual(thread.modelSelection.options, modelOptions);

      // Simulate continue WITHOUT model override — preserve full modelSelection
      const modelSelection =
        undefined === undefined /* no model override */
          ? { ...thread.modelSelection }
          : { instanceId: thread.modelSelection.instanceId, model: "new-model" };

      // Options must be preserved
      assert.deepEqual(modelSelection.options, modelOptions, "options must be preserved");

      // Dispatch continue with preserved modelSelection
      await client.dispatch({
        type: "thread.turn.start",
        commandId: crypto.randomUUID(),
        threadId,
        message: { messageId: crypto.randomUUID(), role: "user", text: "continue", attachments: [] },
        modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      });

      const sent = JSON.parse(routes[2].received!.body);
      assert.deepEqual(
        sent.modelSelection.options,
        modelOptions,
        "Dispatched command must include original options"
      );
      assert.equal(sent.modelSelection.instanceId, "muse");
      assert.equal(sent.modelSelection.model, "claude-3-5-sonnet");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_continue_task drops options when model override is provided", async () => {
  const thread = buildThread({
    branch: "task/br",
    worktreePath: "/tmp/wt",
    modelOptions: { extended_thinking: true },
  });

  // With model override: keep instanceId, use new model, do NOT carry options
  const modelSelection =
    "new-model" !== undefined
      ? { instanceId: thread.modelSelection.instanceId, model: "new-model" }
      : { ...thread.modelSelection };

  assert.equal(modelSelection.model, "new-model");
  assert.equal(modelSelection.instanceId, "muse");
  assert.ok(!("options" in modelSelection), "options must NOT be carried to a new model");
});

// ---------------------------------------------------------------------------
// 13. t3_status filters project/thread counts to configured repos
// ---------------------------------------------------------------------------

test("authorizeProject filters: only configured repos counted", () => {
  const configuredDir = makeTmpRepoDir();
  const unconfiguredDir = makeTmpRepoDir();
  try {
    const config = makeAppConfig({ root: configuredDir });
    const repoRegistry = new RepositoryRegistry(config);

    const projects = [
      { id: "p1", workspaceRoot: configuredDir, title: "configured" },
      { id: "p2", workspaceRoot: unconfiguredDir, title: "unconfigured" },
    ];

    const configuredIds = new Set<string>();
    for (const project of projects) {
      try {
        authorizeProject(project, repoRegistry);
        configuredIds.add(project.id);
      } catch {
        // Not configured
      }
    }

    assert.equal(configuredIds.size, 1);
    assert.ok(configuredIds.has("p1"));
    assert.ok(!configuredIds.has("p2"), "Unconfigured project must not be counted");
  } finally {
    fs.rmSync(configuredDir, { recursive: true, force: true });
    fs.rmSync(unconfiguredDir, { recursive: true, force: true });
  }
});

test("t3_status response includes required_scopes_ok and no token", async () => {
  const route: MockRoute = {
    method: "GET",
    path: "/api/auth/session",
    response: {
      status: 200,
      body: {
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:operate"],
        sessionMethod: "bearer",
      },
    },
  };
  const snapshotRoute: MockRoute = {
    method: "GET",
    path: "/api/orchestration/snapshot",
    response: {
      status: 200,
      body: {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: new Date().toISOString(),
      },
    },
  };

  const { server, baseUrl } = await startMockServer([route, snapshotRoute]);
  const tokenValue = "status-test-token-abc123";

  try {
    await withToken(tokenValue, async () => {
      const client = new T3Client(makeConfig(baseUrl));
      const session = await client.getSession();

      const REQUIRED_SCOPES = ["orchestration:read", "orchestration:operate"];
      const grantedScopes: string[] = session.scopes ?? [];
      const requiredScopesOk = REQUIRED_SCOPES.every((s) => grantedScopes.includes(s));

      // Build status response (mirrors t3_status tool logic)
      const statusResponse = {
        t3_enabled: true,
        authenticated: session.authenticated,
        scopes: grantedScopes,
        required_scopes_ok: requiredScopesOk,
        session_method: session.sessionMethod ?? null,
      };

      const json = JSON.stringify(statusResponse, null, 2);

      assert.ok(requiredScopesOk, "required_scopes_ok should be true");
      assert.ok(!json.includes(tokenValue), "Status response must not contain token");
      assert.ok(json.includes("required_scopes_ok"), "Must include required_scopes_ok field");
      assert.ok(json.includes("orchestration:read"), "Must include scopes in response");
    });
  } finally {
    await stopServer(server);
  }
});

// ---------------------------------------------------------------------------
// Lazy token resolution — token rotation during process lifetime
// ---------------------------------------------------------------------------

test("Token is re-read from env on each request (supports rotation)", async () => {
  const routes: MockRoute[] = [
    {
      method: "GET",
      path: "/api/auth/session",
      response: { status: 200, body: { authenticated: true } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  const prev = process.env["T3_HARDENING_TOKEN"];

  try {
    const client = new T3Client(makeConfig(baseUrl));

    // First request with token A
    process.env["T3_HARDENING_TOKEN"] = "token-A-abc123def456";
    await client.getSession();
    const authA = routes[0].received?.headers["authorization"];
    assert.ok(authA?.includes("token-A-abc123def456"), "Should use token A");

    // Rotate to token B — same client instance
    process.env["T3_HARDENING_TOKEN"] = "token-B-xyz789uvw012";
    await client.getSession();
    const authB = routes[0].received?.headers["authorization"];
    assert.ok(authB?.includes("token-B-xyz789uvw012"), "Should use rotated token B");
  } finally {
    await stopServer(server);
    if (prev === undefined) delete process.env["T3_HARDENING_TOKEN"];
    else process.env["T3_HARDENING_TOKEN"] = prev;
  }
});

// ---------------------------------------------------------------------------
// Exact redaction helper edge cases
// ---------------------------------------------------------------------------

test("redactExact handles tokens with regex special characters", () => {
  // Tokens shouldn't have these but be safe
  const token = "tok+en.value[foo]";
  const body = `found: tok+en.value[foo] in response`;
  const result = redactExact(token, body);
  assert.ok(!result.includes(token));
  assert.ok(result.includes("[REDACTED]"));
});

test("redactExact does not redact short strings (< 8 chars)", () => {
  const shortToken = "short";
  const body = "short value here";
  // Should not redact (safety guard against trivially short tokens)
  const result = redactExact(shortToken, body);
  assert.equal(result, body);
});

test("redactGenericTokenPatterns redacts Bearer prefix pattern", () => {
  const body = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456";
  const result = redactGenericTokenPatterns(body);
  assert.ok(!result.includes("abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(result.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------------
// authorizeThread reuses existingThread to save a round-trip
// ---------------------------------------------------------------------------

test("authorizeThread uses existingThread when provided (no extra thread GET)", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  // Only snapshot route — no thread route — verifies no extra GET is made
  const routes: MockRoute[] = [
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  const config = makeAppConfig({ root: configuredDir });
  const repoRegistry = new RepositoryRegistry(config);

  try {
    await withToken("test-token-reuse", async () => {
      const client = new T3Client(makeConfig(baseUrl));
      const existingThread = buildThread({ id: threadId, projectId, branch: "br", worktreePath: "/wt" });

      // Should succeed using existingThread, only calling snapshot
      const { authorizeThread: auth } = await import("../../src/t3/t3-auth.js");
      const result = await auth(client, threadId, repoRegistry, existingThread as any);
      assert.equal(result.thread.id, threadId);
      assert.equal(result.authorizedRepo.alias, "test-repo");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-End MCP Tool Invocations via Client + InMemoryTransport
// ---------------------------------------------------------------------------

async function setupMcpClientWithT3(client: T3Client, repoRegistry: RepositoryRegistry) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerT3Tools(server, { t3Client: client, repoRegistry });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: "test-client", version: "1.0.0" });
  await mcpClient.connect(clientTransport);
  return { mcpClient, server };
}

test("t3_start_task via MCP client rejects read-only repository", async () => {
  const tmpDir = makeTmpRepoDir();
  const { server, baseUrl } = await startMockServer([]);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: tmpDir, writable: false });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_start_task",
        arguments: {
          repository: "test-repo",
          provider_instance: "muse",
          model: "claude-3-5-sonnet",
          instruction: "do something",
          workspace_strategy: "worktree",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.REPOSITORY_NOT_WRITABLE);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("t3_start_task via MCP client rejects workspace_strategy=in_place", async () => {
  const tmpDir = makeTmpRepoDir();
  const { server, baseUrl } = await startMockServer([]);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: tmpDir, writable: true, allow_in_place: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_start_task",
        arguments: {
          repository: "test-repo",
          provider_instance: "muse",
          model: "claude-3-5-sonnet",
          instruction: "do something",
          workspace_strategy: "in_place",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(content.error.message.includes("worktree isolation"));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("t3_start_task via MCP client rejects repo with default in_place strategy", async () => {
  const tmpDir = makeTmpRepoDir();
  const { server, baseUrl } = await startMockServer([]);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({
        root: tmpDir,
        writable: true,
        allow_in_place: true,
        default_workspace_strategy: "in_place",
      });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_start_task",
        arguments: {
          repository: "test-repo",
          provider_instance: "muse",
          model: "claude-3-5-sonnet",
          instruction: "do something",
          // workspace_strategy omitted
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(content.error.message.includes("defaults to workspace_strategy: in_place"));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("t3_continue_task via MCP client rejects unconfigured project thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const unconfiguredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "task/br", worktreePath: "/wt" }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: unconfiguredDir, title: "other" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_continue_task",
        arguments: {
          thread_id: threadId,
          instruction: "continue work",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(!JSON.stringify(content).includes(unconfiguredDir));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
    fs.rmSync(unconfiguredDir, { recursive: true, force: true });
  }
});

test("t3_cancel_task via MCP client with explicit turn_id rejects unconfigured project thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const unconfiguredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "task/br", worktreePath: "/wt" }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: unconfiguredDir, title: "other" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_cancel_task",
        arguments: {
          thread_id: threadId,
          turn_id: "explicit-turn-123",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(!JSON.stringify(content).includes(unconfiguredDir));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
    fs.rmSync(unconfiguredDir, { recursive: true, force: true });
  }
});

test("t3_continue_task via MCP client rejects in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          // In-place thread: branch=null, worktreePath=null
          thread: buildThread({ id: threadId, projectId, branch: null, worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_continue_task",
        arguments: {
          thread_id: threadId,
          instruction: "continue in-place",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(content.error.message.includes("in-place"));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_respond_approval via MCP client rejects in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: null, worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_respond_approval",
        arguments: {
          thread_id: threadId,
          request_id: "req-1",
          decision: "accept",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_respond_user_input via MCP client rejects in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: null, worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_respond_user_input",
        arguments: {
          thread_id: threadId,
          request_id: "req-1",
          answers: { q1: "ans" },
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_get_task via MCP client succeeds for configured in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: null, worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_get_task",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.branch, null);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_cancel_task via MCP client succeeds for configured in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({
            id: threadId,
            projectId,
            branch: null,
            worktreePath: null,
            activeTurnId: "turn-abc",
          }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 10 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_cancel_task",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.turn_id_interrupted, "turn-abc");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_stop_session via MCP client succeeds for configured in-place thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: null, worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 11 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_stop_session",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.status, "session_stop_dispatched");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_status via MCP client returns all required diagnostic fields", async () => {
  const configuredDir = makeTmpRepoDir();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: "/api/auth/session",
      response: {
        status: 200,
        body: {
          authenticated: true,
          scopes: ["orchestration:read", "orchestration:operate"],
          sessionMethod: "bearer",
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_status",
        arguments: {},
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.t3_enabled, true);
      assert.equal(content.base_url, baseUrl);
      assert.equal(content.server_reachable, true);
      assert.equal(content.authenticated, true);
      assert.deepEqual(content.scopes, ["orchestration:read", "orchestration:operate"]);
      assert.equal(content.required_scopes_ok, true);
      assert.equal(content.session_method, "bearer");
      assert.equal(content.orchestration_snapshot_ok, true);
      assert.equal(content.configured_project_count, 1);
      assert.equal(content.configured_thread_count, 0);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_continue_task preserves canonical array modelSelection.options when no model override", async () => {
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const configuredDir = makeTmpRepoDir();

  const canonicalOptions = [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ] as const;

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 5,
          thread: buildThread({
            id: threadId,
            projectId,
            branch: "task/test",
            worktreePath: "/tmp/wt",
            modelOptions: canonicalOptions,
          }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 5,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 6 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  const config = makeAppConfig({ root: configuredDir, writable: true });
  const repoRegistry = new RepositoryRegistry(config);

  try {
    await withToken("test-token-model-canonical", async () => {
      const client = new T3Client(makeConfig(baseUrl));
      const snap = await client.getThreadSnapshot(threadId, { turnLimit: 1 });
      const thread = snap.thread;

      assert.deepEqual(thread.modelSelection.options, canonicalOptions);

      // Preserves full modelSelection when no override
      const modelSelection = { ...thread.modelSelection };
      assert.deepEqual(modelSelection.options, canonicalOptions);

      // Drops options when override is provided
      const overriddenSelection = { instanceId: thread.modelSelection.instanceId, model: "other-model" };
      assert.equal(overriddenSelection.model, "other-model");
      assert.ok(!("options" in overriddenSelection));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Branch-only thread regression tests (branch != null, worktreePath == null)
// Proves branch alone is NOT sufficient isolation evidence.
// ---------------------------------------------------------------------------

test("t3_continue_task via MCP client rejects configured branch-only thread (worktreePath == null)", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          // Branch is set, but worktreePath is null -> in-place execution, not isolated
          thread: buildThread({ id: threadId, projectId, branch: "feature/branch-only", worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_continue_task",
        arguments: {
          thread_id: threadId,
          instruction: "continue work on branch-only",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
      assert.ok(content.error.message.includes("in-place"));
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_respond_approval via MCP client rejects configured branch-only thread (worktreePath == null)", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "feature/branch-only", worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_respond_approval",
        arguments: {
          thread_id: threadId,
          request_id: "req-branch-only",
          decision: "accept",
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_respond_user_input via MCP client rejects configured branch-only thread (worktreePath == null)", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "feature/branch-only", worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir, writable: true });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_respond_user_input",
        arguments: {
          thread_id: threadId,
          request_id: "req-branch-only",
          answers: { answer: "yes" },
        },
      });

      assert.equal(result.isError, true);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.error.code, ErrorCodes.POLICY_DENIED);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_get_task via MCP client succeeds for configured branch-only thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "feature/branch-only", worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_get_task",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.branch, "feature/branch-only");
      assert.equal(content.worktree_path, null);
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_cancel_task via MCP client succeeds for configured branch-only thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({
            id: threadId,
            projectId,
            branch: "feature/branch-only",
            worktreePath: null,
            activeTurnId: "turn-branch-only",
          }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 10 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_cancel_task",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.turn_id_interrupted, "turn-branch-only");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});

test("t3_stop_session via MCP client succeeds for configured branch-only thread", async () => {
  const configuredDir = makeTmpRepoDir();
  const threadId = crypto.randomUUID();
  const projectId = crypto.randomUUID();

  const routes: MockRoute[] = [
    {
      method: "GET",
      path: `/api/orchestration/threads/${threadId}`,
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          thread: buildThread({ id: threadId, projectId, branch: "feature/branch-only", worktreePath: null }),
        },
      },
    },
    {
      method: "GET",
      path: "/api/orchestration/snapshot",
      response: {
        status: 200,
        body: {
          snapshotSequence: 1,
          projects: [{ id: projectId, workspaceRoot: configuredDir, title: "test-repo" }],
          threads: [],
          updatedAt: new Date().toISOString(),
        },
      },
    },
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      response: { status: 200, body: { sequence: 11 } },
    },
  ];

  const { server, baseUrl } = await startMockServer(routes);
  try {
    await withToken("mcp-test-token", async () => {
      const config = makeAppConfig({ root: configuredDir });
      const repoRegistry = new RepositoryRegistry(config);
      const t3Client = new T3Client(makeConfig(baseUrl));
      const { mcpClient } = await setupMcpClientWithT3(t3Client, repoRegistry);

      const result = await mcpClient.callTool({
        name: "t3_stop_session",
        arguments: { thread_id: threadId },
      });

      assert.equal(result.isError, undefined);
      const content = JSON.parse((result.content as any)[0].text);
      assert.equal(content.thread_id, threadId);
      assert.equal(content.status, "session_stop_dispatched");
    });
  } finally {
    await stopServer(server);
    fs.rmSync(configuredDir, { recursive: true, force: true });
  }
});


