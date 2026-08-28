/**
 * Binary asset core (roadmap #7, slice 7A) — content-addressed blob substrate.
 *
 * Binary files (images, PDFs) are identified by the **sha256 of their bytes**, not
 * by path. The bytes live OUT of the Yjs update log (which has no GC — we fought
 * CRDT bloat in waves 23.2/30): a `BlobStore` holds them beside the doc, and the
 * file tree carries only a small `BinaryAsset` pointer `{ hash, size, mime }`.
 * Content addressing gives dedup + integrity for free and keeps the text CRDT pure.
 *
 * This module is PURE substrate: hashing, mime inference, the store interface, and
 * an in-memory store for tests. No CollabProject wiring, no IndexedDB, no UI —
 * those are slices 7B/7C/7D.
 */

/** A file-tree pointer to content-addressed bytes held in a {@link BlobStore}. */
export interface BinaryAsset {
  type: "binary";
  /** Lowercase hex sha256 of the bytes — the blob's stable identity. */
  hash: string;
  /** Byte length, for display + quota accounting (derivable, cached on the pointer). */
  size: number;
  /** Best-effort media type (magic-number sniff, else extension, else octet-stream). */
  mime: string;
}

/** The hex sha256 of `bytes`. Deterministic; uses Web Crypto (browser + Node 20+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SubtleCrypto is unavailable");
  // Pass a fresh ArrayBuffer slice so a view into a larger buffer hashes only its bytes.
  const digest = await subtle.digest("SHA-256", bytes.slice());
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Extension → mime, for the cases magic numbers can't catch (e.g. svg as text). */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** True when `bytes` starts with `sig` at `offset`. */
function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/**
 * Best-effort media type. Magic-number sniff first (robust against a wrong/missing
 * extension), then the filename extension, then `application/octet-stream`. Pure.
 */
export function inferMime(bytes: Uint8Array, filename?: string): string {
  // Magic numbers for the formats Galley actually embeds.
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // GIF8
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return "image/webp"; // RIFF....WEBP
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"; // BM
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";

  // SVG is text — sniff a leading `<?xml`/`<svg` within the first bytes.
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<?xml") && head.includes("<svg")) return "image/svg+xml";
  if (head.startsWith("<svg")) return "image/svg+xml";

  const ext = filename?.split(".").pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return "application/octet-stream";
}

/** Two assets reference the same bytes iff their content hashes match. Pure. */
export function assetEquals(a: BinaryAsset, b: BinaryAsset): boolean {
  return a.hash === b.hash;
}

/**
 * A content-addressed blob store: bytes in, a {@link BinaryAsset} pointer out.
 * Identity is the hash, so `put`ting the same bytes twice stores them once (dedup).
 * Implementations: {@link InMemoryBlobStore} (tests) and an IndexedDB store (7C).
 */
export interface BlobStore {
  /** Hash + store `bytes` (idempotent: a present hash is not re-stored), return the pointer. */
  put(bytes: Uint8Array, opts?: { filename?: string; mime?: string }): Promise<BinaryAsset>;
  /** The bytes for `hash`, or undefined if absent. */
  get(hash: string): Promise<Uint8Array | undefined>;
  /** Whether `hash` is present. */
  has(hash: string): Promise<boolean>;
  /**
   * Servable-provenance GRANT: durably mark `hash` as locally provenanced for room
   * sharing (a per-hash `servable:<hash>` marker). Idempotent; validates the 64-hex
   * shape (a malformed hash is a no-op) and is INDEPENDENT of whether the bytes exist.
   * The ONLY way a marker is set — generic {@link put} stays NEUTRAL and never grants,
   * so inbound peer/agent bytes are a non-re-servable cache until a trusted local
   * action calls this. (Byte presence is the caller's separate `has`/`get` concern.)
   */
  markServable(hash: string): Promise<void>;
  /** True iff the `servable:<hash>` marker is set (byte presence is checked separately). */
  isServable(hash: string): Promise<boolean>;
}

/** An in-memory {@link BlobStore} for tests + the default non-persistent path. */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  /** Servable-provenance markers (mirrors the persistent store's `servable:` meta keys). */
  private readonly servable = new Set<string>();

  async put(bytes: Uint8Array, opts?: { filename?: string; mime?: string }): Promise<BinaryAsset> {
    const hash = await sha256Hex(bytes);
    // Dedup: store a private copy only the first time we see this content. NEUTRAL:
    // put NEVER grants a servable marker (inbound peer/agent bytes flow through here).
    if (!this.blobs.has(hash)) this.blobs.set(hash, bytes.slice());
    const mime = opts?.mime ?? inferMime(bytes, opts?.filename);
    return { type: "binary", hash, size: bytes.byteLength, mime };
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const stored = this.blobs.get(hash);
    return stored ? stored.slice() : undefined;
  }

  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }

  async markServable(hash: string): Promise<void> {
    // Validate the sha256 shape (lowercase 64-hex) — a malformed hash is a no-op so
    // a bad grant can never plant a marker. Idempotent: re-marking is harmless.
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    this.servable.add(hash);
  }

  async isServable(hash: string): Promise<boolean> {
    return this.servable.has(hash);
  }

  /** Distinct blob count (test/introspection aid; proves dedup). */
  get size(): number {
    return this.blobs.size;
  }
}
