/**
 * T3 MCP tools — Phase 1 additive integration.
 *
 * All t3_* tools route through T3Client (HTTP) to the T3 server.
 * They never call Muse/AGY directly, never accept arbitrary paths from callers,
 * and never log or expose bearer tokens.
 *
 * Existing direct-agent tools (start_task, continue_task, …) are unmodified.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { T3Client, T3ConfigError, T3HttpError } from "./t3-client.js";
import { RepositoryRegistry } from "../repositories/repository-registry.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

export interface T3ToolServices {
  t3Client: T3Client | null;
  repoRegistry: RepositoryRegistry;
}

// --------------------------------------------------------------------------
// Shared error handler — mirrors handleToolError in tool-registry.ts
// --------------------------------------------------------------------------

function handleT3ToolError(err: unknown) {
  if (err instanceof T3ConfigError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: {
                code: "T3_DISABLED_OR_MISCONFIGURED",
                message: err.message,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (err instanceof T3HttpError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              error: {
                code: "T3_HTTP_ERROR",
                httpStatus: err.status,
                // safeBody already redacted by T3Client
                detail: err.safeBody,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }

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

/**
 * Require a live T3Client, throwing a T3ConfigError if it's null (disabled).
 */
function requireT3Client(client: T3Client | null): T3Client {
  if (!client) {
    throw new T3ConfigError(
      "T3 integration is not enabled. Set t3.enabled: true and provide the access token " +
        "environment variable specified in t3.access_token_env in your server config."
    );
  }
  return client;
}

// --------------------------------------------------------------------------
// Derive a concise deterministic title
// --------------------------------------------------------------------------

function deriveTitle(repository: string, instruction: string, maxLen = 80): string {
  const base = `${repository}: ${instruction}`;
  return base.length <= maxLen ? base : base.slice(0, maxLen - 1) + "…";
}

// --------------------------------------------------------------------------
// Register all t3_* tools
// --------------------------------------------------------------------------

export function registerT3Tools(server: McpServer, services: T3ToolServices): void {
  // -----------------------------------------------------------------------
  // t3_status — connectivity and session info
  // -----------------------------------------------------------------------
  server.tool(
    "t3_status",
    "Returns T3 connectivity status, auth info, and orchestration reachability. Does not require a running task.",
    {},
    async () => {
      try {
        const client = requireT3Client(services.t3Client);
        const session = await client.getSession();

        // Lightweight snapshot call to confirm orchestration scope is working
        let snapshotOk = false;
        let projectCount: number | undefined = undefined;
        let threadCount: number | undefined = undefined;
        try {
          const snapshot = await client.getSnapshot();
          snapshotOk = true;
          projectCount = snapshot.projects.length;
          threadCount = snapshot.threads.length;
        } catch {
          // non-fatal — auth check already passed
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  t3_enabled: true,
                  authenticated: session.authenticated,
                  scopes: session.scopes ?? null,
                  session_method: session.sessionMethod ?? null,
                  // expiresAt is an Effect/Schema DateTimeUtc object; convert to string if present
                  expires_at: session.expiresAt ? String(session.expiresAt) : null,
                  orchestration_snapshot_ok: snapshotOk,
                  project_count: projectCount,
                  thread_count: threadCount,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_start_task — create T3 thread + start a turn
  // -----------------------------------------------------------------------
  server.tool(
    "t3_start_task",
    "Starts a new T3-managed coding-agent task. T3 owns the session, turn, worktree, and state. Returns immediately with the T3 thread id.",
    {
      repository: z.string().describe("Configured repository alias (from server config)"),
      provider_instance: z
        .string()
        .describe("T3 provider instance id (e.g. 'muse' or 'antigravity')"),
      model: z.string().describe("Model name (e.g. 'claude-3-7-sonnet-latest')"),
      instruction: z.string().describe("Natural-language coding instruction for the agent"),
      runtime_mode: z
        .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
        .optional()
        .describe("Runtime safety mode (default: approval-required)"),
      interaction_mode: z
        .enum(["default", "plan"])
        .optional()
        .describe("Interaction mode (default: default)"),
      workspace_strategy: z
        .enum(["worktree", "in_place"])
        .optional()
        .describe("Workspace strategy (defaults to repository config)"),
      title: z.string().optional().describe("Optional thread title (auto-derived if omitted)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        // Resolve repository through RepositoryRegistry — no caller-supplied paths.
        const repo = services.repoRegistry.getRepository(args.repository);

        const strategy = args.workspace_strategy ?? repo.default_workspace_strategy;
        const runtimeMode = args.runtime_mode ?? "approval-required";
        const interactionMode = args.interaction_mode ?? "default";
        const title = args.title ?? deriveTitle(args.repository, args.instruction);

        // Ensure a T3 project exists for this repository
        const projectId = await client.ensureProject(args.repository, repo.root);

        const threadId = crypto.randomUUID();
        const commandId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const now = new Date().toISOString();

        const modelSelection = {
          instanceId: args.provider_instance,
          model: args.model,
        };

        // Build bootstrap — always includes createThread
        const bootstrap: Record<string, unknown> = {
          createThread: {
            projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
        };

        // For worktree strategy, include prepareWorktree
        if (strategy === "worktree") {
          if (!repo.default_branch) {
            throw new CodingAgentError(
              ErrorCodes.POLICY_DENIED,
              `Worktree workspace strategy requires 'default_branch' to be configured for repository '${args.repository}'. ` +
                `Add 'default_branch: <branch>' to the repository config or use 'workspace_strategy: in_place'.`
            );
          }
          bootstrap.prepareWorktree = {
            projectCwd: repo.root,
            baseBranch: repo.default_branch,
            startFromOrigin: true,
          };
        }

        const command = {
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId,
            role: "user",
            text: args.instruction,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode,
          bootstrap,
          createdAt: now,
        };

        const result = await client.dispatch(command);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: threadId,
                  project_id: projectId,
                  dispatch_sequence: result.sequence,
                  title,
                  runtime_mode: runtimeMode,
                  interaction_mode: interactionMode,
                  workspace_strategy: strategy,
                  provider_instance: args.provider_instance,
                  model: args.model,
                  status: "dispatched",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_continue_task — send a follow-up instruction to an existing T3 thread
  // -----------------------------------------------------------------------
  server.tool(
    "t3_continue_task",
    "Sends a follow-up instruction to an existing T3-managed thread. Reuses the thread's model/runtime/interaction state unless overridden.",
    {
      thread_id: z.string().describe("Existing T3 thread id"),
      instruction: z.string().describe("Follow-up instruction for the agent"),
      model: z
        .string()
        .optional()
        .describe("Override model (keeps same instance id; omit to reuse current model)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        // Fetch thread to reuse state
        const snapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        const thread = snapshot.thread;

        const instanceId = thread.modelSelection.instanceId;
        const model = args.model ?? thread.modelSelection.model;
        const runtimeMode = thread.runtimeMode;
        const interactionMode = thread.interactionMode;

        const commandId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const now = new Date().toISOString();

        const command = {
          type: "thread.turn.start",
          commandId,
          threadId: args.thread_id,
          message: {
            messageId,
            role: "user",
            text: args.instruction,
            attachments: [],
          },
          modelSelection: {
            instanceId,
            model,
          },
          runtimeMode,
          interactionMode,
          // No bootstrap on continue
          createdAt: now,
        };

        const result = await client.dispatch(command);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: args.thread_id,
                  dispatch_sequence: result.sequence,
                  model_used: model,
                  instance_id: instanceId,
                  runtime_mode: runtimeMode,
                  interaction_mode: interactionMode,
                  status: "dispatched",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_get_task — read thread state/snapshot
  // -----------------------------------------------------------------------
  server.tool(
    "t3_get_task",
    "Returns the current state of a T3-managed thread, including model, runtime mode, latest turn, session, recent messages, activities, and checkpoints.",
    {
      thread_id: z.string().describe("T3 thread id"),
      turn_limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of turns to return (default 10)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);
        const turnLimit = args.turn_limit ?? 10;

        const snapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit });
        const thread = snapshot.thread;

        // Build a bounded, readable summary
        const result = {
          thread_id: thread.id,
          project_id: thread.projectId,
          title: thread.title,
          model_selection: thread.modelSelection,
          runtime_mode: thread.runtimeMode,
          interaction_mode: thread.interactionMode,
          branch: thread.branch,
          worktree_path: thread.worktreePath,
          latest_turn: thread.latestTurn,
          session: thread.session
            ? {
                status: thread.session.status,
                provider_name: thread.session.providerName,
                active_turn_id: thread.session.activeTurnId,
                last_error: thread.session.lastError,
                updated_at: thread.session.updatedAt,
              }
            : null,
          // Bound message list to avoid unbounded output
          recent_messages: (thread.messages as unknown[]).slice(-20),
          recent_activities: (thread.activities as unknown[]).slice(-50),
          checkpoints: thread.checkpoints,
          snapshot_sequence: snapshot.snapshotSequence,
          page: snapshot.page ?? null,
          created_at: thread.createdAt,
          updated_at: thread.updatedAt,
        };

        // Bound the JSON output to avoid overwhelming the MCP caller
        const json = JSON.stringify(result, null, 2);
        const bounded =
          json.length > 120_000
            ? json.slice(0, 120_000) + "\n… [output truncated at 120 KB]"
            : json;

        return {
          content: [{ type: "text" as const, text: bounded }],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_cancel_task — interrupt a running turn
  // -----------------------------------------------------------------------
  server.tool(
    "t3_cancel_task",
    "Interrupts a running T3 turn. If turn_id is omitted, fetches the thread to find the active turn id.",
    {
      thread_id: z.string().describe("T3 thread id"),
      turn_id: z.string().optional().describe("Turn id to interrupt (auto-resolved if omitted)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        let turnId = args.turn_id;

        // Auto-resolve from active session if not supplied
        if (!turnId) {
          try {
            const snapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
            const activeTurnId = snapshot.thread.session?.activeTurnId ?? null;
            if (activeTurnId) {
              turnId = activeTurnId;
            }
          } catch {
            // Continue without turnId — the command still fires
          }
        }

        const command: Record<string, unknown> = {
          type: "thread.turn.interrupt",
          commandId: crypto.randomUUID(),
          threadId: args.thread_id,
          createdAt: new Date().toISOString(),
        };
        if (turnId) {
          command.turnId = turnId;
        }

        const result = await client.dispatch(command);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: args.thread_id,
                  turn_id_interrupted: turnId ?? null,
                  dispatch_sequence: result.sequence,
                  status: "interrupt_dispatched",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_respond_approval — respond to an agent approval request
  // -----------------------------------------------------------------------
  server.tool(
    "t3_respond_approval",
    "Responds to a pending T3 approval request from the coding agent.",
    {
      thread_id: z.string().describe("T3 thread id"),
      request_id: z.string().describe("Approval request id (from thread activities)"),
      decision: z
        .enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"])
        .describe("Approval decision"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        const result = await client.dispatch({
          type: "thread.approval.respond",
          commandId: crypto.randomUUID(),
          threadId: args.thread_id,
          requestId: args.request_id,
          decision: args.decision,
          createdAt: new Date().toISOString(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: args.thread_id,
                  request_id: args.request_id,
                  decision: args.decision,
                  dispatch_sequence: result.sequence,
                  status: "approval_responded",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_respond_user_input — respond to a user-input request
  // -----------------------------------------------------------------------
  server.tool(
    "t3_respond_user_input",
    "Responds to a pending T3 user-input (question/form) request from the coding agent.",
    {
      thread_id: z.string().describe("T3 thread id"),
      request_id: z.string().describe("User-input request id (from thread activities)"),
      answers: z
        .record(z.string(), z.unknown())
        .describe("Answer map keyed by question id, matching the question schema"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        const result = await client.dispatch({
          type: "thread.user-input.respond",
          commandId: crypto.randomUUID(),
          threadId: args.thread_id,
          requestId: args.request_id,
          answers: args.answers,
          createdAt: new Date().toISOString(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: args.thread_id,
                  request_id: args.request_id,
                  dispatch_sequence: result.sequence,
                  status: "user_input_responded",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );

  // -----------------------------------------------------------------------
  // t3_stop_session — stop the provider session for a thread
  // -----------------------------------------------------------------------
  server.tool(
    "t3_stop_session",
    "Stops the T3 provider session associated with a thread (graceful session teardown, not a turn interrupt).",
    {
      thread_id: z.string().describe("T3 thread id"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        const result = await client.dispatch({
          type: "thread.session.stop",
          commandId: crypto.randomUUID(),
          threadId: args.thread_id,
          createdAt: new Date().toISOString(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  thread_id: args.thread_id,
                  dispatch_sequence: result.sequence,
                  status: "session_stop_dispatched",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return handleT3ToolError(err);
      }
    }
  );
}
