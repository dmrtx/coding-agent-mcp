export const DEFAULT_ALLOWED_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE_ENV",
];

/**
 * Filters the parent environment variables using an allowlist,
 * ensuring no sensitive host keys or secrets leak to agent processes.
 */
export function sanitizeEnvironment(
  allowlist: string[] = DEFAULT_ALLOWED_ENV,
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  const allowedSet = new Set(allowlist);

  for (const key of allowedSet) {
    if (process.env[key] !== undefined) {
      sanitized[key] = process.env[key] as string;
    }
  }

  for (const [key, value] of Object.entries(extraEnv)) {
    sanitized[key] = value;
  }

  return sanitized;
}
