/**
 * Proposal provenance (ADR-0023 §1) — the canonical signing serialization plus
 * the HKDF-derived per-grant key and the HMAC sign/verify pair that let the MCP
 * kernel SIGN a proposal record and the browser AUTHENTICATE it before any
 * auto-accept path applies it.
 *
 * THE TRUST PROBLEM this solves: the proposal mailbox lives in a shared room
 * whose id is a capability — any peer holding that capability can write a forged
 * record straight into the Y.Map. The browser's manual Accept gate is the human
 * defense; auto-accept removes the human, so it needs a CRYPTOGRAPHIC one. The
 * kernel and the browser each hold the per-session 256-bit `responseKey` (it
 * never enters any Y.Doc — see control-responder-mount.ts), from which both
 * derive the SAME per-grant HMAC key `K = HKDF(responseKey; scope)`. Only the
 * paired kernel can produce a signature `K` verifies; a mere room peer cannot.
 *
 * DESIGN INVARIANTS (all load-bearing):
 *   - CANONICAL serialization is a FIXED POSITIONAL JSON array of ONLY strings,
 *     nested arrays, and `null` — never an object (no key-order ambiguity) and
 *     never a bare number (numbers become canonical decimal strings, so a value
 *     and its textual form can't collide). `JSON.stringify` of that fixed shape
 *     is injective: positions delimit fields, so no in-band separator can let
 *     one field's content masquerade as another's (the delimiter-injection pin).
 *   - The SCOPE (grantId, controlRoom, syncUrl, projectId, shareRoom, mailbox)
 *     is bound TWICE: once as HKDF `info` (so a different scope derives a
 *     different key — domain separation / stale-signer defense) AND once inside
 *     the signed bytes (so a captured signature can't be replayed under a
 *     different scope even against the same key). Either binding alone refuses a
 *     cross-room/cross-grant replay; both make it defense-in-depth.
 *   - FAIL CLOSED: `verifyProposal` NEVER throws and NEVER returns a non-boolean
 *     — a null key, a non-base64url sig, or any internal error is `false`, never
 *     "ok". The publish side (`deriveProposalKey`/`signProposal`) THROWS when
 *     crypto is absent rather than emitting an unsigned record.
 *   - The derived key is NON-EXTRACTABLE: once derived it can sign/verify but its
 *     raw bytes can never be read back out of the CryptoKey.
 *
 * Framework-agnostic by design (no yjs, no React): the kernel (Node) and the web
 * app (browser) both speak this module. WebCrypto (`globalThis.crypto.subtle`)
 * is the one dependency; it exists in every supported browser and in Node 20+.
 */
import type { EditBlock } from "@galley/shared";
import type { FileProposalRecord, ProposalRecord } from "./proposal-mailbox.js";
import { bytesToBase64Url, base64UrlToBytes } from "./control-mailbox.js";

/**
 * The signing-format version tag — bumped only on a breaking serialization
 * change. v2 (A2) ADDS the binary pointer field to every op's signed view (so a
 * create-binary op's {hash,size,mime} is covered by the signature). The new
 * positional slot is present on EVERY op (null for non-binary ops), so a text-only
 * proposal's signed bytes change shape too — hence the version bump: old (v1) and
 * new (v2) signatures are unambiguously distinct and never silently interchanged.
 */
const VERSION = "galley.mcp.proposal.v2";

/**
 * The six scope fields that bind a signature to ONE grant in ONE room. Mirrors
 * the coordinates the open_project handoff and the persisted grant carry; any
 * difference in any field derives a different key AND signs different bytes.
 */
export interface ProposalScope {
  grantId: string;
  controlRoom: string;
  syncUrl: string;
  projectId: string;
  shareRoom: string;
  mailbox: "mcpProposals" | "mcpFileProposals";
}

/** A binary pointer in the signable view of a create-binary op (A2). */
export interface SignableBinaryAsset {
  hash: string;
  size: number;
  mime: string;
}

/** One file operation in the signable view of a proposal (signed positionally). */
export interface SignableOp {
  kind: "create" | "edit" | "rename" | "delete" | "create-binary";
  path: string;
  /** The rename destination, or `null` for every non-rename op (always present). */
  newPath: string | null;
  baseText: string;
  proposedText: string;
  blocks: { search: string; replace: string }[];
  /**
   * The binary pointer (A2) for a create-binary op, else `null`/absent. SIGNING it
   * binds {hash,size,mime} into the signature, so a room peer cannot swap the hash
   * on a signed create-binary record and pass the browser's auto-accept
   * verification — the swapped bytes would not be the ones the kernel signed. The
   * canonical serialization always emits a positional slot (`?? null`), so an op
   * that omits this field signs IDENTICALLY to one that sets it to null — a
   * text-only SignableOp literal stays valid and its v2 bytes are deterministic.
   */
  binaryAsset?: SignableBinaryAsset | null;
}

/**
 * The normalized, framework-free view of a proposal that gets signed. Both
 * mailbox record shapes (single-file and multi-file) map INTO this via the
 * adapters below, so one signing path covers both. `createdAt`/`seq` are part of
 * the signed set (they pin the record's identity and ordering against replay).
 */
export interface SignableProposal {
  id: string;
  createdAt: number;
  seq: number;
  request: string;
  ops: SignableOp[];
}

const utf8 = new TextEncoder();

/** Canonical encode: UTF-8 bytes of `JSON.stringify` of a strings/arrays/null value. */
function canonical(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value));
}

/**
 * A SAFE INTEGER as its canonical decimal string (`String(n)`), so a numeric
 * field can never collide with the textual form of another AND the encoding is
 * INJECTIVE. Throws on anything that is not a safe integer — a NaN/Infinity/
 * fractional/out-of-range value in the signed set is a publish-side bug that must
 * fail closed, not sign garbage. (Truncating a fractional input would let two
 * distinct numbers — e.g. 5 and 5.9 — sign identically; the read side already
 * drops fractional createdAt/seq, and binaryAsset.size is validated as a positive
 * integer, so an honest publisher always passes.)
 */
function dec(n: number): string {
  if (!Number.isSafeInteger(n)) {
    throw new Error("proposal-provenance: a signed numeric field must be a safe integer");
  }
  return String(n);
}

/**
 * The six-element positional scope array (also reused as HKDF `info`). `syncUrl`
 * is NORMALIZED here (trailing slashes stripped) so the two sides — the kernel,
 * which strips slashes to build its join URL, and the browser, which persists
 * whatever `resolveSyncUrl` returned — derive a BYTE-IDENTICAL scope without
 * having to coordinate slash handling. Every other field is an opaque token
 * passed through verbatim on both sides.
 */
function scopeArray(s: ProposalScope): unknown[] {
  return [
    "scope",
    s.grantId,
    s.controlRoom,
    s.syncUrl.replace(/\/+$/, ""),
    s.projectId,
    s.shareRoom,
    s.mailbox,
  ];
}

/** The full positional signing array — the exact ADR-0023 §1 shape. */
function proposalArray(s: ProposalScope, p: SignableProposal): unknown[] {
  return [
    VERSION,
    scopeArray(s),
    ["record", p.id, "mcp", dec(p.createdAt), dec(p.seq)],
    ["request", p.request],
    [
      "ops",
      p.ops.map((o) => [
        o.kind,
        o.path,
        o.newPath ?? null,
        o.baseText,
        o.proposedText,
        o.blocks.map((b) => [b.search, b.replace]),
        // The binary pointer (A2) — a 3-string positional array [hash, dec(size),
        // mime], or `null` for a non-binary op. `dec(size)` is the canonical
        // decimal string so the numeric size can never collide with another
        // field's text (the same rule createdAt/seq use). Present on EVERY op so
        // the positional shape is uniform and injective.
        o.binaryAsset == null
          ? null
          : [o.binaryAsset.hash, dec(o.binaryAsset.size), o.binaryAsset.mime],
      ]),
    ],
  ];
}

/** The exact bytes that get signed/verified/digested for `(scope, proposal)`. */
export function proposalSigningBytes(s: ProposalScope, p: SignableProposal): Uint8Array {
  return canonical(proposalArray(s, p));
}

/**
 * An opaque handle to a derived WebCrypto key. This package compiles lib:ES2022
 * with no DOM lib, so the global `CryptoKey` type is not in scope; we alias it to
 * an opaque structural type (the runtime value IS a WebCrypto `CryptoKey` in both
 * the browser and Node 20+). The public surface still reads as `CryptoKey` so the
 * derive→sign/verify lifecycle is type-checked.
 */
export type CryptoKey = { readonly __cryptoKey: unique symbol };

/**
 * Structural typing for `crypto.subtle` (this package compiles lib:ES2022 with
 * no DOM lib): the runtime object is WebCrypto in browsers and Node 20+ alike.
 */
interface SubtleLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: string,
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  deriveKey(
    algorithm: { name: string; hash: string; salt: Uint8Array; info: Uint8Array },
    baseKey: CryptoKey,
    derivedKeyType: { name: string; hash: string; length: number },
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKey>;
  sign(algorithm: "HMAC", key: CryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: "HMAC", key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

/** The WebCrypto subtle provider, or undefined when crypto is unavailable. */
function getSubtle(): SubtleLike | undefined {
  return (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
}

/** The salt domain-separating this KDF from any other use of the same key. */
const HKDF_SALT = utf8.encode("galley-proposal-provenance-v1");

/**
 * Derive the per-grant HMAC key `K = HKDF-SHA-256(responseKey; salt, info=scope)`.
 * The scope rides in as HKDF `info`, so a different grant/room derives a
 * DIFFERENT key (stale-signer + domain-separation defense). The result is a
 * NON-EXTRACTABLE HMAC-SHA-256 CryptoKey (sign+verify only). FAILS CLOSED: no
 * WebCrypto provider → throw (a publish side must never emit an unsigned record).
 */
export async function deriveProposalKey(
  responseKey: Uint8Array,
  scope: ProposalScope,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  if (subtle === undefined) {
    throw new Error("proposal-provenance: WebCrypto (crypto.subtle) is required to derive keys");
  }
  const base = await subtle.importKey("raw", responseKey, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: canonical(scopeArray(scope)),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign `(scope, p)` with the derived key → base64url HMAC. Throws when crypto is
 * unavailable (publish-side fail-closed — never emit an unsigned proposal).
 */
export async function signProposal(
  key: CryptoKey,
  scope: ProposalScope,
  p: SignableProposal,
): Promise<string> {
  const subtle = getSubtle();
  if (subtle === undefined) {
    throw new Error("proposal-provenance: WebCrypto (crypto.subtle) is required to sign proposals");
  }
  const mac = await subtle.sign("HMAC", key, proposalSigningBytes(scope, p));
  return bytesToBase64Url(new Uint8Array(mac));
}

/**
 * Authenticate `sig` over `(scope, p)` with the derived key. CONSTANT-TIME (via
 * `subtle.verify`) and TOTAL: returns `false` — never throws, never a non-bool —
 * for a null key, a sig that is not a non-empty base64url string, or ANY internal
 * error. This is the auto-accept gate's authenticity check; a downgrade (missing
 * or garbage signature) MUST read as "unauthenticated", never as "ok".
 */
export async function verifyProposal(
  key: CryptoKey | null,
  scope: ProposalScope,
  p: SignableProposal,
  sig: unknown,
): Promise<boolean> {
  try {
    if (key === null) return false;
    if (typeof sig !== "string" || sig.length === 0) return false;
    const sigBytes = base64UrlToBytes(sig);
    if (sigBytes === null) return false;
    const subtle = getSubtle();
    if (subtle === undefined) return false;
    return await subtle.verify("HMAC", key, sigBytes, proposalSigningBytes(scope, p));
  } catch {
    return false;
  }
}

/**
 * The base64url SHA-256 of the signing bytes — a stable, KEYLESS digest of
 * `(scope, p)`. This is the AUDIT key: the tombstone store keys replay protection
 * on it without ever needing the secret, and identical proposals digest
 * identically (so a re-published applied proposal is recognized as a replay).
 * Throws only if crypto is unavailable.
 */
export async function proposalSignedDigest(
  scope: ProposalScope,
  p: SignableProposal,
): Promise<string> {
  const subtle = getSubtle();
  if (subtle === undefined) {
    throw new Error("proposal-provenance: WebCrypto (crypto.subtle) is required to digest");
  }
  const hash = await subtle.digest("SHA-256", proposalSigningBytes(scope, p));
  return bytesToBase64Url(new Uint8Array(hash));
}

// ---------------------------------------------------------------------------
// Adapters: map the two mailbox record shapes into the one SignableProposal.
//
// `seq` is taken as an EXPLICIT argument for now — it is currently an internal
// mailbox field that `getProposals`/`getFileProposals` strip on read. Task 2
// promotes `seq` onto the public read record; until then the caller (the signer
// on publish, the verifier in a test) passes the seq it knows.
// ---------------------------------------------------------------------------

/** The minimum a single-file record needs to be signed (id/createdAt/request/blocks). */
type SingleSignableSource = Pick<
  ProposalRecord,
  "id" | "createdAt" | "request" | "filePath" | "baseText" | "proposedText"
> & { blocks: EditBlock[] };

/**
 * Single-file proposal → one synthetic `kind:"edit"` op carrying `filePath` as
 * `path`. The single-file mailbox has exactly one target file, so the signed op
 * list is always length 1.
 */
export function singleToSignable(rec: SingleSignableSource, seq: number): SignableProposal {
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    seq,
    request: rec.request,
    ops: [
      {
        kind: "edit",
        path: rec.filePath,
        newPath: null,
        baseText: rec.baseText,
        proposedText: rec.proposedText,
        blocks: rec.blocks.map((b) => ({ search: b.search, replace: b.replace })),
        // The single-file mailbox never carries a binary op — always null.
        binaryAsset: null,
      },
    ],
  };
}

/** The minimum a multi-file record needs to be signed (id/createdAt/request/ops). */
type FileSignableSource = Pick<FileProposalRecord, "id" | "createdAt" | "request" | "ops">;

/**
 * Multi-file proposal → its ops mapped 1:1, with `newPath` normalized to `null`
 * for every non-rename op so the signed shape is uniform.
 */
export function fileToSignable(rec: FileSignableSource, seq: number): SignableProposal {
  return {
    id: rec.id,
    createdAt: rec.createdAt,
    seq,
    request: rec.request,
    ops: rec.ops.map((o) => ({
      kind: o.kind,
      path: o.path,
      newPath: o.newPath ?? null,
      baseText: o.baseText,
      proposedText: o.proposedText,
      blocks: o.blocks.map((b) => ({ search: b.search, replace: b.replace })),
      // The binary pointer (A2) for a create-binary op, else null — so the signed
      // bytes COVER {hash,size,mime} and a peer cannot swap them post-signature.
      binaryAsset:
        o.kind === "create-binary" && o.binaryAsset !== undefined
          ? { hash: o.binaryAsset.hash, size: o.binaryAsset.size, mime: o.binaryAsset.mime }
          : null,
    })),
  };
}
