/**
 * Command registry (#19.1, Rail & Islands stage 1) — the single source of
 * action truth behind the ⌘K palette.
 *
 * A plain, dependency-free TS module: a registry (register / list / lookup /
 * gated run), a hand-rolled fuzzy matcher (subsequence + simple scoring — NO
 * fuzzy-search dep), and the pure helpers the palette composes (filter, group,
 * and the "Open <path>" file-entry builder). Everything here is PURE so it
 * unit-tests in the node gate without a DOM; the React surface lives in
 * `components/CommandPalette.tsx`.
 *
 * Conduct rule (spec): a command whose `available()` returns false is neither
 * listed nor runnable — the registry enforces it, not just the UI.
 */

/** A single palette-invokable action. */
export interface Command {
  /** Stable identifier (also the React key). */
  id: string;
  /** Human title shown in the palette, e.g. "Toggle dark mode". */
  title: string;
  /** Extra match terms beyond the title (e.g. ["theme", "appearance"]). */
  keywords?: readonly string[];
  /** Optional chord spec (`use-shortcuts` syntax, e.g. "Mod-e") shown as a hint. */
  shortcut?: string;
  /** Grouping bucket for the results list (e.g. "File", "View", "Files"). */
  group: string;
  /** Invoke the action. Only ever calls EXISTING handlers — never auto-applies. */
  run: () => void;
  /** Live availability gate; omitted means always available. */
  available?: () => boolean;
}

/** True when the command may be listed/run right now. */
export function isAvailable(command: Command): boolean {
  return command.available ? command.available() !== false : true;
}

export interface CommandRegistry {
  /** Add a command. Re-registering an id replaces it IN PLACE (stable order). */
  register(command: Command): void;
  /** Lookup by id (registered, regardless of availability). */
  get(id: string): Command | undefined;
  /** Available commands, in registration order (availability re-evaluated live). */
  list(): Command[];
  /** Every registered command, in registration order, ignoring availability. */
  listAll(): Command[];
  /**
   * Run a command by id THROUGH the availability gate: returns true and runs it
   * only when it exists and `available()` doesn't veto; false otherwise.
   */
  run(id: string): boolean;
}

/** Create a registry, optionally seeded with `initial` commands in order. */
export function createCommandRegistry(initial?: readonly Command[]): CommandRegistry {
  // A Map preserves insertion order; `set` on an existing key keeps the
  // original position — exactly the replace-in-place semantics we document.
  const commands = new Map<string, Command>();
  for (const c of initial ?? []) commands.set(c.id, c);

  return {
    register(command: Command): void {
      commands.set(command.id, command);
    },
    get(id: string): Command | undefined {
      return commands.get(id);
    },
    list(): Command[] {
      return [...commands.values()].filter(isAvailable);
    },
    listAll(): Command[] {
      return [...commands.values()];
    },
    run(id: string): boolean {
      const command = commands.get(id);
      if (!command || !isAvailable(command)) return false;
      command.run();
      return true;
    },
  };
}

// --- Fuzzy matching (hand-rolled; subsequence + simple scoring) ---

/** Characters that start a "word" for the bonus (incl. path segments). */
const WORD_BREAK = /[\s/\-_.(:]/;

/**
 * PURE: score `query` against `text` as a case-insensitive subsequence.
 * Returns null when `query` is NOT a subsequence of `text`; otherwise a score
 * where higher is better: +1 per matched char, +2 when a match directly
 * follows the previous one (consecutive run), +3 when it sits at a word start
 * (start of text or after whitespace / `/` / `-` / `_` / `.`). Greedy
 * first-occurrence scan — tiny and predictable, good enough for a palette.
 * An empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let from = 0;
  let prev = -2; // never adjacent to the first find
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 2;
    if (at === 0 || WORD_BREAK.test(t[at - 1]!)) score += 3;
    prev = at;
    from = at + 1;
  }
  return score;
}

/**
 * PURE: a command's best fuzzy score for `query` across its title and
 * keywords (equal weight), or null when nothing matches.
 */
export function commandScore(query: string, command: Command): number | null {
  let best = fuzzyScore(query, command.title);
  for (const k of command.keywords ?? []) {
    const s = fuzzyScore(query, k);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/**
 * PURE: the commands matching `query`, best score first; ties keep the input
 * order (stable). A blank query returns every command unchanged.
 */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  if (query.trim() === "") return [...commands];
  return commands
    .map((command, index) => ({ command, index, score: commandScore(query, command) }))
    .filter((x): x is { command: Command; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.command);
}

/**
 * PURE: bucket commands by `group`, preserving the first-seen order of groups
 * and the given order of items within each (same shape as the CommandSheet's
 * grouping, over commands).
 */
export function groupCommands(
  commands: readonly Command[],
): Array<{ group: string; items: Command[] }> {
  const order: string[] = [];
  const buckets = new Map<string, Command[]>();
  for (const command of commands) {
    let bucket = buckets.get(command.group);
    if (!bucket) {
      bucket = [];
      buckets.set(command.group, bucket);
      order.push(command.group);
    }
    bucket.push(command);
  }
  return order.map((group) => ({ group, items: buckets.get(group) ?? [] }));
}

// --- File-open entries ---

/** The minimal file shape the builder needs (matches the project snapshot's). */
export interface OpenableFile {
  fileId: string;
  path: string;
}

/**
 * PURE: one "Open <path>" command per project file, under the "Files" group.
 * Running an entry hands the file id to `openFile` (the palette's only file
 * action — it switches the active editor file via the host's callback; it
 * never touches file content).
 */
export function fileOpenCommands(
  files: readonly OpenableFile[],
  openFile: (fileId: string) => void,
): Command[] {
  return files.map((f) => ({
    id: `open-file:${f.fileId}`,
    title: `Open ${f.path}`,
    keywords: [f.path],
    group: "Files",
    run: () => openFile(f.fileId),
  }));
}
