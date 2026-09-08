import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { RepositoryRegistry } from "../repositories/repository-registry.js";
import { TaskManager } from "../orchestration/task-manager.js";
import { GitService } from "../repositories/git-service.js";
import { VerificationService } from "../verification/verification-service.js";
import { WorkspaceManager } from "../repositories/workspace-manager.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { assertPathContained } from "../security/path-policy.js";

export interface ToolServices {
  agentRegistry: AgentRegistry;
  repoRegistry: RepositoryRegistry;
  taskManager: TaskManager;
  gitService: GitService;
  verificationService: VerificationService;
  workspaceManager: WorkspaceManager;
}

function handleToolError(err: unknown) {
  if (err instanceof CodingAgentError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(err.toJSON(), null, 2),
        },
      ],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: ErrorCodes.INTERNAL_ERROR,
              message,
            },
          },
          null,
          2
        ),
      },
    ],
  };
}

export function registerTools(server: McpServer, services: ToolServices): void {
  // 1. list_agents
  server.tool(
    "list_agents",
    "Returns configured coding agents and their local availability",
    {},
    async () => {
      try {
        const agents = await services.agentRegistry.listAgents();
        return {
          content: [{ type: "text", text: JSON.stringify({ agents }, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 2. list_repositories
  server.tool(
    "list_repositories",
    "Returns configured repository aliases and safe metadata",
    {},
    async () => {
      try {
        const repositories = services.repoRegistry.listRepositories();
        return {
          content: [{ type: "text", text: JSON.stringify({ repositories }, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 3. start_task
  server.tool(
    "start_task",
    "Starts a coding-agent task in a configured repository workspace",
    {
      repository: z.string().describe("Configured repository alias"),
      agent: z.string().describe("Agent identifier (e.g. 'muse', 'agy')"),
      instruction: z.string().describe("Natural-language coding instruction"),
      mode: z.enum(["implement", "review", "investigate"]).optional().describe("Task execution mode"),
      workspace_strategy: z.enum(["worktree", "in_place"]).optional().describe("Workspace strategy"),
    },
    async (args) => {
      try {
        const result = await services.taskManager.startTask({
          repository: args.repository,
          agent: args.agent,
          instruction: args.instruction,
          mode: args.mode,
          workspace_strategy: args.workspace_strategy,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 4. continue_task
  server.tool(
    "continue_task",
    "Sends follow-up instructions to an existing task session",
    {
      task_id: z.string().describe("Existing task ID"),
      instruction: z.string().describe("Follow-up instruction for the agent"),
    },
    async (args) => {
      try {
        const result = await services.taskManager.continueTask({
          task_id: args.task_id,
          instruction: args.instruction,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 5. get_task
  server.tool(
    "get_task",
    "Returns task state and concise metadata",
    {
      task_id: z.string().describe("Task ID to query"),
    },
    async (args) => {
      try {
        const task = services.taskManager.getTask(args.task_id);
        const result = {
          task_id: task.id,
          status: task.status,
          agent: task.agentId,
          repository: task.repositoryId,
          instruction: task.instruction,
          started_at: task.startedAt,
          finished_at: task.finishedAt,
          exit_code: task.exitCode,
          session_resumable: task.sessionResumable,
          base_sha: task.baseSha,
          failure: task.failure,
          workspace_strategy: task.workspaceStrategy,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 6. get_task_output
  server.tool(
    "get_task_output",
    "Returns bounded task output with pagination cursor support",
    {
      task_id: z.string().describe("Task ID"),
      cursor: z.number().int().nonnegative().optional().describe("Byte offset to start reading"),
      max_bytes: z.number().int().positive().optional().describe("Maximum bytes to read (default 20000)"),
    },
    async (args) => {
      try {
        const result = services.taskManager.getTaskOutput(
          args.task_id,
          args.cursor,
          args.max_bytes
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 7. cancel_task
  server.tool(
    "cancel_task",
    "Cancels a running coding-agent task",
    {
      task_id: z.string().describe("Task ID to cancel"),
    },
    async (args) => {
      try {
        const result = await services.taskManager.cancelTask(args.task_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 8. get_repo_status
  server.tool(
    "get_repo_status",
    "Returns structured Git status for a task workspace or configured repository",
    {
      task_id: z.string().optional().describe("Task ID (queries task workspace)"),
      repository: z.string().optional().describe("Repository alias (queries repository root)"),
    },
    async (args) => {
      try {
        let cwd: string;
        let baseSha: string | undefined = undefined;

        if (args.task_id) {
          const task = services.taskManager.getTask(args.task_id);
          cwd = task.workspaceRoot;
          baseSha = task.baseSha;
          assertPathContained(cwd, task.workspaceRoot);
        } else if (args.repository) {
          const repo = services.repoRegistry.getRepository(args.repository);
          cwd = repo.root;
          assertPathContained(cwd, repo.root);
        } else {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            "Either task_id or repository must be provided to get_repo_status"
          );
        }

        const status = await services.gitService.getStatus(cwd, baseSha);
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 9. get_diff
  server.tool(
    "get_diff",
    "Returns the Git diff for a task workspace or configured repository (including committed changes since task base SHA and untracked files)",
    {
      task_id: z.string().optional().describe("Task ID (queries task workspace)"),
      repository: z.string().optional().describe("Repository alias (queries repository root)"),
      staged: z.boolean().optional().describe("Check staged changes (default false)"),
      max_bytes: z.number().int().positive().optional().describe("Max bytes for diff output (default 100000)"),
    },
    async (args) => {
      try {
        let cwd: string;
        let baseSha: string | undefined = undefined;

        if (args.task_id) {
          const task = services.taskManager.getTask(args.task_id);
          cwd = task.workspaceRoot;
          baseSha = task.baseSha;
          assertPathContained(cwd, task.workspaceRoot);
        } else if (args.repository) {
          const repo = services.repoRegistry.getRepository(args.repository);
          cwd = repo.root;
          assertPathContained(cwd, repo.root);
        } else {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            "Either task_id or repository must be provided to get_diff"
          );
        }

        const diffResult = await services.gitService.getDiff(cwd, {
          baseSha,
          staged: args.staged,
          max_bytes: args.max_bytes,
          includeUntracked: true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(diffResult, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );

  // 10. run_verification
  server.tool(
    "run_verification",
    "Runs a configured verification profile (e.g. test, lint) in a task workspace or repository",
    {
      task_id: z.string().optional().describe("Task ID (runs in task workspace)"),
      repository: z.string().optional().describe("Repository alias"),
      profile: z.string().describe("Configured verification profile name"),
    },
    async (args) => {
      try {
        let cwd: string;
        let repoAlias: string;

        if (args.task_id) {
          const task = services.taskManager.getTask(args.task_id);
          cwd = task.workspaceRoot;
          repoAlias = task.repositoryId;
          assertPathContained(cwd, task.workspaceRoot);
        } else if (args.repository) {
          const repo = services.repoRegistry.getRepository(args.repository);
          cwd = repo.root;
          repoAlias = args.repository;
          assertPathContained(cwd, repo.root);
        } else {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            "Either task_id or repository must be provided to run_verification"
          );
        }

        const repoConfig = services.repoRegistry.getRepository(repoAlias);
        const profileConfig = repoConfig.verification_profiles[args.profile];

        if (!profileConfig) {
          throw new CodingAgentError(
            ErrorCodes.VERIFICATION_PROFILE_NOT_FOUND,
            `Verification profile '${args.profile}' not configured for repository '${repoAlias}'`,
            { profile: args.profile, repository: repoAlias }
          );
        }

        const result = await services.verificationService.runVerification(
          args.profile,
          {
            command: profileConfig.command,
            timeoutSeconds: profileConfig.timeout_seconds,
            env: profileConfig.env,
          },
          cwd
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return handleToolError(err);
      }
    }
  );
}
