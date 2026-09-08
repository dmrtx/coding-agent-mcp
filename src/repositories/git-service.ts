import { execFile } from "node:child_process";
import { RepoGitStatus, GitFileStatus, GitDiffResult } from "../domain/repository.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

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
            `Git command failed: git ${args.join(" ")} in ${options.cwd}. ${stderr || error.message}`,
            { stdout, stderr, exitCode: error.code }
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
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

  public async getStatus(cwd: string): Promise<RepoGitStatus> {
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
      base_sha: headSha,
      head_sha: headSha,
      clean: files.length === 0,
      files,
    };
  }

  public async getDiff(
    cwd: string,
    options: { staged?: boolean; max_bytes?: number } = {}
  ): Promise<GitDiffResult> {
    const maxBytes = options.max_bytes ?? 100_000;
    const args = ["diff"];
    if (options.staged) {
      args.push("--staged");
    }

    const { stdout: diffOutput } = await execFilePromise("git", args, { cwd });

    // Also get stats
    const filesChanged: string[] = [];
    let insertions = 0;
    let deletions = 0;

    try {
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
          filesChanged.push(parts[2]);
        }
      }
    } catch {
      // Non-critical if numstat fails
    }

    let diffText = diffOutput;
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
      files_changed: filesChanged,
      insertions,
      deletions,
    };
  }
}
