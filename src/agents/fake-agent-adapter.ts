import crypto from "node:crypto";
import {
  CodingAgent,
  AgentDescriptor,
  AgentStartInput,
  AgentContinueInput,
  AgentProcessSpawnInfo,
} from "../domain/agent.js";

/**
 * FakeAgentAdapter runs a Node inline script to simulate real coding agent behaviors
 * in unit and integration tests without external CLI binaries or network dependencies.
 */
export class FakeAgentAdapter implements CodingAgent {
  public readonly id = "fake-agent";
  public readonly displayName = "Fake Test Agent";
  public available = true;

  public async describe(): Promise<AgentDescriptor> {
    return {
      id: this.id,
      displayName: this.displayName,
      available: this.available,
      version: "1.0.0-test",
      capabilities: ["modify_files", "resume_session"],
    };
  }

  public async prepareStart(input: AgentStartInput): Promise<AgentProcessSpawnInfo> {
    const sessionId = input.sessionId || `session-${crypto.randomUUID()}`;
    const script = `
      const fs = require('fs');
      const path = require('path');
      console.log("FakeAgent started with sessionId: ${sessionId}");
      console.log("Instruction: ${input.instruction.replace(/"/g, '\\"')}");
      
      if ("${input.instruction}".includes("fail")) {
        console.error("Simulated agent failure");
        process.exit(1);
      }
      if ("${input.instruction}".includes("sleep")) {
        const match = "${input.instruction}".match(/sleep (\\d+)/);
        const ms = match ? parseInt(match[1], 10) : 500;
        setTimeout(() => {
          console.log("FakeAgent sleep finished");
          process.exit(0);
        }, ms);
      } else {
        // Default: simulate modifying a file
        const testFile = path.join(process.cwd(), "agent-output.txt");
        fs.appendFileSync(testFile, "modified by FakeAgent: ${input.instruction}\\n");
        console.log("FakeAgent modified file: " + testFile);
        process.exit(0);
      }
    `;

    return {
      command: process.execPath,
      args: ["-e", script],
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId,
    };
  }

  public async prepareContinue(input: AgentContinueInput): Promise<AgentProcessSpawnInfo> {
    const sessionId = input.sessionId || `session-${crypto.randomUUID()}`;
    const script = `
      const fs = require('fs');
      const path = require('path');
      console.log("FakeAgent continued with sessionId: ${sessionId}");
      console.log("Follow-up: ${input.instruction.replace(/"/g, '\\"')}");
      
      const testFile = path.join(process.cwd(), "agent-output.txt");
      fs.appendFileSync(testFile, "continued by FakeAgent: ${input.instruction}\\n");
      console.log("FakeAgent updated file: " + testFile);
      process.exit(0);
    `;

    return {
      command: process.execPath,
      args: ["-e", script],
      cwd: input.workspaceRoot,
      env: input.environment,
      sessionId,
    };
  }

  public extractSessionId(stdout: string, stderr: string): string | undefined {
    const match = stdout.match(/sessionId:\s*([a-zA-Z0-9-]+)/);
    return match ? match[1] : undefined;
  }
}
