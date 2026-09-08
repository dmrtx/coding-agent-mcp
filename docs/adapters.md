# Agent Adapters — coding-agent-mcp

`coding-agent-mcp` abstracts local coding agents behind the `CodingAgent` interface.

---

## 1. Muse Adapter (`muse`)

### Binary Discovery
- The adapter checks the binary configured in `agents.muse.executable` (defaults to `muse`).
- Version detection runs `muse -V`.

### Headless Execution
- When `start_task` is invoked:
  `muse exec --workspace <workspaceRoot> --trust-workspace --approval-mode never --disable-approval --session-id <uuid> "<instruction>"`
- Notice:
  - `--trust-workspace` is passed to prevent interactive trust prompts in freshly created worktrees.
  - `--yolo` is strictly **omitted** to retain Meta's shell/filesystem sandbox active.
  - If `mode` is `review` or `investigate`, both `--disable-write` and `--disable-shell` are added to guarantee a strictly read-only audit environment.
- Session ID is tracked for resumption and task continuation.

### Continuation
- When `continue_task` is called:
  `muse exec --workspace <workspaceRoot> --trust-workspace --approval-mode never --disable-approval --session-id <uuid> "<instruction>"`
- Read-only flags (`--disable-write` and `--disable-shell`) and `--trust-workspace` are preserved during continuations.

---

## 2. AGY Adapter (`agy`)

### Binary Discovery
- The adapter checks `agents.agy.executable` (defaults to `agy`).
- Version detection runs `agy --version`.

### Headless Execution & Containment
- When `start_task` is invoked:
  `agy --print "<instruction>" --output-format json --sandbox`
  (executed with working directory set to the task workspace).
- Notice:
  - `--dangerously-skip-permissions` is strictly **omitted**.
  - Instead, the adapter sets up an isolated environment with `HOME` pointing to `<server.data_dir>/agent-homes/agy/<task-id>` (strictly outside the workspace root with `0700` directory permissions and `0600` for credentials and settings):
    - `enableTerminalSandbox: true`
    - `toolPermission: "proceed-in-sandbox"` (auto-proceeds within the sandbox)
    - `allowNonWorkspaceAccess: false` (strictly blocks reading or writing outside the workspace)
    - `trustedWorkspaces: [<workspaceRoot>]`
    - Granular permissions allowlist for safe build and test commands (`git`, `npm test`, `npm run lint`, etc.).
  - **Fail-closed configuration**: If the isolated directory cannot be created, task execution rejects immediately with `POLICY_DENIED`. It never falls back to the host `HOME` or host credentials.
  - **Clean workspace**: Because the configuration lives under `agent-homes/agy/<task-id>`, credentials and configuration files never pollute the task workspace or leak in `get_repo_status` / `get_diff`.
  - `--sandbox` is explicitly enabled.
  - `--output-format json` emits structured output from which the real `conversation_id` is parsed and stored.
  - If `mode` is `review` or `investigate`, `--mode plan` is added.

### Continuation & Session Resumption
- When `continue_task` is called:
  `agy --print "<instruction>" --output-format json --sandbox --conversation <conversationId>`
- **Strict session resumption**: `sessionId` is strictly required. If no conversation ID was captured from the initial execution, the task cannot be continued and is rejected with `TASK_NOT_RESUMABLE`. Global fallback `--continue` is never used.
- In `review` and `investigate` modes, `--mode plan` is preserved in continuation calls.

---

## 3. Fake Agent Adapter (`fake-agent`)

- Designed for deterministic unit and integration testing without requiring external binaries or network credentials.
- Simulates file modifications, log outputs, sleep commands, session continuation, and non-zero exit codes.
