/**
 * T3 MCP tools — Phase 1 additive integration.
 *
 * Security hardening enforced here:
 *
 * AUTHORIZATION: Every tool operating on an EXISTING thread verifies that the
 * T3 project's workspaceRoot maps to a repository configured in this server.
 * Thread IDs are NOT authorization tokens.
 *
 * WRITE POLICY: t3_start_task enforces repo.writable = true and rejects
 * in_place strategy (Phase 1 requires worktree isolation).
 *
 * WORKTREE-ONLY RESUME: t3_continue_task, t3_respond_approval, and
 * t3_respond_user_input reject in-place threads (they advance agent execution
 * and require worktree-backed sessions). t3_get_task, t3_cancel_task, and
 * t3_stop_session are allowed for configured in-place threads.
 *
 * TOKEN SAFETY: Token is never logged or surfaced. handleT3ToolError does
 * not re-expose token-containing data.
 *
 * LEGACY TOOLS: Existing direct-agent tools are unmodified.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  T3Client,
  T3ConfigError,
  T3HttpError,
  T3ModelSelection,
  T3SnapshotThread,
  redactGenericTokenPatterns,
} from "./t3-client.js";
import { authorizeThread, authorizeProject, isWorktreeThread, T3AuthorizedRepo } from "./t3-auth.js";
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
            { error: { code: "T3_DISABLED_OR_MISCONFIGURED", message: err.message } },
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
                // safeBody is already fully redacted by T3Client
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
      content: [{ type: "text" as const, text: JSON.stringify(err.toJSON(), null, 2) }],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: { code: ErrorCodes.INTERNAL_ERROR, message: redactGenericTokenPatterns(message) } },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * Require a live T3Client, throwing T3ConfigError if disabled.
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
// Policy helpers
// --------------------------------------------------------------------------

/**
 * Asserts that the repository is writable (respects repo.writable policy).
 */
function assertRepoWritable(repoAlias: string, repo: { writable: boolean }): void {
  if (!repo.writable) {
    throw new CodingAgentError(
      ErrorCodes.REPOSITORY_NOT_WRITABLE,
      `Repository '${repoAlias}' is configured as read-only (writable: false). ` +
        `T3-backed task creation requires a writable repository.`
    );
  }
}

/**
 * Phase 1 security decision: T3-backed task creation is WORKTREE ONLY.
 *
 * The legacy WorkspaceManager in-place path includes allow_in_place policy,
 * clean-tree validation, and an exclusive in-place lifecycle lock that the
 * HTTP-only T3 integration cannot safely reproduce/release yet.
 *
 * An in_place workspace_strategy (explicit or from repo default) is rejected
 * unless the caller explicitly requests worktree.
 */
function assertWorktreeStrategy(
  effectiveStrategy: string,
  callerRequestedStrategy: string | undefined,
  repoAlias: string
): void {
  if (effectiveStrategy === "in_place") {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      callerRequestedStrategy === "in_place"
        ? `T3 Phase 1 requires worktree isolation for task creation. ` +
            `The 'in_place' workspace strategy is not permitted via the T3 path in Phase 1 ` +
            `because the HTTP-only integration cannot safely acquire and release the ` +
            `WorkspaceManager in-place lifecycle lock. ` +
            `Use workspace_strategy: worktree instead.`
        : `Repository '${repoAlias}' defaults to workspace_strategy: in_place, ` +
            `which is not allowed for T3-backed task creation in Phase 1. ` +
            `Explicitly pass workspace_strategy: worktree to override.`
    );
  }
}

/**
 * Asserts a thread is worktree-backed for operations that resume agent execution.
 * Called for t3_continue_task, t3_respond_approval, t3_respond_user_input.
 */
function assertWorktreeThread(thread: T3SnapshotThread): void {
  if (!isWorktreeThread(thread)) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      `This T3 thread is running in-place (no worktree branch or path set). ` +
        `Operations that resume or advance agent execution ` +
        `(continue, respond to approval/user-input) require a worktree-backed thread ` +
        `in Phase 1. Use t3_cancel_task or t3_stop_session to terminate the session.`
    );
  }
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
    "Returns T3 connectivity status, auth/scope info, and orchestration reachability. " +
      "Project and thread counts are filtered to repositories configured in this server. " +
      "Does not expose unconfigured project paths or the access token.",
    {},
    async () => {
      try {
        const client = requireT3Client(services.t3Client);
        const session = await client.getSession();

        const REQUIRED_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
        const grantedScopes: string[] = session.scopes ?? [];
        const requiredScopesOk = REQUIRED_SCOPES.every((s) => grantedScopes.includes(s));

        // Snapshot call — counts only configured repos/threads
        let snapshotOk = false;
        let configuredProjectCount: number | undefined;
        let configuredThreadCount: number | undefined;

        try {
          const snapshot = await client.getSnapshot();
          snapshotOk = true;

          // Filter to T3 projects whose workspaceRoot maps to a configured repo
          const configuredProjectIds = new Set<string>();
          for (const project of snapshot.projects) {
            try {
              authorizeProject(project, services.repoRegistry);
              configuredProjectIds.add(project.id);
            } catch {
              // Not configured — skip without exposing the path
            }
          }
          configuredProjectCount = configuredProjectIds.size;
          configuredThreadCount = snapshot.threads.filter((t) =>
            configuredProjectIds.has(t.projectId)
          ).length;
        } catch (snapErr) {
          if (snapErr instanceof T3ConfigError || snapErr instanceof T3HttpError) {
            // snapshot not reachable — non-fatal
          }
          // Other errors (e.g. snapshotOk remains false) are fine
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  t3_enabled: true,
                  base_url: client.getBaseUrl(),
                  server_reachable: snapshotOk || session.authenticated,
                  authenticated: session.authenticated,
                  scopes: grantedScopes.length > 0 ? grantedScopes : null,
                  required_scopes_ok: requiredScopesOk,
                  session_method: session.sessionMethod ?? null,
                  expires_at: session.expiresAt ? String(session.expiresAt) : null,
                  orchestration_snapshot_ok: snapshotOk,
                  // Counts filtered to configured repos only
                  configured_project_count: configuredProjectCount ?? null,
                  configured_thread_count: configuredThreadCount ?? null,
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
    "Starts a new T3-managed coding-agent task (worktree-only in Phase 1). " +
      "T3 owns the session, turn, worktree, and state. Returns immediately with the T3 thread id.",
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
        .describe(
          "Workspace strategy. Only 'worktree' is permitted in T3 Phase 1. " +
            "Omit to use repository default (which must also be worktree)."
        ),
      title: z.string().optional().describe("Optional thread title (auto-derived if omitted)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        // Resolve repository through RepositoryRegistry — no caller-supplied paths.
        const repo = services.repoRegistry.getRepository(args.repository);

        // FIX 2a: Enforce writable policy
        assertRepoWritable(args.repository, repo);

        // FIX 2b: Phase 1 — worktree only; reject in_place (explicit or default)
        const effectiveStrategy = args.workspace_strategy ?? repo.default_workspace_strategy;
        assertWorktreeStrategy(effectiveStrategy, args.workspace_strategy, args.repository);

        // After assertWorktreeStrategy, effectiveStrategy === "worktree"
        if (!repo.default_branch) {
          throw new CodingAgentError(
            ErrorCodes.POLICY_DENIED,
            `Worktree workspace strategy requires 'default_branch' to be configured for ` +
              `repository '${args.repository}'. ` +
              `Add 'default_branch: <branch>' to the repository config.`
          );
        }

        const runtimeMode = args.runtime_mode ?? "approval-required";
        const interactionMode = args.interaction_mode ?? "default";
        const title = args.title ?? deriveTitle(args.repository, args.instruction);

        // Ensure a T3 project exists for this repository
        const projectId = await client.ensureProject(args.repository, repo.root);

        const threadId = crypto.randomUUID();
        const commandId = crypto.randomUUID();
        const messageId = crypto.randomUUID();
        const now = new Date().toISOString();

        const modelSelection: T3ModelSelection = {
          instanceId: args.provider_instance,
          model: args.model,
        };

        // Bootstrap: always createThread + prepareWorktree (worktree-only in Phase 1)
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
          bootstrap: {
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
            prepareWorktree: {
              projectCwd: repo.root,
              baseBranch: repo.default_branch,
              startFromOrigin: true,
            },
          },
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
                  workspace_strategy: "worktree",
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
    "Sends a follow-up instruction to an existing T3-managed worktree thread. " +
      "Requires the thread to belong to a configured repository (writable). " +
      "Reuses thread model/runtime/interaction state (including model options) unless model is overridden.",
    {
      thread_id: z.string().describe("Existing T3 thread id"),
      instruction: z.string().describe("Follow-up instruction for the agent"),
      model: z
        .string()
        .optional()
        .describe(
          "Override model (keeps same instance id and clears model-specific options; " +
            "omit to reuse current model and all model selection options)"
        ),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        // FIX 1: Authorize — fetch thread + find project + map to configured repo
        const threadSnapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        const thread = threadSnapshot.thread;
        const { authorizedRepo } = await authorizeThread(
          client,
          args.thread_id,
          services.repoRegistry,
          thread
        );

        // FIX 2: Writable check
        assertRepoWritable(authorizedRepo.alias, authorizedRepo.config);

        // FIX 2: Phase 1 — reject in-place threads for operations that resume execution
        assertWorktreeThread(thread);

        // FIX 5: Preserve entire modelSelection (including options) on normal continue
        let modelSelection: T3ModelSelection;
        if (args.model !== undefined) {
          // Explicit override: keep instanceId, use new model, do NOT carry options
          // (options may be model-specific and could be invalid for a different model)
          modelSelection = {
            instanceId: thread.modelSelection.instanceId,
            model: args.model,
          };
        } else {
          // Preserve the full existing modelSelection including options
          modelSelection = { ...thread.modelSelection };
        }

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
          modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
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
                  model_used: modelSelection.model,
                  instance_id: modelSelection.instanceId,
                  model_options_preserved: args.model === undefined && modelSelection.options !== undefined,
                  runtime_mode: thread.runtimeMode,
                  interaction_mode: thread.interactionMode,
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
    "Returns the current state of a T3-managed thread. Requires the thread to belong to a configured repository. " +
      "Allowed for both worktree and in-place threads.",
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

        // Fetch with actual turn limit for display
        const snapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit });
        const thread = snapshot.thread;

        // FIX 1: Authorize (reuse already-fetched thread)
        await authorizeThread(client, args.thread_id, services.repoRegistry, thread);

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
          recent_messages: thread.messages.slice(-20),
          recent_activities: thread.activities.slice(-50),
          checkpoints: thread.checkpoints,
          snapshot_sequence: snapshot.snapshotSequence,
          page: snapshot.page ?? null,
          created_at: thread.createdAt,
          updated_at: thread.updatedAt,
        };

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
    "Interrupts a running T3 turn. Requires the thread to belong to a configured repository. " +
      "Allowed for both worktree and in-place threads. " +
      "If turn_id is omitted, fetches the thread to find the active turn id.",
    {
      thread_id: z.string().describe("T3 thread id"),
      turn_id: z.string().optional().describe("Turn id to interrupt (auto-resolved if omitted)"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        let turnId = args.turn_id;
        let thread: T3SnapshotThread | undefined;

        // FIX 1: Must always authorize, even when turn_id is explicitly provided.
        // Fetch the thread first for both authorization and turn_id resolution.
        const threadSnapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        thread = threadSnapshot.thread;

        // Authorize (reuse the fetched thread)
        await authorizeThread(client, args.thread_id, services.repoRegistry, thread);

        // Resolve turnId from active session if not supplied
        if (!turnId) {
          const activeTurnId = thread.session?.activeTurnId ?? null;
          if (activeTurnId) {
            turnId = activeTurnId;
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
    "Responds to a pending T3 approval request from the coding agent. " +
      "Requires the thread to belong to a configured writable worktree repository.",
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

        // FIX 1: Authorize
        const threadSnapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        const thread = threadSnapshot.thread;
        const { authorizedRepo } = await authorizeThread(
          client,
          args.thread_id,
          services.repoRegistry,
          thread
        );

        // FIX 2: Writable + worktree required (resumes execution)
        assertRepoWritable(authorizedRepo.alias, authorizedRepo.config);
        assertWorktreeThread(thread);

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
    "Responds to a pending T3 user-input (question/form) request from the coding agent. " +
      "Requires the thread to belong to a configured writable worktree repository.",
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

        // FIX 1: Authorize
        const threadSnapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        const thread = threadSnapshot.thread;
        const { authorizedRepo } = await authorizeThread(
          client,
          args.thread_id,
          services.repoRegistry,
          thread
        );

        // FIX 2: Writable + worktree required (resumes execution)
        assertRepoWritable(authorizedRepo.alias, authorizedRepo.config);
        assertWorktreeThread(thread);

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
    "Stops the T3 provider session associated with a thread (graceful session teardown). " +
      "Requires the thread to belong to a configured repository. Allowed for in-place threads.",
    {
      thread_id: z.string().describe("T3 thread id"),
    },
    async (args) => {
      try {
        const client = requireT3Client(services.t3Client);

        // FIX 1: Authorize (in-place allowed)
        const threadSnapshot = await client.getThreadSnapshot(args.thread_id, { turnLimit: 1 });
        const thread = threadSnapshot.thread;
        await authorizeThread(client, args.thread_id, services.repoRegistry, thread);

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
