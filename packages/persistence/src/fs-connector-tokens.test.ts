import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorTokenRecord } from "@galley/shared";
import { FsConnectorTokenStore } from "./fs-connector-tokens.js";

const HASH = "a".repeat(64);
const record = (hash = HASH): ConnectorTokenRecord => ({
  version: 1,
  tokenId: "aaaaaaaaaaaaaaaa",
  hash,
  createdBy: "alice",
  name: "Claude chat",
  createdAtMs: 1,
  expiresAtMs: 2,
});

describe("FsConnectorTokenStore", () => {
  it("round-trips a record under its hash, and removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "galley-connector-tokens-"));
    try {
      const store = new FsConnectorTokenStore(root);
      expect(await store.list()).toEqual([]); // no directory yet
      await store.put(record());
      expect(await readdir(join(root, "connector-tokens"))).toEqual([
        `${HASH}.json`,
      ]);
      expect(await store.get(HASH)).toEqual(record());
      expect(await store.list()).toEqual([record()]);
      await store.remove(HASH);
      expect(await store.get(HASH)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never builds a path from an invalid hash, and ignores foreign files", async () => {
    const root = await mkdtemp(join(tmpdir(), "galley-connector-tokens-"));
    try {
      const store = new FsConnectorTokenStore(root);
      await expect(store.put(record("../../escape"))).rejects.toThrow(
        /invalid hash/,
      );
      expect(await store.get("../../etc/passwd")).toBeNull();
      await store.put(record());
      const dir = join(root, "connector-tokens");
      // A record filed under another hash, and a truncated file: neither is a token.
      await writeFile(
        join(dir, `${"b".repeat(64)}.json`),
        JSON.stringify(record()),
      );
      await writeFile(join(dir, `${"c".repeat(64)}.json`), "{");
      expect(await store.get("b".repeat(64))).toBeNull();
      expect(await store.list()).toEqual([record()]);
      expect(await readFile(join(dir, `${HASH}.json`), "utf8")).not.toContain(
        "gly_",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
