/**
 * Lane C — E6 git-remote projection (ADR-0018): push/pull behind a clean,
 * offline-testable seam, preserving CRDT-is-truth.
 *
 * isomorphic-git's `push`/`fetch` speak smart-HTTP and need an injected
 * `HttpClient` — there is no native local/`file://` remote transport. So the
 * seam here is the *semantic* operation (`pushTree`/`fetchTree`), not the HTTP
 * client. The real HTTP impl (`HttpRemoteSync`) is wired but NOT exercised in
 * the gate (no network in CI); the projection SEMANTICS are proven offline by
 * `LocalBareRemoteSync`, which performs the identical object-plumbing against a
 * second *local bare repo* on `node:fs`.
 *
 * Security: a `RemoteConfig.auth.token` is a write-only input. These tests pin
 * that it never leaks into a return value or a thrown error message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import git from "isomorphic-git";
import {
  LocalBareRemoteSync,
  HttpRemoteSync,
  nodeGitFs,
  nodeScratchProvider,
  pushTree,
  fetchTree,
  redactRemoteError,
  redactUrl,
  urlHasUserinfo,
  type GitHttpClient,
  type RemoteConfig,
  type RemoteSync,
  type FetchLimits,
} from "./git-remote.js";

let root: string;
const REDACTED_MARK = "[REDACTED]";
const tree = (...files: [string, string][]) => files.map(([path, text]) => ({ path, text }));

/** A second, on-disk bare repo standing in for "the remote". */
async function makeBareRemote(name = "remote.git"): Promise<string> {
  const dir = join(root, name);
  await git.init({ fs, dir, bare: true, defaultBranch: "main" });
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-git-remote-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pushTree (projection → remote)", () => {
  it("commits a materialized tree onto the remote ref; the remote then has those files", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: remote, ref: "main" };

    const res = await pushTree(sync, cfg, tree(
      ["main.typ", "= Title"],
      ["chapters/one.typ", "Chapter one"],
      [".galley/project.json", "{}"],
    ));

    expect(res.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(res.ref).toBe("refs/heads/main");

    // The bare remote now holds exactly those files at the pushed commit.
    const oid = await git.resolveRef({ fs, gitdir: remote, ref: "refs/heads/main" });
    expect(oid).toBe(res.oid);
    const paths = await git.listFiles({ fs, gitdir: remote, ref: oid });
    expect(paths.sort()).toEqual([".galley/project.json", "chapters/one.typ", "main.typ"]);
    const { blob } = await git.readBlob({ fs, gitdir: remote, oid, filepath: "main.typ" });
    expect(new TextDecoder().decode(blob)).toBe("= Title");
  });

  it("defaults the ref to main when RemoteConfig.ref is omitted", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const res = await pushTree(sync, { url: remote }, tree(["a.typ", "x"]));
    expect(res.ref).toBe("refs/heads/main");
    const oid = await git.resolveRef({ fs, gitdir: remote, ref: "refs/heads/main" });
    expect(oid).toBe(res.oid);
  });

  it("a second push parents onto the prior commit (linear projection history)", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: remote, ref: "main" };

    const v1 = await pushTree(sync, cfg, tree(["a.typ", "one"]));
    const v2 = await pushTree(sync, cfg, tree(["a.typ", "two"]));
    expect(v2.oid).not.toBe(v1.oid);

    const log = await git.log({ fs, gitdir: remote, ref: "refs/heads/main" });
    expect(log.map((e) => e.oid)).toEqual([v2.oid, v1.oid]); // newest first, parented
    const { blob } = await git.readBlob({ fs, gitdir: remote, oid: v2.oid, filepath: "a.typ" });
    expect(new TextDecoder().decode(blob)).toBe("two");
  });
});

describe("fetchTree (remote → import candidate)", () => {
  it("returns the remote's materialized tree (sorted), as a candidate only", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: remote, ref: "main" };

    await pushTree(sync, cfg, tree(["main.typ", "hello"], ["sub/b.typ", "bee"]));

    const candidate = await fetchTree(sync, cfg);
    expect(candidate).toEqual(tree(["main.typ", "hello"], ["sub/b.typ", "bee"]));
  });

  it("returns null for a remote with no such ref (nothing to import)", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const candidate = await fetchTree(sync, { url: remote, ref: "main" });
    expect(candidate).toBeNull();
  });

  it("does NOT mutate any local store or CRDT — it only reads the remote", async () => {
    // Proof by construction: fetchTree's only inputs are the sync seam + config;
    // it has no handle to a VersionStore/CrdtStore/CollabProject. We also assert
    // it leaves the remote untouched (read-only).
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: remote, ref: "main" };
    const pushed = await pushTree(sync, cfg, tree(["a.typ", "x"]));

    await fetchTree(sync, cfg);
    await fetchTree(sync, cfg);

    const oidAfter = await git.resolveRef({ fs, gitdir: remote, ref: "refs/heads/main" });
    expect(oidAfter).toBe(pushed.oid); // remote ref unchanged by fetch
  });
});

describe("token redaction (write-only secret never leaks)", () => {
  const SECRET = "ghp_TOPSECRET1234567890";

  it("redactUrl strips userinfo / embedded credentials", () => {
    expect(redactUrl(`https://x-access-token:${SECRET}@github.com/o/r.git`)).toBe(
      "https://github.com/o/r.git",
    );
    expect(redactUrl(`https://${SECRET}@github.com/o/r.git`)).toBe("https://github.com/o/r.git");
    expect(redactUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(redactUrl("not a url")).toBe("not a url");
  });

  it("redactRemoteError scrubs a token that leaked into a thrown message", () => {
    const err = new Error(`fatal: auth failed using token ${SECRET} for https://h/r`);
    const redacted = redactRemoteError(err, { url: "https://h/r", auth: { token: SECRET } });
    expect(redacted.message).not.toContain(SECRET);
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("pushTree never surfaces the token in its result", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: remote, ref: "main", auth: { token: SECRET } };
    const res = await pushTree(sync, cfg, tree(["a.typ", "x"]));
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("pushTree/fetchTree redact the token from any error the transport throws", async () => {
    // A transport whose failure message leaks the token AND embeds it in URL
    // userinfo — both must be scrubbed before the error reaches the caller.
    const leaky: RemoteSync = {
      pushTree: () => {
        throw new Error(`push failed for https://x:${SECRET}@h/r using token ${SECRET}`);
      },
      fetchTree: () => {
        throw new Error(`fetch failed: token=${SECRET}`);
      },
    };
    const cfg: RemoteConfig = { url: `https://h/r`, ref: "main", auth: { token: SECRET } };

    const pushErr = await pushTree(leaky, cfg, tree(["a.typ", "x"])).catch((e: Error) => e);
    expect(pushErr).toBeInstanceOf(Error);
    expect((pushErr as Error).message).not.toContain(SECRET);
    expect((pushErr as Error).message).toContain(REDACTED_MARK);

    const fetchErr = await fetchTree(leaky, cfg).catch((e: Error) => e);
    expect((fetchErr as Error).message).not.toContain(SECRET);
  });

  it("scrubs the URL-encoded and HTTP-Basic-base64 forms of the token", () => {
    const cfg: RemoteConfig = { url: "https://h/r", auth: { token: SECRET } };
    const encoded = encodeURIComponent(SECRET);
    const basic = Buffer.from(`${SECRET}:x-oauth-basic`, "utf8").toString("base64");
    const leak = `req failed: url-enc=${encoded} header="Authorization: Basic ${basic}"`;
    const redacted = redactRemoteError(new Error(leak), cfg);
    expect(redacted.message).not.toContain(encoded);
    expect(redacted.message).not.toContain(basic);
    expect(redacted.message).toContain(REDACTED_MARK);
  });

  it("the adapter SELF-redacts (bypassing the public wrapper still can't leak)", async () => {
    // Call the LocalBareRemoteSync method directly (skipping pushTree/fetchTree).
    const sync = new LocalBareRemoteSync();
    const cfg: RemoteConfig = { url: "/dev/null/not-a-repo", auth: { token: SECRET } };
    const err = await sync
      .pushTree(cfg, "refs/heads/main", tree(["a.typ", "x"]))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe("scratch isolation (no cross-remote contamination)", () => {
  it("two pushes to two DIFFERENT remotes through one sync don't bleed history", async () => {
    const sync = new LocalBareRemoteSync(); // one instance, reused
    const remoteA = await makeBareRemote("a.git");
    const remoteB = await makeBareRemote("b.git");

    const a = await pushTree(sync, { url: remoteA, ref: "main" }, tree(["only-a.typ", "AAA"]));
    const b = await pushTree(sync, { url: remoteB, ref: "main" }, tree(["only-b.typ", "BBB"]));

    // Each remote holds ONLY its own file at its own commit — no leakage.
    expect(a.oid).not.toBe(b.oid);
    expect((await git.listFiles({ fs, gitdir: remoteA, ref: a.oid })).sort()).toEqual(["only-a.typ"]);
    expect((await git.listFiles({ fs, gitdir: remoteB, ref: b.oid })).sort()).toEqual(["only-b.typ"]);

    // And the projection history on each is a single root commit (B didn't parent onto A).
    expect((await git.log({ fs, gitdir: remoteA, ref: "refs/heads/main" })).length).toBe(1);
    expect((await git.log({ fs, gitdir: remoteB, ref: "refs/heads/main" })).length).toBe(1);
  });
});

describe("fetch import-candidate caps (DoS guard)", () => {
  const tiny: FetchLimits = { maxFiles: 2, maxFileBytes: 16, maxTotalBytes: 32 };

  it("fails closed when the remote exceeds the file-count cap", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync(undefined, tiny);
    await pushTree(sync, { url: remote, ref: "main" }, tree(
      ["a.typ", "x"], ["b.typ", "y"], ["c.typ", "z"], // 3 > maxFiles=2
    ));
    await expect(fetchTree(sync, { url: remote, ref: "main" })).rejects.toThrow(/file-count cap/);
  });

  it("fails closed when a single file exceeds the per-file byte cap", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync(undefined, tiny);
    await pushTree(sync, { url: remote, ref: "main" }, tree(["big.typ", "x".repeat(64)]));
    await expect(fetchTree(sync, { url: remote, ref: "main" })).rejects.toThrow(/per-file byte cap/);
  });

  it("fails closed when the total bytes exceed the total cap", async () => {
    // Two 12-byte files each pass the per-file cap (16) but together (24) exceed
    // a tighter total cap (20).
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync(undefined, { maxFiles: 8, maxFileBytes: 16, maxTotalBytes: 20 });
    await pushTree(sync, { url: remote, ref: "main" }, tree(
      ["a.typ", "x".repeat(12)], ["b.typ", "y".repeat(12)], // 12 ok each, 24 > total=20
    ));
    await expect(fetchTree(sync, { url: remote, ref: "main" })).rejects.toThrow(/total byte cap/);
  });

  it("returns the tree when within caps", async () => {
    const remote = await makeBareRemote();
    const sync = new LocalBareRemoteSync(undefined, tiny);
    await pushTree(sync, { url: remote, ref: "main" }, tree(["a.typ", "ok"]));
    expect(await fetchTree(sync, { url: remote, ref: "main" })).toEqual(tree(["a.typ", "ok"]));
  });
});

describe("URL-embedded credentials (ADR-0019 HIGH-1 / HIGH-2)", () => {
  const URL_USER = "x-access-token";
  const URL_PASS = "ghp_URLEMBEDDEDPAT_456";
  const userinfoUrl = `https://${URL_USER}:${URL_PASS}@github.com/owner/repo.git`;

  it("urlHasUserinfo detects user / user:pass; clean URLs and non-URLs are false", () => {
    expect(urlHasUserinfo(userinfoUrl)).toBe(true);
    expect(urlHasUserinfo(`https://${URL_PASS}@github.com/o/r.git`)).toBe(true);
    expect(urlHasUserinfo("https://github.com/o/r.git")).toBe(false);
    expect(urlHasUserinfo("/local/path/repo.git")).toBe(false);
    expect(urlHasUserinfo("not a url")).toBe(false);
  });

  it("HttpRemoteSync.pushTree fails CLOSED on a userinfo URL — before any transport call", async () => {
    let httpTouched = false;
    const http: GitHttpClient = {
      request: () => {
        httpTouched = true;
        return Promise.reject(new Error("should never be called"));
      },
    };
    const sync = new HttpRemoteSync(http, nodeGitFs, nodeScratchProvider);
    const err = await sync
      .pushTree({ url: userinfoUrl, auth: { token: "ghp_authfield" } }, "refs/heads/main", tree(["a.typ", "x"]))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/token field, not the URL/i);
    expect((err as Error).message).not.toContain(URL_PASS);
    expect(httpTouched).toBe(false);
  });

  it("HttpRemoteSync.fetchTree fails CLOSED on a userinfo URL", async () => {
    const http: GitHttpClient = { request: () => Promise.reject(new Error("nope")) };
    const sync = new HttpRemoteSync(http, nodeGitFs, nodeScratchProvider);
    const err = await sync.fetchTree({ url: userinfoUrl }, "refs/heads/main").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/token field, not the URL/i);
    expect((err as Error).message).not.toContain(URL_PASS);
  });

  it("redactRemoteError scrubs URL userinfo in literal, percent-encoded, and Basic-base64 forms", () => {
    const cfg: RemoteConfig = { url: userinfoUrl };
    const encoded = encodeURIComponent(URL_PASS);
    const basic = Buffer.from(`${URL_USER}:${URL_PASS}`, "utf8").toString("base64");
    const leak = `boom for ${userinfoUrl} pass=${URL_PASS} enc=${encoded} auth="Basic ${basic}"`;
    const redacted = redactRemoteError(new Error(leak), cfg);
    expect(redacted.message).not.toContain(URL_PASS);
    expect(redacted.message).not.toContain(encoded);
    expect(redacted.message).not.toContain(basic);
    expect(redacted.message).toContain("[REDACTED]");
  });

  it("redactRemoteError handles a percent-ENCODED secret embedded in the URL userinfo", () => {
    // A token with URL-special chars is stored percent-encoded in the URL; the
    // DECODED form must still be scrubbed.
    const raw = "p@ss/word:1";
    const url = `https://user:${encodeURIComponent(raw)}@h/r.git`;
    const cfg: RemoteConfig = { url };
    const redacted = redactRemoteError(new Error(`leak decoded=${raw}`), cfg);
    expect(redacted.message).not.toContain(raw);
    expect(redacted.message).toContain("[REDACTED]");
  });
});
