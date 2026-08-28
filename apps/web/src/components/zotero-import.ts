/**
 * #17.1 Zotero library UI seam — the pure helper the CitationPanel's "Zotero" tab
 * mounts. It calls the already-landed read-only Zotero Web API core
 * (`fetchZoteroLibrary` from `@galley/agent`) through the panel's INJECTED fetch,
 * then shapes the returned `CitationEntry[]` into the SAME `LibraryRow` /
 * `ImportLibraryResult` shape the panel already renders for a pasted library —
 * reusing `citation-library.ts`'s re-keying seam (`rekeyEntries` / `summariseRows`)
 * so a Zotero pull and a pasted .bib produce byte-identical reviewable rows.
 *
 * Security posture (mirrors the core, ADR-0016):
 *   - INJECTED fetch only — no global-fetch fallback here; the caller passes the
 *     panel's seam straight through to `deps.fetch`.
 *   - NEVER throws: every outcome is a structured {@link ZoteroImportResult}; an
 *     upstream failure becomes a typed `error` the UI can render.
 *   - The API key is read once, handed ONLY to the core (which sends it as a
 *     header, never in a URL), and is NEVER returned in any result — not in the
 *     rows, not in `error.message` (the core's messages are constant strings, and
 *     we add nothing). Callers keep the key in component state only; this helper
 *     never persists it.
 *   - `truncated` / `notModified` / `libraryVersion` are surfaced honestly from
 *     the core so a partial or unchanged pull is visible, never silently elided.
 */
import {
  fetchZoteroLibrary,
  type CitationInputKind,
  type ZoteroLibraryRef,
  type ZoteroError,
} from "@galley/agent";
import {
  rekeyEntries,
  summariseRows,
  type ImportLibraryResult,
} from "./citation-library.js";

/** A Zotero pull, shaped for the panel. `ok:false` carries a typed, key-safe error. */
export type ZoteroImportResult =
  | {
      ok: true;
      /** Reviewable, collision-free rows in the panel's library shape. */
      result: ImportLibraryResult;
      /** `Last-Modified-Version` of the library (null if absent/malformed). */
      libraryVersion: number | null;
      /** True when the conditional-fetch fast path fired (no rows transferred). */
      notModified: boolean;
      /** True when the page cap cut off a library with more pages pending. */
      truncated: boolean;
    }
  | { ok: false; error: ZoteroError };

export interface ConnectZoteroLibraryOptions {
  /** Which library to read (user/group + digits-only id). Validated by the core. */
  library: ZoteroLibraryRef;
  /**
   * The Zotero API key — passed straight to the core (header-only). Held by the
   * caller in memory only; this helper never returns or persists it.
   */
  apiKey: string;
  /** The panel's injected fetch — the ONLY network capability used. */
  fetch: typeof fetch;
  /** Cite-keys already in the bibliography, so pulled rows are collision-free. */
  existingKeys?: Iterable<string>;
  /** A prior `libraryVersion` to enable the unchanged-library fast path. */
  previousLibraryVersion?: number;
}

/** Zotero (and a paste) both yield offline-resolved entries → `bibtex` provenance. */
const ZOTERO_ROW_KIND: CitationInputKind = "bibtex";

/**
 * Pull a Zotero library (read-only) and shape it into reviewable rows. Never
 * throws — see the module header for the security posture. The API key reaches
 * ONLY the injected fetch (as a header, inside the core) and is absent from every
 * returned value, including `error.message`.
 */
export async function connectZoteroLibrary(
  opts: ConnectZoteroLibraryOptions,
): Promise<ZoteroImportResult> {
  const res = await fetchZoteroLibrary(
    {
      library: opts.library,
      apiKey: opts.apiKey,
      ...(opts.previousLibraryVersion !== undefined
        ? { previousLibraryVersion: opts.previousLibraryVersion }
        : {}),
    },
    { fetch: opts.fetch },
  );

  if (!res.ok) {
    // The core's error messages are constant strings (+ at most an HTTP status);
    // they never contain the key. We pass it through verbatim, adding nothing.
    return { ok: false, error: res.error };
  }

  const rows = rekeyEntries(res.entries, opts.existingKeys ?? [], ZOTERO_ROW_KIND);
  return {
    ok: true,
    result: summariseRows(rows),
    libraryVersion: res.libraryVersion,
    notModified: res.notModified,
    truncated: res.truncated,
  };
}
