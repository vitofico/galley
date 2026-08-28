/**
 * @galley/agent-client — public API surface (self-contained).
 *
 * This is the SHIPPED type declaration for the bundled `agent-client.mjs`: a
 * single file with NO `@galley/*` imports, so a consumer that vendors the bundle
 * needs nothing from the galley workspace to type it. Every type the public API
 * touches transitively (the `@galley/collab` mailbox contract, the `@galley/shared`
 * edit primitives, the project snapshot shape, the injectable socket) is INLINED
 * here. It happens to reference no external package types at all — `yjs` et al.
 * stay runtime-external in the `.mjs` but never surface in the public types.
 *
 * HAND-MAINTAINED, kept honest by two loud gates (see scripts/bundle.mjs):
 *   - `src/surface-contract.ts` — a compile-time bidirectional `IsExact` check of
 *     every export's SHAPE plus value-export name-set completeness, run by `tsc`.
 *   - `scripts/check-surface.mjs` — an exhaustive export name+kind parity check
 *     (TypeScript compiler API) that also catches a newly-ADDED type export.
 * If `src/index.ts` drifts from this file, one of those fails the bundle.
 */

// --- @galley/shared edit primitive (inlined; not re-exported by the package) ---

/** Search/replace edit block — the agent's editing primitive. */
interface EditBlock {
  /** Exact substring to find. Must be unique in the current source. */
  search: string;
  /** Text to replace it with. */
  replace: string;
}

// --- @galley/collab binary-asset pointer (inlined; not re-exported) ------------

/** A file-tree pointer to content-addressed bytes held in a BlobStore. */
interface BinaryAsset {
  type: "binary";
  /** Lowercase hex sha256 of the bytes — the blob's stable identity. */
  hash: string;
  /** Byte length, for display + quota accounting. */
  size: number;
  /** Best-effort media type. */
  mime: string;
}

// --- @galley/collab mailbox contract (re-exported by the package) --------------

export type ProposalStatus = "pending" | "accepted" | "rejected";

/** What a caller publishes (everything else — id, author, status — is minted server-side). */
export interface ProposalInput {
  /** Canonical project path of the target file (leading slash). */
  filePath: string;
  /** The file text the edit was computed against. */
  baseText: string;
  /** The full proposed text (base + edits applied to a scratch copy). */
  proposedText: string;
  /**
   * The original search/replace blocks. The browser's Accept re-applies these
   * conflict-aware when the live text moved past `baseText`, so a stale proposal
   * degrades to a surfaced conflict — never a clobber.
   */
  blocks: EditBlock[];
  /** The human-readable request/title shown in the review card. */
  request: string;
  /**
   * OPTIONAL non-authoritative run-correlation hint. When present, the browser
   * groups every pending record sharing this `runId` into one review card; absent
   * → the record forms its own singleton run. NEVER signed, NEVER gates apply.
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
  /** Per-process tie-break within one millisecond (part of the SIGNED set). */
  seq: number;
  /**
   * The kernel's base64url HMAC over the canonical proposal, or undefined for a
   * locally-published (unsigned) record. The manual Accept gate ignores it.
   */
  sig?: string;
}

/** One file operation in a multi-file proposal. */
export interface FileProposalOp {
  /**
   * `create` a new file, `edit` an existing one, `rename` an existing file to
   * `newPath`, `delete` (soft, recoverable) an existing file, or `create-binary`
   * — add a binary file POINTER to bytes already pushed over the blob channel.
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
   * `create-binary` ONLY: a content-addressed pointer to the bytes pushed over
   * the blob channel. Part of the SIGNED canonical view. ABSENT on every other op.
   */
  binaryAsset?: BinaryAsset;
}

/** What a caller publishes for a multi-file proposal (id/author/status minted server-side). */
export interface FileProposalInput {
  /** Human-readable request/title shown in the review card. */
  request: string;
  /** The change set — applied all-or-nothing on Accept. */
  ops: FileProposalOp[];
  /** OPTIONAL non-authoritative run-correlation hint — see {@link ProposalInput.runId}. */
  runId?: string;
}

/** A flattened, validated multi-file proposal record as read from the mailbox. */
export interface FileProposalRecord extends FileProposalInput {
  id: string;
  author: "mcp";
  status: ProposalStatus;
  createdAt: number;
  /** Signed per-process tie-break — see {@link ProposalRecord.seq}. */
  seq: number;
  /** The kernel's base64url HMAC over the canonical proposal, or undefined when unsigned. */
  sig?: string;
}

/**
 * Shared size limits for single-file proposal records. Enforced at publish time
 * (`publishProposal` throws) and re-checked at read time.
 */
export declare const PROPOSAL_LIMITS: {
  /** Max UTF-8 bytes for `baseText` and `proposedText`, each. */
  readonly maxTextBytes: number;
  /** Max search/replace blocks in one proposal. */
  readonly maxBlocks: 64;
  /** Max UTF-8 bytes for one block's `search` or `replace`, each. */
  readonly maxBlockBytes: number;
  /** Max characters for the `request` title. */
  readonly maxRequestChars: 500;
};

/**
 * Limits for multi-file proposal records. Per-op caps mirror {@link PROPOSAL_LIMITS};
 * aggregate caps bound the whole change set.
 */
export declare const FILE_PROPOSAL_LIMITS: {
  /** Max UTF-8 bytes for ONE op's `proposedText`. */
  readonly maxTextBytes: number;
  /** Max search/replace blocks in ONE edit op. */
  readonly maxBlocks: 64;
  /** Max UTF-8 bytes for one block's `search`/`replace`, each. */
  readonly maxBlockBytes: number;
  /** Max characters for the `request` title. */
  readonly maxRequestChars: 500;
  /** Max ops in one change set. */
  readonly maxOps: 32;
  /** Max SUM of UTF-8 bytes of every op's `proposedText`. */
  readonly maxTotalProposedBytes: number;
  /** Max SUM of `blocks.length` across all edit ops. */
  readonly maxTotalBlocks: 256;
  /** Max characters for one op's `path`. */
  readonly maxPathChars: 1024;
  /** Max characters for a record's `id`. */
  readonly maxIdChars: 128;
  /** Max BYTES of ONE `create-binary` op's blob. */
  readonly maxBlobBytes: number;
  /** Max SUM of every `create-binary` op's `size`. */
  readonly maxTotalBlobBytes: number;
  /** Max characters for a `create-binary` op's `mime`. */
  readonly maxMimeChars: 255;
};

/** Max characters for the non-authoritative `runId` grouping key. */
export declare const RUN_ID_MAX_LEN = 128;

// --- @galley/collab project snapshot (inlined; not re-exported) ----------------

interface ProjectFileSnapshot {
  fileId: string;
  path: string;
  text: string;
  deleted: boolean;
}

interface BinaryFileSnapshot {
  fileId: string;
  path: string;
  /** sha256 of the bytes — the BlobStore key (bytes are NOT in the CRDT). */
  hash: string;
  size: number;
  mime: string;
  deleted: boolean;
}

/** The whole project's state, with files sorted deterministically by [path, id]. */
interface ProjectSnapshot {
  files: ProjectFileSnapshot[];
  mainFileId: string | null;
  duplicatePaths: string[];
  /** Binary files (pointers; bytes live in a BlobStore). Present ONLY when the project has binaries. */
  binaryFiles?: BinaryFileSnapshot[];
}

// --- injectable socket (inlined; not re-exported) -----------------------------

/** The slice of the standard WebSocket API the transport needs. */
interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

// --- the draft-publisher client (this package's own surface) -------------------

/** The default agent identity a draft publisher presents in presence/attribution. */
export declare const DRAFT_PUBLISHER_RUN_ID = "draft-publisher";

export interface DraftPublisherConfig {
  /** The relay endpoint, e.g. `ws://127.0.0.1:8080` — no trailing room path. */
  syncUrl: string;
  /**
   * The project's share-room CAPABILITY (copied from the browser's Share surface).
   * The client only ever JOINS this room — it never creates, lists, or probes rooms.
   */
  room: string;
}

export interface DraftPublisherOptions {
  /** Injectable socket for tests; defaults to the `ws` package. */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * The `runId` of the `{ kind: "agent" }` author this client presents. Always an
   * AGENT identity — a headless bot must never masquerade as a human peer.
   * Defaults to {@link DRAFT_PUBLISHER_RUN_ID}.
   */
  agentRunId?: string;
}

export interface DraftPublisher {
  /**
   * Resolves once the relay's initial state has been applied (the first sync
   * step2). Rejects on timeout, and PROMPTLY if the link drops or the client is
   * torn down while the sync is still in flight.
   */
  whenSynced(timeoutMs?: number): Promise<void>;
  /** The replicated project's current files (compute `baseText` for edits here). */
  snapshot(): ProjectSnapshot;
  /**
   * Publish a single-file proposal, UNSIGNED (manual Accept gate only). Resolves
   * to the minted proposal id; rejects with the mailbox's typed size-violation
   * error on an over-cap input. Local until {@link flush}/{@link close} confirms delivery.
   */
  publishProposal(input: ProposalInput): Promise<string>;
  /** Publish a multi-file proposal, UNSIGNED — see {@link publishProposal}. */
  publishFileProposal(input: FileProposalInput): Promise<string>;
  /** One single-file proposal by id (undefined if absent/malformed). */
  getProposal(id: string): ProposalRecord | undefined;
  /** All well-formed single-file proposals, oldest first. */
  getProposals(): ProposalRecord[];
  /** One multi-file proposal by id (undefined if absent/malformed). */
  getFileProposal(id: string): FileProposalRecord | undefined;
  /** All well-formed multi-file proposals, oldest first. */
  getFileProposals(): FileProposalRecord[];
  /**
   * Invoke `cb` whenever the single-file mailbox may have changed. Unsubscribe
   * with the returned function.
   */
  observeProposals(cb: () => void): () => void;
  /** Like {@link observeProposals}, for the multi-file mailbox. */
  observeFileProposals(cb: () => void): () => void;
  /**
   * Round-trip delivery barrier: resolves once the relay has APPLIED every frame
   * sent so far into the LIVE room doc. Confirms delivery, NOT persistence.
   * Rejects on timeout, after {@link close}/{@link destroy}, or if the single-shot
   * link dropped.
   */
  flush(timeoutMs?: number): Promise<void>;
  /**
   * Explicit flush-then-disconnect: awaits the flush round-trip so a short-lived
   * publish is APPLIED to the live room BEFORE the socket closes, then tears the
   * client down. Rethrows the flush error (after tearing down) when delivery
   * could not be confirmed.
   */
  close(timeoutMs?: number): Promise<void>;
  /** Tear down WITHOUT flushing (abandon): pending flushes reject. Idempotent. */
  destroy(): void;
}

/**
 * Connect to `{syncUrl, room}` and return the joined draft-publisher handle.
 * Connection is lazy/synchronous; await {@link DraftPublisher.whenSynced} before
 * reading, and ALWAYS finish a publish run with {@link DraftPublisher.close}.
 */
export declare function connectDraftPublisher(
  config: DraftPublisherConfig,
  opts?: DraftPublisherOptions,
): DraftPublisher;

// A `.d.ts` module with only inline `export` modifiers leaks its plain top-level
// declarations as exports too; this empty statement flips the file to strict
// module semantics so the inlined helpers above (EditBlock, BinaryAsset,
// ProjectSnapshot & friends, WebSocketLike) stay module-LOCAL — the surface then
// exports EXACTLY what src/index.ts does.
export {};
