/**
 * `galley-blob-v1` wire framing (Phase 1 byte-transport epic).
 *
 * A dedicated binary channel carries content-addressed blob BYTES between the
 * browser and the MCP kernel WITHOUT bloating the Yjs CRDT update log (which has
 * no GC). The CRDT keeps only the small `BinaryAsset` pointer `{hash,size,mime}`;
 * the bytes themselves stream over this side channel and land in a `BlobStore`.
 *
 * Scope v1 = PUSH only. A publisher addresses a blob to the room; the relay
 * forwards the frames to the OTHER peers; each receiver REASSEMBLES, VERIFIES
 * (`sha256(bytes) === header.hash` AND `bytes.length === header.size`) and only
 * THEN stores. Content addressing means a peer cannot poison a hash: a corrupt
 * transfer fails the verify and is discarded whole.
 *
 * A transfer is one HEADER frame then `totalChunks` DATA frames (each chunk
 * <= {@link BLOB_CHUNK_BYTES}, well under the relay's 8 MiB ws frame cap). The
 * receiver advances the sender with ACK frames (a bounded in-flight window);
 * either side may ABORT. This module is PURE framing — encode/decode + caps +
 * the sha256 verify helper — with no socket, no relay, no store wiring.
 *
 * Defensive decode: every reader is bounds-checked against the buffer and every
 * length field is bounded BEFORE it is trusted, so a hostile/truncated frame
 * throws a structured `BlobProtocolError` rather than over-allocating or reading
 * out of bounds. Callers DROP a frame that fails to decode.
 */

import { sha256Hex } from "./binary-assets.js";
import { bytesToBase64Url, base64UrlToBytes } from "./control-mailbox.js";

// --- Caps (exported constants; the relay + both clients import these) --------

/** Max bytes in a single DATA chunk payload. 256 KiB << the relay's 8 MiB cap. */
export const BLOB_CHUNK_BYTES = 256 * 1024;

/** Hard ceiling on a whole transfer. A HEADER declaring more is rejected. */
export const BLOB_MAX_TRANSFER_BYTES = 64 * 1024 * 1024;

/** Max concurrent in-flight transfers a single connection may have open. */
export const BLOB_MAX_INFLIGHT_TRANSFERS = 8;

/**
 * Sender's in-flight ACK window: how many DATA chunks may be unacknowledged
 * before the sender pauses. Bounds sender + receiver buffering per transfer.
 */
export const BLOB_ACK_WINDOW = 4;

/** A transfer with no progress for this long is considered dead and dropped. */
export const BLOB_IDLE_TRANSFER_MS = 30_000;

/** Max bytes in the `mime` field of a HEADER (a defensive bound on decode). */
export const BLOB_MAX_MIME_BYTES = 255;

/** Max bytes in the `transferId` field (a defensive bound on decode). */
export const BLOB_MAX_TRANSFER_ID_BYTES = 64;

/** Max bytes in an ABORT `reason` string. */
export const BLOB_MAX_REASON_BYTES = 255;

/** Max bytes in a terminal-frame MAC (base64url HMAC-SHA256 ≈ 43 chars). */
export const BLOB_MAX_MAC_BYTES = 64;

// Derived: with the chunk cap, totalChunks can never exceed this — a HEADER that
// declares more is malformed (and would blow the in-flight chunk map). Computed
// from the byte cap so the two stay in lockstep.
export const BLOB_MAX_CHUNKS = Math.ceil(BLOB_MAX_TRANSFER_BYTES / BLOB_CHUNK_BYTES) + 1;

// Shared text codecs + the canonical sha256-hex shape, hoisted so the field
// validators (below) and the binary codec (further down) both use them.
const utf8 = new TextEncoder();
const utf8dec = new TextDecoder("utf-8", { fatal: false });
const HEX64 = /^[0-9a-f]{64}$/;

/** The exclusive upper bound for a u32 field (2^32). Encode rejects >= this. */
const U32_LIMIT = 0x1_0000_0000;

/**
 * Assert `v` is a valid u32 (a non-negative integer < 2^32) for `field`. The
 * Writer masks to 32 bits, so WITHOUT this an over-range value wraps silently
 * (2^32 → 0) — a framing-integrity hole. Encode calls this before writing every
 * integer field (rework §C8).
 */
function assertU32(v: number, field: string): void {
  if (!Number.isInteger(v) || v < 0 || v >= U32_LIMIT) {
    throw new BlobProtocolError(`${field} must be a u32 (0..2^32-1), got ${v}`);
  }
}

// --- Frame model -------------------------------------------------------------

export const FrameType = {
  Header: 1,
  Data: 2,
  Ack: 3,
  Abort: 4,
  /**
   * Receiver → sender TERMINAL success signal (Security/Code-Review rework §A1).
   * Emitted ONLY after the receiver has fully reassembled, passed verifyBlob
   * (size + sha256), AND stored the bytes. The sender's `done` resolves ONLY on
   * COMPLETE — never on a bare data-ACK — so success is HONEST: a resolved put
   * means the peer actually has the verified bytes.
   */
  Complete: 5,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Opens a transfer: identity + integrity contract the receiver will enforce. */
export interface HeaderFrame {
  kind: "header";
  /** Opaque per-transfer id (sender-minted; scopes DATA/ACK/ABORT). */
  transferId: string;
  /** Lowercase hex sha256 of the WHOLE blob — the integrity anchor. */
  hash: string;
  /** Declared total byte length (verified against the reassembled bytes). */
  size: number;
  /** Best-effort media type (advisory; not trusted for integrity). */
  mime: string;
  /** How many DATA frames follow. */
  totalChunks: number;
}

/** One chunk of the blob, at `index` in [0, totalChunks). */
export interface DataFrame {
  kind: "data";
  transferId: string;
  index: number;
  bytes: Uint8Array;
}

/** Receiver → sender: chunks up to and including `index` are stored. */
export interface AckFrame {
  kind: "ack";
  transferId: string;
  index: number;
}

/**
 * Either side: tear down a transfer (verify failure, cap breach, disconnect).
 * `mac` (rework rd3 §1): an optional base64url HMAC over the canonical terminal
 * bytes, authenticating that a paired peer (not a forging room member) sent it.
 */
export interface AbortFrame {
  kind: "abort";
  transferId: string;
  reason: string;
  /** Optional terminal MAC (base64url). Present iff a terminal key is configured. */
  mac?: string;
}

/**
 * Receiver → sender TERMINAL success (rework §A1). Sent only after reassembly +
 * verifyBlob + store succeed; the sender resolves `done` exclusively on this.
 * `mac` (rework rd3 §1): an optional base64url HMAC authenticating the COMPLETE so
 * a forged COMPLETE from a 3rd room peer cannot cause a false success.
 */
export interface CompleteFrame {
  kind: "complete";
  transferId: string;
  hash: string;
  size: number;
  /** Optional terminal MAC (base64url). Present iff a terminal key is configured. */
  mac?: string;
}

export type BlobFrame = HeaderFrame | DataFrame | AckFrame | AbortFrame | CompleteFrame;

/** True iff `h` is a lowercase 64-char hex sha256 (the only accepted hash form). */
export function isValidHash(h: string): boolean {
  return HEX64.test(h);
}

/** True iff `id` is a non-empty transferId within the byte cap. */
export function isValidTransferId(id: string): boolean {
  if (id.length === 0) return false;
  return utf8.encode(id).length <= BLOB_MAX_TRANSFER_ID_BYTES;
}

/** True iff `mime` is within the byte cap (advisory field; content not trusted). */
export function isValidMime(mime: string): boolean {
  return utf8.encode(mime).length <= BLOB_MAX_MIME_BYTES;
}

/** The canonical chunk count for a blob of `size` bytes (the ONLY valid value). */
export function expectedChunks(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / BLOB_CHUNK_BYTES);
}

/** A structured decode failure. The caller DROPS the offending frame. */
export class BlobProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobProtocolError";
  }
}

// --- Hand-rolled binary codec ------------------------------------------------
//
// Layout (big-endian where multi-byte):
//   byte 0: frame-type tag
//   then type-specific fields. Strings + byte payloads are length-prefixed:
//     a u8-prefixed short string (id/mime/reason, each <= 255 bytes) or a
//     u32-prefixed byte payload (chunk bytes). Integers (size, index, chunks)
//     are fixed u32 — within every cap above. No varints: fixed widths keep the
//     decoder's bounds trivial to reason about under adversarial input.

/** A tiny growable writer (avoids a length pre-pass; small frames). */
class Writer {
  private buf = new Uint8Array(64);
  private len = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }
  shortStr(s: string, max: number, field: string): void {
    const b = utf8.encode(s);
    if (b.length > max) throw new BlobProtocolError(`${field} too long (${b.length} > ${max})`);
    this.u8(b.length);
    this.bytes(b);
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** A bounds-checked reader: every read validates remaining length first. */
class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new BlobProtocolError("truncated frame");
    }
  }
  u8(): number {
    this.need(1);
    // `need` validated the byte exists; the assertion is for the type checker.
    return this.buf[this.pos++]!;
  }
  u32(): number {
    this.need(4);
    const b = this.buf;
    const p = this.pos;
    const v = (b[p]! * 0x1000000 + (b[p + 1]! << 16) + (b[p + 2]! << 8) + b[p + 3]!) >>> 0;
    this.pos += 4;
    return v;
  }
  shortStr(max: number, field: string): string {
    const n = this.u8();
    if (n > max) throw new BlobProtocolError(`${field} too long (${n} > ${max})`);
    this.need(n);
    const s = utf8dec.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  payload(max: number): Uint8Array {
    const n = this.u32();
    if (n > max) throw new BlobProtocolError(`chunk too large (${n} > ${max})`);
    this.need(n);
    // Copy out so the returned bytes don't alias the (possibly larger) frame buffer.
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  atEnd(): boolean {
    return this.pos === this.buf.length;
  }
}

/** Encode a frame to its compact binary wire form. Pure; throws on over-cap fields. */
export function encodeFrame(frame: BlobFrame): Uint8Array {
  const w = new Writer();
  switch (frame.kind) {
    case "header": {
      if (!HEX64.test(frame.hash)) throw new BlobProtocolError("header hash must be 64 lowercase hex chars");
      assertU32(frame.size, "header.size");
      if (frame.size > BLOB_MAX_TRANSFER_BYTES)
        throw new BlobProtocolError(`header.size ${frame.size} > BLOB_MAX_TRANSFER_BYTES`);
      assertU32(frame.totalChunks, "header.totalChunks");
      // The chunk count is DERIVED from size — there is exactly one valid value.
      // Rejecting any other on encode (and decode) closes the inconsistent-header
      // hole (rework §C9).
      if (frame.totalChunks !== expectedChunks(frame.size))
        throw new BlobProtocolError(
          `header.totalChunks ${frame.totalChunks} != expected ${expectedChunks(frame.size)} for size ${frame.size}`,
        );
      w.u8(FrameType.Header);
      w.shortStr(frame.transferId, BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      w.shortStr(frame.hash, 64, "hash");
      w.u32(frame.size);
      w.shortStr(frame.mime, BLOB_MAX_MIME_BYTES, "mime");
      w.u32(frame.totalChunks);
      break;
    }
    case "data": {
      assertU32(frame.index, "data.index");
      if (frame.bytes.length > BLOB_CHUNK_BYTES)
        throw new BlobProtocolError(`chunk exceeds BLOB_CHUNK_BYTES (${frame.bytes.length})`);
      w.u8(FrameType.Data);
      w.shortStr(frame.transferId, BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      w.u32(frame.index);
      w.u32(frame.bytes.length);
      w.bytes(frame.bytes);
      break;
    }
    case "ack": {
      assertU32(frame.index, "ack.index");
      w.u8(FrameType.Ack);
      w.shortStr(frame.transferId, BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      w.u32(frame.index);
      break;
    }
    case "abort": {
      w.u8(FrameType.Abort);
      w.shortStr(frame.transferId, BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      w.shortStr(frame.reason, BLOB_MAX_REASON_BYTES, "reason");
      // Optional terminal MAC: empty string = absent (rework rd3 §1).
      w.shortStr(frame.mac ?? "", BLOB_MAX_MAC_BYTES, "mac");
      break;
    }
    case "complete": {
      if (!HEX64.test(frame.hash)) throw new BlobProtocolError("complete hash must be 64 lowercase hex chars");
      assertU32(frame.size, "complete.size");
      w.u8(FrameType.Complete);
      w.shortStr(frame.transferId, BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      w.shortStr(frame.hash, 64, "hash");
      w.u32(frame.size);
      w.shortStr(frame.mac ?? "", BLOB_MAX_MAC_BYTES, "mac");
      break;
    }
    default: {
      const _exhaustive: never = frame;
      throw new BlobProtocolError(`unknown frame kind: ${String(_exhaustive)}`);
    }
  }
  return w.done();
}

/**
 * Decode a wire frame. Bounds-checked + cap-checked throughout: a truncated,
 * over-cap, or unknown-tag frame throws {@link BlobProtocolError}, and trailing
 * bytes after a complete frame are rejected (no smuggling). The caller DROPS a
 * frame that throws.
 */
export function decodeFrame(buf: Uint8Array): BlobFrame {
  const r = new Reader(buf);
  const tag = r.u8();
  let frame: BlobFrame;
  switch (tag) {
    case FrameType.Header: {
      const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      if (!isValidTransferId(transferId)) throw new BlobProtocolError("header transferId invalid");
      const hash = r.shortStr(64, "hash");
      if (!HEX64.test(hash)) throw new BlobProtocolError("header hash must be 64 lowercase hex chars");
      const size = r.u32();
      if (size > BLOB_MAX_TRANSFER_BYTES)
        throw new BlobProtocolError(`header size ${size} > BLOB_MAX_TRANSFER_BYTES`);
      const mime = r.shortStr(BLOB_MAX_MIME_BYTES, "mime");
      const totalChunks = r.u32();
      // Enforce the EXACT derived chunk count, not just the upper cap (rework
      // §C9): an inconsistent header (e.g. size=0 but totalChunks=5, or a count
      // off-by-one) is malformed and rejected.
      if (totalChunks !== expectedChunks(size))
        throw new BlobProtocolError(
          `header totalChunks ${totalChunks} != expected ${expectedChunks(size)} for size ${size}`,
        );
      frame = { kind: "header", transferId, hash, size, mime, totalChunks };
      break;
    }
    case FrameType.Data: {
      const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      const index = r.u32();
      const bytes = r.payload(BLOB_CHUNK_BYTES);
      frame = { kind: "data", transferId, index, bytes };
      break;
    }
    case FrameType.Ack: {
      const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      const index = r.u32();
      frame = { kind: "ack", transferId, index };
      break;
    }
    case FrameType.Abort: {
      const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      const reason = r.shortStr(BLOB_MAX_REASON_BYTES, "reason");
      const mac = r.shortStr(BLOB_MAX_MAC_BYTES, "mac");
      frame = mac.length > 0 ? { kind: "abort", transferId, reason, mac } : { kind: "abort", transferId, reason };
      break;
    }
    case FrameType.Complete: {
      const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
      const hash = r.shortStr(64, "hash");
      if (!HEX64.test(hash)) throw new BlobProtocolError("complete hash must be 64 lowercase hex chars");
      const size = r.u32();
      const mac = r.shortStr(BLOB_MAX_MAC_BYTES, "mac");
      frame =
        mac.length > 0
          ? { kind: "complete", transferId, hash, size, mac }
          : { kind: "complete", transferId, hash, size };
      break;
    }
    default:
      throw new BlobProtocolError(`unknown frame tag: ${tag}`);
  }
  if (!r.atEnd()) throw new BlobProtocolError("trailing bytes after frame");
  return frame;
}

/** The minimal routing view of a frame: just its type tag + transferId. */
export interface FrameRouting {
  tag: FrameTypeValue;
  transferId: string;
}

/**
 * LIGHTWEIGHT header-only parse for the RELAY hot path (rework rd3 §4): read the
 * 1-byte tag + the transferId (the FIRST field of EVERY frame), bounds-checked,
 * WITHOUT slicing the chunk payload. The relay routes on {tag, transferId} and
 * forwards the ORIGINAL bytes unchanged, so it never needs to copy a 256 KiB
 * chunk just to read 1 + ~17 bytes (the previous `decodeFrame` did, via
 * `Reader.payload`'s `.slice`). Validates the tag is known and the transferId is
 * well-formed + within its cap; THROWS {@link BlobProtocolError} on a truncated /
 * unknown-tag / over-cap-id frame (the relay drops such a frame). It does NOT
 * validate the rest of the frame body — the receiving CLIENT's full `decodeFrame`
 * is the authority on payload validity.
 */
export function peekFrameRouting(buf: Uint8Array): FrameRouting {
  const r = new Reader(buf);
  const tag = r.u8();
  if (tag !== FrameType.Header && tag !== FrameType.Data && tag !== FrameType.Ack && tag !== FrameType.Abort && tag !== FrameType.Complete) {
    throw new BlobProtocolError(`unknown frame tag: ${tag}`);
  }
  // transferId is the first field of every frame layout (u8-length-prefixed str).
  const transferId = r.shortStr(BLOB_MAX_TRANSFER_ID_BYTES, "transferId");
  if (!isValidTransferId(transferId)) throw new BlobProtocolError("invalid transferId");
  return { tag: tag as FrameTypeValue, transferId };
}

/**
 * Verify reassembled bytes against a header's integrity contract BEFORE storing.
 * Returns true iff `bytes.length === header.size` AND `sha256(bytes) ===
 * header.hash`. The length check is cheap and runs first; the hash is the
 * anti-poisoning anchor. Content addressing means a peer that flips a byte
 * cannot make this pass for the original hash.
 */
export async function verifyBlob(bytes: Uint8Array, header: HeaderFrame): Promise<boolean> {
  if (bytes.length !== header.size) return false;
  const hash = await sha256Hex(bytes);
  return hash === header.hash;
}

// ---------------------------------------------------------------------------
// Terminal-frame authentication (rework rd3 §1).
//
// THE TRUST PROBLEM: DATA is broadcast to every room peer, so the legitimate
// receiver always gets+verifies+stores the bytes — content addressing makes
// CORRUPTION impossible. But a malicious 3rd room peer can forge a COMPLETE (or
// an ABORT) and, because completion is signaled by a terminal frame, make the
// sender's putBlob resolve FALSELY (or fail). The human/CRDT layer can't see
// this. So we AUTHENTICATE the terminal frames end-to-end between the two paired
// clients, reusing the EXACT proposal-provenance HMAC/HKDF pattern: both the
// kernel and the browser hold the per-session 256-bit `responseKey` (it never
// enters any Y.Doc), derive the SAME scoped key, and only a peer holding it can
// produce a MAC the other verifies. The RELAY stays KEYLESS — auth is end-to-end.
//
// ENFORCE-WHEN-PRESENT / ADVISORY-WHEN-ABSENT: a transport with a terminal key
// resolves a push ONLY on a COMPLETE whose MAC verifies, and ignores an
// unsigned/forged COMPLETE or ABORT. A transport WITHOUT a key keeps today's
// behavior — completion is then ADVISORY and forgeable by any room peer (a
// DoS/false-success risk acceptable only on the un-paired local path).
// ---------------------------------------------------------------------------

/** The version tag for the terminal-frame signing format. */
const BLOB_TERMINAL_VERSION = "galley.blob.terminal.v1";

/** The HKDF salt domain-separating the blob-terminal key from every other key. */
const BLOB_TERMINAL_SALT = utf8.encode("galley-blob-terminal-v1");

/** The five scope fields that bind a terminal MAC to ONE grant in ONE room. */
export interface BlobTerminalScope {
  grantId: string;
  controlRoom: string;
  syncUrl: string;
  projectId: string;
  shareRoom: string;
}

/** The two terminal frame kinds that can be authenticated. */
export type BlobTerminalKind = "complete" | "abort";

/** Opaque handle to the derived WebCrypto HMAC key (DOM-lib-free alias). */
export type BlobTerminalKey = { readonly __blobTerminalKey: unique symbol };

interface TerminalSubtle {
  importKey(f: "raw", k: Uint8Array, a: string, e: boolean, u: string[]): Promise<BlobTerminalKey>;
  deriveKey(
    a: { name: string; hash: string; salt: Uint8Array; info: Uint8Array },
    base: BlobTerminalKey,
    t: { name: string; hash: string; length: number },
    e: boolean,
    u: string[],
  ): Promise<BlobTerminalKey>;
  sign(a: "HMAC", k: BlobTerminalKey, d: Uint8Array): Promise<ArrayBuffer>;
  verify(a: "HMAC", k: BlobTerminalKey, sig: Uint8Array, d: Uint8Array): Promise<boolean>;
}

function terminalSubtle(): TerminalSubtle | undefined {
  return (globalThis as unknown as { crypto?: { subtle?: TerminalSubtle } }).crypto?.subtle;
}

/** The normalized positional scope array (also the HKDF `info`). */
function terminalScopeArray(s: BlobTerminalScope): unknown[] {
  return ["scope", s.grantId, s.controlRoom, s.syncUrl.replace(/\/+$/, ""), s.projectId, s.shareRoom];
}

/**
 * The exact canonical bytes signed/verified for one terminal frame. A FIXED
 * POSITIONAL array of strings/null only (no objects, no bare numbers) — the same
 * injective-serialization discipline as proposal-provenance: positions delimit
 * fields, so no field can masquerade as another. `reason` is `null` for COMPLETE.
 */
export function blobTerminalSigningBytes(
  scope: BlobTerminalScope,
  kind: BlobTerminalKind,
  transferId: string,
  hash: string,
  size: number,
  reason: string | null,
): Uint8Array {
  if (!Number.isFinite(size)) throw new BlobProtocolError("blob-terminal: non-finite size in signed set");
  const arr = [
    BLOB_TERMINAL_VERSION,
    terminalScopeArray(scope),
    kind,
    transferId,
    hash,
    String(Math.trunc(size)),
    reason ?? null,
  ];
  return utf8.encode(JSON.stringify(arr));
}

/**
 * Derive `K_blob = HKDF-SHA-256(responseKey; salt, info=scope)` — a NON-
 * EXTRACTABLE HMAC key bound to the grant scope (a different scope → a different
 * key). FAILS CLOSED: no WebCrypto → throw (a signer must never silently emit
 * unsigned terminals).
 */
export async function deriveBlobTerminalKey(
  responseKey: Uint8Array,
  scope: BlobTerminalScope,
): Promise<BlobTerminalKey> {
  const subtle = terminalSubtle();
  if (subtle === undefined) throw new BlobProtocolError("blob-terminal: WebCrypto required to derive key");
  const base = await subtle.importKey("raw", responseKey, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: BLOB_TERMINAL_SALT, info: utf8.encode(JSON.stringify(terminalScopeArray(scope))) },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** Sign a terminal frame → base64url HMAC. Throws when crypto is unavailable. */
export async function signBlobTerminal(
  key: BlobTerminalKey,
  scope: BlobTerminalScope,
  kind: BlobTerminalKind,
  transferId: string,
  hash: string,
  size: number,
  reason: string | null,
): Promise<string> {
  const subtle = terminalSubtle();
  if (subtle === undefined) throw new BlobProtocolError("blob-terminal: WebCrypto required to sign");
  const mac = await subtle.sign("HMAC", key, blobTerminalSigningBytes(scope, kind, transferId, hash, size, reason));
  return bytesToBase64Url(new Uint8Array(mac));
}

/**
 * Authenticate a terminal-frame MAC. CONSTANT-TIME + TOTAL: returns `false` —
 * never throws, never non-bool — for a null key, a non-base64url MAC, or ANY
 * internal error. A missing/garbage MAC reads as "unauthenticated", never "ok".
 */
export async function verifyBlobTerminal(
  key: BlobTerminalKey | null,
  scope: BlobTerminalScope,
  kind: BlobTerminalKind,
  transferId: string,
  hash: string,
  size: number,
  reason: string | null,
  mac: unknown,
): Promise<boolean> {
  try {
    if (key === null) return false;
    if (typeof mac !== "string" || mac.length === 0) return false;
    const sigBytes = base64UrlToBytes(mac);
    if (sigBytes === null) return false;
    const subtle = terminalSubtle();
    if (subtle === undefined) return false;
    return await subtle.verify("HMAC", key, sigBytes, blobTerminalSigningBytes(scope, kind, transferId, hash, size, reason));
  } catch {
    return false;
  }
}

/** Concatenate ordered chunk buffers into one contiguous Uint8Array. */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Split `bytes` into HEADER + DATA frames for one push. The caller supplies the
 * pre-computed hash + mime (it already hashed to mint the `BinaryAsset`). Pure:
 * no id minting here — `transferId` is caller-supplied so it can be unguessable
 * and is shared by the matching ACK/ABORT frames.
 */
export function planTransfer(
  transferId: string,
  bytes: Uint8Array,
  hash: string,
  mime: string,
): { header: HeaderFrame; data: DataFrame[] } {
  const totalChunks = expectedChunks(bytes.length);
  const data: DataFrame[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * BLOB_CHUNK_BYTES;
    data.push({
      kind: "data",
      transferId,
      index: i,
      bytes: bytes.subarray(start, Math.min(start + BLOB_CHUNK_BYTES, bytes.length)),
    });
  }
  return {
    header: { kind: "header", transferId, hash, size: bytes.length, mime, totalChunks },
    data,
  };
}
