# ADR-0031: Deterministic review aids and explicit portable workbench content

Status: Accepted

Document checks belong in the web layer as transparent review aids. Keep the
existing agent source constraints authoritative; distinguish fresh rendered SVG
checks from separately compiled PDF export. Missing geometry and stale renders
must be unavailable, never a passing compliance claim.

Layout auditions use dedicated local worker compilation on frozen project copies.
V0 varies page margins and preserves existing wording/assets/text sizes. It does
not claim a verified minimum rendered font size. Successful candidates are
proposals; human Accept rechecks current project input and target identity before
the existing conflict-aware source apply seam. No new auto-apply route exists.

Workbench records are user-authored portable project content. Bundle and git
exports explicitly opt in to one exact reserved path, `.galley/workbench.json`,
with strict bounded schema validation. Unknown fields fail closed to avoid
accidentally exporting future device-private fields. This policy does not relax
reserved-path handling generally or alter version snapshots. Native source `.tar`
bundles and ZIP projects use the existing review-before-Accept import flow; only
the exact metadata entry is admitted, validated before conversion/deduplication
and before project creation. The same exact validated path is recognized by
human-approved Git tree import/restore. Malformed/duplicate entries, duplicate
record identities, unknown fields and exceeded limits reject before live writes.
Native manifest projects bypass LaTeX conversion: declared text paths/content
(including `.tex`/`.cls`/`.sty` assets) and binary bytes are preserved verbatim.
Only LaTeX imports run the converter. Actual GitHub and generic Git push callbacks
share the validated portable-content projection, including saved-project pushes,
so replacing a remote tree cannot silently remove valid workbench records.
Other reserved paths remain excluded; absence in a version restore preserves
current records.

Workbench scratch proposals freeze baseline and scratch compile-input identities.
Accept reconstructs current text/main/resolved binary input synchronously and
rejects any input change, requiring a new compile rather than accepting a rebased
but uncompiled proposal. The existing conflict-aware resolver and atomic staged
multi-file Accept apply document and provenance together. Imported scalar and
reviewer replacement strings are always literal, including dollar templates.
