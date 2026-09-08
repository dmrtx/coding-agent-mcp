import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WorkspaceDescriptor, WorkspaceStrategy } from "../domain/repository.js";
import { RepositoryConfig } from "../config/schema.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { GitService } from "./git-service.js";
import { assertPathContained, canonicalizePath } from "../security/path-policy.js";

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      options,
      (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => {
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
      }
    );
  });
}

export class WorkspaceManager {
  private readonly gitService: GitService;
  private readonly dataDir: string;
  private readonly inPlaceLocks: Set<string> = new Set();
  private readonly activeWorkspaces: Map<string, WorkspaceDescriptor> = new Map();

  constructor(dataDir: string, gitService: GitService) {
    this.dataDir = canonicalizePath(dataDir);
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
      if (!repoConfig.allow_in_place) {
        throw new CodingAgentError(
          ErrorCodes.POLICY_DENIED,
          `in_place workspace strategy is not permitted for repository '${repositoryId}'. Configuration specifies allow_in_place: false.`,
          { repository: repositoryId }
        );
      }

      if (this.inPlaceLocks.has(repositoryId)) {
        throw new CodingAgentError(
          ErrorCodes.WORKSPACE_CONFLICT,
          `Repository '${repositoryId}' currently has an active in_place task. Concurrent in_place tasks are forbidden.`,
          { repository: repositoryId }
        );
      }

      // Check clean working tree before granting in_place access
      const status = await this.gitService.getStatus(repoConfig.root);
      if (!status.clean) {
        throw new CodingAgentError(
          ErrorCodes.WORKSPACE_CONFLICT,
          `Repository '${repositoryId}' has uncommitted changes or untracked files. in_place strategy requires a clean working tree.`,
          { repository: repositoryId, files: status.files }
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
        headSha: baseSha,
        cleaned: false,
      };

      this.activeWorkspaces.set(taskId, descriptor);
      return descriptor;
    }

    // Worktree strategy
    const workspacesDir = path.join(this.dataDir, "workspaces");
    fs.mkdirSync(workspacesDir, { recursive: true });

    const workspaceRoot = path.join(workspacesDir, taskId);
    assertPathContained(workspaceRoot, workspacesDir);

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
      headSha: baseSha,
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

  public async pruneOldWorktrees(maxAgeMs = 86_400_000, repoRoots: string[] = []): Promise<number> {
    const workspacesDir = path.join(this.dataDir, "workspaces");
    if (!fs.existsSync(workspacesDir)) {
      return 0;
    }

    let pruned = 0;
    const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(workspacesDir, entry.name);
      if (this.activeWorkspaces.has(entry.name)) continue;

      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          let repoRoot: string | undefined;
          const gitFile = path.join(fullPath, ".git");
          if (fs.existsSync(gitFile)) {
            try {
              const gitDirContent = fs.readFileSync(gitFile, "utf-8").trim();
              const match = gitDirContent.match(/^gitdir:\s*(.*)$/m);
              if (match && match[1]) {
                const gitDir = path.resolve(fullPath, match[1]);
                const commondirFile = path.join(gitDir, "commondir");
                if (fs.existsSync(commondirFile)) {
                  const commondir = fs.readFileSync(commondirFile, "utf-8").trim();
                  const mainGitDir = path.resolve(gitDir, commondir);
                  repoRoot = path.dirname(mainGitDir);
                }
              }
            } catch {
              // Ignore gitdir resolution error
            }
          }

          if (repoRoot && fs.existsSync(repoRoot)) {
            try {
              await execFilePromise("git", ["worktree", "remove", "--force", fullPath], {
                cwd: repoRoot,
              });
            } catch {
              fs.rmSync(fullPath, { recursive: true, force: true });
              try {
                await execFilePromise("git", ["worktree", "prune"], { cwd: repoRoot });
              } catch {
                // Ignore worktree prune error
              }
            }

            try {
              await execFilePromise("git", ["branch", "-D", `agent/${entry.name}`], {
                cwd: repoRoot,
              });
            } catch {
              // Ignore branch deletion error
            }
          }

          if (fs.existsSync(fullPath)) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }

          pruned++;
        }
      } catch {
        // Non-blocking prune error
      }
    }

    for (const repoRoot of repoRoots) {
      try {
        if (fs.existsSync(repoRoot)) {
          await execFilePromise("git", ["worktree", "prune"], { cwd: repoRoot });
        }
      } catch {
        // Non-blocking prune error
      }
    }

    return pruned;
  }
}
