import { z } from "zod";

export const VerificationProfileConfigSchema = z.object({
  command: z.array(z.string()).min(1, "Verification profile command must not be empty"),
  timeout_seconds: z.number().int().positive().default(900),
  env: z.record(z.string(), z.string()).optional(),
});

export const RepositoryConfigSchema = z.object({
  root: z.string().min(1, "Repository root path is required"),
  writable: z.boolean().default(true),
  allow_in_place: z.boolean().default(false),
  default_workspace_strategy: z.enum(["worktree", "in_place"]).default("worktree"),
  default_branch: z.string().optional(),
  verification_profiles: z.record(z.string(), VerificationProfileConfigSchema).default({}),
});

export const AgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  executable: z.string().optional(),
  sandbox: z.boolean().default(true),
  default_timeout_seconds: z.number().int().positive().default(1800),
  env_allowlist: z
    .array(z.string())
    .default(["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"]),
  extra_args: z.array(z.string()).optional(),
});

// Direct AGY CLI execution through agy-gyro. This is intentionally separate
// from both account-backed `agy` and the experimental ACP kernel adapter.
export const AgyGeminiConfigSchema = AgentConfigSchema.extend({
  enabled: z.boolean().default(false),
  executable: z.string().min(1).default("agy-gyro"),
  agy_executable: z.string().min(1).default("agy"),
  gyro_args: z.array(z.string()).default([]),
  env_allowlist: z
    .array(z.string())
    .default(["PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "GEMINI_API_KEY"]),
});

// Experimental, opt-in Antigravity ACP integration. The adapter launches an
// operator-provided ACP kernel (optionally through a wrapper such as
// `agy-gyro`) over JSON-RPC/NDJSON and is managed by TaskManager. Legacy
// `agents.agy` behavior remains unchanged.
export const AgyAcpAuthMethodSchema = z.enum([
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
]);

export const AgyAcpModeSchema = z.enum(["default", "auto_edit", "yolo"]);

export const AgyAcpConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    acp_executable: z.string().min(1, "ACP executable path or command is required").default("agy_acp_server"),
    acp_args: z.array(z.string()).default([]),
    auth_method: AgyAcpAuthMethodSchema.default("oauth-personal"),
    model: z.string().min(1).optional(),
    mode: AgyAcpModeSchema.default("default"),
    allow_write_worktree: z.boolean().default(false),
    state_dir: z.string().min(1, "ACP state directory is required").default("~/.coding-agent-mcp/agy-acp"),
    default_timeout_seconds: z.number().int().positive().default(1800),
    env_allowlist: z
      .array(z.string())
      .default(["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"]),
  })
  .refine((value) => !(value.mode === "yolo" && value.allow_write_worktree !== true), {
    message:
      "agents.agy-acp: mode 'yolo' is unsafe unless allow_write_worktree is explicitly set to true",
    path: ["mode"],
  });

export const AGY_ACP_CONFIG_DEFAULTS = {
  enabled: false,
  acp_executable: "agy_acp_server",
  acp_args: [],
  auth_method: "oauth-personal",
  mode: "default",
  allow_write_worktree: false,
  state_dir: "~/.coding-agent-mcp/agy-acp",
  default_timeout_seconds: 1800,
  env_allowlist: ["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"],
} as const;

export const ServerConfigSchema = z.object({
  data_dir: z.string().default("~/.coding-agent-mcp"),
  max_concurrent_tasks: z.number().int().positive().default(2),
  default_task_timeout_seconds: z.number().int().positive().default(1800),
  output_limit_bytes: z.number().int().positive().default(5_000_000),
  workspace_grace_period_ms: z.number().int().positive().default(3000),
});

export const AppConfigSchema = z.object({
  server: ServerConfigSchema.default({
    data_dir: "~/.coding-agent-mcp",
    max_concurrent_tasks: 2,
    default_task_timeout_seconds: 1800,
    output_limit_bytes: 5_000_000,
    workspace_grace_period_ms: 3000,
  }),
  // Known agent keys have dedicated schemas; any other agent key falls back
  // to the legacy generic AgentConfigSchema via catchall, preserving existing
  // behavior for custom agents. `agy-acp` is experimental, opt-in, and
  // disabled by default.
  //
  // Omission semantics match the historical z.record shape exactly: an
  // explicitly provided `agents` object keeps ONLY the keys the operator
  // listed (no backfilling of omitted agents). Whole-`agents` defaults
  // (muse + agy + disabled agy-gemini/agy-acp) apply solely when `agents`
  // itself is omitted, via the outer `.default(...)` below.
  agents: z
    .object({
      muse: AgentConfigSchema.optional(),
      agy: AgentConfigSchema.optional(),
      "agy-gemini": AgyGeminiConfigSchema.optional(),
      "agy-acp": AgyAcpConfigSchema.optional(),
    })
    // Union catchall: unknown agent keys keep legacy generic parsing, while
    // the union also keeps the object output (with its `agy-acp` member)
    // assignable for defaults.
    .catchall(z.union([AgentConfigSchema, AgyGeminiConfigSchema, AgyAcpConfigSchema]))
    .default({
      muse: {
        enabled: true,
        executable: "muse",
        sandbox: true,
        default_timeout_seconds: 1800,
        env_allowlist: ["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"],
      },
      agy: {
        enabled: true,
        executable: "agy",
        sandbox: true,
        default_timeout_seconds: 1800,
        env_allowlist: ["HOME", "PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM"],
      },
      "agy-gemini": {
        enabled: false,
        executable: "agy-gyro",
        agy_executable: "agy",
        gyro_args: [],
        sandbox: true,
        default_timeout_seconds: 1800,
        env_allowlist: ["PATH", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "GEMINI_API_KEY"],
      },
      "agy-acp": {
        ...AGY_ACP_CONFIG_DEFAULTS,
        acp_args: [...AGY_ACP_CONFIG_DEFAULTS.acp_args],
        env_allowlist: [...AGY_ACP_CONFIG_DEFAULTS.env_allowlist],
      },
    }),
  repositories: z.record(z.string(), RepositoryConfigSchema).default({}),
});

export type VerificationProfileConfig = z.infer<typeof VerificationProfileConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgyGeminiConfig = z.infer<typeof AgyGeminiConfigSchema>;
export type AgyAcpAuthMethod = z.infer<typeof AgyAcpAuthMethodSchema>;
export type AgyAcpMode = z.infer<typeof AgyAcpModeSchema>;
export type AgyAcpConfig = z.infer<typeof AgyAcpConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
