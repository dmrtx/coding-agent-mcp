import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WorkspaceDescriptor, WorkspaceStrategy } from "../domain/repository.js";
import { RepositoryConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { GitService } from "./git-service.js";

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => {
      if (error) {
        reject(
          new CodingAgentError(
            ErrorCodes.INTERNAL_ERROR,
            `Command failed: ${file} ${args.join(" ")} in ${options.cwd}. ${stderr || error.message}`,
            { stdout, stderr, exitCode: error.code }
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class WorkspaceManager {
  private readonly gitService: GitService;
  private readonly dataDir: string;
  private readonly inPlaceLocks: Set<string> = new Set();
  private readonly activeWorkspaces: Map<string, WorkspaceDescriptor> = new Map();

  constructor(dataDir: string, gitService: GitService) {
    this.dataDir = dataDir;
    this.gitService = gitService;
  }

  public async createWorkspace(
    taskId: string,
    repositoryId: string,
    repoConfig: RepositoryConfig,
    strategy?: WorkspaceStrategy
  ): Promise<WorkspaceDescriptor> {
    if (!repoConfig.writable) {
      throw new CodingAgentError(
        ErrorCodes.REPOSITORY_NOT_WRITABLE,
        `Repository '${repositoryId}' is marked read-only and cannot be modified`,
        { repository: repositoryId }
      );
    }

    const chosenStrategy = strategy ?? repoConfig.default_workspace_strategy ?? "worktree";

    if (chosenStrategy === "in_place") {
      if (this.inPlaceLocks.has(repositoryId)) {
        throw new CodingAgentError(
          ErrorCodes.WORKSPACE_CONFLICT,
          `Repository '${repositoryId}' currently has an active in_place task. Concurrent in_place tasks are forbidden.`,
          { repository: repositoryId }
        );
      }
      this.inPlaceLocks.add(repositoryId);

      const baseSha = await this.gitService.getHeadSha(repoConfig.root);

      const descriptor: WorkspaceDescriptor = {
        taskId,
        repositoryId,
        strategy: "in_place",
        workspaceRoot: repoConfig.root,
        repositoryRoot: repoConfig.root,
        baseSha,
        cleaned: false,
      };

      this.activeWorkspaces.set(taskId, descriptor);
      return descriptor;
    }

    // Worktree strategy
    const workspacesDir = path.join(this.dataDir, "workspaces");
    fs.mkdirSync(workspacesDir, { recursive: true });

    const workspaceRoot = path.join(workspacesDir, taskId);
    const branchName = `agent/${taskId}`;

    const baseSha = await this.gitService.getHeadSha(repoConfig.root);

    try {
      // Add git worktree
      await execFilePromise(
        "git",
        ["worktree", "add", "-b", branchName, workspaceRoot, "HEAD"],
        { cwd: repoConfig.root }
      );
    } catch (err: any) {
      throw new CodingAgentError(
        ErrorCodes.INTERNAL_ERROR,
        `Failed to create git worktree at ${workspaceRoot}: ${err.message}`,
        { taskId, repositoryId }
      );
    }

    const descriptor: WorkspaceDescriptor = {
      taskId,
      repositoryId,
      strategy: "worktree",
      workspaceRoot,
      repositoryRoot: repoConfig.root,
      branchName,
      baseSha,
      cleaned: false,
    };

    this.activeWorkspaces.set(taskId, descriptor);
    return descriptor;
  }

  public getWorkspace(taskId: string): WorkspaceDescriptor | undefined {
    return this.activeWorkspaces.get(taskId);
  }

  public async cleanupWorkspace(taskId: string): Promise<void> {
    const ws = this.activeWorkspaces.get(taskId);
    if (!ws || ws.cleaned) {
      return;
    }

    if (ws.strategy === "in_place") {
      this.inPlaceLocks.delete(ws.repositoryId);
      ws.cleaned = true;
      return;
    }

    // Worktree cleanup
    try {
      if (fs.existsSync(ws.workspaceRoot)) {
        await execFilePromise("git", ["worktree", "remove", "--force", ws.workspaceRoot], {
          cwd: ws.repositoryRoot,
        });
      }
    } catch {
      // Ignore if already removed or directory wiped
    }

    if (ws.branchName) {
      try {
        await execFilePromise("git", ["branch", "-D", ws.branchName], {
          cwd: ws.repositoryRoot,
        });
      } catch {
        // Ignore branch delete errors
      }
    }

    ws.cleaned = true;
  }
}
