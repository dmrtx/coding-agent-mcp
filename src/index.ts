#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config-loader.js";
import { TaskStore } from "./persistence/task-store.js";
import { AuditStore } from "./persistence/audit-store.js";
import { GitService } from "./repositories/git-service.js";
import { WorkspaceManager } from "./repositories/workspace-manager.js";
import { RepositoryRegistry } from "./repositories/repository-registry.js";
import { AgentRegistry } from "./agents/agent-registry.js";
import { ProcessManager } from "./orchestration/process-manager.js";
import { VerificationService } from "./verification/verification-service.js";
import { TaskManager } from "./orchestration/task-manager.js";
import { createMcpServer } from "./server/mcp-server.js";

async function main() {
  const args = process.argv.slice(2);
  let configPath: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[i + 1];
      i++;
    }
  }

  const config = loadConfig(configPath);

  const taskStore = new TaskStore(config.server.data_dir);
  const recoveredCount = taskStore.recoverOnStartup();
  if (recoveredCount > 0) {
    console.error(`[coding-agent-mcp] Recovered and marked ${recoveredCount} interrupted tasks as failed.`);
  }

  const auditStore = new AuditStore(config.server.data_dir);
  const gitService = new GitService();
  const workspaceManager = new WorkspaceManager(config.server.data_dir, gitService);

  // Prune any stale worktrees older than 24 hours on startup
  try {
    const prunedCount = await workspaceManager.pruneOldWorktrees(
      86_400_000,
      Object.values(config.repositories).map((r) => r.root)
    );
    if (prunedCount > 0) {
      console.error(`[coding-agent-mcp] Pruned ${prunedCount} stale worktrees on startup.`);
    }
  } catch {
    // Non-blocking prune error
  }

  const repoRegistry = new RepositoryRegistry(config);
  const agentRegistry = new AgentRegistry(config);
  const processManager = new ProcessManager(config.server.workspace_grace_period_ms);
  const verificationService = new VerificationService(
    config.server.default_task_timeout_seconds,
    config.server.output_limit_bytes
  );

  const taskManager = new TaskManager(
    config,
    repoRegistry,
    workspaceManager,
    agentRegistry,
    processManager,
    taskStore,
    auditStore
  );

  const server = createMcpServer({
    agentRegistry,
    repoRegistry,
    taskManager,
    gitService,
    verificationService,
    workspaceManager,
  });

  const transport = new StdioServerTransport();

  const shutdown = async () => {
    console.error("[coding-agent-mcp] Shutting down, terminating active worker processes...");
    try {
      await processManager.shutdown();
    } catch {
      // Non-blocking shutdown error
    }
    taskStore.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);
  console.error("[coding-agent-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[coding-agent-mcp] Fatal startup error:", err);
  process.exit(1);
});
