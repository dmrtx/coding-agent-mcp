import { CodingAgentError, ErrorCodes, type ErrorCode } from "../../domain/errors.js";
import { NdjsonFramer, type FramedLine } from "./framer.js";
import {
  AcpMethods,
  AcpProtocolError,
  DEFAULT_ACP_MAX_LINE_BYTES,
  DEFAULT_ACP_REQUEST_TIMEOUT_MS,
  isRecord,
  type AcpInitializeResult,
  type AcpSessionCancelResult,
  type AcpSessionNewResult,
  type AcpSessionPromptResult,
  type AcpSessionResumeResult,
  type AcpSetConfigOptionResult,
} from "./types.js";

export interface AcpRequestOptions {
  timeoutMs?: number;
}

export interface AcpClientOptions {
  /**
   * Transport write: receives one JSON-RPC message serialized WITHOUT the
   * trailing newline; the transport must append `\n` when writing to the
   * kernel stdin. Synchronous throws reject the in-flight request.
   */
  sendLine: (line: string) => void;
  maxLineBytes?: number;
  defaultTimeoutMs?: number;
  /** Unsolicited kernel notifications (`method` without `id`). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Inbound kernel requests (`method` with `id`, e.g. permission prompts).
   * The resolved value is sent back as `result`. A throw/rejection is sent
   * back as JSON-RPC error -32603. When absent, inbound requests are
   * answered with -32601 (method not found) — never silently dropped.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /**
   * Observational hook for structural stream problems (malformed/oversized
   * lines, unexpected shapes, version mismatches). Observational ONLY: every
   * such problem is terminal regardless — the client closes and fails all
   * pending requests. Exceptions thrown by this hook are swallowed so an
   * observer can never crash protocol handling.
   */
  onProtocolError?: (err: AcpProtocolError) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Dependency-light ACP JSON-RPC/NDJSON protocol client (phase 1 foundation).
 *
 * Transport-agnostic: stdout bytes enter via {@link receiveChunk}, messages
 * leave via `options.sendLine`. Stderr is NOT protocol — route it to
 * {@link handleStderrChunk}, which only retains a bounded diagnostic tail
 * and never parses it.
 *
 * Protocol corruption is TERMINAL: the first malformed/oversized line,
 * unexpected shape, unknown response id, or JSON-RPC version mismatch
 * closes the client and fails every pending request with INTERNAL_ERROR.
 * Valid messages earlier (or elsewhere) in the same chunk still settle
 * normally before the failure lands. `onProtocolError` observes the fatal
 * error but cannot resume the client — orchestration must never continue a
 * session after it fires.
 *
 * No orchestration integration: no spawning, no TaskManager/ProcessManager
 * coupling, no permission auto-answering (pair with
 * `decideAcpToolPermission` in phase 2).
 */
export class AcpClient {
  private readonly sendLine: (line: string) => void;
  private readonly framer: NdjsonFramer;
  private readonly defaultTimeoutMs: number;
  private readonly onNotification?: AcpClientOptions["onNotification"];
  private readonly onRequest?: AcpClientOptions["onRequest"];
  private readonly onProtocolError?: AcpClientOptions["onProtocolError"];
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closeReason: string | null = null;
  private stderrTail = "";
  private stderrBytesTotal = 0;
  private static readonly STDERR_TAIL_MAX_CHARS = 8_192;

  constructor(options: AcpClientOptions) {
    this.sendLine = options.sendLine;
    this.framer = new NdjsonFramer(options.maxLineBytes ?? DEFAULT_ACP_MAX_LINE_BYTES);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onProtocolError = options.onProtocolError;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get pendingCount(): number {
    return this.pending.size;
  }

  /** Total stderr bytes observed (diagnostic only; never parsed). */
  public get stderrBytes(): number {
    return this.stderrBytesTotal;
  }

  /** Bounded retained stderr tail for diagnostics. */
  public getStderrTail(): string {
    return this.stderrTail;
  }

  /**
   * Stderr is not protocol: retained (bounded) for diagnostics, never
   * framed or parsed as JSON-RPC.
   */
  public handleStderrChunk(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    this.stderrBytesTotal += Buffer.byteLength(text, "utf-8");
    this.stderrTail = (this.stderrTail + text).slice(-AcpClient.STDERR_TAIL_MAX_CHARS);
  }

  /**
   * Feed raw stdout bytes. Every complete line in the chunk settles in
   * stream order (a later corrupt line never un-settles an earlier valid
   * response); the first structural problem then fails the client
   * terminally. Input after close is ignored.
   */
  public receiveChunk(chunk: string | Buffer): void {
    if (this.closed) {
      return;
    }
    this.processOutcomes(this.framer.push(chunk));
  }

  /**
   * Drain a final unterminated line at EOF, if any. Same terminal
   * semantics as {@link receiveChunk}.
   */
  public flush(): void {
    if (this.closed) {
      return;
    }
    this.processOutcomes(this.framer.flush());
  }

  private processOutcomes(outcomes: FramedLine[]): void {
    let firstError: AcpProtocolError | null = null;
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        firstError ??= outcome.error;
        continue;
      }
      try {
        this.handleLine(outcome.line);
      } catch (err) {
        if (err instanceof AcpProtocolError) {
          firstError ??= err;
        } else {
          throw err;
        }
      }
    }
    if (firstError) {
      this.failCorrupted(firstError);
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === "") {
      throw new AcpProtocolError("malformed_line", "ACP stream contained an empty line", {
        linePreview: "",
      });
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new AcpProtocolError("malformed_line", "ACP stream contained a non-JSON line", {
        linePreview: line.slice(0, 200),
        lineBytes: Buffer.byteLength(line, "utf-8"),
      });
    }

    if (!isRecord(message)) {
      throw new AcpProtocolError(
        "unexpected_message",
        "ACP stream contained a JSON value that is not a JSON-RPC object",
        { linePreview: line.slice(0, 200) }
      );
    }

    if (message.jsonrpc !== "2.0") {
      throw new AcpProtocolError(
        "unexpected_message",
        "ACP message is not JSON-RPC 2.0 (missing or mismatched 'jsonrpc' member)",
        { linePreview: line.slice(0, 200) }
      );
    }

    const hasId = "id" in message && message.id !== undefined && message.id !== null;
    const method = message.method;
    const hasMethod = typeof method === "string";
    const hasResult = "result" in message;
    const hasError = "error" in message;

    if (hasMethod && hasId) {
      void this.answerInboundRequest(message.id as number | string, method, message.params);
      return;
    }

    if (hasMethod && !hasId) {
      if (!this.onNotification) {
        return;
      }
      try {
        this.onNotification(method, message.params);
      } catch (err) {
        // A failing observer is itself a structural failure: isolate it as
        // a protocol error (terminal) instead of breaking the read loop.
        throw new AcpProtocolError(
          "unexpected_message",
          `ACP notification handler failed for '${method}': ${err instanceof Error ? err.message : String(err)}`,
          { method }
        );
      }
      return;
    }

    if (!hasMethod && hasId && (hasResult || hasError)) {
      this.settleResponse(message.id as number | string, message);
      return;
    }

    throw new AcpProtocolError(
      "unexpected_message",
      "ACP stream contained a JSON object that is neither a request, response, nor notification",
      { linePreview: line.slice(0, 200) }
    );
  }

  private settleResponse(id: number | string, message: Record<string, unknown>): void {
    if (typeof id !== "number") {
      throw new AcpProtocolError(
        "unexpected_response_id",
        "ACP response carried a non-numeric id (client issues numeric ids only)",
        { id }
      );
    }
    const entry = this.pending.get(id);
    if (!entry) {
      throw new AcpProtocolError(
        "unexpected_response_id",
        `ACP response referenced unknown request id ${id}`,
        { id }
      );
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in message) {
      const errValue = message.error;
      const code = isRecord(errValue) && typeof errValue.code === "number" ? errValue.code : -32603;
      const text = isRecord(errValue) && typeof errValue.message === "string" ? errValue.message : "unknown ACP error";
      entry.reject(
        new CodingAgentError(
          ErrorCodes.INTERNAL_ERROR,
          `ACP request '${entry.method}' failed: ${text} (code ${code})`,
          { method: entry.method, requestId: id, code, data: isRecord(errValue) ? errValue.data : undefined }
        )
      );
      return;
    }
    entry.resolve(message.result);
  }

  private answerInboundRequest(id: number | string, method: string, params: unknown): void {
    const respond = (payload: Record<string, unknown>): void => {
      // Never answer into a closed transport; and never let a transport
      // failure escape synchronously OR as an unhandled rejection — it is a
      // terminal protocol failure. This runs in async continuations, so it
      // must not throw under any circumstances.
      if (this.closed) {
        return;
      }
      try {
        this.sendLine(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
      } catch (err) {
        this.failCorrupted(
          new AcpProtocolError("unexpected_message", `Failed to send ACP response for '${method}'`, {
            method,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    };

    if (!this.onRequest) {
      respond({ error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }

    let outcome: unknown;
    try {
      outcome = this.onRequest(method, params);
    } catch (err) {
      respond({
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    void Promise.resolve(outcome).then(
      (result) => respond({ result: result ?? null }),
      (err) => respond({ error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
    );
  }

  /**
   * Observational hook delivery. Never throws: an observer exception is
   * swallowed because observation must not affect terminal handling.
   */
  private observeProtocolError(err: AcpProtocolError): void {
    if (!this.onProtocolError) {
      return;
    }
    try {
      this.onProtocolError(err);
    } catch {
      // Observational only; the terminal failure below proceeds regardless.
    }
  }

  /**
   * Terminal protocol failure: observe once, then close and fail every
   * pending request with INTERNAL_ERROR. Safe to call from async
   * continuations (never throws) and idempotent via {@link closeInternal}.
   */
  private failCorrupted(err: AcpProtocolError): void {
    if (this.closed) {
      return;
    }
    this.observeProtocolError(err);
    this.closeInternal(ErrorCodes.INTERNAL_ERROR, `ACP protocol corrupted: ${err.message}`);
  }

  public request<T = unknown>(method: string, params?: unknown, options?: AcpRequestOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new CodingAgentError(
          ErrorCodes.TASK_CANCELLED,
          `ACP client is closed (${this.closeReason ?? "no reason given"}); cannot send '${method}'`,
          { method }
        )
      );
    }
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const id = this.nextId++;
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) envelope.params = params;
    const line = JSON.stringify(envelope);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodingAgentError(ErrorCodes.TASK_TIMEOUT, `ACP request '${method}' timed out after ${timeoutMs}ms`, {
            method,
            requestId: id,
            timeoutMs,
          })
        );
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.sendLine(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new CodingAgentError(
            ErrorCodes.PROCESS_START_FAILED,
            `ACP transport failed to send '${method}': ${err instanceof Error ? err.message : String(err)}`,
            { method, requestId: id }
          )
        );
      }
    });
  }

  public initialize(params?: Record<string, unknown>, options?: AcpRequestOptions): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>(AcpMethods.initialize, params, options);
  }

  public sessionNew(params?: Record<string, unknown>, options?: AcpRequestOptions): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>(AcpMethods.sessionNew, params, options);
  }

  public sessionPrompt(
    params: Record<string, unknown>,
    options?: AcpRequestOptions
  ): Promise<AcpSessionPromptResult> {
    return this.request<AcpSessionPromptResult>(AcpMethods.sessionPrompt, params, options);
  }

  public sessionCancel(
    params: Record<string, unknown>,
    options?: AcpRequestOptions
  ): Promise<AcpSessionCancelResult> {
    return this.request<AcpSessionCancelResult>(AcpMethods.sessionCancel, params, options);
  }

  public sessionResume(
    params: Record<string, unknown>,
    options?: AcpRequestOptions
  ): Promise<AcpSessionResumeResult> {
    return this.request<AcpSessionResumeResult>(AcpMethods.sessionResume, params, options);
  }

  public sessionSetConfigOption(
    params: Record<string, unknown>,
    options?: AcpRequestOptions
  ): Promise<AcpSetConfigOptionResult> {
    return this.request<AcpSetConfigOptionResult>(AcpMethods.sessionSetConfigOption, params, options);
  }

  /**
   * Clean shutdown: marks the client closed and fails every pending request
   * with TASK_CANCELLED so no caller hangs. Input received after close is
   * ignored. Idempotent.
   */
  public close(reason = "client closed"): void {
    this.closeInternal(ErrorCodes.TASK_CANCELLED, reason);
  }

  private closeInternal(code: ErrorCode, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new CodingAgentError(code, `ACP client closed while '${entry.method}' was pending: ${reason}`, {
          method: entry.method,
          requestId: id,
        })
      );
    }
  }
}
