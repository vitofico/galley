/**
 * Pure-core tests for the multi-session store (agent-sessions.ts).
 *
 * Runs in the `node` env (no jsdom) — the module is side-effect-free.
 * Mirrors agent-thread.test.ts conventions.
 */

import { describe, it, expect } from "vitest";
import { saveThread } from "./agent-thread.js";
import {
  loadSessions,
  saveSessions,
  appendMessage,
  createSession,
  deleteSession,
  renameSession,
  selectSession,
  setSessionModel,
  deriveTitle,
  makeSession,
  makeMessage,
  sessionsKey,
  MAX_MESSAGES,
  MAX_SESSIONS,
  MAX_TITLE_LEN,
  SESSIONS_KEY_PREFIX,
  DEFAULT_SESSIONS_ID,
  type SessionsState,
  type SessionStorage,
} from "./agent-sessions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mem = (seed: Record<string, string> = {}): SessionStorage => {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

// ---------------------------------------------------------------------------
// sessionsKey
// ---------------------------------------------------------------------------

describe("sessionsKey — per-project namespacing", () => {
  it("namespaces under the galley.* convention by id", () => {
    expect(sessionsKey("proj-1")).toBe(`${SESSIONS_KEY_PREFIX}proj-1`);
    expect(sessionsKey("a")).not.toBe(sessionsKey("b"));
  });

  it("falls back to DEFAULT_SESSIONS_ID when none is given", () => {
    expect(sessionsKey()).toBe(`${SESSIONS_KEY_PREFIX}${DEFAULT_SESSIONS_ID}`);
    expect(sessionsKey(null)).toBe(sessionsKey(undefined));
  });
});

// ---------------------------------------------------------------------------
// deriveTitle — from the brief verbatim
// ---------------------------------------------------------------------------

it("deriveTitle takes the first line, caps, falls back", () => {
  expect(deriveTitle("Fix the intro\nand more")).toBe("Fix the intro");
  expect(deriveTitle("   ")).toBe("New chat");
  // cap at MAX_TITLE_LEN
  const long = "a".repeat(MAX_TITLE_LEN + 10);
  expect(deriveTitle(long).length).toBe(MAX_TITLE_LEN);
  // empty string
  expect(deriveTitle("")).toBe("New chat");
  // only newlines
  expect(deriveTitle("\n\n")).toBe("New chat");
});

// ---------------------------------------------------------------------------
// makeMessage / makeSession
// ---------------------------------------------------------------------------

describe("makeMessage — shape + caps", () => {
  it("sets required fields", () => {
    const m = makeMessage({ role: "user", text: "hello", at: 100 });
    expect(m.id).toMatch(/^m-/);
    expect(m.role).toBe("user");
    expect(m.text).toBe("hello");
    expect(m.at).toBe(100);
    expect(m.status).toBeUndefined();
  });

  it("carries optional fields through", () => {
    const m = makeMessage({ role: "assistant", text: "done", status: "finished", outcome: "applied", stepCount: 3, at: 200 });
    expect(m.status).toBe("finished");
    expect(m.outcome).toBe("applied");
    expect(m.stepCount).toBe(3);
  });
});

describe("makeSession — initial shape", () => {
  it("creates a session with 'New chat' title and empty messages", () => {
    const s = makeSession(1000);
    expect(s.id).toMatch(/^s-/);
    expect(s.title).toBe("New chat");
    expect(s.messages).toEqual([]);
    expect(s.createdAt).toBe(1000);
    expect(s.updatedAt).toBe(1000);
  });

  it("generates unique ids", () => {
    const a = makeSession(1);
    const b = makeSession(2);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// appendMessage — from the brief verbatim + extras
// ---------------------------------------------------------------------------

it("appendMessage derives the title from the first user message", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  s = appendMessage(s, id, makeMessage({ role: "user", text: "Tighten the abstract", at: 2 }));
  expect(s.sessions[0]!.title).toBe("Tighten the abstract");
});

it("appendMessage does NOT override a user-set title", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  s = renameSession(s, id, "My custom title");
  s = appendMessage(s, id, makeMessage({ role: "user", text: "Tighten the abstract", at: 2 }));
  // title was renamed before first user msg; rename changes it away from default so should stay
  expect(s.sessions[0]!.title).toBe("My custom title");
});

it("appendMessage caps message count", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  for (let i = 0; i < MAX_MESSAGES + 5; i++) {
    s = appendMessage(s, id, makeMessage({ role: "user", text: `m${i}`, at: i }));
  }
  expect(s.sessions[0]!.messages.length).toBe(MAX_MESSAGES);
});

it("appendMessage bumps updatedAt", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  const before = s.sessions[0]!.updatedAt;
  s = appendMessage(s, id, makeMessage({ role: "user", text: "hi", at: 999 }));
  expect(s.sessions[0]!.updatedAt).toBe(999);
  expect(s.sessions[0]!.updatedAt).toBeGreaterThanOrEqual(before);
});

it("appendMessage re-sorts sessions most-recent-first", () => {
  // Create two sessions; append to the second one → it should move to front
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id1 = s.activeId;
  s = createSession(s, 2);
  // first session's updatedAt is 1, second is 2; second already at front
  // Now append to id1 with a later timestamp → id1 should move to front
  s = appendMessage(s, id1, makeMessage({ role: "user", text: "ping", at: 100 }));
  expect(s.sessions[0]!.id).toBe(id1);
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("prepends a fresh session and makes it active", () => {
    let s = createSession({ sessions: [], activeId: "" }, 1);
    const id1 = s.activeId;
    s = createSession(s, 2);
    expect(s.sessions[0]!.id).toBe(s.activeId);
    expect(s.sessions[0]!.id).not.toBe(id1);
  });

  it("caps to MAX_SESSIONS", () => {
    let s: SessionsState = { sessions: [], activeId: "" };
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      s = createSession(s, i);
    }
    expect(s.sessions.length).toBe(MAX_SESSIONS);
  });
});

// ---------------------------------------------------------------------------
// deleteSession — from the brief verbatim
// ---------------------------------------------------------------------------

it("deleteSession seeds a fresh one when the last is removed", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  s = deleteSession(s, s.activeId, 2);
  expect(s.sessions.length).toBe(1);
  expect(s.activeId).toBe(s.sessions[0]!.id);
});

it("deleteSession removes the session and keeps a valid activeId", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  s = createSession(s, 2);
  const id2 = s.activeId; // active is newest
  s = deleteSession(s, id2, 3);
  expect(s.sessions.find((x) => x.id === id2)).toBeUndefined();
  expect(s.sessions.map((x) => x.id)).toContain(s.activeId);
});

it("deleteSession on a non-active session leaves activeId unchanged if still valid", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id1 = s.activeId;
  s = createSession(s, 2);
  const id2 = s.activeId; // active is newest (id2)
  s = deleteSession(s, id1, 3);
  expect(s.activeId).toBe(id2);
});

// ---------------------------------------------------------------------------
// renameSession
// ---------------------------------------------------------------------------

it("renameSession updates only the target session title", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  s = createSession(s, 2);
  s = renameSession(s, id, "A custom name");
  const target = s.sessions.find((x) => x.id === id)!;
  expect(target.title).toBe("A custom name");
  // other session unaffected
  const other = s.sessions.find((x) => x.id !== id)!;
  expect(other.title).toBe("New chat");
});

// ---------------------------------------------------------------------------
// selectSession
// ---------------------------------------------------------------------------

it("selectSession makes the given id the activeId", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id1 = s.activeId;
  s = createSession(s, 2);
  s = selectSession(s, id1);
  expect(s.activeId).toBe(id1);
});

// ---------------------------------------------------------------------------
// setSessionModel
// ---------------------------------------------------------------------------

it("setSessionModel stores the model on the session", () => {
  let s = createSession({ sessions: [], activeId: "" }, 1);
  const id = s.activeId;
  s = setSessionModel(s, id, "claude-opus-4-5");
  expect(s.sessions.find((x) => x.id === id)!.modelId).toBe("claude-opus-4-5");
});

// ---------------------------------------------------------------------------
// saveSessions / loadSessions round-trip — from the brief verbatim
// ---------------------------------------------------------------------------

it("round-trips through storage", () => {
  const store = mem();
  let s = createSession({ sessions: [], activeId: "" }, 1);
  s = appendMessage(s, s.activeId, makeMessage({ role: "user", text: "hi", at: 2 }));
  saveSessions(store, "proj1", s);
  const back = loadSessions(store, "proj1");
  expect(back.sessions[0]!.messages[0]!.text).toBe("hi");
});

// ---------------------------------------------------------------------------
// Fail-safe paths — from the brief verbatim
// ---------------------------------------------------------------------------

it("fails safe to one empty session on corrupt storage", () => {
  const s = loadSessions(mem({ [sessionsKey("p")]: "{not json" }), "p");
  expect(s.sessions.length).toBe(1);
  expect(s.sessions[0]!.messages).toEqual([]);
});

it("fails safe to one empty session on throwing storage", () => {
  const throwing: SessionStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => {},
    removeItem: () => {},
  };
  const s = loadSessions(throwing, "p");
  expect(s.sessions.length).toBe(1);
  expect(s.activeId).toBe(s.sessions[0]!.id);
});

it("fails safe on null storage (globalThis.localStorage absent)", () => {
  const s = loadSessions(null, "p");
  expect(s.sessions.length).toBe(1);
  expect(s.activeId).toBe(s.sessions[0]!.id);
});

it("loadSessions always returns activeId that exists in sessions", () => {
  // Tamper with storage to have an activeId that doesn't match
  const store = mem();
  const s = createSession({ sessions: [], activeId: "" }, 1);
  saveSessions(store, "p", s);
  // Manually corrupt: write a state with a bad activeId
  const raw = JSON.parse(store.getItem(sessionsKey("p"))!) as Record<string, unknown>;
  raw["activeId"] = "nonexistent";
  store.setItem(sessionsKey("p"), JSON.stringify(raw));
  const back = loadSessions(store, "p");
  expect(back.sessions.map((x) => x.id)).toContain(back.activeId);
});

// ---------------------------------------------------------------------------
// Migration — from the brief verbatim
// ---------------------------------------------------------------------------

it("migrates a legacy thread into one session", () => {
  const store = mem();
  saveThread(store, "p", [
    { id: "t1", request: "Add intro", status: "finished", outcome: "applied", summary: "Proposed 1 edit(s)", at: 1 },
  ]);
  const s = loadSessions(store, "p");
  expect(s.sessions[0]!.messages[0]).toMatchObject({ role: "user", text: "Add intro" });
  expect(s.sessions[0]!.messages[1]).toMatchObject({ role: "assistant", status: "finished" });
});

it("migration: multiple legacy thread entries become interleaved messages", () => {
  const store = mem();
  saveThread(store, "p", [
    { id: "t1", request: "First ask", status: "finished", summary: "Done 1", at: 10 },
    { id: "t2", request: "Second ask", status: "stopped", summary: "Stopped", at: 20 },
  ]);
  const s = loadSessions(store, "p");
  const msgs = s.sessions[0]!.messages;
  expect(msgs).toHaveLength(4);
  expect(msgs[0]).toMatchObject({ role: "user", text: "First ask" });
  expect(msgs[1]).toMatchObject({ role: "assistant", status: "finished" });
  expect(msgs[2]).toMatchObject({ role: "user", text: "Second ask" });
  expect(msgs[3]).toMatchObject({ role: "assistant", status: "stopped" });
});

it("migration: empty legacy thread does not block normal empty-fallback", () => {
  const store = mem();
  // no thread, no sessions
  const s = loadSessions(store, "p");
  expect(s.sessions.length).toBe(1);
  expect(s.sessions[0]!.messages).toEqual([]);
});
