import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { AppConfig, AppConfigSchema } from "./schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import {
  assertAgyAcpStateDirDisjointFromRepositories,
  assertDataDirDisjointFromRepositories,
} from "../security/path-policy.js";

export function expandHome(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export function findConfigFile(customPath?: string): string | null {
  if (customPath) {
    const resolved = path.resolve(expandHome(customPath));
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    throw new CodingAgentError(
      ErrorCodes.INTERNAL_ERROR,
      `Config file not found at specified path: ${customPath}`
    );
  }

  if (process.env.CODING_AGENT_MCP_CONFIG) {
    const envPath = path.resolve(expandHome(process.env.CODING_AGENT_MCP_CONFIG));
    if (fs.existsSync(envPath)) {
      return envPath;
    }
    throw new CodingAgentError(
      ErrorCodes.INTERNAL_ERROR,
      `Config file specified in CODING_AGENT_MCP_CONFIG not found: ${process.env.CODING_AGENT_MCP_CONFIG}`
    );
  }

  const defaultLocations = [
    path.resolve("./coding-agent-mcp.yaml"),
    path.resolve("./coding-agent-mcp.yml"),
    path.resolve("./coding-agent-mcp.json"),
    path.join(os.homedir(), ".coding-agent-mcp", "config.yaml"),
    path.join(os.homedir(), ".coding-agent-mcp", "config.yml"),
    path.join(os.homedir(), ".coding-agent-mcp", "config.json"),
  ];

  for (const candidate of defaultLocations) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadConfig(customPath?: string, rawOverrides?: Partial<AppConfig>): AppConfig {
  let parsedRaw: Record<string, unknown> = {};

  const configPath = findConfigFile(customPath);
  if (configPath) {
    const content = fs.readFileSync(configPath, "utf-8");
    if (configPath.endsWith(".json")) {
      parsedRaw = JSON.parse(content);
    } else {
      parsedRaw = (yaml.parse(content) as Record<string, unknown>) || {};
    }
  }

  if (rawOverrides) {
    parsedRaw = { ...parsedRaw, ...rawOverrides };
  }

  const parseResult = AppConfigSchema.safeParse(parsedRaw);
  if (!parseResult.success) {
    const errorDetails = parseResult.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new CodingAgentError(
      ErrorCodes.INTERNAL_ERROR,
      `Configuration validation failed: ${errorDetails}`,
      { issues: parseResult.error.issues }
    );
  }

  const config = parseResult.data;
  // Normalize server data_dir
  config.server.data_dir = path.resolve(expandHome(config.server.data_dir));

  // Normalize experimental agy-acp state_dir. May be absent when the
  // operator lists an explicit `agents` subset without `agy-acp`.
  const agyAcp = (config.agents as Record<string, { state_dir?: string }>)["agy-acp"];
  if (agyAcp?.state_dir) {
    agyAcp.state_dir = path.resolve(expandHome(agyAcp.state_dir));
  }

  // Normalize repositories roots
  for (const [alias, repo] of Object.entries(config.repositories)) {
    repo.root = path.resolve(expandHome(repo.root));
  }

  assertDataDirDisjointFromRepositories(config.server.data_dir, config.repositories);

  // Runtime ACP state must never live inside a repository worktree (it
  // would pollute status/diff and risk credential leaks into commits).
  // Living under server.data_dir (the default) stays allowed.
  if (agyAcp?.state_dir) {
    assertAgyAcpStateDirDisjointFromRepositories(agyAcp.state_dir, config.repositories);
  }

  return config;
}
