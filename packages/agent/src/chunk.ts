/**
 * Roadmap #9 — context economics: the Typst document chunker (pure, offline).
 *
 * As a document grows, sending the agent the WHOLE doc wastes context and money.
 * The first step is to split the source into retrievable, structural chunks. This
 * module is framework-free and deterministic: it splits by Typst headings (so each
 * chunk carries its section path), and splits an oversized section at paragraph
 * (blank-line) boundaries to respect a char budget. Ranking/selection (slice 2) and
 * the agent-loop integration (slice 3, Architect-consulted) build on this.
 */

export interface Chunk {
  /** Stable, unique id (document order): `c0`, `c1`, … */
  id: string;
  /** The exact source slice — `source.slice(start, end) === text`. */
  text: string;
  /** The heading path of the section this chunk belongs to (e.g. ["Intro", "Aim"]). */
  headingPath: string[];
  start: number;
  end: number;
}

export interface ChunkOptions {
  /** Soft max chunk size in chars; oversized sections split at paragraph breaks. Default 2000. */
  maxChars?: number;
}

/** A Typst heading line: one-or-more `=`, whitespace, then a non-empty title. */
const HEADING_RE = /^(=+)[ \t]+(.*?)[ \t]*\n?$/;

interface Section {
  headingPath: string[];
  start: number;
  end: number;
}

export function chunkDocument(source: string, opts: ChunkOptions = {}): Chunk[] {
  if (source.length === 0) return [];
  const maxChars = opts.maxChars ?? 2000;

  // Phase 1 — segment into sections by heading. Each section spans from its
  // heading line (or doc start, for the preamble) up to the next heading line.
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let secStart = 0;
  let secPath: string[] = [];
  const flush = (end: number): void => {
    if (end > secStart) sections.push({ headingPath: [...secPath], start: secStart, end });
  };

  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const m = line.match(HEADING_RE);
    if (m !== null && (m[2]?.length ?? 0) > 0) {
      flush(offset); // close the previous section at this heading's start
      const level = m[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: m[2]! });
      secPath = stack.map((s) => s.title);
      secStart = offset;
    }
    offset += line.length;
  }
  flush(source.length);

  // Phase 2 — pack each section into chunks ≤ maxChars at paragraph boundaries.
  const chunks: Chunk[] = [];
  for (const sec of sections) {
    const text = source.slice(sec.start, sec.end);
    for (const span of packParagraphs(text, maxChars)) {
      chunks.push({
        id: `c${chunks.length}`,
        text: text.slice(span.start, span.end),
        headingPath: sec.headingPath,
        start: sec.start + span.start,
        end: sec.start + span.end,
      });
    }
  }
  return chunks;
}

/**
 * Greedily pack a section's paragraphs (separated by blank lines) into contiguous
 * spans ≤ maxChars. Separators stay attached to the preceding paragraph, so the
 * spans tile the whole section exactly (each chunk round-trips to a source slice).
 * A single paragraph larger than the budget becomes its own (over-budget) span.
 */
function packParagraphs(text: string, maxChars: number): { start: number; end: number }[] {
  if (text.length <= maxChars) return [{ start: 0, end: text.length }];

  // Paragraph cut points = the end index of each blank-line run.
  const cuts: number[] = [];
  const re = /\n[ \t]*\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) cuts.push(m.index + m[0].length);

  const paras: [number, number][] = [];
  let prev = 0;
  for (const c of cuts) {
    paras.push([prev, c]);
    prev = c;
  }
  if (prev < text.length) paras.push([prev, text.length]);

  const out: { start: number; end: number }[] = [];
  let spanStart = paras.length > 0 ? paras[0]![0] : 0;
  let spanEnd = spanStart;
  for (const [, pe] of paras) {
    if (spanEnd > spanStart && pe - spanStart > maxChars) {
      out.push({ start: spanStart, end: spanEnd });
      spanStart = spanEnd;
    }
    spanEnd = pe;
  }
  if (spanEnd > spanStart) out.push({ start: spanStart, end: spanEnd });
  return out;
}
