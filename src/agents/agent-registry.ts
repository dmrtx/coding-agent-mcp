import { CodingAgent, AgentDescriptor } from "../domain/agent.js";
import { AppConfig } from "../config/schema.js";
import { MuseAdapter } from "./muse-adapter.js";
import { AgyAdapter } from "./agy-adapter.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

export class AgentRegistry {
  private readonly agents: Map<string, CodingAgent> = new Map();

  constructor(config: AppConfig) {
    if (config.agents.muse) {
      this.registerAgent(new MuseAdapter(config.agents.muse));
    }
    if (config.agents.agy) {
      this.registerAgent(new AgyAdapter(config.agents.agy));
    }
  }

  public registerAgent(agent: CodingAgent): void {
    this.agents.set(agent.id, agent);
  }

  public async listAgents(): Promise<AgentDescriptor[]> {
    const descriptors: AgentDescriptor[] = [];
    for (const agent of this.agents.values()) {
      try {
        const desc = await agent.describe();
        descriptors.push(desc);
      } catch {
        descriptors.push({
          id: agent.id,
          displayName: agent.displayName,
          available: false,
          capabilities: [],
        });
      }
    }
    return descriptors;
  }

  public getAgent(id: string): CodingAgent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new CodingAgentError(
        ErrorCodes.AGENT_NOT_AVAILABLE,
        `Coding agent '${id}' is not registered or supported`,
        { agent: id }
      );
    }
    return agent;
  }
}
