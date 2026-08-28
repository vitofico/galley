/**
 * #17.1 Mendeley library UI seam (sibling of `zotero-import.ts`) — the pure helper
 * the CitationPanel's "Mendeley" tab mounts. It calls the already-landed read-only
 * Mendeley Web API core (`fetchMendeleyLibrary` from `@galley/agent`) through the
 * panel's INJECTED fetch, then shapes the returned `CitationEntry[]` into the SAME
 * `LibraryRow` / `ImportLibraryResult` shape the panel already renders for a pasted
 * library — reusing `citation-library.ts`'s re-keying seam (`rekeyEntries` /
 * `summariseRows`) so a Mendeley pull and a pasted .bib produce byte-identical
 * reviewable rows.
 *
 * AUTH (OSS boundary): Mendeley's token IS an OAuth2 *bearer access token* the user
 * obtains out-of-band and pastes; the full OAuth "Link" redirect flow is HOSTED-ONLY
 * (galley-cloud C3). The token reaches ONLY the core (which sends it as a header,
 * never in a URL) — there is no OAuth redirect/login flow in this OSS repo.
 *
 * Security posture (mirrors the core, ADR-0016):
 *   - INJECTED fetch only — no global-fetch fallback here; the caller passes the
 *     panel's seam straight through to `deps.fetch`.
 *   - NEVER throws: every outcome is a structured {@link MendeleyImportResult}; an
 *     upstream failure becomes a typed `error` the UI can render.
 *   - The access token is read once, handed ONLY to the core (which sends it as a
 *     header, never in a URL), and is NEVER returned in any result — not in the
 *     rows, not in `error.message` (the core's messages are constant strings, and
 *     we add nothing). Callers keep the token in component state only; this helper
 *     never persists it.
 *   - `truncated` is surfaced honestly from the core so a partial pull is visible,
 *     never silently elided. (Mendeley has no library version / notModified path.)
 */
import { fetchMendeleyLibrary, type CitationInputKind, type MendeleyError } from "@galley/agent";
import {
  rekeyEntries,
  summariseRows,
  type ImportLibraryResult,
} from "./citation-library.js";

/** A Mendeley pull, shaped for the panel. `ok:false` carries a typed, token-safe error. */
export type MendeleyImportResult =
  | {
      ok: true;
      /** Reviewable, collision-free rows in the panel's library shape. */
      result: ImportLibraryResult;
      /** True when the page cap cut off a library with more pages pending. */
      truncated: boolean;
    }
  | { ok: false; error: MendeleyError };

export interface ConnectMendeleyLibraryOptions {
  /**
   * The Mendeley OAuth2 bearer access token — passed straight to the core
   * (header-only). Held by the caller in memory only; this helper never returns or
   * persists it.
   */
  apiToken: string;
  /** The panel's injected fetch — the ONLY network capability used. */
  fetch: typeof fetch;
  /** Cite-keys already in the bibliography, so pulled rows are collision-free. */
  existingKeys?: Iterable<string>;
}

/** Mendeley (and a paste) both yield offline-resolved entries → `bibtex` provenance. */
const MENDELEY_ROW_KIND: CitationInputKind = "bibtex";

/**
 * Pull a Mendeley library (read-only) and shape it into reviewable rows. Never
 * throws — see the module header for the security posture. The access token reaches
 * ONLY the injected fetch (as a header, inside the core) and is absent from every
 * returned value, including `error.message`.
 */
export async function connectMendeleyLibrary(
  opts: ConnectMendeleyLibraryOptions,
): Promise<MendeleyImportResult> {
  const res = await fetchMendeleyLibrary(
    { apiToken: opts.apiToken },
    { fetch: opts.fetch },
  );

  if (!res.ok) {
    // The core's error messages are constant strings (+ at most an HTTP status);
    // they never contain the token. We pass it through verbatim, adding nothing.
    return { ok: false, error: res.error };
  }

  const rows = rekeyEntries(res.entries, opts.existingKeys ?? [], MENDELEY_ROW_KIND);
  return {
    ok: true,
    result: summariseRows(rows),
    truncated: res.truncated,
  };
}
