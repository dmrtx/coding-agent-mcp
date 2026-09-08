import type { ErrorCode } from "./errors.js";

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

export interface AgentResultInterpretation {
  blocked: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  failureCode?: ErrorCode;
}

export interface ManagedStartInput {
  taskId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  instruction: string;
  mode: AgentTaskMode;
  timeoutMs: number;
  environment: Record<string, string>;
  onOutput?: (text: string, isStderr?: boolean) => void;
}

export type ManagedStartStatus = "completed" | "failed" | "cancelled" | "timed_out";

export interface ManagedStartResult {
  sessionId?: string;
  sessionResumable?: boolean;
  assistantText?: string;
  outputLines?: string[];
  status?: ManagedStartStatus;
  stopReason?: string;
  failureCode?: ErrorCode | string;
  failureMessage?: string;
  failureDetails?: Record<string, unknown>;
}

export interface ManagedContinueInput {
  taskId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  sessionId: string;
  instruction: string;
  mode: AgentTaskMode;
  timeoutMs: number;
  environment: Record<string, string>;
  onOutput?: (text: string, isStderr?: boolean) => void;
}

export type ManagedContinueResult = ManagedStartResult;

export interface ManagedCancelInput {
  taskId: string;
  repositoryRoot: string;
  workspaceRoot: string;
  sessionId?: string;
  mode: AgentTaskMode;
  environment: Record<string, string>;
  graceTimeoutMs: number;
}

export type ManagedCancelResult =
  | { status: "acknowledged" }
  | { status: "fallback" }
  | {
      status: "failed";
      failure: { code: ErrorCode; message: string; details?: Record<string, unknown> };
    };

export interface CodingAgent {
  readonly id: string;
  readonly displayName: string;

  describe(): Promise<AgentDescriptor>;

  prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo>;

  prepareContinue?(input: AgentContinueInput): Promise<AgentProcessSpawnInfo>;

  extractSessionId?(stdout: string, stderr: string): string | undefined;

  interpretResult?(stdout: string, stderr: string): AgentResultInterpretation;

  runManagedStart?(input: ManagedStartInput): Promise<ManagedStartResult>;

  runManagedContinue?(input: ManagedContinueInput): Promise<ManagedContinueResult>;

  cancelManagedTask?(input: ManagedCancelInput): Promise<ManagedCancelResult>;
}
