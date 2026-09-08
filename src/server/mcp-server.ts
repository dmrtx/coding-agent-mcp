import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, ToolServices } from "./tool-registry.js";

export function createMcpServer(services: ToolServices): McpServer {
  const server = new McpServer({
    name: "coding-agent-mcp",
    version: "0.1.0",
  });

  registerTools(server, services);

  return server;
}
