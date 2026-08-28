/**
 * The Galley commit-message format (roadmap #11/#12) — the SINGLE encoder every
 * path that writes a Galley commit shares.
 *
 * Lifted out of `git-version-store`, which is Node-only (`node:fs` via
 * isomorphic-git) and therefore excluded from the browser barrel: the web app's
 * GitHub push (REST Git Data API) must stamp the SAME trailer block, or
 * attribution dies at exactly the place `git blame` reads it. Pure string work —
 * no `node:*`, no dependencies — so it is safe on BOTH barrels.
 */

/**
 * The encoder's slice of the version-creation input (structurally a subset of
 * `git-version-store`'s `CreateVersionInput`, so that seam passes straight in).
 */
export type VersionMessageInput = {
  name: string;
  message?: string;
  contributors?: string[];
  /** The saver's real identity — stamped as the commit author by the caller. */
  author?: { name: string; email: string };
};

/** A git trailer key carrying one contributor display label (roadmap #11). */
export const CONTRIBUTOR_TRAILER = "Galley-Contributor";
/** Standard git trailer co-authoring a commit (roadmap #12) — honored by GitHub/blame. */
export const COAUTHOR_TRAILER = "Co-authored-by";

/**
 * Upper bound on the number of contributor entries one commit message carries.
 * Contributor labels arrive from CRDT peers, so an unbounded swarm could
 * otherwise inflate the trailer block without limit — and it rides out to a
 * PAT-authenticated remote. 32 comfortably covers any real co-editing session.
 * The slice is applied ONCE at this single encodeMessage chokepoint, so it bounds
 * BOTH the local version store AND the GitHub snapshot push (which routes here).
 */
export const MAX_CONTRIBUTORS = 32;

/**
 * Commit message = subject (name) + optional body (message) + a trailing trailer
 * block, git-conventionally. The block carries:
 *   - `Galley-Contributor:` lines — one per contributor display label (roadmap
 *     #11); the SOURCE OF TRUTH that `decodeMessage` reads back to drive the
 *     HistoryPanel "by …" line.
 *   - `Co-authored-by: <name> <email>` lines (roadmap #12) — one per contributor
 *     who is NOT the primary commit author, with a synthesized stable noreply
 *     email. These are DERIVED output, never read back on decode.
 *
 * Display labels are UNTRUSTED (they reach here from CRDT peers, and ride out to
 * a PAT-authenticated remote), so every value goes through {@link sanitizeTrailer}
 * to hold two invariants:
 *   1. ONE LINE PER ENTRY — no label can forge a trailer line of its own.
 *   2. EXACTLY ONE `<…>` GROUP per emitted `Co-authored-by:` line, always the
 *      synthesized address. This is what makes the address unambiguous to ANY
 *      parser: with a second group present, a GREEDY matcher reads our address
 *      but a LAZY one reads the attacker's — and we do not control how GitHub
 *      (or any other reader) parses the trailer, so the safety of this line must
 *      not depend on that. A label like `Bob <ceo@company.com>` is exactly the
 *      attack; stripping `<`/`>` is what closes it.
 */
export function encodeMessage(input: VersionMessageInput): string {
  // The SUBJECT is untrusted too — a version name can be chosen adversarially (or
  // arrive from a peer). Fold CR/LF to a space so the name cannot open a second
  // paragraph and smuggle a forged trailer block that decodeMessage would read
  // back as a contributor. Only the newline fold is load-bearing here; we do NOT
  // run sanitizeTrailer on it, whose <>-strip/trim would over-mangle legit names.
  // NOTE: the BODY (input.message) is the same vector but is legitimately
  // multi-line (users write multi-paragraph messages), so it is left intact —
  // out of scope, documented.
  const parts: string[] = [input.name.replace(/[\r\n]+/g, " ")];
  if (input.message) parts.push(input.message);
  const contributors = (input.contributors ?? [])
    .filter((c) => c.length > 0)
    .slice(0, MAX_CONTRIBUTORS);
  const trailerLines: string[] = [];
  for (const c of contributors) {
    trailerLines.push(`${CONTRIBUTOR_TRAILER}: ${sanitizeTrailer(c)}`);
  }
  // Co-authored-by for every contributor that isn't the primary author (compare on
  // the sanitized name, since that's what lands in the commit's author field).
  const authorName = input.author ? sanitizeTrailer(input.author.name) : undefined;
  for (const c of contributors) {
    const name = sanitizeTrailer(c);
    if (authorName !== undefined && name === authorName) continue; // no self-co-author
    trailerLines.push(`${COAUTHOR_TRAILER}: ${name} <${coauthorEmail(name)}>`);
  }
  if (trailerLines.length > 0) parts.push(trailerLines.join("\n"));
  return parts.join("\n\n");
}

/**
 * Fold one UNTRUSTED display value into a safe trailer value. Two strips, each
 * defeating a distinct forgery:
 *   - CR/LF → a space: keeps the value on ONE line, so it cannot forge a trailer
 *     line of its own.
 *   - `<` and `>` removed: keeps it out of the ADDRESS slot. `Co-authored-by:` is
 *     emitted as `<name> <email>`, so a label like `Bob <ceo@company.com>` would
 *     otherwise put a SECOND `<…>` group on the line — see the one-address
 *     invariant on {@link encodeMessage}.
 * Sanitize, never reject: a hostile label must not be able to BLOCK someone
 * else's save or push.
 */
export function sanitizeTrailer(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

/**
 * Synthesize a stable noreply email for a contributor display LABEL (there is no
 * real email locally). Slugify the label (lowercase, non-alphanumerics → `-`,
 * collapse repeats, trim) under `@users.galley.local` so git blame groups a
 * person's co-authored work; an empty slug falls back to `unknown`.
 */
export function coauthorEmail(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "unknown"}@users.galley.local`;
}

export function decodeMessage(raw: string): {
  name: string;
  message?: string;
  contributors?: string[];
} {
  const trimmed = raw.replace(/\n+$/, "");
  // Pull the trailing trailer block out of the LAST paragraph. The block is
  // recognized when every line is EITHER a Galley-Contributor (#11) line OR a
  // Co-authored-by (#12) line; contributors are read from the Galley-Contributor
  // lines ONLY (Co-authored-by is derived output, ignored on decode).
  const blocks = trimmed.split("\n\n");
  const contribPrefix = `${CONTRIBUTOR_TRAILER}: `;
  const coauthorPrefix = `${COAUTHOR_TRAILER}: `;
  let contributors: string[] | undefined;
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1] as string;
    const lines = last.split("\n");
    const isTrailerBlock =
      lines.length > 0 &&
      lines.every((l) => l.startsWith(contribPrefix) || l.startsWith(coauthorPrefix));
    if (isTrailerBlock) {
      const contribs = lines
        .filter((l) => l.startsWith(contribPrefix))
        .map((l) => l.slice(contribPrefix.length));
      if (contribs.length > 0) contributors = contribs;
      blocks.pop();
    }
  }
  const rest = blocks.join("\n\n");
  const sep = rest.indexOf("\n\n");
  const name = sep < 0 ? rest : rest.slice(0, sep);
  const message = sep < 0 ? undefined : rest.slice(sep + 2);
  return {
    name,
    ...(message !== undefined ? { message } : {}),
    ...(contributors !== undefined ? { contributors } : {}),
  };
}
