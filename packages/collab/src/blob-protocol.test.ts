import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrame,
  verifyBlob,
  concatChunks,
  planTransfer,
  isValidHash,
  isValidTransferId,
  isValidMime,
  expectedChunks,
  peekFrameRouting,
  deriveBlobTerminalKey,
  signBlobTerminal,
  verifyBlobTerminal,
  BlobProtocolError,
  FrameType,
  BLOB_CHUNK_BYTES,
  BLOB_MAX_TRANSFER_BYTES,
  type HeaderFrame,
  type BlobFrame,
} from "./blob-protocol.js";
import { sha256Hex } from "./binary-assets.js";

const HASH = "a".repeat(64);

/** A consistent header for `size` bytes (totalChunks is now strictly derived). */
function header(size: number, over: Partial<HeaderFrame> = {}): HeaderFrame {
  return {
    kind: "header",
    transferId: "t",
    hash: HASH,
    size,
    mime: "image/png",
    totalChunks: expectedChunks(size),
    ...over,
  };
}

describe("blob-protocol — framing round-trip", () => {
  it("round-trips a header frame", () => {
    // 999 bytes -> 1 chunk (strict derived count).
    const frame = header(999, { transferId: "t-123" });
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a data frame with arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 0, 0, 7]);
    const frame: BlobFrame = { kind: "data", transferId: "t", index: 3, bytes };
    const out = decodeFrame(encodeFrame(frame));
    expect(out.kind).toBe("data");
    expect(out).toEqual(frame);
  });

  it("round-trips ack, abort, and complete frames (with + without MAC)", () => {
    const ack: BlobFrame = { kind: "ack", transferId: "t", index: 2 };
    const abort: BlobFrame = { kind: "abort", transferId: "t", reason: "verify-failed" };
    const abortMac: BlobFrame = { kind: "abort", transferId: "t", reason: "x", mac: "AAAA" };
    const complete: BlobFrame = { kind: "complete", transferId: "t", hash: HASH, size: 42 };
    const completeMac: BlobFrame = { kind: "complete", transferId: "t", hash: HASH, size: 42, mac: "BBBB" };
    expect(decodeFrame(encodeFrame(ack))).toEqual(ack);
    expect(decodeFrame(encodeFrame(abort))).toEqual(abort);
    expect(decodeFrame(encodeFrame(abortMac))).toEqual(abortMac);
    expect(decodeFrame(encodeFrame(complete))).toEqual(complete);
    expect(decodeFrame(encodeFrame(completeMac))).toEqual(completeMac);
  });

  it("round-trips a full-size chunk (256 KiB) and an empty chunk", () => {
    const big = new Uint8Array(BLOB_CHUNK_BYTES).map((_, i) => i & 0xff);
    expect(decodeFrame(encodeFrame({ kind: "data", transferId: "t", index: 0, bytes: big }))).toEqual({
      kind: "data",
      transferId: "t",
      index: 0,
      bytes: big,
    });
    const empty = new Uint8Array(0);
    expect(decodeFrame(encodeFrame({ kind: "data", transferId: "t", index: 0, bytes: empty }))).toEqual({
      kind: "data",
      transferId: "t",
      index: 0,
      bytes: empty,
    });
  });

  it("tags the first byte with the frame type", () => {
    expect(encodeFrame(header(0))[0]).toBe(FrameType.Header);
    expect(encodeFrame({ kind: "data", transferId: "t", index: 0, bytes: new Uint8Array() })[0]).toBe(FrameType.Data);
    expect(encodeFrame({ kind: "complete", transferId: "t", hash: HASH, size: 0 })[0]).toBe(FrameType.Complete);
  });
});

describe("blob-protocol — defensive decode (adversarial)", () => {
  it("throws on an unknown frame tag", () => {
    expect(() => decodeFrame(new Uint8Array([99, 0, 0]))).toThrow(BlobProtocolError);
  });

  it("throws on a truncated frame", () => {
    const full = encodeFrame({ kind: "data", transferId: "tid", index: 1, bytes: new Uint8Array([1, 2, 3]) });
    expect(() => decodeFrame(full.subarray(0, full.length - 2))).toThrow(BlobProtocolError);
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(BlobProtocolError);
  });

  it("throws on trailing bytes after a complete frame (no smuggling)", () => {
    const ack = encodeFrame({ kind: "ack", transferId: "t", index: 1 });
    const padded = new Uint8Array(ack.length + 3);
    padded.set(ack);
    expect(() => decodeFrame(padded)).toThrow(BlobProtocolError);
  });

  it("rejects a header whose declared size exceeds the transfer cap (patched on the wire)", () => {
    // Encode a legal zero header then patch the u32 size field one over the cap.
    const legal = encodeFrame(header(0));
    const idx = 1 + 1 + 1 + 1 + 64; // tag + idLen + id("t") + hashLen + hash
    const over = BLOB_MAX_TRANSFER_BYTES + 1;
    legal[idx] = (over >>> 24) & 0xff;
    legal[idx + 1] = (over >>> 16) & 0xff;
    legal[idx + 2] = (over >>> 8) & 0xff;
    legal[idx + 3] = over & 0xff;
    expect(() => decodeFrame(legal)).toThrow(BlobProtocolError);
  });

  it("rejects a header with a non-hex / uppercase hash", () => {
    expect(() => encodeFrame(header(0, { hash: "ZZ".repeat(32) }))).toThrow(BlobProtocolError);
    expect(() => encodeFrame(header(0, { hash: "A".repeat(64) }))).toThrow(BlobProtocolError); // uppercase
  });

  it("rejects an over-cap chunk on encode", () => {
    expect(() =>
      encodeFrame({ kind: "data", transferId: "t", index: 0, bytes: new Uint8Array(BLOB_CHUNK_BYTES + 1) }),
    ).toThrow(BlobProtocolError);
  });

  it("rejects an inconsistent totalChunks on encode AND decode (§C9)", () => {
    // size 0 but totalChunks 5 — inconsistent.
    expect(() => encodeFrame({ kind: "header", transferId: "t", hash: HASH, size: 0, mime: "m", totalChunks: 5 })).toThrow(
      BlobProtocolError,
    );
    // Patch a legal header's totalChunks to a wrong-but-in-cap value, then decode.
    const legal = encodeFrame(header(0));
    const idx = legal.length - 4;
    legal[idx] = 0;
    legal[idx + 1] = 0;
    legal[idx + 2] = 0;
    legal[idx + 3] = 7; // size 0 should mean 0 chunks, not 7
    expect(() => decodeFrame(legal)).toThrow(BlobProtocolError);
  });
});

describe("blob-protocol — u32 boundary (§C8)", () => {
  it("encodes index 0 and 0xffffffff, rejects 0x100000000", () => {
    // index 0 and max u32 round-trip.
    expect(decodeFrame(encodeFrame({ kind: "ack", transferId: "t", index: 0 }))).toEqual({
      kind: "ack",
      transferId: "t",
      index: 0,
    });
    expect(decodeFrame(encodeFrame({ kind: "ack", transferId: "t", index: 0xffffffff }))).toEqual({
      kind: "ack",
      transferId: "t",
      index: 0xffffffff,
    });
    // 2^32 must NOT silently wrap to 0 — it must throw.
    expect(() => encodeFrame({ kind: "ack", transferId: "t", index: 0x100000000 })).toThrow(BlobProtocolError);
    expect(() => encodeFrame({ kind: "data", transferId: "t", index: 0x100000000, bytes: new Uint8Array() })).toThrow(
      BlobProtocolError,
    );
  });

  it("rejects a negative or non-integer index on encode", () => {
    expect(() => encodeFrame({ kind: "ack", transferId: "t", index: -1 })).toThrow(BlobProtocolError);
    expect(() => encodeFrame({ kind: "ack", transferId: "t", index: 1.5 })).toThrow(BlobProtocolError);
  });
});

describe("blob-protocol — field validators (§C10)", () => {
  it("isValidHash accepts only lowercase 64-hex", () => {
    expect(isValidHash("a".repeat(64))).toBe(true);
    expect(isValidHash("A".repeat(64))).toBe(false);
    expect(isValidHash("a".repeat(63))).toBe(false);
    expect(isValidHash("g".repeat(64))).toBe(false);
  });
  it("isValidTransferId rejects empty + over-cap", () => {
    expect(isValidTransferId("t")).toBe(true);
    expect(isValidTransferId("")).toBe(false);
    expect(isValidTransferId("x".repeat(65))).toBe(false);
  });
  it("isValidMime bounds the byte length", () => {
    expect(isValidMime("image/png")).toBe(true);
    expect(isValidMime("x".repeat(256))).toBe(false);
  });
  it("expectedChunks is 0 for empty and ceil(size/chunk) otherwise", () => {
    expect(expectedChunks(0)).toBe(0);
    expect(expectedChunks(1)).toBe(1);
    expect(expectedChunks(BLOB_CHUNK_BYTES)).toBe(1);
    expect(expectedChunks(BLOB_CHUNK_BYTES + 1)).toBe(2);
  });
});

describe("blob-protocol — verify + plan", () => {
  it("verifies matching bytes and rejects size or hash mismatch", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = await sha256Hex(bytes);
    const h: HeaderFrame = { kind: "header", transferId: "t", hash, size: 5, mime: "x", totalChunks: 1 };
    expect(await verifyBlob(bytes, h)).toBe(true);
    expect(await verifyBlob(bytes, { ...h, size: 4 })).toBe(false);
    expect(await verifyBlob(new Uint8Array([1, 2, 3, 4, 6]), h)).toBe(false);
  });

  it("plans a multi-chunk transfer and reassembles to the original", async () => {
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 17).map((_, i) => (i * 7) & 0xff);
    const hash = await sha256Hex(bytes);
    const { header: h, data } = planTransfer("t-1", bytes, hash, "application/octet-stream");
    expect(h.totalChunks).toBe(3);
    expect(data).toHaveLength(3);
    expect(data[0]!.bytes.length).toBe(BLOB_CHUNK_BYTES);
    expect(data[2]!.bytes.length).toBe(17);
    const reassembled = concatChunks(data.map((d) => d.bytes));
    expect(reassembled).toEqual(bytes);
    expect(await verifyBlob(reassembled, h)).toBe(true);
  });

  it("plans an empty blob as zero chunks", () => {
    const { header: h, data } = planTransfer("t", new Uint8Array(0), "0".repeat(64), "x");
    expect(h.totalChunks).toBe(0);
    expect(data).toHaveLength(0);
  });
});

describe("blob-protocol — peekFrameRouting (relay hot path, §4)", () => {
  it("reads tag + transferId from each frame type WITHOUT decoding the payload", () => {
    const big = new Uint8Array(BLOB_CHUNK_BYTES).fill(7);
    const dataFrame = encodeFrame({ kind: "data", transferId: "t-77", index: 3, bytes: big });
    const r = peekFrameRouting(dataFrame);
    expect(r.tag).toBe(FrameType.Data);
    expect(r.transferId).toBe("t-77");
    expect(peekFrameRouting(encodeFrame(header(999, { transferId: "h1" })))).toEqual({
      tag: FrameType.Header,
      transferId: "h1",
    });
    expect(peekFrameRouting(encodeFrame({ kind: "complete", transferId: "c1", hash: HASH, size: 1 }))).toEqual({
      tag: FrameType.Complete,
      transferId: "c1",
    });
    expect(peekFrameRouting(encodeFrame({ kind: "abort", transferId: "a1", reason: "x" }))).toEqual({
      tag: FrameType.Abort,
      transferId: "a1",
    });
  });

  it("throws on truncated / unknown-tag / over-cap-id frames", () => {
    expect(() => peekFrameRouting(new Uint8Array(0))).toThrow(BlobProtocolError);
    expect(() => peekFrameRouting(new Uint8Array([99, 0]))).toThrow(BlobProtocolError);
    // A data frame truncated before the transferId completes.
    const d = encodeFrame({ kind: "data", transferId: "tid", index: 0, bytes: new Uint8Array([1]) });
    expect(() => peekFrameRouting(d.subarray(0, 2))).toThrow(BlobProtocolError);
  });
});

describe("blob-protocol — terminal authentication (rework rd3 §1)", () => {
  const scope = {
    grantId: "g1",
    controlRoom: "ctrl",
    syncUrl: "ws://relay/",
    projectId: "proj",
    shareRoom: "share",
  };
  const key = new Uint8Array(32).map((_, i) => (i * 11) & 0xff);

  it("a valid COMPLETE MAC verifies; a forged/wrong-key/wrong-field MAC does NOT", async () => {
    const k = await deriveBlobTerminalKey(key, scope);
    const mac = await signBlobTerminal(k, scope, "complete", "tx", HASH, 100, null);
    expect(await verifyBlobTerminal(k, scope, "complete", "tx", HASH, 100, null, mac)).toBe(true);
    // wrong transferId
    expect(await verifyBlobTerminal(k, scope, "complete", "OTHER", HASH, 100, null, mac)).toBe(false);
    // wrong hash
    expect(await verifyBlobTerminal(k, scope, "complete", "tx", "b".repeat(64), 100, null, mac)).toBe(false);
    // wrong size
    expect(await verifyBlobTerminal(k, scope, "complete", "tx", HASH, 101, null, mac)).toBe(false);
    // wrong kind (complete vs abort)
    expect(await verifyBlobTerminal(k, scope, "abort", "tx", HASH, 100, null, mac)).toBe(false);
    // garbage / missing MAC
    expect(await verifyBlobTerminal(k, scope, "complete", "tx", HASH, 100, null, "not-base64!!")).toBe(false);
    expect(await verifyBlobTerminal(k, scope, "complete", "tx", HASH, 100, null, undefined)).toBe(false);
  });

  it("a MAC under a DIFFERENT key (or different scope) does not verify", async () => {
    const k = await deriveBlobTerminalKey(key, scope);
    const mac = await signBlobTerminal(k, scope, "complete", "tx", HASH, 100, null);
    const otherKey = await deriveBlobTerminalKey(new Uint8Array(32).fill(9), scope);
    expect(await verifyBlobTerminal(otherKey, scope, "complete", "tx", HASH, 100, null, mac)).toBe(false);
    const otherScope = { ...scope, shareRoom: "different" };
    const kOther = await deriveBlobTerminalKey(key, otherScope);
    expect(await verifyBlobTerminal(kOther, otherScope, "complete", "tx", HASH, 100, null, mac)).toBe(false);
  });

  it("syncUrl trailing-slash differences derive the SAME key (normalized scope)", async () => {
    const a = await deriveBlobTerminalKey(key, { ...scope, syncUrl: "ws://relay" });
    const macA = await signBlobTerminal(a, { ...scope, syncUrl: "ws://relay" }, "complete", "t", HASH, 1, null);
    const b = await deriveBlobTerminalKey(key, { ...scope, syncUrl: "ws://relay///" });
    expect(await verifyBlobTerminal(b, { ...scope, syncUrl: "ws://relay///" }, "complete", "t", HASH, 1, null, macA)).toBe(
      true,
    );
  });
});
