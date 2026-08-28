/**
 * Agent pane — pure multi-session store.
 *
 * DISPLAY + LOCAL-STATE ONLY. Manages switchable multi-session conversations
 * in the agent pane. Each session holds a bounded list of messages (user
 * prompts + assistant responses). Sessions are persisted to localStorage,
 * keyed per project/room.
 *
 * This module REPLACES the display role of the per-project `agent-thread.ts`
 * (run history) with full multi-session conversations. It is pure (no React),
 * side-effect-free, and tested in the node env.
 *
 * Conventions mirror agent-thread.ts exactly:
 * - Every localStorage access is wrapped in try/catch, failing safe to a
 *   valid empty state.
 * - `normalize()` drops malformed entries and re-caps string fields.
 * - Monotonic id counters: `s-` prefix for sessions, `m-` for messages.
 * - `resolveStorage()` falls back to globalThis.localStorage.
 */

import { loadThread } from "./agent-thread.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who sent a message. */
export type MessageRole = "user" | "assistant";

/** How an assistant run ended (mirrors ThreadStatus from agent-thread). */
export type RunStatus = "finished" | "stopped" | "error";

/** One message in a session's conversation. */
export interface SessionMessage {
  /** Stable per-message id (React key). */
  id: string;
  /** Who produced this message. */
  role: MessageRole;
  /** The message text (trimmed, capped to MAX_TEXT_LEN). */
  text: string;
  /** For assistant messages: how the run ended. */
  status?: RunStatus;
  /** For assistant messages: the run's AgentRunOutcome. */
  outcome?: string;
  /** How many agent steps were taken (assistant only). */
  stepCount?: number;
  /**
   * The agent run's id (ADR-0025 §4): a grouping/correlation hint carried from
   * the run's `run_started`/`run_finished` events onto the completed assistant
   * message. NEVER authoritative — it correlates the message with an in-app audit
   * entry / Undo, nothing more. Absent on user messages and legacy messages.
   */
  runId?: string;
  /** Unix-ms timestamp. */
  at: number;
}

/** One conversation session. */
export interface AgentSession {
  /** Stable per-session id (React key + select target). */
  id: string;
  /** Human-readable title (derived from first user msg or renamed). */
  title: string;
  /** Optional model preference for this session. */
  modelId?: string;
  /** Messages in chronological order (oldest first). */
  messages: SessionMessage[];
  /** Unix-ms timestamp of session creation. */
  createdAt: number;
  /** Unix-ms timestamp of last message appended (drives sort order). */
  updatedAt: number;
}

/** Top-level persisted state: ordered list of sessions + active selection. */
export interface SessionsState {
  /** Sessions sorted most-recent-first (by updatedAt). */
  sessions: AgentSession[];
  /** The id of the currently selected session. */
  activeId: string;
}

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key prefix; the project/room id is appended for isolation. */
export const SESSIONS_KEY_PREFIX = "galley.agentSessions.";

/** The id used when no project/room id is supplied. */
export const DEFAULT_SESSIONS_ID = "default";

/** Maximum number of sessions retained per project. */
export const MAX_SESSIONS = 30;

/** Maximum number of messages retained per session. */
export const MAX_MESSAGES = 100;

/** Maximum length of a message text field. */
export const MAX_TEXT_LEN = 4000;

/** Maximum length of a session title. */
export const MAX_TITLE_LEN = 60;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let sessionSeq = 0;
function newSessionId(): string {
  sessionSeq += 1;
  return `s-${Date.now().toString(36)}-${sessionSeq.toString(36)}`;
}

let messageSeq = 0;
function newMessageId(): string {
  messageSeq += 1;
  return `m-${Date.now().toString(36)}-${messageSeq.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function capStr(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Derive a session title from a text string.
 * Takes the first line, trims, caps to MAX_TITLE_LEN. Falls back to "New chat".
 */
export function deriveTitle(text: string): string {
  const firstLine = ((text ?? "").split("\n")[0] ?? "").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > MAX_TITLE_LEN ? firstLine.slice(0, MAX_TITLE_LEN) : firstLine;
}

/**
 * Build a new message from input. Text is trimmed and capped.
 */
export function makeMessage(input: {
  role: MessageRole;
  text: string;
  status?: RunStatus;
  outcome?: string;
  stepCount?: number;
  runId?: string;
  at: number;
}): SessionMessage {
  return {
    id: newMessageId(),
    role: input.role,
    text: capStr(input.text ?? "", MAX_TEXT_LEN),
    at: input.at,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.stepCount !== undefined ? { stepCount: input.stepCount } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  };
}

/**
 * Build a new empty session.
 */
export function makeSession(at: number): AgentSession {
  return {
    id: newSessionId(),
    title: "New chat",
    messages: [],
    createdAt: at,
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------
// State mutation helpers (pure — return new state, never mutate)
// ---------------------------------------------------------------------------

/**
 * Append a message to a session. If the session's title is still "New chat"
 * and this is the first user message, derive the title from it. Bumps
 * updatedAt. Re-sorts sessions most-recent-first. Caps messages to MAX_MESSAGES
 * (drops oldest).
 */
export function appendMessage(
  state: SessionsState,
  sessionId: string,
  msg: SessionMessage,
): SessionsState {
  const sessions = state.sessions.map((sess) => {
    if (sess.id !== sessionId) return sess;

    const messages = [...sess.messages, msg];
    const capped =
      messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;

    // Derive title from first user message if still default
    let title = sess.title;
    if (title === "New chat" && msg.role === "user") {
      const derived = deriveTitle(msg.text);
      if (derived !== "New chat") title = derived;
    }

    return { ...sess, messages: capped, title, updatedAt: msg.at };
  });

  // Re-sort most-recent-first
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return { ...state, sessions: sorted };
}

/**
 * Prepend a fresh session, make it active, cap to MAX_SESSIONS.
 */
export function createSession(state: SessionsState, at: number): SessionsState {
  const fresh = makeSession(at);
  const sessions = [fresh, ...state.sessions];
  const capped =
    sessions.length > MAX_SESSIONS ? sessions.slice(0, MAX_SESSIONS) : sessions;
  return { sessions: capped, activeId: fresh.id };
}

/**
 * Rename a session's title.
 */
export function renameSession(state: SessionsState, id: string, title: string): SessionsState {
  const capped = capStr(title, MAX_TITLE_LEN);
  return {
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id ? { ...s, title: capped } : s,
    ),
  };
}

/**
 * Remove a session. If none remain, seed one fresh. Keeps a valid activeId.
 */
export function deleteSession(state: SessionsState, id: string, at: number): SessionsState {
  const remaining = state.sessions.filter((s) => s.id !== id);

  if (remaining.length === 0) {
    // Seed a fresh session so the store is never empty
    const fresh = makeSession(at);
    return { sessions: [fresh], activeId: fresh.id };
  }

  // Keep activeId if it still exists, otherwise pick the first remaining
  const firstRemaining = remaining[0];
  if (!firstRemaining) {
    // Shouldn't happen given the length > 0 check above, but TypeScript + noUncheckedIndexedAccess
    const fresh = makeSession(at);
    return { sessions: [fresh], activeId: fresh.id };
  }
  const activeId = remaining.find((s) => s.id === state.activeId)
    ? state.activeId
    : firstRemaining.id;

  return { sessions: remaining, activeId };
}

/**
 * Select (activate) a session by id.
 */
export function selectSession(state: SessionsState, id: string): SessionsState {
  return { ...state, activeId: id };
}

/**
 * Set a model preference on a session.
 */
export function setSessionModel(
  state: SessionsState,
  id: string,
  modelId: string,
): SessionsState {
  return {
    ...state,
    sessions: state.sessions.map((s) =>
      s.id === id ? { ...s, modelId } : s,
    ),
  };
}

// ---------------------------------------------------------------------------
// Serialization / validation
// ---------------------------------------------------------------------------

function isRunStatus(v: unknown): v is RunStatus {
  return v === "finished" || v === "stopped" || v === "error";
}

function isMessageRole(v: unknown): v is MessageRole {
  return v === "user" || v === "assistant";
}

function isMessage(v: unknown): v is SessionMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    isMessageRole(m.role) &&
    typeof m.text === "string" &&
    typeof m.at === "number" &&
    (m.status === undefined || isRunStatus(m.status)) &&
    (m.outcome === undefined || typeof m.outcome === "string") &&
    (m.stepCount === undefined || typeof m.stepCount === "number") &&
    (m.runId === undefined || typeof m.runId === "string")
  );
}

function isSession(v: unknown): v is AgentSession {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    Array.isArray(s.messages) &&
    typeof s.createdAt === "number" &&
    typeof s.updatedAt === "number" &&
    (s.modelId === undefined || typeof s.modelId === "string")
  );
}

function normalizeMessage(m: SessionMessage): SessionMessage {
  return {
    id: m.id,
    role: m.role,
    text: capStr(m.text, MAX_TEXT_LEN),
    at: m.at,
    ...(m.status !== undefined ? { status: m.status } : {}),
    ...(m.outcome !== undefined ? { outcome: capStr(m.outcome, MAX_TEXT_LEN) } : {}),
    ...(m.stepCount !== undefined ? { stepCount: m.stepCount } : {}),
    ...(m.runId !== undefined ? { runId: capStr(m.runId, MAX_TEXT_LEN) } : {}),
  };
}

function normalizeSession(s: AgentSession): AgentSession {
  const messages = s.messages
    .filter(isMessage)
    .map(normalizeMessage)
    .slice(-MAX_MESSAGES); // keep most recent if over cap

  return {
    id: s.id,
    title: capStr(s.title || "New chat", MAX_TITLE_LEN) || "New chat",
    messages,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ...(s.modelId !== undefined ? { modelId: s.modelId } : {}),
  };
}

function normalize(parsed: unknown): SessionsState | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.sessions) || typeof p.activeId !== "string") return null;

  const sessions = (p.sessions as unknown[])
    .filter(isSession)
    .map(normalizeSession)
    .slice(0, MAX_SESSIONS);

  if (sessions.length === 0) return null;

  // Ensure activeId is valid
  const firstSession = sessions[0];
  if (!firstSession) return null; // defensive (length > 0 checked above)
  const activeId = sessions.find((s) => s.id === p.activeId)
    ? (p.activeId as string)
    : firstSession.id;

  return { sessions, activeId };
}

function resolveStorage(
  storage: SessionStorage | null | undefined,
): SessionStorage | null {
  if (storage === undefined) {
    return (globalThis as { localStorage?: SessionStorage }).localStorage ?? null;
  }
  return storage;
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

/**
 * The localStorage key for a project/room's sessions.
 */
export function sessionsKey(id?: string | null): string {
  const safe = id && id.trim() ? id.trim() : DEFAULT_SESSIONS_ID;
  return `${SESSIONS_KEY_PREFIX}${safe}`;
}

// ---------------------------------------------------------------------------
// Migration from legacy agent-thread
// ---------------------------------------------------------------------------

function migrateFromThread(
  storage: SessionStorage,
  id: string | null | undefined,
  at: number,
): SessionsState | null {
  try {
    const legacy = loadThread(storage, id);
    if (!legacy.length) return null;

    const firstEntry = legacy[0];
    const session = makeSession(firstEntry?.at ?? at);
    const messages: SessionMessage[] = legacy.flatMap((entry) => [
      makeMessage({ role: "user", text: entry.request, at: entry.at }),
      makeMessage({
        role: "assistant",
        text: entry.summary,
        status: entry.status as RunStatus,
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
        at: entry.at,
      }),
    ]);

    // Derive title from first user message
    const firstUser = messages.find((m) => m.role === "user");
    const title = firstUser ? deriveTitle(firstUser.text) : "New chat";

    const capped = messages.slice(-MAX_MESSAGES);
    const lastMsg = capped[capped.length - 1];
    const updatedAt = lastMsg !== undefined ? lastMsg.at : at;

    return {
      sessions: [{ ...session, title, messages: capped, updatedAt }],
      activeId: session.id,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load a project/room's sessions. Fail-safe: always returns a valid
 * SessionsState with ≥1 session and an activeId that exists in sessions.
 *
 * Migration: if no sessions key exists but a legacy `galley.agentThread.<id>`
 * is found, converts it to a single session.
 */
export function loadSessions(
  storage: SessionStorage | null | undefined,
  id?: string | null,
): SessionsState {
  const s = resolveStorage(storage);
  const fallback = (): SessionsState => {
    const fresh = makeSession(Date.now());
    return { sessions: [fresh], activeId: fresh.id };
  };

  if (!s) return fallback();

  try {
    const raw = s.getItem(sessionsKey(id));

    if (!raw) {
      // Attempt migration from legacy thread
      const migrated = migrateFromThread(s, id, Date.now());
      return migrated ?? fallback();
    }

    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalize(parsed);
    return normalized ?? fallback();
  } catch {
    return fallback();
  }
}

/**
 * Persist a project/room's sessions (best-effort). Failures are swallowed.
 */
export function saveSessions(
  storage: SessionStorage | null | undefined,
  id: string | null | undefined,
  state: SessionsState,
): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    if (state.sessions.length === 0) {
      s.removeItem(sessionsKey(id));
      return;
    }
    // Re-cap on the way out
    const bounded: SessionsState = {
      ...state,
      sessions: state.sessions.slice(0, MAX_SESSIONS),
    };
    s.setItem(sessionsKey(id), JSON.stringify(bounded));
  } catch {
    /* persistence is best-effort */
  }
}
