import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

const FORBIDDEN_COMMANDS = new Set([
  "sudo",
  "su",
  "doas",
  "rm -rf /",
  ":(){ :|:& };:",
]);

/**
 * Validates command and arguments against dangerous operations.
 */
export function validateCommandExecution(command: string, args: string[]): void {
  const baseName = command.trim().split("/").pop() || "";

  if (FORBIDDEN_COMMANDS.has(baseName) || FORBIDDEN_COMMANDS.has(command.trim())) {
    throw new CodingAgentError(
      ErrorCodes.POLICY_DENIED,
      `Execution of command '${command}' is explicitly forbidden by security policy`
    );
  }

  // Reject destructive raw git commands via generic tools
  if (baseName === "git") {
    const joinedArgs = args.join(" ");
    if (
      joinedArgs.includes("reset --hard") ||
      joinedArgs.includes("clean -fdx") ||
      joinedArgs.includes("push --force") ||
      joinedArgs.includes("push -f")
    ) {
      throw new CodingAgentError(
        ErrorCodes.POLICY_DENIED,
        `Destructive git operation forbidden: git ${joinedArgs}`
      );
    }
  }
}
