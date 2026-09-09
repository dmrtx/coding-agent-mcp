import path from "node:path";
import { isPathSameOrInside } from "../../security/path-policy.js";

export type AcpTaskMode = "implement" | "review" | "investigate";

export type AcpToolKind =
  | "read"
  | "search"
  | "think"
  | "edit"
  | "delete"
  | "move"
  | "execute"
  | "fetch"
  | "other";

/**
 * Inbound kernel tool-call/permission-request shape (phase 1 convention).
 * Paths are read from common top-level fields AND nested path-like fields;
 * `tool` (falling back to `kind`) names the requested operation. Anything
 * unrecognized denies. This documents the phase 1 test convention only, not
 * any real kernel's request compatibility.
 */
export interface AcpToolCallShape {
  toolCallId?: string;
  tool?: string;
  kind?: string;
  title?: string;
  command?: string;
  url?: string;
  path?: string;
  paths?: string[];
  [key: string]: unknown;
}

export interface AcpPermissionDecision {
  allowed: boolean;
  /** Human-readable verdict suitable for transcript/audit records. */
  reason: string;
  details: {
    mode: AcpTaskMode;
    tool: string;
    kind: AcpToolKind;
    paths: string[];
    outsideWorkspace: string[];
    allowWriteWorktree: boolean;
    workspaceRoot: string;
    /** Adapter-supplied agent-internal scratch root, when one was in effect. */
    internalScratchRoot?: string;
  };
}

/**
 * Derive the adapter-owned agent-internal scratch root for one ACP session.
 *
 * Shape: `<geminiHome>/antigravity-acp/brain/<sessionId>/scratch`, where
 * `geminiHome` is the isolated persistent `GEMINI_HOME` and `sessionId` is
 * the exact established ACP session id. Returns `undefined` fail-closed for
 * any missing, relative, or unsafe input. The session id allowlist rejects
 * path separators and traversal so sibling/parent roots are unreachable.
 */
export function resolveAcpSessionScratchRoot(
  geminiHome: unknown,
  sessionId: unknown
): string | undefined {
  if (typeof geminiHome !== "string" || geminiHome.length === 0) return undefined;
  if (!path.isAbsolute(geminiHome)) return undefined;
  if (typeof sessionId !== "string") return undefined;
  const sid = sessionId.trim();
  if (sid.length === 0 || sid.length > 128) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sid)) return undefined;
  return path.join(geminiHome, "antigravity-acp", "brain", sid, "scratch");
}

const READ_TOOLS = new Set([
  "read", "read_file", "readfile", "read_many", "read_text", "view", "view_file",
  "open", "show", "cat", "list", "ls", "list_dir", "list_files", "glob",
  "stat", "file_info", "get_file",
]);

const SEARCH_TOOLS = new Set([
  "search", "grep", "find", "code_search", "text_search", "search_files", "ripgrep",
]);

const THINK_TOOLS = new Set(["think", "thinking", "reason", "reasoning", "reflect", "reflection"]);

const EDIT_TOOLS = new Set([
  "edit", "edit_file", "write", "write_file", "writefile", "create", "create_file",
  "apply_patch", "patch", "update", "update_file", "save",
]);

const DELETE_TOOLS = new Set(["delete", "delete_file", "remove", "rm", "trash", "unlink"]);

const MOVE_TOOLS = new Set(["move", "move_file", "rename", "mv", "copy", "copy_file"]);

const EXECUTE_TOOLS = new Set([
  "bash", "shell", "exec", "execute", "run", "command", "terminal", "run_command", "sh",
]);

const FETCH_TOOLS = new Set([
  "fetch", "web_fetch", "webfetch", "http", "https", "curl", "wget",
  "browser", "browser_open", "web_search", "websearch",
]);

const PATH_FIELDS = [
  "paths", "path", "file", "filePath", "file_path", "filename",
  "directory", "dir", "source", "destination", "from", "to",
] as const;

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function categorizeTool(tool: string): AcpToolKind {
  if (READ_TOOLS.has(tool)) return "read";
  if (SEARCH_TOOLS.has(tool)) return "search";
  if (THINK_TOOLS.has(tool)) return "think";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (DELETE_TOOLS.has(tool)) return "delete";
  if (MOVE_TOOLS.has(tool)) return "move";
  if (EXECUTE_TOOLS.has(tool)) return "execute";
  if (FETCH_TOOLS.has(tool)) return "fetch";
  return "other";
}

const MAX_NESTING_DEPTH = 5;

interface ExtractedSignals {
  /** Top-level known path fields plus nested path-like strings. */
  paths: string[];
  /** A nested (non-top-level) command/url string payload was found. */
  nestedCommandOrUrl: boolean;
  /** Any nested object/array payload exists (beyond flat top-level fields). */
  opaqueNestedPayload: boolean;
}

function isPathField(key: string): boolean {
  return (PATH_FIELDS as readonly string[]).includes(key);
}

/**
 * Collects path-like strings from known top-level path fields (exact legacy
 * treatment) plus nested path-like strings under known path-field names at
 * any depth, and detects nested command/url payloads. Cycle-safe and
 * depth-capped; anything beyond the cap counts as opaque. Nested plain
 * strings under unknown names (e.g. CLI flags) are NOT treated as paths.
 * The official-kernel `rawInput` query envelope is normalized, not opaque:
 * scalar-only metadata is inert, while path/command/url keys and nested
 * structures inside it keep their usual signal treatment.
 */
function extractSignals(toolCall: AcpToolCallShape): ExtractedSignals {
  const paths: string[] = [];
  const seen = new Set<object>();
  let nestedCommandOrUrl = false;
  let opaqueNestedPayload = false;

  const visit = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (depth > MAX_NESTING_DEPTH) {
      opaqueNestedPayload = true;
      return;
    }
    if (Array.isArray(node)) {
      opaqueNestedPayload = true;
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const [key, entry] of Object.entries(node)) {
      if (typeof entry === "string") {
        if (entry.length === 0) continue;
        if (isPathField(key)) paths.push(entry);
        else if (key === "command" || key === "url") nestedCommandOrUrl = true;
        continue;
      }
      if (typeof entry === "object" && entry !== null) {
        opaqueNestedPayload = true;
        visit(entry, depth + 1);
      }
    }
  };

  const record = toolCall as Record<string, unknown>;
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string") {
      if (value.length > 0) paths.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          if (entry.length > 0) paths.push(entry);
        } else if (typeof entry === "object" && entry !== null) {
          opaqueNestedPayload = true;
          visit(entry, 1);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      opaqueNestedPayload = true;
      visit(value, 1);
    }
  }
  /**
   * Official-kernel query envelope (`rawInput`): scalar-only search
   * metadata such as `{ query }` is NOT opaque — it carries no filesystem
   * or network addressing. Path-field keys still collect auditable paths
   * (so outside-workspace containment keeps rejecting), command/url keys
   * still flag executable payloads, and any nested object/array still
   * marks the payload opaque (visited as usual so deeper path/command
   * signals are not lost). A non-plain-object `rawInput` keeps the
   * generic opaque treatment below.
   */
  const visitQueryEnvelope = (envelope: Record<string, unknown>): void => {
    for (const [key, entry] of Object.entries(envelope)) {
      if (typeof entry === "string") {
        if (entry.length === 0) continue;
        if (isPathField(key)) paths.push(entry);
        else if (key === "command" || key === "url") nestedCommandOrUrl = true;
        // Any other scalar string is inert query metadata: ignored.
        continue;
      }
      if (typeof entry === "object" && entry !== null) {
        if (isPathField(key) && Array.isArray(entry)) {
          for (const item of entry) {
            if (typeof item === "string") {
              if (item.length > 0) paths.push(item);
            } else if (typeof item === "object" && item !== null) {
              opaqueNestedPayload = true;
              visit(item, 1);
            }
          }
          continue;
        }
        opaqueNestedPayload = true;
        visit(entry, 1);
        continue;
      }
      // Numbers, booleans, null/undefined: inert query metadata.
    }
  };
  // Nested scan of every other top-level object/array value (top-level
  // command/url stay the caller's own check, not "nested").
  for (const [key, entry] of Object.entries(record)) {
    if (isPathField(key) || key === "command" || key === "url") continue;
    if (typeof entry === "object" && entry !== null) {
      if (key === "rawInput" && !Array.isArray(entry)) {
        visitQueryEnvelope(entry as Record<string, unknown>);
        continue;
      }
      opaqueNestedPayload = true;
      visit(entry, 1);
    }
  }
  return { paths: [...new Set(paths)], nestedCommandOrUrl, opaqueNestedPayload };
}

function isContained(candidate: string, workspaceRoot: string): boolean {
  try {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
    return isPathSameOrInside(absolute, workspaceRoot);
  } catch {
    return false;
  }
}

/**
 * Pure ACP permission-policy helper (phase 1 foundation, no I/O).
 *
 * Fail-closed rules:
 * - Everything outside `workspaceRoot` is denied, for every kind and mode,
 *   EXCEPT the narrow agent-internal scratch exception below (which never
 *   touches the repository).
 * - `read`/`search`/`think` are auto-allowed only when every referenced path
 *   (top-level or nested) is inside the workspace. `think` additionally
 *   requires no command/url payload at any depth and no nested structure
 *   at all. Nested command/url payloads deny every kind.
 * - Pathless native `search` (no paths at any depth, including inside a
 *   query-only `rawInput` envelope) is treated as workspace-scoped and
 *   allowed in every mode ONLY when the kind is `search`, there is no
 *   command/url payload at any depth, and there is no opaque nested
 *   structure. Pathless `read` stays denied.
 * - Agent-internal scratch: `edit`/`write`/`create` (kind `edit`) whose
 *   every path is contained in the adapter-supplied `internalScratchRoot`
 *   (`<geminiHome>/antigravity-acp/brain/<sessionId>/scratch`) is allowed in
 *   every task mode without the `allowWriteWorktree` gate, because it does
 *   not touch the repository. `delete`/`move`/`execute`/`fetch`/`other`
 *   inside the scratch root stay denied; traversal/outside-scratch and
 *   command/url payloads deny; normal repository writes stay gated.
 * - `review`/`investigate` deny all repository writes, execute, delete,
 *   move, fetch, and anything unrecognized — even when contained and gated.
 * - `implement` additionally allows repository `edit`/`write` only when
 *   `allowWriteWorktree` is true AND every path is contained. Execute,
 *   delete, move, fetch, and unrecognized tools stay denied.
 * - There is deliberately NO yolo bypass: the ACP agent `mode` is not even
 *   an input to this helper.
 */
export function decideAcpToolPermission(input: {
  workspaceRoot: string;
  mode: AcpTaskMode;
  allowWriteWorktree: boolean;
  toolCall: AcpToolCallShape;
  /** Agent-internal scratch root supplied by the adapter; absent = no exception. */
  internalScratchRoot?: string;
}): AcpPermissionDecision {
  const { workspaceRoot, mode, allowWriteWorktree, toolCall } = input;
  const scratchRaw = typeof input.internalScratchRoot === "string" ? input.internalScratchRoot : "";
  const internalScratchRoot =
    scratchRaw.length > 0 && path.isAbsolute(scratchRaw) ? scratchRaw : undefined;
  const rawTool = typeof toolCall.tool === "string" ? toolCall.tool : toolCall.kind;
  const tool = normalizeToolName(rawTool) || "unknown";
  const kind = categorizeTool(tool);
  const signals = extractSignals(toolCall);
  const paths = signals.paths;
  const outsideWorkspace = paths.filter((p) => !isContained(p, workspaceRoot));
  const hasExecutablePayload =
    (typeof toolCall.command === "string" && toolCall.command.length > 0) ||
    (typeof toolCall.url === "string" && toolCall.url.length > 0) ||
    signals.nestedCommandOrUrl;

  const isInsideScratch = (candidate: string): boolean => {
    if (internalScratchRoot === undefined) return false;
    try {
      const absolute = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(workspaceRoot, candidate);
      return isPathSameOrInside(absolute, internalScratchRoot);
    } catch {
      return false;
    }
  };
  const allInsideScratch =
    internalScratchRoot !== undefined &&
    paths.length > 0 &&
    paths.every(isInsideScratch);
  // Scratch paths live outside the repository by construction (state_dir is
  // disjoint from every repository root). Require that here so an
  // overlapping root can never turn a repository write into an ungated
  // scratch write: every path must be outside the workspace.
  const allOutsideWorkspace = paths.length > 0 && outsideWorkspace.length === paths.length;

  const base = {
    mode,
    tool,
    kind,
    paths,
    outsideWorkspace,
    allowWriteWorktree,
    workspaceRoot,
    ...(internalScratchRoot !== undefined ? { internalScratchRoot } : {}),
  };

  const deny = (reason: string): AcpPermissionDecision => ({ allowed: false, reason, details: base });
  const allow = (reason: string): AcpPermissionDecision => ({ allowed: true, reason, details: base });

  // Fail closed on task-mode confusion (e.g. an ACP agent mode like "yolo"
  // passed where a task mode belongs), even if TypeScript is bypassed.
  if (mode !== "implement" && mode !== "review" && mode !== "investigate") {
    return deny(`Denied '${tool}' (${kind}): unknown task mode '${String(mode)}'`);
  }

  // Narrow agent-internal scratch exception: edit/write/create only, every
  // path contained in the exact session scratch root, no command/url at any
  // depth. Allowed in every task mode without the worktree gate because it
  // cannot touch the repository. Delete/move/execute/fetch/other inside the
  // scratch root fall through to the normal denies below.
  if (kind === "edit" && allInsideScratch && allOutsideWorkspace) {
    if (hasExecutablePayload) {
      return deny(`Denied '${tool}' (edit) in ${mode} mode: scratch writes must not carry command/url payloads`);
    }
    return allow(`Allowed '${tool}' (edit) in ${mode} mode: all ${paths.length} path(s) inside agent-internal scratch`);
  }

  if (outsideWorkspace.length > 0) {
    return deny(
      `Denied '${tool}' (${kind}) in ${mode} mode: path(s) outside workspace: ${outsideWorkspace.join(", ")}`
    );
  }

  if (kind === "think") {
    // Think must be pure reasoning: no paths at any depth, no executable
    // payloads, and no opaque nested structure that could hide either.
    if (paths.length > 0 || hasExecutablePayload || signals.opaqueNestedPayload) {
      return deny(`Denied '${tool}' (think) in ${mode} mode: reasoning must not carry paths, payloads, or nested structure`);
    }
    return allow(`Allowed '${tool}' (think) in ${mode} mode: pure reasoning, no filesystem or network access`);
  }

  if (kind === "read" || kind === "search") {
    if (hasExecutablePayload) {
      return deny(`Denied '${tool}' (${kind}) in ${mode} mode: read-only operations must not carry command/url payloads`);
    }
    if (paths.length === 0) {
      // Official kernels issue native search without auditable paths. Treat
      // that narrow shape as workspace-scoped search: search kind only, no
      // executable payload, and no opaque nested structure that could hide
      // side effects. Pathless read stays denied.
      if (kind === "search" && !signals.opaqueNestedPayload) {
        return allow(`Allowed '${tool}' (search) in ${mode} mode: workspace-scoped native search with no paths`);
      }
      return deny(`Denied '${tool}' (${kind}) in ${mode} mode: no auditable in-workspace paths provided`);
    }
    return allow(`Allowed '${tool}' (${kind}) in ${mode} mode: all ${paths.length} path(s) inside workspace`);
  }

  if (mode === "review" || mode === "investigate") {
    return deny(`Denied '${tool}' (${kind}) in ${mode} mode: ${mode} tasks are read-only`);
  }

  // mode === "implement" from here on.
  if (signals.nestedCommandOrUrl) {
    return deny(`Denied '${tool}' (${kind}) in implement mode: nested command/url payloads are never auto-allowed`);
  }
  if (kind === "edit") {
    if (paths.length === 0) {
      return deny(`Denied '${tool}' (edit) in implement mode: no auditable in-workspace paths provided`);
    }
    if (!allowWriteWorktree) {
      return deny(
        `Denied '${tool}' (edit) in implement mode: allow_write_worktree is false (writes are opt-in)`
      );
    }
    return allow(`Allowed '${tool}' (edit) in implement mode: gate enabled and all ${paths.length} path(s) inside workspace`);
  }

  if (kind === "execute" || kind === "delete" || kind === "move" || kind === "fetch" || kind === "other") {
    return deny(`Denied '${tool}' (${kind}) in implement mode: only contained read/search/think and gated edit/write are permitted`);
  }

  return deny(`Denied '${tool}' (${kind}) in ${mode} mode: unrecognized operation`);
}
