export type WorkspaceStrategy = "worktree" | "in_place";

export interface RepositoryDescriptor {
  id: string;
  root: string;
  defaultBranch?: string;
  verificationProfiles: string[];
  writable: boolean;
  allow_in_place: boolean;
  defaultWorkspaceStrategy?: WorkspaceStrategy;
}

export interface WorkspaceDescriptor {
  taskId: string;
  repositoryId: string;
  strategy: WorkspaceStrategy;
  workspaceRoot: string;
  repositoryRoot: string;
  branchName?: string;
  baseSha?: string;
  headSha?: string;
  cleaned: boolean;
}

export interface GitFileStatus {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface RepoGitStatus {
  branch?: string;
  base_sha?: string;
  head_sha?: string;
  clean: boolean;
  files: GitFileStatus[];
}

export interface GitDiffResult {
  diff: string;
  truncated: boolean;
  files_changed: string[];
  insertions: number;
  deletions: number;
}
