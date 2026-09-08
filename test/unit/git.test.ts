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
