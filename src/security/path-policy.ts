import fs from "node:fs";
import path from "node:path";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

/**
 * Returns canonical path, properly resolving ancestor symlinks (e.g. macOS /var -> /private/var)
 * even if the target file does not yet exist.
 */
export function canonicalizePath(targetPath: string): string {
  const abs = path.resolve(targetPath);
  if (fs.existsSync(abs)) {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }

  // Nearest-existing-ancestor walk. Unlike existsSync (which follows links),
  // each level is inspected with lstat so symlinks — including dangling ones
  // whose target does not exist — are resolved via readlink instead of being
  // mistaken for a plain missing path component.
  let current = abs;
  const missingParts: string[] = [];
  const seenLinks = new Set<string>();
  for (;;) {
    let isLink = false;
    try {
      isLink = fs.lstatSync(current).isSymbolicLink();
    } catch {
      // Component does not exist (or is not inspectable): move up,
      // matching the historical existsSync-based behavior.
      if (current === path.dirname(current)) {
        break;
      }
      missingParts.unshift(path.basename(current));
      current = path.dirname(current);
      continue;
    }
    if (isLink) {
      if (seenLinks.has(current)) {
        return abs; // Symlink loop: the path is unusable; fail safe.
      }
      seenLinks.add(current);
      let target: string;
      try {
        target = fs.readlinkSync(current);
      } catch {
        return abs;
      }
      current = path.join(path.resolve(path.dirname(current), target), ...missingParts);
      missingParts.length = 0;
      if (fs.existsSync(current)) {
        try {
          return fs.realpathSync(current);
        } catch {
          return current;
        }
      }
      continue;
    }
    try {
      const canonicalAncestor = fs.realpathSync(current);
      return path.join(canonicalAncestor, ...missingParts);
    } catch {
      return abs;
    }
  }

  try {
    const canonicalAncestor = fs.realpathSync(current);
    return path.join(canonicalAncestor, ...missingParts);
  } catch {
    return abs;
  }
}

/**
 * Validates that a target path is strictly contained within an allowed root directory.
 * Resolves symlinks and canonical realpaths to prevent traversal and symlink escapes.
 */
export function assertPathContained(targetPath: string, allowedRoot: string): string {
  const canonicalAllowed = canonicalizePath(allowedRoot);
  const canonicalTarget = canonicalizePath(targetPath);

  const relative = path.relative(canonicalAllowed, canonicalTarget);
  const isEscape = relative.startsWith("..") || path.isAbsolute(relative);

  if (isEscape) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      `Path access violation: target path '${targetPath}' escapes allowed root '${allowedRoot}'`
    );
  }

  return canonicalTarget;
}

/**
 * Returns true when `targetPath` is equal to or contained within `rootPath`.
 * Both paths are canonicalized with {@link canonicalizePath} so symlinks
 * cannot bypass the comparison, including ancestors that do not exist yet.
 */
export function isPathSameOrInside(targetPath: string, rootPath: string): boolean {
  const canonicalRoot = canonicalizePath(rootPath);
  const canonicalTarget = canonicalizePath(targetPath);

  if (canonicalTarget === canonicalRoot) {
    return true;
  }

  const relative = path.relative(canonicalRoot, canonicalTarget);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Returns true when either path is equal to or contains the other.
 */
export function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return isPathSameOrInside(firstPath, secondPath) || isPathSameOrInside(secondPath, firstPath);
}

/**
 * Rejects a `server.data_dir` that is equal to, inside, or contains any
 * configured repository root. All comparisons are realpath-aware via
 * {@link canonicalizePath} so symlinks cannot bypass the check.
 */
export function assertDataDirDisjointFromRepositories(
  dataDir: string,
  repositories: Record<string, { root: string }>
): void {
  for (const [alias, repo] of Object.entries(repositories)) {
    if (pathsOverlap(dataDir, repo.root)) {
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Invalid configuration: server.data_dir '${dataDir}' overlaps repository '${alias}' root '${repo.root}'. server.data_dir must be outside every configured repository root.`,
        { repository: alias, data_dir: dataDir, repository_root: repo.root }
      );
    }
  }
}

/**
 * Rejects an `agents.agy-acp.state_dir` that is equal to, inside, or
 * contains any configured repository root. Runtime agent state (sessions,
 * credentials, transcripts) must never live inside a worktree where it
 * would pollute `get_repo_status` / `get_diff` or leak into commits.
 * Living under `server.data_dir` (the default) is explicitly allowed; only
 * repository overlap is rejected. Same realpath-aware comparison as
 * {@link assertDataDirDisjointFromRepositories}, so symlinks (including
 * dangling and mid-path links) cannot bypass the check.
 */
export function assertAgyAcpStateDirDisjointFromRepositories(
  stateDir: string,
  repositories: Record<string, { root: string }>
): void {
  for (const [alias, repo] of Object.entries(repositories)) {
    if (pathsOverlap(stateDir, repo.root)) {
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Invalid configuration: agents.agy-acp.state_dir '${stateDir}' overlaps repository '${alias}' root '${repo.root}'. state_dir must be outside every configured repository root (living under server.data_dir is allowed).`,
        { repository: alias, state_dir: stateDir, repository_root: repo.root }
      );
    }
  }
}

/**
 * Validates that a path does not contain traversal segments or suspicious control characters.
 */
export function sanitizeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      `Invalid relative path traversal: '${relativePath}'`
    );
  }
  return normalized;
}
