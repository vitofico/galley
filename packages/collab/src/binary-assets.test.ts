import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  inferMime,
  assetEquals,
  InMemoryBlobStore,
  type BinaryAsset,
} from "./binary-assets.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);

describe("binary-assets.sha256Hex", () => {
  it("matches known vectors and is deterministic", async () => {
    // Well-known: sha256("") and sha256("abc").
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const a = await sha256Hex(PNG);
    const b = await sha256Hex(PNG);
    expect(a).toBe(b);
  });

  it("hashes only the view's bytes, not the backing buffer", async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5); // [1,2,3]
    expect(await sha256Hex(view)).toBe(await sha256Hex(bytes(1, 2, 3)));
  });
});

describe("binary-assets.inferMime", () => {
  it("sniffs magic numbers (png/jpeg/gif/webp/pdf/bmp/tiff)", () => {
    expect(inferMime(PNG)).toBe("image/png");
    expect(inferMime(JPEG)).toBe("image/jpeg");
    expect(inferMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(inferMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
    expect(inferMime(PDF)).toBe("application/pdf");
    expect(inferMime(bytes(0x42, 0x4d, 0, 0))).toBe("image/bmp");
    expect(inferMime(bytes(0x49, 0x49, 0x2a, 0x00))).toBe("image/tiff");
  });

  it("sniffs SVG text and honors the extension when there's no magic", () => {
    expect(inferMime(new TextEncoder().encode('<svg xmlns="...">'))).toBe("image/svg+xml");
    expect(inferMime(new TextEncoder().encode('<?xml version="1.0"?><svg>'))).toBe("image/svg+xml");
    expect(inferMime(bytes(1, 2, 3, 4), "diagram.png")).toBe("image/png");
  });

  it("falls back to octet-stream for unknown bytes with no usable extension", () => {
    expect(inferMime(bytes(1, 2, 3, 4))).toBe("application/octet-stream");
    expect(inferMime(bytes(1, 2, 3, 4), "data.unknownext")).toBe("application/octet-stream");
  });
});

describe("binary-assets.InMemoryBlobStore", () => {
  it("put returns a content-addressed pointer with hash/size/mime", async () => {
    const store = new InMemoryBlobStore();
    const asset = await store.put(PNG, { filename: "x.png" });
    expect(asset.type).toBe("binary");
    expect(asset.hash).toBe(await sha256Hex(PNG));
    expect(asset.size).toBe(PNG.byteLength);
    expect(asset.mime).toBe("image/png");
    expect(await store.has(asset.hash)).toBe(true);
  });

  it("dedupes identical content (same hash, stored once)", async () => {
    const store = new InMemoryBlobStore();
    const a = await store.put(PNG);
    const b = await store.put(PNG.slice()); // identical bytes, different array
    expect(a.hash).toBe(b.hash);
    expect(store.size).toBe(1);
    const c = await store.put(JPEG);
    expect(c.hash).not.toBe(a.hash);
    expect(store.size).toBe(2);
  });

  it("get returns a copy of the stored bytes; unknown hash → undefined", async () => {
    const store = new InMemoryBlobStore();
    const { hash } = await store.put(PDF);
    const got = await store.get(hash);
    expect(got).toEqual(PDF);
    // Mutating the returned copy must not corrupt the store.
    got![0] = 0;
    expect(await store.get(hash)).toEqual(PDF);
    expect(await store.get("deadbeef")).toBeUndefined();
  });

  it("an explicit mime hint overrides sniffing", async () => {
    const store = new InMemoryBlobStore();
    const asset = await store.put(bytes(1, 2, 3), { mime: "application/x-custom" });
    expect(asset.mime).toBe("application/x-custom");
  });
});

describe("binary-assets.assetEquals", () => {
  it("is content equality by hash", () => {
    const a: BinaryAsset = { type: "binary", hash: "aa", size: 1, mime: "image/png" };
    const b: BinaryAsset = { type: "binary", hash: "aa", size: 999, mime: "image/jpeg" };
    const c: BinaryAsset = { type: "binary", hash: "bb", size: 1, mime: "image/png" };
    expect(assetEquals(a, b)).toBe(true); // same bytes ⇒ equal, metadata aside
    expect(assetEquals(a, c)).toBe(false);
  });
});
