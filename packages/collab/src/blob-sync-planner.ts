/**
 * Blob-sync PLANNER (Phase 1 "D1" — online-only, ZERO server change).
 *
 * The relay is a blind byte relay; blob DISCOVERY rides the CRDT's awareness
 * channel. A connected peer that is MISSING the bytes for a binary pointer it
 * references publishes an additive awareness presence field — a WANT-LIST of the
 * hashes it needs. A peer that is AUTHORIZED to disclose those bytes answers by
 * pushing them over the existing `galley-blob-v1` byte channel.
 *
 * This module is the PURE decision core: no network, no timers, no apps/web
 * imports, no blob-store import. It splits cleanly into two roles so that a
 * requester's snapshot state can NEVER be reused as holder authority:
 *
 *   - {@link planBlobDemand} (REQUESTER): from the LOCAL snapshot's binary
 *     pointers, decide what to EXPECT then ADVERTISE. The peer-writable snapshot
 *     is used HERE and ONLY here — to answer "what bytes do *I* need".
 *   - {@link planBlobServe} (HOLDER): from durable SERVABLE provenance + peer
 *     want-lists + per-session serve attempts, decide what to SEND. There is NO
 *     snapshot input: authorization to disclose bytes comes exclusively from a
 *     durable, device-local grant (`servableHeld`) — never from "I reference this
 *     hash in my snapshot", which is peer-writable and was the exfiltration bug.
 *
 * All I/O — `expect()`/`send()` on the channel and `setLocalStateField` on
 * awareness — is the session layer's job (project-session.ts). Keeping the policy
 * pure lets the batch caps, the holder rule, and the requestId-amplification
 * bound be pinned directly without a socket.
 */
import { isValidHash } from "./blob-protocol.js";

/** Awareness presence field a requester publishes to advertise the blob hashes it needs. */
export const BLOB_WANTS_FIELD = "galleyBlobWants";

/**
 * Max hashes advertised in ONE want-list batch. 64 × a 64-char hex hash ≈ 4 KiB of
 * JSON — comfortably under the relay's 16 KiB awareness-state ceiling, leaving room
 * for the cursor/author presence that shares the same state object.
 */
export const BLOB_WANT_BATCH_MAX = 64;

/**
 * Max serve attempts per (clientId, hash) per holder session: initial send + one
 * retry. Module-private (kept off the frozen export surface); the session tracks
 * the same cap of 2 on its own attempt ledger.
 */
const BLOB_SERVE_ATTEMPT_MAX = 2;

/** A binary pointer from the snapshot: the content hash + its byte length. */
export interface BlobPointer {
  hash: string;
  size: number;
}

/**
 * A requester's published want-list — the value of the {@link BLOB_WANTS_FIELD}
 * awareness field. Versioned and carries a `requestId` that is REQUESTER-side
 * publication-freshness metadata ONLY: the holder IGNORES it for both
 * authorization and deduplication (rotating it buys a requester no extra work —
 * see {@link planBlobServe}).
 */
export interface BlobWantList {
  v: 1;
  requestId: string;
  hashes: string[];
}

/** An inbound peer's want-list, tagged with the peer's Yjs clientID (from awareness). */
export interface PeerBlobWant {
  clientId: number;
  wants: BlobWantList;
}

/** Structural validation of an inbound want-list (a hostile/garbled peer is ignored). */
function isWantListShape(w: unknown): w is BlobWantList {
  if (typeof w !== "object" || w === null) return false;
  const c = w as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.requestId === "string" &&
    c.requestId.length > 0 &&
    c.requestId.length <= 128 &&
    Array.isArray(c.hashes)
  );
}

/**
 * Decode a raw awareness presence field into a {@link BlobWantList}, or undefined if
 * it is absent/malformed. Only well-formed 64-hex hashes survive, capped at the
 * batch max (never trust a peer's count — the cap is anti-flood on the holder side).
 * Exported so the session decodes peers' presence through the SAME gate the planner
 * uses, and so the decode is unit-pinned.
 */
export function decodeWantList(field: unknown): BlobWantList | undefined {
  if (!isWantListShape(field)) return undefined;
  const hashes = field.hashes
    .filter((h): h is string => typeof h === "string" && isValidHash(h))
    .slice(0, BLOB_WANT_BATCH_MAX);
  return { v: 1, requestId: field.requestId, hashes };
}

/** Chunk `hashes` into batches ≤ BLOB_WANT_BATCH_MAX, each with an independent requestId. */
function batchWants(
  requestId: string,
  hashes: string[],
): { requestId: string; hashes: string[] }[] {
  const out: { requestId: string; hashes: string[] }[] = [];
  for (let i = 0; i < hashes.length; i += BLOB_WANT_BATCH_MAX) {
    const slice = hashes.slice(i, i + BLOB_WANT_BATCH_MAX);
    const id = i === 0 ? requestId : `${requestId}-${i / BLOB_WANT_BATCH_MAX}`;
    out.push({ requestId: id, hashes: slice });
  }
  return out;
}

/**
 * REQUESTER (demand) planning. The peer-writable snapshot is used HERE and ONLY
 * here: the `local` pointers (INCLUDING tombstoned ones, whose bytes are retained
 * for restore) are the requester's own "what bytes do I need" set — never a
 * holder's "what may I serve" set.
 *
 * Pure and deterministic: local pointers are deduped by hash (keeping the
 * first-seen size), the referenced-AND-missing set is the demand, and missing
 * hashes are SORTED so the expectation list and want batches are stable.
 *
 * @returns
 *  - `toExpect`: {hash,size} pairs to `expect(hash,size)` on the byte channel
 *    BEFORE advertising — the referenced-and-missing blobs. Publishing the
 *    expectation first closes the window where a peer could answer an un-expected
 *    hash (which the transport would abort pre-store anyway).
 *  - `wantBatch`: the want-list batch(es) to publish (each ≤ {@link
 *    BLOB_WANT_BATCH_MAX} hashes). Empty when nothing is missing. Batches beyond
 *    the first derive a suffixed requestId so each is independently addressable.
 */
export function planBlobDemand(input: {
  local: BlobPointer[];
  has: (hash: string) => boolean;
  requestId: string;
}): { toExpect: BlobPointer[]; wantBatch: { requestId: string; hashes: string[] }[] } {
  // Dedupe local pointers by hash (a hash may back several files/tombstones); keep
  // the first-seen size. This is the requester's referenced set + the size source.
  const sizeByHash = new Map<string, number>();
  for (const p of input.local) {
    if (isValidHash(p.hash) && !sizeByHash.has(p.hash)) sizeByHash.set(p.hash, p.size);
  }

  // Referenced-AND-missing → expect + advertise. Sorted for deterministic batches.
  const missing: BlobPointer[] = [];
  for (const [hash, size] of sizeByHash) {
    if (!input.has(hash)) missing.push({ hash, size });
  }
  missing.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

  const wantBatch =
    missing.length > 0 ? batchWants(input.requestId, missing.map((m) => m.hash)) : [];

  return { toExpect: missing, wantBatch };
}

/**
 * HOLDER (serve) planning. There is DELIBERATELY NO snapshot / `local` /
 * `referenced` input: the ONLY authorization to disclose bytes is `servableHeld` —
 * a durable, device-local SERVABLE grant (earned by a trusted local action) AND
 * the verified bytes being present. "I reference this hash in my peer-writable
 * snapshot" is NOT an authorization boundary; feeding snapshot state here is
 * exactly the pre-Accept exfiltration bug this split exists to prevent.
 *
 * A send for (clientId, hash) is emitted iff, for a structurally valid want:
 *   - `servableHeld(hash)` — durable grant AND bytes held, AND
 *   - `serveAttempts(clientId, hash) < BLOB_SERVE_ATTEMPT_MAX` — the per-session
 *     work bound (initial send + one retry), AND
 *   - it was not already planned in THIS call.
 *
 * Accounting and dedup are keyed by (clientId, hash) ONLY. `requestId` is IGNORED
 * for both authorization and deduplication: rotating it produces NO additional
 * transfer work (the requestId-amplification bound). The send tuple carries NO
 * requestId; the session reads the bytes + MIME from its own verified local store.
 *
 * Deterministic: peer wants and their decoded hashes are processed in input order.
 */
export function planBlobServe(input: {
  servableHeld: (hash: string) => boolean;
  peerWants: PeerBlobWant[];
  serveAttempts: (clientId: number, hash: string) => number;
}): { toSend: { clientId: number; hash: string }[] } {
  const toSend: { clientId: number; hash: string }[] = [];
  const planned = new Set<string>(); // (clientId, hash) keys planned this call

  for (const pw of input.peerWants) {
    const wl = decodeWantList(pw.wants); // structural gate: malformed peer → ignored wholesale
    if (wl === undefined) continue;
    for (const hash of wl.hashes) {
      if (!input.servableHeld(hash)) continue; // ONLY serve authority
      if (input.serveAttempts(pw.clientId, hash) >= BLOB_SERVE_ATTEMPT_MAX) continue; // work bound
      const key = `${pw.clientId} ${hash}`; // (clientId, hash) — requestId is NOT a key
      if (planned.has(key)) continue; // in-plan dedup
      planned.add(key);
      toSend.push({ clientId: pw.clientId, hash });
    }
  }

  return { toSend };
}
