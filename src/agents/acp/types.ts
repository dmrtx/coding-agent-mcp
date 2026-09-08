import { CodingAgentError, ErrorCodes } from "../../domain/errors.js";

/**
 * Structural ACP protocol error: malformed JSON, oversized lines, or
 * unexpected message shapes on the NDJSON stream. These are never silently
 * ignored: the framer throws them and the client routes them to
 * `onProtocolError` (or throws when no handler is installed).
 */
export class AcpProtocolError extends CodingAgentError {
  public readonly kind:
    | "malformed_line"
    | "line_too_long"
    | "unexpected_message"
    | "unexpected_response_id";

  constructor(
    kind: AcpProtocolError["kind"],
    message: string,
    details?: Record<string, unknown>
  ) {
    super(ErrorCodes.INTERNAL_ERROR, message, { protocol: "acp", kind, ...details });
    this.name = "AcpProtocolError";
    this.kind = kind;
    Object.setPrototypeOf(this, AcpProtocolError.prototype);
  }
}

/** Default upper bound for a single NDJSON protocol line (1 MiB). */
export const DEFAULT_ACP_MAX_LINE_BYTES = 1_000_000;

/** Default per-request timeout when the caller does not specify one. */
export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 120_000;

/** Phase 1 ACP method names (JSON-RPC `method` strings). */
export const AcpMethods = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionResume: "session/resume",
  sessionSetConfigOption: "session/set_config_option",
  /** Inbound kernel-to-client permission request (phase 1 test convention). */
  requestPermission: "session/request_permission",
} as const;

export type AcpMethod = (typeof AcpMethods)[keyof typeof AcpMethods];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Minimal, permissive result shapes. Fields are optional because servers may
// evolve; phase 1 only needs the identifiers below.
export interface AcpInitializeResult {
  protocolVersion?: unknown;
  serverInfo?: { name?: string; version?: string };
  [key: string]: unknown;
}

export interface AcpSessionNewResult {
  sessionId?: string;
  [key: string]: unknown;
}

export interface AcpSessionPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface AcpSessionCancelResult {
  cancelled?: boolean;
  [key: string]: unknown;
}

export interface AcpSessionResumeResult {
  sessionId?: string;
  resumed?: boolean;
  [key: string]: unknown;
}

export interface AcpSetConfigOptionResult {
  updated?: boolean;
  [key: string]: unknown;
}

export interface AcpAuthenticateResult {
  [key: string]: unknown;
}
