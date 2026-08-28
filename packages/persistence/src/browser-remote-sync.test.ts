/**
 * ADR-0019 — the browser RemoteSync assembly drives `HttpRemoteSync` over the
 * in-memory git fs + scratch router. We can't hit a real network in the gate, so
 * we swap the http client for a fake (the constructor injects http only at the
 * factory boundary; here we mirror the factory but with a stub) to prove the
 * fs-router path runs the SAME plumbing and that a transport failure surfaces a
 * redacted error rather than hanging — the exact path the e2e exercises.
 */
import { describe, it, expect } from "vitest";
import { HttpRemoteSync, type GitHttpClient } from "./git-remote-core.js";
import { createMemoryGitFs } from "./browser-git-fs.js";

const SECRET = "ghp_TOPSECRET1234567890";
const tree = (...files: [string, string][]) => files.map(([path, text]) => ({ path, text }));

/** Rebuild the browser router locally (mirrors browser-remote-sync.ts) with a stub http. */
function browserSyncWith(http: GitHttpClient): HttpRemoteSync {
  const byRoot = new Map<string, ReturnType<typeof createMemoryGitFs>>();
  let seq = 0;
  const routed = new Set([
    "readFile", "writeFile", "unlink", "readdir", "mkdir", "rmdir", "rm", "stat", "lstat", "symlink", "readlink",
  ]);
  const fs = {
    promises: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (typeof prop === "symbol" || !routed.has(String(prop))) return undefined;
        return async (path: string, ...rest: unknown[]) => {
          let target: ReturnType<typeof createMemoryGitFs> | undefined;
          for (const [root, f] of byRoot) if (path === root || path.startsWith(root + "/")) target = f;
          if (!target) throw new Error("unknown scratch root");
          const fn = (target.promises as unknown as Record<string, unknown>)[String(prop)];
          return (fn as (...a: unknown[]) => unknown).call(target.promises, path, ...rest);
        };
      },
    }),
  } as never;
  const scratch = {
    make: async () => {
      const root = `/galley-git-${seq++}`;
      byRoot.set(root, createMemoryGitFs());
      return root;
    },
    cleanup: async (p: string) => void byRoot.delete(p),
  };
  return new HttpRemoteSync(http, fs, scratch, () => 1_700_000_000);
}

describe("browser RemoteSync (in-memory fs + scratch router)", () => {
  it("push fails FAST with a redacted error when the http transport rejects (no hang)", async () => {
    // A transport that always rejects (stands in for an unreachable/`.invalid` host).
    const http: GitHttpClient = {
      request: () => Promise.reject(new Error(`net fail for https://x:${SECRET}@h using ${SECRET}`)),
    };
    const sync = browserSyncWith(http);
    const cfg = { url: "https://h/r.git", auth: { token: SECRET } };
    const err = await sync.pushTree(cfg, "refs/heads/main", tree(["a.typ", "x"])).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("the in-memory scratch runs the object plumbing (commit lands before push is attempted)", async () => {
    // Capture whether `git.push` was reached — proving init→commit ran on the
    // memory fs router (the bug-prone seam) before the transport call.
    let reached = false;
    const http: GitHttpClient = {
      request: () => {
        reached = true;
        return Promise.reject(new Error("rejected at push"));
      },
    };
    const sync = browserSyncWith(http);
    await sync
      .pushTree({ url: "https://h/r.git" }, "refs/heads/main", tree(["a.typ", "x"]))
      .catch(() => undefined);
    expect(reached).toBe(true);
  });
});
