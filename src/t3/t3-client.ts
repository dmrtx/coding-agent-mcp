/**
 * T3Client — lightweight HTTP client for the T3 Environment API (Phase 1).
 *
 * Security contracts:
 * - Bearer token is NEVER logged, serialized, or included in thrown error messages.
 * - All request timeouts are enforced via AbortController.
 * - Non-2xx responses are surfaced with HTTP status and a bounded (≤ 2 KB) body excerpt.
 * - Token resolution: process.env[access_token_env] at construction time.
 */

import { T3Config } from "./t3-config.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

// --------------------------------------------------------------------------
// Types matching T3 wire shapes (no runtime lib dependency; plain TS).
// --------------------------------------------------------------------------

export interface T3SnapshotProject {
  id: string;
  workspaceRoot: string;
  title: string;
  // additional fields present but not consumed in Phase 1
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
  modelSelection: {
    instanceId: string;
    model: string;
  };
  runtimeMode: string;
  interactionMode: string;
  session: T3Session | null;
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

// A minimal typed union for the dispatch commands we emit (Phase 1).
// We use plain records rather than Effect-Schema types — the HTTP server
// accepts any valid JSON object that matches the union discriminant.
export type T3DispatchCommand = Record<string, unknown>;

export interface T3AuthSessionState {
  authenticated: boolean;
  scopes?: string[];
  sessionMethod?: string;
  expiresAt?: string;
  auth?: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Error class
// --------------------------------------------------------------------------

export class T3HttpError extends Error {
  public readonly status: number;
  public readonly safeBody: string;

  constructor(status: number, safeBody: string, context: string) {
    // Never include bearer token in message
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
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: T3Config) {
    if (!config.enabled) {
      throw new T3ConfigError("T3 integration is disabled (t3.enabled is false)");
    }
    // Strip trailing slash from base_url
    this.baseUrl = config.base_url.replace(/\/+$/, "");

    const tokenValue = process.env[config.access_token_env];
    if (!tokenValue || tokenValue.trim() === "") {
      throw new T3ConfigError(
        `T3 access token is missing. ` +
          `Set the environment variable named in t3.access_token_env (currently: ${config.access_token_env}). ` +
          `The token value must never be placed in config files.`
      );
    }
    this.token = tokenValue;
    this.timeoutMs = config.request_timeout_ms;
  }

  /** Builds an Authorization header without exposing the raw token in any object key names */
  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** Performs an HTTP request with timeout enforcement. Never logs the token. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
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
      ...this.authHeader(),
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
      throw err;
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
      // Redact anything that looks like a bearer token before surfacing
      const safeBody = redactTokens(rawBody).slice(0, SAFE_BODY_LIMIT);
      throw new T3HttpError(response.status, safeBody, path);
    }

    return response.json() as Promise<T>;
  }

  // -----------------------------------------------------------------------
  // Public API methods
  // -----------------------------------------------------------------------

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
function normalizeRoot(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Redact strings that look like bearer tokens (long base64url strings).
 * This is a defensive measure; tokens should never reach error bodies, but
 * if a 4xx body echoes the auth header we won't surface the raw value.
 */
function redactTokens(text: string): string {
  // Replace long (>= 20 chars) base64url-like tokens after "Bearer " prefix
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-_+/=]{20,}/g, "Bearer [REDACTED]")
    .replace(/"(access_token|token|bearer)"\s*:\s*"[A-Za-z0-9\-_+/=.]{20,}"/gi, '"$1":"[REDACTED]"');
}

// --------------------------------------------------------------------------
// Factory — creates a T3Client from config, returning null when disabled.
// --------------------------------------------------------------------------

export function createT3Client(t3Config: T3Config | undefined): T3Client | null {
  if (!t3Config || !t3Config.enabled) return null;
  return new T3Client(t3Config);
}
