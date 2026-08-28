/**
 * `seedIfPristine` — seed a document's initial content ONLY when the document has
 * never held any content (no CRDT history), not merely when its text is currently
 * empty.
 *
 * This is the safe companion to local persistence (y-indexeddb). Two hazards it
 * guards against:
 *  - The seed-once footgun: two independent inserts of the same template merge to
 *    *duplicated* CRDT text. Callers run this AFTER persistence has loaded, so a
 *    restored draft makes the doc non-pristine and the seed is skipped.
 *  - The delete-all footgun: if a user empties their draft and reloads, the text
 *    is empty but the doc still carries history — re-seeding the template would
 *    silently resurrect it. Gating on history (the state vector), not text length,
 *    keeps a deliberately-emptied draft empty.
 *
 * Returns whether it seeded.
 */
import * as Y from "yjs";
import type { Author } from "@galley/shared";
import type { CollabDocument } from "./collab-document.js";

/** A pristine doc has no client entries in its state vector (no writes ever). */
function hasHistory(ydoc: Y.Doc): boolean {
  return Y.decodeStateVector(Y.encodeStateVector(ydoc)).size > 0;
}

export function seedIfPristine(doc: CollabDocument, initial: string, author: Author): boolean {
  if (initial.length === 0) return false;
  if (hasHistory(doc.doc)) return false;
  doc.transact((text) => text.insert(0, initial), author);
  return true;
}
