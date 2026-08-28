/**
 * Session-layer re-audit regression (#1 slice 2 rider): the session path is now
 * load-bearing for capability-room REGISTRATION (it supplies `createdBy` and a
 * control room's expiry), so `FsSessionStore.getValid` must fail CLOSED on a
 * malformed record. Previously a record with a missing/non-numeric
 * `expiresAtMs` compared false against every clock and validated FOREVER — an
 * immortal session via a corrupt/foreign file on the shared volume.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSessionStore } from "./fs-auth-stores.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "galley-sess-audit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function plantSession(id: string, record: unknown): Promise<void> {
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(join(dir, "sessions", `${id}.json`), JSON.stringify(record));
}

describe("FsSessionStore.getValid — malformed-expiry fail-closed", () => {
  it.each([
    ["missing expiresAtMs", { userId: "u", createdAtMs: 0 }],
    [
      "string expiresAtMs",
      { userId: "u", createdAtMs: 0, expiresAtMs: "never" },
    ],
    ["null expiresAtMs", { userId: "u", createdAtMs: 0, expiresAtMs: null }],
  ])(
    "a record with %s is INVALID and reaped on access",
    async (_name, record) => {
      const store = new FsSessionStore(dir);
      await plantSession("malformed", record);
      expect(await store.getValid("malformed", 1000)).toBeNull();
      // Reaped: even the raw (non-expiry-enforcing) read no longer finds it.
      expect(await store.get("malformed")).toBeNull();
    },
  );

  it("an INFINITE expiry (raw JSON `1e999` → Infinity) is INVALID and reaped (M3)", async () => {
    const store = new FsSessionStore(dir);
    // JSON.stringify can't emit 1e999 — plant the raw body a hostile/corrupt
    // writer could leave on the shared volume. JSON.parse reads it as Infinity,
    // which an `<= nowMs` comparison would never expire: immortal-session bug.
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(
      join(dir, "sessions", "immortal.json"),
      '{"userId":"u","createdAtMs":0,"expiresAtMs":1e999}',
    );
    expect(await store.getValid("immortal", 1000)).toBeNull();
    expect(await store.get("immortal")).toBeNull(); // reaped
  });

  it("a NEGATIVE expiry is simply expired (finite path unchanged)", async () => {
    const store = new FsSessionStore(dir);
    await plantSession("past", { userId: "u", createdAtMs: 0, expiresAtMs: -1 });
    expect(await store.getValid("past", 1000)).toBeNull();
  });

  it("a WELL-FORMED unexpired record still validates (no regression)", async () => {
    const store = new FsSessionStore(dir);
    const { id } = await store.create({
      userId: "u",
      createdAtMs: 0,
      expiresAtMs: 5000,
    });
    expect(await store.getValid(id, 1000)).toMatchObject({ userId: "u" });
    expect(await store.getValid(id, 5000)).toBeNull(); // boundary unchanged
  });
});
