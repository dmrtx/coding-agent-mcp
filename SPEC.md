# coding-agent-mcp — Implementation Specification

**Status:** Draft 0.1  
**Target:** MVP  
**Date:** 2026-09-08

## 1. Purpose

`coding-agent-mcp` is a **local, client-agnostic MCP server** that lets an MCP client supervise and orchestrate coding agents installed on the same trusted machine or reachable local environment.

The server is not an OpenAI-specific integration. ChatGPT/OpenAI may be one consumer, but the same MCP server should also be usable by any compatible MCP client.

The primary use case is to let a capable supervisor model behave like a technical lead:

1. understand a coding task;
2. choose an available coding agent;
3. delegate implementation work;
4. inspect the resulting changes;
5. run deterministic verification such as tests, builds and linters;
6. give corrective feedback to the same or another coding agent;
7. repeat until the result is acceptable;
8. optionally prepare a commit or hand the result back to the caller.

Initial worker agents:

- **Muse**
- **AGY**

The design must make agents replaceable and extensible.

---

## 2. Core idea

```text
Any MCP client / supervisor
          |
          | MCP
          v
+-----------------------------+
|      coding-agent-mcp       |
|                             |
|  task orchestration         |
|  repository/worktree safety |
|  agent adapters             |
|  deterministic verification|
+-------------+---------------+
              |
       +------+------+
       |             |
       v             v
     Muse           AGY
       |             |
       +------+------+
              |
              v
      local repository/worktree
```

The intelligence that decides *what should be done* may live primarily in the MCP client/supervisor. `coding-agent-mcp` provides the safe execution and observation primitives required to make that orchestration possible.

The server should not attempt to become a full autonomous software-development platform in the MVP.

---

## 3. Goals

### 3.1 Primary goals

- Expose local coding agents through a stable MCP interface.
- Allow the caller to start and continue an agent task.
- Preserve conversational/session context for an agent when the underlying CLI supports it.
- Let the caller inspect task progress and final output.
- Let the caller inspect Git status and diffs produced by the agent.
- Let the caller run approved verification commands.
- Restrict all filesystem and process activity to configured repositories/workspaces.
- Keep Muse/AGY-specific CLI details behind adapters.
- Make the MCP server independent of OpenAI, ChatGPT or any single client.
- Provide enough structured output that a supervisor can review and iterate reliably.

### 3.2 Secondary goals

- Permit one agent to implement and another agent to review/fix.
- Support multiple repositories through configuration aliases.
- Support long-running coding-agent processes without requiring one MCP call to remain open indefinitely.
- Keep an auditable record of task inputs, tool invocations, process exits and validation results.
- Be suitable for exposure through a secure local tunnel without exposing a raw shell.

---

## 4. Non-goals for the MVP

The following are explicitly outside the initial implementation:

- Building a custom LLM planner inside the server.
- Replacing GitHub, CI, issue trackers or IDEs.
- Providing unrestricted shell access to the MCP client.
- Allowing arbitrary filesystem paths supplied by the caller.
- Automatic deployment to production.
- Automatic destructive Git operations.
- Managing cloud credentials.
- Providing a web UI.
- Depending on ChatGPT/OpenAI-specific APIs.
- Requiring ACP for the first release.

ACP may be added later as an internal adapter protocol where useful, but the public integration boundary for this project is MCP.

---

## 5. Design principles

### 5.1 Client agnostic

The server exposes MCP capabilities. It must not encode concepts such as ChatGPT conversation IDs, OpenAI responses, OpenAI models, or product-specific approval flows into the core domain model.

### 5.2 High-level capabilities, not arbitrary shell

Do **not** expose a tool such as:

```text
shell(command: string)
```

Instead expose constrained operations such as:

```text
start_task(...)
continue_task(...)
get_task(...)
get_diff(...)
run_verification(...)
```

### 5.3 Deterministic verification is separate from agent claims

A worker saying “tests pass” is not sufficient. Tests/build/lint must be executable by the MCP server and their real exit code/output returned to the caller.

### 5.4 Agents are adapters

Muse and AGY are implementations of one internal `CodingAgent` contract. No MCP tool should need to know CLI-specific argument syntax.

### 5.5 Repository aliases instead of arbitrary paths

The caller uses a configured repository identifier such as `factorial`, never `/Users/david/...` supplied dynamically.

### 5.6 Safe by default

The MVP should prefer refusing an unsupported operation over guessing or executing a broad shell command.

### 5.7 Observable and resumable

A long-running agent task should have an ID and explicit lifecycle. The caller must be able to inspect status/output after the original MCP request returns.

---

## 6. High-level architecture

Recommended modules:

```text
src/
  server/
    mcp-server
    tool-registry

  domain/
    task
    agent
    repository
    verification
    errors

  orchestration/
    task-manager
    process-manager
    session-manager

  agents/
    coding-agent
    muse-adapter
    agy-adapter

  repositories/
    repository-registry
    workspace-manager
    git-service

  verification/
    verification-service
    command-policy

  security/
    path-policy
    environment-policy
    process-policy

  persistence/
    task-store
    audit-store

  config/
    config-loader
    schema
```

The exact language is an implementation choice. TypeScript/Node is a reasonable default because MCP SDK support is mature and process management is straightforward, but the architecture should not depend on this choice.

---

## 7. Core domain model

### 7.1 Agent

```ts
interface AgentDescriptor {
  id: string;                 // e.g. "muse", "agy"
  displayName: string;
  available: boolean;
  version?: string;
  capabilities: AgentCapability[];
}
```

Possible capabilities:

```text
interactive_session
resume_session
modify_files
read_only_review
structured_output
```

### 7.2 Repository

```ts
interface RepositoryDescriptor {
  id: string;                 // configured alias
  root: string;               // server-side only
  defaultBranch?: string;
  verificationProfiles: string[];
  writable: boolean;
}
```

`root` should normally not be exposed to remote clients unless needed for diagnostics.

### 7.3 Task

```ts
interface CodingTask {
  id: string;
  repositoryId: string;
  agentId: string;
  status: TaskStatus;
  instruction: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  workspaceId?: string;
  exitCode?: number;
  failure?: TaskFailure;
}
```

### 7.4 Task states

```text
queued
starting
running
waiting_for_agent
completed
failed
cancelled
timed_out
```

`waiting_for_agent` is optional and only needed if an adapter can surface an interactive question that cannot be safely auto-answered.

---

## 8. Agent adapter contract

The core abstraction should resemble:

```ts
interface CodingAgent {
  describe(): Promise<AgentDescriptor>;

  start(input: AgentStartInput): Promise<AgentRunHandle>;

  continue?(input: AgentContinueInput): Promise<AgentRunHandle>;

  cancel?(runId: string): Promise<void>;
}
```

Suggested inputs:

```ts
interface AgentStartInput {
  repositoryRoot: string;
  workspaceRoot: string;
  instruction: string;
  mode: "implement" | "review" | "investigate";
  timeoutMs: number;
  environment: Record<string, string>;
}

interface AgentContinueInput {
  runId: string;
  sessionId?: string;
  instruction: string;
  timeoutMs: number;
}
```

The adapter owns:

- exact CLI executable;
- argument construction;
- session/resume syntax;
- stdout/stderr parsing;
- version detection;
- process exit interpretation;
- mapping CLI behavior into normalized task state.

The rest of the codebase must not parse Muse- or AGY-specific output.

---

## 9. Muse adapter

The Muse adapter must initially support:

- availability/version detection;
- starting a task in a configured workspace;
- sending a natural-language instruction;
- capturing stdout/stderr;
- returning the real exit code;
- detecting or storing a resumable session identifier when Muse supports it;
- continuing an existing task/session where supported;
- timeout/cancellation.

CLI syntax must be discovered and validated during implementation rather than hard-coded from assumptions in this document.

Tests should use a fake executable/process fixture so that the core suite does not require a paid Muse account.

---

## 10. AGY adapter

The AGY adapter has the same normalized contract as Muse:

- availability/version detection;
- task start;
- output capture;
- exit status;
- session resume when available;
- timeout/cancellation.

Any AGY-specific model, reasoning-effort or profile selection should be represented as optional adapter configuration, not public MCP concepts unless a genuine cross-agent abstraction emerges.

---

## 11. Repository and workspace model

### 11.1 Repository registry

Repositories are defined in server configuration:

```yaml
repositories:
  factorial:
    root: /home/david/src/factorial
    writable: true
    verification_profiles:
      - test
      - lint

  another-project:
    root: /home/david/src/another-project
    writable: true
```

MCP calls reference only the alias:

```json
{ "repository": "factorial" }
```

Unknown aliases are rejected.

### 11.2 Working directly vs isolated worktrees

The server should support two workspace strategies eventually:

```text
in_place
worktree
```

For the MVP, **Git worktree isolation is preferred** if practical.

Benefits:

- parallel tasks do not overwrite one another;
- current developer changes remain untouched;
- diff boundaries are clearer;
- cleanup is easier;
- task-level base SHA can be recorded.

A task workspace can be created under a configured directory such as:

```text
~/.coding-agent-mcp/workspaces/<task-id>/
```

The task should record:

- source repository;
- starting commit SHA;
- worktree path;
- branch name if one is created;
- final Git status.

If worktree support makes MVP implementation materially harder, `in_place` may ship first, but it must reject startup when the repository contains unsafe conflicting changes unless explicitly configured otherwise.

---

## 12. MCP tools

The MVP should expose a small, composable tool surface.

### 12.1 `list_agents`

Returns configured agents and availability.

Input:

```json
{}
```

Output example:

```json
{
  "agents": [
    {
      "id": "muse",
      "display_name": "Muse",
      "available": true,
      "version": "...",
      "capabilities": ["modify_files", "resume_session"]
    },
    {
      "id": "agy",
      "display_name": "AGY",
      "available": true,
      "version": "...",
      "capabilities": ["modify_files"]
    }
  ]
}
```

### 12.2 `list_repositories`

Returns configured repository aliases and safe metadata.

No arbitrary path discovery.

### 12.3 `start_task`

Starts a coding-agent task.

Input:

```json
{
  "repository": "factorial",
  "agent": "muse",
  "mode": "implement",
  "instruction": "Reproduce the classification regression, add a regression test, implement the fix, and do not commit.",
  "workspace_strategy": "worktree"
}
```

Output should return promptly with a task ID:

```json
{
  "task_id": "task_...",
  "status": "running",
  "agent": "muse",
  "repository": "factorial"
}
```

The MCP tool should not need to hold one request open for the full lifetime of a long coding job.

### 12.4 `continue_task`

Sends follow-up instructions to an existing task/session.

Example:

```json
{
  "task_id": "task_...",
  "instruction": "The new test passes, but the change breaks explicit business classification. Correct that regression and rerun the relevant tests."
}
```

If the underlying agent cannot resume sessions, the adapter may start a new process using normalized task context. This behavior must be surfaced in the response.

### 12.5 `get_task`

Returns task state and concise metadata.

Suggested fields:

```json
{
  "task_id": "task_...",
  "status": "completed",
  "agent": "muse",
  "started_at": "...",
  "finished_at": "...",
  "exit_code": 0,
  "session_resumable": true,
  "output_truncated": false
}
```

### 12.6 `get_task_output`

Returns normalized task output with pagination/cursor support.

Input:

```json
{
  "task_id": "task_...",
  "cursor": null,
  "max_bytes": 20000
}
```

Output must distinguish stdout/stderr where practical and indicate truncation.

### 12.7 `cancel_task`

Cancels a running task using graceful termination first and force termination after a configured grace period.

### 12.8 `get_repo_status`

Returns structured Git status for the task workspace or configured repository.

Prefer structured files over raw `git status` prose:

```json
{
  "branch": "agent/task_...",
  "base_sha": "...",
  "head_sha": "...",
  "files": [
    { "path": "src/...", "status": "modified" },
    { "path": "tests/...", "status": "added" }
  ]
}
```

### 12.9 `get_diff`

Returns the Git diff for a task workspace.

Inputs may include:

```json
{
  "task_id": "task_...",
  "staged": false,
  "max_bytes": 100000
}
```

The response must indicate truncation and provide file-level summary metadata even when the patch is too large.

### 12.10 `run_verification`

Runs a configured verification profile, **not an arbitrary command**.

Input:

```json
{
  "task_id": "task_...",
  "profile": "test"
}
```

Config example:

```yaml
verification_profiles:
  test:
    command: ["npm", "test"]
    timeout_seconds: 900

  lint:
    command: ["npm", "run", "lint"]
    timeout_seconds: 300
```

Output:

```json
{
  "profile": "test",
  "passed": true,
  "exit_code": 0,
  "duration_ms": 12345,
  "stdout": "...",
  "stderr": "...",
  "truncated": false
}
```

### 12.11 Optional later tool: `create_commit`

Commit creation is intentionally **not required for MVP phase 1**.

If added, it must be a dedicated operation with a caller-supplied message and must not support arbitrary Git arguments.

Pushing and PR creation should remain outside the initial local MCP unless there is a clear reason to add them.

---

## 13. Expected orchestration flow

The project should enable a supervisor to perform this cycle without embedding the cycle itself into the server:

```text
1. list_agents
2. start_task(agent=muse, task=implement bugfix)
3. get_task / get_task_output
4. get_diff
5. run_verification(test)
6. supervisor reviews real diff + real test result
7. continue_task(correct regression)
8. get_diff
9. run_verification(test)
10. supervisor accepts or iterates again
```

A second-agent review should also be possible:

```text
Muse -> implementation
AGY  -> review/investigate
Muse -> correction
MCP  -> deterministic tests
Supervisor -> final decision
```

The MCP server coordinates processes and state. The client/supervisor decides the strategy.

---

## 14. Task execution and process management

### 14.1 Long-running tasks

Agent runs may take minutes. The process manager must therefore:

- spawn the agent process independently of the originating request;
- record PID/process handle;
- continuously capture bounded output;
- update task status;
- enforce timeout;
- preserve enough task state to query later;
- reap child processes correctly.

### 14.2 Output buffering

Avoid unbounded memory use.

Recommended approach:

- stream output to a task log file;
- keep only a small tail in memory;
- paginate output through `get_task_output`;
- enforce maximum persisted log size or rotation;
- indicate truncation explicitly.

### 14.3 Cancellation

Cancellation sequence:

1. mark cancellation requested;
2. send graceful signal;
3. wait configured grace period;
4. force kill process tree if still alive;
5. mark task `cancelled`;
6. retain workspace for inspection unless cleanup policy says otherwise.

Child process trees must be considered; killing only the parent CLI is insufficient if it leaves subprocesses behind.

---

## 15. Security model

This project intentionally gives an AI-controlled client the ability to ask local coding agents to modify source code. Security is therefore a first-class requirement.

### 15.1 No generic shell tool

Never expose arbitrary remote shell execution as an MCP tool.

### 15.2 Repository allowlist

Only configured repository aliases may be accessed.

Use realpath/canonical path checks to prevent:

- `..` traversal;
- symlink escapes;
- alternate path spellings escaping an allowed root.

### 15.3 Process allowlist

Only configured agent executables and verification commands may run.

Executable paths should preferably be resolved at server startup and validated.

### 15.4 Environment filtering

Do not inherit every server environment variable into worker agents by default.

Configuration should explicitly define allowed/passed variables.

Sensitive examples to avoid leaking unintentionally:

- unrelated API keys;
- cloud credentials;
- SSH agent/socket configuration where unnecessary;
- secrets used by other local services.

### 15.5 No sudo

The server and child processes must run as an unprivileged OS user.

### 15.6 Time/resource limits

Each task and verification profile must have configurable:

- timeout;
- max output;
- max concurrent processes.

Optional later hardening:

- CPU/memory limits;
- containers/sandboxing;
- filesystem namespace isolation;
- network policy.

### 15.7 Git destructive operations

Do not expose remote primitives for:

- `git reset --hard`;
- `git clean -fdx`;
- force push;
- deleting branches;
- rewriting arbitrary history.

Internal workspace cleanup may perform destructive operations only inside server-owned disposable worktrees.

### 15.8 Network exposure

The server should listen on localhost by default.

Remote MCP access should be provided through an authenticated secure tunnel/reverse connection rather than binding a privileged coding endpoint directly to the public Internet.

Tunnel implementation is deployment-specific and not part of the core orchestration domain.

---

## 16. Configuration

Example conceptual config:

```yaml
server:
  data_dir: ~/.coding-agent-mcp
  max_concurrent_tasks: 2
  default_task_timeout_seconds: 1800
  output_limit_bytes: 5000000

agents:
  muse:
    enabled: true
    executable: /usr/local/bin/muse
    default_timeout_seconds: 1800
    env_allowlist:
      - HOME
      - PATH

  agy:
    enabled: true
    executable: /usr/local/bin/agy
    default_timeout_seconds: 1800
    env_allowlist:
      - HOME
      - PATH

repositories:
  factorial:
    root: /home/david/src/factorial
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

Config validation must happen at startup with actionable errors.

Unknown fields should preferably fail validation rather than be silently ignored for security-relevant configuration.

---

## 17. Persistence

MVP persistence can be SQLite or a simple durable local store.

Persist at least:

- task ID;
- repository ID;
- agent ID;
- original instruction;
- follow-up instructions;
- timestamps;
- state transitions;
- session identifier if applicable;
- workspace metadata;
- process exit code;
- validation runs;
- failure reason;
- audit events.

Large stdout/stderr should live in files referenced by task metadata rather than bloating the database.

After server restart:

- previously running processes that cannot be safely reattached should become a terminal `failed`/`interrupted` state;
- completed task metadata and logs should remain inspectable.

---

## 18. Audit log

Record structured events such as:

```text
task.created
task.started
agent.process_spawned
agent.output_truncated
task.completed
task.failed
task.cancel_requested
verification.started
verification.completed
workspace.created
workspace.cleaned
```

Do not store secrets in audit records.

The audit log is diagnostic, not a replacement for application logs.

---

## 19. Error model

MCP tools should return stable machine-readable error categories, for example:

```text
AGENT_NOT_AVAILABLE
REPOSITORY_NOT_FOUND
REPOSITORY_NOT_WRITABLE
WORKSPACE_CONFLICT
TASK_NOT_FOUND
TASK_NOT_RUNNING
TASK_NOT_RESUMABLE
TASK_TIMEOUT
TASK_CANCELLED
PROCESS_START_FAILED
VERIFICATION_PROFILE_NOT_FOUND
VERIFICATION_TIMEOUT
OUTPUT_TRUNCATED
POLICY_DENIED
INTERNAL_ERROR
```

Include a human-readable message and safe contextual details.

Do not return raw environment variables or secret-bearing command lines in errors.

---

## 20. Concurrency

MVP should support at least:

- multiple completed/persisted tasks;
- a configurable number of concurrently running tasks;
- isolation between concurrent workspaces.

A single repository using `in_place` mode must not permit conflicting concurrent writers.

Worktree mode should be the path to safe parallelism.

---

## 21. MCP resources/prompts

The MVP can be implemented entirely with tools.

Optional resources later may expose:

- task logs;
- task metadata;
- repository summaries.

Avoid duplicating the same information across tools and resources until a concrete client need appears.

Server-provided MCP prompts are not required initially; orchestration prompts belong primarily to the consuming client.

---

## 22. Client integrations are separate

This distinction is intentional and architectural.

### Core project

```text
coding-agent-mcp
  -> MCP protocol
  -> safe local task execution
  -> Muse/AGY adapters
  -> Git observation
  -> deterministic verification
```

### Separate consumers/integrations

Examples:

```text
ChatGPT / OpenAI client
Claude Desktop
custom OpenAI API client
other MCP-capable orchestrator
```

An OpenAI-specific client may later provide features such as:

- planning a coding task;
- selecting Muse vs AGY;
- automatically reviewing diffs;
- deciding whether another iteration is required;
- coordinating GitHub issues/PRs with the local MCP.

Those behaviors must **not** be required for the MCP server to function and should live in a separate integration/application layer or even a separate repository if substantial.

---

## 23. ACP relationship

ACP (Agent Client Protocol) is relevant conceptually because it standardizes interactions with coding agents.

For this project:

- MCP is the external/public protocol exposed by `coding-agent-mcp`.
- Muse and AGY adapters may initially invoke their CLIs directly.
- If Muse, AGY or future agents expose ACP cleanly, an ACP-backed internal adapter can be added later.
- The domain model must not assume ACP is available.

Possible future architecture:

```text
MCP client
   |
   v
coding-agent-mcp
   |
   +-- direct CLI adapter -> Muse
   +-- direct CLI adapter -> AGY
   +-- ACP adapter        -> future ACP-compatible agents
```

This avoids coupling the MVP to another protocol while leaving a clean upgrade path.

---

## 24. Verification philosophy

There are two independent forms of review:

### 24.1 Agent/model review

A supervisor or secondary agent can reason about:

- correctness;
- architecture;
- edge cases;
- test quality;
- whether the diff actually addresses the task.

### 24.2 Deterministic checks

The MCP server executes configured commands and reports factual results:

- tests;
- lint;
- typecheck;
- build;
- formatter check;
- project-specific validation.

The two should never be conflated.

Example successful completion criteria from a supervisor may be:

```text
- requested regression test exists;
- diff is scoped to the issue;
- no suspicious unrelated changes;
- test profile exits 0;
- lint exits 0;
- reviewer finds no remaining correctness issue.
```

The MCP server supplies the evidence; the supervisor makes the judgment.

---

## 25. Recommended MVP phases

### Phase 0 — repository skeleton

Deliver:

- project scaffold;
- config schema;
- logging;
- MCP server startup;
- health/version information;
- unit test harness.

### Phase 1 — read/execute foundation

Deliver:

- repository registry;
- `list_repositories`;
- Git status/diff service;
- verification profiles;
- `run_verification`;
- security/path policy tests.

No coding agent required yet.

### Phase 2 — task engine + one worker

Deliver:

- persistent task model;
- process manager;
- output capture;
- timeout/cancel;
- `start_task`;
- `get_task`;
- `get_task_output`;
- `cancel_task`;
- first working adapter: **Muse or whichever CLI is easier to validate locally first**.

### Phase 3 — continuation and second worker

Deliver:

- session/resume abstraction;
- `continue_task`;
- AGY adapter;
- `list_agents` capability reporting;
- normalized adapter integration tests.

### Phase 4 — workspace isolation

Deliver:

- Git worktree manager;
- task-specific base SHA;
- parallel task safety;
- cleanup policy;
- workspace integration tests.

If worktrees are easy enough, Phase 4 may move earlier.

### Phase 5 — hardening

Deliver:

- durable audit log;
- restart recovery semantics;
- output pagination/limits;
- process-tree cancellation;
- security review;
- documented tunnel deployment example.

---

## 26. MVP acceptance criteria

The MVP is considered useful when all of the following are true:

1. The server starts locally with validated configuration.
2. An MCP client can list configured repositories.
3. An MCP client can list Muse/AGY availability.
4. A caller can start a task against an allowlisted repository without supplying a filesystem path.
5. The chosen agent can modify files in the task workspace.
6. The caller can query task state after the initial call returns.
7. The caller can read bounded/paginated agent output.
8. The caller can inspect structured Git status and a diff.
9. The caller can run at least one configured test/verification profile and receive the real exit code.
10. The caller can give corrective follow-up instructions when the selected adapter supports continuation.
11. A timeout or cancellation terminates the worker process tree.
12. Attempts to access an unconfigured path/repository are rejected.
13. No arbitrary shell MCP tool exists.
14. Unit/integration tests cover path traversal, command restrictions and task lifecycle.
15. The core server contains no dependency on OpenAI/ChatGPT-specific APIs.

---

## 27. Test strategy

### Unit tests

- config validation;
- repository alias resolution;
- canonical path/symlink escape prevention;
- task state transitions;
- command-policy enforcement;
- output truncation/pagination;
- timeout behavior;
- adapter output normalization.

### Fake agent integration tests

Provide a tiny fake coding-agent executable capable of:

- printing output;
- sleeping;
- exiting non-zero;
- modifying a fixture file;
- spawning a child process;
- emitting a fake session ID.

Use it to test the entire task/process layer without Muse/AGY credentials.

### Git integration tests

Use temporary repositories to verify:

- clean status;
- modified/added/deleted files;
- diff generation;
- worktree lifecycle;
- concurrent worktree isolation.

### Real-agent smoke tests

Keep these opt-in and excluded from normal CI:

```text
MUSE_SMOKE_TEST=1
AGY_SMOKE_TEST=1
```

They validate only CLI compatibility and adapter assumptions.

---

## 28. Suggested initial repository structure

```text
coding-agent-mcp/
  README.md
  SPEC.md
  LICENSE

  src/
    index.*
    server/
    domain/
    orchestration/
    agents/
    repositories/
    verification/
    security/
    persistence/
    config/

  test/
    unit/
    integration/
    fixtures/
      fake-agent/

  examples/
    config.example.yaml

  docs/
    security.md
    deployment.md
    adapters.md
```

---

## 29. Future capabilities

Not required for the MVP, but the architecture should leave room for:

- more agents (Codex CLI, Claude Code, Gemini CLI, etc.);
- ACP-backed agents;
- explicit agent-to-agent review workflows;
- automatic task retry policies;
- configurable model/profile selection per adapter;
- cost/token accounting where CLIs expose it;
- commit creation;
- branch creation;
- patch export;
- sandbox/container execution;
- repository-specific instruction templates;
- richer structured progress events;
- optional webhook/event streaming;
- remote worker nodes.

These should be added only when driven by real usage.

---

## 30. Example end-to-end scenario

A supervisor receives a bug report and decides Muse should implement it.

```text
Supervisor
  -> start_task(
       repository="factorial",
       agent="muse",
       mode="implement",
       instruction="Reproduce the bug, add a regression test, implement the fix. Do not commit."
     )

coding-agent-mcp
  -> creates isolated workspace
  -> launches Muse
  -> captures output
  -> returns task_id

Supervisor
  -> polls get_task
  -> reads get_task_output
  -> calls get_diff
  -> calls run_verification(profile="test")

Supervisor observes:
  - expected regression test exists
  - test suite passes
  - another classification edge case is broken

Supervisor
  -> continue_task(
       task_id=...,
       instruction="The change regresses explicit business classification. Preserve that behavior and add coverage."
     )

coding-agent-mcp
  -> resumes/restarts normalized Muse session

Supervisor
  -> get_diff
  -> run_verification(test)
  -> final code review
  -> accepts result
```

Nothing in this flow requires the supervisor to be OpenAI. The supervisor only needs to be able to call MCP tools and reason about the returned evidence.

---

## 31. Implementation decisions to validate first

Before significant code is written, verify these concrete local facts:

1. Exact Muse CLI invocation for non-interactive prompts.
2. Whether Muse exposes a resumable session ID and how continuation works.
3. Exact AGY CLI invocation for non-interactive prompts.
4. Whether AGY exposes resumable sessions.
5. Whether either CLI requires a TTY for normal coding operation.
6. How each CLI signals completion/failure.
7. Which environment variables they actually need.
8. Whether Git worktrees work cleanly with their repository discovery behavior.

Adapter implementation should follow observed behavior, not assumptions.

---

## 32. Definition of the product

The simplest useful definition is:

> `coding-agent-mcp` is a safe local MCP bridge that turns installed coding agents into observable, resumable workers that an external supervisor can delegate to, inspect, verify and correct.

The **orchestration intelligence** may live in ChatGPT/OpenAI or another MCP client. The **execution, isolation, normalization and verification boundary** lives here.
