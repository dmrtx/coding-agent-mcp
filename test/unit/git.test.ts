import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { GitService } from "../../src/repositories/git-service.js";
import { WorkspaceManager } from "../../src/repositories/workspace-manager.js";
import { RepositoryConfig } from "../../src/config/schema.js";

function setupTestGitRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-repo-"));
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });

  fs.writeFileSync(path.join(repoDir, "file1.txt"), "hello world\n");
  execSync("git add file1.txt && git commit -m 'Initial commit'", {
    cwd: repoDir,
    stdio: "ignore",
  });

  return repoDir;
}

test("GitService returns structured status and diff", async () => {
  const repoDir = setupTestGitRepo();
  const gitService = new GitService();

  // Initially clean
  const cleanStatus = await gitService.getStatus(repoDir);
  assert.equal(cleanStatus.clean, true);
  assert.equal(cleanStatus.files.length, 0);

  // Modify file1.txt and add file2.txt
  fs.appendFileSync(path.join(repoDir, "file1.txt"), "line 2\n");
  fs.writeFileSync(path.join(repoDir, "file2.txt"), "new file\n");

  const modifiedStatus = await gitService.getStatus(repoDir);
  assert.equal(modifiedStatus.clean, false);
  const modifiedFile = modifiedStatus.files.find((f) => f.path.includes("file1.txt"));
  const untrackedFile = modifiedStatus.files.find((f) => f.path.includes("file2.txt"));
  assert.ok(modifiedFile);
  assert.equal(modifiedFile.status, "modified");
  assert.ok(untrackedFile);
  assert.equal(untrackedFile.status, "untracked");

  // Diff
  const diffResult = await gitService.getDiff(repoDir);
  assert.ok(diffResult.diff.includes("line 2"));
  assert.equal(diffResult.truncated, false);

  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("WorkspaceManager creates and cleans up isolated worktree", async () => {
  const repoDir = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-data-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
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

test("WorkspaceManager prevents concurrent in_place operations", async () => {
  const repoDir = setupTestGitRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-inplace-"));
  const gitService = new GitService();
  const wm = new WorkspaceManager(dataDir, gitService);

  const repoConfig: RepositoryConfig = {
    root: repoDir,
    writable: true,
    default_workspace_strategy: "in_place",
    verification_profiles: {},
  };

  await wm.createWorkspace("task-1", "test-repo", repoConfig, "in_place");

  await assert.rejects(
    () => wm.createWorkspace("task-2", "test-repo", repoConfig, "in_place"),
    (err: any) => err.code === "WORKSPACE_CONFLICT"
  );

  await wm.cleanupWorkspace("task-1");

  // Can now acquire again
  const ws2 = await wm.createWorkspace("task-2", "test-repo", repoConfig, "in_place");
  assert.equal(ws2.taskId, "task-2");

  await wm.cleanupWorkspace("task-2");

  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
