# ADR-0003 — Search/replace blocks as the agent's edit primitive

- **Status:** Accepted
- **Date:** 2026-06-06
- **Deciders:** Galley founding work

## Context

The agent must edit the Typst document. The candidate edit representations are:
**line-number edits**, **full-file rewrites**, and **search/replace blocks**
(Aider / Claude Code style: a unique `search` string + its `replace`). The MVP
also has concurrent human typing during agent runs (scratch isolation), and a
future with concurrent multi-peer editing (CRDT). The edit format must fail
*safe* when its assumptions about the source no longer hold.

## Decision

Use **search/replace blocks** as the edit primitive. `applyEdits(source, blocks)`
enforces:

- exact, **unique** match per block (0 → `no_match`, >1 → `multiple_matches`);
- sequential application against the running source;
- no overlapping edits;
- all-or-nothing per call, returning **structured `EditFailure`s** (not throwing)
  so the model can retry.

On **Accept**, the blocks are **re-matched against current live source**
(conflict-aware), not applied as a precomputed textual diff — so edits made while
the agent ran are detected as conflicts rather than silently clobbered. Full
contract: [`editing-and-diff.md`](../editing-and-diff.md).

## Consequences

- ✅ **Fails safe.** A stale block doesn't match → reported, not misapplied. Line
  numbers would silently target the wrong location.
- ✅ Token-efficient and produces readable diffs vs. full rewrites.
- ✅ Degrades gracefully toward the CRDT future ("agent is just another peer").
- ⚠️ **Not a long-term edit model.** Fails on repeated text, large
  restructures, whitespace drift, and overlapping edits. The failure path must be
  first-class and fed back to the model — it is, by design.
- ⚠️ Requires the model to include enough surrounding context to make `search`
  unique; the loop must coach it via `multiple_matches` feedback.

## Alternatives considered

- **Line-number edits.** Rejected: drift and silent misapplication, catastrophic
  under concurrent editing.
- **Full-file rewrites.** Rejected: token-expensive, destroys unrelated
  formatting, unreadable diffs.
- **Structured AST edits.** Rejected for MVP: far more complex; revisit if/when
  search/replace's failure rate proves limiting.
