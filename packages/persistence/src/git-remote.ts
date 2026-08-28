/**
 * Lane C / ADR-0019 — Node-side aggregate re-export of the git-remote projection.
 *
 * The implementation was split for browser support: the runtime-neutral core
 * (`git-remote-core.ts`, no `node:*`) + the Node-only adapters
 * (`git-remote-node.ts`, `node:fs` scratch + {@link LocalBareRemoteSync}). This
 * module re-exports BOTH so existing Node imports (`./git-remote.js`) keep
 * working unchanged. The browser imports the core directly (and never this file
 * or the node module) — see `browser-remote-sync.ts` / ADR-0019.
 *
 * Security/semantics are unchanged: tokens stay write-only and redacted from
 * every surfaced error; `fetchTree` stays pure; `DEFAULT_FETCH_LIMITS` unchanged.
 */
export {
  pushTree,
  fetchTree,
  toFullRef,
  redactUrl,
  urlHasUserinfo,
  redactRemoteError,
  base64Utf8,
  commitTreeOnto,
  commitTreeToRef,
  readTreeAtRef,
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
export {
  LocalBareRemoteSync,
  nodeGitFs,
  nodeScratchProvider,
  createNodeHttpRemoteSync,
} from "./git-remote-node.js";
