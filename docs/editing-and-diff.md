# Editing & Diff

> The search/replace edit contract, scratch-copy isolation, how the reviewable
> diff is produced, and how Accept handles conflicts.

## Why search/replace blocks (not line numbers, not full rewrites)

The agent edits via **search/replace blocks** (Aider / Claude Code style): a
unique `search` string and its `replace` string. Compared to the alternatives:

- **vs. line numbers:** line numbers drift the moment anything above changes, and
  degrade catastrophically once concurrent editing exists (they silently point at
  the wrong place). Search/replace **fails safe** — a stale block simply doesn't
  match.
- **vs. full-file rewrites:** rewrites are token-expensive, destroy unrelated
  formatting, and make diffs unreadable.

Its failure modes are real and are handled as first-class, structured results —
see below. (ADR:
[`decisions/ADR-0003-search-replace-edits.md`](decisions/ADR-0003-search-replace-edits.md).)

## The apply contract

`applyEdits(source, blocks) → ApplyResult` (in `@galley/agent`, types in
`@galley/shared/edits.ts`). Rules, **enforced**, not merely documented:

1. **Normalize line endings** to `\n` before matching.
2. Each block's `search` must match **exactly once** in the current running
   source.
   - 0 matches → `no_match`.
   - >1 matches → `multiple_matches` (with `matchCount`). The model must
     disambiguate by including more surrounding context in `search`.
3. **Sequential application.** Blocks apply in order against the running source;
   an earlier block's replacement is visible to a later block's search. A later
   `search` **may** include text a previous block inserted, as long as it also
   anchors on surrounding text.
4. **No overlap.** A block whose match lies **entirely within** text a previous
   block in the same batch just inserted — i.e. re-editing your own insertion
   with no anchor to original surrounding text — fails with `overlap`. (A match
   that merely *includes* a prior replacement while also covering original text
   is fine, per rule 3.)
5. **All-or-nothing per call.** If any block fails, the call returns
   `ok: false` with the list of `EditFailure`s and **does not partially mutate**
   the scratch. The agent loop feeds those failures back to the model to retry.

Failures are **structured data returned to the model**, never thrown — the model
is expected to read them and produce corrected blocks.

## Scratch-copy isolation

- An agent run operates on a **scratch string** seeded from a `DocumentSnapshot`
  taken at run start: `{ source, revision, hash }`.
- The scratch lives entirely inside the run. The live document is untouched while
  the agent works.
- **Concurrent typing is safe by construction:** the user can keep editing the
  live document during a run; nothing the run does can reach live state. The cost
  is that the run's base may be stale by the time it finishes — handled at Accept.

## Producing the reviewable diff

When the run finishes (`compiled_clean` or `max_iters_reached` with content):

1. Compute a **unified diff** from `baseSource` → final scratch source, using a
   unified-diff library, for display only.
2. Render it in the **diff review UI** with **Accept** / **Reject** controls.
3. Show, alongside the diff: the final `AgentRunOutcome`, page count, and any
   remaining **warnings** (or remaining **errors** if `max_iters_reached`).

The diff shown to the human is a *view*. The thing actually applied on Accept is
the **edit blocks**, re-matched against current source (next section) — not the
textual diff. This is what makes Accept conflict-aware.

## Accept: conflict-aware application

The user may have typed during the run, so the live document may no longer equal
`baseSource`. On **Accept**:

```
if liveHash == baseHash:
    # fast path — nothing changed underneath
    apply final scratch source directly
else:
    # the user edited during the run — re-apply the blocks to CURRENT source
    result = applyEdits(liveSource, runBlocks)
    if result.ok:
        apply result.source
    else:
        surface a CONFLICT: show which blocks no longer match uniquely;
        let the user re-run the agent or resolve manually.
        NEVER apply blindly.
```

- `stale_base` is the `EditFailure` reason used when re-application can't proceed.
- Conflict handling at Accept is load-bearing even for a single user, because
  typing during a run is normal.

## Reject

Discard the scratch and the accumulated blocks. The live document is, by
construction, already untouched — Reject is just dropping the run state and
clearing the diff UI.

## Under collaboration

With CRDT/Yjs editing (see
[`server-and-collaboration.md`](server-and-collaboration.md)), a diff can be
stale by the time it's accepted because *another* peer edited too. The same
design holds: accepted agent edits are applied as an author-tagged CRDT
transaction (`applyAgentEdits` in `packages/collab`) with identical semantics —
each block must match exactly once in the *current* shared document,
application is all-or-nothing, and a block that no longer matches uniquely is a
surfaced conflict, never silent corruption. The agent is just another CRDT
peer.
