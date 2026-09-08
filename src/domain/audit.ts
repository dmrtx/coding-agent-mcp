export type AuditEventType =
  | "task.created"
  | "task.started"
  | "task.instruction_added"
  | "task.completed"
  | "task.failed"
  | "task.cancel_requested"
  | "task.cancelled"
  | "task.timed_out"
  | "agent.process_spawned"
  | "agent.output_truncated"
  | "workspace.created"
  | "workspace.cleaned"
  | "verification.started"
  | "verification.completed";

export interface AuditEvent {
  timestamp: string;
  type: AuditEventType;
  taskId?: string;
  repositoryId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
}
