export type AgentCapability =
  | "interactive_session"
  | "resume_session"
  | "modify_files"
  | "read_only_review"
  | "structured_output";

export interface AgentDescriptor {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
  capabilities: AgentCapability[];
}

export type AgentTaskMode = "implement" | "review" | "investigate";

export interface AgentStartInput {
  taskId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  instruction: string;
  mode: AgentTaskMode;
  timeoutMs: number;
  environment: Record<string, string>;
  sessionId?: string;
}

export interface AgentContinueInput {
  taskId: string;
  workspaceRoot: string;
  sessionId?: string;
  instruction: string;
  mode: AgentTaskMode;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface AgentProcessSpawnInfo {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionId?: string;
}

export interface CodingAgent {
  readonly id: string;
  readonly displayName: string;

  describe(): Promise<AgentDescriptor>;

  prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo>;

  prepareContinue?(input: AgentContinueInput): Promise<AgentProcessSpawnInfo>;

  extractSessionId?(stdout: string, stderr: string): string | undefined;
}
