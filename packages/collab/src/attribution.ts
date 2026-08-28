/**
 * Cross-peer author attribution (ADR-0012) — "who wrote which span of the source".
 *
 * The wire problem (ADR-0007): standard Yjs updates do NOT carry our transaction
 * ORIGIN, so the `human:…`/`agent:…` tag is local-only. But every CRDT item in the
 * `Y.Text` carries its originating Yjs `clientID`, and THAT crosses the wire. So
 * attribution is: a durable, replicated `Y.Map` from `String(clientID) → Author`
 * (each peer registers its own clientID), plus a walk of the visible text items
 * mapping each item's `id.client` back to an author.
 *
 * This is the framework-agnostic CORE (yjs only, offline-testable). Rendering the
 * spans in the editor is a later binding slice. It deliberately reaches into a few
 * Yjs structures (the type's `_start` item chain, `Item`, `ContentString`); that
 * coupling is isolated here and locked by tests against the installed Yjs version.
 */
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import type { CollabDocument } from "./collab-document.js";

const AUTHORS_KEY = "authors";

/**
 * Anything backed by one `Y.Doc` — a single-file `CollabDocument` or a multi-file
 * `CollabProject`. The authors map is doc-global (one per `Y.Doc`, shared across
 * every file's `Y.Text`), so author registration takes a host, not a text.
 */
export interface AuthorHost {
  doc: Y.Doc;
}

function authorsMap(host: AuthorHost): Y.Map<Author> {
  return host.doc.getMap<Author>(AUTHORS_KEY);
}

function sameAuthor(a: Author, b: Author): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "human"
    ? a.userId === (b as Extract<Author, { kind: "human" }>).userId
    : a.runId === (b as Extract<Author, { kind: "agent" }>).runId;
}

/**
 * Record THIS document's `clientID → author`. Call it AFTER any seed
 * (`seedIfPristine`): writing the map creates CRDT history, which would otherwise
 * make a pristine doc look non-pristine and suppress the seed.
 *
 * Write-once invariant: a Yjs `clientID` identifies exactly one author for life
 * (every item that client created carries that id). Re-registering the SAME author
 * is an idempotent no-op; re-registering a DIFFERENT author would silently
 * reattribute every span that client ever wrote, so it throws. Corollary: ONE
 * `Y.Doc` peer per identity — the agent must be a distinct peer, not an
 * agent-tagged transaction on a human's doc (see `attributedRanges`).
 */
export function registerAuthor(doc: AuthorHost, author: Author): void {
  const map = authorsMap(doc);
  const key = String(doc.doc.clientID);
  const existing = map.get(key);
  if (existing !== undefined) {
    if (sameAuthor(existing, author)) return;
    throw new Error(
      `attribution: clientID ${key} is already bound to a different author; ` +
        `one peer = one identity (the agent must be a distinct peer)`,
    );
  }
  map.set(key, author);
}

/** Resolve a clientID to its registered author, if known on this peer yet. */
export function authorForClientID(doc: AuthorHost, clientID: number): Author | undefined {
  return authorsMap(doc).get(String(clientID));
}

/**
 * Rename a HUMAN author across the doc-global authors map: set `name` on EVERY
 * `clientID` entry bound to `userId` (a peer that reconnected registers several).
 *
 * This is the deliberate counterpart to {@link registerAuthor}'s write-once
 * IDENTITY rule. Identity (the `userId` attribution key) is untouched — only the
 * human-friendly LABEL changes — so it is always safe: it can never silently
 * reattribute a span to a different person. The effect is immediate and crosses
 * the wire: live attribution spans and {@link distinctAuthors} (hence FUTURE
 * version snapshots, whose contributor labels are captured live) reflect the new
 * name at once. PRIOR version snapshots keep their already-recorded contributor
 * labels — that history is immutable by design, not rewritten here.
 *
 * A blank/whitespace name is a no-op (renaming TO nothing would just blank the
 * label). Returns true iff at least one entry actually changed. All writes happen
 * in one transaction so observers (decorations, roster) fire once.
 */
export function renameAuthor(host: AuthorHost, userId: string, name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  const map = authorsMap(host);
  // Collect matching keys FIRST, then write — never mutate the map mid-iteration.
  const keys: string[] = [];
  for (const [key, author] of map.entries()) {
    if (author.kind === "human" && author.userId === userId && author.name !== trimmed) {
      keys.push(key);
    }
  }
  if (keys.length === 0) return false;
  host.doc.transact(() => {
    for (const key of keys) {
      const author = map.get(key);
      if (author?.kind === "human") map.set(key, { ...author, name: trimmed });
    }
  });
  return true;
}

/** A stable identity string for an author (kind + its identity key). */
function authorIdentity(a: Author): string {
  return a.kind === "agent" ? `agent:${a.runId}` : `human:${a.userId}`;
}

/**
 * The DISTINCT authors registered in this doc's doc-global authors map (roadmap
 * #11 — author-attributed versioning). Every peer that has ever written
 * registers its `clientID → Author`; this collapses those to one entry per
 * distinct identity (a peer that reconnects gets a fresh `clientID` but the same
 * identity, so two `clientID`s for the same human dedupe to one author).
 *
 * v1 attribution semantics (KEEP IT SIMPLE): "who has contributed to the current
 * project state" — the union of registered authors at snapshot time, NOT a
 * per-snapshot diff. Pure read; never mutates the doc. Order is the authors map's
 * iteration order (stable per session); callers that need a fixed order sort the
 * formatted labels.
 */
export function distinctAuthors(host: AuthorHost): Author[] {
  const seen = new Set<string>();
  const out: Author[] = [];
  for (const author of authorsMap(host).values()) {
    const id = authorIdentity(author);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(author);
  }
  return out;
}

export interface AttributedRange {
  /** UTF-16 start offset into the current source (inclusive). */
  from: number;
  /** UTF-16 end offset (exclusive). */
  to: number;
  /** The Yjs clientID that created this span. */
  clientID: number;
  /** The author for that clientID, or `undefined` if not registered yet. */
  author: Author | undefined;
}

/**
 * The visible source partitioned into contiguous spans by originating clientID.
 * Concatenating `from..to` over the result reproduces `doc.getSource()` exactly
 * (UTF-16 offsets; astral characters count as 2, same basis as `Y.Text`).
 */
export function attributedRanges(doc: CollabDocument): AttributedRange[] {
  return textAttributedRanges(doc, doc.source);
}

/**
 * The per-`Y.Text` core of {@link attributedRanges}: partition `ytext` into spans
 * by originating clientID, resolving authors against `host`'s doc-global authors
 * map. Multi-file projects call this with each file's own `Y.Text` (the authors
 * map is shared across all files in the one `Y.Doc`).
 */
export function textAttributedRanges(host: AuthorHost, ytext: Y.Text): AttributedRange[] {
  const ranges: AttributedRange[] = [];
  const map = authorsMap(host);
  let index = 0;
  // Walk the Yjs item linked-list INLINE rather than materializing it via
  // `Y.getTypeChildren` (which allocates a fresh array of the ENTIRE item chain —
  // tombstones included, and those only ever grow — on every call). The decoration
  // ViewPlugins call this per keystroke, so the per-call full-array alloc is hot.
  // This is the same traversal `getTypeChildren` performs: from the type's `_start`
  // following `.right`. Output is byte-for-byte identical (same skip/coalesce).
  let item: Y.Item | null = (ytext as unknown as { _start: Y.Item | null })._start;
  for (; item !== null; item = item.right) {
    // Tombstones and non-countable content (e.g. formatting) don't occupy the
    // visible string; only inserted text strings advance the offset. This Y.Text
    // holds plain Typst source only (the editor binding inserts strings, never
    // embeds), so skipping non-string content stays consistent with
    // `getSource()` (`toString()` likewise excludes embeds/format) — no drift.
    if (item.deleted || !item.countable) continue;
    if (!(item.content instanceof Y.ContentString)) continue;
    const len = item.content.str.length;
    if (len === 0) continue;
    const clientID = item.id.client;
    const from = index;
    const to = index + len;
    index = to;
    const prev = ranges[ranges.length - 1];
    if (prev !== undefined && prev.clientID === clientID && prev.to === from) {
      prev.to = to; // coalesce adjacent spans from the same client
    } else {
      ranges.push({ from, to, clientID, author: map.get(String(clientID)) });
    }
  }
  return ranges;
}

/** The attributed span covering `index` (the character at `index`), if any. */
export function attributionAt(doc: CollabDocument, index: number): AttributedRange | undefined {
  for (const r of attributedRanges(doc)) {
    if (index >= r.from && index < r.to) return r;
  }
  return undefined;
}

/** Observe attribution changes for a specific `Y.Text` (project per-file case). */
export function observeTextAttribution(host: AuthorHost, ytext: Y.Text, cb: () => void): () => void {
  const map = authorsMap(host);
  ytext.observe(cb);
  map.observe(cb);
  return () => {
    ytext.unobserve(cb);
    map.unobserve(cb);
  };
}

/**
 * Invoke `cb` whenever attribution may have changed — either the text changed or
 * an author registration arrived. Returns an unsubscribe.
 */
export function observeAttribution(doc: CollabDocument, cb: () => void): () => void {
  const text = doc.source;
  const map = authorsMap(doc);
  text.observe(cb);
  map.observe(cb);
  return () => {
    text.unobserve(cb);
    map.unobserve(cb);
  };
}

/**
 * Invoke `cb` only when the author MAP changes (a registration arrived), not on
 * text edits. An editor binding drives text-change refreshes from its own update
 * cycle and uses this for the map-only case, avoiding a redundant rebuild per
 * keystroke (and the reentrancy of acting inside the text→editor dispatch).
 */
export function observeAuthors(doc: AuthorHost, cb: () => void): () => void {
  const map = authorsMap(doc);
  map.observe(cb);
  return () => map.unobserve(cb);
}
