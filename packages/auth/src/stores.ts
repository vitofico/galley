/**
 * In-memory reference stores for auth (roadmap #4, ADR-0018 §3). Validate the
 * seams + drive tests; durable adapters (filesystem/SQLite) land later behind the
 * same `@galley/shared` interfaces. Session/state ids are high-entropy by default
 * (unguessable); injectable for deterministic tests.
 */
import type {
  OidcLoginState,
  OidcLoginStateStore,
  SessionRecord,
  SessionStore,
} from "@galley/shared";
import { randomToken } from "./oidc-core.js";

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  constructor(private readonly newId: () => string = () => randomToken()) {}

  async create(record: SessionRecord): Promise<{ id: string; record: SessionRecord }> {
    // Always a fresh id (no fixation): callers mint a new session per login.
    const id = this.newId();
    this.sessions.set(id, record);
    return { id, record };
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async getValid(id: string, nowMs: number): Promise<SessionRecord | null> {
    const rec = this.sessions.get(id);
    if (!rec) return null;
    if (rec.expiresAtMs <= nowMs) {
      this.sessions.delete(id); // reap on access
      return null;
    }
    return rec;
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteExpired(nowMs: number): Promise<void> {
    for (const [id, rec] of this.sessions) {
      if (rec.expiresAtMs <= nowMs) this.sessions.delete(id);
    }
  }
}

export class InMemoryOidcLoginStateStore implements OidcLoginStateStore {
  private readonly states = new Map<string, OidcLoginState>();

  async put(state: OidcLoginState): Promise<void> {
    this.states.set(state.state, state);
  }

  /** One-time: ALWAYS deletes (so a `state` — even an expired one — can't be replayed). */
  async consume(state: string, nowMs: number): Promise<OidcLoginState | null> {
    const found = this.states.get(state) ?? null;
    this.states.delete(state);
    if (!found || found.expiresAtMs <= nowMs) return null;
    return found;
  }
}
