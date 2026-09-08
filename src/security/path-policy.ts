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

  let current = abs;
  const missingParts: string[] = [];
  while (!fs.existsSync(current) && current !== path.dirname(current)) {
    missingParts.unshift(path.basename(current));
    current = path.dirname(current);
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
