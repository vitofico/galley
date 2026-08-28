/**
 * Shared painter for the author-attribution decorations used by both the
 * single-file (`attribution-decorations.ts`) and project (`project-attribution-
 * decorations.ts`) editors. Centralising it keeps the two ViewPlugins byte-for-byte
 * consistent and puts the "when is attribution worth showing?" policy in one place.
 *
 * Attribution is a COLLABORATION signal — it answers "who wrote this part?". In the
 * common solo case there is only one author, so painting every span tells the writer
 * nothing; it just tints the whole editor and reads as noise. So we paint only when
 * the file carries ≥2 distinct registered authors (e.g. two humans, or a human and
 * the agent). A solo document is left clean.
 */
import { Decoration, type DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { AttributedRange } from "@galley/collab";
import { authorColor, authorKey, authorLabel } from "../attribution-style.js";

export function buildAttributionDecorations(ranges: AttributedRange[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Only paint once authorship is informative — i.e. more than one distinct author
  // has touched the file. A single author (solo writing) is left untinted.
  const distinct = new Set<string>();
  for (const r of ranges) {
    if (r.author !== undefined) distinct.add(authorKey(r.author));
  }
  if (distinct.size < 2) return builder.finish();

  for (const r of ranges) {
    if (r.author === undefined) continue; // author not registered yet → no paint
    const from = Math.max(0, Math.min(r.from, docLength));
    const to = Math.max(0, Math.min(r.to, docLength));
    if (to <= from) continue;
    builder.add(
      from,
      to,
      Decoration.mark({
        class: "cm-attribution",
        attributes: {
          "data-author-kind": r.author.kind,
          "data-author-id": authorKey(r.author),
          title: authorLabel(r.author),
          style: `--attr-color:${authorColor(r.author)}`,
        },
      }),
    );
  }
  return builder.finish();
}
