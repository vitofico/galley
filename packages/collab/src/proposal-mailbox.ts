/**
 * The MCP pending-proposal mailbox (roadmap #16.1, ADR-0020) — the shared CRDT
 * contract between the local MCP kernel and the browser's Accept gate.
 *
 * A top-level `Y.Map` ("mcpProposals") on the project's existing `Y.Doc` holds
 * one nested `Y.Map` per proposal record. NESTED (same rationale as
 * `CollabProject.fileMeta`) so the browser's status resolution merges
 * field-by-field with anything else instead of clobbering the whole record.
 *
 * The security invariant this module carries (ADR-0020): publishing a proposal
 * NEVER touches file text — it writes only into the mailbox map. The kernel's
 * `propose_edit` computes the proposed text against a scratch copy and parks it
 * here; the browser's mandatory DiffReview → `resolveAccept` →
 * `applyAcceptedFileAsAgent` path is the ONLY thing that can land it. Pinned by
 * test: a publish leaves every file's text byte-for-byte unchanged.
 *
 * Proposal ids are CSPRNG-minted (the mailbox lives in a shared room whose id
 * is itself a capability; ids must not be guessable or collide). Like
 * `mintShareRoom`, this fails closed — no `Math.random()` fallback.
 *
 * Framework-agnostic by design (yjs only): the kernel (Node) and the web app
 * (browser) both speak this module over their replicated docs.
 */
import * as Y from "yjs";
import type { Author, EditBlock } from "@galley/shared";
import type { BinaryAsset } from "./binary-assets.js";
import { isSafeProjectPath } from "@galley/shared";
import { authorOrigin } from "./collab-document.js";
import type { DocHost } from "./collab-connection.js";
import { singleToSignable, fileToSignable, type SignableProposal } from "./proposal-provenance.js";

const MAILBOX_KEY = "mcpProposals";

/**
 * Signs the canonical view of a freshly minted proposal record (ADR-0023 §1).
 * Injected into `publishProposal`/`publishFileProposal` so this yjs-bound module
 * never owns a CryptoKey lifecycle — the kernel binds it to the per-grant key +
 * scope (Task 4); local-mode publishes pass no signer and stay unsigned. Returns
 * the base64url HMAC to store as the record's `sig`.
 */
export type ProposalSigner = (
  signable: SignableProposal,
  mailbox: "mcpProposals" | "mcpFileProposals",
) => Promise<string>;

export type ProposalStatus = "pending" | "accepted" | "rejected";

/**
 * Shared size limits for proposal records (Security-Analyst round, finding 1).
 * Enforced TWICE, on both sides of the trust boundary:
 *   - at PUBLISH time (`publishProposal` throws; the kernel's tool layer turns
 *     that into a structured rejection), so an honest kernel never writes an
 *     oversized record into the room's CRDT; and
 *   - at READ time (`readRecord` skips over-limit records exactly like any
 *     other malformed entry), so a hostile ROOM PEER that forges a huge record
 *     straight into the Y.Map cannot freeze the browser's diff renderer —
 *     forged oversized records never surface and never get an Accept
 *     affordance.
 * `maxTextBytes` mirrors the compile service's per-file cap (ADR-0015).
 */
export const PROPOSAL_LIMITS = {
  /** Max UTF-8 bytes for `baseText` and `proposedText`, each. */
  maxTextBytes: 2 * 1024 * 1024,
  /** Max search/replace blocks in one proposal. */
  maxBlocks: 64,
  /** Max UTF-8 bytes for one block's `search` or `replace`, each. */
  maxBlockBytes: 64 * 1024,
  /** Max characters for the `request` title. */
  maxRequestChars: 500,
} as const;

/**
 * Caps for the non-authoritative `runId` grouping (ADR-0025 §7, Task 2). `runId`
 * is a UI/correlation hint only — it NEVER gates apply — but it is still
 * attacker-influenceable text written into an open room, so the read-side guards
 * here preserve the same DoS posture as {@link PROPOSAL_LIMITS}:
 *   - a `runId` longer than `RUN_ID_MAX_LEN` is treated as ABSENT on read (the
 *     record collapses to its own singleton group) — never trust an unbounded
 *     grouping key; and
 *   - `getPendingRunGroups` returns at most `RUN_GROUP_MAX` groups and
 *     `RECORDS_PER_RUN_MAX` records per group, surfacing overflow as a flag
 *     (mirrors the "showing newest N of M" notice) rather than silently dropping.
 */
export const RUN_ID_MAX_LEN = 128;
/** Max run groups returned by {@link getPendingRunGroups} (newest kept on overflow). */
export const RUN_GROUP_MAX = 50;
/** Max records surfaced within ONE run group (newest kept on overflow). */
export const RECORDS_PER_RUN_MAX = 200;

const utf8 = new TextEncoder();

/**
 * The UTF-8 byte length of `text` when it is within `maxBytes`, else null —
 * WITHOUT allocating an encoding for an oversized string. `text.length` (UTF-16
 * code units) is a lower bound on the UTF-8 byte length, so a string longer than
 * `maxBytes` code units is already over the byte cap and is rejected before any
 * `TextEncoder.encode` allocation. This is the cheap guard that stops a forged
 * mailbox record with bounded array lengths but a huge string from forcing
 * attacker-sized work at read time.
 */
function utf8BytesWithinCap(text: string, maxBytes: number): number | null {
  if (text.length > maxBytes) return null;
  const n = utf8.encode(text).length;
  return n > maxBytes ? null : n;
}

/**
 * The first limit `input` violates, or null when it is within bounds. Pure and
 * shared by BOTH enforcement points (publish + read) so they can never drift.
 */
export function proposalSizeViolation(input: ProposalInput): string | null {
  if (input.request.length > PROPOSAL_LIMITS.maxRequestChars) {
    return `request exceeds ${PROPOSAL_LIMITS.maxRequestChars} characters`;
  }
  if (input.blocks.length > PROPOSAL_LIMITS.maxBlocks) {
    return `more than ${PROPOSAL_LIMITS.maxBlocks} edit blocks`;
  }
  for (const block of input.blocks) {
    if (
      utf8BytesWithinCap(block.search, PROPOSAL_LIMITS.maxBlockBytes) === null ||
      utf8BytesWithinCap(block.replace, PROPOSAL_LIMITS.maxBlockBytes) === null
    ) {
      return `an edit block exceeds ${PROPOSAL_LIMITS.maxBlockBytes} bytes`;
    }
  }
  if (utf8BytesWithinCap(input.baseText, PROPOSAL_LIMITS.maxTextBytes) === null) {
    return `baseText exceeds ${PROPOSAL_LIMITS.maxTextBytes} bytes`;
  }
  if (utf8BytesWithinCap(input.proposedText, PROPOSAL_LIMITS.maxTextBytes) === null) {
    return `proposedText exceeds ${PROPOSAL_LIMITS.maxTextBytes} bytes`;
  }
  return null;
}

/** What a caller publishes (everything else — id, author, status — is minted here). */
export interface ProposalInput {
  /** Canonical project path of the target file (leading slash). */
  filePath: string;
  /** The file text the edit was computed against. */
  baseText: string;
  /** The full proposed text (base + edits applied to a scratch copy). */
  proposedText: string;
  /**
   * The original search/replace blocks. The browser's Accept re-applies these
   * conflict-aware (`resolveAccept`) when the live text moved past `baseText`,
   * so a stale proposal degrades to a surfaced conflict — never a clobber.
   */
  blocks: EditBlock[];
  /** The human-readable request/title shown in the review card. */
  request: string;
  /**
   * OPTIONAL non-authoritative run-correlation hint (ADR-0025 §7). When present,
   * the browser groups every pending record sharing this `runId` into one review
   * card; absent → the record forms its own singleton "legacy run". NEVER signed,
   * NEVER gates apply — a forged/reused `runId` can at worst mis-group a card.
   * Omitted from the CRDT record entirely when absent (single-file path stays
   * byte-compatible).
   */
  runId?: string;
}

/** A flattened, validated proposal record as read from the mailbox. */
export interface ProposalRecord extends ProposalInput {
  id: string;
  /** Proposals are always agent-authored; the tag is fixed by the contract. */
  author: "mcp";
  status: ProposalStatus;
  /** Publisher wall-clock ms — for deterministic oldest-first listing. */
  createdAt: number;
  /**
   * Per-process tie-break within one millisecond, promoted onto the public
   * record because it is part of the SIGNED set (ADR-0023 §1): the auto-accept
   * verifier reconstructs the signable view from the read record and must see
   * the same `seq` the kernel signed. Falls back to 0 for a forged record.
   */
  seq: number;
  /**
   * The kernel's base64url HMAC over the canonical proposal (ADR-0023 §1), or
   * undefined for a locally-published (unsigned) record. Read-side surface only
   * — the auto-accept gate AUTHENTICATES it; the manual Accept gate ignores it.
   */
  sig?: string;
}

function mailbox(host: DocHost): Y.Map<Y.Map<unknown>> {
  return host.doc.getMap<Y.Map<unknown>>(MAILBOX_KEY);
}

/** CSPRNG proposal id. Fails closed — a guessable id is worse than no proposal. */
function mintProposalId(): string {
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
  throw new Error("proposal-mailbox: a secure random source (crypto) is required to mint ids");
}

/**
 * CSPRNG run id — the SAME unguessable scheme as {@link mintProposalId} (a run id
 * is itself a grouping key written into a shared room; reuse the one fail-closed
 * secure-random helper rather than invent a second). Exported so the kernel that
 * owns a run's lifecycle (apps/mcp surface) mints run ids the same way the
 * mailbox mints record ids.
 */
export function mintRunId(): string {
  return mintProposalId();
}

/** Same-millisecond tie-break for publishes from THIS process (cross-peer ties fall to id). */
let seq = 0;

/**
 * Publish a pending proposal into the shared mailbox as one author-tagged
 * transaction. Returns the minted proposal id. Writes ONLY the mailbox map —
 * never file text (the ADR-0020 pin). Throws on an over-limit input
 * ({@link PROPOSAL_LIMITS}) so oversized records never enter the CRDT.
 *
 * ASYNC because signing is async (ADR-0023): when `signer` is present, the
 * record's identity (`id`/`createdAt`/`seq`) is minted FIRST, the canonical
 * signable view is built from it, the signature is awaited, and ONLY THEN is
 * the (still single) transaction run — so the signed bytes exactly match the
 * stored record. A missing `signer` publishes an unsigned record (local mode).
 */
export async function publishProposal(
  host: DocHost,
  input: ProposalInput,
  author: Author,
  signer?: ProposalSigner,
): Promise<string> {
  const violation = proposalSizeViolation(input);
  if (violation !== null) throw new Error(`publishProposal: ${violation}`);
  const id = mintProposalId();
  const createdAt = Date.now();
  const recordSeq = seq++;
  // Sign BEFORE the transaction so the whole publish stays ONE transaction and
  // the signed canonical view matches the fields below exactly.
  const sig = signer
    ? await signer(singleToSignable({ ...input, id, createdAt }, recordSeq), MAILBOX_KEY)
    : undefined;
  const record = new Y.Map<unknown>();
  host.doc.transact(() => {
    record.set("id", id);
    record.set("filePath", input.filePath);
    record.set("baseText", input.baseText);
    record.set("proposedText", input.proposedText);
    // Blocks are immutable once published — a plain JSON value (LWW) is fine.
    record.set("blocks", input.blocks.map((b) => ({ search: b.search, replace: b.replace })));
    record.set("request", input.request);
    record.set("author", "mcp");
    record.set("status", "pending");
    record.set("createdAt", createdAt);
    record.set("seq", recordSeq);
    // exactOptionalPropertyTypes: only set `sig` when actually signed.
    if (sig !== undefined) record.set("sig", sig);
    // `runId` is additive + non-authoritative: only write the key when the caller
    // supplied one, so an unsigned/un-grouped publish stores the exact same record
    // shape as before (the security-pinned single-file path stays byte-compatible).
    if (input.runId !== undefined) record.set("runId", input.runId);
    mailbox(host).set(id, record);
  }, authorOrigin(author));
  return id;
}

function isEditBlock(b: unknown): b is EditBlock {
  return (
    typeof b === "object" &&
    b !== null &&
    typeof (b as EditBlock).search === "string" &&
    typeof (b as EditBlock).replace === "string"
  );
}

/**
 * Flatten + validate one mailbox entry. Returns undefined for anything
 * malformed OR over the shared size limits — the mailbox lives in an open
 * room, so a buggy/hostile peer can write garbage or forge an oversized record
 * directly into the Y.Map; readers skip both rather than throw mid-render or
 * feed attacker-sized text to a diff.
 */
function readRecord(entry: unknown, key: string): ProposalRecord | undefined {
  if (!(entry instanceof Y.Map)) return undefined;
  const id = entry.get("id");
  const filePath = entry.get("filePath");
  const baseText = entry.get("baseText");
  const proposedText = entry.get("proposedText");
  const blocks = entry.get("blocks");
  const request = entry.get("request");
  const status = entry.get("status");
  if (
    typeof id !== "string" ||
    typeof filePath !== "string" ||
    typeof baseText !== "string" ||
    typeof proposedText !== "string" ||
    typeof request !== "string" ||
    !Array.isArray(blocks) ||
    // Bound the block-array length BEFORE `.every` so a forged record with a
    // huge blocks array can't force attacker-sized work (the size gate re-checks
    // authoritatively; this is the cheap early bail — mirrors readFileRecord).
    blocks.length > PROPOSAL_LIMITS.maxBlocks ||
    !blocks.every(isEditBlock) ||
    (status !== "pending" && status !== "accepted" && status !== "rejected")
  ) {
    return undefined;
  }
  // Record-swap guard (ADR-0023): the mailbox is keyed by the proposal id, so a
  // record whose signed `id` disagrees with the map KEY it lives under was
  // relocated — drop it, exactly like any other forged/malformed entry. This
  // pins the signature (which binds `id`) to the slot it was published in.
  if (id !== key) return undefined;
  // The read-side half of the double enforcement: a forged over-limit record is
  // as unusable as a malformed one (finding 1 — never diff attacker-sized text).
  if (proposalSizeViolation({ filePath, baseText, proposedText, blocks, request }) !== null) {
    return undefined;
  }
  const createdAt = entry.get("createdAt");
  const seqVal = entry.get("seq");
  // Reject a forged FRACTIONAL/unsafe numeric createdAt or seq: the signed bytes
  // serialize these via integer truncation (`dec`), so a peer could otherwise
  // mutate them within an integer bucket and keep a valid signature. Honest
  // publishers always write safe integers (review Medium-2).
  if (
    (typeof createdAt === "number" && !Number.isSafeInteger(createdAt)) ||
    (typeof seqVal === "number" && !Number.isSafeInteger(seqVal))
  ) {
    return undefined;
  }
  const sig = entry.get("sig");
  const runId = entry.get("runId");
  return {
    id,
    filePath,
    baseText,
    proposedText,
    blocks: blocks.map((b) => ({ search: b.search, replace: b.replace })),
    request,
    author: "mcp",
    status,
    createdAt: typeof createdAt === "number" ? createdAt : 0,
    seq: typeof seqVal === "number" ? seqVal : 0,
    // exactOptionalPropertyTypes: omit `sig` entirely when not a string.
    ...(typeof sig === "string" ? { sig } : {}),
    // `runId` is a non-authoritative grouping hint: read it ONLY when it is a
    // bounded string. An over-length (or non-string) value is treated as ABSENT —
    // the record falls back to its own singleton group — so a forged unbounded
    // grouping key can never freeze the grouping pass (same posture as the size
    // guards above). Omitted entirely when absent (back-compat).
    ...(isValidRunId(runId) ? { runId } : {}),
  };
}

/** A `runId` is usable only when it is a non-empty, bounded string (else treated as absent). */
function isValidRunId(runId: unknown): runId is string {
  return typeof runId === "string" && runId.length > 0 && runId.length <= RUN_ID_MAX_LEN;
}

// ---------------------------------------------------------------------------
// Run boundaries (ADR-0025 §5, Task 3) — a sibling `Y.Map("mcpRuns")`, one
// nested record per `runId`, recording whether the run is still emitting
// proposals so a run card survives reload/disconnect. The kernel marks a run
// OPEN at its first proposal and CLOSED on idle. PURELY a UI/correlation hint:
// `open` feeds {@link getPendingRunGroups}'s `streaming` flag and NOTHING ELSE —
// it never gates apply/accept. Additive + byte-compatible: an absent map means
// no runs, so legacy docs (and the security-pinned single-file path) are
// untouched.
// ---------------------------------------------------------------------------

const RUNS_KEY = "mcpRuns";

/** The persisted boundary state for one run, keyed in the `mcpRuns` map by `runId`. */
export interface RunState {
  /** True while the run is still emitting proposals (drives `streaming`). */
  open: boolean;
  /** Wall-clock ms the run first opened (first proposal). */
  startedAt: number;
  /** Wall-clock ms of the most recent open/close transition. */
  lastAt: number;
}

function runsMap(host: DocHost): Y.Map<Y.Map<unknown>> {
  return host.doc.getMap<Y.Map<unknown>>(RUNS_KEY);
}

/**
 * Mark a run OPEN (its first proposal, or a later proposal extending it). One
 * author-less transaction on the sibling map — never file text, never the
 * mailbox. `startedAt` is set once (first open wins); a re-open of an
 * already-open run only advances `lastAt`. Idempotent and safe to call on every
 * proposal in the run.
 */
export function markRunOpen(host: DocHost, runId: string, at: number): void {
  host.doc.transact(() => {
    const map = runsMap(host);
    const existing = map.get(runId);
    if (existing instanceof Y.Map) {
      existing.set("open", true);
      existing.set("lastAt", at);
      return;
    }
    const record = new Y.Map<unknown>();
    record.set("open", true);
    record.set("startedAt", at);
    record.set("lastAt", at);
    map.set(runId, record);
  });
}

/**
 * Mark a run CLOSED (idle-close, the kernel's bounded fallback). Flips `open` to
 * false and stamps `lastAt`; a close of an unknown run is a no-op (the run never
 * opened — nothing to close). Closing NEVER accepts anything; it only stops a
 * run card from saying "in progress".
 */
export function markRunClosed(host: DocHost, runId: string, at: number): void {
  const map = runsMap(host);
  const existing = map.get(runId);
  if (!(existing instanceof Y.Map)) return;
  host.doc.transact(() => {
    existing.set("open", false);
    existing.set("lastAt", at);
  });
}

/**
 * Whether the run `runId` is currently OPEN (still streaming). False for an
 * absent or malformed entry — a forged/garbage record reads as not-open, exactly
 * like any other malformed mailbox entry, so this can never freeze or mislead
 * the grouping pass.
 */
export function readRunOpen(host: DocHost, runId: string): boolean {
  const entry = runsMap(host).get(runId);
  return entry instanceof Y.Map && entry.get("open") === true;
}

/** All well-formed proposals, oldest first ([createdAt, seq, id] — deterministic). */
export function getProposals(host: DocHost): ProposalRecord[] {
  const out: ProposalRecord[] = [];
  for (const [key, entry] of mailbox(host).entries()) {
    const rec = readRecord(entry, key);
    if (rec) out.push(rec);
  }
  out.sort(
    (a, b) =>
      a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

/** The well-formed proposals still awaiting the browser's Accept/Reject. */
export function getPendingProposals(host: DocHost): ProposalRecord[] {
  return getProposals(host).filter((p) => p.status === "pending");
}

/** One proposal by id, or undefined if absent/malformed. */
export function getProposal(host: DocHost, id: string): ProposalRecord | undefined {
  return readRecord(mailbox(host).get(id), id);
}

/**
 * Invoke `cb` whenever the mailbox may have changed — a record arriving or a
 * nested field (status) flipping — hence `observeDeep`. Returns an unsubscribe.
 */
export function observeProposals(host: DocHost, cb: () => void): () => void {
  const map = mailbox(host);
  const handler = (): void => cb();
  map.observeDeep(handler);
  return () => map.unobserveDeep(handler);
}

/**
 * Record the browser's verdict as one author-tagged transaction. Only the
 * `status` field is written (nested map — field-level merge). Throws on an
 * unknown id: resolving a proposal that doesn't exist is a caller bug, never a
 * silent no-op (house style — see `CollabProject.requireMeta`).
 */
export function resolveProposal(
  host: DocHost,
  id: string,
  status: "accepted" | "rejected",
  author: Author,
): void {
  const record = mailbox(host).get(id);
  if (!(record instanceof Y.Map)) throw new Error(`resolveProposal: unknown proposal ${id}`);
  host.doc.transact(() => record.set("status", status), authorOrigin(author));
}

// ---------------------------------------------------------------------------
// Multi-file proposals (`propose_files`) — a SIBLING mailbox to the single-file
// one above. Same trust model (the browser's mandatory Accept gate is the ONLY
// thing that lands anything; publishing writes ONLY this map, never file text),
// same double-enforced size/path caps, same CSPRNG ids. A separate
// `Y.Map("mcpFileProposals")` keeps the security-pinned single-file path
// byte-for-byte untouched. One record carries an all-or-nothing change set of
// `create`/`edit` ops; the browser validates EVERY op against the live snapshot
// and applies nothing on any conflict (never a partial landing).
// ---------------------------------------------------------------------------

const FILE_MAILBOX_KEY = "mcpFileProposals";

/**
 * Limits for multi-file proposal records. PER-OP caps reuse {@link PROPOSAL_LIMITS}
 * (so a single op can never exceed what a single-file proposal can), plus
 * AGGREGATE caps bounding the whole change set — a multi-file proposal must not
 * become an unbounded channel just because each op is individually small
 * (Architect's DoS note). Enforced TWICE (publish throws + read skips), exactly
 * like {@link proposalSizeViolation}.
 */
export const FILE_PROPOSAL_LIMITS = {
  /** Max UTF-8 bytes for ONE op's `proposedText` (mirrors PROPOSAL_LIMITS.maxTextBytes). */
  maxTextBytes: PROPOSAL_LIMITS.maxTextBytes,
  /** Max search/replace blocks in ONE edit op. */
  maxBlocks: PROPOSAL_LIMITS.maxBlocks,
  /** Max UTF-8 bytes for one block's `search`/`replace`, each. */
  maxBlockBytes: PROPOSAL_LIMITS.maxBlockBytes,
  /** Max characters for the `request` title. */
  maxRequestChars: PROPOSAL_LIMITS.maxRequestChars,
  /** Max ops in one change set. */
  maxOps: 32,
  /** Max SUM of UTF-8 bytes of every op's `proposedText` (the content that will land). */
  maxTotalProposedBytes: 8 * 1024 * 1024,
  /** Max SUM of `blocks.length` across all edit ops. */
  maxTotalBlocks: 256,
  /** Max characters for one op's `path` (mirrors the tool layer's read cap). */
  maxPathChars: 1024,
  /** Max characters for a record's `id` (CSPRNG ids are short; bound a forged one). */
  maxIdChars: 128,
  /**
   * Max BYTES of ONE `create-binary` op's blob (A2). The pointer carries a SIZE
   * the bytes were pushed under; this caps each one and is double-enforced
   * (publish throws + read skips) exactly like the text caps. KEPT SEPARATE from
   * the text byte caps — binary bytes never enter `proposedText`, so they must
   * never be folded into {@link maxTotalProposedBytes}.
   */
  maxBlobBytes: 64 * 1024 * 1024,
  /** Max SUM of every `create-binary` op's `size` (the bytes that will land). */
  maxTotalBlobBytes: 64 * 1024 * 1024,
  /** Max characters for a `create-binary` op's `mime` (a bounded, non-empty media type). */
  maxMimeChars: 255,
} as const;

/** A lowercase-hex sha256 is exactly 64 chars of [0-9a-f] (the BlobStore key shape). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A well-formed binary pointer carried on a `create-binary` op (A2): a
 * content-addressed {@link BinaryAsset} (`type:"binary"`, a 64-hex sha256 hash,
 * a positive-integer byte size within the blob cap, a bounded non-empty mime).
 * Pure + shared by the validator and the read normalizer so they never drift.
 * The bytes themselves are pushed over the blob channel and verified on Accept —
 * this only validates the POINTER's shape.
 */
function binaryAssetViolation(asset: unknown): string | null {
  if (typeof asset !== "object" || asset === null) return "binaryAsset must be an object";
  const a = asset as Record<string, unknown>;
  if (a.type !== "binary") return "binaryAsset.type must be \"binary\"";
  if (typeof a.hash !== "string" || !SHA256_HEX_RE.test(a.hash)) {
    return "binaryAsset.hash must be a 64-character lowercase hex sha256";
  }
  if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size <= 0) {
    return "binaryAsset.size must be a positive integer";
  }
  if (a.size > FILE_PROPOSAL_LIMITS.maxBlobBytes) {
    return `binaryAsset.size exceeds ${FILE_PROPOSAL_LIMITS.maxBlobBytes} bytes`;
  }
  if (typeof a.mime !== "string" || a.mime.length === 0) {
    return "binaryAsset.mime must be a non-empty string";
  }
  if (a.mime.length > FILE_PROPOSAL_LIMITS.maxMimeChars) {
    return `binaryAsset.mime exceeds ${FILE_PROPOSAL_LIMITS.maxMimeChars} characters`;
  }
  return null;
}

/** One file operation in a multi-file proposal. */
export interface FileProposalOp {
  /**
   * `create` a new file, `edit` an existing one, `rename` (also = move-into-folder,
   * since the path is just metadata) an existing file to `newPath`, `delete`
   * (soft, recoverable) an existing file, or `create-binary` (A2) — add a binary
   * file POINTER to bytes already pushed over the blob channel.
   */
  kind: "create" | "edit" | "rename" | "delete" | "create-binary";
  /** Canonical path with leading slash. create(-binary): the new file; edit/rename/delete: the target. */
  path: string;
  /** `rename` ONLY: the destination path the file moves to (safe, in-tree, ≠ `path`). */
  newPath?: string;
  /** Text the edit blocks were computed against. create/rename/delete/create-binary carry "". */
  baseText: string;
  /** Full proposed text. `create`: the whole new file; `edit`: base + blocks applied; rename/delete/create-binary: "". */
  proposedText: string;
  /** The original search/replace blocks (re-applied conflict-aware on Accept). create/rename/delete/create-binary: []. */
  blocks: EditBlock[];
  /**
   * `create-binary` ONLY (A2): a content-addressed pointer to the bytes pushed
   * over the blob channel — `{ type:"binary", hash, size, mime }`. It is part of
   * the SIGNED canonical view (proposal-provenance), so a room peer cannot swap
   * the hash and keep a valid signature. ABSENT on every other op kind.
   */
  binaryAsset?: BinaryAsset;
}

/** What a caller publishes for a multi-file proposal (id/author/status minted here). */
export interface FileProposalInput {
  /** Human-readable request/title shown in the review card. */
  request: string;
  /** The change set — applied all-or-nothing on Accept. */
  ops: FileProposalOp[];
  /**
   * OPTIONAL non-authoritative run-correlation hint (ADR-0025 §7) — see
   * {@link ProposalInput.runId}. Groups this record with same-`runId` peers into
   * one review card; never signed, never gates apply; omitted from the CRDT
   * record when absent.
   */
  runId?: string;
}

/** A flattened, validated multi-file proposal record as read from the mailbox. */
export interface FileProposalRecord extends FileProposalInput {
  id: string;
  author: "mcp";
  status: ProposalStatus;
  createdAt: number;
  /** Signed per-process tie-break (ADR-0023 §1) — see {@link ProposalRecord.seq}. */
  seq: number;
  /** The kernel's base64url HMAC over the canonical proposal, or undefined when unsigned. */
  sig?: string;
}

/**
 * The first limit/safety rule `input` violates, or null when within bounds.
 * Pure and shared by BOTH enforcement points (publish + read) so they can never
 * drift — mirrors {@link proposalSizeViolation}. Also enforces path safety
 * ({@link isSafeProjectPath}) and intra-proposal path uniqueness, since multi-file
 * ops carry attacker-influenceable paths (the single-file path was fixed at
 * session start and validated there).
 */
export function fileProposalSizeViolation(input: FileProposalInput): string | null {
  if (input.request.length > FILE_PROPOSAL_LIMITS.maxRequestChars) {
    return `request exceeds ${FILE_PROPOSAL_LIMITS.maxRequestChars} characters`;
  }
  if (input.ops.length === 0) {
    return "a proposal must carry at least one op";
  }
  if (input.ops.length > FILE_PROPOSAL_LIMITS.maxOps) {
    return `more than ${FILE_PROPOSAL_LIMITS.maxOps} ops`;
  }
  const seenPaths = new Set<string>();
  let totalProposed = 0;
  let totalBlocks = 0;
  let totalBlobBytes = 0;
  for (const op of input.ops) {
    if (
      op.kind !== "create" &&
      op.kind !== "edit" &&
      op.kind !== "rename" &&
      op.kind !== "delete" &&
      op.kind !== "create-binary"
    ) {
      return `unknown op kind`;
    }
    if (op.path.length > FILE_PROPOSAL_LIMITS.maxPathChars) {
      return `a path exceeds ${FILE_PROPOSAL_LIMITS.maxPathChars} characters`;
    }
    if (!isSafeProjectPath(op.path)) {
      return `unsafe or reserved path: ${op.path}`;
    }
    if (seenPaths.has(op.path)) {
      return `duplicate path within the proposal: ${op.path}`;
    }
    seenPaths.add(op.path);
    // create-binary (A2): the op carries a POINTER, never text — so it must have
    // a well-formed binaryAsset AND empty text/blocks (the bytes are pushed over
    // the blob channel, not inlined). Every OTHER kind must NOT carry a
    // binaryAsset (a forged pointer on an edit/rename/delete is meaningless and
    // could only confuse the Accept path). Both halves are double-enforced.
    if (op.kind === "create-binary") {
      const av = binaryAssetViolation(op.binaryAsset);
      if (av !== null) return `a create-binary op ${av}`;
      if (op.baseText !== "" || op.proposedText !== "" || op.blocks.length !== 0) {
        return "a create-binary op must carry empty baseText, proposedText, and blocks";
      }
      // op.binaryAsset is non-null here (binaryAssetViolation passed).
      totalBlobBytes += (op.binaryAsset as BinaryAsset).size;
      continue;
    }
    if (op.binaryAsset !== undefined) {
      return `only a create-binary op may carry a binaryAsset (got ${op.kind})`;
    }
    // A rename carries a destination that is itself a path the change set occupies:
    // gate it through the SAME safety + uniqueness rules (a forged newPath could
    // otherwise traverse or collide). Every path mentioned anywhere — source,
    // target, create/rename destination — must be unique across the proposal, so
    // no two ops can race for the same path on Accept.
    if (op.kind === "rename") {
      const dest = op.newPath;
      if (typeof dest !== "string" || dest.length > FILE_PROPOSAL_LIMITS.maxPathChars) {
        return `a rename op needs a destination path within ${FILE_PROPOSAL_LIMITS.maxPathChars} characters`;
      }
      if (!isSafeProjectPath(dest)) {
        return `unsafe or reserved path: ${dest}`;
      }
      if (dest === op.path) {
        return `a rename's destination equals its source: ${dest}`;
      }
      if (seenPaths.has(dest)) {
        return `duplicate path within the proposal: ${dest}`;
      }
      seenPaths.add(dest);
    }
    if (op.blocks.length > FILE_PROPOSAL_LIMITS.maxBlocks) {
      return `an op has more than ${FILE_PROPOSAL_LIMITS.maxBlocks} edit blocks`;
    }
    for (const block of op.blocks) {
      if (
        utf8BytesWithinCap(block.search, FILE_PROPOSAL_LIMITS.maxBlockBytes) === null ||
        utf8BytesWithinCap(block.replace, FILE_PROPOSAL_LIMITS.maxBlockBytes) === null
      ) {
        return `an edit block exceeds ${FILE_PROPOSAL_LIMITS.maxBlockBytes} bytes`;
      }
    }
    // Cheap length precheck inside utf8BytesWithinCap rejects an over-cap string
    // BEFORE encoding it — a forged record can't force an attacker-sized encode.
    const proposedBytes = utf8BytesWithinCap(op.proposedText, FILE_PROPOSAL_LIMITS.maxTextBytes);
    if (proposedBytes === null) {
      return `an op's proposedText exceeds ${FILE_PROPOSAL_LIMITS.maxTextBytes} bytes`;
    }
    if (utf8BytesWithinCap(op.baseText, FILE_PROPOSAL_LIMITS.maxTextBytes) === null) {
      return `an op's baseText exceeds ${FILE_PROPOSAL_LIMITS.maxTextBytes} bytes`;
    }
    totalProposed += proposedBytes;
    totalBlocks += op.blocks.length;
  }
  if (totalProposed > FILE_PROPOSAL_LIMITS.maxTotalProposedBytes) {
    return `total proposedText exceeds ${FILE_PROPOSAL_LIMITS.maxTotalProposedBytes} bytes`;
  }
  if (totalBlocks > FILE_PROPOSAL_LIMITS.maxTotalBlocks) {
    return `total edit blocks exceed ${FILE_PROPOSAL_LIMITS.maxTotalBlocks}`;
  }
  // The binary-bytes aggregate is its OWN cap (A2) — kept separate from the text
  // byte cap so binary content can never be smuggled into the text budget and
  // vice-versa; both are double-enforced (publish throws + read skips).
  if (totalBlobBytes > FILE_PROPOSAL_LIMITS.maxTotalBlobBytes) {
    return `total binary bytes exceed ${FILE_PROPOSAL_LIMITS.maxTotalBlobBytes} bytes`;
  }
  return null;
}

function fileMailbox(host: DocHost): Y.Map<Y.Map<unknown>> {
  return host.doc.getMap<Y.Map<unknown>>(FILE_MAILBOX_KEY);
}

/** Same-millisecond tie-break for multi-file publishes from THIS process. */
let fileSeq = 0;

/**
 * Publish a pending multi-file proposal as one author-tagged transaction.
 * Returns the minted id. Writes ONLY the mailbox map — never file text (the
 * ADR-0020 pin, extended to multi-file). Throws on an over-limit/unsafe input
 * ({@link fileProposalSizeViolation}) so bad records never enter the CRDT.
 */
export async function publishFileProposal(
  host: DocHost,
  input: FileProposalInput,
  author: Author,
  signer?: ProposalSigner,
): Promise<string> {
  const violation = fileProposalSizeViolation(input);
  if (violation !== null) throw new Error(`publishFileProposal: ${violation}`);
  const id = mintProposalId();
  const createdAt = Date.now();
  const recordSeq = fileSeq++;
  // Sign BEFORE the transaction (see publishProposal) so the publish stays ONE
  // transaction and the signed canonical view matches the stored record.
  const sig = signer
    ? await signer(fileToSignable({ ...input, id, createdAt }, recordSeq), FILE_MAILBOX_KEY)
    : undefined;
  const record = new Y.Map<unknown>();
  host.doc.transact(() => {
    record.set("id", id);
    record.set("request", input.request);
    // Ops are immutable once published — a plain JSON value (LWW) is fine.
    record.set(
      "ops",
      input.ops.map((op) => ({
        kind: op.kind,
        path: op.path,
        // newPath only rides along for rename ops (omitted otherwise).
        ...(op.kind === "rename" ? { newPath: op.newPath } : {}),
        baseText: op.baseText,
        proposedText: op.proposedText,
        blocks: op.blocks.map((b) => ({ search: b.search, replace: b.replace })),
        // binaryAsset only rides along for create-binary ops (A2) — stored as a
        // plain JSON pointer (LWW, immutable once published), exactly like blocks.
        ...(op.kind === "create-binary" && op.binaryAsset !== undefined
          ? {
              binaryAsset: {
                type: "binary" as const,
                hash: op.binaryAsset.hash,
                size: op.binaryAsset.size,
                mime: op.binaryAsset.mime,
              },
            }
          : {}),
      })),
    );
    record.set("author", "mcp");
    record.set("status", "pending");
    record.set("createdAt", createdAt);
    record.set("seq", recordSeq);
    // exactOptionalPropertyTypes: only set `sig` when actually signed.
    if (sig !== undefined) record.set("sig", sig);
    // Additive + non-authoritative grouping hint — only written when supplied so
    // an un-grouped publish keeps the prior record shape (see publishProposal).
    if (input.runId !== undefined) record.set("runId", input.runId);
    fileMailbox(host).set(id, record);
  }, authorOrigin(author));
  return id;
}

function isFileProposalOp(op: unknown): op is FileProposalOp {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  // A create-binary op (A2) carries a well-formed binaryAsset pointer and NO
  // text/blocks — validated here so a malformed binary op is dropped on read
  // exactly like any other malformed record (the size gate re-checks the asset
  // authoritatively; this is the cheap structural bail).
  if (o.kind === "create-binary") {
    return (
      typeof o.path === "string" &&
      o.baseText === "" &&
      o.proposedText === "" &&
      Array.isArray(o.blocks) &&
      o.blocks.length === 0 &&
      binaryAssetViolation(o.binaryAsset) === null
    );
  }
  return (
    (o.kind === "create" ||
      o.kind === "edit" ||
      (o.kind === "rename" && typeof o.newPath === "string") ||
      o.kind === "delete") &&
    // A forged binaryAsset on a non-binary op is malformed — drop the record.
    o.binaryAsset === undefined &&
    typeof o.path === "string" &&
    typeof o.baseText === "string" &&
    typeof o.proposedText === "string" &&
    Array.isArray(o.blocks) &&
    // Bound the block-array length BEFORE `.every` so a forged op with a huge
    // blocks array can't force attacker-sized validation work (the size gate
    // re-checks authoritatively; this is the cheap early bail).
    o.blocks.length <= FILE_PROPOSAL_LIMITS.maxBlocks &&
    o.blocks.every(isEditBlock)
  );
}

/**
 * Flatten + validate one multi-file mailbox entry. Returns undefined for
 * anything malformed OR over the shared size/path limits — a buggy/hostile peer
 * can forge garbage straight into the Y.Map; readers skip it rather than throw
 * mid-render or feed an oversized/unsafe change set to the Accept gate.
 */
function readFileRecord(entry: unknown, key: string): FileProposalRecord | undefined {
  if (!(entry instanceof Y.Map)) return undefined;
  const id = entry.get("id");
  const request = entry.get("request");
  const ops = entry.get("ops");
  const status = entry.get("status");
  if (
    typeof id !== "string" ||
    id.length > FILE_PROPOSAL_LIMITS.maxIdChars ||
    typeof request !== "string" ||
    !Array.isArray(ops) ||
    // Bound the op-array length BEFORE `.every`/`.map` so a forged record with a
    // huge ops array can't force attacker-sized work (the size gate re-checks).
    ops.length > FILE_PROPOSAL_LIMITS.maxOps ||
    !ops.every(isFileProposalOp) ||
    (status !== "pending" && status !== "accepted" && status !== "rejected")
  ) {
    return undefined;
  }
  // Record-swap guard (ADR-0023): the signed `id` must match the map KEY the
  // record lives under, else it was relocated — drop it (mirrors readRecord).
  if (id !== key) return undefined;
  const normalizedOps: FileProposalOp[] = ops.map((op) => ({
    kind: op.kind,
    path: op.path,
    ...(op.kind === "rename" ? { newPath: op.newPath } : {}),
    baseText: op.baseText,
    proposedText: op.proposedText,
    blocks: op.blocks.map((b) => ({ search: b.search, replace: b.replace })),
    // Preserve the binary pointer on a create-binary op (A2) — isFileProposalOp
    // already validated its shape; re-pick only the contract fields so no extra
    // forged keys ride along.
    ...(op.kind === "create-binary" && op.binaryAsset !== undefined
      ? {
          binaryAsset: {
            type: "binary" as const,
            hash: op.binaryAsset.hash,
            size: op.binaryAsset.size,
            mime: op.binaryAsset.mime,
          },
        }
      : {}),
  }));
  // The read-side half of the double enforcement: a forged over-limit/unsafe
  // record is as unusable as a malformed one (never surface attacker-sized text
  // or a traversal path to the Accept gate).
  if (fileProposalSizeViolation({ request, ops: normalizedOps }) !== null) {
    return undefined;
  }
  const createdAt = entry.get("createdAt");
  const seqVal = entry.get("seq");
  // Reject a forged FRACTIONAL/unsafe numeric createdAt or seq: the signed bytes
  // serialize these via integer truncation (`dec`), so a peer could otherwise
  // mutate them within an integer bucket and keep a valid signature. Honest
  // publishers always write safe integers (review Medium-2).
  if (
    (typeof createdAt === "number" && !Number.isSafeInteger(createdAt)) ||
    (typeof seqVal === "number" && !Number.isSafeInteger(seqVal))
  ) {
    return undefined;
  }
  const sig = entry.get("sig");
  const runId = entry.get("runId");
  return {
    id,
    request,
    ops: normalizedOps,
    author: "mcp",
    status,
    createdAt: typeof createdAt === "number" ? createdAt : 0,
    seq: typeof seqVal === "number" ? seqVal : 0,
    // exactOptionalPropertyTypes: omit `sig` entirely when not a string.
    ...(typeof sig === "string" ? { sig } : {}),
    // Non-authoritative grouping hint, clamped to absent when over-length/non-string
    // (see readRecord) — a forged unbounded `runId` falls back to a singleton group.
    ...(isValidRunId(runId) ? { runId } : {}),
  };
}

/** All well-formed multi-file proposals, oldest first ([createdAt, seq, id]). */
export function getFileProposals(host: DocHost): FileProposalRecord[] {
  const out: FileProposalRecord[] = [];
  for (const [key, entry] of fileMailbox(host).entries()) {
    const rec = readFileRecord(entry, key);
    if (rec) out.push(rec);
  }
  out.sort(
    (a, b) =>
      a.createdAt - b.createdAt || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

/** The well-formed multi-file proposals still awaiting the browser's Accept/Reject. */
export function getPendingFileProposals(host: DocHost): FileProposalRecord[] {
  return getFileProposals(host).filter((p) => p.status === "pending");
}

/** One multi-file proposal by id, or undefined if absent/malformed. */
export function getFileProposal(host: DocHost, id: string): FileProposalRecord | undefined {
  return readFileRecord(fileMailbox(host).get(id), id);
}

/** Invoke `cb` whenever the multi-file mailbox may have changed (record or status). */
export function observeFileProposals(host: DocHost, cb: () => void): () => void {
  const map = fileMailbox(host);
  const handler = (): void => cb();
  map.observeDeep(handler);
  return () => map.unobserveDeep(handler);
}

/**
 * Record the browser's verdict for a multi-file proposal as one author-tagged
 * transaction (only the `status` field). Throws on an unknown id (house style).
 */
export function resolveFileProposal(
  host: DocHost,
  id: string,
  status: "accepted" | "rejected",
  author: Author,
): void {
  const record = fileMailbox(host).get(id);
  if (!(record instanceof Y.Map)) throw new Error(`resolveFileProposal: unknown proposal ${id}`);
  host.doc.transact(() => record.set("status", status), authorOrigin(author));
}

// ---------------------------------------------------------------------------
// Run grouping (ADR-0025 §5/§7, Task 2) — a PURE, READ-ONLY view that collapses
// a run's many pending proposals (single- and multi-file alike) into one card
// per `runId`. This is a UI/correlation read ONLY: `runId` NEVER gates apply,
// and this helper touches NO accept/resolve logic. A record without a valid
// `runId` becomes its own singleton "legacy run" keyed by its `id`. Caps mirror
// the per-proposal DoS posture: overflow is FLAGGED, never silently dropped.
// ---------------------------------------------------------------------------

/** One run's pending records, grouped for a single review card. */
export interface RunGroup {
  /** The shared `runId`, or — for a legacy/un-grouped record — that record's own `id`. */
  runId: string;
  /** This run's pending records, ordered by publish `seq` (oldest first). */
  records: Array<ProposalRecord | FileProposalRecord>;
  /**
   * Whether the run is still emitting proposals — read from the persisted
   * `mcpRuns` boundary state ({@link readRunOpen}), NOT inferred from record
   * counts (Task 3). A legacy/un-grouped singleton (whose `runId` is a record
   * id, never an `mcpRuns` key) is therefore never streaming. This is a UI hint
   * only — `streaming` never gates apply.
   */
  streaming: boolean;
  /**
   * Count of THIS group's pending records beyond {@link RECORDS_PER_RUN_MAX} that
   * were not included. `> 0` means the card must show "showing newest N of M";
   * the overflow is flagged, never silently dropped.
   */
  overflow: number;
}

/** The capped set of pending run groups plus group-level overflow accounting. */
export interface PendingRunGroups {
  /** At most {@link RUN_GROUP_MAX} groups, ordered by each group's minimum `seq`. */
  groups: RunGroup[];
  /** Total run groups that existed before the {@link RUN_GROUP_MAX} cap was applied. */
  totalGroups: number;
  /** True when more than {@link RUN_GROUP_MAX} groups existed and the oldest were capped. */
  overflow: boolean;
}

/**
 * Group every PENDING proposal (single- and multi-file) by `runId` for the
 * browser's run-card surface (ADR-0025 §5). Pure and read-only:
 *   - reuses the existing pending filters ({@link getPendingProposals} /
 *     {@link getPendingFileProposals}), so only `status: "pending"` records and
 *     only well-formed/in-cap records ever appear;
 *   - records sharing a valid `runId` group together; a record with no valid
 *     `runId` (absent on read, e.g. clamped over-length) becomes a SINGLETON
 *     group keyed by its own `id` — a "legacy run";
 *   - groups are ordered by their minimum `seq`; records within a group by `seq`;
 *   - caps mirror the per-proposal DoS posture: at most {@link RUN_GROUP_MAX}
 *     groups (newest kept) and {@link RECORDS_PER_RUN_MAX} records per group
 *     (newest kept), with overflow FLAGGED (`overflow` count / boolean), never
 *     silently dropped.
 * `runId` is non-authoritative — this view MUST NOT influence whether/how any
 * record is applied.
 */
export function getPendingRunGroups(host: DocHost): PendingRunGroups {
  const records: Array<ProposalRecord | FileProposalRecord> = [
    ...getPendingProposals(host),
    ...getPendingFileProposals(host),
  ];

  // Bucket by valid `runId`, or by the record's own id (singleton legacy run).
  // A Map preserves first-seen insertion order; we re-sort by min seq below.
  const buckets = new Map<string, Array<ProposalRecord | FileProposalRecord>>();
  for (const rec of records) {
    const key = isValidRunId(rec.runId) ? rec.runId : rec.id;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(rec);
    else buckets.set(key, [rec]);
  }

  const groups: RunGroup[] = [];
  for (const [runId, bucketRecords] of buckets) {
    // Intra-group: oldest-first by [seq, id] (deterministic; mirrors getProposals).
    bucketRecords.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Cap records-per-group, keeping the NEWEST (tail) like the "showing newest N
    // of M" render cap; flag the count dropped rather than hide it.
    const overflow = Math.max(0, bucketRecords.length - RECORDS_PER_RUN_MAX);
    const capped = overflow > 0 ? bucketRecords.slice(-RECORDS_PER_RUN_MAX) : bucketRecords;
    // `streaming` reads the persisted run boundary (Task 3): a real run with an
    // open `mcpRuns` entry is streaming; a legacy singleton (runId == record id)
    // has no entry, so readRunOpen returns false. Non-authoritative — UI only.
    groups.push({ runId, records: capped, streaming: readRunOpen(host, runId), overflow });
  }

  // Order groups by their minimum `seq` (oldest run first), id as a tie-break.
  groups.sort(
    (a, b) =>
      a.records[0]!.seq - b.records[0]!.seq ||
      (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
  );

  const totalGroups = groups.length;
  const overflow = totalGroups > RUN_GROUP_MAX;
  // Cap the group COUNT, keeping the NEWEST runs (tail) like the per-record cap.
  const cappedGroups = overflow ? groups.slice(-RUN_GROUP_MAX) : groups;
  return { groups: cappedGroups, totalGroups, overflow };
}
