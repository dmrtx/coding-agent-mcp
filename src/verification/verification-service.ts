import { spawn } from "node:child_process";
import { VerificationProfile, VerificationResult } from "../domain/verification.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";
import { validateVerificationCommand } from "./command-policy.js";
import { sanitizeEnvironment } from "../security/environment-policy.js";

export class VerificationService {
  private readonly defaultTimeoutSeconds: number;
  private readonly outputLimitBytes: number;

  constructor(defaultTimeoutSeconds = 900, outputLimitBytes = 5_000_000) {
    this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    this.outputLimitBytes = outputLimitBytes;
  }

  public async runVerification(
    profileName: string,
    profile: VerificationProfile,
    cwd: string
  ): Promise<VerificationResult> {
    validateVerificationCommand(profile.command);

    const [cmd, ...args] = profile.command;
    const timeoutMs = (profile.timeoutSeconds || this.defaultTimeoutSeconds) * 1000;
    const startTime = Date.now();

    const env = sanitizeEnvironment(undefined, profile.env);

    return new Promise((resolve, reject) => {
      let child: any;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let totalBytes = 0;

      const timer = setTimeout(() => {
        timedOut = true;
        if (child && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, timeoutMs);

      try {
        child = spawn(cmd, args, {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        clearTimeout(timer);
        reject(
          new CodingAgentError(
            ErrorCodes.PROCESS_START_FAILED,
            `Failed to start verification command '${cmd}': ${err.message}`
          )
        );
        return;
      }

      const appendChunk = (isStderr: boolean, chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > this.outputLimitBytes) {
          truncated = true;
          const allowed = Math.max(0, this.outputLimitBytes - (totalBytes - chunk.length));
          if (allowed > 0) {
            const sub = chunk.subarray(0, allowed).toString("utf-8");
            if (isStderr) stderr += sub;
            else stdout += sub;
          }
        } else {
          if (isStderr) stderr += chunk.toString("utf-8");
          else stdout += chunk.toString("utf-8");
        }
      };

      child.stdout.on("data", (chunk: Buffer) => appendChunk(false, chunk));
      child.stderr.on("data", (chunk: Buffer) => appendChunk(true, chunk));

      child.on("error", (err: any) => {
        clearTimeout(timer);
        reject(
          new CodingAgentError(
            ErrorCodes.PROCESS_START_FAILED,
            `Verification process error: ${err.message}`
          )
        );
      });

      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          reject(
            new CodingAgentError(
              ErrorCodes.VERIFICATION_TIMEOUT,
              `Verification profile '${profileName}' timed out after ${timeoutMs}ms`
            )
          );
          return;
        }

        const exitCode = code ?? 1;
        resolve({
          profile: profileName,
          passed: exitCode === 0,
          exit_code: exitCode,
          duration_ms: durationMs,
          stdout,
          stderr,
          truncated,
        });
      });
    });
  }
}
