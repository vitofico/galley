# Document checks and layout auditions

Open **Before you send** in the document's writing/agent pane. Choose a page cap
and optional portrait A4/Letter requirement. Settings last for this mounted
session. Existing `.galley/instructions` word, section and forbidden-term goals
remain the deterministic source-check authority in the Writing goals card.

The additional checks report passed, failed or unavailable for the **current
preview SVG** and compile-input source files. A changed input invalidates checks
immediately, including the compiler's debounce window. A failed current compile
cannot reuse the last good render as a passing result. Paper size checks require
per-page source-map geometry from the compiler; a route without that geometry
reports unavailable. The source scan recognizes TODO/FIXME/XXX/TBD and `[[…]]`
markers. It can match code/comments and is not semantic editorial review.

Export PDF is available beside those checks and compiles a PDF separately. SVG
checks do not certify the exported PDF, font embedding, accessibility or external
submission requirements. No compliance badge is produced.

Every standard proposal diff includes expandable **Meaning changes to check**:
multiset changes to numeric/date/unit tokens, `@reference` keys and selected
English obligation/negation words. This deterministic inventory flags attention
points, includes source markup and misses changes outside its patterns. It does
not establish factual correctness, citation existence or semantic equivalence.

Open **Layout auditions** on the project main document. Choose center margin,
spread and a candidate page cap, then compile three local scratch variants. Each
candidate prepends only `#set page(margin: …mm)`; original wording, file assets
and text-size rules are byte-preserved. Existing page rules can override it,
so compare the actual compiled previews. Minimum rendered font size is explicitly
unverified; auditions never shrink text to satisfy a page cap. Package-dependent
projects unavailable to the local compiler report errors rather than pretending
a candidate compiled.

Review a successfully rendered candidate within the current page cap to open the
normal Accept/Reject diff. All rendered SVG entries are shown (the current local
engine emits a single SVG containing every page). Nothing reaches CRDT state
until human Accept. At Accept the shell re-reads target identity and the entire
compile input, including resolved binary identities, and rejects stale input.
It then uses the existing conflict-aware Accept and agent-attributed write seam.
Failed compile, stale project or a newly lowered cap prevents application.

Preview scrolling with available page geometry preserves page ordinal and
within-page reading position across SVG reflow, clamping to the last surviving
page if pages disappear. Source-to-preview navigation continues to take priority
when explicitly moving the editor cursor. Without page geometry native scrolling
is retained.

Source bundle and bare-git exports now carry the exact versioned
`.galley/workbench.json` file when it passes a bounded schema allowlist. This
includes author-provided retained source excerpts and reviewer records: treat it
as document content when sharing the export. Unknown fields, invalid records or
duplicate metadata fail export rather than silently dropping user work. Other
reserved/device/secret metadata stays excluded. Version snapshots retain their
existing config-free projection. Native source bundles preserve source paths and
contents verbatim, including `.tex`, `.cls` and `.sty` evidence/read assets; only
actual LaTeX imports invoke conversion. Native bundle and validated ZIP imports
retain workbench records through the existing report and explicit Accept step.
Normal GitHub and generic Git push projections also carry the validated records;
Git compare/import restores them only after human acceptance.

## Local verification

On 2026-10-31, the full Docker gate passed 5,184 unit tests across 341 files
(four existing skips), nine download/security-script tests and all 268 Chromium
acceptance tests. The Firefox/WebKit smoke gate passed all ten tests, and the
dependency/security audit passed. Independent review covered the six workflows,
literal replacement handling, complete compile-input freshness, atomic apply,
native source roundtrips and the actual Git push projections.

Browser acceptance exercises real local scratch compilation, failed and stale
proposals, page-cap changes, reviewed refreshes, evidence states, reviewer exports
and source-bundle import through the explicit review gate. Validation used
synthetic projects and disposable local services.
