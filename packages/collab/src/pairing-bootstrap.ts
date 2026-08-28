/**
 * Pairing bootstrap (B2, ADR-0026 — v2 with FORWARD SECRECY) — the PURE crypto
 * core of the durable kernel pairing handshake. Replaces the baked
 * `--control-room`/`--response-key` launch args (the long-lived secret in argv)
 * with a short-lived, one-time pairing CODE that NEVER appears in any mailbox
 * message.
 *
 * THE PROBLEM: the operator used to paste a command carrying the 32-byte
 * `responseKey` verbatim in argv (shell history / process listings / logs). B2
 * pastes only a 16-byte pairing CODE; the kernel runs a handshake to OBTAIN the
 * room + responseKey without the secret ever in argv.
 *
 * THE CRYPTO (this module):
 *   1. From the code — and ONLY the code — BOTH sides derive (HKDF-SHA-256,
 *      domain-separated `info` labels) WITHOUT transmitting it: a pairing ROOM id
 *      `pair-<hex>`, a bootstrap MAC key, and a code SECRET. The room id is a
 *      PUBLIC one-way derivative; macKey ≠ codeSecret by construction.
 *   2. EACH side mints an EPHEMERAL ECDH (P-256) keypair. The kernel's claim is
 *      `{ ephPub, nonce, claimMac = HMAC(macKey, tag ‖ ephPub ‖ nonce ‖ requestId) }`
 *      — PROOF it knows the code (the code-derived MAC AUTHENTICATES the ephemeral
 *      public key + the nonce + the request id), NOT the code. The browser
 *      verifies it CONSTANT-TIME BEFORE consuming the code, then replies with its
 *      OWN ephemeral pub (also MAC-authenticated) + the sealed payload.
 *   3. The AEAD seal key = HKDF( ECDH(myEph, theirEph) ‖ codeSecret ; salt=nonce,
 *      info=seal-v2 ) — derived from BOTH the ephemeral ECDH shared secret AND the
 *      code secret. The ephemeral PRIVATE keys are DISCARDED after the handshake.
 *
 * FORWARD SECRECY (the v2 property): even an attacker who RECORDS the whole
 * pairing-room transcript (both ephemeral PUBLIC keys + the sealed envelope) AND
 * LATER LEAKS the code (⇒ codeSecret) still cannot recover the responseKey — it
 * lacks an ephemeral PRIVATE key, so it cannot recompute the ECDH shared secret,
 * so it cannot derive the seal key. (Without ECDH, a code-only seal key meant a
 * recorded transcript + a later code leak decrypted the responseKey; v2 closes
 * that.) The responseKey is ENCRYPTED in transit, never signed-plaintext.
 *
 * DESIGN INVARIANTS (load-bearing; the security review pins these):
 *   - The code is the sole PASTED secret; the room id is a PUBLIC HKDF derivative.
 *   - macKey ≠ codeSecret (different `info`); the seal key needs an ephemeral
 *     private key, never recoverable from the transcript.
 *   - The claimMac binds the ephemeral pubkey + nonce + requestId, so a peer
 *     without the code can neither forge a claim nor swap the ephemeral key, and a
 *     captured claim replayed under a DIFFERENT request id fails the MAC.
 *   - FAIL CLOSED: verify/open NEVER throw and NEVER return a non-result; the
 *     mint/derive/seal sides THROW when crypto is absent.
 *   - Framework-agnostic (no yjs, React, DOM lib): WebCrypto (subtle ECDH/HKDF/
 *     HMAC/AES-GCM + getRandomValues), present in every supported browser and
 *     Node 20+, so the kernel (Node) and the web app run byte-identical crypto.
 */
import { bytesToBase64Url, base64UrlToBytes } from "./control-mailbox.js";

/** 16-byte (128-bit) one-time pairing code → ~22-char base64url. */
export const PAIRING_CODE_BYTES = 16;

/** 32-byte (256-bit) CSPRNG claim nonce — the handshake's anti-replay challenge + KDF salt. */
export const PAIRING_NONCE_BYTES = 32;

/** AES-256-GCM IV: 96-bit (12-byte), the GCM-recommended nonce size. */
const SEAL_IV_BYTES = 12;

/** Raw P-256 ECDH public key length (uncompressed `0x04 ‖ X ‖ Y`): 65 bytes. */
export const PAIRING_EPH_PUBLIC_BYTES = 65;

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

/**
 * Structural typing for `crypto.subtle` (this package compiles lib:ES2022 with no
 * DOM lib): the runtime object is WebCrypto in browsers and Node 20+ alike.
 */
interface SubtleLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: string | { name: string; hash?: string; namedCurve?: string },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  exportKey(format: "raw", key: unknown): Promise<ArrayBuffer>;
  generateKey(
    algorithm: { name: "ECDH"; namedCurve: "P-256" },
    extractable: boolean,
    usages: string[],
  ): Promise<{ publicKey: unknown; privateKey: unknown }>;
  deriveBits(
    algorithm:
      | { name: "HKDF"; hash: string; salt: Uint8Array; info: Uint8Array }
      | { name: "ECDH"; public: unknown },
    baseKey: unknown,
    length: number,
  ): Promise<ArrayBuffer>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  encrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
}

interface CryptoLike {
  subtle?: SubtleLike;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function getCrypto(): CryptoLike | undefined {
  return (globalThis as unknown as { crypto?: CryptoLike }).crypto;
}

function getSubtle(): SubtleLike | undefined {
  return getCrypto()?.subtle;
}

function requireSubtle(what: string): SubtleLike {
  const subtle = getSubtle();
  if (subtle === undefined) {
    throw new Error(`pairing-bootstrap: WebCrypto (crypto.subtle) is required to ${what}`);
  }
  return subtle;
}

/**
 * CSPRNG bytes, FAIL-CLOSED (no `Math.random` fallback — like `mintShareRoom`):
 * no secure source → throw rather than mint guessable material.
 */
function randomBytes(n: number): Uint8Array {
  const c = getCrypto();
  if (c === undefined || typeof c.getRandomValues !== "function") {
    throw new Error("pairing-bootstrap: a secure random source (crypto.getRandomValues) is required");
  }
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * Mint a fresh, one-time pairing code: {@link PAIRING_CODE_BYTES} CSPRNG bytes →
 * base64url (no padding). FAIL-CLOSED. The code is the ONLY secret the operator
 * pastes; it never enters any Y.Doc.
 */
export function mintPairingCode(): string {
  return bytesToBase64Url(randomBytes(PAIRING_CODE_BYTES));
}

/** The bootstrap values derived from one pairing code (the ephemeral keys are separate). */
export interface PairingBootstrap {
  /**
   * The unguessable pairing room id (a PUBLIC, one-way HKDF derivative). Minted in
   * the `share-` capability namespace so the relay's capability gate + the
   * absent-Origin carve-out apply unchanged under `GALLEY_SYNC_AUTH=required` (the
   * cookie-less kernel can join it once the browser registers it). It is a
   * transient bootstrap channel only — torn down on code-consume / 10-min TTL.
   */
  pairingRoom: string;
  /** The 32-byte bootstrap MAC key (authenticates the claim + the ephemeral pubkeys). */
  macKey: Uint8Array;
  /**
   * The 32-byte code SECRET mixed into the seal-key KDF alongside the ephemeral
   * ECDH shared secret — so a wrong code derives a wrong seal key EVEN with a valid
   * ECDH, and the seal key is NOT recoverable from the code alone (FS).
   */
  codeSecret: Uint8Array;
}

/** The plaintext the browser seals and the kernel opens. */
export interface PairingPayload {
  syncUrl: string;
  controlRoom: string;
  /** base64url of the 32-byte response-auth key (encrypted in transit, never plain). */
  responseKey: string;
}

/** The AAD bound into the seal — the nonce, the request id (the mailbox key), the room. */
export interface PairingSealAad {
  /** base64url of the kernel's claim nonce. */
  nonce: string;
  /** The handshake's mailbox request id (binds the seal to ONE request — #2 anti-replay). */
  requestId: string;
  /** The derived pairing room id the handshake runs in. */
  pairingRoom: string;
}

/** What a claim MAC binds: the direction + the sender's ephemeral pubkey + nonce + request id. */
export interface ClaimContext {
  /**
   * Which side authored this claim — domain-separates the two handshake legs under
   * the SAME macKey so a kernel claim can never be reflected as a browser claim (or
   * vice-versa). `"kernel"` is the kernel's opening claim, `"browser"` the reply.
   */
  direction: "kernel" | "browser";
  /** The raw (65-byte) P-256 ephemeral public key being authenticated. */
  ephPublicRaw: Uint8Array;
  /** The 32-byte handshake nonce. */
  nonce: Uint8Array;
  /** The mailbox request id (binds the claim to ONE request — defeats id-replay DoS). */
  requestId: string;
}

/** The sealed envelope: a fresh IV + the AES-GCM ciphertext (incl. tag), both base64url. */
export interface SealedPairingPayload {
  /** base64url of the 12-byte AES-GCM IV (fresh per seal). */
  iv: string;
  /** base64url of the ciphertext with the appended GCM tag. */
  ct: string;
}

/** An ephemeral ECDH keypair — the private key is OPAQUE (non-extractable) + discarded. */
export interface EphemeralKeyPair {
  publicKey: unknown;
  privateKey: unknown;
}

/** The HKDF salt domain-separating this bootstrap KDF from every other HKDF use. */
const HKDF_SALT = utf8.encode("galley-pairing-bootstrap-v1");

/** Domain-separated HKDF `info` labels for the code-derived outputs. */
const INFO_ROOM = utf8.encode("galley-pairing/room/v1");
const INFO_MAC = utf8.encode("galley-pairing/mac-key/v1");
const INFO_CODE_SECRET = utf8.encode("galley-pairing/code-secret/v2");

/** The HKDF `info` for the final seal key (ECDH ‖ codeSecret → key). */
const INFO_SEAL = utf8.encode("galley-pairing/seal-key/v2");

/**
 * Decode the pairing code to its raw bytes, or throw. ENFORCES the exact code
 * length ({@link PAIRING_CODE_BYTES}) — the 128-bit-code invariant is load-bearing
 * (a short code is brute-forceable), so a wrong-length code fails loud.
 */
function codeBytes(code: string): Uint8Array {
  const bytes = base64UrlToBytes(code);
  if (bytes === null || bytes.length !== PAIRING_CODE_BYTES) {
    throw new Error(
      `pairing-bootstrap: the pairing code must be base64url of exactly ${PAIRING_CODE_BYTES} bytes`,
    );
  }
  return bytes;
}

/** HKDF-SHA-256 expand of `ikm` under `HKDF_SALT` + `info` to `bytes` octets. */
async function hkdfFromCode(ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const subtle = requireSubtle("derive keys");
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const out = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info },
    base,
    bytes * 8,
  );
  return new Uint8Array(out);
}

/**
 * Derive the bootstrap values from the pairing code. DETERMINISTIC: the same code
 * yields the same room + macKey + codeSecret, so the kernel and browser agree with
 * no other coordination. The room id is `pair-<hex>` of a 16-byte HKDF output.
 */
export async function deriveBootstrap(code: string): Promise<PairingBootstrap> {
  const ikm = codeBytes(code);
  const [roomBytes, macKey, codeSecret] = await Promise.all([
    hkdfFromCode(ikm, INFO_ROOM, 16),
    hkdfFromCode(ikm, INFO_MAC, 32),
    hkdfFromCode(ikm, INFO_CODE_SECRET, 32),
  ]);
  const hex = Array.from(roomBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  // `share-` namespace (not a bespoke `pair-`) so the relay's capability gate +
  // absent-Origin carve-out + registration path apply unchanged (ADR-0026 #3).
  return { pairingRoom: `share-${hex}`, macKey, codeSecret };
}

/**
 * Mint a fresh EPHEMERAL P-256 ECDH keypair. The private key is NON-EXTRACTABLE
 * (it can derive bits but never be read out) and DISCARDED after one handshake —
 * the basis of forward secrecy. THROWS when crypto is absent.
 */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const subtle = requireSubtle("generate an ephemeral key");
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Export a keypair's PUBLIC key to its raw 65-byte form (the wire representation). */
export async function exportEphemeralPublic(pair: EphemeralKeyPair): Promise<Uint8Array> {
  const subtle = requireSubtle("export an ephemeral public key");
  return new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
}

/** Import a raw 65-byte P-256 public key for ECDH, or throw on a malformed input. */
async function importPeerPublic(subtle: SubtleLike, raw: Uint8Array): Promise<unknown> {
  if (raw.length !== PAIRING_EPH_PUBLIC_BYTES) {
    throw new Error("pairing-bootstrap: an ephemeral public key must be 65 raw bytes (P-256)");
  }
  return subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/**
 * Derive the AEAD seal key = HKDF( ECDH(myPriv, peerPub) ‖ codeSecret ; salt=nonce,
 * info=seal-v2 ). Mixing the ephemeral ECDH shared secret AND the code secret means
 * the key needs BOTH the code (authentication) AND an ephemeral private key (forward
 * secrecy). THROWS on absent crypto or a malformed peer key.
 */
export async function deriveSealKey(
  myPrivateKey: unknown,
  peerPublicRaw: Uint8Array,
  codeSecret: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== PAIRING_NONCE_BYTES) {
    throw new Error(`pairing-bootstrap: the handshake nonce must be exactly ${PAIRING_NONCE_BYTES} bytes`);
  }
  const subtle = requireSubtle("derive the seal key");
  const peer = await importPeerPublic(subtle, peerPublicRaw);
  // ECDH → 32-byte (P-256) shared secret (X coordinate).
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: peer }, myPrivateKey, 256));
  // IKM = sharedSecret ‖ codeSecret; salt = nonce; one HKDF expand to a 32-byte key.
  const ikm = new Uint8Array(shared.length + codeSecret.length);
  ikm.set(shared, 0);
  ikm.set(codeSecret, shared.length);
  const base = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const out = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce, info: INFO_SEAL },
    base,
    256,
  );
  return new Uint8Array(out);
}

/** The exact bytes a claim MAC covers — a domain tag (incl. direction) + eph pubkey + nonce + requestId. */
function claimBytes(ctx: ClaimContext): Uint8Array {
  // Canonical, injective: a fixed tag carrying the DIRECTION (so the two legs are
  // domain-separated under one macKey — no reflection), then length-prefixed
  // positional fields so no field can bleed into another.
  const tag = utf8.encode(`galley-pairing/claim/v2/${ctx.direction}`);
  const rid = utf8.encode(ctx.requestId);
  const lenBytes = (n: number): Uint8Array =>
    new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const parts = [
    lenBytes(tag.length),
    tag,
    lenBytes(ctx.ephPublicRaw.length),
    ctx.ephPublicRaw,
    lenBytes(ctx.nonce.length),
    ctx.nonce,
    lenBytes(rid.length),
    rid,
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Compute a claim MAC = HMAC-SHA-256(macKey, claimBytes(ctx)) → base64url. PROOF
 * the sender holds the code (it derived macKey) that AUTHENTICATES its ephemeral
 * public key + the nonce + the request id — without revealing the code. THROWS on
 * a wrong-length nonce or absent crypto (never emit an unauthenticated claim).
 */
export async function computeClaimMac(macKey: Uint8Array, ctx: ClaimContext): Promise<string> {
  if (ctx.nonce.length !== PAIRING_NONCE_BYTES) {
    throw new Error(`pairing-bootstrap: a claim nonce must be exactly ${PAIRING_NONCE_BYTES} bytes`);
  }
  if (ctx.ephPublicRaw.length !== PAIRING_EPH_PUBLIC_BYTES) {
    throw new Error("pairing-bootstrap: a claim ephemeral public key must be 65 raw bytes");
  }
  const subtle = requireSubtle("compute a claim");
  const key = await subtle.importKey("raw", macKey, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle.sign("HMAC", key, claimBytes(ctx));
  return bytesToBase64Url(new Uint8Array(mac));
}

/**
 * Verify a claim MAC over `ctx` (CONSTANT-TIME recompute + length-safe compare).
 * TOTAL + FAIL-CLOSED: a null/garbage/non-base64url `offered`, a wrong key, a
 * wrong nonce/ephPub/requestId, or a wrong-length nonce/pubkey all read `false`;
 * NEVER throws. The verifier MUST pass this BEFORE consuming the one-time code.
 */
export async function verifyClaimMac(
  macKey: Uint8Array,
  ctx: ClaimContext,
  offered: string,
): Promise<boolean> {
  try {
    if (ctx.nonce.length !== PAIRING_NONCE_BYTES) return false;
    if (ctx.ephPublicRaw.length !== PAIRING_EPH_PUBLIC_BYTES) return false;
    if (typeof offered !== "string" || offered.length === 0) return false;
    const offeredBytes = base64UrlToBytes(offered);
    if (offeredBytes === null) return false;
    const subtle = getSubtle();
    if (subtle === undefined) return false;
    const key = await subtle.importKey("raw", macKey, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const expected = new Uint8Array(await subtle.sign("HMAC", key, claimBytes(ctx)));
    return timingSafeEqualBytes(offeredBytes, expected);
  } catch {
    return false;
  }
}

/**
 * Length-checked constant-time byte compare. Different lengths short-circuit to
 * false (length is not secret); equal lengths XOR-accumulate so the timing does
 * not depend on WHERE the first difference is.
 */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Build the canonical AAD bytes from the seal AAD (positional, injective). */
function aadBytes(aad: PairingSealAad): Uint8Array {
  return utf8.encode(
    JSON.stringify(["galley-pairing/seal/v2", aad.nonce, aad.requestId, aad.pairingRoom]),
  );
}

/**
 * SEAL the payload under the (ECDH-derived) seal key with AES-256-GCM, binding the
 * AAD (nonce / request id / pairing room) into the tag. A FRESH 96-bit IV per call.
 * The responseKey is ENCRYPTED, not signed. THROWS when crypto is absent.
 */
export async function sealPairingPayload(
  sealKey: Uint8Array,
  payload: PairingPayload,
  aad: PairingSealAad,
): Promise<SealedPairingPayload> {
  const subtle = requireSubtle("seal the payload");
  const iv = randomBytes(SEAL_IV_BYTES);
  const key = await subtle.importKey("raw", sealKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = utf8.encode(
    JSON.stringify([payload.syncUrl, payload.controlRoom, payload.responseKey]),
  );
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadBytes(aad) }, key, plaintext);
  return { iv: bytesToBase64Url(iv), ct: bytesToBase64Url(new Uint8Array(ct)) };
}

/**
 * OPEN a sealed payload under the (ECDH-derived) seal key, verifying the AAD.
 * TOTAL + FAIL-CLOSED: a wrong key, a tampered IV/ciphertext/AAD, a malformed
 * envelope, or a shape that does not validate all read `null`; NEVER throws. The
 * kernel then shape-validates the result (responseKey decodes to 32 bytes, etc.).
 */
export async function openPairingPayload(
  sealKey: Uint8Array,
  sealed: SealedPairingPayload,
  aad: PairingSealAad,
): Promise<PairingPayload | null> {
  try {
    if (typeof sealed !== "object" || sealed === null) return null;
    const iv = base64UrlToBytes(sealed.iv);
    const ct = base64UrlToBytes(sealed.ct);
    if (iv === null || ct === null || iv.length !== SEAL_IV_BYTES || ct.length === 0) return null;
    const subtle = getSubtle();
    if (subtle === undefined) return null;
    const key = await subtle.importKey("raw", sealKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const ptBuf = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadBytes(aad) }, key, ct);
    const parsed: unknown = JSON.parse(utf8Decode.decode(new Uint8Array(ptBuf)));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [syncUrl, controlRoom, responseKey] = parsed as unknown[];
    if (
      typeof syncUrl !== "string" ||
      typeof controlRoom !== "string" ||
      typeof responseKey !== "string"
    ) {
      return null;
    }
    return { syncUrl, controlRoom, responseKey };
  } catch {
    return null;
  }
}
