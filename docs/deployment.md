# Deployment & Tunnel Guide — coding-agent-mcp

## 1. Local stdio MCP Setup

`coding-agent-mcp` connects via standard input/output (`stdio`) by default, following the MCP specification.

### Building from Source

```bash
npm install
npm run build
```

### Configuration File

Create a configuration file at `~/.coding-agent-mcp/config.yaml` or pass `--config <path>`:

```yaml
server:
  data_dir: ~/.coding-agent-mcp
  max_concurrent_tasks: 2

repositories:
  my-repo:
    root: /path/to/my-repo
    writable: true
    verification_profiles:
      test:
        command: ["npm", "test"]
        timeout_seconds: 300
```

### Adding to Claude Desktop / MCP Clients

Add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "coding-agent": {
      "command": "node",
      "args": ["/absolute/path/to/coding-agent-mcp/dist/index.js"]
    }
  }
}
```

Or with a custom configuration file:

```json
{
  "mcpServers": {
    "coding-agent": {
      "command": "node",
      "args": [
        "/absolute/path/to/coding-agent-mcp/dist/index.js",
        "--config",
        "/absolute/path/to/my-config.yaml"
      ]
    }
  }
}
```

---

## 2. Secure Tunneling for Remote Clients

If exposing `coding-agent-mcp` to a remote MCP client (e.g. ChatGPT Actions or an external supervisor):

1. **Do not bind raw unauthenticated ports to the public Internet.**
2. Use an authenticated, encrypted reverse tunnel (such as Cloudflare Tunnels, Tailscale Funnel, or SSH reverse tunnel).
3. The server runs with unprivileged user permissions on the host.
