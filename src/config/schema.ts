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
  agents: z.record(z.string(), AgentConfigSchema).default({
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
  }),
  repositories: z.record(z.string(), RepositoryConfigSchema).default({}),
});

export type VerificationProfileConfig = z.infer<typeof VerificationProfileConfigSchema>;
export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
