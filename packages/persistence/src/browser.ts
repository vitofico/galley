/**
 * @galley/persistence/browser — the BROWSER-SAFE entry point (ADR-0019).
 *
 * Exposes ONLY the runtime-neutral pieces: the git-remote transport core
 * (`pushTree`/`fetchTree` + redaction + caps + `HttpRemoteSync`), the browser
 * adapter (`createBrowserRemoteSync`, `createBrowserGitHttp`, `createMemoryGitFs`),
 * and the export-as-git-repo core (`exportProjectAsGitRepo`, roadmap #17.5).
 * It deliberately does NOT re-export the main barrel — that pulls
 * `git-version-store` and the Node-only `git-remote-node` (both `node:fs`), which
 * would break the Vite browser bundle. `apps/web` imports from HERE.
 */
import "./browser-buffer.js";
export {
  pushTree,
  fetchTree,
  toFullRef,
  redactUrl,
  urlHasUserinfo,
  redactRemoteError,
  base64Utf8,
  HttpRemoteSync,
  DEFAULT_FETCH_LIMITS,
} from "./git-remote-core.js";
export type {
  RemoteConfig,
  PushResult,
  RemoteSync,
  FetchLimits,
  GitHttpClient,
  GitFs,
  ScratchProvider,
} from "./git-remote-core.js";
export { createBrowserGitHttp, InboundCapError, MAX_INBOUND_RESPONSE_BYTES } from "./browser-git-http.js";
export { createMemoryGitFs, FsError, MemFsContractError } from "./browser-git-fs.js";
export type { MemoryGitFs } from "./browser-git-fs.js";
export { createBrowserRemoteSync } from "./browser-remote-sync.js";
// Export-as-git-repo core (roadmap #17.5): snapshot → tar of a bare git repo.
// Browser-safe by construction (in-memory git fs + object plumbing, no node:*).
export { exportProjectAsGitRepo } from "./project-export-git.js";
export type { GitRepoExport, GitExportOutcome, GitExportOptions } from "./project-export-git.js";
// The commit-message format (roadmap #11/#12). Browser-safe by construction (pure
// string work, no `node:*`) — the GitHub push path stamps the same trailers the
// local `GitVersionStore` writes, instead of inventing a second format.
export {
  encodeMessage,
  decodeMessage,
  sanitizeTrailer,
  coauthorEmail,
  CONTRIBUTOR_TRAILER,
  COAUTHOR_TRAILER,
} from "./version-message.js";
export type { VersionMessageInput } from "./version-message.js";
