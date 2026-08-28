/**
 * Roadmap #6 (feed): bibliography → cite-key pipeline — PURE, offline,
 * framework-free.
 *
 * The citation core (`./citation.ts`) gives us a tolerant BibTeX parser, an
 * order-preserving deduper, and a deterministic stable-key generator. What was
 * missing is the COMPOSITION that turns a whole bibliography *library* string
 * into the ordered, de-duplicated, uniquely-keyed list the `@`-cite autocomplete
 * and the ref-check consume. That is this module: a thin, pure pipeline over the
 * core, with no DOM / React / network.
 *
 * Keying contract:
 *   - Parse the library, then dedupe (DOI, else title+year; first occurrence
 *     wins), preserving source order.
 *   - Thread a running `Set` of already-used keys across the whole list so the
 *     result is GLOBALLY unique.
 *   - Keys that BibTeX already provided are preserved verbatim — UNLESS a later
 *     entry's provided key collides with one already taken, in which case it gets
 *     the same deterministic suffix sequence `makeCiteKey` uses ("b", "c", …).
 *   - Empty keys are filled via `makeCiteKey`, which derives `<family><year>`
 *     (falling back to title's first word, then "ref") and self-suffixes on
 *     collision against the running set.
 */
import {
  type CitationEntry,
  parseBibtex,
  dedupeEntries,
  makeCiteKey,
  nextDeterministicKey,
} from "./citation.js";

/**
 * Parse a (possibly multi-entry) BibTeX library string into an ordered,
 * de-duplicated list of citations where every entry has a stable, non-empty,
 * globally-unique `key`. Robust to junk/empty input (returns `[]`). Pure —
 * returns fresh entry objects; inputs untouched.
 */
export function parseBibliography(src: string): CitationEntry[] {
  if (typeof src !== "string" || src.trim().length === 0) return [];

  const deduped = dedupeEntries(parseBibtex(src));
  const used = new Set<string>();
  // base→next-suffix-index cache: keeps batch keying O(n) on pathological
  // all-colliding input instead of O(n²) (#22.2). Shared across the provided-key
  // and generated-key paths so both resume from the same per-base counter.
  const hints = new Map<string, number>();
  const out: CitationEntry[] = [];

  for (const entry of deduped) {
    const provided = entry.key?.trim() ?? "";
    const key =
      provided.length > 0
        ? nextDeterministicKey(provided, used, hints)
        : makeCiteKey(entry, used, hints);
    used.add(key);
    out.push({ ...entry, key });
  }
  return out;
}

/**
 * Convenience: the ordered, unique cite-key list for a bibliography library —
 * exactly the keys of `parseBibliography`. This is what the `@`-cite
 * autocomplete and the ref-check feed on. Pure.
 */
export function citeKeysFromBibliography(src: string): string[] {
  return parseBibliography(src).map((e) => e.key);
}
