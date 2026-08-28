/**
 * #15 agent-pane @-mention file context — pure helpers.
 *
 * Lets the author reference project files from the agent composer by typing
 * `@<path>`; the referenced files' contents are attached to the run as extra
 * context. PURE + side-effect-free so it's unit-testable in Node and the UI stays
 * a thin shell. No network, no document mutation: this only shapes the request
 * string handed to the agent (the raw prompt the user typed — and the thread
 * history — stay untouched; only the in-flight `agent.run` request is augmented).
 */

/** A file the agent can be pointed at: a canonical leading-slash path + its text. */
export interface MentionableFile {
  path: string;
  text: string;
}

/** Per-file attachment cap so a huge file can't blow the context window (or be a
 *  cheap way to balloon a request). Truncated content is marked. */
export const MENTION_ATTACH_MAX_CHARS = 16_000;

/** A mention token: `@` then a run of non-space, non-`@` characters. */
const MENTION_TOKEN_RE = /@[^\s@]+/g;

/** Normalize a typed path token to canonical leading-slash form for matching. */
function canonical(token: string): string {
  const trimmed = token.replace(/^\/+/, "");
  return `/${trimmed}`;
}

/**
 * The `@`-token currently being typed at the END of `text` (the caret is assumed
 * at the end — the composer's lightweight suggestion list only fires on the tail
 * token). Returns the query AFTER the `@` (possibly empty, e.g. just typed `@`),
 * or null when the tail isn't an open mention. A trailing space closes it.
 */
export function activeMentionQuery(text: string): string | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text);
  return m ? (m[2] ?? "") : null;
}

/**
 * Files whose path is `@`-mentioned anywhere in `text`. A token matches a file
 * when its canonical (leading-slash) form equals the file's path — so `@main.typ`
 * and `@/main.typ` both resolve `/main.typ`, while a partial like `@main` does
 * NOT (exact match avoids ambiguous prefixes). Deduped, in first-mention order.
 * Pure.
 */
export function resolveFileMentions(
  text: string,
  files: readonly MentionableFile[],
): MentionableFile[] {
  if (typeof text !== "string" || files.length === 0) return [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: MentionableFile[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const path = canonical(match[0].slice(1));
    const file = byPath.get(path);
    if (file && !seen.has(path)) {
      seen.add(path);
      out.push(file);
    }
  }
  return out;
}

/** Files to offer for the active mention query (substring match on the path,
 *  case-insensitive), capped for a tidy list. Empty query → all files. Pure. */
export function suggestMentions(
  query: string,
  files: readonly MentionableFile[],
  limit = 8,
): MentionableFile[] {
  const q = query.trim().toLowerCase().replace(/^\/+/, "");
  const matches = q.length === 0 ? files : files.filter((f) => f.path.toLowerCase().includes(q));
  return matches.slice(0, limit);
}

/** One file's attachment block, content capped + marked when truncated. */
function attachmentBlock(file: MentionableFile): string {
  const body =
    file.text.length > MENTION_ATTACH_MAX_CHARS
      ? `${file.text.slice(0, MENTION_ATTACH_MAX_CHARS)}\n…(truncated)`
      : file.text;
  return `--- ${file.path} ---\n${body}`;
}

/**
 * Build the request actually sent to the agent: the raw prompt, plus an attached
 * context block for each `@`-mentioned file. Returns the request UNCHANGED when
 * nothing resolves (byte-for-byte the no-mention path). Pure.
 */
export function composeAgentRequest(request: string, files: readonly MentionableFile[]): string {
  const attachments = resolveFileMentions(request, files);
  if (attachments.length === 0) return request;
  const blocks = attachments.map(attachmentBlock).join("\n\n");
  return `${request}\n\n[Attached file context — the user referenced these with @:]\n\n${blocks}`;
}
