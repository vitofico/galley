/**
 * Roadmap #4 follow-up: durable Fs session + login-state stores. Same contracts
 * as the in-memory ones, over real files (survive a "restart"), plus the
 * security-critical guarantee: an untrusted id/state key that isn't a base64url
 * token is rejected BEFORE any filesystem access (no path traversal).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSessionStore, FsOidcLoginStateStore } from "./index.js";
import type { OidcLoginState, SessionRecord } from "@galley/shared";

let root: string;
const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  userId: "oidc:abc",
  createdAtMs: 1_000,
  expiresAtMs: 10_000,
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "galley-fsauth-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FsSessionStore", () => {
  it("persists a session across a 'restart' and enforces expiry on getValid", async () => {
    const { id } = await new FsSessionStore(root).create(rec({ expiresAtMs: 5_000 }));
    const fresh = new FsSessionStore(root); // new instance, same root
    expect(await fresh.getValid(id, 4_999)).toEqual(rec({ expiresAtMs: 5_000 }));
    expect(await fresh.getValid(id, 5_000)).toBeNull(); // expired → reaped
    expect(await fresh.get(id)).toBeNull();
  });

  it("mints distinct, high-entropy, url-safe ids", async () => {
    const s = new FsSessionStore(root);
    const a = await s.create(rec());
    const b = await s.create(rec());
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.id.length).toBeGreaterThanOrEqual(40);
  });

  it("rejects an unsafe id without touching the filesystem (no traversal)", async () => {
    const s = new FsSessionStore(root);
    // Plant a file outside sessions/ that a traversal id would try to reach.
    await writeFile(join(root, "secret.json"), JSON.stringify(rec()));
    for (const evil of ["../secret", "../../etc/passwd", "a/b", "a.b", "", "x".repeat(200)]) {
      expect(await s.getValid(evil, 0), evil).toBeNull();
      expect(await s.get(evil), evil).toBeNull();
      await s.delete(evil); // must be a no-op, never delete outside
    }
    // The planted file is untouched.
    expect((await readdir(root)).includes("secret.json")).toBe(true);
  });

  it("deleteExpired reaps only lapsed sessions", async () => {
    const s = new FsSessionStore(root);
    const a = await s.create(rec({ expiresAtMs: 5_000 }));
    const b = await s.create(rec({ expiresAtMs: 20_000 }));
    await s.deleteExpired(5_000);
    expect(await s.get(a.id)).toBeNull();
    expect(await s.get(b.id)).not.toBeNull();
  });
});

describe("FsOidcLoginStateStore", () => {
  const state = (s: string): OidcLoginState => ({
    state: s,
    codeVerifier: "v",
    nonce: "n",
    returnTo: "/",
    expiresAtMs: 9_999,
  });

  it("consume returns valid state once, then burns it (replay defense), across a restart", async () => {
    await new FsOidcLoginStateStore(root).put(state("abc123"));
    const fresh = new FsOidcLoginStateStore(root);
    expect(await fresh.consume("abc123", 1_000)).toMatchObject({ state: "abc123", codeVerifier: "v" });
    expect(await fresh.consume("abc123", 1_000)).toBeNull(); // burned
  });

  it("burns an expired state too (deletes + null)", async () => {
    const s = new FsOidcLoginStateStore(root);
    await s.put(state("old1"));
    expect(await s.consume("old1", 10_000)).toBeNull(); // expired
    expect(await s.consume("old1", 1_000)).toBeNull(); // and gone
  });

  it("rejects an unsafe state key without touching the filesystem", async () => {
    await mkdir(join(root, "login-state"), { recursive: true });
    await writeFile(join(root, "login-state.json"), "{}");
    const s = new FsOidcLoginStateStore(root);
    expect(await s.consume("../login-state", 1_000)).toBeNull();
    expect(await s.consume("a/b", 1_000)).toBeNull();
  });
});
