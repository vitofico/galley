/**
 * Roadmap #13 — agent-based contribution reconstruction: the LIVE-EVIDENCE adapter.
 *
 * The pure CORE (`buildContributionStatement` / `renderContributionStatement` in
 * @galley/agent) takes injected evidence and is intentionally ignorant of Galley's
 * runtime types. This module is the thin, PURE bridge that turns Galley's own
 * shapes — the project's `Version` history (#11 `contributors`) and per-file
 * authorship ranges (collab `AttributedRange`, flattened to `{author, length}`) —
 * into that injected `ContributionInput`.
 *
 * It is deliberately CRDT-free: ProjectApp resolves each live `Y.Text` to a list
 * of `{author, length}` rows (via `textAttributedRanges` + `authorLabel`) and the
 * version store to a `Version[]`, then hands those plain arrays here. That keeps
 * the mapping fully unit-testable without a live document, and keeps the only
 * Yjs/identity coupling in ProjectApp where it already lives.
 *
 * Pure, deterministic, fail-soft: blank/empty inputs yield empty evidence; ranges
 * with no resolved author or non-positive length are dropped; never throws.
 */
import type { Version } from "@galley/shared";
import type {
  ContributionInput,
  ContributionSnapshot,
  SectionAttribution,
} from "@galley/agent";

/** One author's flattened authorship span in a file (label already resolved). */
export interface AttributedSpan {
  /** The author label as it should appear in the statement, or undefined if the
   *  originating clientID has no registered author yet (dropped). */
  author: string | undefined;
  /** UTF-16 length of the span (char count); non-positive ⇒ dropped. */
  length: number;
}

/** A project file plus its per-author authorship spans. */
export interface AttributedFile {
  /** The file path, used verbatim as the statement's "section" label. */
  path: string;
  ranges: AttributedSpan[];
}

/**
 * Map the project's `Version` history → snapshot evidence. Each version becomes a
 * `ContributionSnapshot` carrying its name (as `label`) and its `contributors`
 * (#11). Versions written before #11 lack `contributors`; they default to `[]`.
 * INPUT ORDER IS PRESERVED — the core's review-vs-draft inference reads snapshot
 * index, so callers must pass oldest → newest (the `listVersions` order).
 */
export function versionsToSnapshots(versions: readonly Version[]): ContributionSnapshot[] {
  return versions.map((v) => ({
    label: v.name,
    contributors: Array.isArray(v.contributors) ? [...v.contributors] : [],
  }));
}

/**
 * Map per-file authorship spans → section attributions. For each file, sum span
 * lengths per author into one `SectionAttribution { section: path, author, weight }`
 * per (file, author). Spans with no resolved author or non-positive length are
 * dropped. The core sorts everything, so emission order here is not significant.
 */
export function fileRangesToAttributions(
  files: readonly AttributedFile[],
): SectionAttribution[] {
  const out: SectionAttribution[] = [];
  for (const file of files) {
    const perAuthor = new Map<string, number>();
    for (const span of file.ranges) {
      const author = span.author;
      const length = typeof span.length === "number" ? span.length : 0;
      if (author === undefined || author === "" || !(length > 0)) continue;
      perAuthor.set(author, (perAuthor.get(author) ?? 0) + length);
    }
    for (const [author, weight] of perAuthor) {
      out.push({ section: file.path, author, weight });
    }
  }
  return out;
}

/**
 * Bundle the version history and per-file authorship into a `ContributionInput`
 * ready for `buildContributionStatement`. Pure composition of the two mappers.
 */
export function gatherContributionEvidence(
  versions: readonly Version[],
  files: readonly AttributedFile[],
): ContributionInput {
  return {
    snapshots: versionsToSnapshots(versions),
    attributions: fileRangesToAttributions(files),
  };
}
