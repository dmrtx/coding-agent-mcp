/**
 * T3Client — lightweight HTTP client for the T3 Environment API (Phase 1).
 *
 * Security contracts:
 * - Bearer token is NEVER logged, serialized, or included in thrown error messages.
 * - Token is resolved LAZILY on each request from process.env[access_token_env].
 *   This means a missing token does NOT prevent client construction or MCP server
 *   startup — it only fails the individual request.
 * - All request timeouts are enforced via AbortController.
 * - Non-2xx responses are surfaced with HTTP status and a bounded (≤ 2 KB) body
 *   excerpt, with the exact token value and generic bearer patterns both redacted.
 * - Network/fetch error messages are also sanitized before re-throwing.
 */

import { T3Config } from "./t3-config.js";

// --------------------------------------------------------------------------
// Types matching T3 wire shapes (no runtime lib dependency; plain TS).
// Kept minimal — only fields we actually consume in Phase 1.
// --------------------------------------------------------------------------

/** T3 ModelSelection — includes optional per-instance options matching canonical T3 wire shape. */
export interface T3ModelSelection {
  instanceId: string;
  model: string;
  /** Provider-specific option overrides matching canonical T3 wire shape. */
  options?:
    | ReadonlyArray<{
        id: string;
        value: string | boolean;
      }>
    | Record<string, unknown>;
  [key: string]: unknown;
}

export interface T3SnapshotProject {
  id: string;
  workspaceRoot: string;
  title: string;
  [key: string]: unknown;
}

export interface T3Snapshot {
  snapshotSequence: number;
  projects: T3SnapshotProject[];
  threads: T3SnapshotThread[];
  updatedAt: string;
}

export interface T3SnapshotThread {
  id: string;
  projectId: string;
  title: string;
  modelSelection: T3ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: T3LatestTurn | null;
  session: T3Session | null;
  messages: unknown[];
  activities: unknown[];
  checkpoints: unknown[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface T3LatestTurn {
  turnId: string;
  state: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
  [key: string]: unknown;
}

export interface T3Session {
  threadId: string;
  status: string;
  providerName: string | null;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
  [key: string]: unknown;
}

export interface T3ThreadDetailSnapshot {
  snapshotSequence: number;
  thread: T3SnapshotThread;
  page?: {
    beforeCursor: string | null;
    hasMore: boolean;
    snapshotSequence: number;
  };
}

export interface T3DispatchResult {
  sequence: number;
}

export type T3DispatchCommand = Record<string, unknown>;

export interface T3AuthSessionState {
  authenticated: boolean;
  scopes?: string[];
  sessionMethod?: string;
  expiresAt?: unknown;
  auth?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Error classes
// --------------------------------------------------------------------------

export class T3HttpError extends Error {
  public readonly status: number;
  public readonly safeBody: string;

  constructor(status: number, safeBody: string, context: string) {
    // safeBody is already redacted before this constructor is called.
    super(`T3 HTTP ${status} on ${context}: ${safeBody}`);
    this.name = "T3HttpError";
    this.status = status;
    this.safeBody = safeBody;
    Object.setPrototypeOf(this, T3HttpError.prototype);
  }
}

export class T3ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "T3ConfigError";
    Object.setPrototypeOf(this, T3ConfigError.prototype);
  }
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

const SAFE_BODY_LIMIT = 2048;

export class T3Client {
  private readonly baseUrl: string;
  private readonly tokenEnvVar: string;
  private readonly timeoutMs: number;

  /**
   * Constructs a T3Client.
   *
   * Token resolution is LAZY — we do NOT read process.env here.
   * This means a missing/expired token does not prevent MCP server startup;
   * the error surfaces only when a request is made.
   */
  constructor(config: T3Config) {
    if (!config.enabled) {
      throw new T3ConfigError("T3 integration is disabled (t3.enabled is false)");
    }
    // Strip trailing slash from base_url
    this.baseUrl = config.base_url.replace(/\/+$/, "");
    // Store the env var name, NOT the value
    this.tokenEnvVar = config.access_token_env;
    this.timeoutMs = config.request_timeout_ms;
  }

  /** Returns the normalized base URL (without trailing slash). */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Resolves the bearer token from process.env at request time.
   * Throws T3ConfigError (never exposes the value) if missing.
   */
  private resolveToken(): string {
    const tokenValue = process.env[this.tokenEnvVar];
    if (!tokenValue || tokenValue.trim() === "") {
      throw new T3ConfigError(
        `T3 access token is missing. ` +
          `Set the environment variable '${this.tokenEnvVar}' before making T3 requests. ` +
          `The token value must never be placed in config files.`
      );
    }
    return tokenValue;
  }

  /**
   * Performs an HTTP request with timeout enforcement and token redaction.
   * The resolved token is NEVER logged or included in any thrown error.
   */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    // Resolve token lazily — throws T3ConfigError if missing
    const token = this.resolveToken();

    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), this.timeoutMs);

    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url = `${url}?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (method === "POST" && options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timerId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new T3HttpError(0, "Request timed out", path);
      }
      // Sanitize network error messages — they may echo the URL which could
      // theoretically contain credential material (though we never put it there).
      const safeMsg = err instanceof Error
        ? redactExact(token, redactGenericTokenPatterns(err.message)).slice(0, SAFE_BODY_LIMIT)
        : "Network error";
      throw new T3HttpError(0, safeMsg, path);
    } finally {
      clearTimeout(timerId);
    }

    if (!response.ok) {
      let rawBody = "";
      try {
        rawBody = await response.text();
      } catch {
        // swallow read errors
      }
      // Step 1: redact exact token value (works regardless of JSON key name or Bearer prefix)
      // Step 2: redact generic bearer/token patterns as defence-in-depth
      const safeBody = redactGenericTokenPatterns(redactExact(token, rawBody)).slice(0, SAFE_BODY_LIMIT);
      throw new T3HttpError(response.status, safeBody, path);
    }

    return response.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  /** GET /api/auth/session — connection/auth status check. */
  async getSession(): Promise<T3AuthSessionState> {
    return this.request<T3AuthSessionState>("GET", "/api/auth/session");
  }

  /** GET /api/orchestration/snapshot — projects + threads lightweight model. */
  async getSnapshot(): Promise<T3Snapshot> {
    return this.request<T3Snapshot>("GET", "/api/orchestration/snapshot");
  }

  /**
   * GET /api/orchestration/threads/:threadId
   * Optional query params: turnLimit, beforeCursor.
   */
  async getThreadSnapshot(
    threadId: string,
    options?: { turnLimit?: number; beforeCursor?: string }
  ): Promise<T3ThreadDetailSnapshot> {
    return this.request<T3ThreadDetailSnapshot>(
      "GET",
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      {
        query: {
          ...(options?.turnLimit !== undefined ? { turnLimit: options.turnLimit } : {}),
          ...(options?.beforeCursor !== undefined ? { beforeCursor: options.beforeCursor } : {}),
        },
      }
    );
  }

  /** POST /api/orchestration/dispatch — send a ClientOrchestrationCommand. */
  async dispatch(command: T3DispatchCommand): Promise<T3DispatchResult> {
    return this.request<T3DispatchResult>("POST", "/api/orchestration/dispatch", { body: command });
  }

  /**
   * Resolve or create a T3 project for the given repository.
   *
   * 1. Calls getSnapshot() and finds an existing project by workspaceRoot.
   * 2. If absent, dispatches project.create with a new UUID project id.
   * 3. Returns the project id (existing or newly created).
   *
   * Security: repositoryRoot MUST come from RepositoryRegistry, not from MCP args.
   */
  async ensureProject(repositoryAlias: string, repositoryRoot: string): Promise<string> {
    const snapshot = await this.getSnapshot();
    const existing = snapshot.projects.find(
      (p) => normalizeRoot(p.workspaceRoot) === normalizeRoot(repositoryRoot)
    );
    if (existing) {
      return existing.id;
    }

    const projectId = crypto.randomUUID();
    await this.dispatch({
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: repositoryAlias,
      workspaceRoot: repositoryRoot,
      createdAt: new Date().toISOString(),
    });
    return projectId;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Normalize path for workspace-root comparison (trailing slash insensitive). */
export function normalizeRoot(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Redact the exact resolved token value from any string.
 * This catches cases where the server echoes the token under an arbitrary JSON
 * key name (not "token", not prefixed by "Bearer ").
 *
 * The token string itself MUST NOT appear in any log or error surface.
 */
export function redactExact(token: string, text: string): string {
  if (!token || token.length < 8) return text; // safety: don't redact trivial strings
  // Escape regex special chars in the token before using it as a pattern
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "g"), "[REDACTED]");
}

/**
 * Defence-in-depth: redact strings that look like bearer tokens or common
 * token JSON fields, AFTER exact-value redaction has already run.
 */
export function redactGenericTokenPatterns(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-_+/=]{20,}/g, "Bearer [REDACTED]")
    .replace(/"(access_token|token|bearer|authorization)"\s*:\s*"[A-Za-z0-9\-_+/=.]{20,}"/gi, '"$1":"[REDACTED]"');
}

// --------------------------------------------------------------------------
// Factory — creates a T3Client from config, returning null when disabled.
// Does NOT resolve the token — construction is always safe.
// --------------------------------------------------------------------------

export function createT3Client(t3Config: T3Config | undefined): T3Client | null {
  if (!t3Config || !t3Config.enabled) return null;
  return new T3Client(t3Config);
}
