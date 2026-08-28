/**
 * Roadmap #9 slice 2 — retrieval + selection over chunks (pure, offline).
 *
 * Given a query (e.g. the user's request) and a document's {@link Chunk}s, rank by
 * relevance and select the most relevant within a budget — so the agent receives
 * *selected* context, not the whole doc. The default ranker is **BM25** (lexical,
 * dependency-free, deterministic). An optional **embedding seam** lets semantic
 * retrieval swap in; the cosine/ranking helpers are pure (the `embed` call is
 * injected, fake in tests — no model in the gate).
 */
import type { Chunk } from "./chunk.js";

export interface Retrieved {
  chunk: Chunk;
  score: number;
}

export interface SelectOptions {
  /** Char budget for the selected context (token proxy). Default 6000. */
  maxChars?: number;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A chunk's searchable text includes its heading path (high-signal terms). */
function searchableText(c: Chunk): string {
  return `${c.headingPath.join(" ")} ${c.text}`;
}

/** A Typst heading line: one-or-more `=`, whitespace, then a title. */
const HEADING_LINE_RE = /^=+[ \t]+\S/;

/**
 * A "heading-only" chunk carries no content-bearing prose: once its heading
 * line(s) and blank lines are removed, nothing is left. Such stubs are tiny, and
 * BM25 length-normalization inflates their score so a bare section heading can
 * outrank a long section that actually contains the answer. We detect them so
 * ranking/selection can demote them below real content (but still surface them
 * when a query is purely structural and there is no content to return).
 */
export function isHeadingOnly(chunk: Chunk): boolean {
  for (const line of chunk.text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // blank line
    if (HEADING_LINE_RE.test(trimmed)) continue; // a heading line
    return false; // content-bearing prose
  }
  return true;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * Rank chunks by BM25 relevance to `query` (desc; ties broken by document order).
 *
 * Heading-only chunks (bare `= Section` stubs with no prose) are demoted **below**
 * any content-bearing chunk that scored > 0, so length-normalization can't let a
 * tiny heading outrank the section that actually answers the query. They keep
 * their own positive score and relative order, so a purely structural/outline
 * query (where no content chunk matches) still ranks the right heading first.
 */
export function rankChunks(chunks: Chunk[], query: string): Retrieved[] {
  const queryTerms = [...new Set(tokenize(query))];
  const docs = chunks.map((c) => tokenize(searchableText(c)));
  const n = docs.length;
  const avgdl = n > 0 ? docs.reduce((sum, d) => sum + d.length, 0) / n : 0;

  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const scored = chunks.map((chunk, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of queryTerms) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const dfi = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - dfi + 0.5) / (dfi + 0.5));
      const norm = avgdl > 0 ? d.length / avgdl : 1;
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * norm)));
    }
    return { chunk, score, headingOnly: isHeadingOnly(chunk) };
  });

  // Tier content-bearing matches above heading-only stubs (when the stub would
  // otherwise be inflated past real content). Within each tier: score desc, then
  // document order. A heading-only chunk only loses to a content chunk that
  // actually scored > 0 — so structure-only queries are unaffected.
  return scored
    .sort((a, b) => {
      if (a.headingOnly !== b.headingOnly) {
        const aRelevant = !a.headingOnly && a.score > 0;
        const bRelevant = !b.headingOnly && b.score > 0;
        if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;
      }
      return b.score - a.score || a.chunk.start - b.chunk.start;
    })
    .map(({ chunk, score }) => ({ chunk, score }));
}

/**
 * Select the most relevant chunks within a char budget, returned in DOCUMENT
 * ORDER (so the model reads coherent, in-sequence context). Greedy by rank;
 * guarantees at least the single best chunk when the query matches nothing well.
 */
export function selectContext(chunks: Chunk[], query: string, opts: SelectOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 6000;
  const ranked = rankChunks(chunks, query);

  // When the query is answered by real content, don't let tiny heading-only
  // stubs greedily consume the budget and crowd out the on-topic section (which
  // is often longer and gets skipped for size). Filter them from the fill; the
  // fallback below still guarantees the best chunk is returned. If NOTHING is
  // content-bearing (e.g. an all-headings outline doc), keep the stubs eligible
  // so structural queries still return their heading.
  const hasRelevantContent = ranked.some((r) => r.score > 0 && !isHeadingOnly(r.chunk));
  const fillable = hasRelevantContent ? ranked.filter((r) => !isHeadingOnly(r.chunk)) : ranked;

  const picked: Chunk[] = [];
  let used = 0;
  for (const { chunk } of fillable) {
    if (used + chunk.text.length <= maxChars) {
      picked.push(chunk);
      used += chunk.text.length;
    }
  }
  if (picked.length === 0 && ranked.length > 0) picked.push(ranked[0]!.chunk);
  return picked.sort((a, b) => a.start - b.start);
}

/** Embedding provider (injected). Returns one vector per input text, same order. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** Cosine similarity of two equal-length vectors (0 if either is a zero vector). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Rank chunks by semantic similarity to a query vector (pure — the caller embeds
 * the query + chunks via an injected {@link Embedder}). Desc by similarity, ties
 * by document order.
 */
export function rankBySimilarity(chunks: Chunk[], queryVec: number[], chunkVecs: number[][]): Retrieved[] {
  return chunks
    .map((chunk, i) => ({ chunk, score: cosineSimilarity(queryVec, chunkVecs[i] ?? []) }))
    .sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);
}
