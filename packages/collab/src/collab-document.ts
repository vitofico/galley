/**
 * `CollabDocument` — a Yjs-backed Typst document (ADR-0006, Phase 1). The source
 * lives in a `Y.Text` so edits from multiple peers (humans AND the agent) merge
 * conflict-free. Framework-agnostic: no React, no DOM, no network — sync is just
 * exchanging encoded updates between docs (the websocket transport is Phase 2).
 */
import * as Y from "yjs";
import type { Author } from "@galley/shared";

/** Stable transaction origin string for an author (used for attribution). */
export function authorOrigin(author: Author): string {
  return author.kind === "human" ? `human:${author.userId}` : `agent:${author.runId}`;
}

export class CollabDocument {
  readonly doc: Y.Doc;
  private readonly text: Y.Text;

  /**
   * Seed-once invariant: pass `initial` on EXACTLY ONE peer (the creator). Every
   * other peer must join EMPTY and receive the content via sync — two peers that
   * independently insert the same `initial` produce distinct CRDT items that
   * merge to *duplicated* text (`"x"` + `"x"` → `"xx"`). See sync.test.ts.
   */
  constructor(initial = "", doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.text = doc.getText("source");
    if (initial.length > 0 && this.text.length === 0) {
      this.text.insert(0, initial);
    }
  }

  /** Current Typst source. */
  getSource(): string {
    return this.text.toString();
  }

  /** The underlying shared text (e.g. for a CodeMirror binding in Phase 2). */
  get source(): Y.Text {
    return this.text;
  }

  /** Run a mutation on the shared text in one transaction, tagged by author. */
  transact(mutate: (text: Y.Text) => void, author: Author): void {
    this.doc.transact(() => mutate(this.text), authorOrigin(author));
  }

  /** Encode full doc state as an update (to seed a fresh peer). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Encode just the changes a peer is missing (diff-based sync). */
  encodeStateSince(remoteStateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, remoteStateVector);
  }

  /** This peer's state vector (what it already has). */
  stateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Merge another peer's update into this doc. */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  /** Subscribe to updates with their author origin (for sync/attribution). */
  onUpdate(handler: (update: Uint8Array, origin: unknown) => void): () => void {
    const listener = (update: Uint8Array, origin: unknown) => handler(update, origin);
    this.doc.on("update", listener);
    return () => this.doc.off("update", listener);
  }

  destroy(): void {
    this.doc.destroy();
  }
}
