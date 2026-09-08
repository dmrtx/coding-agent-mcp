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
- **Muse**: Executed with `--trust-workspace --disable-approval --approval-mode never` for non-interactive execution, but **without** `--yolo`, keeping Meta's shell/filesystem sandboxing active.
- **AGY**: Executed with `--sandbox --dangerously-skip-permissions`. In headless print mode, `--sandbox` enforces terminal execution restrictions, while environment sanitization prevents credential exfiltration.
- **Review/Investigate Modes**: Enforce read-only semantics (`--disable-write` and `--disable-shell` on Muse, `--mode plan` on AGY).

---

## 3. Repository Allowlist & Path Containment

- Only repository aliases configured in the configuration file can be accessed.
- Dynamic filesystem paths from callers are rejected.
- Path traversal (`../`) and symlink escapes outside the repository root or worktree root are detected and blocked using realpath canonical checks (`PathPolicy`).
- Untracked symbolic links in diff generation are safely ignored to prevent indirect access to sensitive host files outside repositories.

---

## 4. Environment Variable Sanitization

Child agent and verification processes do not inherit the entire host environment.
- Environment variables are filtered against a strict allowlist (e.g. `HOME`, `PATH`, `TMPDIR`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`).
- Host secrets, cloud provider credentials, SSH agent sockets, and sensitive tokens are stripped before spawning subprocesses.

---

## 5. Worktree Isolation & in_place Safety

- **Worktree Isolation**: Tasks default to Git worktrees under `~/.coding-agent-mcp/workspaces/<task-id>` on dedicated `agent/<task-id>` branches.
- **in_place Restrictions**: `in_place` workspace strategy is disabled by default (`allow_in_place: false`). If explicitly enabled, `in_place` tasks are rejected if the working tree has uncommitted or untracked changes (`WORKSPACE_CONFLICT`).
- **Atomic Locking**: `in_place` mutual exclusion locks are acquired synchronously before any asynchronous checks, eliminating race conditions between concurrent requests.

---

## 6. Process Lifecycle & Crash Orphan Prevention

- **Detached Process Groups**: Subprocesses run in detached process groups so signals propagate cleanly to all children (compilers, shell tools, scripts).
- **Inline Guardian Watchdog**: Each worker process has an attached guardian watchdog connected via an OS pipe. If the MCP server dies abruptly (via `SIGKILL`, kernel crash, or power failure), the OS kernel closes the pipe descriptor and the watchdog terminates the child process group within milliseconds, guaranteeing workers are not left orphaned.
- **Verifiable Process Identity Recovery**: Active worker metadata (PID, exact command line, working directory, and start timestamp) is recorded on disk. On server startup, `recoverOrphanedWorkers()` inspects running processes via `ps` to verify identity before signaling, preventing blind PID reuse hazards.
- **Graceful Shutdown**: Server termination (`SIGINT`, `SIGTERM`) triggers `ProcessManager.shutdown()` terminating all active child process groups.
- **Atomic Concurrency Reservations**: `max_concurrent_tasks` slots are reserved synchronously before any asynchronous operations, preventing concurrency races.
- **Cumulative Output Cap**: Output limits are enforced cumulatively across all continuation turns of a task, strictly capping the single task log size.

---

## 7. Verification Profile Restrictions

- `run_verification` only executes pre-configured profiles (such as `test` or `lint`).
- Arbitrary command injection or modification of verification commands is rejected.
- Subprocess timeouts and output size caps are enforced.
