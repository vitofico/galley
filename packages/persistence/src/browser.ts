/**
 * @galley/persistence/browser — the BROWSER-SAFE entry point (ADR-0019).
 *
 * Exposes ONLY the runtime-neutral pieces: the git-remote transport core
 * (`pushTree`/`fetchTree` + redaction + caps + `HttpRemoteSync`), the browser
 * adapter (`createBrowserRemoteSync`, `createBrowserGitHttp`, `createMemoryGitFs`),
 * and the export-as-git-repo core (`exportProjectAsGitRepo`, roadmap #17.5).
 * The main barrel imports the Node-only `git-remote-node` and its filesystem
 * dependency. `apps/web` uses this entry point to keep Node modules out of Vite.
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
// The shared commit-message encoder and trailer helpers use only strings.
export {
  encodeMessage,
  decodeMessage,
  sanitizeTrailer,
  coauthorEmail,
  CONTRIBUTOR_TRAILER,
  COAUTHOR_TRAILER,
} from "./version-message.js";
export type { VersionMessageInput } from "./version-message.js";
