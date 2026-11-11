import { describe, it, expect } from "vitest";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldConnectorActivity,
  type ConnectorActivityEntry,
} from "@galley/shared";
import {
  FsConnectorActivityLog,
  FsConnectorCheckpoints,
} from "./fs-connector-activity.js";

const ROOM = "share-activitytest0000000000000000";
const entry = (
  over: Partial<ConnectorActivityEntry> = {},
): ConnectorActivityEntry => ({
  version: 1,
  changeId: "change-1",
  state: "started",
  atMs: 1,
  tokenId: "aaaaaaaaaaaaaaaa",
  request: "Fix a typo",
  files: ["/main.typ"],
  ops: 1,
  bytes: 12,
  checkpointId: `${"0".repeat(13)}-${"a".repeat(64)}`,
  ...over,
});

async function withLog(
  run: (log: FsConnectorActivityLog, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "galley-connector-activity-"));
  try {
    await run(new FsConnectorActivityLog(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("FsConnectorActivityLog", () => {
  it("is empty before anything is written, then keeps entries in order", () =>
    withLog(async (log) => {
      expect(await log.read(ROOM)).toEqual([]);
      await log.append(ROOM, entry());
      await log.append(ROOM, entry({ state: "applied", atMs: 2 }));
      expect((await log.read(ROOM)).map((e) => e.state)).toEqual([
        "started",
        "applied",
      ]);
    }));

  it("keeps each project's trail apart", () =>
    withLog(async (log) => {
      await log.append(ROOM, entry());
      expect(await log.read("share-otherroom00000000000000000000")).toEqual([]);
    }));

  it("refuses an invalid entry and an unsafe room name, writing nothing", () =>
    withLog(async (log, root) => {
      await expect(
        log.append(ROOM, entry({ checkpointId: "nope" })),
      ).rejects.toThrow();
      await expect(log.append("../escape", entry())).rejects.toThrow();
      await expect(log.read("../escape")).rejects.toThrow();
      await expect(stat(join(root, "activity"))).rejects.toThrow();
    }));

  it("skips a torn or foreign line instead of failing the whole trail", () =>
    withLog(async (log, root) => {
      await log.append(ROOM, entry());
      await appendFile(
        join(root, "activity", `${ROOM}.jsonl`),
        '{"version":1,"changeId":"x"}\n{"torn',
      );
      expect(await log.read(ROOM)).toEqual([entry()]);
    }));

  it("stays bounded: an overgrown trail is rewritten with its newest entries", () =>
    withLog(async (log, root) => {
      // ~60 KB per entry, so a few dozen appends cross the 1 MiB bound.
      const files = Array.from({ length: 60 }, (_, i) =>
        `/${String(i).padStart(3, "0")}${"p".repeat(990)}`,
      );
      for (let i = 0; i < 40; i++)
        await log.append(ROOM, entry({ changeId: `change-${i}`, atMs: i, files }));
      const kept = await log.read(ROOM);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(40);
      expect(kept.at(-1)?.changeId).toBe("change-39");
      expect(
        (await readFile(join(root, "activity", `${ROOM}.jsonl`))).byteLength,
      ).toBeLessThan(1024 * 1024 + 64 * 1024);
    }));
});

describe("FsConnectorCheckpoints", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  async function withStore(
    run: (store: FsConnectorCheckpoints, root: string) => Promise<void>,
    keep?: number,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "galley-connector-checkpoints-"));
    try {
      await run(
        new FsConnectorCheckpoints(root, {
          now: () => 5,
          ...(keep !== undefined ? { keep } : {}),
        }),
        root,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("stores a checkpoint under a self-checking id and reads it back", () =>
    withStore(async (store) => {
      expect(await store.list(ROOM)).toEqual([]);
      const id = await store.save(ROOM, bytes("one"));
      expect(id).toMatch(/^0000000000005-[a-f0-9]{64}$/);
      expect(new TextDecoder().decode((await store.read(ROOM, id))!)).toBe("one");
      expect(await store.read(ROOM, `${"9".repeat(13)}-${"a".repeat(64)}`)).toBeNull();
      expect(await store.read(ROOM, "../../etc/passwd")).toBeNull();
    }));

  it("gives ids that sort in the order taken, even within one millisecond", () =>
    withStore(async (store) => {
      const first = await store.save(ROOM, bytes("same"));
      const second = await store.save(ROOM, bytes("same"));
      expect(second > first).toBe(true);
      expect(await store.list(ROOM)).toEqual([second, first]);
    }));

  it("keeps only the newest checkpoints of a project", () =>
    withStore(async (store, root) => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await store.save(ROOM, bytes(`v${i}`)));
      expect(await store.list(ROOM)).toEqual([ids[4], ids[3], ids[2]]);
      expect(await readdir(join(root, "checkpoints", ROOM))).toHaveLength(3);
    }, 3));

  it("does not return a checkpoint whose bytes changed on disk", () =>
    withStore(async (store, root) => {
      const id = await store.save(ROOM, bytes("honest"));
      await writeFile(join(root, "checkpoints", ROOM, `${id}.json`), "tampered");
      expect(await store.read(ROOM, id)).toBeNull();
    }));

  it("refuses an unsafe room name", () =>
    withStore(async (store) => {
      await expect(store.save("../escape", bytes("x"))).rejects.toThrow();
      await expect(store.list("../escape")).rejects.toThrow();
    }));
});

describe("foldConnectorActivity", () => {
  it("shows each change once, in its final state, newest first", () => {
    const folded = foldConnectorActivity([
      entry({ changeId: "a", atMs: 1 }),
      entry({ changeId: "a", atMs: 2, state: "applied" }),
      entry({ changeId: "b", atMs: 3 }),
      entry({ changeId: "c", atMs: 4 }),
      entry({ changeId: "c", atMs: 5, state: "conflict" }),
    ]);
    expect(folded.map((e) => [e.changeId, e.state])).toEqual([
      ["c", "conflict"],
      ["b", "started"],
      ["a", "applied"],
    ]);
  });
});
