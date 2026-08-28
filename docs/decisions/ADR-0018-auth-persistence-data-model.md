# ADR-0018 — Auth, persistence & git-backed versioning: the data model

- **Status:** Accepted (architecture); built core-first in slices. Opens roadmap **#4**.
- **Relates to:** ADR-0006/0007 (Yjs CRDT core), ADR-0012 (cross-peer attribution),
  ADR-0013 (`CollabProject`), ADR-0008 (sync server), ADR-0017 (self-host).
- **Review:** the data-model fork was decided via an **Architect (GPT)** tradeoff
  consult (2026-06-07), optimized for future-proofing; the **OIDC auth flow** is a
  gating **Security-Analyst (GPT)** review before that slice is built.

## Context

Roadmap #4 adds accounts, saved projects, history-for-free, and a clean self-host
story. The central fork: **what is the source of truth** — files-in-git, a database,
or the CRDT? Galley already has a Yjs CRDT as the live merge/attribution substrate
(ADRs 0006–0013). Splitting truth across two stores (CRDT live + DB/git primary)
would mean reconciling two merge models forever.

## Decision

**The Yjs CRDT document is the single source of truth. Git is a one-way,
human-readable projection of it; persistence and auth live behind seams; cores
stay auth-agnostic.**

### 1. CRDT is truth; Git is a one-way projection

The CRDT is the only live-merge layer. At **version boundaries** a project is
*materialized* to a git working tree — `.typ` (and other) files + a
`.galley/project.json` manifest (structure: main + path↔fileId) — committed into a
bare repo. Git is **never** read back as a merge input; restore/import is an
**explicit CRDT transaction** (mint items under a peer's clientID, like the
agent-as-peer Accept). Benefits: one history/attribution substrate, and "data
outlives the app" — a project is a plain git repo any tool can read.

The pure projection core is `materializeProject(snapshot)` in `@galley/collab`
(slice 1): deterministic (no clocks), offline, IO-free, fails closed on a duplicate
live path (never clobbers). The bare-git commit is an adapter (a later slice).

### 2. Persistence behind seams

`ProjectStore` (project CRUD + membership), `CrdtStore` (the Yjs update log +
compacted snapshots), `VersionStore` (named versions → git commits). Default
adapters: **SQLite + a filesystem bare-git repo** for zero-infra self-host; a
**Postgres** adapter is a later drop-in. CRDT update-logs **compact to snapshots**
(`encodeStateAsUpdate`) so the log doesn't grow unbounded. The seam interfaces are
pure; adapters are Node/server-only and stay out of the framework-free cores.

### 3. Auth behind a seam; no-auth local mode preserved

A **no-auth single-user local mode stays the default** (the MVP/self-host story is
untouched). For networked deploys, **OIDC (Authorization Code + PKCE)** sits behind
an `AuthProvider` seam; the browser holds **HttpOnly, Secure, SameSite cookies**,
never long-lived JWTs; no bespoke password crypto. The IdP is mocked in tests
(deterministic, offline). Gating Security-Analyst review before this lands.

### 4. Authz at the service edges

An `Authorizer` seam gates the service edges; the cores stay auth-agnostic. The
must-fix: **close the currently-open `apps/sync` rooms** — derive the room from a
`projectId` and check membership at the WebSocket upgrade (the ADR-0017 / Security-
Analyst finding). The proxy/compile edges gate the same way.

### 5. Identity ↔ attribution

Keep `clientID → Author` (ADR-0012), but `Author` now points to a durable
**`userId`** (a local-profile id in no-auth mode, an OIDC subject when authed). The
agent stays a **distinct** peer (one Y.Doc peer per identity — the locked invariant).

## Consequences

- One merge substrate; git/DB are derived, swappable, and never authoritative.
- Restore = a CRDT transaction, so history/attribution stay coherent across restore.
- Auth/persistence are additive seams; the no-auth local + self-host paths are
  unchanged until a deploy opts into OIDC + a real store.
- Each piece lands as its own offline-green-gateable slice (mocked IdP, in-memory
  stores, then SQLite/FS/git adapters).

## Slices

1. **`materializeProject`** ✅ — the pure CRDT → git projection core (this ADR §1).
2. Persistence **seams** + the CRDT **snapshot/compaction/restore** core (in-memory).
3. **SQLite + filesystem bare-git** adapters (`CrdtStore`/`ProjectStore`/`VersionStore`).
4. **`AuthProvider`** seam + **OIDC** (Auth Code + PKCE, mocked IdP) + HttpOnly cookies — Security-Analyst gated.
5. **`Authorizer`** seam closing the sync rooms (projectId + membership at upgrade).
6. Identity↔attribution `userId` wiring.
