/**
 * Agent-pane `/` quick-actions — pure helpers.
 *
 * Typing `/` at the START of the composer offers a catalog of canned prompts;
 * choosing one EXPANDS it into the composer text. Deliberately a pure text
 * transform on the composer buffer — the expansion is just a prompt the author
 * could have typed, so `onSend`, the run path and the human Accept gate are all
 * untouched. Choosing an action never sends: the author still reads, edits and
 * sends the prompt themselves.
 *
 * Mirrors `agent-mentions.ts` (same shape, same conventions) with one deliberate
 * difference: `@` is a mid-text token, `/` is a whole-prompt PREFIX — so the
 * query here is START-ANCHORED.
 */

/** One canned prompt: the token you type, how it reads in the picker, and the
 *  prompt text it expands to. */
export interface SlashAction {
  id: string;
  label: string;
  hint: string;
  template: string;
}

/**
 * The static catalog. Static on purpose: these prompts depend on nothing about
 * the project, so the picker needs no host seam and this ships without touching
 * the agent pane's wiring.
 *
 * The templates ARE the feature — each one is scoped (says what NOT to touch),
 * Typst-native, and guards the failure mode that matters for that action:
 * silent rewrites, invented sources, drifting voice.
 */
export const SLASH_ACTIONS: readonly SlashAction[] = [
  {
    id: "fix",
    label: "Fix compile errors",
    hint: "smallest change that compiles",
    template:
      "Fix the Typst compile errors in this document. Make the smallest change that " +
      "compiles: correct the markup only — do not reword prose, renumber anything, or " +
      "restructure the document. For each error, tell me what was broken and why your " +
      "change is the fix.",
  },
  {
    id: "proofread",
    label: "Proofread",
    hint: "grammar and consistency only",
    template:
      "Proofread this document for grammar, spelling, punctuation and consistent " +
      "terminology. Fix only what is actually wrong — do not rewrite for style, and " +
      "leave the argument, the citations and all Typst markup untouched. Where a " +
      "sentence is ambiguous, flag it and tell me what you think I meant instead of " +
      "silently picking a reading.",
  },
  {
    id: "shorten",
    label: "Shorten",
    hint: "tighten without losing content",
    template:
      "Tighten this text without losing information. Cut hedging, redundancy and " +
      "filler; prefer the shorter phrasing wherever the meaning is identical. Keep my " +
      "voice, every claim, and all citations, cross-references and Typst markup intact. " +
      "Aim for roughly 20% shorter, and tell me if a cut would lose something real.",
  },
  {
    id: "expand",
    label: "Expand",
    hint: "make the reasoning explicit",
    template:
      "Expand this passage: make the argument explicit and spell out the steps a reader " +
      "would otherwise have to infer. Keep exactly the same claims — do not invent " +
      "results, numbers, sources or conclusions that are not already supported here. " +
      "Match the surrounding voice and Typst markup.",
  },
  {
    id: "explain",
    label: "Explain this",
    hint: "answer only, no edits",
    template:
      "Explain how this part of the document works — the argument it makes and any Typst " +
      "markup involved — in plain language. Answer only: do not propose any edit to the " +
      "document. If something looks wrong, say so rather than fixing it.",
  },
  {
    id: "cite",
    label: "Check citations",
    hint: "unsupported claims; never invents sources",
    template:
      "Find the claims in this document that need a citation but do not have one. For " +
      "each, quote the sentence and say what kind of source would support it. Only add a " +
      "reference if that key ALREADY exists in the bibliography — never invent a " +
      "citation key, an author, a year or a source. Also flag any reference that no " +
      "longer matches the claim it is attached to.",
  },
];

/** A leading slash token: `/` then a run of non-space, non-`/` characters. */
const LEADING_SLASH_TOKEN_RE = /^\/([^\s/]*)/;

/**
 * The slash token being typed at the START of `text`, or null when `text` isn't
 * an open slash prompt. Returns the query AFTER the `/` (possibly empty, e.g.
 * just typed `/`). A trailing space closes it.
 *
 * START-ANCHORED, unlike `activeMentionQuery`: a slash action is a whole-prompt
 * prefix, so a `/` after prose (a path, a URL, "and/or") is an ordinary
 * character and must NOT open the picker.
 */
export function activeSlashQuery(text: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(text);
  return m ? (m[1] ?? "") : null;
}

/** Actions to offer for the active query (substring match on the id,
 *  case-insensitive), capped for a tidy list. Empty query → all actions. Pure. */
export function suggestSlash(
  query: string,
  actions: readonly SlashAction[],
  limit = 8,
): SlashAction[] {
  const q = query.trim().toLowerCase();
  const matches = q.length === 0 ? actions : actions.filter((a) => a.id.toLowerCase().includes(q));
  return matches.slice(0, limit);
}

/**
 * Expand `action` into `text`: replace ONLY the leading `/<query>` with the
 * action's template, keeping anything the author already typed after it.
 * Returns `text` BYTE-IDENTICAL when it isn't a slash prompt. Pure.
 */
export function expandSlash(text: string, action: SlashAction): string {
  const m = LEADING_SLASH_TOKEN_RE.exec(text);
  if (!m) return text;
  return `${action.template}${text.slice(m[0].length)}`;
}
