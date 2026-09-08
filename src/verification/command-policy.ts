import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { validateCommandExecution } from "../security/process-policy.js";

export function validateVerificationCommand(command: string[]): void {
  if (!command || command.length === 0) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      "Verification command cannot be empty"
    );
  }

  const [executable, ...args] = command;
  validateCommandExecution(executable, args);
}
