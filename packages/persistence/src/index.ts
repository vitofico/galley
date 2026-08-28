/**
 * @galley/persistence — adapters for the `@galley/shared` store seams
 * (ProjectStore / CrdtStore / VersionStore), per roadmap #4 / ADR-0018.
 *
 * In-memory reference implementations now (validate the seams + drive tests);
 * SQLite + filesystem bare-git adapters land in the next slice and must behave
 * identically. The CRDT stays the source of truth; these only persist + project.
 */
export {
  InMemoryProjectStore,
  InMemoryGroupStore,
  InMemoryCrdtStore,
  InMemoryVersionStore,
} from "./in-memory.js";
export type { IdGenerator } from "./in-memory.js";
export { FsProjectStore, FsCrdtStore } from "./fs.js";
export { FsGroupStore } from "./fs-groups.js";
export { PgCrdtStore } from "./pg.js";
export { membershipAuthorizer, projectOrGroupMembershipAuthorizer } from "./authorizer.js";
export { GitVersionStore } from "./git-version-store.js";
export type { SecondsClock } from "./git-version-store.js";
// The commit-message format (roadmap #11/#12) — also on the `/browser` barrel,
// which is how the web app's GitHub push path reaches the same encoder.
export {
  encodeMessage,
  decodeMessage,
  sanitizeTrailer,
  coauthorEmail,
  CONTRIBUTOR_TRAILER,
  COAUTHOR_TRAILER,
} from "./version-message.js";
export type { VersionMessageInput } from "./version-message.js";
export { FsSessionStore, FsOidcLoginStateStore } from "./fs-auth-stores.js";
export { FsCapabilityRoomRegistry } from "./fs-capability-rooms.js";
// Git-remote projection (ADR-0018/0019). Browser-safe core + Node-only adapters
// are re-aggregated by `git-remote.ts` so this Node barrel keeps stable names.
export {
  pushTree,
  fetchTree,
  redactUrl,
  urlHasUserinfo,
  redactRemoteError,
  LocalBareRemoteSync,
  HttpRemoteSync,
  createNodeHttpRemoteSync,
  DEFAULT_FETCH_LIMITS,
} from "./git-remote.js";
export type {
  RemoteConfig,
  PushResult,
  RemoteSync,
  FetchLimits,
  GitHttpClient,
  GitFs,
  ScratchProvider,
} from "./git-remote.js";
export { createBrowserGitHttp } from "./browser-git-http.js";
export { createMemoryGitFs } from "./browser-git-fs.js";
export { createBrowserRemoteSync } from "./browser-remote-sync.js";
// Export-as-git-repo core (roadmap #17.5) — browser-safe, also on the
// `@galley/persistence/browser` barrel for the web UI.
export { exportProjectAsGitRepo } from "./project-export-git.js";
export type { GitRepoExport, GitExportOutcome, GitExportOptions } from "./project-export-git.js";
