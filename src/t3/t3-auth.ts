/**
 * T3 repository authorization helpers.
 *
 * Thread IDs are NOT authorization tokens. Every T3 thread operation that
 * can read, advance, or terminate agent state must verify that the T3 project
 * backing the thread maps to a repository configured in this coding-agent-mcp
 * instance.
 *
 * Authorization flow for an existing thread:
 *   1. Fetch thread snapshot (already fetched in most callers; reuse when possible).
 *   2. Find the T3 project matching thread.projectId in the orchestration snapshot.
 *   3. Canonicalize project.workspaceRoot.
 *   4. Look for a configured repository whose canonical root matches.
 *   5. If none found → throw POLICY_DENIED (do not expose the unconfigured root).
 */

import { RepositoryRegistry } from "../repositories/repository-registry.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { T3Client, T3SnapshotProject, T3Snapshot, T3SnapshotThread } from "./t3-client.js";
import type { RepositoryConfig } from "../config/schema.js";

/** Result of a successful repository authorization check. */
export interface T3AuthorizedRepo {
  alias: string;
  config: RepositoryConfig;
  project: T3SnapshotProject;
}

/**
 * Authorizes a T3 project by matching its workspaceRoot to a configured
 * repository using canonical path comparison.
 *
 * Throws POLICY_DENIED if the project's workspaceRoot does not map to any
 * configured repository. The unconfigured path is NOT included in the message.
 */
export function authorizeProject(
  project: T3SnapshotProject,
  repoRegistry: RepositoryRegistry
): T3AuthorizedRepo {
  const match = repoRegistry.resolveRepositoryByWorkspaceRoot(project.workspaceRoot);
  if (match) {
    return { alias: match.alias, config: match.config, project };
  }

  // Do NOT expose the unconfigured root path in the error message
  throw new CodingAgentError(
    ErrorCodes.POLICY_DENIED,
    `The T3 thread belongs to a project that is not registered in this ` +
      `coding-agent-mcp instance. Only threads backed by configured repositories ` +
      `may be managed through this server.`
  );
}

/**
 * Full authorization check for an existing T3 thread:
 * fetches both the thread snapshot AND the orchestration snapshot, finds the
 * matching project, and authorizes it against the RepositoryRegistry.
 *
 * Returns the thread, its project, and the matched repository config.
 *
 * Callers that have already fetched the thread snapshot should pass it via
 * `existingThread` to avoid a redundant HTTP round-trip.
 */
export async function authorizeThread(
  client: T3Client,
  threadId: string,
  repoRegistry: RepositoryRegistry,
  existingThread?: T3SnapshotThread
): Promise<{
  thread: T3SnapshotThread;
  authorizedRepo: T3AuthorizedRepo;
}> {
  // 1. Get thread (reuse if already fetched)
  let thread: T3SnapshotThread;
  if (existingThread && existingThread.id === threadId) {
    thread = existingThread;
  } else {
    const snapshot = await client.getThreadSnapshot(threadId, { turnLimit: 1 });
    thread = snapshot.thread;
  }

  // 2. Find the T3 project in the orchestration snapshot
  const orchestrationSnapshot: T3Snapshot = await client.getSnapshot();
  const project = orchestrationSnapshot.projects.find((p) => p.id === thread.projectId);

  if (!project) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      `The T3 project for this thread is not found in the orchestration snapshot. ` +
        `The thread may belong to a deleted or inaccessible project.`
    );
  }

  // 3. Authorize the project's workspaceRoot against the RepositoryRegistry
  const authorizedRepo = authorizeProject(project, repoRegistry);

  return { thread, authorizedRepo };
}

/**
 * Checks whether the T3 thread is using a worktree workspace strategy
 * (i.e., thread.branch != null OR thread.worktreePath != null).
 *
 * This is an approximation for Phase 1: T3 sets branch/worktreePath when
 * prepareWorktree was used. An in-place thread has both as null.
 */
export function isWorktreeThread(thread: T3SnapshotThread): boolean {
  return thread.branch !== null || thread.worktreePath !== null;
}
