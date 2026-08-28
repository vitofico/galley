/**
 * Roadmap #9 slice 3a — retrieval-aware `read_document` view (pure, offline).
 *
 * As a document grows, sending the agent the WHOLE source on every `read_document`
 * wastes context and money. This module renders a *selected* view of the scratch
 * for the agent loop, built on the slice-1 chunker + slice-2 BM25 retrieval, while
 * keeping the search/replace editing contract unchanged (edits always run against
 * the full scratch; the view only governs what the model *reads*).
 *
 * Design (Architect-consulted; recorded in STATUS.md "Epic 9 Slice 3"):
 *   - A run opts in via `RunAgentOptions.context = { mode: "retrieval", … }`, and
 *     retrieval activates ONLY when the base source exceeds `thresholdChars`. The
 *     decision is made ONCE per run so the tool schema + system prompt stay stable
 *     mid-run. The default (`{ mode: "full" }` / no option / small doc) path is
 *     byte-for-byte unchanged — the loop keeps using `lineNumbered(scratch)`.
 *   - When active, `read_document` gains scopes: `selected` (default — BM25 over the
 *     user request, rendered with TRUE full-doc line numbers + explicit
 *     `… omitted lines X–Y …` markers), `range {startLine,endLine}` (a line window),
 *     and `full` (the whole doc — escape hatch).
 *   - Diagnostic-span pinning: chunks overlapping the latest compile's error spans
 *     are pinned FIRST, then BM25 fills the budget — so self-correction always sees
 *     the erroring region. Re-selected lazily on each `read_document`.
 *
 * Everything here is pure and deterministic (no model, no network, no WASM), so it
 * unit-tests offline in the Docker gate.
 */

import type { CheckResult } from "@galley/shared";
import { chunkDocument, type Chunk } from "./chunk.js";
import { rankChunks, type Retrieved } from "./retrieve.js";
import { SYSTEM_PROMPT, lineNumbered } from "./tools.js";

/**
 * Ranks chunks by relevance to a query (best first). The default is lexical BM25
 * ({@link rankChunks}); injecting one lets semantic retrieval swap in (e.g. an
 * `Embedder` + `rankBySimilarity`) without the agent loop importing a model — the
 * `embed` call stays the caller's concern, so the Node gate stays offline. May be
 * async (embedding is a network/model call in production).
 */
export type ChunkRanker = (chunks: Chunk[], query: string) => Retrieved[] | Promise<Retrieved[]>;

/** Per-run context-economics options (default OFF — `mode:"full"`). */
export interface RetrievalContextOptions {
  mode: "full" | "retrieval";
  /** Retrieval activates only when `baseSource.length` exceeds this. Default 24000. */
  thresholdChars?: number;
  /** Char budget for the `selected` excerpt (token proxy). Default 6000. */
  maxChars?: number;
  /** Soft max per chunk when splitting the doc. Default 2000. */
  chunkMaxChars?: number;
  /** Override the chunk ranker for the `selected` scope. Default lexical BM25. */
  ranker?: ChunkRanker;
}

export const DEFAULT_THRESHOLD_CHARS = 24_000;
export const DEFAULT_SELECT_MAX_CHARS = 6_000;
export const DEFAULT_CHUNK_MAX_CHARS = 2_000;

/**
 * Decide ONCE per run whether retrieval is active: only in `retrieval` mode AND
 * when the base source is larger than the threshold. Small docs stay on the
 * unchanged full-document path.
 */
export function retrievalActive(
  ctx: RetrievalContextOptions | undefined,
  baseSource: string,
): boolean {
  if (ctx?.mode !== "retrieval") return false;
  const threshold = ctx.thresholdChars ?? DEFAULT_THRESHOLD_CHARS;
  return baseSource.length > threshold;
}

/**
 * The retrieval-scoped `read_document` spec and the retrieval tool set now live
 * in (and are DERIVED from) the shared tool registry (roadmap #3) — re-exported
 * here so every existing import path keeps working unchanged. The retrieval
 * spec keeps the identical `read_document` name (so the editing contract + tool
 * plumbing are unchanged), and `RETRIEVAL_TOOLS` still shares the compile /
 * propose_edit spec OBJECTS with `AGENT_TOOLS` (tests pin that identity).
 */
export { RETRIEVAL_READ_DOCUMENT, RETRIEVAL_TOOLS } from "./tool-registry.js";

/** The system prompt when retrieval is active: base prompt + the selected-view guide. */
export const RETRIEVAL_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

This document is large, so read_document returns SELECTED context by default: the
sections most relevant to your task, shown with TRUE document line numbers and
"… omitted lines X–Y …" markers where text is hidden. To navigate, call
read_document with scope:"outline" for a heading map, then scope:"section" with a
heading to read one whole section; scope:"range" with {startLine,endLine} for a
specific window, or scope:"full" for the entire document; pass query:"…" to refocus
the excerpt. Your edits still match on the document TEXT via search/replace — never
on line numbers — and apply against the full document even when a region was omitted
from your view.`;

/** What the renderer needs from the running loop to build a view. */
export interface ContextRenderCtx {
  scratch: string;
  userRequest: string;
  lastCheck: CheckResult | null;
  maxChars: number;
  chunkMaxChars: number;
}

/** A rendered `read_document` result: the text fed to the model + a short UI summary. */
export interface RenderedRead {
  text: string;
  summary: string;
}

/** Number of real lines (excludes the trailing empty element from a final newline). */
function realLineCount(scratch: string): number {
  const parts = scratch.split("\n");
  return scratch.endsWith("\n") ? parts.length - 1 : parts.length;
}

/**
 * Render the scratch showing only the lines in `shown` (1-based), with true line
 * numbers and a single `… omitted lines X–Y …` marker collapsing each hidden run.
 */
function renderWindows(
  scratch: string,
  shown: Set<number>,
): { text: string; shownCount: number; lineCount: number } {
  const rawLines = scratch.split("\n");
  const lineCount = realLineCount(scratch);
  const width = String(Math.max(lineCount, 1)).length;
  const out: string[] = [];
  let omitStart = 0;
  let shownCount = 0;
  const flush = (endLine: number): void => {
    if (omitStart > 0) {
      out.push(`… omitted lines ${omitStart}–${endLine} …`);
      omitStart = 0;
    }
  };
  for (let ln = 1; ln <= lineCount; ln++) {
    if (shown.has(ln)) {
      flush(ln - 1);
      out.push(`${String(ln).padStart(width, " ")}| ${rawLines[ln - 1]!}`);
      shownCount += 1;
    } else if (omitStart === 0) {
      omitStart = ln;
    }
  }
  flush(lineCount);
  return { text: out.join("\n"), shownCount, lineCount };
}

/** The 1-based line numbers covered by the selected chunks (chunks tile at line starts). */
function coveredLines(scratch: string, picked: Chunk[]): Set<number> {
  const rawLines = scratch.split("\n");
  const shown = new Set<number>();
  let off = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const lineStart = off;
    if (picked.some((ch) => ch.start <= lineStart && lineStart < ch.end)) shown.add(i + 1);
    off += rawLines[i]!.length + 1;
  }
  return shown;
}

/**
 * Error spans from the latest check, clamped to the current scratch. A zero-length
 * or end-of-file span (e.g. "unexpected end of input", reported at `scratch.length`)
 * is mapped onto the last code unit so it still OVERLAPS the final chunk — otherwise
 * the erroring tail would never be pinned. Spans whose start is past the (possibly
 * shrunk) scratch are stale and dropped (fail safe — no pin, no crash).
 */
function errorSpans(ctx: ContextRenderCtx): { start: number; end: number }[] {
  const len = ctx.scratch.length;
  return (ctx.lastCheck?.diagnostics ?? [])
    .filter((d) => d.severity === "error" && d.span)
    .map((d) => ({ start: d.span!.offset, end: d.span!.endOffset }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.start <= len)
    .map((s) => {
      const start = Math.min(s.start, Math.max(0, len - 1));
      const end = Math.min(Math.max(s.end, start + 1), Math.max(len, start + 1));
      return { start, end };
    });
}

/** Build the BM25 query from the request, an optional model query, + diagnostic text. */
function buildQuery(ctx: ContextRenderCtx, modelQuery: string | undefined): string {
  const diag = (ctx.lastCheck?.diagnostics ?? []).map((d) => d.message).join(" ");
  return [ctx.userRequest, modelQuery ?? "", diag].filter((s) => s.trim().length > 0).join(" ");
}

/**
 * Select chunks for the `selected` view: pin chunks overlapping the latest error
 * spans FIRST (mandatory, so self-correction sees the erroring region), then
 * BM25-fill the remaining budget. Returned in document order.
 */
export async function selectChunks(
  ctx: ContextRenderCtx,
  modelQuery?: string,
  ranker: ChunkRanker = rankChunks,
): Promise<Chunk[]> {
  const chunks = chunkDocument(ctx.scratch, { maxChars: ctx.chunkMaxChars });
  if (chunks.length === 0) return [];

  const spans = errorSpans(ctx);
  const picked: Chunk[] = [];
  const pickedIds = new Set<string>();
  let used = 0;

  // Pinned (error-overlapping) chunks first, in document order — always included.
  for (const ch of chunks) {
    const overlapsError = spans.some((s) => s.start < ch.end && s.end > ch.start);
    if (overlapsError) {
      picked.push(ch);
      pickedIds.add(ch.id);
      used += ch.text.length;
    }
  }

  // Relevance fill within the remaining budget (BM25 by default; injected ranker
  // otherwise). Guard against a misbehaving injected ranker: ignore any entry that
  // isn't one of THIS document's chunks (its offsets wouldn't map to the scratch).
  const validIds = new Set(chunks.map((c) => c.id));
  const ranked = (await ranker(chunks, buildQuery(ctx, modelQuery))).filter((r) =>
    validIds.has(r.chunk.id),
  );
  for (const { chunk } of ranked) {
    if (pickedIds.has(chunk.id)) continue;
    if (used + chunk.text.length <= ctx.maxChars) {
      picked.push(chunk);
      pickedIds.add(chunk.id);
      used += chunk.text.length;
    }
  }

  // Always surface at least one chunk, even if the ranker returned nothing usable.
  if (picked.length === 0) picked.push(ranked[0]?.chunk ?? chunks[0]!);

  return picked.sort((a, b) => a.start - b.start);
}

/** 1-based line number containing `offset` (the line `offset` falls on). */
function lineAt(scratch: string, offset: number): number {
  return scratch.slice(0, Math.max(0, offset)).split("\n").length;
}

interface DocSection {
  headingPath: string[];
  start: number;
  end: number;
}

/** True if a chunk's first line is a Typst heading (`=+` then a non-empty title). */
function startsWithHeading(text: string): boolean {
  return /^(=+)[ \t]+\S/.test(text);
}

/**
 * Merge the chunks the chunker split out of one section back into whole sections.
 * A continuation chunk shares its heading path AND does NOT begin with a heading
 * line; a chunk that begins with a heading starts a NEW section even when its
 * heading path matches the previous one — so two distinct sections that happen to
 * share a heading title (e.g. two "= Notes") are kept separate, not collapsed.
 */
function documentSections(chunks: Chunk[]): DocSection[] {
  const secs: DocSection[] = [];
  for (const ch of chunks) {
    const last = secs[secs.length - 1];
    const isContinuation =
      last !== undefined &&
      last.end === ch.start &&
      !startsWithHeading(ch.text) &&
      last.headingPath.length === ch.headingPath.length &&
      last.headingPath.every((p, i) => p === ch.headingPath[i]);
    if (isContinuation) last.end = ch.end;
    else secs.push({ headingPath: [...ch.headingPath], start: ch.start, end: ch.end });
  }
  return secs;
}

/** A compact heading map (no bodies) so the model can navigate a large doc cheaply. */
function renderOutline(scratch: string, chunkMaxChars: number): RenderedRead {
  const secs = documentSections(chunkDocument(scratch, { maxChars: chunkMaxChars }));
  const lineCount = realLineCount(scratch);
  const lines = secs.map((s) => {
    const at = `L${lineAt(scratch, s.start)}`;
    if (s.headingPath.length === 0) return `${at}: (preamble)`;
    const title = s.headingPath[s.headingPath.length - 1]!;
    return `${at}: ${"=".repeat(s.headingPath.length)} ${title}`;
  });
  const body = lines.length > 0 ? lines.join("\n") : "(no headings)";
  return {
    text: `Document outline (${lineCount} lines total):\n${body}`,
    summary: `outline: ${secs.length} section(s)`,
  };
}

/** Render one whole section selected by heading title (case-insensitive). */
function renderSection(scratch: string, heading: string, chunkMaxChars: number): RenderedRead | null {
  const secs = documentSections(chunkDocument(scratch, { maxChars: chunkMaxChars }));
  const needle = heading.trim().toLowerCase();
  if (needle.length === 0) return null;
  const titled = secs.filter((s) => s.headingPath.length > 0);
  const match =
    titled.find((s) => s.headingPath[s.headingPath.length - 1]!.toLowerCase() === needle) ??
    titled.find((s) => s.headingPath[s.headingPath.length - 1]!.toLowerCase().includes(needle));
  if (!match) return null;
  const startLine = lineAt(scratch, match.start);
  const endLine = lineAt(scratch, Math.max(match.start, match.end - 1));
  const shown = new Set<number>();
  for (let ln = startLine; ln <= endLine; ln++) shown.add(ln);
  const r = renderWindows(scratch, shown);
  return {
    text: r.text,
    summary: `section "${match.headingPath[match.headingPath.length - 1]!}" (lines ${startLine}–${endLine} of ${r.lineCount})`,
  };
}

function parseRange(
  raw: unknown,
  lineCount: number,
): { startLine: number; endLine: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { startLine, endLine } = raw as Record<string, unknown>;
  if (typeof startLine !== "number" || typeof endLine !== "number") return null;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;
  const start = Math.max(1, Math.min(Math.floor(startLine), lineCount));
  const end = Math.max(start, Math.min(Math.floor(endLine), lineCount));
  return { startLine: start, endLine: end };
}

/**
 * Render `read_document` for an active-retrieval run. Dispatches on the model's
 * `scope` arg (`selected` default / `range` / `full`); an invalid scope or range
 * falls back to `selected`.
 */
export async function renderRetrievalRead(
  args: unknown,
  ctx: ContextRenderCtx,
  ranker: ChunkRanker = rankChunks,
): Promise<RenderedRead> {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const knownScopes = ["selected", "range", "full", "outline", "section"] as const;
  const scope = (knownScopes as readonly string[]).includes(a.scope as string)
    ? (a.scope as (typeof knownScopes)[number])
    : "selected";
  const modelQuery = typeof a.query === "string" ? a.query : undefined;

  if (scope === "full") {
    return {
      text: lineNumbered(ctx.scratch),
      summary: `${ctx.scratch.split("\n").length} lines (full)`,
    };
  }

  if (scope === "outline") {
    return renderOutline(ctx.scratch, ctx.chunkMaxChars);
  }

  if (scope === "section") {
    if (typeof a.heading === "string") {
      const rendered = renderSection(ctx.scratch, a.heading, ctx.chunkMaxChars);
      if (rendered) return rendered;
    }
    // Missing/unknown heading → fall through to the selected excerpt.
  }

  if (scope === "range") {
    const range = parseRange(a.range, realLineCount(ctx.scratch));
    if (range) {
      const shown = new Set<number>();
      for (let ln = range.startLine; ln <= range.endLine; ln++) shown.add(ln);
      const r = renderWindows(ctx.scratch, shown);
      return {
        text: r.text,
        summary: `lines ${range.startLine}–${range.endLine} of ${r.lineCount}`,
      };
    }
    // Invalid range → fall through to the selected excerpt.
  }

  const chunks = chunkDocument(ctx.scratch, { maxChars: ctx.chunkMaxChars });
  if (chunks.length === 0) {
    return { text: lineNumbered(ctx.scratch), summary: `${realLineCount(ctx.scratch)} lines` };
  }
  const picked = await selectChunks(ctx, modelQuery, ranker);
  const r = renderWindows(ctx.scratch, coveredLines(ctx.scratch, picked));
  return {
    text: r.text,
    summary: `selected ${picked.length} section(s); ${r.shownCount}/${r.lineCount} lines`,
  };
}
