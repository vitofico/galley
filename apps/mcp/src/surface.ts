/**
 * The kernel's wrapped capability surface (#16.1, ADR-0020).
 *
 * ADR-0020's hard invariant: "tool handlers get a wrapped surface that can only
 * read file text and write proposal records". This module IS that wrapper — the
 * tool layer (server.ts) receives a `ToolSurface` and never the `CollabProject`,
 * so no tool handler can reach `transactFile`/`create`/`delete`/`rename` or any
 * other mutator. The ONLY write this surface exposes is `publishProposal`, which
 * writes a pending-proposal record into the shared mailbox (and provably never
 * file text — see the mailbox tests + the kernel integration test).
 *
 * #16.2a widens the READ side only — `listFiles`/`readFile` give tools
 * single-project read context (bounded by READ_LIMITS) — while the write scope
 * stays exactly one proposal mailbox keyed to the session's one target file.
 *
 * #16.2b adds `projectContext`: budget-limited, query-relevant excerpts across
 * the WHOLE live project (chunk → BM25 rank → select, the same retrieval
 * substrate as the in-app agent loop), with provenance and honest skip
 * accounting — still read-only, still metadata-first, still hard-bounded in
 * both WORK and OUTPUT.
 */
import * as Y from "yjs";
import { chunkDocument, selectContext, type Chunk } from "@galley/agent";
import {
  CollabProject,
  PROPOSAL_LIMITS,
  publishProposal,
  publishFileProposal,
  getProposal,
  getFileProposal,
  observeProposals,
  observeFileProposals,
  markRunOpen,
  markRunClosed,
  mintRunId,
  type ProposalInput,
  type ProposalRecord,
  type FileProposalInput,
  type ProposalSigner,
} from "@galley/collab";
import type { Author, CompileInput } from "@galley/shared";

/**
 * Read-side response caps (#16.2a), in the same spirit as PROPOSAL_LIMITS:
 * everything the kernel sends back to an MCP client is bounded, because the
 * replicated room is peer-writable and a hostile peer can seed arbitrarily
 * large files or forged path strings straight into the Y.Maps. And not just
 * the OUTPUT: the WORK done to produce it is bounded too (Security round 2) —
 * reads scan the cheap file metadata first and only materialize Y.Text bodies
 * once every cap has been applied, under a per-call sizing budget.
 */
export const READ_LIMITS = {
  /**
   * Max UTF-8 bytes of file text one read tool call returns — mirrors
   * PROPOSAL_LIMITS.maxTextBytes (itself the ADR-0015 per-file compile cap).
   * An over-cap file is refused with a structured error, never dumped — and
   * never even materialized when the cheap O(1) Y.Text length (UTF-16 code
   * units, a lower bound on UTF-8 bytes) already exceeds the cap.
   */
  maxFileBytes: PROPOSAL_LIMITS.maxTextBytes,
  /**
   * Max characters of a file path surfaced by listFiles / accepted by
   * read_file. A live entry with a longer (necessarily forged — the UI cannot
   * create it) path is SKIPPED like any other malformed record, matching the
   * mailbox's forged-record tolerance: it never surfaces, it only counts.
   */
  maxPathChars: 1024,
  /** Max entries one listFiles result carries (excess is marked truncated). */
  maxListEntries: 500,
  /**
   * Cumulative sizing budget for ONE listFiles call, in UTF-16 code units of
   * source text actually materialized to compute exact UTF-8 sizes. Once a
   * call has spent it, remaining entries report the O(1) Y.Text length as an
   * honest lower bound (`sizeExact: false`) instead of encoding — so a room
   * seeded with hundreds of huge files cannot turn one cheap listing into
   * gigabytes of string work.
   */
  maxSizingChars: 8 * 1024 * 1024,
  /**
   * Max characters of a projectContext query (the BM25 ranking input). Long
   * queries add work linear in chunk count; a hostile client gets a refusal,
   * never amplified ranking cost.
   */
  maxQueryChars: 1024,
  /**
   * projectContext response budget (chars of excerpt TEXT) — caller-tunable
   * between min and max, defaulting to the agent loop's own selection budget
   * (DEFAULT_SELECT_MAX_CHARS-sized). The response NEVER carries more excerpt
   * text than this, even when the single best chunk is bigger (it is cut to a
   * prefix and flagged `truncated`).
   */
  minContextChars: 256,
  maxContextChars: 32 * 1024,
  defaultContextChars: 6 * 1024,
  /**
   * Max excerpts one projectContext result carries — bounds the provenance
   * METADATA channel (paths/line ranges/heading paths) the way the char budget
   * bounds the text channel, so thousands of tiny hostile chunks cannot turn
   * one call into a megabyte of records.
   */
  maxContextExcerpts: 64,
  /**
   * Max characters of ONE headingPath entry surfaced as excerpt provenance
   * (longer hostile headings are cut to this + an ellipsis, flagged via
   * `headingPathTruncated`). Applied at CHUNK COLLECTION time, before BM25 —
   * so a megabyte-scale heading can neither ride the metadata channel nor
   * amplify ranking work (Security round 2, finding 1).
   */
  maxHeadingChars: 200,
  /**
   * Max headingPath DEPTH surfaced (the most specific entries win). Hostile
   * `=`-ladder nesting otherwise grows the per-chunk provenance — and the
   * per-chunk ranking text — linearly with file lines.
   */
  maxHeadingDepth: 8,
  /**
   * Fixed per-excerpt charge (chars) against the response budget for the
   * non-text record fields (line numbers, flags, JSON keys). With path +
   * bounded headings charged exactly and this constant on top, the SERIALIZED
   * response scales with the budget — never with excerpt count alone.
   */
  excerptOverheadChars: 128,
  /**
   * Max chunks one projectContext call collects + ranks. Collection STOPS
   * here (`chunksTruncated`; files never reached are skipped "chunk-cap"), so
   * a tiny-heading chunk storm inside an in-cap file cannot amplify into
   * unbounded BM25/sort work (Security round 2, finding 3).
   */
  maxContextChunks: 2048,
  /**
   * Cumulative materialization budget for ONE projectContext call, in UTF-16
   * code units of file text actually materialized for chunking + ranking
   * (the same spirit as maxSizingChars). Once spent, the scan STOPS: every
   * remaining file is skipped with reason "scan-budget" and the result is
   * flagged `scanTruncated` — a room seeded with hundreds of huge files cannot
   * turn one context call into gigabytes of string work.
   */
  maxContextScanChars: 8 * 1024 * 1024,
} as const;

const utf8 = new TextEncoder();

/** UTF-8 byte length of `text` (the unit every read/proposal cap is in). */
export function utf8ByteLength(text: string): number {
  return utf8.encode(text).length;
}

/**
 * How long an OPEN agent run waits, with no new proposal, before the surface
 * marks it closed (ADR-0025 §5, Task 3). A run STARTS on the first `propose_*`
 * when none is open and reuses that `runId` for every later proposal; the idle
 * timer is reset on each proposal and, when it finally fires, persists a run-end
 * boundary (`markRunClosed`) so a run card stops saying "in progress". Idle-close
 * is a bounded UX fallback — it NEVER accepts or rejects anything (§8.4).
 */
export const RUN_IDLE_MS = 60_000;

/**
 * The high-value read caps the kernel may lower via launch args (D2). Each is
 * OPTIONAL; an absent field keeps the {@link READ_LIMITS} default byte-for-byte.
 * Only these three are tunable — the security/anti-abuse caps (path length,
 * sizing/scan budgets, chunk/excerpt caps) are NOT operator-overridable.
 */
export interface ReadLimitOverrides {
  /** Max UTF-8 bytes a read tool returns (default {@link READ_LIMITS.maxFileBytes}). */
  maxFileBytes?: number;
  /** Default projectContext budget (default {@link READ_LIMITS.defaultContextChars}). */
  defaultContextChars?: number;
  /** Max list_files entries (default {@link READ_LIMITS.maxListEntries}). */
  maxListEntries?: number;
}

/** Tunable seams for the surface's run-boundary tracking (Task 3) — tests inject these. */
export interface ToolSurfaceOptions {
  /** Idle window before an open run auto-closes. Default {@link RUN_IDLE_MS}. */
  runIdleMs?: number;
  /**
   * Lowered read caps from the kernel's launch args (D2). Merged over
   * {@link READ_LIMITS}; absent ⇒ the defaults, unchanged. The caller is
   * responsible for validating values (config.ts bounds them); the surface
   * trusts what it is handed here.
   */
  readLimits?: ReadLimitOverrides;
  /** Injectable wall clock for run-boundary timestamps. Default Date.now. */
  now?: () => number;
  /**
   * Register the run-timer disposer so the kernel can clear it on shutdown
   * (session.destroy). The surface also `.unref()`s its timer, so a forgotten
   * disposer never keeps Node alive — this is belt-and-braces cleanup.
   */
  registerDisposer?: (dispose: () => void) => void;
}

/** A structured read of the scoped file (never throws across the tool boundary). */
export type ReadOutcome =
  | { ok: true; path: string; text: string }
  | { ok: false; error: string };

/**
 * The structured pointer `read_file` returns for a BINARY file (A3): the project
 * stores binary files (images, PDFs) as a content-addressed pointer in a SEPARATE
 * map (collab's `binaryMeta`), bytes held in a BlobStore, NEVER in the CRDT. So a
 * binary path has no Y.Text to return — read_file surfaces this metadata instead
 * (`kind:"binary"` discriminates it from a text read). The BYTES are out of scope:
 * returning them needs a transport this read seam does not have.
 */
export interface BinaryReadPointer {
  ok: true;
  kind: "binary";
  path: string;
  /** Lowercase-hex sha256 of the bytes — the BlobStore key. */
  hash: string;
  /** Byte length of the blob. */
  size: number;
  /** Best-effort media type recorded on the pointer. */
  mime: string;
}

/**
 * What `readFile` yields: a text read (the historical {@link ReadOutcome} shapes,
 * byte-for-byte) OR a binary pointer (A3) when the path resolves to a binary file.
 * A text-file read is indistinguishable from before; only a binary path produces
 * the new `kind:"binary"` variant.
 */
export type FileReadOutcome = ReadOutcome | BinaryReadPointer;

/** One live file in a listing: its exact path + a bounded-cost size. */
export interface FileListEntry {
  path: string;
  /**
   * Exact UTF-8 bytes when `sizeExact`, else a cheap LOWER BOUND (the O(1)
   * Y.Text length in UTF-16 code units — always <= the true UTF-8 size).
   * For a BINARY entry this is the pointer's exact byte size (always exact).
   */
  sizeBytes: number;
  /** False when this entry's size was not encoded (sizing budget spent). */
  sizeExact: boolean;
  /** True when 2+ live files hold this same path (a CRDT duplicate-path conflict). */
  duplicate: boolean;
  /**
   * Present (F14) only for a BINARY file — a content-addressed pointer the agent
   * can pass to read_file. Text rows omit these fields entirely (kind undefined),
   * so a text listing is byte-for-byte unchanged from before.
   */
  kind?: "binary";
  /** A binary entry's sha256 content address (omitted for text). */
  hash?: string;
  /** A binary entry's media type (omitted for text). */
  mime?: string;
}

/** A structured listing of the project's live files (never throws). */
export type ListOutcome =
  | {
      ok: true;
      files: FileListEntry[];
      /** True when live files past READ_LIMITS.maxListEntries were cut off. */
      truncated: boolean;
      /** Live entries hidden because their forged path exceeds maxPathChars. */
      omitted: number;
    }
  | { ok: false; error: string };

/** Why a live file contributed no excerpts to a projectContext result. */
export type ContextSkipReason = "duplicate-path" | "over-cap" | "scan-budget" | "chunk-cap";

/** A live file projectContext excluded, with the honest reason. */
export interface ContextSkippedFile {
  path: string;
  reason: ContextSkipReason;
}

/** One query-relevant excerpt, with provenance back to the live project. */
export interface ContextExcerpt {
  path: string;
  /** 1-based inclusive line range of `text` within its file. */
  startLine: number;
  endLine: number;
  /**
   * The Typst heading path of the section the excerpt belongs to — BOUNDED:
   * each entry is cut to READ_LIMITS.maxHeadingChars (+ "…") and only the
   * most specific READ_LIMITS.maxHeadingDepth entries survive.
   */
  headingPath: string[];
  /** True when headingPath was cut (entry length or depth) from the source. */
  headingPathTruncated: boolean;
  /** An EXACT slice of the file (a structural chunk, or its budget-cut prefix). */
  text: string;
  /** True when this excerpt is a budget-cut PREFIX of an over-budget chunk. */
  truncated: boolean;
}

/** A structured whole-project context selection (never throws). */
export type ContextOutcome =
  | {
      ok: true;
      /** Budget-limited excerpts in stable order (file order, then offset). */
      excerpts: ContextExcerpt[];
      /** Live files excluded from ranking, each with its reason. */
      skipped: ContextSkippedFile[];
      /** Live entries hidden because their forged path exceeds maxPathChars. */
      omitted: number;
      /** True when live files past READ_LIMITS.maxListEntries were never considered. */
      filesTruncated: boolean;
      /** True when the materialization budget cut the scan short. */
      scanTruncated: boolean;
      /** True when chunk collection hit READ_LIMITS.maxContextChunks. */
      chunksTruncated: boolean;
      /** True when ranked chunks beyond the response budget were left out. */
      selectionTruncated: boolean;
    }
  | { ok: false; error: string };

/**
 * Which mailbox a published proposal lives in — the single-file `propose_edit`
 * mailbox, or the multi-file `propose_files` one. Drives which collab
 * get/observe pair {@link ToolSurface.awaitProposalResolution} reads.
 */
export type ProposalKind = "single" | "file";

/**
 * The terminal disposition of a published proposal as the kernel observed it,
 * or "timeout" when no verdict replicated within the await window. Lets the
 * tool layer tell the agent the HONEST truth about what happened to its
 * proposal instead of an unconditional "a human must Accept it".
 */
export type ProposalResolution = "accepted" | "rejected" | "timeout";

export interface ToolSurface {
  /** The session's one target file path (for messages/results). */
  readonly filePath: string;
  /**
   * Whether this session can produce AUTO-ACCEPTABLE proposals (ADR-0023): true
   * exactly when a per-grant signer is bound, because the signature is the only
   * thing the browser's auto-accept applier authenticates. When false, every
   * proposal awaits a manual human Accept and the tool layer says so verbatim;
   * when true, the tool layer awaits the actual verdict before answering, so it
   * never claims "pending — a human must Accept" about a proposal the browser is
   * already applying.
   */
  readonly autoAcceptEligible: boolean;
  /**
   * Await the browser's verdict on a just-published proposal (ADR-0023): the
   * auto-accept applier flips the record's `status` to "accepted"/"rejected"
   * and that change replicates back into this peer's doc. Resolves to that
   * terminal status, or "timeout" if none arrives within `timeoutMs`.
   *
   * Race-safe: it subscribes to the mailbox FIRST, then immediately re-reads
   * the current status, so a verdict that lands between publish and subscribe
   * is never missed. Always unsubscribes and clears its timer. Read-only — it
   * only observes; it never resolves the proposal itself.
   */
  awaitProposalResolution(
    kind: ProposalKind,
    id: string,
    timeoutMs: number,
  ): Promise<ProposalResolution>;
  /** READ: the scoped file's current replicated text. */
  readDocument(): ReadOutcome;
  /**
   * READ (#16.2a): the project's live (non-deleted) files — exact path +
   * bounded-cost size — in the deterministic [path, fileId] order, bounded by
   * READ_LIMITS (entries, path length, AND sizing work). Listing only; write
   * scope is untouched.
   */
  listFiles(): ListOutcome;
  /**
   * READ (#16.2a): the live replicated text of ANY project file by EXACT path
   * (a VFS key as listed by listFiles — no normalization, no traversal
   * semantics). Requires exactly ONE live match (duplicate-path conflicts are
   * a structured refusal) and enforces the READ_LIMITS.maxFileBytes cap before
   * the text is even materialized. Structured errors; never throws.
   *
   * A3: when the EXACT path resolves to a BINARY file (collab's `binaryMeta`,
   * not a Y.Text), it returns a {@link BinaryReadPointer} ({ kind:"binary", path,
   * hash, size, mime }) instead of text — the bytes live in a BlobStore and are
   * out of scope for this read seam. A text path behaves exactly as before.
   */
  readFile(path: string): FileReadOutcome;
  /**
   * READ (#16.2b): budget-limited, query-relevant excerpts across the WHOLE
   * live project, with provenance (path + 1-based line range + heading path).
   * Structural chunking + BM25 selection (the @galley/agent retrieval
   * substrate) over every live, unique-path, in-cap file — under BOTH a
   * cumulative materialization budget (READ_LIMITS.maxContextScanChars) and
   * the response budget (`budgetChars`, default/clamped per READ_LIMITS).
   * Duplicate-path, over-cap, and past-budget files are skipped with an honest
   * reason, never silently. Read-only; structured errors; never throws.
   */
  projectContext(query: string, budgetChars?: number): ContextOutcome;
  /**
   * READ: what the compile service should check — the whole project's compile
   * input when it is valid (so cross-file imports resolve, matching the browser
   * preview), else the scoped file's text alone.
   */
  compileInput(): CompileInput | { error: string };
  /**
   * WRITE: park a single-file pending proposal in the shared mailbox. ASYNC
   * because publishing may sign the record (ADR-0023) — the kernel will pass a
   * signer here in a later slice; today it forwards none.
   */
  publishProposal(input: Omit<ProposalInput, "filePath">): Promise<string>;
  /**
   * WRITE: park a MULTI-FILE pending proposal (create + edit change set) in the
   * sibling mailbox. Each op carries its own path (no session-file injection);
   * like {@link publishProposal} it writes ONLY the mailbox, never file text —
   * the browser's Accept gate lands the whole set atomically. ASYNC (signing).
   */
  publishFileProposal(input: FileProposalInput): Promise<string>;
  /** READ: a published proposal's current record (for status reporting). */
  getProposal(id: string): ProposalRecord | undefined;
}

/**
 * The CollabProject CRDT map names (packages/collab/src/collab-project.ts).
 * Reaching them through the PUBLIC `project.doc` lets every read here scan the
 * cheap metadata WITHOUT materializing any Y.Text body — `snapshot()` would
 * stringify every file (tombstones included) before our caps could apply,
 * which is exactly the unbounded-work hole the Security round flagged. The
 * duplication of these two literals is pinned by a surface test that checks
 * the cheap scan agrees with `snapshot()` on a real project — a rename in
 * collab fails that test loudly, never silently.
 */
const FILE_META = "fileMeta";
const FILE_TEXTS = "fileTexts";
/**
 * The binary-file pointer map (collab's `BINARY_META`, #7 slice 7B): fileId →
 * Y.Map { path, hash, size, mime, deleted }. Bytes are NOT in the CRDT — only
 * this content-addressed pointer is. Read here (text-free, like FILE_META) so a
 * binary path resolves to its pointer without ever touching a Y.Text. Pinned by
 * a surface test against collab's `snapshot().binaryFiles` — a collab rename
 * fails it loudly, never silently.
 */
const BINARY_META = "binaryMeta";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Project paths are absolute — the same canonicalization collab applies. */
const canonicalizePath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/** A live file's cheap identity: id + canonical path. NO text is touched. */
interface LiveEntry {
  fileId: string;
  path: string;
}

/**
 * Text-free scan of the live (non-deleted) files, in the same deterministic
 * [path, fileId] order as `snapshot()`. Forged meta records (non-Y.Map value,
 * non-string path) are skipped like any other malformed entry. Cost: O(N log N)
 * over file COUNT — independent of file sizes.
 */
function liveEntries(project: CollabProject): LiveEntry[] {
  const metaMap = project.doc.getMap<unknown>(FILE_META);
  const out: LiveEntry[] = [];
  metaMap.forEach((meta, fileId) => {
    if (!(meta instanceof Y.Map)) return;
    if (meta.get("deleted") === true) return;
    const raw = meta.get("path");
    if (typeof raw !== "string") return;
    out.push({ fileId, path: canonicalizePath(raw) });
  });
  out.sort((a, b) => (a.path === b.path ? cmp(a.fileId, b.fileId) : cmp(a.path, b.path)));
  return out;
}

/** A file's Y.Text by id — `.length` is O(1); only `.toString()` materializes. */
function liveText(project: CollabProject, fileId: string): Y.Text | undefined {
  const text = project.doc.getMap<unknown>(FILE_TEXTS).get(fileId);
  return text instanceof Y.Text ? text : undefined;
}

/** A live binary file's cheap pointer (A3): canonical path + content-address. */
interface LiveBinaryEntry {
  path: string;
  hash: string;
  size: number;
  mime: string;
}

/**
 * Text-free scan of the live (non-deleted) BINARY files, mirroring
 * {@link liveEntries}: deterministic [path, fileId] order, forged/malformed
 * records (non-Y.Map value, non-string path, non-string hash) skipped like any
 * other bad entry. Bytes are never touched — only the pointer fields. The
 * deleted/path posture matches collab's `getBinary`/`allBinaryFiles`.
 */
function liveBinaryEntries(project: CollabProject): LiveBinaryEntry[] {
  const metaMap = project.doc.getMap<unknown>(BINARY_META);
  const out: { fileId: string; entry: LiveBinaryEntry }[] = [];
  metaMap.forEach((meta, fileId) => {
    if (!(meta instanceof Y.Map)) return;
    if (meta.get("deleted") === true) return;
    const rawPath = meta.get("path");
    const rawHash = meta.get("hash");
    if (typeof rawPath !== "string" || typeof rawHash !== "string") return;
    const rawSize = meta.get("size");
    const rawMime = meta.get("mime");
    out.push({
      fileId,
      entry: {
        path: canonicalizePath(rawPath),
        hash: rawHash,
        size: typeof rawSize === "number" ? rawSize : 0,
        mime: typeof rawMime === "string" ? rawMime : "application/octet-stream",
      },
    });
  });
  out.sort((a, b) =>
    a.entry.path === b.entry.path ? cmp(a.fileId, b.fileId) : cmp(a.entry.path, b.entry.path),
  );
  return out.map((o) => o.entry);
}

/** Start offset of every line in `text` (index i = 0-based line i's start). */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * Bound a chunk's heading-path provenance (Security round 2, finding 1): keep
 * only the most specific READ_LIMITS.maxHeadingDepth entries and cut each to
 * READ_LIMITS.maxHeadingChars (+ an ellipsis marker). Applied BEFORE ranking,
 * so hostile megabyte headings never reach BM25's per-chunk searchable text.
 */
function boundedHeadingPath(headingPath: string[]): { entries: string[]; truncated: boolean } {
  const depthCut = headingPath.length > READ_LIMITS.maxHeadingDepth;
  const tail = depthCut ? headingPath.slice(-READ_LIMITS.maxHeadingDepth) : headingPath;
  let truncated = depthCut;
  const entries = tail.map((h) => {
    if (h.length <= READ_LIMITS.maxHeadingChars) return h;
    truncated = true;
    // Never split a surrogate pair at the cut: a trailing lone HIGH surrogate
    // backs the cut off one unit (bounded either way; this keeps it clean).
    const last = h.charCodeAt(READ_LIMITS.maxHeadingChars - 1);
    const cut =
      last >= 0xd800 && last <= 0xdbff
        ? READ_LIMITS.maxHeadingChars - 1
        : READ_LIMITS.maxHeadingChars;
    return `${h.slice(0, cut)}…`;
  });
  return { entries, truncated };
}

/**
 * True when [start,end) is `=`+ then a space/tab — a POTENTIAL Typst heading
 * line per packages/agent/src/chunk.ts's HEADING_RE (over-permissive on
 * purpose: empty titles count too, keeping the estimate an upper bound).
 */
function maybeHeadingLine(s: string, start: number, end: number): boolean {
  let i = start;
  while (i < end && s.charCodeAt(i) === 61 /* = */) i++;
  if (i === start) return false;
  const c = i < end ? s.charCodeAt(i) : -1;
  return c === 32 /* space */ || c === 9 /* tab */;
}

/** True when [start,end) holds only spaces/tabs (a blank line; "" counts). */
function isBlankLine(s: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * O(n) UPPER BOUND on `chunkDocument(body).length`, computed WITHOUT building
 * any chunk (Security round 3): chunkDocument splits sections at heading
 * lines and packs each section into at most one chunk per paragraph
 * (paragraph cuts are `\n[ \t]*\n+` runs, each consuming >= 1 blank line;
 * every packed span holds >= 1 whole paragraph). So: potential heading lines
 * + 1 preamble + blank lines. Exported for the test pin that this bound holds
 * against the real chunker — the creation cap rests on it.
 */
export function estimateChunks(body: string): number {
  let n = 1; // the preamble section
  let lineStart = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body.charCodeAt(i) === 10 /* \n */) {
      if (i === body.length && lineStart === i) break; // no final line
      if (maybeHeadingLine(body, lineStart, i) || isBlankLine(body, lineStart, i)) n++;
      lineStart = i + 1;
    }
  }
  return n;
}

/**
 * Largest LINE-BOUNDARY prefix of `body` whose {@link estimateChunks} fits
 * `capacity` — the input-side chunk cap (Security round 3): chunkDocument
 * eagerly builds every section+chunk for whatever it is given, so the cap
 * must bound its INPUT, not just what the caller retains. Returns 0 when not
 * even the first line fits.
 */
export function chunkSafePrefix(body: string, capacity: number): number {
  let estimate = 1; // the preamble section
  let cut = 0;
  let lineStart = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || body.charCodeAt(i) === 10 /* \n */) {
      if (i === body.length && lineStart === i) break; // no final line
      const cost =
        maybeHeadingLine(body, lineStart, i) || isBlankLine(body, lineStart, i) ? 1 : 0;
      if (estimate + cost > capacity) return cut;
      estimate += cost;
      cut = i === body.length ? i : i + 1;
      lineStart = i + 1;
    }
  }
  return cut;
}

/** 1-based line number containing `offset` (binary search over line starts). */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * The session-scoped file for readDocument/compileInput: FIRST live match in
 * deterministic order (the pre-16.2a `snapshot().find` semantics, preserved
 * byte-for-byte) — but now only THAT one file's text is ever materialized.
 */
function liveFile(project: CollabProject, path: string): { path: string; text: string } | undefined {
  const entry = liveEntries(project).find((e) => e.path === path);
  if (!entry) return undefined;
  return { path: entry.path, text: liveText(project, entry.fileId)?.toString() ?? "" };
}

/**
 * Build the read+propose-only capability over one project + one file. The
 * returned object closes over the project — it never escapes to the tool layer.
 */
export function createToolSurface(
  project: CollabProject,
  filePath: string,
  author: Author,
  /**
   * The per-grant proposal signer (ADR-0023 §1), or undefined for a local/
   * un-paired join. When present, every published proposal carries an HMAC `sig`
   * the browser can authenticate; when absent, proposals publish unsigned (still
   * manually reviewable, never auto-acceptable).
   */
  signer?: ProposalSigner,
  options: ToolSurfaceOptions = {},
): ToolSurface {
  // A bound signer is the ONLY thing that makes a proposal auto-acceptable
  // (ADR-0023 §1) — so its mere presence decides whether the tool layer should
  // await a verdict (signed/auto-accept) or report manual-review immediately.
  const autoAcceptEligible = signer !== undefined;

  // Effective read caps (D2): the READ_LIMITS defaults with the kernel's
  // launch-arg overrides merged on top. Only the three high-value caps are
  // tunable; every anti-abuse cap stays at its READ_LIMITS value. With no
  // overrides this is byte-for-byte READ_LIMITS, so the shipped path is
  // unchanged. config.ts has already validated/bounded any override.
  const maxFileBytes = options.readLimits?.maxFileBytes ?? READ_LIMITS.maxFileBytes;
  const maxListEntries = options.readLimits?.maxListEntries ?? READ_LIMITS.maxListEntries;
  const defaultContextChars =
    options.readLimits?.defaultContextChars ?? READ_LIMITS.defaultContextChars;

  // --- Run boundaries (ADR-0025 §5, Task 3) ---------------------------------
  // The surface owns one agent run's lifecycle: a run STARTS on the first
  // `propose_*` when none is open, every later proposal reuses the same CSPRNG
  // `runId` (and resets the idle timer), and the run ENDS when `runIdleMs`
  // passes with no new proposal (`markRunClosed`). The `runId` is threaded into
  // every publish so the browser collapses the run into one review card. This is
  // a UI/correlation hint ONLY — it never gates apply (the per-record Accept gate
  // is untouched).
  const runIdleMs = options.runIdleMs ?? RUN_IDLE_MS;
  const now = options.now ?? Date.now;
  let currentRunId: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const closeRun = (): void => {
    clearIdleTimer();
    if (currentRunId === undefined) return;
    // Persist the run-end boundary so a run card survives reload/disconnect and
    // stops saying "in progress". Never accepts/rejects — boundary only.
    markRunClosed(project, currentRunId, now());
    currentRunId = undefined;
  };
  // Tag the proposal about to be published with the open run's id, starting a
  // new run (and persisting markRunOpen) when none is open, and (re)arming the
  // idle-close timer. Returns the runId to thread into the publish call.
  const beginProposalRun = (): string => {
    const at = now();
    if (currentRunId === undefined) currentRunId = mintRunId();
    markRunOpen(project, currentRunId, at);
    clearIdleTimer();
    idleTimer = setTimeout(closeRun, runIdleMs);
    // The idle timer must never keep the Node process alive on its own (a closed
    // tab / finished CLI run should exit cleanly) — unref it where supported.
    (idleTimer as { unref?: () => void }).unref?.();
    return currentRunId;
  };
  // Hand the kernel a disposer (session.destroy) so an in-flight idle timer is
  // cleared on teardown — defense in depth on top of the unref above.
  options.registerDisposer?.(clearIdleTimer);

  return {
    filePath,
    autoAcceptEligible,

    awaitProposalResolution(
      kind: ProposalKind,
      id: string,
      timeoutMs: number,
    ): Promise<ProposalResolution> {
      // Read the CURRENT terminal disposition of this id (undefined = not yet a
      // verdict, or record absent — both keep waiting). One re-read function
      // for the initial race-close check AND every observer callback.
      const terminalStatus = (): "accepted" | "rejected" | undefined => {
        const record = kind === "file" ? getFileProposal(project, id) : getProposal(project, id);
        const status = record?.status;
        return status === "accepted" || status === "rejected" ? status : undefined;
      };
      return new Promise<ProposalResolution>((resolve) => {
        let settled = false;
        let unsubscribe: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (outcome: ProposalResolution): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          // Defensive: a malformed observer teardown must not strand the await.
          try {
            unsubscribe?.();
          } catch {
            /* the resolution already happened; teardown noise is irrelevant */
          }
          resolve(outcome);
        };
        const check = (): void => {
          const status = terminalStatus();
          if (status !== undefined) finish(status);
        };
        // SUBSCRIBE FIRST so a verdict landing during setup is queued, not lost.
        const observe = kind === "file" ? observeFileProposals : observeProposals;
        unsubscribe = observe(project, check);
        // THEN re-read: a verdict already present (raced ahead of subscribe)
        // resolves now; this is what makes the await order-independent.
        check();
        if (settled) return;
        timer = setTimeout(() => finish("timeout"), timeoutMs);
      });
    },

    readDocument(): ReadOutcome {
      const file = liveFile(project, filePath);
      if (!file) {
        return {
          ok: false,
          error: `file ${filePath} is not present in this room (deleted or never created)`,
        };
      }
      return { ok: true, path: file.path, text: file.text };
    },

    listFiles(): ListOutcome {
      try {
        // Cheap metadata pass FIRST (no text): live-only, forged over-long
        // paths skipped, duplicate-path counts, deterministic order, entry cap
        // — only the entries that actually surface get sized at all. (F14) The
        // pass spans BOTH text and binary files so the agent sees the binaries
        // it pushed; the duplicate-path count is taken over the UNION so a
        // text↔binary collision is flagged on both rows, matching readFile's
        // cross-map conflict refusal.
        const live = liveEntries(project);
        const liveBinary = liveBinaryEntries(project);
        const surfaced = live.filter((e) => e.path.length <= READ_LIMITS.maxPathChars);
        const surfacedBinary = liveBinary.filter((e) => e.path.length <= READ_LIMITS.maxPathChars);
        const pathCounts = new Map<string, number>();
        for (const e of surfaced) pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1);
        for (const e of surfacedBinary) pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1);

        // Merge text + binary into ONE deterministically-ordered list ([path,
        // then text-before-binary at an equal path) BEFORE the entry cap, so the
        // cap bounds the combined surface and `truncated` stays honest.
        type Row =
          | { kind: "text"; path: string; fileId: string }
          | { kind: "binary"; path: string; hash: string; size: number; mime: string };
        const rows: Row[] = [
          ...surfaced.map((e): Row => ({ kind: "text", path: e.path, fileId: e.fileId })),
          ...surfacedBinary.map(
            (e): Row => ({ kind: "binary", path: e.path, hash: e.hash, size: e.size, mime: e.mime }),
          ),
        ].sort((a, b) =>
          a.path === b.path
            ? cmp(a.kind, b.kind) /* "binary" < "text": stable, deterministic */
            : cmp(a.path, b.path),
        );
        const totalSurfaced = surfaced.length + surfacedBinary.length;
        const listed = rows.slice(0, maxListEntries);

        // Sizing pass, under the cumulative budget: exact UTF-8 bytes while it
        // lasts, then the O(1) length lower bound — never unbounded encoding.
        // A binary row's size is its pointer's exact byte count (no Y.Text to
        // materialize), so it is always exact and never draws down the budget.
        let budgetChars = READ_LIMITS.maxSizingChars;
        const files = listed.map((row): FileListEntry => {
          const duplicate = (pathCounts.get(row.path) ?? 0) > 1;
          if (row.kind === "binary") {
            return {
              path: row.path,
              sizeBytes: row.size,
              sizeExact: true,
              duplicate,
              kind: "binary",
              hash: row.hash,
              mime: row.mime,
            };
          }
          const text = liveText(project, row.fileId);
          const units = text?.length ?? 0;
          if (text !== undefined && units <= budgetChars) {
            budgetChars -= units;
            return {
              path: row.path,
              sizeBytes: utf8ByteLength(text.toString()),
              sizeExact: true,
              duplicate,
            };
          }
          return { path: row.path, sizeBytes: units, sizeExact: false, duplicate };
        });
        return {
          ok: true,
          files,
          truncated: totalSurfaced > listed.length,
          omitted: live.length - surfaced.length + (liveBinary.length - surfacedBinary.length),
        };
      } catch (err) {
        // Never throw across the tool boundary — a poisoned CRDT read becomes
        // an honest one-line outcome, not a stack.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    readFile(path: string): FileReadOutcome {
      // Defense in depth behind the zod boundary: the surface itself refuses
      // junk input rather than trusting every future caller to validate.
      if (typeof path !== "string" || path.length === 0) {
        return { ok: false, error: "path must be a non-empty string" };
      }
      if (path.length > READ_LIMITS.maxPathChars) {
        return { ok: false, error: `path exceeds ${READ_LIMITS.maxPathChars} characters` };
      }
      // Hostile paths can carry newlines/control chars — every echo of the
      // caller's path below is JSON-escaped so a tool error stays one line.
      const shown = JSON.stringify(path);
      try {
        // Exact match over the cheap metadata only — and it must be UNIQUE
        // ACROSS text AND binary files: compile/export can't represent two files
        // at one path, so a text↔binary (or text↔text, binary↔binary) collision
        // is a duplicate-path conflict with no honest "the file at this path".
        // We refuse it (the browser's conflict-blocked-compile posture) rather
        // than silently pick a winner and mislead the agent about project state.
        const matches = liveEntries(project).filter((e) => e.path === path);
        const binaryMatches = liveBinaryEntries(project).filter((e) => e.path === path);
        const total = matches.length + binaryMatches.length;
        if (total === 0) {
          return {
            ok: false,
            error: `file ${shown} is not present in this room (no live file with that exact path — see list_files)`,
          };
        }
        if (total > 1) {
          return {
            ok: false,
            error:
              `file ${shown} resolves to ${total} live files (duplicate-path conflict) — ` +
              "resolve the conflict in Galley before reading",
          };
        }
        // A3: a unique BINARY match has no Y.Text — return its content-addressed
        // pointer (size + sha256 + mime) instead of text. The bytes are out of
        // scope (no transport on this read seam); never materialized here.
        if (binaryMatches.length === 1) {
          const bin = binaryMatches[0]!;
          return {
            ok: true,
            kind: "binary",
            path: bin.path,
            hash: bin.hash,
            size: bin.size,
            mime: bin.mime,
          };
        }
        const match = matches[0]!;
        const text = liveText(project, match.fileId);
        // O(1) pre-check BEFORE materializing: UTF-16 units are a lower bound
        // on UTF-8 bytes, so an over-cap length is already an over-cap file.
        const units = text?.length ?? 0;
        if (units > maxFileBytes) {
          return {
            ok: false,
            error:
              `file ${shown} is at least ${units} bytes — over the ` +
              `${maxFileBytes}-byte read cap; refusing to return it`,
          };
        }
        const body = text?.toString() ?? "";
        const sizeBytes = utf8ByteLength(body);
        if (sizeBytes > maxFileBytes) {
          return {
            ok: false,
            error:
              `file ${shown} is ${sizeBytes} bytes — over the ` +
              `${maxFileBytes}-byte read cap; refusing to return it`,
          };
        }
        return { ok: true, path: match.path, text: body };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    projectContext(query: string, budgetChars?: number): ContextOutcome {
      // Defense in depth behind the zod boundary (the readFile posture): the
      // surface refuses junk input rather than trusting every future caller.
      if (typeof query !== "string" || query.length === 0) {
        return { ok: false, error: "query must be a non-empty string" };
      }
      if (query.length > READ_LIMITS.maxQueryChars) {
        return { ok: false, error: `query exceeds ${READ_LIMITS.maxQueryChars} characters` };
      }
      if (
        budgetChars !== undefined &&
        (!Number.isInteger(budgetChars) ||
          budgetChars < READ_LIMITS.minContextChars ||
          budgetChars > READ_LIMITS.maxContextChars)
      ) {
        return {
          ok: false,
          error: `budget must be an integer between ${READ_LIMITS.minContextChars} and ${READ_LIMITS.maxContextChars}`,
        };
      }
      const budget = budgetChars ?? defaultContextChars;
      try {
        // Cheap metadata pass FIRST (no text) — identical posture to listFiles:
        // live-only, forged over-long paths hidden (counted), duplicate-path
        // detection over the surfaced set, deterministic order, entry cap.
        const live = liveEntries(project);
        const surfaced = live.filter((e) => e.path.length <= READ_LIMITS.maxPathChars);
        const pathCounts = new Map<string, number>();
        for (const e of surfaced) pathCounts.set(e.path, (pathCounts.get(e.path) ?? 0) + 1);
        const considered = surfaced.slice(0, maxListEntries);

        // Materialization pass, under the cumulative scan budget. Each file is
        // gated by the O(1) Y.Text length BEFORE its body is materialized:
        // duplicates and over-cap files never cost text work at all, and once
        // the budget is hit the scan STOPS (later files are noted, not read).
        interface IncludedFile {
          path: string;
          order: number;
          text: string;
        }
        interface ChunkMeta {
          file: IncludedFile;
          headingPathTruncated: boolean;
        }
        const skipped: ContextSkippedFile[] = [];
        const chunkMeta = new Map<Chunk, ChunkMeta>();
        const allChunks: Chunk[] = [];
        let scanBudget = READ_LIMITS.maxContextScanChars;
        let scanTruncated = false;
        let chunksTruncated = false;
        let order = 0;
        for (const e of considered) {
          if ((pathCounts.get(e.path) ?? 0) > 1) {
            // Same refusal posture as readFile: under a duplicate-path CRDT
            // conflict there is no honest "the file at this path", so neither
            // candidate's content enters the context.
            skipped.push({ path: e.path, reason: "duplicate-path" });
            continue;
          }
          if (allChunks.length >= READ_LIMITS.maxContextChunks) {
            // The ranking set is full (finding 3): reading more files would be
            // pure unranked work, so they are noted and never materialized.
            chunksTruncated = true;
            skipped.push({ path: e.path, reason: "chunk-cap" });
            continue;
          }
          const text = liveText(project, e.fileId);
          const units = text?.length ?? 0; // O(1); lower bound on UTF-8 bytes
          if (units > maxFileBytes) {
            skipped.push({ path: e.path, reason: "over-cap" });
            continue;
          }
          if (scanTruncated || units > scanBudget) {
            scanTruncated = true;
            skipped.push({ path: e.path, reason: "scan-budget" });
            continue;
          }
          scanBudget -= units;
          const body = text?.toString() ?? "";
          // readFile parity (finding 2): the O(1) UTF-16 gate is only a LOWER
          // bound on UTF-8 bytes — re-check the EXACT size after materializing
          // (charging the true encoding size to the scan budget; the work
          // happened) so projectContext never reads what readFile refuses.
          const bytes = utf8ByteLength(body);
          if (bytes > units) scanBudget -= bytes - units;
          if (bytes > maxFileBytes) {
            skipped.push({ path: e.path, reason: "over-cap" });
            continue;
          }
          // Creation-bounding guard (Security round 3): chunkDocument eagerly
          // builds EVERY section+chunk for the body it is given, so the cap
          // must bound its INPUT — chunk objects EVER CREATED stay
          // O(maxContextChunks) per call, not merely those retained. The O(n)
          // estimate (pinned >= the real yield by test) decides; when it
          // exceeds the remaining capacity, only the largest line-boundary
          // prefix whose estimate fits is chunked (flagged), and a file with
          // no room even for its first line is skipped "chunk-cap".
          const capacity = READ_LIMITS.maxContextChunks - allChunks.length;
          let chunkBody = body;
          if (estimateChunks(body) > capacity) {
            chunksTruncated = true;
            chunkBody = body.slice(0, chunkSafePrefix(body, capacity));
            if (chunkBody.length === 0) {
              skipped.push({ path: e.path, reason: "chunk-cap" });
              continue;
            }
          }
          const file: IncludedFile = { path: e.path, order: order++, text: body };
          for (const chunk of chunkDocument(chunkBody)) {
            if (allChunks.length >= READ_LIMITS.maxContextChunks) {
              chunksTruncated = true;
              break;
            }
            // Bound heading provenance BEFORE ranking (finding 1): hostile
            // megabyte headings / deep `=`-ladders never reach BM25's
            // per-chunk searchable text, let alone the response.
            const heading = boundedHeadingPath(chunk.headingPath);
            const safe: Chunk = heading.truncated
              ? { ...chunk, headingPath: heading.entries }
              : chunk;
            chunkMeta.set(safe, { file, headingPathTruncated: heading.truncated });
            allChunks.push(safe);
          }
        }

        // Rank ALL collected chunks against the query and select under the
        // response budget (BM25 greedy fill — the agent loop's own substrate).
        const picked = selectContext(allChunks, query, { maxChars: budget });

        // HARD output bound: selectContext guarantees at least one chunk even
        // when it exceeds the budget (a single blank-line-free paragraph can
        // be megabytes), and it budgets TEXT only. Re-enforce the cap charging
        // each excerpt's full cost — text PLUS provenance metadata (path +
        // bounded headings + a fixed per-record overhead) — so the SERIALIZED
        // response is budget-scale (finding 1). The excerpt COUNT is capped
        // too. When nothing fits whole, return a budget-cut PREFIX of the
        // first selected chunk, flagged, never a dump.
        const metaCost = (chunk: Chunk): number => {
          const headingChars = chunk.headingPath.reduce((n, h) => n + h.length, 0);
          return (
            chunkMeta.get(chunk)!.file.path.length +
            headingChars +
            READ_LIMITS.excerptOverheadChars
          );
        };
        let used = 0;
        const included: { chunk: Chunk; text: string; truncated: boolean }[] = [];
        for (const chunk of picked) {
          if (included.length >= READ_LIMITS.maxContextExcerpts) break;
          const cost = metaCost(chunk) + chunk.text.length;
          if (used + cost <= budget) {
            included.push({ chunk, text: chunk.text, truncated: false });
            used += cost;
          }
        }
        if (included.length === 0 && picked.length > 0) {
          const chunk = picked[0]!;
          const room = budget - metaCost(chunk);
          if (room > 0) {
            included.push({ chunk, text: chunk.text.slice(0, room), truncated: true });
          }
        }

        // Stable order: deterministic file order first, then offset within the
        // file — so excerpts read coherently and results are reproducible.
        included.sort((a, b) => {
          const fa = chunkMeta.get(a.chunk)!.file;
          const fb = chunkMeta.get(b.chunk)!.file;
          return fa.order - fb.order || a.chunk.start - b.chunk.start;
        });

        // Provenance: map chunk offsets to TRUE 1-based line ranges (lazily,
        // only for files that actually contribute excerpts).
        const lineStarts = new Map<string, number[]>();
        const excerpts: ContextExcerpt[] = included.map(({ chunk, text, truncated }) => {
          const meta = chunkMeta.get(chunk)!;
          let starts = lineStarts.get(meta.file.path);
          if (starts === undefined) {
            starts = lineStartsOf(meta.file.text);
            lineStarts.set(meta.file.path, starts);
          }
          const lastOffset = Math.max(chunk.start, chunk.start + text.length - 1);
          return {
            path: meta.file.path,
            startLine: lineOf(starts, chunk.start),
            endLine: lineOf(starts, lastOffset),
            headingPath: chunk.headingPath,
            headingPathTruncated: meta.headingPathTruncated,
            text,
            truncated,
          };
        });

        const totalChars = allChunks.reduce((n, c) => n + c.text.length, 0);
        const includedChars = included.reduce((n, e) => n + e.text.length, 0);
        return {
          ok: true,
          excerpts,
          skipped,
          omitted: live.length - surfaced.length,
          filesTruncated: surfaced.length > considered.length,
          scanTruncated,
          chunksTruncated,
          selectionTruncated: includedChars < totalChars,
        };
      } catch (err) {
        // Never throw across the tool boundary — a poisoned CRDT read becomes
        // an honest one-line outcome, not a stack.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    compileInput(): CompileInput | { error: string } {
      const projectInput = project.toProjectInput();
      if (projectInput !== null) return projectInput;
      const file = liveFile(project, filePath);
      if (!file) return { error: `file ${filePath} is not present in this room` };
      return file.text;
    },

    publishProposal(input): Promise<string> {
      // Tag this publish with the current run (Task 3): same runId for every
      // proposal in one run; a UI grouping hint only, never gating apply.
      const runId = beginProposalRun();
      return publishProposal(project, { ...input, filePath, runId }, author, signer);
    },

    publishFileProposal(input): Promise<string> {
      const runId = beginProposalRun();
      return publishFileProposal(project, { ...input, runId }, author, signer);
    },

    getProposal(id): ProposalRecord | undefined {
      return getProposal(project, id);
    },
  };
}
