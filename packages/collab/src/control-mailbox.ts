/**
 * The Agent Access control mailbox (roadmap #16.3a, ADR-0021) — a bounded
 * request/response RPC protocol over a shared Yjs doc, between the local MCP
 * kernel (the REQUESTER) and the user's browser (the RESPONDER and sole
 * authority). The kernel ASKS; the browser DECIDES — nothing in this module
 * grants any capability beyond writing bounded records into the control room's
 * replicated doc.
 *
 * Layout: two top-level `Y.Map`s on the control room's doc, both keyed by the
 * CSPRNG request id:
 *
 *   - `mcpControlRequests`:  id → { id, op, params, createdAt, seq }
 *   - `mcpControlResponses`: id → { id, ok, result | error, respondedAt }
 *
 * Records are PLAIN JSON values, not nested `Y.Map`s like the proposal
 * mailbox's: control records are IMMUTABLE once written (nothing flips a field
 * in place the way a proposal's `status` does), so field-level merge buys
 * nothing — the only mutations are whole-key deletes (withdrawal + pruning),
 * which plain values handle exactly as well.
 *
 * Security posture (the 16.1/16.2 mailbox posture, ADR-0021):
 *   - {@link CONTROL_LIMITS} enforced TWICE — at publish time (throws, so an
 *     honest peer never writes an oversized record) and at read time (skipped,
 *     so a hostile room peer forging records straight into the Y.Maps can
 *     neither freeze readers nor smuggle attacker-sized payloads through).
 *   - Malformed/forged records are SKIPPED, never thrown on.
 *   - Request ids are CSPRNG-minted (fail-closed, like `mintShareRoom`): the
 *     id is the correlation token, so it must never be guessable in advance or
 *     collide.
 *   - ANSWER-ONCE for honest peers: a second `publishControlResponse` for an
 *     already-answered id is ignored (returns false) unless the caller passes
 *     `overwrite: true` — the RESPONDER's anti-squatting privilege (below).
 *   - RESPONSE AUTHENTICATION (#1 slice 1 security round, finding HIGH-1): a
 *     response may carry an optional `sig` — HMAC-SHA-256 over
 *     {@link controlResponseSigningString} (the request id + the canonical-JSON
 *     payload) keyed by a per-session 256-bit RESPONSE KEY that travels ONLY in
 *     the out-of-band pairing command, NEVER through any Y.Doc. The kernel's
 *     `awaitControlResponse` takes an `accept` predicate and settles ONLY on a
 *     response that passes it (the kernel verifies the HMAC with a timing-safe
 *     comparison): a same-room attacker can no longer FORGE a response —
 *     winning the write race buys an entry the kernel ignores. The browser
 *     responder publishes with `overwrite: true`, so a forged squatter response
 *     cannot block the authentic, signed one from landing. KEY↔ID BINDING
 *     (HIGH-2): a response record is readable under map key K only when its
 *     own `id` equals K (`getControlResponse`), and the kernel additionally
 *     recomputes the HMAC over the id it is AWAITING — so a validly signed
 *     response for request A replayed verbatim under request B's key is
 *     rejected at BOTH layers. The requester still schema-validates every
 *     accepted body downstream (the kernel does, op by op). Honest residual is
 *     AVAILABILITY only: a peer holding the room capability can still
 *     flood/withdraw/overwrite-after-settle (DoS), but can no longer make the
 *     kernel ACT on data the browser did not sign for that exact request.
 *   - The pending-request cap is PER PROCESS (it counts only ids THIS process
 *     minted and has not withdrawn): an honest runaway requester self-bounds,
 *     while a hostile peer flooding forged requests can never lock the kernel
 *     out of publishing.
 *
 * Garbage collection — the doc must not grow without bound, so cleanup is
 * layered AND enforced opportunistically from BOTH sides (Security round 2,
 * finding 1; every layer pinned by test):
 *   1. The REQUESTER withdraws its own request+response pair once the RPC
 *      settles (success OR timeout) via {@link withdrawControlRequest}. A
 *      timed-out request is withdrawn too — best-effort revocation so a late
 *      responder is less likely to act on an RPC the requester abandoned (not
 *      a guarantee; the responder may already hold it).
 *   2. BOTH SIDES run the same hard bounds policy ({@link pruneControlMailbox}):
 *      the requester on every PUBLISH and every WITHDRAWAL (so each RPC tick
 *      re-bounds the mailbox even when no responder exists at all), the
 *      responder on every WAKE (even when it answered nothing — a
 *      malformed-only flood must not survive a drain pass). The policy deletes:
 *        - malformed/over-limit/mis-keyed raw entries in either map,
 *        - ORPHANED responses (no surviving request — withdrawn or forged),
 *        - EXPIRED unanswered requests (older than
 *          `CONTROL_LIMITS.maxRecordAgeMs` — a stale ask nobody is awaiting),
 *        - the OLDEST answered pairs beyond `CONTROL_LIMITS.maxAnsweredKept`
 *          (the keep-window lets a slow requester observe its answer; honest
 *          requesters self-withdraw long before it fills), and
 *        - the OLDEST records beyond the HARD TOTAL caps
 *          (`maxTotalRequests` / `maxTotalResponses`) — so even a flood of
 *          well-formed, in-cap, unanswered records stays bounded.
 *      The ONE protection rule: a live well-formed pending request THIS
 *      process minted — and the response correlated to it — is never dropped
 *      (itself bounded by `maxPendingRequests`).
 *
 * Honest residual: Yjs map deletes leave TOMBSTONES, so a determined flooder
 * still costs memory at the CRDT level even while the VISIBLE mailbox stays
 * within the caps above. The real flood boundary is the relay's room — the
 * control room is an unguessable, revocable, session-scoped capability and
 * every holder is local-agent-equivalent (ADR-0021); this policy bounds what
 * an honest peer ever surfaces, materializes, or acts on.
 *
 * Framework-agnostic (yjs only) and transport-agnostic: the kernel (Node) and
 * the browser speak this module over any provider that replicates the doc.
 */
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import { authorOrigin } from "./collab-document.js";
import type { DocHost } from "./collab-connection.js";

const REQUESTS_KEY = "mcpControlRequests";
const RESPONSES_KEY = "mcpControlResponses";

/**
 * Shared size/count limits for control records (the PROPOSAL_LIMITS spirit).
 * Enforced on both sides of the trust boundary: publish throws, read skips.
 */
export const CONTROL_LIMITS = {
  /** Max UTF-8 bytes of one serialized request envelope (`{op, params}`). */
  maxRequestBytes: 16 * 1024,
  /** Max UTF-8 bytes of one serialized success `result` value. */
  maxResponseBytes: 256 * 1024,
  /** Max characters of an `op` name (also charset-bound, see OP_RE). */
  maxOpChars: 64,
  /** Accepted id length band — CSPRNG ids are 32+ chars; forged shorties are skipped. */
  minIdChars: 8,
  maxIdChars: 128,
  /** Max characters of a failure response's `error` message. */
  maxErrorChars: 500,
  /** Max characters of a response `sig` (base64url HMAC-SHA-256 is 43; headroom only). */
  maxSigChars: 100,
  /** Max UNANSWERED requests one PROCESS may have outstanding (self-bounding). */
  maxPendingRequests: 32,
  /** Max well-formed pending requests one `readControlRequests` call surfaces. */
  maxReadRequests: 64,
  /** Answered request/response pairs the responder's prune keeps (oldest collected first). */
  maxAnsweredKept: 32,
  /**
   * HARD total caps on what either map may hold after a bounds pass — the
   * flood backstop (Security round 2, finding 1): beyond these, the OLDEST
   * records are dropped even when individually well-formed and unanswered
   * (locally minted pending requests excepted). Sized so an honest workload
   * never gets near them: one requester holds <= maxPendingRequests pending
   * + maxAnsweredKept answered pairs.
   */
  maxTotalRequests: 128,
  maxTotalResponses: 64,
  /**
   * TTL for UNANSWERED requests (ms): an ask this old has no live awaiter
   * (the RPC timeout is seconds; settled requests are withdrawn), so a bounds
   * pass drops it. Locally minted pending requests are exempt.
   */
  maxRecordAgeMs: 10 * 60 * 1000,
} as const;

/** `op` names are lowercase snake_case identifiers — nothing else validates. */
const OP_RE = /^[a-z][a-z0-9_]*$/;

/**
 * The control-id CHARSET + length band: base64url characters (`[A-Za-z0-9_-]`),
 * bounded by `CONTROL_LIMITS.minIdChars`/`maxIdChars`. Enforced on BOTH publish and
 * read for request AND response ids. The minted ids (`randomUUID()` — hex + `-` —
 * or 32 hex chars) and the B2 handshake's `randomUUID()` id all fall inside this
 * charset, while a forged id carrying exotic bytes is rejected. Pairs with the
 * record-swap guard (`id === mapKey`) so a request id is BOTH well-formed AND bound
 * to the slot it was published under — the basis of the B2 claim-MAC's id binding.
 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Whether `id` is a well-formed control id (charset + length). Shared publish/read. */
function isValidControlId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= CONTROL_LIMITS.minIdChars &&
    id.length <= CONTROL_LIMITS.maxIdChars &&
    ID_RE.test(id)
  );
}

const utf8 = new TextEncoder();

/** Request params: a plain JSON object (size-validated as serialized bytes). */
export type ControlParams = Record<string, unknown>;

export interface ControlRequestInput {
  op: string;
  params: ControlParams;
}

/** A flattened, validated request record as read from the mailbox. */
export interface ControlRequest extends ControlRequestInput {
  id: string;
  /** Publisher wall-clock ms — for deterministic oldest-first listing. */
  createdAt: number;
}

/**
 * What a responder publishes (respondedAt is minted here). `sig` is the
 * OPTIONAL response authentication tag (HIGH-1): HMAC-SHA-256, base64url, over
 * {@link controlResponseSigningString} keyed by the out-of-band response key.
 * Absent-sig responses remain valid records (back-compat: per-project mode and
 * pre-key envelopes) — whether a sig is REQUIRED is the requester's policy
 * (the control-mode kernel requires it via its `accept` predicate).
 */
export type ControlResponseInput =
  | { id: string; ok: true; result: unknown; sig?: string }
  | { id: string; ok: false; error: string; sig?: string };

/** A flattened, validated response record as read from the mailbox. */
export type ControlResponse =
  | { id: string; ok: true; result: unknown; respondedAt: number; sig?: string }
  | { id: string; ok: false; error: string; respondedAt: number; sig?: string };

function requests(host: DocHost): Y.Map<unknown> {
  return host.doc.getMap<unknown>(REQUESTS_KEY);
}

function responses(host: DocHost): Y.Map<unknown> {
  return host.doc.getMap<unknown>(RESPONSES_KEY);
}

/**
 * UTF-8 bytes of `value`'s JSON serialization, or null when it cannot be
 * serialized (cycles, BigInt, …) — the one sizing rule both enforcement
 * points share. Cost is linear in the value's size: bounded by what was
 * already replicated, the same read-cost posture as the proposal mailbox.
 */
function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return null; // undefined / non-JSON roots
    return utf8.encode(text).length;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Yjs shared types (Y.Map etc.) are objects too — only data crosses here.
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The first limit a request violates, or null when within bounds. Pure and
 * shared by BOTH enforcement points (publish + read) so they can never drift.
 */
export function controlRequestViolation(input: ControlRequestInput): string | null {
  if (typeof input.op !== "string" || input.op.length === 0) return "op must be a non-empty string";
  if (input.op.length > CONTROL_LIMITS.maxOpChars) {
    return `op exceeds ${CONTROL_LIMITS.maxOpChars} characters`;
  }
  if (!OP_RE.test(input.op)) return "op must be a lowercase snake_case identifier";
  if (!isPlainObject(input.params)) return "params must be a plain JSON object";
  const bytes = jsonByteLength({ op: input.op, params: input.params });
  if (bytes === null) return "params are not JSON-serializable";
  if (bytes > CONTROL_LIMITS.maxRequestBytes) {
    return `request exceeds ${CONTROL_LIMITS.maxRequestBytes} bytes`;
  }
  return null;
}

/**
 * The first limit a response violates, or null when within bounds. Shared by
 * publish (throws) and read (skips).
 */
export function controlResponseViolation(input: ControlResponseInput): string | null {
  if (typeof input.id !== "string") return "id must be a string";
  if (!isValidControlId(input.id)) {
    return `id must be ${CONTROL_LIMITS.minIdChars}–${CONTROL_LIMITS.maxIdChars} base64url characters`;
  }
  if (input.sig !== undefined) {
    if (typeof input.sig !== "string" || input.sig.length === 0) {
      return "sig, when present, must be a non-empty string";
    }
    if (input.sig.length > CONTROL_LIMITS.maxSigChars) {
      return `sig exceeds ${CONTROL_LIMITS.maxSigChars} characters`;
    }
  }
  if (input.ok === true) {
    const bytes = jsonByteLength(input.result);
    if (bytes === null) return "result is not JSON-serializable";
    if (bytes > CONTROL_LIMITS.maxResponseBytes) {
      return `result exceeds ${CONTROL_LIMITS.maxResponseBytes} bytes`;
    }
    return null;
  }
  if (input.ok !== false) return "ok must be a boolean";
  if (typeof input.error !== "string" || input.error.length === 0) {
    return "error must be a non-empty string";
  }
  if (input.error.length > CONTROL_LIMITS.maxErrorChars) {
    return `error exceeds ${CONTROL_LIMITS.maxErrorChars} characters`;
  }
  return null;
}

/** CSPRNG request id. Fails closed — a guessable correlation token is worse than none. */
function mintControlId(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (a: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("control-mailbox: a secure random source (crypto) is required to mint ids");
}

/** Same-millisecond tie-break for publishes from THIS process (cross-peer ties fall to id). */
let seq = 0;

/**
 * Ids THIS process minted and has not yet withdrawn — the basis of the
 * per-process pending cap (a hostile peer's forged requests never count
 * against the local requester). Keyed by doc so independent sessions in one
 * process don't share a budget.
 */
const localPending = new WeakMap<Y.Doc, Set<string>>();

function localPendingSet(host: DocHost): Set<string> {
  let set = localPending.get(host.doc);
  if (set === undefined) {
    set = new Set();
    localPending.set(host.doc, set);
  }
  return set;
}

/**
 * Publish a control request into the shared mailbox as one author-tagged
 * transaction and return the request id (the correlation token). Throws on an
 * over-limit input ({@link CONTROL_LIMITS}) and when THIS process already has
 * `maxPendingRequests` unanswered requests outstanding (the per-process
 * self-bound; settle or withdraw them first).
 *
 * `id` is OPTIONAL: callers normally let the mailbox mint a CSPRNG id (the
 * default). The B2 pairing handshake (ADR-0026) supplies its OWN CSPRNG id so it
 * can BIND that id into the claim MAC + AEAD AAD *before* publishing — closing an
 * id-replay DoS where a pairing-room peer copies a captured claim onto a second
 * mailbox id. A supplied id is length/charset-validated like any other; a
 * collision with an existing request id is rejected (the id is a fresh CSPRNG
 * token, so an honest collision is astronomically unlikely).
 */
export function publishControlRequest(
  host: DocHost,
  input: ControlRequestInput,
  author: Author,
  id?: string,
): string {
  const violation = controlRequestViolation(input);
  if (violation !== null) throw new Error(`publishControlRequest: ${violation}`);

  // Refresh the local tally first: ids already answered or no longer present
  // (withdrawn elsewhere, pruned by a responder) free their budget slot.
  const pending = localPendingSet(host);
  for (const id of pending) {
    if (!requests(host).has(id) || getControlResponse(host, id) !== undefined) pending.delete(id);
  }
  if (pending.size >= CONTROL_LIMITS.maxPendingRequests) {
    throw new Error(
      `publishControlRequest: this process already has ${CONTROL_LIMITS.maxPendingRequests} ` +
        "unanswered requests outstanding — settle or withdraw them first",
    );
  }

  let finalId: string;
  if (id === undefined) {
    finalId = mintControlId();
  } else {
    if (!isValidControlId(id)) {
      throw new Error(
        `publishControlRequest: a supplied id must be ${CONTROL_LIMITS.minIdChars}–${CONTROL_LIMITS.maxIdChars} base64url characters`,
      );
    }
    if (requests(host).has(id)) {
      throw new Error("publishControlRequest: the supplied request id already exists");
    }
    finalId = id;
  }
  // The map KEY is set to the id, so the record-swap guard (id === mapKey) holds for
  // every honestly published request — including the kernel's own B2 claim.
  host.doc.transact(() => {
    requests(host).set(finalId, {
      id: finalId,
      op: input.op,
      // Serialization round-trip: what readers see is exactly what was sized.
      params: JSON.parse(JSON.stringify(input.params)) as ControlParams,
      createdAt: Date.now(),
      seq: seq++,
    });
  }, authorOrigin(author));
  pending.add(finalId);
  // Requester-side bounds tick (Security round 2, finding 1): every publish
  // re-bounds the mailbox, so a hostile flood is collected even when no
  // responder exists. The just-published request is locally pending — exempt.
  pruneControlMailbox(host, author);
  return finalId;
}

/**
 * Flatten + validate one raw request entry. Undefined for anything malformed
 * OR over the shared limits — the mailbox lives in an open room, so a hostile
 * peer can forge garbage straight into the Y.Map; readers skip, never throw.
 */
function readRequestRecord(entry: unknown): (ControlRequest & { seq: number }) | undefined {
  if (!isPlainObject(entry)) return undefined;
  const { id, op, params } = entry;
  // Charset + length: a forged id carrying exotic bytes is skipped (mirrors the
  // publish-side check). The record-swap guard (id === mapKey) is applied by the
  // CALLERS that hold the key (readControlRequests / getControlRequest).
  if (!isValidControlId(id)) return undefined;
  if (typeof op !== "string" || !isPlainObject(params)) return undefined;
  if (controlRequestViolation({ op, params }) !== null) return undefined;
  const createdAt = entry["createdAt"];
  const seqVal = entry["seq"];
  return {
    id,
    op,
    params,
    createdAt: typeof createdAt === "number" ? createdAt : 0,
    seq: typeof seqVal === "number" ? seqVal : 0,
  };
}

/** Flatten + validate one raw response entry (same skip-never-throw posture).
 * A record carrying an ILL-TYPED/over-cap `sig` is invalid as a whole (skipped):
 * stricter is safer — the kernel keeps waiting and the responder's overwrite
 * privilege replaces the garbage. */
function readResponseRecord(entry: unknown): ControlResponse | undefined {
  if (!isPlainObject(entry)) return undefined;
  const { id, ok } = entry;
  if (typeof id !== "string" || typeof ok !== "boolean") return undefined;
  const respondedAtRaw = entry["respondedAt"];
  const respondedAt = typeof respondedAtRaw === "number" ? respondedAtRaw : 0;
  const sigRaw = entry["sig"];
  const sigField = sigRaw === undefined ? {} : { sig: sigRaw as string };
  if (ok) {
    const candidate: ControlResponseInput = { id, ok: true, result: entry["result"], ...sigField };
    if (controlResponseViolation(candidate) !== null) return undefined;
    return { ...candidate, respondedAt };
  }
  const error = entry["error"];
  if (typeof error !== "string") return undefined;
  const candidate: ControlResponseInput = { id, ok: false, error, ...sigField };
  if (controlResponseViolation(candidate) !== null) return undefined;
  return { ...candidate, respondedAt };
}

const cmpRecords = (
  a: { createdAt: number; seq: number; id: string },
  b: { createdAt: number; seq: number; id: string },
): number =>
  a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The well-formed, UNANSWERED requests, oldest first, capped at
 * `CONTROL_LIMITS.maxReadRequests` — the responder's work list. Already
 * answered requests are excluded (the answer-once contract: answering is what
 * retires a request from this list), so a responder that answers everything it
 * reads drains any backlog in bounded passes.
 *
 * `includeAnswered: true` (HIGH-1, the AUTHORITATIVE responder's read mode)
 * also surfaces requests that already carry a response: a hostile peer could
 * otherwise SQUAT a forged response onto a fresh request and silence the real
 * responder forever. The responder pairs this with its own local answered-id
 * set (skip what IT answered) and `overwrite: true` publishing, so a squatted
 * request still receives the authentic, signed answer exactly once.
 */
export function readControlRequests(
  host: DocHost,
  opts: { includeAnswered?: boolean } = {},
): ControlRequest[] {
  const out: (ControlRequest & { seq: number })[] = [];
  // Iterate ENTRIES (key + value), not values: a hostile peer can write a record
  // whose body `id` ≠ its Y.Map KEY. RECORD-SWAP GUARD (mirrors getControlResponse
  // + the proposal mailbox's readRecord): drop any record whose self-asserted `id`
  // disagrees with the slot it lives in, so the id a responder acts on is the
  // AUTHENTIC map key — never a spoofed body id. This is what makes the B2 pairing
  // claim's id binding sound: the kernel publishes under map-key = its CSPRNG id, so
  // a replay copied under a DIFFERENT key surfaces with the key's id, and the
  // claim-MAC (which covers the kernel's id) then fails to verify.
  for (const [key, entry] of requests(host).entries()) {
    const rec = readRequestRecord(entry);
    if (rec === undefined) continue;
    if (rec.id !== key) continue; // body-id-spoofed record — never surfaced
    if (opts.includeAnswered !== true && getControlResponse(host, rec.id) !== undefined) continue;
    out.push(rec);
  }
  out.sort(cmpRecords);
  return out.slice(0, CONTROL_LIMITS.maxReadRequests).map(({ seq: _seq, ...rec }) => rec);
}

/**
 * One request by id, or undefined if absent/malformed/mis-keyed (for responder
 * lookups). The record-swap guard (`rec.id === id`) holds here too: the lookup key
 * IS the id, so a record stored under a different key with this body id is simply
 * absent at `.get(id)`, and one stored under THIS key with a different body id is
 * rejected by the `rec.id !== id` check.
 */
export function getControlRequest(host: DocHost, id: string): ControlRequest | undefined {
  const rec = readRequestRecord(requests(host).get(id));
  if (rec === undefined || rec.id !== id) return undefined;
  const { seq: _seq, ...request } = rec;
  return request;
}

/**
 * Publish a response for `input.id` as one author-tagged transaction.
 * ANSWER-ONCE by default: when a well-formed response for that id already
 * exists this is a no-op returning false — a second verdict never overwrites
 * the first (an honest double-answer is a bug upstream; this pins it
 * harmless). `overwrite: true` is the RESPONDER's anti-squatting privilege
 * (HIGH-1): the authoritative browser responder REPLACES whatever record sits
 * at the id — a hostile peer that raced a forged response into the slot can
 * therefore never block the authentic, signed answer (the requester's `accept`
 * predicate ignores the forgery either way). Throws on an over-limit input so
 * oversized records never enter the CRDT.
 */
export function publishControlResponse(
  host: DocHost,
  input: ControlResponseInput,
  author: Author,
  opts: { overwrite?: boolean } = {},
): boolean {
  const violation = controlResponseViolation(input);
  if (violation !== null) throw new Error(`publishControlResponse: ${violation}`);
  if (opts.overwrite !== true && getControlResponse(host, input.id) !== undefined) return false;
  host.doc.transact(() => {
    responses(host).set(input.id, {
      ...(input.ok
        ? // Serialization round-trip: what readers see is exactly what was
          // sized (the violation check above guarantees serializability).
          { id: input.id, ok: true, result: JSON.parse(JSON.stringify(input.result)) as unknown }
        : { id: input.id, ok: false, error: input.error }),
      ...(input.sig !== undefined ? { sig: input.sig } : {}),
      respondedAt: Date.now(),
    });
  }, authorOrigin(author));
  return true;
}

/**
 * The well-formed response for `id`, or undefined (absent/malformed/oversized
 * — or MIS-KEYED). KEY↔ID BINDING (HIGH-2, cross-request replay): a record is
 * valid under map key K only when its own `id` field EQUALS K. Without this, a
 * peer could copy a validly SIGNED response for request A verbatim under key B
 * and replay A's stale verdict into B (the signature still verifies — it
 * covers A's id, which the record self-asserts). Enforced here, on the ONE
 * read path every consumer shares: `awaitControlResponse`, the answered-set
 * exclusion in `readControlRequests`, and the publish answer-once check all go
 * through this function. (`pruneControlMailbox` already collects mis-keyed
 * records; this closes the read-side window before any prune runs.)
 */
export function getControlResponse(host: DocHost, id: string): ControlResponse | undefined {
  const record = readResponseRecord(responses(host).get(id));
  if (record === undefined || record.id !== id) return undefined;
  return record;
}

/**
 * Invoke `cb` whenever the REQUESTS map changes (a request arriving or being
 * withdrawn) — the responder's wake-up. Returns an unsubscribe. Shallow
 * `observe` suffices: records are plain values, so every change is a key event.
 */
export function observeControlRequests(host: DocHost, cb: () => void): () => void {
  const map = requests(host);
  const handler = (): void => cb();
  map.observe(handler);
  return () => map.unobserve(handler);
}

/**
 * Resolve with the FIRST well-formed response for `id` that passes `accept`
 * (default: accept anything well-formed), or reject after `timeoutMs` with a
 * structured one-line message — fail-closed when no ACCEPTABLE response
 * arrives; the CALLER decides whether/when to retry (no retry storms here).
 *
 * `accept` is the requester's AUTHENTICATION hook (HIGH-1): the control-mode
 * kernel passes an HMAC verifier, so a forged/unsigned response is silently
 * IGNORED — the wait continues, and the authoritative responder's
 * `overwrite: true` publish can still land the authentic one. Once settled,
 * later overwrites are irrelevant. The caller should withdraw the request
 * after settling either way (see {@link withdrawControlRequest}).
 */
export function awaitControlResponse(
  host: DocHost,
  id: string,
  opts: { timeoutMs: number; accept?: (response: ControlResponse) => boolean },
): Promise<ControlResponse> {
  const accept = opts.accept ?? ((): boolean => true);
  const existing = getControlResponse(host, id);
  if (existing !== undefined && accept(existing)) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const map = responses(host);
    const onChange = (): void => {
      const response = getControlResponse(host, id);
      if (response === undefined) return;
      if (!accept(response)) return; // forged/unsigned — keep waiting (HIGH-1)
      cleanup();
      resolve(response);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`control request ${id} received no acceptable response within ${opts.timeoutMs}ms`),
      );
    }, opts.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      map.unobserve(onChange);
    };
    map.observe(onChange);
  });
}

/**
 * Delete `id`'s request AND response (requester self-GC, layer 1): call once
 * the RPC settles — after a success/failure response, and after a TIMEOUT too
 * (best-effort revocation of an abandoned ask). Idempotent and forgiving by
 * design — withdrawal is cleanup, so an unknown/already-pruned id is a no-op,
 * never a throw (unlike `resolveProposal`, where an unknown id is a caller
 * bug).
 */
export function withdrawControlRequest(host: DocHost, id: string, author: Author): void {
  host.doc.transact(() => {
    requests(host).delete(id);
    responses(host).delete(id);
  }, authorOrigin(author));
  localPendingSet(host).delete(id);
  // Requester-side bounds tick (the settle path; see publishControlRequest).
  pruneControlMailbox(host, author);
}

/**
 * The shared hard-bounds policy (layer 2) — run by BOTH sides: the requester
 * on every publish and withdrawal, the responder on every wake (the fake
 * responder / browser contract calls it from its drain loop, answered or not).
 * Deletes, as one author-tagged transaction:
 *   - malformed/over-limit RAW entries in either map (forged garbage holds no
 *     tenure: it is skipped by readers AND collected here, mis-keyed records
 *     included),
 *   - ORPHANED responses (no surviving request — the requester withdrew, or a
 *     peer forged a response to a request that never existed),
 *   - EXPIRED unanswered requests (older than `CONTROL_LIMITS.maxRecordAgeMs`
 *     — no live awaiter exists at that age; settled requests are withdrawn
 *     within seconds),
 *   - the OLDEST answered request/response pairs beyond
 *     `CONTROL_LIMITS.maxAnsweredKept` (the keep-window lets a slow requester
 *     still observe its answer; honest requesters self-withdraw first, so this
 *     only mops up after crashed ones), and
 *   - the OLDEST surviving records beyond the HARD totals
 *     (`CONTROL_LIMITS.maxTotalRequests` / `maxTotalResponses`) — the flood
 *     backstop: even individually well-formed, fresh, unanswered records
 *     cannot grow the visible mailbox past the caps.
 * The ONE protection rule: requests THIS process minted and still has pending
 * (and the responses correlated to them) are never dropped — that set is
 * itself bounded by `maxPendingRequests`. Returns the number of map entries
 * deleted (0 without a transaction when the mailbox is already within
 * bounds, so observer-driven callers cannot ping-pong).
 */
export function pruneControlMailbox(
  host: DocHost,
  author: Author,
  now: number = Date.now(),
): number {
  const reqMap = requests(host);
  const respMap = responses(host);
  const local = localPendingSet(host);

  const dropRequests = new Set<string>();
  const dropResponses = new Set<string>();

  // 1. Malformed / mis-keyed raw entries in either map.
  const valid = new Map<string, ControlRequest & { seq: number }>();
  reqMap.forEach((entry, key) => {
    const rec = readRequestRecord(entry);
    // A record stored under a key other than its own id is forged — collect it.
    if (rec === undefined || rec.id !== key) dropRequests.add(key);
    else valid.set(key, rec);
  });
  const answeredIds = new Set<string>();
  respMap.forEach((entry, key) => {
    const rec = readResponseRecord(entry);
    if (rec === undefined || rec.id !== key) {
      dropResponses.add(key);
      return;
    }
    if (!valid.has(key)) {
      dropResponses.add(key); // orphan: no surviving request to correlate with
      return;
    }
    answeredIds.add(key);
  });

  // 2. Expired UNANSWERED requests (stale asks; locally pending ones exempt).
  for (const rec of valid.values()) {
    if (answeredIds.has(rec.id) || local.has(rec.id)) continue;
    if (now - rec.createdAt > CONTROL_LIMITS.maxRecordAgeMs) dropRequests.add(rec.id);
  }

  // 3. Answered pairs beyond the keep-window (oldest first; local exempt).
  const answered = [...answeredIds]
    .map((id) => valid.get(id)!)
    .filter((rec) => !local.has(rec.id))
    .sort(cmpRecords);
  const excess = answered.length - CONTROL_LIMITS.maxAnsweredKept;
  for (let i = 0; i < excess; i++) {
    const { id } = answered[i]!;
    dropRequests.add(id);
    dropResponses.add(id);
  }

  // 4. Hard totals over what SURVIVES the layers above (oldest dropped first,
  //    local exempt; a dropped request takes its response along so the maps
  //    never hold a half-pair this pass created).
  const survivingRequests = [...valid.values()]
    .filter((rec) => !dropRequests.has(rec.id))
    .sort(cmpRecords);
  let requestsOver = survivingRequests.length - CONTROL_LIMITS.maxTotalRequests;
  for (const rec of survivingRequests) {
    if (requestsOver <= 0) break;
    if (local.has(rec.id)) continue;
    dropRequests.add(rec.id);
    dropResponses.add(rec.id);
    requestsOver--;
  }
  const survivingResponses = [...answeredIds]
    .filter((id) => !dropResponses.has(id))
    .map((id) => valid.get(id)!)
    .sort(cmpRecords);
  let responsesOver = survivingResponses.length - CONTROL_LIMITS.maxTotalResponses;
  for (const rec of survivingResponses) {
    if (responsesOver <= 0) break;
    if (local.has(rec.id)) continue;
    dropResponses.add(rec.id);
    dropRequests.add(rec.id);
    responsesOver--;
  }

  if (dropRequests.size === 0 && dropResponses.size === 0) return 0;
  let deleted = 0;
  host.doc.transact(() => {
    for (const key of dropRequests) {
      if (!reqMap.has(key)) continue;
      reqMap.delete(key);
      deleted++;
    }
    for (const key of dropResponses) {
      if (!respMap.has(key)) continue;
      respMap.delete(key);
      deleted++;
    }
  }, authorOrigin(author));
  return deleted;
}

// ---------------------------------------------------------------------------
// Response authentication (HIGH-1) — the shared signing contract both sides
// implement: the browser responder SIGNS, the control-mode kernel VERIFIES.
// The key itself never appears in this module's data paths: it is minted by
// the browser at enable(), travels ONLY inside the out-of-band pairing
// command, and is handed to these helpers as raw bytes by each side.
// ---------------------------------------------------------------------------

/** Exact byte length of a control response key (256-bit HMAC-SHA-256 key). */
export const CONTROL_RESPONSE_KEY_BYTES = 32;

/**
 * Deterministic, key-order-independent JSON for signing: object keys sorted
 * recursively, arrays in order, primitives as JSON.stringify renders them.
 * The value is round-tripped through JSON first so the SIGNER (who holds the
 * pre-publish value, possibly with `undefined` fields) and the VERIFIER (who
 * reads the round-tripped record out of the doc) serialize the SAME thing.
 */
function canonicalJson(value: unknown): string {
  const plain: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value));
  const render = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map((x) => render(x === undefined ? null : x)).join(",")}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${render(obj[k])}`).join(",")}}`;
  };
  return render(plain);
}

/**
 * The EXACT string a response signature covers: the request id (so a signed
 * response can never be replayed onto a different request) + the canonical
 * JSON of the verdict payload. `sig` itself and `respondedAt` (a responder-
 * local timestamp the verifier never acts on) are deliberately EXCLUDED so
 * the signer can sign its input before publish and the verifier can recompute
 * from the read record, byte-for-byte.
 */
export function controlResponseSigningString(
  response: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string },
): string {
  const payload = response.ok
    ? { ok: true, result: response.result }
    : { ok: false, error: response.error };
  return `${response.id}\n${canonicalJson(payload)}`;
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Raw bytes → base64url (no padding). Pure — no Buffer/btoa dependency. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64URL_ALPHABET[b0 >> 2]!;
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64URL_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

/** base64url (no padding) → raw bytes, or null on any invalid input (fail-closed). */
export function base64UrlToBytes(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0 || text.length % 4 === 1) return null;
  const values: number[] = [];
  for (const ch of text) {
    const v = B64URL_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    values.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 4) {
    const v0 = values[i]!;
    const v1 = values[i + 1];
    const v2 = values[i + 2];
    const v3 = values[i + 3];
    if (v1 === undefined) return null;
    out.push((v0 << 2) | (v1 >> 4));
    if (v2 !== undefined) out.push(((v1 & 0x0f) << 4) | (v2 >> 2));
    if (v3 !== undefined) out.push(((v2! & 0x03) << 6) | v3);
  }
  return new Uint8Array(out);
}

/**
 * HMAC-SHA-256 over `text` with `key`, base64url-encoded — via WebCrypto
 * (`globalThis.crypto.subtle`), available in every supported browser AND in
 * Node ≥ 16, so the browser signer, the kernel's tests, and any reference
 * responder share ONE implementation. FAILS CLOSED: a missing crypto provider
 * throws rather than "signing" with nothing.
 */
export async function hmacControlResponse(key: Uint8Array, text: string): Promise<string> {
  // Structural typing (this package compiles lib:ES2022, no DOM): the runtime
  // object is WebCrypto's `crypto.subtle` in browsers and Node ≥ 16 alike.
  interface SubtleLike {
    importKey(
      format: "raw",
      keyData: Uint8Array,
      algorithm: { name: string; hash: string },
      extractable: boolean,
      usages: string[],
    ): Promise<unknown>;
    sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  }
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("control-mailbox: WebCrypto (crypto.subtle) is required to sign responses");
  }
  if (key.length !== CONTROL_RESPONSE_KEY_BYTES) {
    throw new Error(
      `control-mailbox: a response key must be exactly ${CONTROL_RESPONSE_KEY_BYTES} bytes`,
    );
  }
  const cryptoKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle.sign("HMAC", cryptoKey, utf8.encode(text));
  return bytesToBase64Url(new Uint8Array(mac));
}
