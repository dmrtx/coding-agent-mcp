# coding-agent-mcp

Local, client-agnostic MCP server for supervising and orchestrating coding agents such as Muse and AGY.

The MCP server is the integration boundary. OpenAI/ChatGPT, Claude Desktop, custom MCP clients, or any other compatible client are separate consumers of the server and are intentionally outside the core architecture.

See `SPEC.md` for the implementation specification.
