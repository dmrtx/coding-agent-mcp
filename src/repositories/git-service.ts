import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { RepoGitStatus, GitFileStatus, GitDiffResult } from "../domain/repository.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { assertPathContained } from "../security/path-policy.js";

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      options,
      (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && exitCode !== 1) {
          reject(
            new CodingAgentError(
              ErrorCodes.INTERNAL_ERROR,
              `Git command failed: git ${args.join(" ")} in ${options.cwd}. ${stderr || error.message}`,
              { stdout, stderr, exitCode }
            )
          );
          return;
        }
        resolve({ stdout, stderr, exitCode });
      }
    );
  });
}

export class GitService {
  public async getHeadSha(cwd: string): Promise<string> {
    try {
      const { stdout } = await execFilePromise("git", ["rev-parse", "HEAD"], { cwd });
      return stdout.trim();
    } catch {
      return "unknown";
    }
  }

  public async getStatus(cwd: string, baseSha?: string): Promise<RepoGitStatus> {
    const { stdout } = await execFilePromise("git", ["status", "--porcelain=v1", "-b", "-uall"], {
      cwd,
    });
    const headSha = await this.getHeadSha(cwd);

    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    let branch: string | undefined = undefined;
    const files: GitFileStatus[] = [];

    for (const line of lines) {
      if (line.startsWith("## ")) {
        const branchPart = line.slice(3).trim();
        const firstToken = branchPart.split("...")[0].trim();
        branch = firstToken.replace("HEAD (no branch)", "detached");
        continue;
      }

      const statusChars = line.slice(0, 2);
      const filePath = line.slice(3).trim();

      let fileStatus: GitFileStatus["status"] = "modified";
      if (statusChars === "??" || statusChars.includes("?")) {
        fileStatus = "untracked";
      } else if (statusChars.includes("A")) {
        fileStatus = "added";
      } else if (statusChars.includes("D")) {
        fileStatus = "deleted";
      } else if (statusChars.includes("R")) {
        fileStatus = "renamed";
      } else if (statusChars.includes("M")) {
        fileStatus = "modified";
      }

      files.push({
        path: filePath,
        status: fileStatus,
      });
    }

    return {
      branch,
      base_sha: baseSha ?? headSha,
      head_sha: headSha,
      clean: files.length === 0,
      files,
    };
  }

  public async getDiff(
    cwd: string,
    options: { baseSha?: string; staged?: boolean; max_bytes?: number; includeUntracked?: boolean } = {}
  ): Promise<GitDiffResult> {
    const maxBytes = options.max_bytes ?? 100_000;
    const filesChangedSet = new Set<string>();
    let insertions = 0;
    let deletions = 0;
    let combinedDiff = "";

    const args = ["diff"];
    if (options.baseSha) {
      // Diffs base commit against current working tree (including committed, staged, and unstaged tracked changes)
      args.push(options.baseSha);
    } else if (options.staged) {
      args.push("--staged");
    }

    try {
      const { stdout: diffOutput } = await execFilePromise("git", args, { cwd });
      combinedDiff += diffOutput;

      const statArgs = [...args, "--numstat"];
      const { stdout: statOutput } = await execFilePromise("git", statArgs, { cwd });
      const statLines = statOutput.split("\n").filter((l) => l.trim().length > 0);

      for (const line of statLines) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          const ins = parseInt(parts[0], 10) || 0;
          const del = parseInt(parts[1], 10) || 0;
          insertions += ins;
          deletions += del;
          filesChangedSet.add(parts[2]);
        }
      }
    } catch {
      // Fallback if baseSha or HEAD is empty
    }

    // Include untracked files safely
    if (options.includeUntracked !== false) {
      try {
        const { stdout: statusOut } = await execFilePromise(
          "git",
          ["status", "--porcelain=v1", "-uall"],
          { cwd }
        );
        const statusLines = statusOut.split("\n").filter((l) => l.trim().length > 0);

        for (const line of statusLines) {
          if (line.startsWith("?? ")) {
            const relPath = line.slice(3).trim();
            const fullPath = path.join(cwd, relPath);

            // Path containment and symlink escape prevention
            try {
              if (!fs.existsSync(fullPath)) continue;
              const lstat = fs.lstatSync(fullPath);
              if (lstat.isSymbolicLink()) {
                // Reject/skip symlinks to prevent indirect outside reading
                continue;
              }
              assertPathContained(fullPath, cwd);
            } catch {
              continue;
            }

            filesChangedSet.add(relPath);

            // Generate unified diff for untracked file via git diff --no-index
            try {
              const { stdout: untrackedDiff } = await execFilePromise(
                "git",
                ["diff", "--no-index", "--", "/dev/null", relPath],
                { cwd }
              );
              if (untrackedDiff) {
                if (combinedDiff.length > 0 && !combinedDiff.endsWith("\n")) {
                  combinedDiff += "\n";
                }
                combinedDiff += untrackedDiff;

                // Count insertions directly from git diff output without Node readFileSync
                for (const diffLine of untrackedDiff.split("\n")) {
                  if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
                    insertions++;
                  }
                }
              }
            } catch {
              // Ignore diff generation failures for binary/empty files
            }
          }
        }
      } catch {
        // Non-critical if untracked inspection fails
      }
    }

    let diffText = combinedDiff;
    let truncated = false;
    const byteLength = Buffer.byteLength(diffText, "utf-8");

    if (byteLength > maxBytes) {
      const buf = Buffer.from(diffText, "utf-8");
      diffText = buf.subarray(0, maxBytes).toString("utf-8");
      truncated = true;
    }

    return {
      diff: diffText,
      truncated,
      files_changed: Array.from(filesChangedSet),
      insertions,
      deletions,
    };
  }
}
