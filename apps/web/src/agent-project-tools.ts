/**
 * Roadmap #3 — the web app's `ProjectToolsSeam` (the agent's read-only project
 * tools: search_project / list_files / read_file).
 *
 * A PURE builder over an injected `getFiles()` reader: the closure is consulted
 * on EVERY tool call, so the tools see the project AS IT EXISTS AT CALL TIME
 * (multi-file awareness over the live CRDT) — never a render-time copy that
 * would go stale while a run streams. ProjectApp supplies a reader over the
 * live `CollabProject` snapshot, filtered to the SAME visible set as the file
 * tree (`.galley/*` reserved config excluded), so the agent can read exactly
 * what the human can see and nothing more.
 *
 * Search delegates to the existing pure `searchProjectFiles` (Tier E #2 "find
 * in files") — same literal, case-insensitive substring semantics the Search
 * panel uses, so the agent and the human get identical answers. The registry
 * (packages/agent/src/tool-registry.ts) re-caps every output regardless, so
 * nothing here needs to defend the model context.
 *
 * No React, no DOM, no Yjs — unit-tested in the node gate.
 */

import type { ProjectToolsSeam } from "@galley/agent";
import { searchProjectFiles, type SearchInputFile } from "./project-search.js";

/**
 * Tolerate the model omitting (or adding) the leading "/" on a path: project
 * paths are stored with a leading slash ("/main.typ"), but a model will often
 * say "main.typ". Both sides are normalized, so the match is exact otherwise —
 * no globbing, no traversal (the candidate set is the closed project list).
 */
function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Build the agent's optional project seams from a live-file reader.
 *
 * `getFiles` must return the CURRENT {fileId, path, text} rows on every call —
 * pass a closure over the live project, not a captured array.
 */
export function buildProjectToolsSeam(getFiles: () => SearchInputFile[]): ProjectToolsSeam {
  return {
    listFiles: () => getFiles().map((f) => ({ fileId: f.fileId, path: f.path })),
    readFile: (path) => {
      const wanted = normalizePath(path);
      const hit = getFiles().find((f) => normalizePath(f.path) === wanted);
      return hit ? hit.text : null;
    },
    // `searchProjectFiles` already caps matches/files; the registry clamps
    // again to its own context-budget caps. Structural fit: `SearchResult`
    // carries extra per-match fields (offsets/columns) the seam type ignores.
    search: (query) => searchProjectFiles(getFiles(), query),
  };
}
