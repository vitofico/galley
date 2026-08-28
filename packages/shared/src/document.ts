/**
 * Document identity & revision tracking.
 *
 * The MVP is single-document with no persistence, but every agent run is still
 * anchored to a base revision so that an accepted diff can detect whether the
 * live document moved underneath it (the user kept typing). This is the
 * "revision/hash conflict handling before Accept" that GPT flagged as secretly
 * load-bearing. See docs/editing-and-diff.md ("Accept/Reject conflicts").
 */

/**
 * A monotonically increasing counter bumped on every committed change to the
 * live document (user keystrokes are debounced into revisions by the app).
 */
export type Revision = number;

/** A content hash of the source at a given revision (e.g. SHA-256, hex). */
export type ContentHash = string;

export interface DocumentSnapshot {
  /** Filename for display/export, e.g. "untitled.typ". */
  name: string;
  source: string;
  revision: Revision;
  hash: ContentHash;
}
