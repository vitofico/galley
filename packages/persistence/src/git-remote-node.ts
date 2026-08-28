/**
 * Lane C / ADR-0019 — the **Node-only** half of the git-remote projection. This
 * module is the ONLY one that touches `node:fs`/`node:os`/`node:path`; the
 * runtime-neutral plumbing lives in `git-remote-core.ts` (browser-safe). Server
 * code imports from here (via the package barrel); the browser imports the core +
 * `browser-git-fs.ts` and NEVER this file.
 *
 * It provides:
 *   - {@link LocalBareRemoteSync}: identical projection semantics against a second
 *     *local bare repo* on `node:fs`, so the logic is fully tested OFFLINE.
 *   - {@link nodeScratchProvider}: a `mkdtemp(tmpdir())`-backed scratch provider.
 *   - {@link createNodeHttpRemoteSync}: the live-network `HttpRemoteSync`
 *     pre-wired with `node:fs` + the node scratch provider (caller injects the
 *     `isomorphic-git/http/node` client).
 */
import nodeFs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VersionedFile } from "@galley/shared";
import {
  HttpRemoteSync,
  commitTreeToRef,
  readTreeAtRef,
  redactRemoteError,
  DEFAULT_FETCH_LIMITS,
  type FetchLimits,
  type GitFs,
  type GitHttpClient,
  type PushResult,
  type RemoteConfig,
  type RemoteSync,
  type ScratchProvider,
} from "./git-remote-core.js";

/** `node:fs` typed as the structural {@link GitFs} the plumbing expects. */
export const nodeGitFs: GitFs = nodeFs as unknown as GitFs;

/** A scratch provider that allocates temp gitdirs under `os.tmpdir()` (deleted on cleanup). */
export const nodeScratchProvider: ScratchProvider = {
  make: () => mkdtemp(join(tmpdir(), "galley-git-remote-")),
  cleanup: (path) => rm(path, { recursive: true, force: true }),
};

/**
 * Build the live-network {@link HttpRemoteSync} on Node: `node:fs` + the node
 * scratch provider, with the caller's injected `isomorphic-git/http/node` client.
 */
export function createNodeHttpRemoteSync(
  http: GitHttpClient,
  nowSec?: () => number,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
): HttpRemoteSync {
  return new HttpRemoteSync(
    http,
    nodeGitFs,
    nodeScratchProvider,
    nowSec ?? (() => Math.floor(Date.now() / 1000)),
    limits,
  );
}

/**
 * Drives the projection directly against a *local bare repo* on `node:fs` (the
 * `RemoteConfig.url` is the bare-repo path). No HTTP, no network — this is what
 * the CI gate exercises to prove push/fetch SEMANTICS. The on-disk smart-HTTP
 * edge ({@link HttpRemoteSync}) reuses the exact same object plumbing.
 */
export class LocalBareRemoteSync implements RemoteSync {
  constructor(
    private readonly nowSec: () => number = () => Math.floor(Date.now() / 1000),
    private readonly limits: FetchLimits = DEFAULT_FETCH_LIMITS,
  ) {}

  // Self-redact (defense in depth): even a caller that bypasses the public
  // `pushTree`/`fetchTree` wrappers can't leak a token through this adapter.
  async pushTree(config: RemoteConfig, fullRef: string, tree: VersionedFile[]): Promise<PushResult> {
    try {
      return await commitTreeToRef(nodeGitFs, config.url, fullRef, tree, this.nowSec());
    } catch (err) {
      throw redactRemoteError(err, config);
    }
  }

  async fetchTree(config: RemoteConfig, fullRef: string): Promise<VersionedFile[] | null> {
    try {
      return await readTreeAtRef(nodeGitFs, config.url, fullRef, this.limits);
    } catch (err) {
      throw redactRemoteError(err, config);
    }
  }
}
