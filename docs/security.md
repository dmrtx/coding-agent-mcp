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
- **AGY**: Executed with `--sandbox` and an isolated task configuration directory without `--dangerously-skip-permissions`. The isolated configuration is placed at `<server.data_dir>/agent-homes/agy/<task-id>` (strictly outside the task repository and workspace) with `0700` directory permissions and `0600` for credentials and `settings.json`. The configuration sets `enableTerminalSandbox: true`, `toolPermission: "proceed-in-sandbox"`, `allowNonWorkspaceAccess: false`, and granular tool allowlists — including exactly `read_file(.)`, which per official AGY semantics grants recursive reads relative to the single configured workspace root (no globs, `read_file(*)`, write grants, or `command(*)`, and no absolute-path characters in the rule). Configuration creation is strictly fail-closed (`POLICY_DENIED` on error, never falling back to host credentials). As a second layer, exit-0 runs whose dedicated stdout capture parses as a recognizable AGY result envelope with affirmative denial evidence (non-empty denied-action lists, denial status, or denied count > 0) are reclassified to `failed`/`POLICY_DENIED` with a `task.failed` audit event instead of silently completing; a bare envelope `ERROR` without denial evidence becomes `INTERNAL_ERROR`. Only envelope objects are interpreted, so agent-emitted JSON can never trigger the reclassification. Completion callbacks fire only after the stdout/stderr capture streams have flushed.
- **AGY Gemini via Gyro**: The optional `agy-gemini` adapter executes `agy-gyro` as a retry proxy around the installed AGY CLI. It writes `modelProvider: gemini` into a distinct per-task home, requires an explicitly allowlisted `GEMINI_API_KEY`, strips other Google/Gemini/Antigravity credential variables, and never copies OAuth tokens. The account-backed `agy` profile and macOS Keychain are not used by this route.
- **Review/Investigate Modes**: Enforce read-only semantics (`--disable-write` and `--disable-shell` on Muse, `--mode plan` on AGY).

---

## 3. Repository Allowlist & Path Containment

- Only repository aliases configured in the configuration file can be accessed.
- Dynamic filesystem paths from callers are rejected.
- Path traversal (`../`) and symlink escapes outside the repository root or worktree root are detected and blocked using realpath canonical checks (`PathPolicy`).
- Untracked symbolic links in diff generation are safely ignored to prevent indirect access to sensitive host files outside repositories.
- `server.data_dir` must be disjoint from every configured repository root: at startup/config validation, a `data_dir` that is equal to, inside, or contains any repository root is rejected with `POLICY_DENIED` identifying the conflicting repository alias. The comparison is realpath-aware (via `canonicalizePath`), so symlinks on either side cannot bypass it. This keeps security-sensitive runtime state (AGY isolated homes, copied credentials, task databases, logs, workspaces) out of Git status, diffs, agent-visible files, and commits.

---

## 4. Environment Variable Sanitization

Child agent and verification processes do not inherit the entire host environment.
- Environment variables are filtered against a strict allowlist (e.g. `HOME`, `PATH`, `TMPDIR`, `USER`, `SHELL`, `LANG`, `LC_ALL`, `TERM`).
- Host secrets, cloud provider credentials, SSH agent sockets, and sensitive tokens are stripped before spawning subprocesses.

---

## 5. Worktree Isolation & in_place Safety

- **Worktree Isolation**: Tasks default to Git worktrees under `~/.coding-agent-mcp/workspaces/<task-id>` on dedicated `agent/<task-id>` branches.
- **in_place Restrictions**: `in_place` workspace strategy is disabled by default (`allow_in_place: false`). If explicitly enabled, `in_place` tasks are rejected if the working tree has uncommitted or untracked changes (`WORKSPACE_CONFLICT`).
- **Atomic Locking & Lifecycle**: `in_place` mutual exclusion locks are acquired synchronously before any asynchronous checks, eliminating race conditions between concurrent requests. `in_place` tasks are strictly one-shot and non-resumable (`sessionResumable: false`, rejection in `continueTask`). Upon process termination, exit, cancellation, or failure, the repository lock is promptly released via `cleanupWorkspace()`.

---

## 6. Process Lifecycle & Crash Orphan Prevention (Defense-in-Depth)

- **Detached Process Groups**: Subprocesses run in detached process groups so signals propagate cleanly to all children (compilers, shell tools, scripts).
- **Multi-Layered Orphan Prevention (Defense-in-Depth)**:
  - **Inline Guardian Watchdog**: Each worker process has an attached inline watchdog connected via an OS pipe. If the parent MCP server abruptly terminates (e.g., via `SIGKILL`, crash, or unexpected termination), the closed pipe signals the watchdog to terminate the child process group promptly as an immediate defense layer. Watchdog cleanup is strictly idempotent.
  - **Verifiable Process Identity Recovery on Startup**: Active worker metadata (PID, exact command line, canonical working directory, and OS start timestamp from `ps -p <pid> -o lstart=`) is atomically maintained in `active-workers.json`. On server startup, `recoverOrphanedWorkers()` operates strictly fail-closed: it requires matching OS start times, canonical working directories, and inspectable command lines before signaling. Recycled PIDs belonging to unrelated processes are never killed, and unverified records are preserved in `active-workers.json` rather than dropped.
- **Immediate Spawn Error Handling**: `spawnProcess` asynchronously awaits initial process spawn and error events, capturing `ENOENT` / missing binary errors cleanly without unhandled exceptions.
- **Graceful Shutdown**: Server termination (`SIGINT`, `SIGTERM`) triggers `ProcessManager.shutdown()` terminating all active child process groups.
- **Atomic Concurrency Reservations**: `max_concurrent_tasks` slots are reserved synchronously before any asynchronous operations, preventing concurrency races.
- **Cumulative Output Cap & Git Buffer Overflow**: Output limits are enforced cumulatively across all continuation turns of a task, strictly capping the single task log size. Git diff operations run `--numstat` first so summary statistics (`files_changed`, `insertions`, `deletions`) are preserved even when the patch diff overflows the buffer limit and is truncated (`truncated: true`).

---

## 7. Verification Profile Restrictions

- `run_verification` only executes pre-configured profiles (such as `test` or `lint`).
- Arbitrary command injection or modification of verification commands is rejected.
- Subprocess timeouts and output size caps are enforced.
