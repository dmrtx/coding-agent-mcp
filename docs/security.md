# Security Model — coding-agent-mcp

`coding-agent-mcp` allows AI-controlled MCP clients to delegate coding tasks to local worker agents (such as Muse and AGY) and run deterministic verifications. Because code execution and filesystem modifications occur locally, safety and security are fundamental principles.

---

## 1. No Generic Shell Tool

The server intentionally does **not** expose generic shell tools like `exec(cmd: string)` or `shell(...)`.

All operations are constrained through semantic tools:
- `start_task`
- `continue_task`
- `get_diff`
- `get_repo_status`
- `run_verification`

---

## 2. Repository Allowlist & Path Containment

- Only repository aliases configured in the configuration file can be accessed.
- Dynamic filesystem paths from callers are rejected.
- Path traversal (`../`) and symlink escapes outside the repository root or worktree root are detected and blocked using realpath canonical checks (`PathPolicy`).

---

## 3. Environment Variable Sanitization

Child agent and verification processes do not inherit the entire host environment.
- Environment variables are filtered against a strict allowlist (e.g. `HOME`, `PATH`, `TMPDIR`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`).
- Host secrets, cloud provider credentials, and sensitive tokens are not leaked to subprocesses.

---

## 4. Worktree Isolation

- Tasks default to Git worktrees under `~/.coding-agent-mcp/workspaces/<task-id>`.
- Parallel tasks operate in separate worktrees with distinct branches (`agent/<task-id>`).
- Direct changes to developer active work are avoided.
- For `in_place` tasks, mutual exclusion is enforced per repository to prevent concurrent conflicting writes.

---

## 5. Verification Profile Restrictions

- `run_verification` only executes pre-configured profiles (such as `test` or `lint`).
- Arbitrary command injection or modification of verification commands is rejected.
- Subprocess timeouts and output size caps are enforced.
