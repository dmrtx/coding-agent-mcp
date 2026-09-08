import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { GitService } from "../../src/repositories/git-service.js";
import { WorkspaceManager } from "../../src/repositories/workspace-manager.js";
import { RepositoryConfig } from "../../src/config/schema.js";

function setupTestGitRepo(): { repoDir: string; baseSha: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-repo-"));
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });

  fs.writeFileSync(path.join(repoDir, "file1.txt"), "line 1\n");
  execSync("git add file1.txt && git commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "ignore",
  });

  const baseSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();
  return { repoDir, baseSha };
}

test("GitService returns structured status with base_sha and head_sha", async () => {
  const { repoDir, baseSha } = setupTestGitRepo();
  const gitService = new GitService();

  // Initially clean
  const cleanStatus = await gitService.getStatus(repoDir, baseSha);
  assert.equal(cleanStatus.clean, true);
  assert.equal(cleanStatus.base_sha, baseSha);
  assert.equal(cleanStatus.head_sha, baseSha);
  assert.equal(cleanStatus.files.length, 0);

  // Agent makes a commit
  fs.appendFileSync(path.join(repoDir, "file1.txt"), "line 2\n");
  execSync("git commit -am 'Second commit'", { cwd: repoDir, stdio: "ignore" });
  const headSha = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();

  // Agent makes unstaged change and creates untracked file
  fs.appendFileSync(path.join(repoDir, "file1.txt"), "line 3\n");
  fs.writeFileSync(path.join(repoDir, "brand-new.txt"), "new file content\n");

  const status = await gitService.getStatus(repoDir, baseSha);
  assert.equal(status.clean, false);
  assert.equal(status.base_sha, baseSha);
  assert.equal(status.head_sha, headSha);
  assert.notEqual(status.base_sha, status.head_sha);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("GitService task-aware diff includes committed changes, unstaged changes, and untracked files", async () => {
  const { repoDir, baseSha } = setupTestGitRepo();
  const gitService = new GitService();

  // 1. Committed change since baseSha
  fs.writeFileSync(path.join(repoDir, "committed.txt"), "committed line\n");
  execSync("git add committed.txt && git commit -m 'Add committed.txt'", {
    cwd: repoDir,
    stdio: "ignore",
  });

  // 2. Unstaged tracked modification
  fs.appendFileSync(path.join(repoDir, "file1.txt"), "unstaged line\n");

  // 3. Untracked brand new file created by worker
  fs.writeFileSync(path.join(repoDir, "untracked-by-agent.txt"), "untracked agent output\n");

  // Run task-aware diff against baseSha
  const diffResult = await gitService.getDiff(repoDir, {
    baseSha,
    includeUntracked: true,
  });

  assert.ok(diffResult.diff.includes("committed.txt"), "Diff must include changes committed since baseSha");
  assert.ok(diffResult.diff.includes("committed line"));
  assert.ok(diffResult.diff.includes("unstaged line"), "Diff must include unstaged changes");
  assert.ok(diffResult.diff.includes("untracked-by-agent.txt"), "Diff must include untracked files");
  assert.ok(diffResult.diff.includes("untracked agent output"));

  assert.ok(diffResult.files_changed.includes("committed.txt"));
  assert.ok(diffResult.files_changed.includes("file1.txt"));
  assert.ok(diffResult.files_changed.includes("untracked-by-agent.txt"));
  assert.equal(diffResult.truncated, false);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("WorkspaceManager creates and cleans up isolated worktree", async () => {
  const { repoDir } = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-data-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    allow_in_place: false,
    default_workspace_strategy: "worktree",
    verification_profiles: {},
  };

  const ws = await wm.createWorkspace("task-123", "test-repo", repoConfig, "worktree");
  assert.equal(ws.strategy, "worktree");
  assert.ok(fs.existsSync(ws.workspaceRoot));
  assert.ok(fs.existsSync(path.join(ws.workspaceRoot, "file1.txt")));

  // Making changes in worktree doesn't affect main repo
  fs.writeFileSync(path.join(ws.workspaceRoot, "worktree-file.txt"), "isolated");
  assert.ok(!fs.existsSync(path.join(repoDir, "worktree-file.txt")));

  await wm.cleanupWorkspace("task-123");
  assert.ok(!fs.existsSync(ws.workspaceRoot));

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("WorkspaceManager enforces in_place security: allow_in_place check and dirty tree rejection", async () => {
  const { repoDir } = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-inplace-sec-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  // 1. allow_in_place = false -> must reject
  const disabledInPlaceConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    allow_in_place: false,
    default_workspace_strategy: "in_place",
    verification_profiles: {},
  };

  await assert.rejects(
    () => wm.createWorkspace("task-dis", "test-repo", disabledInPlaceConfig, "in_place"),
    (err: any) => err.code === "POLICY_DENIED"
  );

  // 2. allow_in_place = true BUT repository is dirty -> must reject
  const allowedInPlaceConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    allow_in_place: true,
    default_workspace_strategy: "in_place",
    verification_profiles: {},
  };

  fs.appendFileSync(path.join(repoDir, "file1.txt"), "dirty uncommitted change\n");

  await assert.rejects(
    () => wm.createWorkspace("task-dirty", "test-repo", allowedInPlaceConfig, "in_place"),
    (err: any) => err.code === "WORKSPACE_CONFLICT"
  );

  // Reset clean state
  execSync("git checkout -- file1.txt", { cwd: repoDir, stdio: "ignore" });

  // 3. Clean and allowed -> succeeds
  const ws = await wm.createWorkspace("task-clean", "test-repo", allowedInPlaceConfig, "in_place");
  assert.equal(ws.strategy, "in_place");

  // 4. Concurrent in_place -> rejected
  await assert.rejects(
    () => wm.createWorkspace("task-second", "test-repo", allowedInPlaceConfig, "in_place"),
    (err: any) => err.code === "WORKSPACE_CONFLICT"
  );

  await wm.cleanupWorkspace("task-clean");

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("GitService safely ignores untracked symlinks pointing outside repository", async () => {
  const { repoDir, baseSha } = setupTestGitRepo();
  const gitService = new GitService();

  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-dir-"));
  fs.writeFileSync(path.join(secretDir, "secret.txt"), "super-secret-password-123\n");

  // Create untracked symlink pointing to secret file outside repo
  fs.symlinkSync(path.join(secretDir, "secret.txt"), path.join(repoDir, "leak-symlink.txt"));

  const diffResult = await gitService.getDiff(repoDir, {
    baseSha,
    includeUntracked: true,
  });

  assert.ok(!diffResult.diff.includes("super-secret-password-123"), "Symlink targets outside repo must NOT be exposed in diff");
  assert.ok(!diffResult.files_changed.includes("leak-symlink.txt"), "Symlink should not be in files_changed");

  fs.rmSync(secretDir, { recursive: true, force: true });
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("WorkspaceManager.pruneOldWorktrees removes stale worktrees and deletes git branches", async () => {
  const { repoDir } = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-prune-data-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    allow_in_place: false,
    default_workspace_strategy: "worktree",
    verification_profiles: {},
  };

  const ws = await wm.createWorkspace("stale-task-1", "test-repo", repoConfig, "worktree");
  assert.ok(fs.existsSync(ws.workspaceRoot));

  // Verify branch exists in git repo
  const branchesBefore = execSync("git branch", { cwd: repoDir }).toString();
  assert.ok(branchesBefore.includes("agent/stale-task-1"));

  // Pretend task ended and server restarted (activeWorkspaces cleared)
  const wmRestarted = new WorkspaceManager(dataDir, gitService);

  // Set mtime to 2 days ago
  const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000;
  fs.utimesSync(ws.workspaceRoot, twoDaysAgo, twoDaysAgo);

  const pruned = await wmRestarted.pruneOldWorktrees(86_400_000, [repoDir]);
  assert.equal(pruned, 1);
  assert.ok(!fs.existsSync(ws.workspaceRoot));

  // Verify git branch was removed
  const branchesAfter = execSync("git branch", { cwd: repoDir }).toString();
  assert.ok(!branchesAfter.includes("agent/stale-task-1"));

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("WorkspaceManager atomically locks in_place strategy against concurrent requests", async () => {
  const { repoDir } = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-inplace-race-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    allow_in_place: true,
    default_workspace_strategy: "in_place",
    verification_profiles: {},
  };

  // Launch two concurrent in_place workspace requests simultaneously
  const results = await Promise.allSettled([
    wm.createWorkspace("task-race-1", "test-repo", repoConfig, "in_place"),
    wm.createWorkspace("task-race-2", "test-repo", repoConfig, "in_place"),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one in_place workspace must be acquired");
  assert.equal(rejected.length, 1, "Concurrent in_place workspace request must be rejected");

  const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
  assert.equal(rejectionReason.code, "WORKSPACE_CONFLICT");

  // Cleanup the successful one
  const successfulTaskId = (fulfilled[0] as PromiseFulfilledResult<any>).value.taskId;
  await wm.cleanupWorkspace(successfulTaskId);

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("GitService handles large diffs >1 MiB without silent truncation or maxBuffer errors", async () => {
  const { repoDir, baseSha } = setupTestGitRepo();
  const gitService = new GitService();

  // Create a 1.2 MiB file commit
  const largeContent = "const chunk = 'abcdefghijklmnopqrstuvwxyz0123456789\\n';\n".repeat(25000); // ~1.3 MB
  fs.writeFileSync(path.join(repoDir, "large_file.js"), largeContent);

  // 1. Check full diff with large max_bytes
  const fullDiff = await gitService.getDiff(repoDir, {
    baseSha,
    max_bytes: 10 * 1024 * 1024,
    includeUntracked: true,
  });

  assert.equal(fullDiff.truncated, false, "1.2 MB diff must not be truncated when max_bytes is 10 MB");
  assert.ok(fullDiff.diff.length > 1024 * 1024, "Diff output must exceed 1 MiB");
  assert.ok(fullDiff.files_changed.includes("large_file.js"));

  // 2. Check explicit truncation when max_bytes is small
  const truncatedDiff = await gitService.getDiff(repoDir, {
    baseSha,
    max_bytes: 50_000,
    includeUntracked: true,
  });

  assert.equal(truncatedDiff.truncated, true);
  assert.equal(Buffer.byteLength(truncatedDiff.diff, "utf-8"), 50_000);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("GitService reports truncated: true with buffered output on buffer overflow instead of silently swallowing as empty diff", async () => {
  const { repoDir, baseSha } = setupTestGitRepo();
  const gitService = new GitService();

  // Create tracked changes
  const content = "const chunk = 'abcdefghijklmnopqrstuvwxyz0123456789\\n';\n".repeat(400);
  fs.writeFileSync(path.join(repoDir, "file1.txt"), content);

  // Invoke getDiff with small maxBuffer = 1024 (1 KiB)
  const diffResult = await gitService.getDiff(repoDir, {
    baseSha,
    maxBuffer: 1024,
    max_bytes: 100_000,
    includeUntracked: false,
  });

  // Must report truncated: true and contain buffered output (NOT empty diff)
  assert.equal(diffResult.truncated, true, "Buffer overflow must mark diff as truncated");
  assert.ok(diffResult.diff.length > 0, "Buffered output must NOT be swallowed or empty");
  assert.ok(diffResult.diff.includes("file1.txt") || diffResult.diff.includes("diff --git"));
  assert.ok(diffResult.files_changed.includes("file1.txt"), "Summary metadata files_changed must be preserved on overflow");
  assert.ok(diffResult.insertions > 0, "Summary metadata insertions must be preserved on overflow");

  fs.rmSync(repoDir, { recursive: true, force: true });
});

