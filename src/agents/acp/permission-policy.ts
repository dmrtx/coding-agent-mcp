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
  };
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
  // Nested scan of every other top-level object/array value (top-level
  // command/url stay the caller's own check, not "nested").
  for (const [key, entry] of Object.entries(record)) {
    if (isPathField(key) || key === "command" || key === "url") continue;
    if (typeof entry === "object" && entry !== null) {
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
 * - Everything outside `workspaceRoot` is denied, for every kind and mode.
 * - `read`/`search`/`think` are auto-allowed only when every referenced path
 *   (top-level or nested) is inside the workspace. `think` additionally
 *   requires no command/url payload at any depth and no nested structure
 *   at all. Nested command/url payloads deny every kind.
 * - `review`/`investigate` deny all writes, execute, delete, move, fetch,
 *   and anything unrecognized — even when contained and gated.
 * - `implement` additionally allows `edit`/`write` only when
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
}): AcpPermissionDecision {
  const { workspaceRoot, mode, allowWriteWorktree, toolCall } = input;
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

  const base = {
    mode,
    tool,
    kind,
    paths,
    outsideWorkspace,
    allowWriteWorktree,
    workspaceRoot,
  };

  const deny = (reason: string): AcpPermissionDecision => ({ allowed: false, reason, details: base });
  const allow = (reason: string): AcpPermissionDecision => ({ allowed: true, reason, details: base });

  // Fail closed on task-mode confusion (e.g. an ACP agent mode like "yolo"
  // passed where a task mode belongs), even if TypeScript is bypassed.
  if (mode !== "implement" && mode !== "review" && mode !== "investigate") {
    return deny(`Denied '${tool}' (${kind}): unknown task mode '${String(mode)}'`);
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
