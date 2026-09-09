# T3 orchestration integration — Phase 1

## Goal

Redirect `coding-agent-mcp` so T3 owns coding-agent sessions, turns, approvals, user input, checkpoints and worktrees. `coding-agent-mcp` remains the MCP-facing supervisor surface and deterministic verification layer.

Target architecture:

```text
MCP client / ChatGPT
        |
        v
coding-agent-mcp
        |
        | HTTP JSON (Phase 1)
        v
T3 server (default http://127.0.0.1:3773)
        |
        +--> Antigravity provider
        +--> Muse provider
```

Phase 1 is additive. Do **not** remove or change the existing direct Muse/AGY task flow. Add T3-backed tools alongside the existing tools so we can smoke-test the new path before deleting legacy orchestration.

## Confirmed T3 API

T3 exposes an authenticated Environment HTTP API.

Orchestration endpoints:

- `GET /api/orchestration/snapshot`
  - scope: `orchestration:read`
  - returns `{ snapshotSequence, projects, threads, updatedAt }`
- `GET /api/orchestration/shell`
  - scope: `orchestration:read`
- `GET /api/orchestration/threads/:threadId`
  - scope: `orchestration:read`
  - optional query params: `turnLimit`, `beforeCursor`
- `POST /api/orchestration/dispatch`
  - scope: `orchestration:operate`
  - payload: one `ClientOrchestrationCommand`
  - returns `{ sequence }`

Auth endpoints relevant to a non-browser client:

- `GET /api/auth/session`
- `POST /oauth/token`
- `POST /api/auth/websocket-ticket`

For Phase 1, use a pre-issued bearer access token from an environment variable. Do not implement pairing/bootstrap exchange yet.

T3 access-token sessions default to 30 days. WebSocket tickets default to 5 minutes. WebSocket integration is Phase 2; Phase 1 uses HTTP snapshots/polling only.

Required scopes for the configured token:

- `orchestration:read`
- `orchestration:operate`

## Configuration

Extend app config additively with:

```yaml
t3:
  enabled: false
  base_url: http://127.0.0.1:3773
  access_token_env: T3_ACCESS_TOKEN
  request_timeout_ms: 15000
```

Requirements:

- `enabled` defaults to `false` so current installations remain unchanged.
- Never put the token value itself into serialized config or tool responses.
- Resolve the token from `process.env[access_token_env]`.
- Strip a trailing slash from `base_url`.
- When `enabled: true`, missing token must fail with a clear typed/local error.
- No arbitrary base URL supplied by MCP callers; only server config controls it.

## T3Client

Add a small client module, for example `src/t3/t3-client.ts`.

Responsibilities:

- construct authenticated HTTP requests with `Authorization: Bearer <token>`;
- JSON encode/decode;
- enforce request timeout using `AbortController`;
- surface non-2xx responses with status + bounded response body;
- never log the bearer token;
- methods:
  - `getSession()` -> `GET /api/auth/session`
  - `getSnapshot()` -> `GET /api/orchestration/snapshot`
  - `getThreadSnapshot(threadId, options?)` -> `GET /api/orchestration/threads/:threadId`
  - `dispatch(command)` -> `POST /api/orchestration/dispatch`
  - `ensureProject(repositoryAlias, repositoryRoot)`

Use `crypto.randomUUID()` for T3 `commandId`, `projectId`, `threadId`, and `messageId`. T3 identifier schemas are branded non-empty trimmed strings; UUIDs are valid.

Use `new Date().toISOString()` for `createdAt`.

## Project mapping

`coding-agent-mcp` already has a repository registry. T3 projects should be resolved by `workspaceRoot`, not by a separate local mapping database.

`ensureProject(repositoryAlias, repositoryRoot)`:

1. call `getSnapshot()`;
2. find a project whose `workspaceRoot` equals the configured repository root;
3. if found, return its id;
4. if absent, dispatch:

```json
{
  "type": "project.create",
  "commandId": "<uuid>",
  "projectId": "<uuid>",
  "title": "<repository alias>",
  "workspaceRoot": "<configured repository root>",
  "createdAt": "<iso>"
}
```

Then return the created project id.

Do not accept arbitrary project/workspace paths from MCP callers.

## Starting a T3 task

Add an MCP tool `t3_start_task`.

Input:

```ts
{
  repository: string,
  provider_instance: string,
  model: string,
  instruction: string,
  runtime_mode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  interaction_mode?: "default" | "plan",
  workspace_strategy?: "worktree" | "in_place",
  title?: string
}
```

Defaults:

- `runtime_mode`: `approval-required`
- `interaction_mode`: `default`
- `workspace_strategy`: repository config's `default_workspace_strategy`
- title: concise deterministic title derived from repository + instruction; truncation is fine.

Flow:

1. resolve repository through the existing `RepositoryRegistry`;
2. `ensureProject()`;
3. create `threadId`, `commandId`, `messageId`;
4. build a `thread.turn.start` command with bootstrap thread creation;
5. dispatch once;
6. return promptly with the T3 thread id and dispatch sequence. Do not wait for the coding agent to finish.

Confirmed client command shape:

```json
{
  "type": "thread.turn.start",
  "commandId": "<uuid>",
  "threadId": "<uuid>",
  "message": {
    "messageId": "<uuid>",
    "role": "user",
    "text": "<instruction>",
    "attachments": []
  },
  "modelSelection": {
    "instanceId": "<provider_instance>",
    "model": "<model>"
  },
  "runtimeMode": "approval-required",
  "interactionMode": "default",
  "bootstrap": {
    "createThread": {
      "projectId": "<project id>",
      "title": "<title>",
      "modelSelection": {
        "instanceId": "<provider_instance>",
        "model": "<model>"
      },
      "runtimeMode": "approval-required",
      "interactionMode": "default",
      "branch": null,
      "worktreePath": null,
      "createdAt": "<iso>"
    }
  },
  "createdAt": "<iso>"
}
```

For `workspace_strategy: worktree`, also set:

```json
"prepareWorktree": {
  "projectCwd": "<repository root>",
  "baseBranch": "<configured repository.default_branch>",
  "startFromOrigin": true
}
```

If worktree mode is requested and `repository.default_branch` is not configured, fail clearly in Phase 1 rather than guessing a branch.

For `in_place`, omit `prepareWorktree`.

Do not let the caller supply `projectCwd` or `baseBranch` independently of repository configuration.

## Continue task

Add `t3_continue_task`:

```ts
{
  thread_id: string,
  instruction: string,
  model?: string
}
```

Flow:

1. fetch the thread snapshot;
2. reuse `thread.modelSelection.instanceId`, `thread.runtimeMode`, and `thread.interactionMode`;
3. if `model` is provided, use it with the same instance id; otherwise reuse current model;
4. dispatch another `thread.turn.start` without bootstrap:

```json
{
  "type": "thread.turn.start",
  "commandId": "<uuid>",
  "threadId": "<existing>",
  "message": {
    "messageId": "<uuid>",
    "role": "user",
    "text": "<instruction>",
    "attachments": []
  },
  "modelSelection": {
    "instanceId": "<existing instance>",
    "model": "<existing or overridden model>"
  },
  "runtimeMode": "<existing>",
  "interactionMode": "<existing>",
  "createdAt": "<iso>"
}
```

## Read/status tool

Add `t3_get_task`:

```ts
{
  thread_id: string,
  turn_limit?: number
}
```

Fetch `/api/orchestration/threads/:threadId?turnLimit=N` (default a small bounded window such as 10).

Return a bounded JSON object containing at least:

- thread id/title/project id;
- model selection;
- runtime/interaction modes;
- branch/worktree path;
- latest turn;
- session status/provider/active turn id/last error;
- recent messages;
- recent activities;
- checkpoints;
- snapshot sequence/page metadata.

It is acceptable in Phase 1 to return the decoded thread snapshot nearly as-is, but bound JSON text sent back to MCP to avoid unbounded output.

## Interrupt/cancel

Add `t3_cancel_task`:

```ts
{
  thread_id: string,
  turn_id?: string
}
```

Dispatch:

```json
{
  "type": "thread.turn.interrupt",
  "commandId": "<uuid>",
  "threadId": "<thread_id>",
  "turnId": "<optional turn_id>",
  "createdAt": "<iso>"
}
```

If no `turn_id` is supplied, fetch the thread first and use `thread.session.activeTurnId` when available. The command also permits omitting `turnId`; use that only if the snapshot does not expose an active id.

## Approval response

Add `t3_respond_approval`:

```ts
{
  thread_id: string,
  request_id: string,
  decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
}
```

Dispatch `thread.approval.respond` with `commandId`, `threadId`, `requestId`, `decision`, `createdAt`.

## User-input response

Add `t3_respond_user_input`:

```ts
{
  thread_id: string,
  request_id: string,
  answers: Record<string, unknown>
}
```

Dispatch `thread.user-input.respond` with `commandId`, `threadId`, `requestId`, `answers`, `createdAt`.

Do not expose `thread.user-input.dismiss` yet; native callback questions may not be dismissible and Phase 1 should prefer an explicit answer.

## Stop session

Add `t3_stop_session`:

```ts
{ thread_id: string }
```

Dispatch `thread.session.stop` with `commandId`, `threadId`, `createdAt`.

## Connection/status tool

Add `t3_status` with no input.

It should call `GET /api/auth/session` and optionally a lightweight orchestration snapshot. Return:

- enabled/configured;
- base URL;
- authenticated;
- scopes;
- session method/expiry if returned;
- server reachable;

Never return or log token contents.

## Existing tools stay intact

Do not change semantics of:

- `start_task`
- `continue_task`
- `get_task`
- `get_task_output`
- `cancel_task`
- existing Git/diff/verification tools

Phase 1 is additive. `TaskManager`, `ProcessManager`, direct Muse adapter, and direct AGY adapter remain available.

The goal of this PR is to prove the T3-backed path before deleting any old path.

## Wiring

- Construct one `T3Client` in `src/index.ts` when config is loaded.
- Include it in `ToolServices` as optional/disabled-aware service.
- Register `t3_*` tools regardless of whether enabled, but return a clear configuration error if `t3.enabled` is false. Alternatively register them only when enabled; choose the style that best matches existing code, but test it.

## Tests

Use Node's existing `tsx --test` test stack. Do not require a live T3 server for unit tests.

Add a local mock HTTP server and cover at least:

1. bearer header is sent and never included in surfaced errors;
2. non-2xx errors preserve HTTP status and bounded safe body;
3. request timeout aborts;
4. `getSnapshot` and `getThreadSnapshot` paths/query params;
5. `dispatch` POST body;
6. `ensureProject` reuses project matched by workspaceRoot;
7. `ensureProject` dispatches `project.create` when absent;
8. `t3_start_task` constructs a valid in-place bootstrap command;
9. worktree mode uses only configured repo root/default branch and rejects missing `default_branch`;
10. `t3_continue_task` reuses model/runtime/interaction state;
11. interrupt command behavior with and without active turn id;
12. approval and user-input response command mapping;
13. T3 disabled/missing-token behavior;
14. existing tests remain green.

Run:

```bash
npm test
npm run build
```

## Phase 1 acceptance criteria

- Existing direct-agent behavior unchanged.
- `npm test` passes.
- `npm run build` passes.
- With a real T3 server + bearer token, `t3_status` succeeds.
- A real `t3_start_task` using Muse creates a thread visible in the T3 UI and starts a Muse turn.
- A real `t3_start_task` using Antigravity creates a thread visible in the T3 UI and starts an Antigravity turn.
- `t3_continue_task` continues the same T3 thread/session.
- `t3_cancel_task` interrupts a running turn.
- No direct Muse/AGY session state is created by any `t3_*` tool.

## Phase 1 Security Decisions and Hardening

The following security hardening rules are enforced across all `t3_*` tools in Phase 1:

1. **Thread IDs are not authorization**:
   A caller possessing a valid `thread_id` cannot perform operations on that thread unless the underlying T3 project's canonical `workspaceRoot` maps to a repository configured in `coding-agent-mcp`.
2. **All T3 thread operations are repository-scoped**:
   Every operation on an existing thread (`t3_continue_task`, `t3_get_task`, `t3_cancel_task`, `t3_respond_approval`, `t3_respond_user_input`, `t3_stop_session`) fetches the thread snapshot, resolves its project in the T3 snapshot, and verifies that the canonical workspace root matches a configured repository in `RepositoryRegistry`. If no match is found, the request fails with `POLICY_DENIED` without leaking unconfigured paths or project names. Even `t3_cancel_task` with an explicit `turn_id` enforces repository authorization.
3. **Phase 1 T3-backed creation and resume is worktree-only**:
   - `t3_start_task` rejects `workspace_strategy: in_place` (explicitly or via repository default) with `POLICY_DENIED`. It also enforces repository write policy (`repo.writable === true`), returning `REPOSITORY_NOT_WRITABLE` for read-only repositories.
   - Operations that resume or advance agent execution (`t3_continue_task`, `t3_respond_approval`, `t3_respond_user_input`) require a worktree-backed thread (`branch !== null || worktreePath !== null`) and a writable repository.
   - Read-only or terminal operations (`t3_get_task`, `t3_cancel_task`, `t3_stop_session`) remain permitted for configured in-place threads.
4. **In-place execution parity deferred until lifecycle-aware locking exists**:
   The legacy direct-agent pipeline provides extensive in-place safety protections (clean-tree validation, policy verification, exclusive in-place lifecycle locking via `WorkspaceManager`). The HTTP-only T3 integration cannot safely acquire, monitor, and release that lifecycle lock across independent HTTP dispatch calls. In-place support for T3-backed tasks is therefore deferred until lifecycle-aware coordination or WebSocket RPC is available in Phase 2.
5. **Lazy token resolution & exact token redaction**:
   The T3 bearer token is resolved lazily at request time from the environment variable (`access_token_env`), allowing server construction without requiring credentials up front and enabling zero-downtime token rotation. Error sanitization explicitly replaces the exact resolved token value with `[REDACTED]` prior to running generic token/bearer regexes, preventing credential exposure under arbitrary JSON keys or in network error messages.


## Phase 2 (not this PR)

After Phase 1 smoke tests are green:

- WebSocket RPC `/ws` using `POST /api/auth/websocket-ticket`;
- subscribe to shell/thread streams;
- push-based turn completion and event observation;
- approval/user-input discovery without polling;
- normalized T3 task façade replacing the old local `TaskStore` path;
- remove direct Muse/AGY orchestration only after parity is demonstrated.
