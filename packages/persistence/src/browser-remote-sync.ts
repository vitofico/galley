/**
 * Lane S / ADR-0019 — the BROWSER remote-sync adapter. Assembles the
 * runtime-neutral {@link HttpRemoteSync} with (a) the `fetch`-backed
 * `isomorphic-git/http/web` client (via {@link createBrowserGitHttp}) and (b) a
 * hand-rolled in-memory git fs ({@link createMemoryGitFs}), so push/fetch run
 * entirely in the browser with NO `node:fs` and NO new external dependency.
 *
 * This is the module `apps/web` imports (through the `@galley/persistence/browser`
 * subpath). It NEVER imports `git-remote-node.ts` or `node:*`, so the Vite bundle
 * stays Node-free (the gate's web build proves this).
 *
 * Isolation: each op gets a FRESH in-memory fs with its own scratch root, dropped
 * (GC'd) after the op — no cross-remote contamination, mirroring the Node scratch
 * provider's `mkdtemp`/`rm` discipline. Security is unchanged from the core: the
 * token flows only through `HttpRemoteSync.onAuth`, every error self-redacts, and
 * `DEFAULT_FETCH_LIMITS` bound a fetched candidate.
 */
import {
  HttpRemoteSync,
  DEFAULT_FETCH_LIMITS,
  type FetchLimits,
  type GitFs,
  type GitHttpClient,
  type ScratchProvider,
} from "./git-remote-core.js";
import { createBrowserGitHttp } from "./browser-git-http.js";
import { createMemoryGitFs } from "./browser-git-fs.js";

/** The fs method names the router forwards (the in-memory adapter's modelled subset). */
const ROUTED_METHODS = new Set([
  "readFile",
  "writeFile",
  "unlink",
  "readdir",
  "mkdir",
  "rmdir",
  "rm",
  "stat",
  "lstat",
  "symlink",
  "readlink",
]);

/**
 * A browser scratch provider: each `make()` mints a fresh, isolated in-memory git
 * fs and a unique gitdir path inside it; `cleanup()` drops the namespace so the
 * scratch repo is ephemeral. Because each op gets its OWN fs (not a shared one),
 * two concurrent/sequential ops to different remotes cannot bleed history.
 *
 * `HttpRemoteSync` holds ONE injected `fs`, so the per-op fresh fs is exposed
 * through {@link MemoryFsRouter}: a thin `GitFs` facade that routes every call to
 * the fs registered for the current op's gitdir. (Each op uses a unique root path,
 * so there is never ambiguity.)
 */
class MemoryFsRouter implements ScratchProvider {
  // gitdir root → its dedicated in-memory fs.
  private readonly byRoot = new Map<string, GitFs>();
  private seq = 0;

  /**
   * The `GitFs` handed to `HttpRemoteSync`; routes each call to the in-memory fs
   * owning the path's scratch root. Only the real method NAMES are intercepted —
   * every other property read (isomorphic-git's `_original_unwrapped_fs`
   * double-wrap probe, `then`, symbol probes) reads as `undefined`, exactly as on
   * a plain fs, so the wrapper detection is not corrupted.
   */
  readonly fs: GitFs = {
    promises: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (typeof prop === "symbol") return undefined;
        const method = String(prop);
        if (!ROUTED_METHODS.has(method)) return undefined;
        // MUST be async so a routing failure surfaces as a REJECTED promise, not a
        // synchronous throw — isomorphic-git's `isPromiseFs` probe calls
        // `readFile()` (no args) and treats a sync throw as "not a promise fs",
        // which would silently switch it to callback-mode and hang.
        return async (path: string, ...rest: unknown[]) => {
          const target = this.resolve(path);
          const fn = (target.promises as unknown as Record<string, unknown>)[method];
          return (fn as (...a: unknown[]) => unknown).call(target.promises, path, ...rest);
        };
      },
    }) as unknown as GitFs["promises"],
  };

  private resolve(path: string): GitFs {
    for (const [root, fs] of this.byRoot) {
      if (path === root || path.startsWith(root + "/")) return fs;
    }
    throw new Error("browser git fs: operation on an unknown scratch root");
  }

  async make(): Promise<string> {
    const root = `/galley-git-${Date.now().toString(36)}-${this.seq++}`;
    this.byRoot.set(root, createMemoryGitFs());
    return root;
  }

  async cleanup(path: string): Promise<void> {
    this.byRoot.delete(path); // drop the namespace; GC reclaims the in-memory tree
  }
}

/**
 * Build a browser {@link HttpRemoteSync}: `isomorphic-git/http/web` + an in-memory
 * git fs, with per-op isolated scratch. Drop-in for the Node `HttpRemoteSync` —
 * same `pushTree`/`fetchTree` semantics, same redaction, same fetch caps.
 *
 * @param nowSec  optional injectable seconds clock (deterministic tests).
 * @param limits  optional fetch-candidate caps (defaults to `DEFAULT_FETCH_LIMITS`).
 */
export function createBrowserRemoteSync(
  nowSec?: () => number,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
): HttpRemoteSync {
  const router = new MemoryFsRouter();
  const http: GitHttpClient = createBrowserGitHttp();
  return new HttpRemoteSync(
    http,
    router.fs,
    router,
    nowSec ?? (() => Math.floor(Date.now() / 1000)),
    limits,
  );
}
