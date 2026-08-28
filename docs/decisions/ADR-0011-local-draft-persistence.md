# ADR-0011 — Collaboration Phase 2e: local draft persistence (IndexedDB)

- **Status:** **Accepted**
- **Date:** 2026-06-07
- **Builds on:** [ADR-0006](ADR-0006-collaboration-phase1.md) (`CollabDocument` +
  the seed-once invariant), [ADR-0009](ADR-0009-collab-editor-binding.md) /
  [ADR-0010](ADR-0010-collab-presence-connection.md) (the flag-gated session)

## Context

Collaboration is live end-to-end, but a `?collab=1` LOCAL draft lives only in
memory — a refresh loses it. The natural, low-risk next increment is to persist
the local draft so it survives reloads, using Yjs's standard `y-indexeddb`
provider. This must not regress the seed-once invariant or the default
single-user MVP path. (Design validated by the Architect expert; the
implementation was adversarially reviewed by the Code-Reviewer expert — three
findings, addressed below.)

## Decision

- **Scope: LOCAL mode only** (`?collab=1` *without* `?sync=`). The DB name is
  versioned + room-scoped: `galley-local-draft-v1-${room ?? "default"}`. CONNECTED
  mode is unchanged — the sync server is the authority and the client still joins
  empty; combining IndexedDB with a server provider tangles with server-authority
  and future auth, so offline caching there is a later slice.
- **Seed-after-load, gated on history.** The doc is constructed **empty**;
  persistence attaches; only after its `synced` event do we seed. Seeding goes
  through `seedIfPristine(doc, SAMPLE, author)` in `@galley/collab`, which seeds
  **only if the doc has no CRDT history** (empty state vector), not merely empty
  text. This guards two footguns at once:
  - **Duplication** (seed-once): a restored draft makes the doc non-pristine, so
    the template is not inserted a second time (which would merge to doubled text).
  - **Delete-all:** a draft the user deliberately cleared still carries history, so
    the template is **not** resurrected on reload.
- **Library-free core.** `@galley/collab` gains only the pure `seedIfPristine`
  (yjs-only). The browser-only `y-indexeddb` lives in `apps/web` behind a
  `DraftStore` seam (`{ whenSynced; destroy() }`) and is pulled in via a **dynamic
  `import("y-indexeddb")`**, so the static module graph — and the Node unit gate —
  never load it. Tests inject a fake `DraftStore`.
- **Graceful degradation (review #2).** `whenReady` always settles: if persistence
  fails to load (e.g. IndexedDB blocked), the session catches it and still seeds
  in-memory, so the editor is never left blank. Because seeding is gated on
  pristine-ness, a *late* `synced` can never duplicate the seed — so no timeout
  race is needed (a timeout would re-seed before a slow load lands).
- **No data loss on teardown.** `destroy()` calls the provider's `destroy()`
  (detaches), never `clearData()` (which would wipe the draft). A `destroyed`
  flag (review #3) prevents a provider created by a late-resolving dynamic import
  from leaking after an early teardown.
- **Verification.** Unit: `seedIfPristine` (fresh seeds / restored skips /
  emptied-with-history skips / empty-initial no-op / origin tag) and the session
  wiring with a fake store (fresh seeds, restored no-dup, **degrade-on-failure**,
  versioned name, destroy-without-wipe, connected-mode-no-persist). e2e (real
  browser IndexedDB): type a draft → reload → it survives and the sample is not
  duplicated; then delete-all → reload → it stays empty (no resurrection).

## Consequences

- ✅ A local draft survives refresh with zero new risk to the MVP (flag default
  OFF; LOCAL-only; the core package stays browser-lib-free).
- ✅ The seed-once + delete-all hazards are closed by a single history-based gate,
  proven against real Yjs (not assumed).
- ⚠️ **Multi-tab first-run** is a known, accepted edge: two *fresh* tabs of the
  same room can each load empty and both seed `SAMPLE`, merging to duplicate text.
  Existing persisted content is unaffected. Cross-tab coordination (a shared/
  broadcast provider or a lock) is deferred — out of scope for this slice.
- ⚠️ Persistence is **content only**; cross-peer author attribution still doesn't
  cross the wire (ADR-0007).
- ⚠️ Session creation remains a lazy-ref during render (the established,
  StrictMode-safe pattern in this codebase). The concrete leak path is closed by
  the `destroyed` flag; a fuller move to a committed lifecycle is out of scope.

## Alternatives considered

- **Seed on empty *text*** (not history). Rejected: resurrects a deliberately
  emptied draft on reload.
- **A timeout fallback for a hung IndexedDB open.** Rejected: resolving early
  would seed before a slow load completes and reintroduce duplication; the
  pristine gate already makes a late load safe and the editor works meanwhile.
- **Put `y-indexeddb` in `@galley/collab`.** Rejected: it would be the core's
  first concrete browser-lib dependency; the dynamic-import seam keeps the core
  pure and the Node gate clean (same discipline as the injected WASM / WebSocket).
