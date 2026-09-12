# `agy-acp` — Experimental Antigravity ACP Adapter

> Status: opt-in. ACP execution is wired into the managed `TaskManager`
> lifecycle, while the legacy `agy` adapter remains available independently.

## What exists in phase 1

- Disabled-by-default `agents.agy-acp` configuration (`enabled: false`):
  `acp_executable`, optional wrapper `acp_args`, `auth_method`
  (`oauth-personal` | `oauth-business` | `gemini-api-key` | `agent-platform`),
  optional `model`, `mode` (`default` | `auto_edit` | `yolo`),
  `allow_write_worktree` (default `false`), `state_dir`,
  `default_timeout_seconds`, `env_allowlist`. Config validation rejects the
  unsafe combination `mode: yolo` unless `allow_write_worktree: true`.
  When `auth_method: gemini-api-key`, an explicitly allowlisted
  `GEMINI_API_KEY` is forwarded to the isolated ACP process; all ambient
  Google/Gemini/Antigravity credentials remain stripped in other modes. The
  adapter also selects `gemini-api-key` through ACP before opening or resuming
  a session, preventing a persisted OAuth profile from silently taking
  precedence over the configured API route.
- Dependency-light ACP JSON-RPC/NDJSON protocol client under
  `src/agents/acp/` (incremental framing with bounded line size, numeric
  request ids with timeouts, response/notification/inbound-request handling,
  clean close). Any structural corruption (malformed/oversized line,
  unexpected shape or response id, non-`2.0` message) is terminal: the
  client closes and fails all pending requests. `onProtocolError` only
  observes; it cannot resume the client. No orchestration integration.
- `agents.agy-acp.state_dir` may live under `server.data_dir` (the default
  does) but must stay outside every configured repository root; startup
  validation rejects overlaps with the same realpath-aware comparison as
  `server.data_dir`.
- Pure permission-policy helper (`decideAcpToolPermission`) built on the
  existing canonical path-containment helpers. No yolo bypass exists on
  purpose.
- A fake ACP kernel fixture (`test/fixtures/agy-acp-fake-server.mjs`) for
  protocol-level tests only.

## Operator requirement

The official `agy_acp_server` binary must be installed and provided by the
operator (point `agents.agy-acp.acp_executable` at it). This project ships
**no downloader** and redistributes **no kernel**. Authentication material
lives with the operator; phase 1 stores nothing.

## Current limitations

- The project does not install or update the ACP kernel or optional wrappers.
- Real-provider authentication and model availability remain operator-managed.
- The `session/request_permission` inbound shape used by the fake kernel is
  a test convention for exercising the protocol client, not a
  compatibility claim about the real server.

See `examples/config.example.yaml` for an annotated (disabled) example.
