# coding-agent-mcp

Local, client-agnostic MCP server for supervising and orchestrating coding agents such as **Muse** and **AGY**.

The MCP server is the safe execution, isolation, and verification boundary. OpenAI/ChatGPT, Claude Desktop, custom MCP orchestrators, or any other compatible client act as external supervisors.

---

## Features

- **Safe Local Execution**: Interacts with local agents without exposing arbitrary shell execution.
- **Git Worktree Isolation**: Spawns tasks in isolated Git worktrees by default, protecting current work and enabling safe concurrency.
- **Client-Agnostic MCP Surface**: Standard MCP tools compatible with any client:
  - `list_agents`
  - `list_repositories`
  - `start_task`
  - `continue_task`
  - `get_task`
  - `get_task_output`
  - `cancel_task`
  - `get_repo_status`
  - `get_diff`
  - `run_verification`
- **Deterministic Verification**: Independent test and lint execution profiles returning real exit codes and outputs.
- **Agent Adapters**: Pluggable adapters for Muse and AGY with headless execution, permission management, and session resumption.
- **Durable Persistence & Audit**: SQLite-backed task state, streaming logs, and structured audit logs with crash recovery.

---

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Configuration

Create `~/.coding-agent-mcp/config.yaml` (or copy `examples/config.example.yaml`):

```yaml
server:
  data_dir: ~/.coding-agent-mcp
  max_concurrent_tasks: 2

repositories:
  my-repo:
    root: /path/to/my-repo
    writable: true
    default_workspace_strategy: worktree
    verification_profiles:
      test:
        command: ["npm", "test"]
        timeout_seconds: 900
      lint:
        command: ["npm", "run", "lint"]
        timeout_seconds: 300
```

### 3. Run Server

```bash
node dist/index.js --config /path/to/config.yaml
```

---

## Running Tests

```bash
npm test
```

Runs the test suite covering unit policies, Git worktree isolation, task lifecycle, and end-to-end MCP tool invocations.

---

## Documentation

- [Specification (`SPEC.md`)](SPEC.md)
- [Security Model (`docs/security.md`)](docs/security.md)
- [Deployment & Tunneling (`docs/deployment.md`)](docs/deployment.md)
- [Agent Adapters (`docs/adapters.md`)](docs/adapters.md)

---

## License

MIT
