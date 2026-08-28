# ADR-0012 — Collaboration Phase 3a: cross-peer author attribution (core)

- **Status:** **Accepted**
- **Date:** 2026-06-07
- **Builds on:** [ADR-0006](ADR-0006-collaboration-phase1.md) (`CollabDocument`),
  [ADR-0007](ADR-0007-collaboration-phase2-sync-core.md) (which **deferred** this:
  Yjs updates don't carry our transaction origin)

## Context

ADR-0007 established that standard Yjs document updates do **not** encode our
transaction origin (`human:…` / `agent:…`), so author attribution was local-only
and cross-peer "who wrote which span" was deferred. The unlock: every CRDT item in
a `Y.Text` carries its originating **Yjs `clientID`**, and that *does* cross the
wire. So attribution becomes a `clientID → author` mapping plus a walk of the
visible text items. Per the project's core-first rhythm (like the 2a sync core
before the 2c editor binding), this slice ships the **offline, framework-agnostic
core only**; rendering spans in the editor is a later binding slice.

(Design validated by the Architect expert; implementation adversarially reviewed
by the Code-Reviewer expert — the item-walk was confirmed correct for plain-text
`Y.Text`; one hardening finding addressed below.)

## Decision

- **Data model:** a durable, replicated `Y.Map("authors")` from
  `String(clientID) → Author`. Each peer calls `registerAuthor(doc, author)` to
  record **its own** clientID. The map is a CRDT, so entries merge across peers and
  persist (y-indexeddb / the sync server) — unlike ephemeral awareness presence.
- **Span derivation:** `attributedRanges(doc)` walks the visible `Y.Text` items
  (`Y.getTypeChildren`), skips tombstones / non-countable / non-`ContentString`
  content, and partitions the source into contiguous spans keyed by
  `item.id.client`, coalescing adjacent same-client spans. Offsets are UTF-16 and
  reproduce `getSource()` exactly (astral chars = 2 units). Also `attributionAt`,
  `authorForClientID`, and `observeAttribution`.
- **Write-once identity (review):** a clientID identifies exactly one author for
  life. `registerAuthor` is idempotent for the same identity and **throws** on a
  conflicting re-bind (which would silently reattribute every span that client
  wrote). Corollary invariant: **one `Y.Doc` peer per identity**.
- **Init ordering:** `registerAuthor` writes the map (creating CRDT history), so it
  must run **after** `seedIfPristine` — otherwise it would make a pristine doc look
  used and suppress the seed. The session-wiring slice enforces this.
- **Yjs-internals coupling:** `getTypeChildren` / `Item` / `ContentString` are
  effectively internal; the coupling is isolated to `attribution.ts` and locked by
  a canary suite (split items, delete+insert, astral, formatting) against the
  lockfile-pinned `yjs@13.6.31`.

## Consequences

- ✅ Cross-peer "who wrote which span" is answerable offline and over the wire,
  closing the ADR-0007 deferral at the core level — proven with two in-memory peers
  (human+human and human+agent-as-distinct-peer) that converge to identical source
  AND identical attribution.
- ✅ Additive and flag-neutral: pure metadata, no change to the editor/session/MVP
  path; the core stays yjs-only.
- ⚠️ **Agent attribution requires the agent to be a distinct peer.** Today the
  in-app Accept path applies agent edits as an agent-tagged transaction on the
  *human's* doc, so those items carry the human's clientID and resolve to the
  human. A documenting test pins this invariant; routing the agent through its own
  `Y.Doc`/clientID is part of the editor-binding slice.
- ⚠️ The `authors` map grows one small entry per session/clientID (a new clientID
  each reload). Not pruned — acceptable; spans reference clientIDs, not userIds.

## Update (binding slices landed)

- **Phase 3b** wired `registerAuthor` into the session (LOCAL: after
  `seedIfPristine`; CONNECTED: after `connect()`) and added a reentrancy-safe CM6
  decoration extension (`attributionDecorations`) that paints spans by author;
  presence + attribution share one color helper. Two-browser e2e verifies distinct
  authored spans render.
- **Phase 3c** resolved the agent-clientID caveat above with
  `applyAcceptedSourceAsAgent`: Accept applies through a transient agent `Y.Doc`
  (own clientID), merging only the delta back, so the agent's spans attribute to
  the agent. e2e verifies `data-author-kind="agent"` on the inserted text.

## Alternatives considered

- **`Y.PermanentUserData`** (Yjs's built-in author tracking). Rejected as the core:
  it is string-only, delete-set-heavy, and still requires item traversal to get
  visible ranges — more machinery than this slice needs. Could revisit for
  "who deleted this" later.
- **A sidecar range-attribution structure** (record author per insert via relative
  positions). Rejected: re-implements what CRDT item clientIDs give for free and is
  hard to keep correct under concurrent merges.
- **Carry origin in a custom protocol message** alongside each update. Rejected:
  fragile, non-standard, and unnecessary given clientID already crosses the wire.
