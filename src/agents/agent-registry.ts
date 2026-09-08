import { CodingAgent, AgentDescriptor } from "../domain/agent.js";
import { AppConfig, AgyAcpConfig } from "../config/schema.js";
import { MuseAdapter } from "./muse-adapter.js";
import { AgyAdapter } from "./agy-adapter.js";
import { AgyAcpAdapter } from "./agy-acp-adapter.js";
import { CodingAgentError, ErrorCodes } from "../domain/errors.js";

export class AgentRegistry {
  private readonly agents: Map<string, CodingAgent> = new Map();

  constructor(config: AppConfig) {
    if (config.agents.muse) {
      this.registerAgent(new MuseAdapter(config.agents.muse));
    }
    if (config.agents.agy) {
      this.registerAgent(new AgyAdapter(config.agents.agy, config.server?.data_dir));
    }
    // Phase 2A slice 1: `agy-acp` is opt-in and registered ONLY when
    // explicitly enabled. Legacy `muse`/`agy` handling above is unchanged.
    const agyAcp = (config.agents as Record<string, AgyAcpConfig | undefined>)["agy-acp"];
    if (agyAcp?.enabled === true) {
      this.registerAgent(new AgyAcpAdapter(agyAcp));
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
        `Coding agent '${id}' is not registered or configured`,
        { agent: id }
      );
    }
    return agent;
  }

  public async validateAgentAvailable(id: string): Promise<CodingAgent> {
    const agent = this.getAgent(id);
    const desc = await agent.describe();
    if (!desc.available) {
      throw new CodingAgentError(
        ErrorCodes.AGENT_NOT_AVAILABLE,
        `Coding agent '${id}' is not currently available or enabled on this system`,
        { agent: id, version: desc.version }
      );
    }
    return agent;
  }
}
