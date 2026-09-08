# Agent Adapters — coding-agent-mcp

`coding-agent-mcp` abstracts local coding agents behind the `CodingAgent` interface.

---

## 1. Muse Adapter (`muse`)

### Binary Discovery
- The adapter checks the binary configured in `agents.muse.executable` (defaults to `muse`).
- Version detection runs `muse -V`.

### Headless Execution
- When `start_task` is invoked:
  `muse exec --workspace <workspaceRoot> --approval-mode never --yolo --session-id <uuid> "<instruction>"`
- Session ID is tracked for resumption and task continuation.

### Continuation
- When `continue_task` is called:
  `muse exec --workspace <workspaceRoot> --approval-mode never --yolo --session-id <uuid> "<instruction>"`

---

## 2. AGY Adapter (`agy`)

### Binary Discovery
- The adapter checks `agents.agy.executable` (defaults to `agy`).
- Version detection runs `agy --version`.

### Headless Execution
- When `start_task` is invoked:
  `agy --print "<instruction>" --dangerously-skip-permissions`
  (executed with working directory set to the task workspace).

### Continuation
- When `continue_task` is called:
  `agy --print "<instruction>" --dangerously-skip-permissions --conversation <conversationId>`
  (or `--continue`).

---

## 3. Fake Agent Adapter (`fake-agent`)

- Designed for deterministic unit and integration testing without requiring external binaries or network credentials.
- Simulates file modifications, log outputs, sleep commands, and non-zero exit codes.
