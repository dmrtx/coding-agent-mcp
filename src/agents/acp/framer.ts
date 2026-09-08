import { StringDecoder } from "node:string_decoder";
import { AcpProtocolError, DEFAULT_ACP_MAX_LINE_BYTES } from "./types.js";

/**
 * One framed outcome per complete NDJSON line. Errors are values (never
 * thrown for complete lines) so a later oversized/malformed line can neither
 * discard nor prevent delivery of earlier valid lines from the same chunk.
 */
export type FramedLine = { ok: true; line: string } | { ok: false; error: AcpProtocolError };

/**
 * Incremental newline framing for ACP's NDJSON transport.
 *
 * Feed arbitrary stdout chunks via {@link push}; complete lines (without the
 * terminator) are returned in order. `\r\n` line endings are tolerated.
 * Bytes are decoded with a {@link StringDecoder}, so multi-byte UTF-8
 * codepoints split across `Buffer` chunks round-trip exactly.
 *
 * The line size is bounded: any complete line longer than `maxLineBytes`, or
 * a buffered partial line that already exceeds it, yields an `ok: false`
 * outcome (and discards the offending bytes) instead of being silently
 * truncated or ignored. Call {@link flush} at EOF to drain a final
 * unterminated line, if any.
 */
export class NdjsonFramer {
  private readonly decoder = new StringDecoder("utf-8");
  private buffer = "";
  public readonly maxLineBytes: number;

  constructor(maxLineBytes: number = DEFAULT_ACP_MAX_LINE_BYTES) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new AcpProtocolError(
        "line_too_long",
        `Invalid ACP max line size: ${String(maxLineBytes)} (must be a positive integer)`
      );
    }
    this.maxLineBytes = maxLineBytes;
  }

  private static oversized(maxLineBytes: number): AcpProtocolError {
    return new AcpProtocolError(
      "line_too_long",
      `ACP protocol line exceeds ${maxLineBytes} bytes; discarding oversized line`,
      { maxLineBytes }
    );
  }

  /**
   * Append a chunk and return one outcome per newly completed line, in
   * stream order. Never throws for stream content (only the constructor
   * validates its own argument).
   */
  public push(chunk: string | Buffer): FramedLine[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    const segments = this.buffer.split("\n");
    this.buffer = segments.pop() ?? "";

    const outcomes: FramedLine[] = [];
    for (const raw of segments) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (Buffer.byteLength(line, "utf-8") > this.maxLineBytes) {
        outcomes.push({ ok: false, error: NdjsonFramer.oversized(this.maxLineBytes) });
        continue;
      }
      outcomes.push({ ok: true, line });
    }

    // A partial line that already exceeds the bound can never become valid.
    // Discard it now; its post-discard tail (up to the next newline) will
    // surface as its own outcome when terminated.
    if (Buffer.byteLength(this.buffer, "utf-8") > this.maxLineBytes) {
      this.buffer = "";
      outcomes.push({ ok: false, error: NdjsonFramer.oversized(this.maxLineBytes) });
    }

    return outcomes;
  }

  /**
   * Drain any buffered unterminated bytes at EOF as one final outcome.
   * Returns `[]` when nothing is buffered. Decodes any trailing partial
   * codepoint still held by the decoder.
   */
  public flush(): FramedLine[] {
    this.buffer += this.decoder.end();
    if (this.buffer === "") {
      return [];
    }
    const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = "";
    if (Buffer.byteLength(line, "utf-8") > this.maxLineBytes) {
      return [{ ok: false, error: NdjsonFramer.oversized(this.maxLineBytes) }];
    }
    return [{ ok: true, line }];
  }

  /** Bytes currently held awaiting a newline (diagnostics only). */
  public pendingBytes(): number {
    return Buffer.byteLength(this.buffer, "utf-8");
  }
}
