/**
 * T3 Phase 1 integration barrel.
 * Re-exports config schema, client, auth helpers, and tool registration function.
 */

export { T3ConfigSchema, T3_CONFIG_DEFAULTS } from "./t3-config.js";
export type { T3Config } from "./t3-config.js";

export {
  T3Client,
  T3HttpError,
  T3ConfigError,
  createT3Client,
  normalizeRoot,
  redactExact,
  redactGenericTokenPatterns,
} from "./t3-client.js";
export type {
  T3ModelSelection,
  T3Snapshot,
  T3SnapshotProject,
  T3SnapshotThread,
  T3LatestTurn,
  T3Session,
  T3ThreadDetailSnapshot,
  T3DispatchResult,
  T3DispatchCommand,
  T3AuthSessionState,
} from "./t3-client.js";

export { authorizeThread, authorizeProject, isWorktreeThread } from "./t3-auth.js";
export type { T3AuthorizedRepo } from "./t3-auth.js";

export { registerT3Tools } from "./t3-tools.js";
export type { T3ToolServices } from "./t3-tools.js";
