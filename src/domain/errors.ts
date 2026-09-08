export const ErrorCodes = {
  AGENT_NOT_AVAILABLE: "AGENT_NOT_AVAILABLE",
  REPOSITORY_NOT_FOUND: "REPOSITORY_NOT_FOUND",
  REPOSITORY_NOT_WRITABLE: "REPOSITORY_NOT_WRITABLE",
  WORKSPACE_CONFLICT: "WORKSPACE_CONFLICT",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_NOT_RUNNING: "TASK_NOT_RUNNING",
  TASK_NOT_RESUMABLE: "TASK_NOT_RESUMABLE",
  TASK_TIMEOUT: "TASK_TIMEOUT",
  TASK_CANCELLED: "TASK_CANCELLED",
  PROCESS_START_FAILED: "PROCESS_START_FAILED",
  VERIFICATION_PROFILE_NOT_FOUND: "VERIFICATION_PROFILE_NOT_FOUND",
  VERIFICATION_TIMEOUT: "VERIFICATION_TIMEOUT",
  OUTPUT_TRUNCATED: "OUTPUT_TRUNCATED",
  POLICY_DENIED: "POLICY_DENIED",
  CONCURRENCY_LIMIT_REACHED: "CONCURRENCY_LIMIT_REACHED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class CodingAgentError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CodingAgentError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, CodingAgentError.prototype);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
