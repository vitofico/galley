/**
 * useAgentSessions — thin React hook over the pure agent-sessions store.
 *
 * Loads sessions from localStorage on mount (and on projectId change), then
 * exposes mutators that compute next state via the pure helpers, flush to
 * localStorage, and call setState — all in a single synchronous step so React
 * and localStorage always agree.
 */

import { useEffect, useState } from "react";

import {
  type AgentSession,
  type SessionMessage,
  type SessionsState,
  appendMessage as pureAppendMessage,
  createSession,
  deleteSession,
  loadSessions,
  renameSession,
  saveSessions,
  selectSession,
  setSessionModel,
} from "./agent-sessions.js";

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseAgentSessionsResult {
  sessions: AgentSession[];
  active: AgentSession;
  activeId: string;
  select(id: string): void;
  create(): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  appendMessage(sessionId: string, msg: SessionMessage): void;
  setModel(id: string, modelId: string): void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSessions(projectId?: string): UseAgentSessionsResult {
  const [state, setState] = useState<SessionsState>(() =>
    loadSessions(undefined, projectId),
  );

  // Reload when the project/room changes — mirrors AgentPanel's thread reload effect.
  useEffect(() => {
    setState(loadSessions(undefined, projectId));
  }, [projectId]);

  // ---------------------------------------------------------------------------
  // Exposed mutators — each computes next state via a pure helper inside the
  // functional updater, persists THAT next state, and returns it, so React and
  // localStorage never diverge.
  // ---------------------------------------------------------------------------

  function select(id: string): void {
    setState((prev) => {
      const next = selectSession(prev, id);
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  function create(): void {
    setState((prev) => {
      const next = createSession(prev, Date.now());
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  function rename(id: string, title: string): void {
    setState((prev) => {
      const next = renameSession(prev, id, title);
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  function remove(id: string): void {
    setState((prev) => {
      const next = deleteSession(prev, id, Date.now());
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  function appendMessage(sessionId: string, msg: SessionMessage): void {
    setState((prev) => {
      const next = pureAppendMessage(prev, sessionId, msg);
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  function setModel(id: string, modelId: string): void {
    setState((prev) => {
      const next = setSessionModel(prev, id, modelId);
      saveSessions(undefined, projectId, next);
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const { sessions, activeId } = state;
  const active = sessions.find((s) => s.id === activeId) ?? sessions[0];

  // sessions is always ≥1 (loadSessions guarantees it), so sessions[0] is safe.
  // The cast tells TypeScript we're certain.
  return {
    sessions,
    active: active as AgentSession,
    activeId,
    select,
    create,
    rename,
    remove,
    appendMessage,
    setModel,
  };
}
