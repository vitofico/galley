/**
 * Source-anchored threaded comments (Comments Phase A, Layer 1) — a top-level
 * `Y.Map` ("comments") on the project's existing `Y.Doc`, one nested `Y.Map` per
 * thread. NESTED (same rationale as `CollabProject.fileMeta` and the proposal
 * mailbox) so concurrent edits to one thread — a status flip, a reply appended —
 * merge field-by-field instead of clobbering the whole record.
 *
 * Modelled on `proposal-mailbox.ts`: free functions taking `host: DocHost` first,
 * every write wrapped in `host.doc.transact(fn, authorOrigin(author))`. ONE module
 * serves single-file AND multi-file docs because `host.doc.getMap("comments")`
 * lazily creates the top-level map on either doc.
 *
 * The anchor is the load-bearing idea: a thread does not store offsets (which a
 * concurrent edit would invalidate), it stores Yjs RELATIVE positions encoded to
 * bytes. `resolveThreadRange` decodes them back to live offsets against the
 * current doc state — staying put across inserts/deletes before, after, or inside
 * the range, and degrading to ORPHANED (null) when the whole anchored span is
 * deleted. That decode is a PURE render seam (no React/DOM) so Layer 2 can build
 * decorations against it and it stays unit-testable here.
 *
 * Comments NEVER reach the Typst compiler — they live only in this map, which is
 * deliberately absent from `ProjectSnapshot`/`toProjectInput` (the compile input).
 *
 * Framework-agnostic by design (yjs only): the same module works in the browser
 * and (should it ever need to) in Node over the replicated doc.
 */
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import { authorOrigin } from "./collab-document.js";
import type { DocHost } from "./collab-connection.js";

const COMMENTS_KEY = "comments";

/**
 * The fileId a SINGLE-FILE document's comments are anchored to. A single-file
 * `CollabDocument` has exactly one shared text (`doc.getText("source")`), so its
 * threads all carry this sentinel and decode against `doc.source`. Multi-file
 * callers pass a real `CollabProject` fileId instead and look the per-file
 * `Y.Text` up via `project.fileText(fileId)`. The relative-position anchors are
 * doc-GLOBAL, so `resolveAnchor` only needs `host.doc`; the fileId/ytext matter
 * only at CREATE time and for gutter line-mapping.
 */
export const SINGLE_FILE_ID = "source";

export type ThreadStatus = "open" | "resolved";

/** One message in a thread (read-side projection). */
export interface Message {
  id: string;
  author: Author;
  body: string;
  createdAt: number;
  /** @mentions parsed from the body (Phase A: stored, surfaced later). */
  mentions: string[];
}

/**
 * A flattened, validated thread as read from the comments map (a plain-object
 * projection — mirrors `ProposalRecord`). The raw `anchorStart`/`anchorEnd` bytes
 * are surfaced so the render seam (`resolveThreadRange`) can decode them; UI never
 * touches them directly.
 */
export interface ThreadView {
  id: string;
  /** The file the thread is anchored to ({@link SINGLE_FILE_ID} for single-file). */
  fileId: string;
  /** Encoded Yjs relative position of the range start. */
  anchorStart: Uint8Array;
  /** Encoded Yjs relative position of the range end. */
  anchorEnd: Uint8Array;
  /** The text that was selected when the thread was created (kept even if orphaned). */
  anchorText: string;
  status: ThreadStatus;
  createdAt: number;
  createdBy: Author;
  messages: Message[];
}

/** Alias mirroring the spec's vocabulary — the stored shape is the view shape. */
export type Thread = ThreadView;

/** What a caller passes to open a new thread (id/author/timestamps minted here). */
export interface CreateThreadInput {
  /** {@link SINGLE_FILE_ID} for single-file, else a `CollabProject` fileId. */
  fileId: string;
  /** The shared `Y.Text` the range lives in — used ONLY to build the anchors. */
  ytext: Y.Text;
  /** Range start offset (inclusive). */
  from: number;
  /** Range end offset (exclusive). */
  to: number;
  /** The selected text, kept verbatim so an orphaned thread still shows context. */
  anchorText: string;
  /** The first message body. */
  body: string;
}

/**
 * Like {@link CreateThreadInput} but with the relative-position anchors ALREADY
 * encoded (at SELECTION time, off the live `ytext`) instead of `{ from, to }`
 * offsets resolved later. The plain `{ from, to }` path resolves offsets at submit
 * time, so a concurrent remote edit before the range during the compose window
 * mis-anchors the thread; capturing the anchor bytes when the user selects closes
 * that window. UI callers prefer this; the offset path stays for tests/headless.
 */
export interface CreateThreadAnchoredInput {
  /** {@link SINGLE_FILE_ID} for single-file, else a `CollabProject` fileId. */
  fileId: string;
  /** Encoded Yjs relative position of the range start (see {@link encodeAnchor}). */
  anchorStart: Uint8Array;
  /** Encoded Yjs relative position of the range end. */
  anchorEnd: Uint8Array;
  /** The selected text, kept verbatim so an orphaned thread still shows context. */
  anchorText: string;
  /** The first message body. */
  body: string;
}

/**
 * Encode an offset into `ytext` as a Yjs relative-position byte string — the stable
 * anchor that auto-rebases through concurrent edits. Call this at SELECTION time so
 * the anchor is pinned before any compose-window edit can shift the offsets.
 */
export function encodeAnchor(ytext: Y.Text, offset: number): Uint8Array {
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, offset));
}

/**
 * The comments map for a doc — the unified accessor (mirrors `mailbox()`).
 * Lazily creates the top-level `Y.Map` on first call, on either a single-file or
 * multi-file doc.
 */
export function getComments(host: DocHost): Y.Map<Y.Map<unknown>> {
  return host.doc.getMap<Y.Map<unknown>>(COMMENTS_KEY);
}

/** CSPRNG id. Fails closed — a guessable id is worse than no id (cf. mailbox). */
function mintId(): string {
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
  throw new Error("comments: a secure random source (crypto) is required to mint ids");
}

/** Author stored as a plain JSON value (LWW on each field) — re-picked on read. */
function authorToValue(author: Author): Record<string, unknown> {
  return author.kind === "human"
    ? { kind: "human", userId: author.userId, ...(author.name !== undefined ? { name: author.name } : {}) }
    : { kind: "agent", runId: author.runId };
}

/** Re-validate an author value read back from the map; undefined if malformed. */
function readAuthor(value: unknown): Author | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const a = value as Record<string, unknown>;
  if (a.kind === "human" && typeof a.userId === "string") {
    return typeof a.name === "string"
      ? { kind: "human", userId: a.userId, name: a.name }
      : { kind: "human", userId: a.userId };
  }
  if (a.kind === "agent" && typeof a.runId === "string") {
    return { kind: "agent", runId: a.runId };
  }
  return undefined;
}

/** Build a fresh message `Y.Map` (its own record so a reply merges field-wise). */
function makeMessage(body: string, author: Author): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("id", mintId());
  m.set("author", authorToValue(author));
  m.set("body", body);
  m.set("createdAt", Date.now());
  m.set("mentions", parseMentions(body));
  return m;
}

/** Parse bare `@name` mentions from a body. Phase A: stored for later surfacing. */
function parseMentions(body: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (!out.includes(match[1]!)) out.push(match[1]!);
  }
  return out;
}

/**
 * Open a new comment thread anchored to `[from, to)` in `ytext`. Mints the id,
 * encodes both endpoints as Yjs relative positions, builds the thread `Y.Map`
 * (status "open", seeded with the first message), and stores it — all in ONE
 * author-tagged transaction. Returns the new thread id. Writes ONLY the comments
 * map, never file text.
 */
export function createThread(host: DocHost, input: CreateThreadInput, author: Author): string {
  return createThreadAnchored(
    host,
    {
      fileId: input.fileId,
      anchorStart: encodeAnchor(input.ytext, input.from),
      anchorEnd: encodeAnchor(input.ytext, input.to),
      anchorText: input.anchorText,
      body: input.body,
    },
    author,
  );
}

/**
 * Open a new thread from ALREADY-encoded anchors (captured at selection time, off
 * the live `ytext`) — the rest is identical to {@link createThread}. Prefer this
 * from UI so a concurrent remote edit during the compose window can't mis-anchor.
 */
export function createThreadAnchored(
  host: DocHost,
  input: CreateThreadAnchoredInput,
  author: Author,
): string {
  const id = mintId();
  const thread = new Y.Map<unknown>();
  host.doc.transact(() => {
    thread.set("id", id);
    thread.set("fileId", input.fileId);
    thread.set("anchorStart", input.anchorStart);
    thread.set("anchorEnd", input.anchorEnd);
    thread.set("anchorText", input.anchorText);
    thread.set("status", "open");
    thread.set("createdAt", Date.now());
    thread.set("createdBy", authorToValue(author));
    const messages = new Y.Array<Y.Map<unknown>>();
    messages.push([makeMessage(input.body, author)]);
    thread.set("messages", messages);
    getComments(host).set(id, thread);
  }, authorOrigin(author));
  return id;
}

/**
 * Append a reply to a thread's `messages` array as one author-tagged transaction.
 * Throws on an unknown id — replying to a thread that doesn't exist is a caller
 * bug, never a silent no-op (house style; cf. `resolveProposal`).
 */
export function addMessage(host: DocHost, threadId: string, body: string, author: Author): void {
  const thread = getComments(host).get(threadId);
  if (!(thread instanceof Y.Map)) throw new Error(`addMessage: unknown thread ${threadId}`);
  host.doc.transact(() => {
    const messages = thread.get("messages");
    if (!(messages instanceof Y.Array)) throw new Error(`addMessage: thread ${threadId} has no messages array`);
    (messages as Y.Array<Y.Map<unknown>>).push([makeMessage(body, author)]);
  }, authorOrigin(author));
}

/**
 * Set a thread's status (open/resolved) as one author-tagged transaction —
 * field-level LWW on the nested map, so it converges against a concurrent reply.
 * Throws on an unknown id (house style).
 */
export function setThreadStatus(host: DocHost, threadId: string, status: ThreadStatus, author: Author): void {
  const thread = getComments(host).get(threadId);
  if (!(thread instanceof Y.Map)) throw new Error(`setThreadStatus: unknown thread ${threadId}`);
  host.doc.transact(() => thread.set("status", status), authorOrigin(author));
}

/** Flatten + validate one message entry; undefined if malformed (skipped on read). */
function readMessage(entry: unknown): Message | undefined {
  if (!(entry instanceof Y.Map)) return undefined;
  const id = entry.get("id");
  const body = entry.get("body");
  const author = readAuthor(entry.get("author"));
  const createdAt = entry.get("createdAt");
  if (typeof id !== "string" || typeof body !== "string" || author === undefined) return undefined;
  const mentions = entry.get("mentions");
  return {
    id,
    author,
    body,
    createdAt: typeof createdAt === "number" && Number.isSafeInteger(createdAt) ? createdAt : 0,
    mentions: Array.isArray(mentions) ? mentions.filter((m): m is string => typeof m === "string") : [],
  };
}

/**
 * Flatten + validate one thread entry. Returns undefined for anything malformed —
 * the comments map lives on a doc that may be shared, so a buggy/hostile peer can
 * write garbage straight into the `Y.Map`; readers skip it rather than throw
 * mid-render (mirrors `readRecord` in the proposal mailbox).
 */
function readThread(entry: unknown, key: string): ThreadView | undefined {
  if (!(entry instanceof Y.Map)) return undefined;
  const id = entry.get("id");
  const fileId = entry.get("fileId");
  const anchorStart = entry.get("anchorStart");
  const anchorEnd = entry.get("anchorEnd");
  const anchorText = entry.get("anchorText");
  const status = entry.get("status");
  const createdBy = readAuthor(entry.get("createdBy"));
  const messages = entry.get("messages");
  if (
    typeof id !== "string" ||
    id !== key ||
    typeof fileId !== "string" ||
    !(anchorStart instanceof Uint8Array) ||
    !(anchorEnd instanceof Uint8Array) ||
    typeof anchorText !== "string" ||
    (status !== "open" && status !== "resolved") ||
    createdBy === undefined ||
    !(messages instanceof Y.Array)
  ) {
    return undefined;
  }
  const createdAt = entry.get("createdAt");
  const out: Message[] = [];
  for (const m of (messages as Y.Array<unknown>)) {
    const msg = readMessage(m);
    if (msg) out.push(msg);
  }
  return {
    id,
    fileId,
    anchorStart,
    anchorEnd,
    anchorText,
    status,
    createdAt: typeof createdAt === "number" && Number.isSafeInteger(createdAt) ? createdAt : 0,
    createdBy,
    messages: out,
  };
}

/** Every well-formed thread, oldest first ([createdAt, id] — deterministic). */
export function getThreads(host: DocHost): ThreadView[] {
  const out: ThreadView[] = [];
  for (const [key, entry] of getComments(host).entries()) {
    const t = readThread(entry, key);
    if (t) out.push(t);
  }
  out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** One thread by id, or undefined if absent/malformed. */
export function getThread(host: DocHost, id: string): ThreadView | undefined {
  return readThread(getComments(host).get(id), id);
}

/**
 * Invoke `cb` whenever the comments map MAY have changed — a thread arriving, a
 * status flipping, a reply appended — hence `observeDeep` (the nested mutations
 * would not surface on a shallow `observe`). Returns an unsubscribe.
 */
export function observeComments(host: DocHost, cb: () => void): () => void {
  const map = getComments(host);
  const handler = (): void => cb();
  map.observeDeep(handler);
  return () => map.unobserveDeep(handler);
}

// ---------------------------------------------------------------------------
// Anchor decode — the PURE render seam (no React/DOM), unit-testable here.
// ---------------------------------------------------------------------------

/**
 * Decode one encoded relative position to a live absolute offset against `doc`,
 * or null when it no longer resolves (its anchored content was deleted). Relative
 * positions are doc-GLOBAL, so this needs only the `Y.Doc`, not the per-file text.
 */
export function resolveAnchor(doc: Y.Doc, encoded: Uint8Array): number | null {
  // FAIL CLOSED: the bytes ride a shared doc, so a buggy/hostile peer can sync a
  // truncated/garbage anchor; `Y.decodeRelativePosition` throws on those. A throw
  // here is on an UNGUARDED render path (the decorations ViewPlugin + ProjectApp's
  // overview/orphan useMemos), so it would white-screen the editor for EVERY peer.
  // Degrade an undecodable anchor to the already-handled ORPHANED state instead.
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(encoded), doc);
    return abs?.index ?? null;
  } catch {
    return null;
  }
}

/**
 * Decode a thread's range to live `{ from, to }` offsets against `host.doc`, or
 * null when the thread is ORPHANED — either endpoint failed to resolve OR the
 * span collapsed (`to <= from`, i.e. the whole anchored content was deleted). An
 * orphaned thread is KEPT (with its `anchorText`) and still appears in
 * `getThreads`; it just drops out of the gutter/highlight render.
 */
export function resolveThreadRange(host: DocHost, thread: ThreadView): { from: number; to: number } | null {
  const from = resolveAnchor(host.doc, thread.anchorStart);
  const to = resolveAnchor(host.doc, thread.anchorEnd);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}
