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

## 2. Worker Agent Sandboxing

Worker agents must never run with unconstrained system access.
- **Muse**: Executed with `--disable-approval --approval-mode never` for non-interactive execution, but **without** `--yolo`, keeping OS/filesystem/network sandboxing active.
- **AGY**: Executed with `--sandbox --dangerously-skip-permissions`, ensuring terminal and filesystem sandboxing restrictions remain enforced.
- **Review/Investigate Modes**: Enforce read-only semantics (`--disable-write` on Muse, `--mode plan` on AGY).

---

## 3. Repository Allowlist & Path Containment

- Only repository aliases configured in the configuration file can be accessed.
- Dynamic filesystem paths from callers are rejected.
- Path traversal (`../`) and symlink escapes outside the repository root or worktree root are detected and blocked using realpath canonical checks (`PathPolicy`).

---

## 4. Environment Variable Sanitization

Child agent and verification processes do not inherit the entire host environment.
- Environment variables are filtered against a strict allowlist (e.g. `HOME`, `PATH`, `TMPDIR`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`).
- Host secrets, cloud provider credentials, and sensitive tokens are not leaked to subprocesses.

---

## 5. Worktree Isolation & in_place Safety

- **Worktree Isolation**: Tasks default to Git worktrees under `~/.coding-agent-mcp/workspaces/<task-id>` on dedicated `agent/<task-id>` branches.
- **in_place Restrictions**: `in_place` workspace strategy is disabled by default (`allow_in_place: false`). If explicitly enabled, `in_place` tasks are rejected if the working tree has uncommitted or untracked changes (`WORKSPACE_CONFLICT`), and only one writer task is permitted at a time.

---

## 6. Process Lifecycle & Shutdown Safety

- Subprocesses are spawned in detached process groups.
- Timeouts and cancellations terminate the entire process group gracefully (SIGTERM followed by SIGKILL after a grace period).
- Server termination (`SIGINT`, `SIGTERM`) triggers an active shutdown routine that terminates all running worker process trees before exiting, preventing orphan workers from modifying files after shutdown.
- Stale process IDs are tracked on disk to clean up any orphaned processes across server crashes.

---

## 7. Verification Profile Restrictions

- `run_verification` only executes pre-configured profiles (such as `test` or `lint`).
- Arbitrary command injection or modification of verification commands is rejected.
- Subprocess timeouts and output size caps are enforced.
