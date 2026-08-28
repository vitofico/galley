# ADR-0005 — Collaboration via Yjs CRDT (agent as a peer); pluggable OIDC auth

- **Status:** **Proposed** (direction-setting; not yet built, not in the MVP)
- **Date:** 2026-06-06
- **Deciders:** Galley founding work
- **Context doc:** [`server-and-collaboration.md`](../server-and-collaboration.md)

## Context

The MVP is single-user with no server, auth, or collaboration. But the roadmap's
headline post-MVP feature is real-time collaboration, with the elegant payoff that
**the AI agent becomes just another editing peer**. We want the direction recorded
now so MVP choices stay compatible — without committing code or scope.

This ADR is **Proposed**: it sets direction, not implementation. It will be
revisited (and either Accepted or revised) when collaboration work actually
starts. Do not build against it yet.

## Decision (proposed direction)

1. **Collaboration uses Yjs (CRDT).** One `Y.Doc` per document, Typst source as a
   `Y.Text`; a sync provider (y-websocket or equivalent) relays updates +
   awareness (cursors/presence). Conflict-free concurrent editing.
2. **The agent is a peer.** An agent run joins the same `Y.Doc` with its own
   client id; accepting its change applies edits as a Yjs transaction, merging
   with concurrent human edits through identical machinery.
3. **Auth is standards-based and pluggable.** Integrate via **OIDC**; self-hosters
   bring their own IdP or run an embedded one. Galley sees only a verified `User`.
   No hard coupling to a single SaaS auth vendor (protects the self-host wedge).
4. **Ownership model:** `Project` owned by a `User`; `Membership` grants
   `owner | editor | viewer`. Authorization enforced at the API + sync edges;
   browser packages stay authorization-agnostic.

## Consequences

- ✅ Human + AI edits merge conflict-free; no bespoke merge logic.
- ✅ The MVP's **conflict-aware Accept** and **framework-agnostic packages**
  generalize into this world rather than being rewritten (see
  [`editing-and-diff.md`](../editing-and-diff.md), ADR-0001).
- ✅ Pluggable OIDC keeps self-hosting first-class.
- ⚠️ Yjs persistence + git-backed versioning (roadmap item 4) is non-trivial; its
  own design pass when the time comes.
- ⚠️ Introduces an `Author` (human vs agent) concept into edits/events — the one
  contract that genuinely anticipates collaboration. Kept out of MVP code until
  needed (see context doc, "Should we implement contracts now?").

## Why not now

The MVP has no consumers for these types; committing them to `@galley/shared`
would be premature abstraction with likely-wrong shapes. The expensive seams
(framework-agnostic core, multi-writer-safe Accept) already exist, so deferring
the rest is cheap. Captured as design + Proposed ADR; hardened into code only when
collaboration work begins.

## Alternatives considered

- **Operational Transform (OT) instead of CRDT.** Rejected as the direction: OT
  needs a central authority and is harder to make "agent = peer"; Yjs CRDTs give
  conflict-free local-first merging that matches the product's grain.
- **Roll-your-own auth.** Rejected: security risk and undercuts BYO-IdP self-host.
- **Define all collaboration/auth contracts in code now.** Rejected: premature
  (see "Why not now").
