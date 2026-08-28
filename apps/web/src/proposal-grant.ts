/**
 * The PERSISTED, MAC'd AGENT GRANT (ADR-0023 §4) — the localStorage record that
 * re-binds an already-consented `open_project` share after a reload, plus the
 * grant-scoped coordinates the proposal verifier signs against.
 *
 * Why a MAC at all: the grant rides in localStorage (the same sensitive store
 * the response-auth key already lives in). An XSS or same-origin script can read
 * it — that is conceded (threat model) — but a passive tamper of the persisted
 * blob (a hand-edited `shareRoom`, a flipped `mode`, a forged grant
 * pointing at an attacker's room) must NOT be honored on the next boot. So the
 * grant is HMAC-SHA-256'd with the per-session `responseKey` (the same secret
 * that derives the proposal keys, re-derivable on resume because the mount
 * already persists it). On load we recompute the MAC and reject the grant unless
 * it matches: a grant the attacker cannot re-sign without the key never re-binds
 * (fail closed — a bad MAC reads as "no grant", never as "trusted").
 *
 * DESIGN INVARIANTS (mirroring proposal-provenance.ts):
 *   - CANONICAL serialization is a FIXED POSITIONAL JSON array of ONLY strings —
 *     never an object (no key-order ambiguity), never a bare number/boolean (the
 *     boolean becomes "0"/"1", `grantedAt` a canonical decimal string), so two
 *     distinct grants can never canonicalize to the same bytes.
 *   - The MAC NEVER covers itself: `serializeGrant` stores `{...grant, mac}` but
 *     `macGrant` hashes only the grant fields, so the persisted blob and the MAC
 *     input stay independent.
 *   - FAIL CLOSED: `parseGrant` returns null for an absent/unparseable/wrong-shape
 *     blob OR a recomputed-MAC mismatch — it never throws and never returns a
 *     grant it could not authenticate.
 *
 * Framework-agnostic and yjs-free: WebCrypto (`crypto.subtle` HMAC) is the one
 * dependency, present in every supported browser and Node 20+. The base64url
 * helper is reused from `@galley/collab` so the encoding matches the rest of the
 * provenance surface byte-for-byte.
 */
import { bytesToBase64Url } from "@galley/collab";

/**
 * One consented `open_project` grant. The first six fields are the exact
 * coordinates a proposal signature binds to (they reconstruct a `ProposalScope`
 * per mailbox); `mode` is the per-grant acceptance disposition (re-MAC'd when
 * toggled) and `grantedAt` pins when consent was given.
 *
 * `mode` is the SOLE MCP authority for auto-apply (ADR-0025 §7): `"auto"` means
 * a verified, audited, undoable auto-apply is permitted for this grant; `"ask"`
 * (the default for a fresh grant) holds every record for a human Accept. It is
 * part of the MAC'd payload, so it cannot be hand-edited in storage to widen
 * trust — a tampered `mode` fails the MAC check and the whole grant is rejected.
 */
export interface ProposalGrant {
  controlRoom: string;
  projectId: string;
  shareRoom: string;
  syncUrl: string;
  mainFile: string;
  grantId: string;
  mode: "ask" | "auto";
  grantedAt: number;
  /**
   * F13 (tab-closed access): when true, this is a STANDING, revocable capability
   * the human granted once that authorises a HEADLESS re-attach (the in-tab agent
   * host applying the agent's proposals while the project is not the active editor
   * document) — not just a reload re-bind of the foreground tab. Default-OFF and
   * opt-in per project; absent/false ⇒ today's tab-bound behaviour.
   *
   * MAC-COVERED (see {@link grantArray}): the slot is appended to the canonical
   * signing array ONLY when true, so an absent/false grant MACs byte-identically to
   * a pre-F13 (and legacy) blob — existing grants still re-bind — while a tampered
   * blob that FLIPS this flip changes the array length and fails the MAC (the whole
   * grant is rejected, fail closed). It is therefore a standing WRITE capability an
   * attacker cannot forge without `responseKey`; an idle TTL
   * ({@link HEADLESS_ACCESS_IDLE_TTL_MS}) degrades a forgotten grant to manual.
   */
  persistentAccess?: boolean;
}

/**
 * The canonical reuse SCOPE (ADR-0024 §3): the live coordinates an `open_project`
 * reuse must match a persisted grant against before it re-attaches an already-
 * consented share WITHOUT a fresh consent modal. These are exactly the fields the
 * LIVE session can re-derive independently of the grant blob — the current
 * responder control room, the resolved relay URL, the request's projectId, the
 * room the grant points at (re-attached, never minted), and the project's current
 * main file. Every field is load-bearing: a drift in ANY of them means the
 * authorization context changed and reuse MUST fall through to full consent (fail
 * closed). `grantId` is NOT here — it is the grant's own opaque identity (the
 * kernel only sends a projectId), carried forward on a hit, never re-derived.
 */
export interface GrantReuseScope {
  controlRoom: string;
  syncUrl: string;
  projectId: string;
  shareRoom: string;
  mainFile: string;
}

/**
 * Whether a persisted grant may be REUSED for a live `open_project` (ADR-0024 §3):
 * its canonical scope must equal the live scope EXACTLY — `controlRoom`, `syncUrl`,
 * `projectId`, `shareRoom`, AND `mainFile` all byte-for-byte identical. A mismatch
 * in ANY field (a moved relay, a renamed main file, a different room, a foreign
 * project) returns false so the caller falls through to full consent. Pure + total
 * — no crypto, no I/O; the MAC authenticity of `grant` is the CALLER's
 * responsibility (it comes from {@link parseGrant} on resume or this session's own
 * {@link recordGrant}), this only compares already-trusted coordinates.
 */
export function grantMatchesReuseScope(g: ProposalGrant, live: GrantReuseScope): boolean {
  return (
    g.controlRoom === live.controlRoom &&
    g.syncUrl === live.syncUrl &&
    g.projectId === live.projectId &&
    g.shareRoom === live.shareRoom &&
    g.mainFile === live.mainFile
  );
}

/**
 * The acceptance `mode` a NEWLY recorded grant should default to (H1 — broken
 * authority scoping). A fresh grant defaults to `"ask"`; it inherits the prior
 * grant's `mode` (e.g. Auto across a re-share) ONLY when the prior grant is for
 * the EXACT SAME full reuse scope as the grant being recorded — i.e. this is a
 * continuation of the very same grant, not a newly consented DIFFERENT project.
 *
 * Without this gate a grant minted for project B would copy project A's Auto as
 * its MAC'd default (privilege carry-over): Auto from one project silently
 * authorizing auto-apply on another. Pure + total (delegates the scope compare to
 * {@link grantMatchesReuseScope}); `prior` null → always `"ask"`.
 */
export function inheritedGrantMode(
  prior: ProposalGrant | null,
  live: GrantReuseScope,
): "ask" | "auto" {
  return prior !== null && grantMatchesReuseScope(prior, live) ? prior.mode : "ask";
}

/**
 * The acceptance `mode` to stamp on a grant being minted RIGHT NOW (F12). It is
 * `"auto"` when EITHER the same-scope prior grant was Auto (the {@link
 * inheritedGrantMode} continuation case) OR the human has explicitly armed Auto
 * for THIS project via the in-app Agent-access toggle (`projectMode`). The second
 * arm is the fix for "arm-before-pair": a user who selects Auto before any agent
 * has paired writes only the in-app project setting (no grant exists yet); this
 * lets the freshly minted grant honour that choice at the moment of open_project
 * consent, scoped to the single just-consented project.
 *
 * This is a deliberate, audited user opt-in on the grant being consented to —
 * NOT passive privilege carry-over: `projectMode` is read for the EXACT project
 * being recorded, so project A's Auto never seeds project B's first grant. Pure +
 * total; with `inheritedMode==="ask"` and `projectMode==="ask"` it stays the
 * fail-closed `"ask"` default.
 */
export function mintGrantMode(
  inheritedMode: "ask" | "auto",
  projectMode: "ask" | "auto",
): "ask" | "auto" {
  return inheritedMode === "auto" || projectMode === "auto" ? "auto" : "ask";
}

/** The serialization-format version tag — bumped only on a breaking change. */
const VERSION = "galley.mcp.grant.v1";

const utf8 = new TextEncoder();

/** Canonical encode: UTF-8 bytes of `JSON.stringify` of a strings-only value. */
function canonical(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value));
}

/**
 * A finite number as its canonical decimal string, so `grantedAt` can never
 * collide with the textual form of another field. Throws on a non-finite value
 * (a publish-side bug must fail closed, not MAC garbage).
 */
function dec(n: number): string {
  if (!Number.isFinite(n)) throw new Error("proposal-grant: non-finite grantedAt");
  return String(Math.trunc(n));
}

/**
 * The fixed positional MAC input for a grant: every field in a known order, the
 * acceptance disposition as "0" (ask) / "1" (auto) and `grantedAt` as a decimal
 * string. The MAC covers THIS — not the `mac` field itself.
 *
 * NOTE (migration, ADR-0025 §7): the `mode` slot is encoded EXACTLY as the legacy
 * `autoAccept` boolean was (`auto`→"1" mirrors `true`→"1"; `ask`→"0" mirrors
 * `false`/absent→"0"). So a valid OLD-shape blob, once coerced to `mode`, MACs to
 * the SAME bytes it was signed under — the standard MAC check in {@link parseGrant}
 * authenticates the migrated grant with no separate old-payload recomputation, and
 * a TAMPERED old blob still fails that same check (fail closed).
 */
function grantArray(g: ProposalGrant): unknown[] {
  const arr: unknown[] = [
    VERSION,
    g.controlRoom,
    g.projectId,
    g.shareRoom,
    g.syncUrl,
    g.mainFile,
    g.grantId,
    g.mode === "auto" ? "1" : "0",
    dec(g.grantedAt),
  ];
  // F13: the persistentAccess slot is APPENDED only when true, so an absent/false
  // grant produces the EXACT 9-element array a pre-F13 (and legacy) blob was signed
  // under — those grants still authenticate + re-bind unchanged. A 10-element array
  // (persistentAccess true) is a byte-distinct sequence, so two grants differing
  // only in this flag can never collide, and a tampered flip fails the MAC check.
  if (g.persistentAccess === true) arr.push("1");
  return arr;
}

/** The exact bytes that get MAC'd for a grant. */
function grantMacBytes(g: ProposalGrant): Uint8Array {
  return canonical(grantArray(g));
}

/**
 * Structural typing for `crypto.subtle` (no DOM lib assumption): the runtime
 * object is WebCrypto in browsers and Node 20+ alike.
 */
interface SubtleLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: string; hash: string },
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyLike>;
  sign(algorithm: "HMAC", key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
}

/** Opaque handle to a WebCrypto key (no DOM lib in scope). */
type CryptoKeyLike = { readonly __cryptoKey: unique symbol };

/** The WebCrypto subtle provider, or undefined when crypto is unavailable. */
function getSubtle(): SubtleLike | undefined {
  return (globalThis as unknown as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
}

/**
 * HMAC-SHA-256 the grant's canonical bytes with `responseKey` → base64url. Throws
 * when crypto is unavailable (the persist side must never write an unMAC'd grant).
 */
export async function macGrant(responseKey: Uint8Array, g: ProposalGrant): Promise<string> {
  const subtle = getSubtle();
  if (subtle === undefined) {
    throw new Error("proposal-grant: WebCrypto (crypto.subtle) is required to MAC a grant");
  }
  const key = await subtle.importKey(
    "raw",
    responseKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", key, grantMacBytes(g));
  return bytesToBase64Url(new Uint8Array(mac));
}

/** Serialize a grant + its MAC to the persisted JSON blob (`{...grant, mac}`). */
export function serializeGrant(g: ProposalGrant, mac: string): string {
  return JSON.stringify({ ...g, mac });
}

/**
 * Validate one parsed grant shape, returning a typed grant or null.
 *
 * MIGRATION (ADR-0025 §7, fail-closed): accepts BOTH the current `mode:"ask"|"auto"`
 * shape and the LEGACY `autoAccept:boolean` (or `autoAccept` absent) shape, mapping
 * the legacy field onto `mode` (`true`→`auto`, `false`/absent→`ask`). Because the
 * MAC slot for `mode` is byte-identical to the old `autoAccept` boolean encoding
 * (see {@link grantArray}), the coerced grant MACs to the EXACT bytes a valid old
 * blob was signed under — so the caller's standard MAC check authenticates the
 * upgraded grant, and a TAMPERED old blob still fails that check (never silently
 * upgraded). Coercion alone is NOT authentication; {@link parseGrant} is.
 */
function coerceGrant(value: unknown): ProposalGrant | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["controlRoom"] !== "string") return null;
  if (typeof v["projectId"] !== "string") return null;
  if (typeof v["shareRoom"] !== "string") return null;
  if (typeof v["syncUrl"] !== "string") return null;
  if (typeof v["mainFile"] !== "string") return null;
  if (typeof v["grantId"] !== "string") return null;
  // Disposition: prefer the current `mode`; fall back to the legacy `autoAccept`
  // boolean (or its absence → ask). A present-but-wrong-typed field of either kind
  // is a malformed blob → reject (fail closed).
  let mode: "ask" | "auto";
  const rawMode = v["mode"];
  const rawAuto = v["autoAccept"];
  if (rawMode !== undefined) {
    if (rawMode !== "ask" && rawMode !== "auto") return null;
    mode = rawMode;
  } else if (rawAuto === undefined) {
    mode = "ask"; // legacy blob with no disposition field at all
  } else if (typeof rawAuto === "boolean") {
    mode = rawAuto ? "auto" : "ask"; // legacy migration
  } else {
    return null; // a non-boolean autoAccept is malformed
  }
  // A safe INTEGER (not just finite): the canonical signing bytes truncate
  // grantedAt to an integer, so two grants differing only in a sub-integer
  // fraction would canonicalize identically — require an integer at the read
  // boundary so the "distinct grants never collide" invariant holds.
  if (typeof v["grantedAt"] !== "number" || !Number.isSafeInteger(v["grantedAt"])) return null;
  // F13 persistentAccess: absent ⇒ false (legacy/pre-F13 blob). A present field
  // must be a boolean; anything else is a malformed blob → reject (fail closed).
  // Coercion is NOT authentication: a flipped flag changes the MAC array length, so
  // parseGrant's standard MAC check rejects a tampered persistentAccess (the value
  // here only reconstructs the grant the MAC will then authenticate).
  const rawPersistent = v["persistentAccess"];
  if (rawPersistent !== undefined && typeof rawPersistent !== "boolean") return null;
  const grant: ProposalGrant = {
    controlRoom: v["controlRoom"],
    projectId: v["projectId"],
    shareRoom: v["shareRoom"],
    syncUrl: v["syncUrl"],
    mainFile: v["mainFile"],
    grantId: v["grantId"],
    mode,
    grantedAt: v["grantedAt"],
  };
  // Only set the field when true so an undefined/false grant stays byte-identical
  // to a legacy blob (the spread in serializeGrant drops an undefined key).
  if (rawPersistent === true) grant.persistentAccess = true;
  return grant;
}

/**
 * The idle window after which a standing {@link ProposalGrant.persistentAccess}
 * grant degrades to manual (F13, operator-chosen): 7 days with no agent activity.
 * The host re-prompts for consent to resume — bounding the blast radius of a
 * forgotten, XSS-readable standing write capability without requiring a Revoke.
 */
export const HEADLESS_ACCESS_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a standing headless grant has gone idle past {@link
 * HEADLESS_ACCESS_IDLE_TTL_MS}. `lastActiveAt` is the last agent-activity stamp
 * (the host falls back to `grantedAt` when none is recorded yet). Pure; a
 * non-finite stamp is treated as expired (fail closed).
 */
export function headlessAccessExpired(lastActiveAt: number, now: number): boolean {
  if (!Number.isFinite(lastActiveAt) || !Number.isFinite(now)) return true;
  return now - lastActiveAt >= HEADLESS_ACCESS_IDLE_TTL_MS;
}

/**
 * Whether a persisted grant authorises a HEADLESS re-attach for a non-foreground
 * project (F13). ALL must hold: the grant carries `persistentAccess` (the human's
 * explicit standing opt-in), its full scope matches the live request EXACTLY (no
 * cross-project carry-over — {@link grantMatchesReuseScope}), and it has NOT gone
 * idle past the TTL. Pure + total; the caller is responsible for the grant's MAC
 * authenticity (it comes from {@link parseGrant}) and for `lastActiveAt`/`now`.
 */
export function grantAuthorizesHeadlessAttach(
  g: ProposalGrant,
  live: GrantReuseScope,
  lastActiveAt: number,
  now: number,
): boolean {
  return (
    g.persistentAccess === true &&
    grantMatchesReuseScope(g, live) &&
    !headlessAccessExpired(lastActiveAt, now)
  );
}

/**
 * Parse + AUTHENTICATE a persisted grant blob. Returns null on absent, malformed,
 * wrong-shape, a missing/non-string `mac`, OR a recomputed MAC that does not equal
 * the stored one (fail closed — a tampered or forged grant never re-binds). The
 * MAC comparison is a plain `===` on the base64url strings: this is integrity, not
 * a secret an attacker can grind — without `responseKey` they cannot produce a
 * matching MAC at all. Never throws.
 */
export async function parseGrant(
  raw: string | null,
  responseKey: Uint8Array,
): Promise<ProposalGrant | null> {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const grant = coerceGrant(parsed);
  if (grant === null) return null;
  const storedMac = (parsed as Record<string, unknown>)["mac"];
  if (typeof storedMac !== "string" || storedMac.length === 0) return null;
  let expected: string;
  try {
    expected = await macGrant(responseKey, grant);
  } catch {
    return null; // crypto unavailable → cannot authenticate → no grant
  }
  return expected === storedMac ? grant : null;
}
