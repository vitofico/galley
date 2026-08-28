import { useEffect, useState } from "react";
import {
  detectInputKind,
  parseBibtex,
  toHayagriva,
  makeCiteKey,
  fetchCitation,
  CitationFetchError,
  deduplicateBibliographySource,
  mergeGroup,
} from "@galley/agent";
import type { CitationEntry, CitationInputKind } from "@galley/agent";
import { DiffReview } from "./DiffReview.js";
import { appendSnippet } from "./authoring-insert.js";
import {
  importLibrary,
  searchCitationsDetailed,
  filterCitationRows,
  type ImportLibraryResult,
  type CitationSearchSource,
} from "./citation-library.js";
import {
  connectZoteroLibrary,
  type ZoteroImportResult,
} from "./zotero-import.js";
import {
  connectMendeleyLibrary,
  type MendeleyImportResult,
} from "./mendeley-import.js";
import { Notice } from "./Notice.js";
import "./authoring-panels.css";
import "./citation-panel.css";

/**
 * Citation paste UI (roadmap #6) — paste a DOI, a DOI/URL, or a BibTeX string and
 * turn it into a REVIEWABLE Hayagriva entry + a stable cite-key before it lands in
 * the document. The hard part (deterministic keys, BibTeX parsing, safe Hayagriva
 * rendering, the fail-closed network seam) lives in the pure `@galley/agent`
 * citation core; this component is a thin shell over it.
 *
 * PRESENTATIONAL + CONTROLLED, mirroring ImportPanel (#15) / FigurePanel (#8):
 *  - it owns only the draft input + the resolved result;
 *  - insertion goes through the host's conflict-aware `onInsert` (Accept stays
 *    mandatory — the entry is never auto-inserted);
 *  - the single network path is an INJECTED `fetch` (default: the global), so the
 *    component is offline-testable and the seam stays honest/fail-closed — a fetch
 *    failure surfaces a visible error and NEVER calls `onInsert`.
 *
 * BibTeX resolves locally (no network). A DOI/DOI-URL resolves via the injected
 * fetch through the core's `fetchCitation` (Crossref envelope). A plain web URL has
 * no metadata source in this seam and fails closed with a visible message.
 *
 * What gets inserted, and where: Typst splits a citation into TWO places — the
 * bibliography library (a Hayagriva `.yml`, referenced by `#bibliography(...)`)
 * and the in-text cite sigil `@key` in the prose. The Hayagriva YAML is NOT valid
 * Typst in the document body, so `onInsert` (which appends to the .typ document)
 * receives the in-text cite `@<key>` ONLY — always valid Typst. The Hayagriva
 * entry is surfaced for review and handed to the OPTIONAL `onAddToBibliography`
 * callback (the host routes it to the project's bib file; that wiring is Lane S's
 * job). Both artifacts reference the SAME deterministic key.
 */

/** How the author is sourcing a citation: a single paste, an imported library, a
 *  literature search, or a dedup pass. The "Import library" tab covers EVERY
 *  whole-library path — a pasted .bib/.ris file OR a live Zotero/Mendeley pull —
 *  behind one `librarySource` selector, so adding a connector never grows the tab
 *  bar (#17.1). */
export type CitationMode = "paste" | "library" | "search" | "dedup";

/** Where the "Import library" tab is sourcing its references from. */
export type LibrarySource = "paste" | "zotero" | "mendeley";

/**
 * The literature-search backends offered in the Search tab, in display order, with
 * their human labels. Crossref stays first/default so the existing behaviour is
 * unchanged; arXiv, OpenAlex + Semantic Scholar are the additional sources picked
 * from the same compact selector (no new tab). Driving the selector + the button
 * label + the error copy from ONE list keeps them in lockstep as sources are added.
 */
export const SEARCH_SOURCES: ReadonlyArray<{ id: CitationSearchSource; label: string }> = [
  { id: "crossref", label: "Crossref" },
  { id: "arxiv", label: "arXiv" },
  { id: "openalex", label: "OpenAlex" },
  { id: "semanticscholar", label: "Semantic Scholar" },
];

/** The display label for a search source (falls back to the id, defensively). */
export function searchSourceLabel(source: CitationSearchSource): string {
  return SEARCH_SOURCES.find((s) => s.id === source)?.label ?? source;
}

/**
 * A reviewable duplicate cluster found in the CURRENT bibliography: the duplicate
 * entries that share an identity, plus the single merged entry they collapse to
 * (first entry wins conflicts; later ones fill gaps + contribute richer authors).
 * Pure shape — no DOM/network.
 */
export interface DedupGroupPreview {
  /** The duplicate members, in first-occurrence order. */
  members: CitationEntry[];
  /** The single entry the members collapse to (keeps the first member's key). */
  merged: CitationEntry;
}

/** The full dedup preview: the rewritten library text + the groups + the counts. */
export interface DedupPreview {
  /**
   * The de-duplicated bibliography, ready to replace the file. SURGICAL: every
   * surviving byte (the kept entries' original BibTeX, comments, whitespace) is
   * preserved verbatim — only the duplicate entries are removed. The file stays
   * BibTeX, so Typst's `.bib` compile and the cite-key readers keep working.
   */
  text: string;
  /** How many entries are removed by the merge. */
  removed: number;
  /** The duplicate clusters, each with its merged result (for the preview list). */
  groups: DedupGroupPreview[];
  /** Total duplicate entries involved (across all groups) = removed + groups. */
  duplicateMembers: number;
  /** Merged entries the clusters collapse into (one per group). */
  mergedCount: number;
  /** True when the rewrite is safe to apply with no data loss / no format change. */
  safe: boolean;
}

/**
 * Compute the dedup preview for a bibliography library STRING (BibTeX — the format
 * Galley's bib feed parses AND Typst compiles). PURE: detects duplicate clusters,
 * shows what each collapses to, and computes the SURGICAL rewrite (duplicates
 * removed, everything else verbatim). Robust to junk/empty (returns no groups,
 * removed 0). The merged entry per group is `mergeGroup`'d for the preview display
 * (what fields the kept entry effectively gains); the apply preserves the kept
 * entry's original text.
 */
export function previewDedup(bibliographySource: string): DedupPreview {
  const { text, removed, groups, safe } = deduplicateBibliographySource(bibliographySource);
  const previews: DedupGroupPreview[] = groups.map((members) => ({
    members,
    merged: mergeGroup(members),
  }));
  return {
    text,
    removed,
    groups: previews,
    duplicateMembers: removed + previews.length,
    mergedCount: previews.length,
    safe,
  };
}

/** The reviewed artifact: the source entry, its assigned key, and rendered YAML. */
export interface ResolvedCitation {
  kind: CitationInputKind;
  key: string;
  entry: CitationEntry;
  hayagriva: string;
}

export interface CitationPanelProps {
  open: boolean;
  onClose: () => void;
  /** The live document the in-text cite will be appended to (for the diff). */
  currentSource: string;
  /**
   * Insert the in-text cite snippet (`@<key>`) into the document, conflict-aware.
   * Returns true if applied (false on a concurrent-edit conflict). The Hayagriva
   * entry is NOT inserted here — it is valid only in the bibliography file (see
   * `onAddToBibliography`).
   */
  onInsert: (snippet: string) => boolean;
  /**
   * OPTIONAL: route the resolved Hayagriva entry to the project's bibliography
   * library (the `.yml` referenced by `#bibliography(...)`). When omitted, the
   * entry is still shown for review but only the in-text cite is inserted — the
   * host is responsible for wiring the bib file (Lane S).
   */
  onAddToBibliography?: (resolved: ResolvedCitation) => void;
  /**
   * OPTIONAL (#6 dedup): the CURRENT bibliography library text (the BibTeX the bib
   * feed parses). When provided alongside `onRewriteBibliography`, the panel offers
   * a user-initiated "Deduplicate library" mode that previews duplicate clusters
   * and merges them. Omitted (or with no rewrite callback) → the dedup tab is inert
   * / hidden, and every existing mode is byte-for-byte unchanged.
   */
  bibliographySource?: string;
  /**
   * OPTIONAL (#6 dedup): replace the project's bibliography file text with `text`
   * in ONE undoable edit (a single CRDT `transactFile`). This is a DIRECT user
   * edit (no Accept gate). When omitted, the dedup apply is inert (read-only role).
   */
  onRewriteBibliography?: (text: string) => void;
  /**
   * Cite-keys already in use, so a newly minted key is collision-free against the
   * existing bibliography. Optional (defaults to empty). NOT mutated.
   */
  existingKeys?: Iterable<string>;
  /**
   * Injected `fetch` for the DOI/URL network path (mirrors the core's seam).
   * Defaults to the global `fetch`; tests pass a fake so no real network is hit.
   */
  fetch?: typeof fetch;
  /**
   * Rail & Islands (#19.2): when true the panel renders as a DOCKED card (no
   * fixed backdrop, no modal dialog semantics) inside the shell's dock host.
   * Default false — the modal presentation is byte-for-byte unchanged.
   */
  docked?: boolean;
}

/**
 * Resolve a pasted string to a reviewable citation. PURE except for the injected
 * `fetch` it is handed (BibTeX never touches the network). Throws on any failure
 * (empty/unknown input, no BibTeX entry, or a fail-closed network error) — the
 * caller turns the throw into a visible message and does NOT insert. Unit-tested
 * directly per the repo's Node-env house pattern (no DOM rendering in tests).
 */
export async function resolveCitation(opts: {
  input: string;
  existingKeys?: Iterable<string>;
  fetch: typeof fetch;
}): Promise<ResolvedCitation> {
  const input = opts.input.trim();
  const kind = detectInputKind(input);
  if (kind === "unknown") {
    throw new CitationFetchError(
      "Could not recognise the input — paste a DOI, a DOI/URL, or a BibTeX entry.",
    );
  }
  const existing = new Set<string>(opts.existingKeys ?? []);

  let entry: CitationEntry;
  if (kind === "bibtex") {
    const parsed = parseBibtex(input);
    if (parsed.length === 0) {
      throw new CitationFetchError("No BibTeX entry found in the pasted text.");
    }
    // First entry wins for the single-insert flow; the parsed (user-controlled)
    // key is discarded in favour of a deterministic, collision-free one below.
    entry = parsed[0]!;
  } else {
    // DOI or DOI-URL → injected fetch (fail-closed inside the core).
    entry = await fetchCitation(input, { fetch: opts.fetch });
  }

  const key = makeCiteKey(entry, existing);
  const keyed: CitationEntry = { ...entry, key };
  return { kind, key, entry: keyed, hayagriva: toHayagriva(keyed) };
}

/**
 * The plain-text snippet inserted into the DOCUMENT on Accept: the in-text Typst
 * cite sigil `@<key>` (the same form the cite autocomplete emits). This is the
 * only citation artifact that is valid inside the .typ body — the Hayagriva entry
 * goes to the bibliography file via `onAddToBibliography`. Pure.
 */
export function buildCitationSnippet(resolved: ResolvedCitation): string {
  return `@${resolved.key}`;
}

/**
 * Whether a search hit's cite-key is ALREADY present in the bibliography — either
 * because the live bibliography already exposes it (`existingKeys`) or because
 * this search session has already added it (`added`). Drives the search rows'
 * "Add to bib" done-state and keeps "Insert" from appending a duplicate entry.
 * Pure.
 */
export function citationInBibliography(
  key: string,
  existingKeys: Iterable<string> | undefined,
  added: ReadonlySet<string>,
): boolean {
  if (added.has(key)) return true;
  for (const k of existingKeys ?? []) if (k === key) return true;
  return false;
}

export function CitationPanel({
  open,
  onClose,
  currentSource,
  onInsert,
  onAddToBibliography,
  bibliographySource,
  onRewriteBibliography,
  existingKeys,
  fetch: injectedFetch,
  docked,
}: CitationPanelProps) {
  const [mode, setMode] = useState<CitationMode>("paste");
  const [input, setInput] = useState("");
  const [resolved, setResolved] = useState<ResolvedCitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // #17.1 reference-library import: a pasted BibTeX/RIS export -> reviewable list.
  const [libraryText, setLibraryText] = useState("");
  const [library, setLibrary] = useState<ImportLibraryResult | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // #6 search-your-library: free-text filter over the parsed library rows.
  const [libraryFilter, setLibraryFilter] = useState("");

  // #17.4 literature search: a query -> a results list (fail-closed to empty).
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ResolvedCitation[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Which backend the Search tab queries (Crossref default). Switching sources
  // clears any prior results/error so a stale list never sits under a new header.
  const [searchSource, setSearchSource] = useState<CitationSearchSource>("crossref");
  // #6 — which backend the search runs against. Crossref is the default so the
  // existing search behavior is byte-for-byte unchanged unless the user switches.
  // A FAILED search (offline / blocked / rate-limited / bad body) is distinct
  // from a query that genuinely matched nothing — null while there's no failure.
  const [searchError, setSearchError] = useState<null | "network" | "server" | "malformed">(null);
  // #6 search-insert: cite-keys added to the bibliography straight from a search
  // result this session (so the row shows a calm "Added" done-state and a later
  // "Insert" of the same hit doesn't append a duplicate entry).
  const [searchAdded, setSearchAdded] = useState<Set<string>>(new Set());

  // #17.1 Zotero pull: read-only Web API v3 → the SAME reviewable library list.
  // The API key lives ONLY here in component state — never localStorage, never a
  // store, never echoed back. `zoteroResult` holds the typed pull outcome.
  const [zoteroKind, setZoteroKind] = useState<"user" | "group">("user");
  const [zoteroId, setZoteroId] = useState("");
  const [zoteroKey, setZoteroKey] = useState("");
  const [zoteroResult, setZoteroResult] = useState<ZoteroImportResult | null>(null);
  const [zoteroConnecting, setZoteroConnecting] = useState(false);
  const [zoteroAdded, setZoteroAdded] = useState<Set<string>>(new Set());

  // #17.1 Mendeley pull: read-only Web API → the SAME reviewable library list.
  // Mendeley pulls the AUTHENTICATED user's own library, so there is no library
  // kind/id input — only the OAuth2 bearer access token, which lives ONLY here in
  // component state (never localStorage, never a store, never echoed back).
  // `mendeleyResult` holds the typed pull outcome.
  const [mendeleyToken, setMendeleyToken] = useState("");
  const [mendeleyResult, setMendeleyResult] = useState<MendeleyImportResult | null>(null);
  const [mendeleyConnecting, setMendeleyConnecting] = useState(false);
  const [mendeleyAdded, setMendeleyAdded] = useState<Set<string>>(new Set());

  // Which source the "Import library" tab is pulling from: a pasted .bib/.ris
  // file (default), a live Zotero pull, or a live Mendeley pull. Folding the two
  // connectors in here (instead of their own top-level tabs) keeps the tab bar at
  // four entries no matter how many reference managers we add.
  const [librarySource, setLibrarySource] = useState<LibrarySource>("paste");

  // #6 dedup: the computed preview (null until the user clicks "Find duplicates"),
  // and whether an apply has landed (so the tab shows a calm done-state).
  const [dedup, setDedup] = useState<DedupPreview | null>(null);
  const [dedupApplied, setDedupApplied] = useState(false);

  // The IO seam's default. The bare global `fetch` must NOT be handed to a helper
  // that calls it as `opts.fetch(...)` — that's a method call (`this === opts`),
  // which browsers reject with "Illegal invocation", so the request never fires
  // and the search/resolve fails closed as a phantom "network" error. Bind it to
  // the window once. Tests still inject their own fake fetch via `injectedFetch`.
  const defaultFetch: typeof fetch = injectedFetch ?? globalThis.fetch.bind(globalThis);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const kind = detectInputKind(input);

  const resolve = async () => {
    if (input.trim().length === 0 || resolving) return;
    setResolving(true);
    setError(null);
    setResolved(null);
    try {
      const result = await resolveCitation({
        input,
        // Omit when absent (exactOptionalPropertyTypes: the target is `existingKeys?`, not `| undefined`).
        ...(existingKeys !== undefined ? { existingKeys } : {}),
        // Default to the global fetch; the DOI/URL path is the only consumer.
        fetch: defaultFetch,
      });
      setResolved(result);
    } catch (err) {
      // Fail-closed: a visible message, and `onInsert` is never reached.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  };

  const reset = () => {
    setResolved(null);
    setError(null);
  };

  const snippet = resolved ? buildCitationSnippet(resolved) : "";
  const next = resolved ? appendSnippet(currentSource, snippet) : currentSource;

  // Accept = route the Hayagriva entry to the bibliography (if the host wired it)
  // THEN insert the in-text cite into the document. The entry is added first so a
  // successful insert never leaves a dangling `@key` with no bibliography entry.
  // Generalised over any resolved citation so a pasted entry, a search hit, and a
  // library row all flow through the IDENTICAL insert path.
  const acceptResolved = (r: ResolvedCitation) => {
    onAddToBibliography?.(r);
    if (onInsert(buildCitationSnippet(r))) onClose();
  };
  const accept = () => {
    if (!resolved) return;
    acceptResolved(resolved);
  };

  // #6 search-insert: insert a search hit's in-text cite straight from the result
  // row, adding it to the bibliography first UNLESS it is already there (so a
  // hit that's already in the .yml — or one the user just "Added" — never gets a
  // duplicate entry). One click: search → cite → bibliography, no paste detour.
  const insertHit = (hit: ResolvedCitation) => {
    if (!citationInBibliography(hit.key, existingKeys, searchAdded)) {
      onAddToBibliography?.(hit);
    }
    if (onInsert(buildCitationSnippet(hit))) onClose();
  };

  // #6 search-insert: stock the bibliography from a search hit WITHOUT inserting a
  // cite (the in-text @cite is the author's later choice — mirrors the library
  // import tab). No-ops when the key is already present.
  const addHitToBibliography = (hit: ResolvedCitation) => {
    if (citationInBibliography(hit.key, existingKeys, searchAdded)) return;
    onAddToBibliography?.(hit);
    setSearchAdded((prev) => new Set(prev).add(hit.key));
  };

  // #17.1 — parse the pasted library (offline) against the existing keys, deduped.
  const runImport = () => {
    setLibrary(
      importLibrary({
        text: libraryText,
        ...(existingKeys !== undefined ? { existingKeys } : {}),
      }),
    );
    setAdded(new Set());
    setLibraryFilter("");
  };

  // Add ONE reviewed library row to the bibliography (no in-text cite — a library
  // import populates the .yml; the @cite is the author's later choice). Routed via
  // the same `onAddToBibliography` seam, deduped against `existingKeys` upstream.
  const addRowToBibliography = (key: string) => {
    const row = library?.entries.find((e) => e.key === key);
    if (!row) return;
    onAddToBibliography?.(row);
    setAdded((prev) => new Set(prev).add(key));
  };

  // #6 search-your-library: insert a library row's in-text cite straight from the
  // list (adding it to the bibliography first unless already present), then close
  // — the same one-click search→cite the literature-search rows offer.
  const insertLibraryRow = (key: string) => {
    const row = library?.entries.find((e) => e.key === key);
    if (!row) return;
    if (!citationInBibliography(key, existingKeys, added)) {
      onAddToBibliography?.(row);
      setAdded((prev) => new Set(prev).add(key));
    }
    if (onInsert(buildCitationSnippet(row))) onClose();
  };

  // Add EVERY not-yet-added row in one reviewed batch (still one call per entry —
  // no silent bulk write; the list was already shown for review).
  const addAllToBibliography = () => {
    if (!library) return;
    const justAdded = new Set(added);
    for (const row of library.entries) {
      if (justAdded.has(row.key)) continue;
      onAddToBibliography?.(row);
      justAdded.add(row.key);
    }
    setAdded(justAdded);
  };

  // #17.4 — search via the injected fetch. The helper never throws; it returns a
  // discriminated outcome so a FAILED request surfaces a distinct, actionable
  // message instead of masquerading as an empty "no results".
  const runSearch = async () => {
    if (query.trim().length === 0 || searching) return;
    setSearching(true);
    setResults(null);
    setSearchError(null);
    setSearchAdded(new Set());
    try {
      const outcome = await searchCitationsDetailed({
        query,
        fetch: defaultFetch,
        source: searchSource,
        ...(existingKeys !== undefined ? { existingKeys } : {}),
      });
      if (outcome.ok) setResults(outcome.results);
      else setSearchError(outcome.reason);
    } finally {
      setSearching(false);
    }
  };

  // Switch the search backend, clearing any prior results/error/added-state so a
  // stale list from the previous source never lingers under the new one. The query
  // text is kept so the author can re-run the same terms against another source.
  const switchSearchSource = (source: CitationSearchSource) => {
    if (source === searchSource) return;
    setSearchSource(source);
    setResults(null);
    setSearchError(null);
    setSearchAdded(new Set());
  };

  // #17.1 — pull the Zotero library via the injected fetch into the SAME
  // reviewable list as a pasted library. FAIL-CLOSED: the helper never throws;
  // an upstream failure becomes a typed error rendered below. The API key is
  // handed to the helper (header-only inside the core) and never persisted/echoed.
  const zoteroRows = zoteroResult?.ok ? zoteroResult.result : null;
  const runZoteroConnect = async () => {
    if (zoteroId.trim().length === 0 || zoteroKey.trim().length === 0 || zoteroConnecting) {
      return;
    }
    setZoteroConnecting(true);
    setZoteroResult(null);
    setZoteroAdded(new Set());
    try {
      const res = await connectZoteroLibrary({
        library: { kind: zoteroKind, id: zoteroId.trim() },
        apiKey: zoteroKey,
        fetch: defaultFetch,
        ...(existingKeys !== undefined ? { existingKeys } : {}),
      });
      setZoteroResult(res);
    } finally {
      setZoteroConnecting(false);
    }
  };

  // Add ONE pulled Zotero row to the bibliography (same seam as the paste-library
  // path: no in-text cite, deduped against `existingKeys` upstream).
  const addZoteroRow = (key: string) => {
    const row = zoteroRows?.entries.find((e) => e.key === key);
    if (!row) return;
    onAddToBibliography?.(row);
    setZoteroAdded((prev) => new Set(prev).add(key));
  };

  // Add EVERY not-yet-added pulled row in one reviewed batch (one call per entry).
  const addAllZotero = () => {
    if (!zoteroRows) return;
    const justAdded = new Set(zoteroAdded);
    for (const row of zoteroRows.entries) {
      if (justAdded.has(row.key)) continue;
      onAddToBibliography?.(row);
      justAdded.add(row.key);
    }
    setZoteroAdded(justAdded);
  };

  // #17.1 — pull the Mendeley library via the injected fetch into the SAME
  // reviewable list as a pasted library. FAIL-CLOSED: the helper never throws;
  // an upstream failure becomes a typed error rendered below. The access token is
  // handed to the helper (header-only inside the core) and never persisted/echoed.
  const mendeleyRows = mendeleyResult?.ok ? mendeleyResult.result : null;
  const runMendeleyConnect = async () => {
    if (mendeleyToken.trim().length === 0 || mendeleyConnecting) {
      return;
    }
    setMendeleyConnecting(true);
    setMendeleyResult(null);
    setMendeleyAdded(new Set());
    try {
      const res = await connectMendeleyLibrary({
        apiToken: mendeleyToken,
        fetch: defaultFetch,
        ...(existingKeys !== undefined ? { existingKeys } : {}),
      });
      setMendeleyResult(res);
    } finally {
      setMendeleyConnecting(false);
    }
  };

  // Add ONE pulled Mendeley row to the bibliography (same seam as the paste-library
  // path: no in-text cite, deduped against `existingKeys` upstream).
  const addMendeleyRow = (key: string) => {
    const row = mendeleyRows?.entries.find((e) => e.key === key);
    if (!row) return;
    onAddToBibliography?.(row);
    setMendeleyAdded((prev) => new Set(prev).add(key));
  };

  // Add EVERY not-yet-added pulled row in one reviewed batch (one call per entry).
  const addAllMendeley = () => {
    if (!mendeleyRows) return;
    const justAdded = new Set(mendeleyAdded);
    for (const row of mendeleyRows.entries) {
      if (justAdded.has(row.key)) continue;
      onAddToBibliography?.(row);
      justAdded.add(row.key);
    }
    setMendeleyAdded(justAdded);
  };

  const switchMode = (m: CitationMode) => {
    setMode(m);
    setError(null);
  };

  // #6 dedup — the tab is offered ONLY when the host wired BOTH the current bib
  // text AND the rewrite seam. A viewer (read-only) gets no rewrite callback, so
  // the apply path is inert exactly like the other mutating affordances.
  const dedupAvailable = bibliographySource !== undefined && onRewriteBibliography !== undefined;

  // Scan the CURRENT bibliography for duplicate clusters (pure, offline). No write.
  const runDedupScan = () => {
    setDedup(previewDedup(bibliographySource ?? ""));
    setDedupApplied(false);
  };

  // Apply the merge as ONE undoable rewrite of the bib file (a single transaction
  // in the host). Direct user edit — no Accept gate, no network. The rewrite is
  // SURGICAL (duplicates removed, everything else verbatim, still BibTeX). Inert if
  // the host gave us no rewrite callback (read-only role), there is nothing to
  // merge, or the rewrite is not provably loss-free (`safe`).
  const applyDedup = () => {
    if (!onRewriteBibliography || !dedup || dedup.removed === 0 || !dedup.safe) return;
    onRewriteBibliography(dedup.text);
    setDedupApplied(true);
  };

  const panel = (
      <div
        className={`authoring-panel${docked ? " authoring-panel--docked" : ""}`}
        data-testid="citation-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="authoring-header">
          <h2 className="authoring-title">Add citation</h2>
          <button type="button" className="authoring-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div
          className="citation-tabs"
          role="tablist"
          aria-label="How to add a citation"
          data-testid="citation-modes"
        >
          <button
            type="button"
            role="tab"
            className="citation-tab"
            data-testid="citation-mode-paste"
            aria-selected={mode === "paste"}
            onClick={() => switchMode("paste")}
          >
            Paste
          </button>
          <button
            type="button"
            role="tab"
            className="citation-tab"
            data-testid="citation-mode-library"
            aria-selected={mode === "library"}
            onClick={() => switchMode("library")}
          >
            Import library
          </button>
          <button
            type="button"
            role="tab"
            className="citation-tab"
            data-testid="citation-mode-search"
            aria-selected={mode === "search"}
            onClick={() => switchMode("search")}
          >
            Search
          </button>
          {dedupAvailable && (
            <button
              type="button"
              role="tab"
              className="citation-tab"
              data-testid="citation-mode-dedup"
              aria-selected={mode === "dedup"}
              onClick={() => switchMode("dedup")}
            >
              Deduplicate
            </button>
          )}
        </div>

        {mode === "paste" && (
        <div className="authoring-body">
          <p className="authoring-status" data-testid="citation-kind">
            {input.trim().length === 0
              ? "Paste a DOI, a DOI/URL, or a BibTeX entry."
              : kind === "unknown"
                ? "Unrecognised — paste a DOI, a DOI/URL, or a BibTeX entry."
                : kind === "bibtex"
                  ? "Detected BibTeX (resolves offline)."
                  : kind === "doi"
                    ? "Detected a DOI (resolved over the network)."
                    : "Detected a URL (only DOI URLs can be resolved)."}
          </p>

          <textarea
            className="authoring-input"
            data-testid="citation-input"
            value={input}
            placeholder={"Paste a DOI (10.1145/…), a DOI URL, or a @article{…} BibTeX entry"}
            aria-label="Citation to add"
            rows={5}
            onChange={(e) => setInput(e.target.value)}
          />

          <div className="authoring-actions">
            <button
              type="button"
              className="authoring-primary"
              data-testid="citation-resolve"
              disabled={input.trim().length === 0 || kind === "unknown" || resolving}
              onClick={() => void resolve()}
            >
              {resolving ? "Resolving…" : "Resolve"}
            </button>
            {(resolved || error) && (
              <button
                type="button"
                className="authoring-secondary"
                data-testid="citation-reset"
                onClick={reset}
              >
                Clear
              </button>
            )}
          </div>

          {error && (
            <Notice severity="error" testId="citation-error" message={`Error: ${error}`} />
          )}

          {resolved && (
            <>
              <div className="authoring-status" data-testid="citation-result" data-ok="true">
                <div className="citation-key-line">
                  Cite key: <code data-testid="citation-key">{resolved.key}</code> — inserts{" "}
                  <code>@{resolved.key}</code> in the text; the entry below is added to the
                  bibliography.
                </div>
                <pre className="citation-yaml" data-testid="citation-yaml">
                  {resolved.hayagriva}
                </pre>
              </div>
              <DiffReview
                base={currentSource}
                next={next}
                outcome="citation"
                onAccept={accept}
                onReject={reset}
              />
              {/* Stable, citation-scoped Accept hook for the e2e. DiffReview's own
                  "accept" testid is shared across all panels, so Lane S can target
                  this citation-specific one instead. Visually hidden (CSS), same
                  Accept behaviour. */}
              <button
                type="button"
                className="citation-insert-hidden"
                data-testid="citation-insert"
                aria-hidden="true"
                tabIndex={-1}
                onClick={accept}
              >
                Insert citation
              </button>
            </>
          )}
        </div>
        )}

        {mode === "library" && (
          <div className="authoring-body" data-testid="citation-library-body">
            <div
              className="citation-library-source"
              role="tablist"
              aria-label="Library source"
              data-testid="citation-library-source"
            >
              <button
                type="button"
                role="tab"
                className="citation-source-tab"
                data-testid="citation-library-source-paste"
                aria-selected={librarySource === "paste"}
                onClick={() => setLibrarySource("paste")}
              >
                Paste file
              </button>
              <button
                type="button"
                role="tab"
                className="citation-source-tab"
                data-testid="citation-library-source-zotero"
                aria-selected={librarySource === "zotero"}
                onClick={() => setLibrarySource("zotero")}
              >
                Zotero
              </button>
              <button
                type="button"
                role="tab"
                className="citation-source-tab"
                data-testid="citation-library-source-mendeley"
                aria-selected={librarySource === "mendeley"}
                onClick={() => setLibrarySource("mendeley")}
              >
                Mendeley
              </button>
            </div>

            {librarySource === "paste" && (
            <>
            <p className="authoring-status">
              Paste a BibTeX or RIS library export (from Zotero, Mendeley, EndNote,
              …). Review the parsed entries, then add the ones you want to the
              bibliography. Format is detected automatically.
            </p>

            <textarea
              className="authoring-input"
              data-testid="citation-library-input"
              value={libraryText}
              placeholder={"Paste a .bib or .ris export — one or many references"}
              aria-label="Reference library to import"
              rows={6}
              onChange={(e) => setLibraryText(e.target.value)}
            />

            <div className="authoring-actions">
              <button
                type="button"
                className="authoring-primary"
                data-testid="citation-library-parse"
                disabled={libraryText.trim().length === 0}
                onClick={runImport}
              >
                Parse library
              </button>
              {library && (
                <button
                  type="button"
                  className="authoring-secondary"
                  data-testid="citation-library-clear"
                  onClick={() => {
                    setLibrary(null);
                    setAdded(new Set());
                    setLibraryFilter("");
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {library && (
              <>
                <p className="authoring-status" data-testid="citation-library-summary">
                  {library.parsedCount === 0
                    ? "No references found in the pasted text."
                    : `Parsed ${library.parsedCount} reference${
                        library.parsedCount === 1 ? "" : "s"
                      }${
                        library.duplicateCount > 0
                          ? ` — ${library.duplicateCount} already in your bibliography`
                          : ""
                      }.${library.formatNote ? ` (Note: ${library.formatNote}.)` : ""}`}
                </p>

                {library.malformedCount > 0 && (
                  <p
                    className="authoring-status authoring-status-warn"
                    data-testid="citation-library-parsed-note"
                  >
                    {`Parsed ${library.seenCount - library.malformedCount} of ${
                      library.seenCount
                    } — ${library.malformedCount} malformed entr${
                      library.malformedCount === 1 ? "y" : "ies"
                    } skipped.`}
                  </p>
                )}

                {library.entries.length > 0 && (
                  <>
                    <div className="authoring-actions">
                      <button
                        type="button"
                        className="authoring-primary"
                        data-testid="citation-library-add-all"
                        disabled={library.entries.every((e) => added.has(e.key))}
                        onClick={addAllToBibliography}
                      >
                        Add all to bibliography
                      </button>
                    </div>
                    <input
                      type="text"
                      className="authoring-input citation-library-filter"
                      data-testid="citation-library-filter"
                      value={libraryFilter}
                      placeholder={"Search this library by title, author, or key…"}
                      aria-label="Search the imported library"
                      onChange={(e) => setLibraryFilter(e.target.value)}
                    />
                    {filterCitationRows(library.entries, libraryFilter).length === 0 ? (
                      <p className="authoring-status" data-testid="citation-library-no-matches">
                        No references match “{libraryFilter}”.
                      </p>
                    ) : (
                      <ul className="citation-list" data-testid="citation-library-list">
                        {filterCitationRows(library.entries, libraryFilter).map((row) => (
                          <li
                            key={row.key}
                            className="citation-list-item"
                            data-testid={`citation-library-row-${row.key}`}
                          >
                            <div className="citation-list-meta">
                              <span className="citation-list-title">
                                {row.entry.title ?? "(untitled)"}
                              </span>
                              <span className="citation-list-sub">
                                {(row.entry.author?.[0] ?? "Unknown author")}
                                {row.entry.year ? ` · ${row.entry.year}` : ""} ·{" "}
                                <code>{row.key}</code>
                                {row.duplicate && (
                                  <span
                                    className="citation-dup-badge"
                                    data-testid={`citation-library-dup-${row.key}`}
                                  >
                                    already in bibliography
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="citation-search-actions">
                              <button
                                type="button"
                                className="authoring-primary"
                                data-testid={`citation-library-insert-${row.key}`}
                                onClick={() => insertLibraryRow(row.key)}
                              >
                                Insert
                              </button>
                              <button
                                type="button"
                                className="authoring-secondary"
                                data-testid={`citation-library-add-${row.key}`}
                                disabled={added.has(row.key)}
                                onClick={() => addRowToBibliography(row.key)}
                              >
                                {added.has(row.key) ? "Added" : "Add"}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            )}
            </>
            )}

            {librarySource === "zotero" && (
              <div className="citation-source-pane" data-testid="citation-zotero-body">
                <p className="authoring-status">
                  Pull a Zotero library straight in (read-only). Enter the library
                  (your user library or a group), its numeric id, and a Zotero API
                  key. The key is used for this connection only — it is never saved.
                </p>

                <div className="citation-zotero-fields">
                  <label className="citation-zotero-field">
                    <span className="citation-zotero-label">Library</span>
                    <select
                      className="authoring-input citation-zotero-select"
                      data-testid="citation-zotero-kind"
                      value={zoteroKind}
                      aria-label="Zotero library type"
                      onChange={(e) => setZoteroKind(e.target.value === "group" ? "group" : "user")}
                    >
                      <option value="user">User library</option>
                      <option value="group">Group library</option>
                    </select>
                  </label>

                  <label className="citation-zotero-field">
                    <span className="citation-zotero-label">Library id</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="authoring-input"
                      data-testid="citation-zotero-id"
                      value={zoteroId}
                      placeholder={"e.g. 475425"}
                      aria-label="Zotero library id"
                      onChange={(e) => setZoteroId(e.target.value)}
                    />
                  </label>

                  <label className="citation-zotero-field">
                    <span className="citation-zotero-label">API key</span>
                    <input
                      type="password"
                      autoComplete="off"
                      className="authoring-input"
                      data-testid="citation-zotero-key"
                      value={zoteroKey}
                      placeholder={"Zotero API key (kept in memory only)"}
                      aria-label="Zotero API key"
                      onChange={(e) => setZoteroKey(e.target.value)}
                    />
                  </label>
                </div>

                <div className="authoring-actions">
                  <button
                    type="button"
                    className="authoring-primary"
                    data-testid="citation-zotero-connect"
                    disabled={
                      zoteroId.trim().length === 0 ||
                      zoteroKey.trim().length === 0 ||
                      zoteroConnecting
                    }
                    onClick={() => void runZoteroConnect()}
                  >
                    {zoteroConnecting ? "Connecting…" : "Connect"}
                  </button>
                  {zoteroResult && (
                    <button
                      type="button"
                      className="authoring-secondary"
                      data-testid="citation-zotero-clear"
                      onClick={() => {
                        setZoteroResult(null);
                        setZoteroAdded(new Set());
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {zoteroResult && !zoteroResult.ok && (
                  <Notice
                    severity="error"
                    testId="citation-zotero-error"
                    message={`Error: ${zoteroResult.error.message}`}
                  />
                )}

                {zoteroResult?.ok && zoteroResult.notModified && (
                  <p className="authoring-status" data-testid="citation-zotero-unchanged">
                    Library unchanged since the last pull — nothing new to import.
                  </p>
                )}

                {zoteroRows && zoteroResult?.ok && !zoteroResult.notModified && (
                  <>
                    <p className="authoring-status" data-testid="citation-zotero-summary">
                      {zoteroRows.parsedCount === 0
                        ? "No references in this Zotero library."
                        : `Pulled ${zoteroRows.parsedCount} reference${
                            zoteroRows.parsedCount === 1 ? "" : "s"
                          }${
                            zoteroRows.duplicateCount > 0
                              ? ` — ${zoteroRows.duplicateCount} already in your bibliography`
                              : ""
                          }.`}
                    </p>

                    {zoteroResult?.ok && zoteroResult.truncated && (
                      <p className="authoring-status citation-truncated" data-testid="citation-zotero-truncated">
                        This library is large — only the first part was pulled. Some
                        references may be missing.
                      </p>
                    )}

                    {zoteroRows.entries.length > 0 && (
                      <>
                        <div className="authoring-actions">
                          <button
                            type="button"
                            className="authoring-primary"
                            data-testid="citation-zotero-add-all"
                            disabled={zoteroRows.entries.every((e) => zoteroAdded.has(e.key))}
                            onClick={addAllZotero}
                          >
                            Add all to bibliography
                          </button>
                        </div>
                        <ul className="citation-list" data-testid="citation-zotero-list">
                          {zoteroRows.entries.map((row) => (
                            <li
                              key={row.key}
                              className="citation-list-item"
                              data-testid={`citation-zotero-row-${row.key}`}
                            >
                              <div className="citation-list-meta">
                                <span className="citation-list-title">
                                  {row.entry.title ?? "(untitled)"}
                                </span>
                                <span className="citation-list-sub">
                                  {(row.entry.author?.[0] ?? "Unknown author")}
                                  {row.entry.year ? ` · ${row.entry.year}` : ""} ·{" "}
                                  <code>{row.key}</code>
                                  {row.duplicate && (
                                    <span
                                      className="citation-dup-badge"
                                      data-testid={`citation-zotero-dup-${row.key}`}
                                    >
                                      already in bibliography
                                    </span>
                                  )}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="authoring-secondary"
                                data-testid={`citation-zotero-add-${row.key}`}
                                disabled={zoteroAdded.has(row.key)}
                                onClick={() => addZoteroRow(row.key)}
                              >
                                {zoteroAdded.has(row.key) ? "Added" : "Add"}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {librarySource === "mendeley" && (
              <div className="citation-source-pane" data-testid="citation-mendeley-body">
                <p className="authoring-status">
                  Pull your Mendeley library straight in (read-only). Paste a
                  Mendeley access token — it reads your own library, so there's no
                  library id to enter. The token is used for this connection only —
                  it is never saved.
                </p>

                <div className="citation-zotero-fields">
                  <label className="citation-zotero-field">
                    <span className="citation-zotero-label">Access token</span>
                    <input
                      type="password"
                      autoComplete="off"
                      className="authoring-input"
                      data-testid="citation-mendeley-token"
                      value={mendeleyToken}
                      placeholder={"Mendeley access token (kept in memory only)"}
                      aria-label="Mendeley access token"
                      onChange={(e) => setMendeleyToken(e.target.value)}
                    />
                  </label>
                </div>

                <div className="authoring-actions">
                  <button
                    type="button"
                    className="authoring-primary"
                    data-testid="citation-mendeley-connect"
                    disabled={mendeleyToken.trim().length === 0 || mendeleyConnecting}
                    onClick={() => void runMendeleyConnect()}
                  >
                    {mendeleyConnecting ? "Connecting…" : "Connect"}
                  </button>
                  {mendeleyResult && (
                    <button
                      type="button"
                      className="authoring-secondary"
                      data-testid="citation-mendeley-clear"
                      onClick={() => {
                        setMendeleyResult(null);
                        setMendeleyAdded(new Set());
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {mendeleyResult && !mendeleyResult.ok && (
                  <Notice
                    severity="error"
                    testId="citation-mendeley-error"
                    message={`Error: ${mendeleyResult.error.message}`}
                  />
                )}

                {mendeleyRows && mendeleyResult?.ok && (
                  <>
                    <p className="authoring-status" data-testid="citation-mendeley-summary">
                      {mendeleyRows.parsedCount === 0
                        ? "No references in this Mendeley library."
                        : `Pulled ${mendeleyRows.parsedCount} reference${
                            mendeleyRows.parsedCount === 1 ? "" : "s"
                          }${
                            mendeleyRows.duplicateCount > 0
                              ? ` — ${mendeleyRows.duplicateCount} already in your bibliography`
                              : ""
                          }.`}
                    </p>

                    {mendeleyResult?.ok && mendeleyResult.truncated && (
                      <p className="authoring-status citation-truncated" data-testid="citation-mendeley-truncated">
                        This library is large — only the first part was pulled. Some
                        references may be missing.
                      </p>
                    )}

                    {mendeleyRows.entries.length > 0 && (
                      <>
                        <div className="authoring-actions">
                          <button
                            type="button"
                            className="authoring-primary"
                            data-testid="citation-mendeley-add-all"
                            disabled={mendeleyRows.entries.every((e) => mendeleyAdded.has(e.key))}
                            onClick={addAllMendeley}
                          >
                            Add all to bibliography
                          </button>
                        </div>
                        <ul className="citation-list" data-testid="citation-mendeley-list">
                          {mendeleyRows.entries.map((row) => (
                            <li
                              key={row.key}
                              className="citation-list-item"
                              data-testid={`citation-mendeley-row-${row.key}`}
                            >
                              <div className="citation-list-meta">
                                <span className="citation-list-title">
                                  {row.entry.title ?? "(untitled)"}
                                </span>
                                <span className="citation-list-sub">
                                  {(row.entry.author?.[0] ?? "Unknown author")}
                                  {row.entry.year ? ` · ${row.entry.year}` : ""} ·{" "}
                                  <code>{row.key}</code>
                                  {row.duplicate && (
                                    <span
                                      className="citation-dup-badge"
                                      data-testid={`citation-mendeley-dup-${row.key}`}
                                    >
                                      already in bibliography
                                    </span>
                                  )}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="authoring-secondary"
                                data-testid={`citation-mendeley-add-${row.key}`}
                                disabled={mendeleyAdded.has(row.key)}
                                onClick={() => addMendeleyRow(row.key)}
                              >
                                {mendeleyAdded.has(row.key) ? "Added" : "Add"}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {mode === "search" && (
          <div className="authoring-body" data-testid="citation-search-body">
            <p className="authoring-status">
              Search the literature by title, author, or keywords. Insert a result
              straight into your document (it's added to the bibliography too), add
              it to the bibliography without citing yet, or review it first.
            </p>

            <div
              className="citation-library-source"
              role="tablist"
              aria-label="Search source"
              data-testid="citation-search-source"
            >
              {SEARCH_SOURCES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  className="citation-source-tab"
                  data-testid={`citation-search-source-${s.id}`}
                  aria-selected={searchSource === s.id}
                  onClick={() => switchSearchSource(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <div className="authoring-actions">
              <input
                type="text"
                className="authoring-input citation-search-input"
                data-testid="citation-search-input"
                value={query}
                placeholder={"e.g. attention is all you need"}
                aria-label="Literature search query"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch();
                  }
                }}
              />
              <button
                type="button"
                className="authoring-primary"
                data-testid="citation-search-run"
                disabled={query.trim().length === 0 || searching}
                onClick={() => void runSearch()}
              >
                {searching ? "Searching…" : `Search ${searchSourceLabel(searchSource)}`}
              </button>
            </div>

            {searchError !== null && (
              <Notice
                severity="error"
                testId="citation-search-error"
                message={
                  searchError === "network"
                    ? `Couldn't reach ${searchSourceLabel(searchSource)} — check your internet connection and try again.`
                    : searchError === "server"
                      ? `${searchSourceLabel(searchSource)} returned an error (it may be rate-limiting or temporarily down). Try again in a moment.`
                      : `${searchSourceLabel(searchSource)} sent an unexpected response. Try again, or refine your search terms.`
                }
              />
            )}

            {searchError === null && results !== null && results.length === 0 && (
              <p className="authoring-status" data-testid="citation-search-empty">
                No results — try different terms.
              </p>
            )}

            {results !== null && results.length > 0 && (
              <ul className="citation-list" data-testid="citation-search-list">
                {results.map((hit) => (
                  <li
                    key={hit.key}
                    className="citation-list-item"
                    data-testid={`citation-search-row-${hit.key}`}
                  >
                    <div className="citation-list-meta">
                      <span className="citation-list-title">
                        {hit.entry.title ?? "(untitled)"}
                      </span>
                      <span className="citation-list-sub">
                        {(hit.entry.author?.[0] ?? "Unknown author")}
                        {hit.entry.year ? ` · ${hit.entry.year}` : ""} ·{" "}
                        <code>{hit.key}</code>
                      </span>
                    </div>
                    <div className="citation-search-actions">
                      <button
                        type="button"
                        className="authoring-primary"
                        data-testid={`citation-search-insert-${hit.key}`}
                        onClick={() => insertHit(hit)}
                      >
                        Insert
                      </button>
                      <button
                        type="button"
                        className="authoring-secondary"
                        data-testid={`citation-search-add-${hit.key}`}
                        disabled={citationInBibliography(hit.key, existingKeys, searchAdded)}
                        onClick={() => addHitToBibliography(hit)}
                      >
                        {citationInBibliography(hit.key, existingKeys, searchAdded)
                          ? "In bibliography"
                          : "Add to bib"}
                      </button>
                      <button
                        type="button"
                        className="authoring-tertiary"
                        data-testid={`citation-search-select-${hit.key}`}
                        onClick={() => {
                          setResolved(hit);
                          setMode("paste");
                        }}
                      >
                        Review
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "dedup" && dedupAvailable && (
          <div className="authoring-body" data-testid="citation-dedup-body">
            <p className="authoring-status">
              Find and remove duplicate entries already in your bibliography — the
              same work added twice (matched by DOI, else title + year). The first
              of each duplicate is kept exactly as written and the extra copies are
              removed; every other entry and detail stays untouched. Review the
              changes, then apply them as one undoable edit.
            </p>

            <div className="authoring-actions">
              <button
                type="button"
                className="authoring-primary"
                data-testid="citation-dedup-scan"
                onClick={runDedupScan}
              >
                Find duplicates
              </button>
              {dedup && (
                <button
                  type="button"
                  className="authoring-secondary"
                  data-testid="citation-dedup-clear"
                  onClick={() => {
                    setDedup(null);
                    setDedupApplied(false);
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {dedup && dedup.groups.length === 0 && (
              <p className="authoring-status" data-testid="citation-dedup-empty">
                No duplicate entries found — your bibliography is already clean.
              </p>
            )}

            {dedup && dedup.groups.length > 0 && (
              <>
                <p className="authoring-status" data-testid="citation-dedup-summary">
                  {dedupApplied
                    ? `Merged ${dedup.duplicateMembers} entries into ${dedup.mergedCount}.`
                    : `Merge ${dedup.duplicateMembers} duplicate ${
                        dedup.duplicateMembers === 1 ? "entry" : "entries"
                      } into ${dedup.mergedCount} (${dedup.removed} removed).`}
                </p>

                {!dedupApplied && (
                  <div className="authoring-actions">
                    <button
                      type="button"
                      className="authoring-primary"
                      data-testid="citation-dedup-apply"
                      onClick={applyDedup}
                    >
                      Merge duplicates
                    </button>
                  </div>
                )}

                <ul className="citation-list" data-testid="citation-dedup-list">
                  {dedup.groups.map((g) => (
                    <li
                      key={g.merged.key}
                      className="citation-list-item"
                      data-testid={`citation-dedup-group-${g.merged.key}`}
                    >
                      <div className="citation-list-meta">
                        <span className="citation-list-title">
                          {g.merged.title ?? "(untitled)"}
                        </span>
                        <span className="citation-list-sub">
                          {g.members.length} copies →{" "}
                          <code>{g.merged.key}</code>
                          {" · keeping "}
                          {g.members.map((m) => m.key || "(no key)").join(", ")}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
  );
  if (docked) return panel;
  return (
    <div
      className="authoring-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add a citation"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}
