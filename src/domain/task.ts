import { AgentTaskMode } from "./agent.js";
import { WorkspaceStrategy } from "./repository.js";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_agent"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface TaskFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskInstruction {
  id: string;
  text: string;
  receivedAt: string;
}

export interface CodingTask {
  id: string;
  repositoryId: string;
  agentId: string;
  status: TaskStatus;
  instruction: string;
  followUpInstructions: TaskInstruction[];
  mode: AgentTaskMode;
  workspaceStrategy: WorkspaceStrategy;
  workspaceRoot: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  workspaceId?: string;
  exitCode?: number;
  failure?: TaskFailure;
  logPath: string;
  sessionResumable?: boolean;
}
