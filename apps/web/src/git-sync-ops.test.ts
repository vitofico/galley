import { describe, it, expect } from "vitest";
import {
  pushGitRemote,
  fetchGitRemote,
  pushGithubSnapshot,
  fetchGithubSnapshot,
  projectIdbName,
  MAX_IDENTITY_CHARS,
} from "./git-sync-ops.js";
import type { RemoteConfig, RemoteSync } from "@galley/persistence/browser";
import type { VersionedFile } from "@galley/shared";
import type { GithubFetch } from "./github-api.js";

/**
 * Host-side git-sync orchestration (#17.2 / ADR-0019). Driven with a FAKE
 * `RemoteSync` (no network), this pins:
 *  - push materialize-failure and transport-failure both surface a redacted error;
 *  - push success returns the projection OID;
 *  - fetch returns a CANDIDATE (never auto-applies) and `hasCandidate:false` for an
 *    absent ref;
 *  - the SECURITY invariant: a token leaked by the transport is scrubbed before it
 *    reaches the outcome (the public wrappers redact).
 */

const SECRET = "ghp_TOPSECRET1234567890";
const tree = (...files: [string, string][]): VersionedFile[] =>
  files.map(([path, text]) => ({ path, text }));

function fakeSync(over: Partial<RemoteSync> = {}): RemoteSync {
  return {
    pushTree: async () => ({ oid: "a".repeat(40), ref: "refs/heads/main" }),
    fetchTree: async () => null,
    ...over,
  };
}

describe("pushGitRemote", () => {
  const cfg: RemoteConfig = { url: "https://h/r.git", ref: "main", auth: { token: SECRET } };

  it("materializes, pushes, and returns the projection OID on success", async () => {
    const out = await pushGitRemote(fakeSync(), cfg, () => ({ ok: true, files: tree(["a.typ", "x"]) }));
    expect(out).toEqual({ ok: true, oid: "a".repeat(40) });
  });

  it("fails closed (no push) when materialize fails", async () => {
    let pushed = false;
    const sync = fakeSync({
      pushTree: async () => {
        pushed = true;
        return { oid: "z".repeat(40), ref: "refs/heads/main" };
      },
    });
    const out = await pushGitRemote(sync, cfg, () => ({ ok: false, reason: "unsafe-path" }));
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unsafe-path");
    expect(pushed).toBe(false);
  });

  it("redacts a token the transport leaks into its error", async () => {
    const sync = fakeSync({
      pushTree: async () => {
        throw new Error(`push failed for https://x:${SECRET}@h/r using token ${SECRET}`);
      },
    });
    const out = await pushGitRemote(sync, cfg, () => ({ ok: true, files: tree(["a.typ", "x"]) }));
    expect(out.ok).toBe(false);
    expect(out.error).not.toContain(SECRET);
    expect(out.error).toContain("[REDACTED]");
  });
});

describe("fetchGitRemote", () => {
  const cfg: RemoteConfig = { url: "https://h/r.git", ref: "main", auth: { token: SECRET } };

  it("returns the remote tree as a CANDIDATE (never auto-applies)", async () => {
    const remote = tree(["main.typ", "hello"], ["sub/b.typ", "bee"]);
    const out = await fetchGitRemote(fakeSync({ fetchTree: async () => remote }), cfg);
    expect(out).toEqual({ ok: true, hasCandidate: true, candidate: remote });
  });

  it("reports hasCandidate:false for an absent remote ref", async () => {
    const out = await fetchGitRemote(fakeSync({ fetchTree: async () => null }), cfg);
    expect(out).toEqual({ ok: true, hasCandidate: false });
  });

  it("redacts a token the transport leaks into a fetch error", async () => {
    const sync = fakeSync({
      fetchTree: async () => {
        throw new Error(`fetch failed: token=${SECRET}`);
      },
    });
    const out = await fetchGitRemote(sync, cfg);
    expect(out.ok).toBe(false);
    expect(out.error).not.toContain(SECRET);
  });
});

describe("pushGithubSnapshot (Connect GitHub v0)", () => {
  // Device-scoped credential…
  const CONN = { token: SECRET, login: "octocat" };
  // …and the per-project target, passed separately (the 2026-06-15 split).
  const REPO = { owner: "octocat", name: "paper", branch: "main" };
  const okTree = async () => ({ ok: true as const, files: tree(["main.typ", "= Hi"]) });

  /** A fetch fake walking the whole happy Git-Data sequence. */
  function happyFetch(): {
    fetchImpl: GithubFetch;
    paths: string[];
    /** The parsed `POST /git/commits` body — what actually lands on the remote. */
    commitBody: () => Record<string, unknown>;
  } {
    const paths: string[] = [];
    let commit: Record<string, unknown> = {};
    let blob = 0;
    const fetchImpl: GithubFetch = async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(`${init.method} ${path}`);
      if (path.endsWith("/git/commits") && typeof init.body === "string") {
        commit = JSON.parse(init.body) as Record<string, unknown>;
      }
      const body = (b: unknown) => ({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(b)),
      });
      if (init.method === "GET" && path.endsWith("/git/ref/heads/main"))
        return body({ object: { sha: "base" } });
      if (path.endsWith("/git/blobs")) return body({ sha: `b${blob++}` });
      if (path.endsWith("/git/trees")) return body({ sha: "t" });
      if (path.endsWith("/git/commits")) return body({ sha: "c".repeat(40) });
      if (path.includes("/git/refs/heads/")) return body({ object: { sha: "c".repeat(40) } });
      throw new Error(`unrouted ${init.method} ${path}`);
    };
    return { fetchImpl, paths, commitBody: () => commit };
  }

  it("gates honestly: no connection / no repo target — and never materializes", async () => {
    let materialized = false;
    const spyTree = async () => {
      materialized = true;
      return { ok: true as const, files: tree(["main.typ", "x"]) };
    };
    const none = await pushGithubSnapshot(spyTree, { connection: null, repo: REPO });
    expect(none.ok).toBe(false);
    expect(none.error).toContain("Connect GitHub");
    // Connected, but no per-project target chosen yet.
    const noRepo = await pushGithubSnapshot(spyTree, { connection: CONN, repo: null });
    expect(noRepo.ok).toBe(false);
    expect(noRepo.error).toContain("repository");
    expect(materialized).toBe(false);
  });

  it("pushes the materialized tree through the REST sequence and returns the commit", async () => {
    const { fetchImpl, paths } = happyFetch();
    const out = await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
    });
    expect(out).toEqual({ ok: true, oid: "c".repeat(40) });
    expect(paths[0]).toBe("GET /repos/octocat/paper/git/ref/heads/main");
    expect(paths.at(-1)).toBe("PATCH /repos/octocat/paper/git/refs/heads/main");
  });

  // --- Attribution on the pushed commit (#12) ---------------------------------

  it("with NO author/contributors the commit is byte-identical to the pre-#12 push", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    const out = await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
    });
    expect(out.ok).toBe(true);
    // The exact shipped body: the bare subject (encodeMessage appends NOTHING
    // without contributors) and no identity keys at all.
    expect(commitBody()).toEqual({
      message: "Galley snapshot — 2026-06-12T00:00:00.000Z",
      tree: "t",
      parents: ["base"],
    });
  });

  it("NEVER sends an author/committer — even when one is supplied (#12)", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: ["Alice", "Bob Smith"],
    });
    const body = commitBody();
    // The identity NEVER reaches the wire: the remote author stays GitHub's
    // authenticated default (the PAT owner) — a real, LINKED account. The commit
    // body is {message, tree, parents} unconditionally, author supplied or not.
    expect(body).not.toHaveProperty("author");
    expect(body).not.toHaveProperty("committer");
    expect(Object.keys(body).sort()).toEqual(["message", "parents", "tree"]);
    // Attribution rides the MESSAGE — same subject, same trailer format the local
    // git path writes. Alice is the pusher, so she is NOT co-authored to her own
    // commit; Bob (a co-contributor) IS.
    expect(body.message).toBe(
      "Galley snapshot — 2026-06-12T00:00:00.000Z\n\n" +
        "Galley-Contributor: Alice\n" +
        "Galley-Contributor: Bob Smith\n" +
        "Co-authored-by: Bob Smith <bob-smith@users.galley.local>",
    );
  });

  it("does not co-author the pusher to their own commit, but does co-author others", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: "Alice", email: "alice@users.galley.local" },
      contributors: ["Alice", "Bob Smith", "Carol Q."],
    });
    const co = (commitBody().message as string)
      .split("\n")
      .filter((l) => l.startsWith("Co-authored-by: "));
    // Alice already authors the commit (GitHub attributes it to her PAT), so a
    // Co-authored-by naming her would be redundant self-attribution.
    expect(co).toEqual([
      "Co-authored-by: Bob Smith <bob-smith@users.galley.local>",
      "Co-authored-by: Carol Q. <carol-q@users.galley.local>",
    ]);
    expect(co.join("\n")).not.toContain("Alice");
  });

  it("a hostile contributor display name cannot FORGE a trailer on the pushed commit", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: "Alice", email: "alice@users.galley.local" },
      // A peer who named themselves a trailer payload (display names are CRDT
      // data — any collaborator can set one).
      contributors: ["Eve\nCo-authored-by: Attacker <attacker@evil.example>"],
    });
    const message = commitBody().message as string;
    const lines = message.split("\n");
    // No forged trailer stands alone at a line start…
    expect(lines).not.toContain("Co-authored-by: Attacker <attacker@evil.example>");
    // …and the only co-author address is the synthesized noreply one.
    const co = lines.filter((l) => l.startsWith("Co-authored-by: "));
    expect(co).toHaveLength(1);
    expect(co[0]!.endsWith("@users.galley.local>")).toBe(true);
    expect(message).not.toMatch(/^Co-authored-by: Attacker/m);
  });

  it("a hostile author display name reaches NOTHING — not the wire, not the message", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: "Eve\r\nCo-authored-by: Attacker <attacker@evil.example>", email: "eve\n@x.local" },
      contributors: ["Bob"],
    });
    // The author is read ONLY to skip self-co-authoring; it is never emitted into
    // the message and never sent as a field. So a hostile pusher name has no
    // channel to the commit at all — assert on the WHOLE serialized body.
    const serialized = JSON.stringify(commitBody());
    expect(serialized).not.toContain("Attacker");
    expect(serialized).not.toContain("evil.example");
    expect(serialized).not.toContain("Eve");
  });

  it("bounds an oversized contributor label instead of shipping it to the remote", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: "A".repeat(5_000), email: "a@users.galley.local" },
      contributors: ["B".repeat(5_000)],
    });
    for (const line of (commitBody().message as string).split("\n").slice(1)) {
      // Trailer key + a bounded value — never an unbounded peer-supplied blob.
      expect(line.length).toBeLessThanOrEqual(MAX_IDENTITY_CHARS * 2 + 80);
    }
  });

  it("bounds the SAME way on both sides, so a huge name still self-suppresses", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    const huge = "A".repeat(5_000);
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      author: { name: huge, email: "a@users.galley.local" },
      contributors: [huge],
    });
    // Bounding only the contributor would make it stop matching its (unbounded)
    // author and re-introduce the redundant self-co-author line.
    expect(commitBody().message as string).not.toContain("Co-authored-by:");
  });

  it("bounds an astral-plane contributor label without splitting a surrogate pair", async () => {
    const { fetchImpl, commitBody } = happyFetch();
    await pushGithubSnapshot(okTree, {
      connection: CONN,
      repo: REPO,
      fetchImpl,
      now: () => new Date("2026-06-12T00:00:00Z"),
      // Each emoji is a surrogate PAIR, and the leading "A" pushes the pairs to
      // ODD offsets — so a code-unit `slice(0, 200)` cuts the 100th emoji in half
      // and strands a lone high surrogate. (Without the "A" the cut lands on a
      // pair boundary and the naive bug hides.)
      contributors: [`A${"🎉".repeat(500)}`],
    });
    const line = (commitBody().message as string)
      .split("\n")
      .find((l) => l.startsWith("Galley-Contributor: "))!;
    const name = line.slice("Galley-Contributor: ".length);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high
    expect(name).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone low
    expect([...name]).toHaveLength(MAX_IDENTITY_CHARS);
  });

  it("surfaces a materialize failure without any network call", async () => {
    let called = 0;
    const fetchImpl: GithubFetch = async () => {
      called++;
      throw new Error("must not be called");
    };
    const out = await pushGithubSnapshot(
      async () => ({ ok: false as const, reason: "duplicate_path (a.typ)" }),
      { connection: CONN, repo: REPO, fetchImpl },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("duplicate_path");
    expect(called).toBe(0);
  });

  it("returns a typed, token-free error when GitHub refuses", async () => {
    const fetchImpl: GithubFetch = async () => ({
      status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ message: `bad creds ${SECRET}` })),
    });
    const out = await pushGithubSnapshot(okTree, { connection: CONN, repo: REPO, fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("401");
    expect(out.error).not.toContain(SECRET);
  });

  it("scrubs the literal token even from a non-GithubApiError seam failure", async () => {
    const fetchImpl: GithubFetch = async () => {
      // Simulate a hostile/buggy injected seam whose error embeds the token in
      // a way that bypasses the REST client's own scrubbing path.
      return Promise.reject({ message: `weird ${SECRET}`, toString: () => `weird ${SECRET}` });
    };
    const out = await pushGithubSnapshot(okTree, { connection: CONN, repo: REPO, fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.error).not.toContain(SECRET);
  });

  it("projectIdbName matches createProjectSession's per-project db scheme", () => {
    expect(projectIdbName("default")).toBe("galley-local-project-v1-default");
  });

  it("pushes to the EXACT repo target passed in — storage is never re-consulted (TOCTOU)", async () => {
    // The panel loads the connection + per-project target ONCE on click and
    // pushes with those same objects, so what the status names is what was
    // pushed. Pin that an explicitly passed target is used verbatim: every
    // repo-scoped call must target ITS owner/name/branch. (In this Node env the
    // storage loaders would return null — so any re-consult would surface as a
    // gate error.)
    const paths: string[] = [];
    let blob = 0;
    const fetchImpl: GithubFetch = async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(`${init.method} ${path}`);
      const body = (b: unknown) => ({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(b)),
      });
      if (path.endsWith("/git/ref/heads/release")) return body({ object: { sha: "base" } });
      if (path.endsWith("/git/blobs")) return body({ sha: `b${blob++}` });
      if (path.endsWith("/git/trees")) return body({ sha: "t" });
      if (path.endsWith("/git/commits")) return body({ sha: "d".repeat(40) });
      if (path.includes("/git/refs/heads/")) return body({ object: { sha: "d".repeat(40) } });
      throw new Error(`unrouted ${init.method} ${path}`);
    };
    const out = await pushGithubSnapshot(okTree, {
      connection: { token: SECRET, login: "octocat" },
      repo: { owner: "other-owner", name: "mirror", branch: "release" },
      fetchImpl,
    });
    expect(out).toEqual({ ok: true, oid: "d".repeat(40) });
    for (const p of paths) {
      expect(p).toMatch(/^[A-Z]+ \/repos\/other-owner\/mirror\//);
    }
    expect(paths[0]).toBe("GET /repos/other-owner/mirror/git/ref/heads/release");
    expect(paths.at(-1)).toBe("PATCH /repos/other-owner/mirror/git/refs/heads/release");
  });
});

describe("fetchGithubSnapshot (GitHub Fetch — Accept-gated candidate)", () => {
  const CONN = { token: SECRET, login: "octocat" };
  const REPO = { owner: "octocat", name: "paper", branch: "main" };

  /** A fetch fake walking the whole ref → commit → tree → blob read sequence. */
  function happyFetch(files: Record<string, string>): { fetchImpl: GithubFetch; paths: string[] } {
    const paths: string[] = [];
    const names = Object.keys(files);
    const body = (b: unknown) => ({
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(b)),
    });
    const fetchImpl: GithubFetch = async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(`${init.method} ${path}`);
      if (path.endsWith("/git/ref/heads/main")) return body({ object: { sha: "commit" } });
      if (path.includes("/git/commits/")) return body({ tree: { sha: "tree" } });
      if (path.includes("/git/trees/"))
        return body({
          truncated: false,
          tree: names.map((p) => ({
            path: p,
            type: "blob",
            sha: `blob-${p}`,
            size: Buffer.byteLength(files[p]!, "utf-8"),
          })),
        });
      const blobMatch = path.match(/\/git\/blobs\/blob-(.+)$/);
      if (blobMatch) {
        const name = decodeURIComponent(blobMatch[1]!);
        const b64 = Buffer.from(files[name]!, "utf-8").toString("base64");
        return body({ content: b64, encoding: "base64" });
      }
      throw new Error(`unrouted ${init.method} ${path}`);
    };
    return { fetchImpl, paths };
  }

  it("returns the remote tree as a CANDIDATE (never auto-applies)", async () => {
    const { fetchImpl } = happyFetch({ "main.typ": "= Hi", "a.bib": "@book{x}" });
    const out = await fetchGithubSnapshot({ connection: CONN, repo: REPO, fetchImpl });
    expect(out).toEqual({
      ok: true,
      hasCandidate: true,
      candidate: tree(["main.typ", "= Hi"], ["a.bib", "@book{x}"]),
    });
  });

  it("reports hasCandidate:false when the remote ref is empty/absent", async () => {
    const fetchImpl: GithubFetch = async () => ({
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ message: "Not Found" })),
    });
    const out = await fetchGithubSnapshot({ connection: CONN, repo: REPO, fetchImpl });
    expect(out).toEqual({ ok: true, hasCandidate: false });
  });

  it("gates honestly: no connection / no repo target — and never calls the network", async () => {
    let called = 0;
    const fetchImpl: GithubFetch = async () => {
      called++;
      throw new Error("must not be called");
    };
    const none = await fetchGithubSnapshot({ connection: null, repo: REPO, fetchImpl });
    expect(none.ok).toBe(false);
    expect(none.error).toContain("Connect GitHub");
    const noRepo = await fetchGithubSnapshot({ connection: CONN, repo: null, fetchImpl });
    expect(noRepo.ok).toBe(false);
    expect(noRepo.error).toContain("repository");
    expect(called).toBe(0);
  });

  it("returns a typed, token-free error when GitHub refuses mid-read", async () => {
    const fetchImpl: GithubFetch = async () => ({
      status: 401,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ message: `bad creds ${SECRET}` })),
    });
    const out = await fetchGithubSnapshot({ connection: CONN, repo: REPO, fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("401");
    expect(out.error).not.toContain(SECRET);
  });

  it("scrubs the literal token even from a non-GithubApiError seam failure", async () => {
    const fetchImpl: GithubFetch = async () =>
      Promise.reject({ message: `weird ${SECRET}`, toString: () => `weird ${SECRET}` });
    const out = await fetchGithubSnapshot({ connection: CONN, repo: REPO, fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.error).not.toContain(SECRET);
  });
});
