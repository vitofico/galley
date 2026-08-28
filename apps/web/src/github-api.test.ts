/**
 * Connect GitHub v0 — the pure REST client over an injected fetch seam.
 *
 * Everything here runs offline against a recording fake fetch. The headline
 * invariants:
 *   - the Git Data API call SEQUENCE (ref probe → blobs → tree → commit → ref
 *     move/create), including the empty-repo first-commit case;
 *   - typed error mapping (bad-token / not-found / rate-limited / conflict /
 *     network / invalid / too-large);
 *   - the token NEVER appears in any surfaced error — not literally, not
 *     URL-encoded, not base64'd, not as the `Bearer …` wire form — even when
 *     the transport echoes the whole request back in its failure.
 */
import { describe, expect, it } from "vitest";
import { base64Utf8 } from "@galley/persistence/browser";
import {
  GithubApiError,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  createRepo,
  fetchSnapshot,
  pushSnapshot,
  scrubToken,
  validateToken,
  type GithubFetch,
  type GithubResponseLike,
} from "./github-api.js";

const TOKEN = "ghp_unit_SENTINEL_token_123456";

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(JSON.stringify(body)),
  } satisfies GithubResponseLike;
}

/** A scripted fake fetch: route key `"METHOD path"` → responder. Records calls. */
function fakeFetch(
  routes: Record<string, (call: RecordedCall) => GithubResponseLike | Promise<GithubResponseLike>>,
): { fetchImpl: GithubFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: GithubFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const call: RecordedCall = {
      method: init.method,
      url,
      headers: init.headers,
      body: init.body !== undefined ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[`${init.method} ${path}`];
    if (!handler) throw new Error(`unrouted: ${init.method} ${path}`);
    return handler(call);
  };
  return { fetchImpl, calls };
}

async function kindOf(p: Promise<unknown>): Promise<{ kind: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GithubApiError) return { kind: err.kind, message: err.message };
    throw err;
  }
  throw new Error("expected the promise to reject");
}

describe("scrubToken", () => {
  it("strips the literal, URL-encoded, base64 and Bearer wire forms", () => {
    const tok = "ghp_top+secret/value";
    const text = [
      `literal=${tok}`,
      `encoded=${encodeURIComponent(tok)}`,
      `b64=${base64Utf8(tok)}`,
      `bearer=Bearer ${tok}`,
      `bearer64=${base64Utf8(`Bearer ${tok}`)}`,
    ].join(" | ");
    const out = scrubToken(text, tok);
    expect(out).not.toContain(tok);
    expect(out).not.toContain(encodeURIComponent(tok));
    expect(out).not.toContain(base64Utf8(tok));
    expect(out).not.toContain(base64Utf8(`Bearer ${tok}`));
    expect(out).toContain("[redacted]");
  });

  it("passes text through untouched for an empty token", () => {
    expect(scrubToken("hello", "")).toBe("hello");
  });
});

describe("validateToken", () => {
  it("GETs /user with a Bearer header and resolves the login", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "GET /user": () => jsonResponse(200, { login: "octocat" }),
    });
    const res = await validateToken(TOKEN, { fetchImpl });
    expect(res).toEqual({ login: "octocat" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/user");
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.headers["accept"]).toContain("github");
  });

  it("maps 401 to bad-token, with the GitHub message included but the token scrubbed", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /user": () => jsonResponse(401, { message: `Bad credentials for ${TOKEN}` }),
    });
    const err = await kindOf(validateToken(TOKEN, { fetchImpl }));
    expect(err.kind).toBe("bad-token");
    expect(err.message).toContain("401");
    expect(err.message).not.toContain(TOKEN);
  });

  it("maps a rate-limit 403 to rate-limited (via the x-ratelimit-remaining header)", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /user": () =>
        jsonResponse(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" }),
    });
    expect((await kindOf(validateToken(TOKEN, { fetchImpl }))).kind).toBe("rate-limited");
  });

  it("maps 429 to rate-limited", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /user": () => jsonResponse(429, { message: "slow down" }),
    });
    expect((await kindOf(validateToken(TOKEN, { fetchImpl }))).kind).toBe("rate-limited");
  });

  it("maps a transport failure to network and scrubs an echoed token (all encodings)", async () => {
    const fetchImpl: GithubFetch = () =>
      Promise.reject(
        new Error(
          `socket hung up sending Bearer ${TOKEN} (b64 ${base64Utf8(TOKEN)}, enc ${encodeURIComponent(TOKEN)})`,
        ),
      );
    const err = await kindOf(validateToken(TOKEN, { fetchImpl }));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(base64Utf8(TOKEN));
    expect(err.message).not.toContain(encodeURIComponent(TOKEN));
  });

  it("rejects a blank token before any network call", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    expect((await kindOf(validateToken("   ", { fetchImpl }))).kind).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("caps + survives an unreadable success body", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /user": () => ({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve("<!doctype html> not json"),
      }),
    });
    expect((await kindOf(validateToken(TOKEN, { fetchImpl }))).kind).toBe("network");
  });
});

describe("createRepo", () => {
  it("POSTs /user/repos private-by-default and resolves owner/name", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "POST /user/repos": () =>
        jsonResponse(201, { name: "paper", owner: { login: "octocat" } }),
    });
    const res = await createRepo(TOKEN, { name: "paper" }, { fetchImpl });
    expect(res).toEqual({ owner: "octocat", name: "paper" });
    expect(calls[0]!.body).toMatchObject({ name: "paper", private: true, auto_init: false });
  });

  it("maps 422 (name already exists) to conflict", async () => {
    const { fetchImpl } = fakeFetch({
      "POST /user/repos": () =>
        jsonResponse(422, { message: "name already exists on this account" }),
    });
    const err = await kindOf(createRepo(TOKEN, { name: "paper" }, { fetchImpl }));
    expect(err.kind).toBe("conflict");
  });

  it("rejects an unsafe repo name before any network call", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    expect((await kindOf(createRepo(TOKEN, { name: "../etc" }, { fetchImpl }))).kind).toBe(
      "invalid",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("pushSnapshot", () => {
  const FILES = [
    { path: "main.typ", text: "= Hello" },
    { path: "chapters/intro.typ", text: "Intro." },
  ];

  function pushRoutes(opts: { refStatus?: number } = {}) {
    let blobCount = 0;
    let bootstrapped = false;
    return fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () => {
        if (opts.refStatus === undefined) return jsonResponse(200, { object: { sha: "base-sha" } });
        // An empty repo (409) answers 409 until the Contents-API bootstrap
        // gives it a commit; then the re-probe returns the bootstrap parent.
        if (opts.refStatus === 409 && bootstrapped)
          return jsonResponse(200, { object: { sha: "init-sha" } });
        return jsonResponse(opts.refStatus, { message: "nope" });
      },
      "PUT /repos/octocat/paper/contents/.galley-init": () => {
        bootstrapped = true;
        return jsonResponse(201, { commit: { sha: "init-sha" } });
      },
      "POST /repos/octocat/paper/git/blobs": () =>
        jsonResponse(201, { sha: `blob-${blobCount++}` }),
      "POST /repos/octocat/paper/git/trees": () => jsonResponse(201, { sha: "tree-sha" }),
      "POST /repos/octocat/paper/git/commits": () => jsonResponse(201, { sha: "commit-sha" }),
      "PATCH /repos/octocat/paper/git/refs/heads/main": () =>
        jsonResponse(200, { object: { sha: "commit-sha" } }),
      "POST /repos/octocat/paper/git/refs": () =>
        jsonResponse(201, { object: { sha: "commit-sha" } }),
    });
  }

  const REQ = { owner: "octocat", repo: "paper", message: "snapshot", files: FILES };

  it("walks ref → blobs → tree → commit → ref-update, in order, on an existing branch", async () => {
    const { fetchImpl, calls } = pushRoutes();
    const res = await pushSnapshot(TOKEN, REQ, { fetchImpl });
    expect(res).toEqual({
      commitSha: "commit-sha",
      branch: "main",
      createdBranch: false,
      filesPushed: 2,
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /repos/octocat/paper/git/ref/heads/main",
      "POST /repos/octocat/paper/git/blobs",
      "POST /repos/octocat/paper/git/blobs",
      "POST /repos/octocat/paper/git/trees",
      "POST /repos/octocat/paper/git/commits",
      "PATCH /repos/octocat/paper/git/refs/heads/main",
    ]);
    // The tree pairs each path with its blob sha; the commit parents on base.
    const tree = calls[3]!.body as { tree: Array<Record<string, unknown>> };
    expect(tree.tree).toEqual([
      { path: "main.typ", mode: "100644", type: "blob", sha: "blob-0" },
      { path: "chapters/intro.typ", mode: "100644", type: "blob", sha: "blob-1" },
    ]);
    expect(calls[4]!.body).toMatchObject({ tree: "tree-sha", parents: ["base-sha"] });
    // The ref move is a forced fast-forward-or-not — git is a one-way mirror.
    expect(calls[5]!.body).toMatchObject({ sha: "commit-sha", force: true });
  });

  it("sends EXACTLY {message, tree, parents} — never an author or committer (#12)", async () => {
    const { fetchImpl, calls } = pushRoutes();
    await pushSnapshot(TOKEN, REQ, { fetchImpl });
    // There is deliberately NO identity seam here: GitHub attributes both author
    // and committer to the authenticated PAT owner — a real, LINKED account
    // (avatar, profile, contribution graph). A synthesized `@users.galley.local`
    // identity would replace that with an unlinkable one, and since an omitted
    // `committer` defaults to the AUTHOR it would take both fields down with it.
    const body = calls.find((c) => c.url.endsWith("/git/commits"))!.body as Record<string, unknown>;
    expect(body).toEqual({ message: "snapshot", tree: "tree-sha", parents: ["base-sha"] });
    expect(body).not.toHaveProperty("author");
    expect(body).not.toHaveProperty("committer");
  });

  it("BOOTSTRAPS the wholly-EMPTY repo (409): Contents-API init → re-probe → snapshot push", async () => {
    const { fetchImpl, calls } = pushRoutes({ refStatus: 409 });
    const res = await pushSnapshot(TOKEN, REQ, { fetchImpl });
    expect(res.createdBranch).toBe(true);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /repos/octocat/paper/git/ref/heads/main", // 409: repo is empty
      "PUT /repos/octocat/paper/contents/.galley-init", // bootstrap the first commit
      "GET /repos/octocat/paper/git/ref/heads/main", // re-probe → the bootstrap parent
      "POST /repos/octocat/paper/git/blobs",
      "POST /repos/octocat/paper/git/blobs",
      "POST /repos/octocat/paper/git/trees",
      "POST /repos/octocat/paper/git/commits",
      "PATCH /repos/octocat/paper/git/refs/heads/main", // force-move past the placeholder
    ]);
    // The bootstrap writes a base64 placeholder on the target branch.
    const init = calls.find((c) => c.url.endsWith("/contents/.galley-init"))!;
    expect(init.body).toMatchObject({ branch: "main" });
    expect((init.body as { content: string }).content).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The snapshot commit parents on the bootstrap commit (no longer parentless).
    const commit = calls.find((c) => c.url.endsWith("/git/commits"))!;
    expect(commit.body).toMatchObject({ parents: ["init-sha"] });
    // The branch already exists (bootstrap created it), so the ref MOVES (force).
    const refMove = calls.at(-1)!;
    expect(refMove.body).toMatchObject({ sha: "commit-sha", force: true });
  });

  it("treats a 404 ref probe (missing branch) the same as a new branch", async () => {
    const { fetchImpl } = pushRoutes({ refStatus: 404 });
    const res = await pushSnapshot(TOKEN, REQ, { fetchImpl });
    expect(res.createdBranch).toBe(true);
  });

  it("propagates a blob-step 404 (repo truly missing) as not-found", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(404, { message: "Not Found" }),
      "POST /repos/octocat/paper/git/blobs": () => jsonResponse(404, { message: "Not Found" }),
    });
    expect((await kindOf(pushSnapshot(TOKEN, REQ, { fetchImpl }))).kind).toBe("not-found");
  });

  it("fails closed on caps: too many files / too many bytes", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const many = Array.from({ length: MAX_SNAPSHOT_FILES + 1 }, (_, i) => ({
      path: `f${i}.typ`,
      text: "x",
    }));
    expect(
      (await kindOf(pushSnapshot(TOKEN, { ...REQ, files: many }, { fetchImpl }))).kind,
    ).toBe("too-large");
    const big = [{ path: "big.typ", text: "x".repeat(MAX_SNAPSHOT_BYTES + 1) }];
    expect(
      (await kindOf(pushSnapshot(TOKEN, { ...REQ, files: big }, { fetchImpl }))).kind,
    ).toBe("too-large");
    expect(calls).toHaveLength(0); // both rejected before any network call
  });

  it("fails closed on unsafe paths and identifiers before any network call", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    for (const files of [
      [{ path: "../escape.typ", text: "x" }],
      [{ path: "/abs.typ", text: "x" }],
      [{ path: "a//b.typ", text: "x" }],
      [{ path: "ctl\u0007.typ", text: "x" }],
      [] as Array<{ path: string; text: string }>,
    ]) {
      const err = await kindOf(pushSnapshot(TOKEN, { ...REQ, files }, { fetchImpl }));
      expect(err.kind).toBe("invalid");
    }
    expect((await kindOf(pushSnapshot(TOKEN, { ...REQ, owner: "a/b" }, { fetchImpl }))).kind).toBe(
      "invalid",
    );
    expect(
      (await kindOf(pushSnapshot(TOKEN, { ...REQ, branch: "a/../b" }, { fetchImpl }))).kind,
    ).toBe("invalid");
    expect(calls).toHaveLength(0);
  });

  it("rejects branch dot segments that would URL-normalize onto a DIFFERENT ref", async () => {
    // `release/./main` normalizes to `release/main` in a URL path — with
    // force:true that would silently clobber the wrong branch. Fail closed.
    const { fetchImpl, calls } = fakeFetch({});
    for (const branch of ["release/./main", "./main", "main/.", "."]) {
      const err = await kindOf(pushSnapshot(TOKEN, { ...REQ, branch }, { fetchImpl }));
      expect(err.kind).toBe("invalid");
    }
    expect(calls).toHaveLength(0);
  });

  it("never surfaces the token from a mid-sequence failure, in any encoding", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(200, { object: { sha: "base-sha" } }),
      "POST /repos/octocat/paper/git/blobs": () => {
        throw new Error(
          `proxy echoed request: authorization: Bearer ${TOKEN}; raw=${TOKEN}; b64=${base64Utf8(TOKEN)}`,
        );
      },
    });
    const err = await kindOf(pushSnapshot(TOKEN, REQ, { fetchImpl }));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(base64Utf8(TOKEN));
    expect(err.message).not.toContain(encodeURIComponent(TOKEN));
  });

  it("defaults the branch to main and accepts a custom branch", async () => {
    let blob = 0;
    const { fetchImpl, calls } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/drafts/v2": () =>
        jsonResponse(404, { message: "missing" }),
      "POST /repos/octocat/paper/git/blobs": () => jsonResponse(201, { sha: `b${blob++}` }),
      "POST /repos/octocat/paper/git/trees": () => jsonResponse(201, { sha: "t" }),
      "POST /repos/octocat/paper/git/commits": () => jsonResponse(201, { sha: "c" }),
      "POST /repos/octocat/paper/git/refs": () => jsonResponse(201, {}),
    });
    const res = await pushSnapshot(TOKEN, { ...REQ, branch: "drafts/v2" }, { fetchImpl });
    expect(res.branch).toBe("drafts/v2");
    expect(calls.at(-1)!.body).toMatchObject({ ref: "refs/heads/drafts/v2" });
    // The dynamic URL path segments land exactly as validated — owner, repo and
    // each branch segment are percent-encoded defensively, which for the
    // validated charset is the identity (no mangling, no normalization).
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/octocat/paper/git/ref/heads/drafts/v2",
    );
  });
});

describe("fetchSnapshot", () => {
  const TARGET = { owner: "octocat", repo: "paper", branch: "main" };

  /** GitHub's blob API returns base64 with line wraps — model that here. */
  function blobBody(text: string) {
    const b64 = base64Utf8(text);
    const wrapped = (b64.match(/.{1,60}/g) ?? []).join("\n") + "\n";
    return { content: wrapped, encoding: "base64" };
  }

  function happyRoutes(
    files: Record<string, string>,
    opts: { truncated?: boolean; sizeOf?: (p: string) => number } = {},
  ) {
    const paths = Object.keys(files);
    // Git blob shas are hex (URL-safe) — model that, not the path, so the
    // per-blob route key matches the encoded request URL exactly.
    const blobShaOf = (p: string) => `blob${paths.indexOf(p)}`;
    return {
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(200, { object: { sha: "commit-sha" } }),
      "GET /repos/octocat/paper/git/commits/commit-sha": () =>
        jsonResponse(200, { tree: { sha: "tree-sha" } }),
      "GET /repos/octocat/paper/git/trees/tree-sha": () =>
        jsonResponse(200, {
          truncated: opts.truncated ?? false,
          tree: [
            { path: "docs", type: "tree", sha: "subtree" },
            // Real tree listings carry a byte `size` per blob — model it so the
            // byte preflight sees a valid size (overridable for the cap test).
            ...paths.map((p) => ({
              path: p,
              type: "blob",
              sha: blobShaOf(p),
              size: opts.sizeOf?.(p) ?? new TextEncoder().encode(files[p]!).length,
            })),
          ],
        }),
      ...Object.fromEntries(
        paths.map((p) => [
          `GET /repos/octocat/paper/git/blobs/${blobShaOf(p)}`,
          () => jsonResponse(200, blobBody(files[p]!)),
        ]),
      ),
    } as Record<string, (call: RecordedCall) => GithubResponseLike | Promise<GithubResponseLike>>;
  }

  it("reads ref → commit → tree → blobs and decodes base64 to UTF-8 text", async () => {
    const { fetchImpl, calls } = fakeFetch(
      happyRoutes({ "main.typ": "= Title — café ☕", "refs/a.bib": "@book{x}" }),
    );
    const files = await fetchSnapshot(TOKEN, TARGET, { fetchImpl });
    expect(files).toEqual([
      { path: "main.typ", text: "= Title — café ☕" },
      { path: "refs/a.bib", text: "@book{x}" },
    ]);
    // The recursive tree was requested, and only blob entries were fetched
    // (the `tree`-typed subdir was skipped).
    expect(calls[2]!.url).toBe(
      "https://api.github.com/repos/octocat/paper/git/trees/tree-sha?recursive=1",
    );
    expect(calls.filter((c) => c.url.includes("/git/blobs/")).length).toBe(2);
  });

  it("returns null when the branch ref is absent (404 — nothing to import)", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(404, { message: "Not Found" }),
    });
    expect(await fetchSnapshot(TOKEN, TARGET, { fetchImpl })).toBeNull();
  });

  it("returns null when the repo is wholly empty (409 — nothing to import)", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(409, { message: "Git Repository is empty." }),
    });
    expect(await fetchSnapshot(TOKEN, TARGET, { fetchImpl })).toBeNull();
  });

  it("returns null when the tree is empty (a bootstrapped repo with no real files)", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(200, { object: { sha: "commit-sha" } }),
      "GET /repos/octocat/paper/git/commits/commit-sha": () =>
        jsonResponse(200, { tree: { sha: "tree-sha" } }),
      "GET /repos/octocat/paper/git/trees/tree-sha": () =>
        jsonResponse(200, { truncated: false, tree: [] }),
    });
    expect(await fetchSnapshot(TOKEN, TARGET, { fetchImpl })).toBeNull();
  });

  it("fails CLOSED with too-large when the tree is truncated (never a silent partial import)", async () => {
    const { fetchImpl } = fakeFetch(happyRoutes({ "main.typ": "x" }, { truncated: true }));
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("too-large");
  });

  it("fails CLOSED with too-large when the blob count exceeds the cap", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_SNAPSHOT_FILES; i++) many[`f${i}.typ`] = "x";
    const { fetchImpl } = fakeFetch(happyRoutes(many));
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("too-large");
  });

  it("fails CLOSED with too-large when the summed blob sizes exceed the byte cap — BEFORE any blob download", async () => {
    // <=500 files but one huge blob: the byte preflight must reject it from the
    // tree listing's `size`, never fetching a blob (the DoS the review flagged).
    const { fetchImpl, calls } = fakeFetch(
      happyRoutes(
        { "huge.typ": "x" },
        { sizeOf: () => MAX_SNAPSHOT_BYTES + 1 },
      ),
    );
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("too-large");
    expect(calls.some((c) => c.url.includes("/git/blobs/"))).toBe(false);
  });

  it("fails CLOSED with too-large when the tree listing omits a blob size", async () => {
    const { fetchImpl, calls } = fakeFetch(
      happyRoutes({ "main.typ": "x" }, { sizeOf: () => Number.NaN }),
    );
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("too-large");
    expect(calls.some((c) => c.url.includes("/git/blobs/"))).toBe(false);
  });

  it("rejects a hostile traversal path in the fetched tree (fail closed)", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(200, { object: { sha: "commit-sha" } }),
      "GET /repos/octocat/paper/git/commits/commit-sha": () =>
        jsonResponse(200, { tree: { sha: "tree-sha" } }),
      "GET /repos/octocat/paper/git/trees/tree-sha": () =>
        jsonResponse(200, {
          truncated: false,
          tree: [{ path: "../../etc/passwd", type: "blob", sha: "evil" }],
        }),
    });
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("invalid");
  });

  it("validates owner/repo/branch the same way push does", async () => {
    const { fetchImpl } = fakeFetch({});
    expect((await kindOf(fetchSnapshot(TOKEN, { ...TARGET, owner: "bad/owner" }, { fetchImpl }))).kind).toBe(
      "invalid",
    );
    expect((await kindOf(fetchSnapshot(TOKEN, { ...TARGET, branch: "a/../b" }, { fetchImpl }))).kind).toBe(
      "invalid",
    );
  });

  it("never surfaces the token, in any encoding, from a mid-sequence failure", async () => {
    const { fetchImpl } = fakeFetch({
      "GET /repos/octocat/paper/git/ref/heads/main": () =>
        jsonResponse(200, { object: { sha: "commit-sha" } }),
      "GET /repos/octocat/paper/git/commits/commit-sha": () => {
        throw new Error(
          `proxy echoed: authorization: Bearer ${TOKEN}; raw=${TOKEN}; b64=${base64Utf8(TOKEN)}`,
        );
      },
    });
    const err = await kindOf(fetchSnapshot(TOKEN, TARGET, { fetchImpl }));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(base64Utf8(TOKEN));
    expect(err.message).not.toContain(encodeURIComponent(TOKEN));
  });
});
