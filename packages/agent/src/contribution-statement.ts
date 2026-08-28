/**
 * Roadmap #13 — agent-based contribution reconstruction: the PURE CORE.
 *
 * A read-only, deterministic drafter of a CRediT-style author-contribution
 * statement. Many journals now require detailing each author's contribution;
 * this turns the attributed history Galley already records into a first DRAFT a
 * human then edits — it is NOT an authoritative attribution.
 *
 * Evidence in, statement out. Two evidence shapes are injected (so this core
 * imports NOTHING from @galley/collab or @galley/persistence — it stays pure and
 * lane-disjoint). They mirror what #11/#12 already produce:
 *   - `snapshots`: version snapshots, each carrying `contributors: string[]`.
 *     This mirrors the shipped `Version.contributors` (#11).
 *   - `attributions`: per-section/per-file authorship shares
 *     ({ section, author, weight }). This mirrors collab's `AttributedRange`
 *     ({ author, length }) from #12 blame, flattened to a plain injected shape.
 *
 * INFERENCE RULES (deliberately simple, explicit, and conservative — a draft):
 *   1. "Writing – original draft" is credited to any author who AUTHORED
 *      content, i.e. appears in `attributions` with positive weight. The
 *      sections they "wrote" are those where they hold the MAXIMUM authorship
 *      weight (ties ⇒ all tying authors are co-writers of that section).
 *   2. "Writing – review & editing" is credited to an author who appears as a
 *      contributor in a snapshot AFTER the first snapshot they appear in WAS NOT
 *      the first overall — concretely: anyone who shows up in a later snapshot's
 *      `contributors` but did NOT author original content gets review-only;
 *      and anyone who authored content AND also appears in a strictly-later
 *      snapshot than the first also carries review & editing (they kept editing
 *      across revisions).
 *   3. An author seen ONLY in `attributions` (never in any snapshot) still gets
 *      original draft (rule 1) — attribution is direct evidence of writing.
 *
 * No network, no I/O, no randomness, no Date.now() — any timestamps are taken
 * from the input. Fail-soft: blank authors/sections and non-positive weights are
 * dropped; empty input yields an empty (but well-formed) statement; never throws.
 *
 * Only dependency: none (pure TS + locally-defined types).
 */

/** The closed CRediT-ish role vocabulary this core can infer from the evidence. */
export const CREDIT_ROLES = [
  "Writing – original draft",
  "Writing – review & editing",
] as const;

/** A CRediT-style role string drawn from {@link CREDIT_ROLES}. */
export type CreditRole = (typeof CREDIT_ROLES)[number];

/**
 * A version snapshot's evidence. Mirrors the shipped `Version` (#11): we read
 * only the contributor list (and optionally a label/timestamp for rendering).
 */
export interface ContributionSnapshot {
  /** Human label for the snapshot (e.g. "v2", a commit subject). Optional. */
  label?: string;
  /** Optional snapshot time, taken from the input (we never call the clock). */
  timestamp?: number;
  /** The authors credited on this snapshot (mirrors `Version.contributors`). */
  contributors: string[];
}

/**
 * One per-section / per-file authorship share. Mirrors collab's
 * `AttributedRange` ({ author, length }) — flattened so the core needs no Yjs.
 * `weight` is a relative magnitude (e.g. character count); only its ordering
 * within a section matters to the inference.
 */
export interface SectionAttribution {
  /** The section or file label (e.g. "Introduction", "methods.typ"). */
  section: string;
  /** The author of this share. */
  author: string;
  /** Relative authorship magnitude (char count / weight). Non-positive ⇒ dropped. */
  weight: number;
}

/** The full evidence bundle injected into {@link buildContributionStatement}. */
export interface ContributionInput {
  snapshots: ContributionSnapshot[];
  attributions: SectionAttribution[];
}

/** A single author's reconstructed contribution. */
export interface AuthorContribution {
  /** The author's name/label as it appeared in the evidence. */
  author: string;
  /** The CRediT-style roles inferred for this author (ordered, deduped). */
  roles: CreditRole[];
  /** Sections this author is credited as having written (sorted, deduped). */
  sectionsWritten: string[];
}

/** The structured CRediT-style statement (a draft). */
export interface ContributionStatement {
  /** Per-author contributions, sorted by author name for determinism. */
  authors: AuthorContribution[];
  /** Always true: this is a machine-drafted statement meant for human editing. */
  draft: true;
}

/** Options for {@link renderContributionStatement}. */
export interface RenderContributionOptions {
  /** Prepend an "Author Contributions" heading line. Default false. */
  heading?: boolean;
}

/** Trim and treat blank-only strings as absent. */
function clean(s: string | undefined): string {
  return (s ?? "").trim();
}

/**
 * Build a CRediT-style contribution statement from injected evidence.
 *
 * Pure and deterministic: same input ⇒ structurally identical output. Fail-soft
 * on degenerate input (see module header). Never throws.
 */
export function buildContributionStatement(
  input: ContributionInput,
): ContributionStatement {
  const snapshots = Array.isArray(input?.snapshots) ? input.snapshots : [];
  const attributions = Array.isArray(input?.attributions)
    ? input.attributions
    : [];

  // --- Pass 1: per-section authorship weights (drop degenerate entries). ---
  // Map<section, Map<author, totalWeight>>; insertion order is irrelevant since
  // we sort everything before emitting.
  const sectionWeights = new Map<string, Map<string, number>>();
  for (const a of attributions) {
    const section = clean(a?.section);
    const author = clean(a?.author);
    const weight = typeof a?.weight === "number" ? a.weight : 0;
    if (section === "" || author === "" || !(weight > 0)) continue;
    let perAuthor = sectionWeights.get(section);
    if (!perAuthor) {
      perAuthor = new Map<string, number>();
      sectionWeights.set(section, perAuthor);
    }
    perAuthor.set(author, (perAuthor.get(author) ?? 0) + weight);
  }

  // Authors who wrote content, and which sections they "own" (max-weight, ties
  // shared). `wroteSomething` ⇒ eligible for original draft.
  const sectionsWritten = new Map<string, Set<string>>(); // author -> sections
  const authoredContent = new Set<string>();
  for (const [section, perAuthor] of sectionWeights) {
    let max = -Infinity;
    for (const w of perAuthor.values()) if (w > max) max = w;
    for (const [author, w] of perAuthor) {
      authoredContent.add(author);
      if (w === max) {
        let set = sectionsWritten.get(author);
        if (!set) {
          set = new Set<string>();
          sectionsWritten.set(author, set);
        }
        set.add(section);
      }
    }
  }

  // --- Pass 2: snapshot evidence → first appearance + later appearance. ---
  // An author who appears only in a snapshot AFTER snapshot index 0 (i.e. not in
  // the very first snapshot) is a candidate "reviewer". We also flag any author
  // who appears in a strictly-later snapshot than their own first appearance as
  // having kept editing across revisions (review & editing).
  const firstSnapshotIndex = new Map<string, number>();
  const lastSnapshotIndex = new Map<string, number>();
  for (let i = 0; i < snapshots.length; i++) {
    const contributors = Array.isArray(snapshots[i]?.contributors)
      ? snapshots[i]!.contributors
      : [];
    for (const raw of contributors) {
      const author = clean(raw);
      if (author === "") continue;
      if (!firstSnapshotIndex.has(author)) firstSnapshotIndex.set(author, i);
      lastSnapshotIndex.set(author, i);
    }
  }

  // --- Assemble the per-author roles. ---
  const allAuthors = new Set<string>([
    ...authoredContent,
    ...firstSnapshotIndex.keys(),
    ...sectionsWritten.keys(),
  ]);

  const authors: AuthorContribution[] = [];
  for (const author of allAuthors) {
    const roles: CreditRole[] = [];
    const wrote = authoredContent.has(author);

    // Rule 1: authored content ⇒ original draft.
    if (wrote) roles.push("Writing – original draft");

    // Rules 2: review & editing.
    const first = firstSnapshotIndex.get(author);
    const last = lastSnapshotIndex.get(author);
    const appearedLater =
      first !== undefined && (first > 0 || (last !== undefined && last > first));
    if (!wrote) {
      // Snapshot contributor with no authored content ⇒ review-only.
      if (first !== undefined) roles.push("Writing – review & editing");
    } else if (appearedLater) {
      // Authored content AND kept showing up in later revisions ⇒ also reviewed.
      roles.push("Writing – review & editing");
    }

    const sections = [...(sectionsWritten.get(author) ?? new Set<string>())].sort(
      (a, b) => a.localeCompare(b),
    );

    authors.push({ author, roles, sectionsWritten: sections });
  }

  authors.sort((a, b) => a.author.localeCompare(b.author));

  return { authors, draft: true };
}

/**
 * Render a {@link ContributionStatement} as plain text — one CRediT-style
 * sentence per author. Deterministic; safe on an empty statement.
 */
export function renderContributionStatement(
  statement: ContributionStatement,
  opts: RenderContributionOptions = {},
): string {
  const lines: string[] = [];
  if (opts.heading) lines.push("Author Contributions");

  if (statement.authors.length === 0) {
    lines.push("No attributed contributions were found.");
    return lines.join("\n");
  }

  for (const a of statement.authors) {
    const parts: string[] = [];
    if (a.roles.includes("Writing – original draft")) {
      const sections =
        a.sectionsWritten.length > 0
          ? ` (${a.sectionsWritten.join(", ")})`
          : "";
      parts.push(`Writing – original draft${sections}`);
    }
    if (a.roles.includes("Writing – review & editing")) {
      parts.push("Writing – review & editing");
    }
    const detail = parts.length > 0 ? parts.join("; ") : "Contributor";
    lines.push(`${a.author}: ${detail}.`);
  }

  return lines.join("\n");
}
