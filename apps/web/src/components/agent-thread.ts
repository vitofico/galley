/**
 * Deep agent pane — pure multi-turn THREAD history (roadmap #15, next slice).
 *
 * DISPLAY + LOCAL-STATE ONLY. This module is the persisted record of PAST agent
 * runs in the pane: each completed run contributes one small entry (the request,
 * a short outcome summary, a status, a timestamp). It is read/written from
 * localStorage, keyed per project/room, and never touches the run loop, the
 * Accept gate, the document, or version history. It invents NO new `AgentEvent`
 * fields — an entry is derived entirely from data the run already surfaced.
 *
 * Split out of AgentPanel.tsx (mirroring agent-trace.ts) so the entry shape, the
 * bounded append, and the guarded (de)serialization are pure functions with unit
 * tests — the repo's test layer is the `node` env (no jsdom). Every localStorage
 * access is wrapped in try/catch and fails safe to an EMPTY thread.
 */

/** How a run ended, for the history entry's status badge. */
export type ThreadStatus = "finished" | "stopped" | "error";

/** One past run in the pane's history. Small + bounded by construction. */
export interface ThreadEntry {
  /** Stable per-entry id (React key + clear-one target if ever needed). */
  id: string;
  /** The user's request prompt that started the run (trimmed + capped). */
  request: string;
  /** How the run ended. */
  status: ThreadStatus;
  /** The run's `AgentRunOutcome` when it finished (omitted for stop/error). */
  outcome?: string;
  /** A short human summary of the outcome (trimmed + capped). */
  summary: string;
  /** Unix-ms timestamp the entry was recorded. */
  at: number;
}

/** localStorage key PREFIX; the project/room id is appended for isolation. */
export const THREAD_KEY_PREFIX = "galley.agentThread.";

/** The id used when no project/room id is supplied (single-shell fallback). */
export const DEFAULT_THREAD_ID = "default";

/** Cap on retained entries — the oldest are dropped past this. */
export const MAX_ENTRIES = 50;

/** Cap on each stored string field (request/summary) — bounds the store. */
export const MAX_SUMMARY_LEN = 280;

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface ThreadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The localStorage key for a project/room's thread. Namespaced under the
 * `galley.*` convention; the id keeps two projects' histories isolated. Falls
 * back to a single default id when none is given (e.g. the single-file shell,
 * which has no room id to thread through props).
 */
export function threadKey(id?: string | null): string {
  const safe = id && id.trim() ? id.trim() : DEFAULT_THREAD_ID;
  return `${THREAD_KEY_PREFIX}${safe}`;
}

function cap(s: string, max = MAX_SUMMARY_LEN): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

let entrySeq = 0;
function newId(): string {
  // Display-only id; uniqueness is all that matters. A monotonic counter mixed
  // with time avoids collisions within a session without any crypto dependency.
  entrySeq += 1;
  return `t-${Date.now().toString(36)}-${entrySeq.toString(36)}`;
}

/**
 * Build a history entry from a finished run. Request + summary are trimmed and
 * length-capped so the persisted store can't grow unbounded per entry.
 */
export function makeEntry(input: {
  request: string;
  status: ThreadStatus;
  outcome?: string | undefined;
  summary?: string | undefined;
  at: number;
}): ThreadEntry {
  return {
    id: newId(),
    request: cap(input.request ?? ""),
    status: input.status,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    summary: cap(input.summary ?? ""),
    at: input.at,
  };
}

/**
 * Append an entry (newest LAST) and enforce the retention cap by dropping the
 * oldest. Pure — returns a new array, never mutates the input.
 */
export function appendEntry(thread: readonly ThreadEntry[], entry: ThreadEntry): ThreadEntry[] {
  const next = [...thread, entry];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

/**
 * The newest (last) entry's request, or null when there's no actionable prompt.
 * Newest is LAST (per `appendEntry`). Returns null for an empty thread or when
 * the newest entry's request is empty/whitespace — so the "Regenerate" control
 * has a target only when there's a real prompt to re-run. Pure; never mutates.
 */
export function lastRequest(thread: readonly ThreadEntry[]): string | null {
  const newest = thread[thread.length - 1];
  if (!newest) return null;
  const req = newest.request.trim();
  return req ? req : null;
}

/** Structural validation of a parsed value as a `ThreadEntry`. */
function isEntry(v: unknown): v is ThreadEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.request === "string" &&
    (e.status === "finished" || e.status === "stopped" || e.status === "error") &&
    typeof e.summary === "string" &&
    typeof e.at === "number" &&
    (e.outcome === undefined || typeof e.outcome === "string")
  );
}

/**
 * Normalize any parsed value into a bounded, valid thread: keep only well-formed
 * entries, re-cap their string fields (defends against a hand-edited store), and
 * enforce the retention cap. A non-array → empty.
 */
function normalize(parsed: unknown): ThreadEntry[] {
  if (!Array.isArray(parsed)) return [];
  const valid = parsed.filter(isEntry).map((e) => ({
    id: e.id,
    request: cap(e.request),
    status: e.status,
    ...(e.outcome ? { outcome: cap(e.outcome) } : {}),
    summary: cap(e.summary),
    at: e.at,
  }));
  return valid.length > MAX_ENTRIES ? valid.slice(valid.length - MAX_ENTRIES) : valid;
}

function resolveStorage(storage: ThreadStorage | null | undefined): ThreadStorage | null {
  if (storage === undefined) {
    return (globalThis as { localStorage?: ThreadStorage }).localStorage ?? null;
  }
  return storage;
}

/**
 * Load a project/room's thread. Fails SAFE to an empty thread on every error
 * path: storage unavailable, read throws (private mode / blocked), corrupt or
 * non-array JSON, or wrong-shape entries. Never throws.
 */
export function loadThread(storage: ThreadStorage | null | undefined, id?: string | null): ThreadEntry[] {
  const s = resolveStorage(storage);
  if (!s) return [];
  try {
    const raw = s.getItem(threadKey(id));
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Persist a project/room's thread (best-effort). An empty thread REMOVES the key
 * so no empty residue accumulates. Failures (quota / private mode / serialize)
 * are swallowed — persistence must never break the pane.
 */
export function saveThread(
  storage: ThreadStorage | null | undefined,
  id: string | null | undefined,
  thread: readonly ThreadEntry[],
): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (thread.length === 0) {
      s.removeItem(threadKey(id));
      return;
    }
    // Re-cap on the way out so a programmatic over-cap can never be persisted.
    const bounded = thread.length > MAX_ENTRIES ? thread.slice(thread.length - MAX_ENTRIES) : thread;
    s.setItem(threadKey(id), JSON.stringify(bounded));
  } catch {
    /* persistence is best-effort */
  }
}

/** Clear a project/room's thread (display-only — never touches the document). */
export function clearThread(storage: ThreadStorage | null | undefined, id?: string | null): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.removeItem(threadKey(id));
  } catch {
    /* best-effort */
  }
}
