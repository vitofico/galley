# Document workbench

The editor's **Document workbench** disclosure provides three offline workflows.
It stores schema-versioned JSON in the project's canonical CRDT text file
`/.galley/workbench.json`. These are explicit human provenance records, not
truth verification. No provider or server is required.

## Living numbers

Import a CSV or JSON with the workbench's file picker. Existing paths are never
overwritten. Give a scalar a name, choose its project source, enter a JSON dot
path (array indices supported) or a CSV `row.header` selector (first data row is
1), and paste a unique passage containing the current value exactly once.

Each binding retains the source text version, selector, value and linked passage.
A changed source marks dependent prose as potentially stale even if the selected
value did not change. **Preview reviewed refresh** substitutes only that value
in the explicitly linked passage. Equal-value refreshes acknowledge the source
version without editing prose. This does not discover unlinked dependencies.

## Evidence lens

Attach a claim's exact unique passage to a project text source. Retain that source
version, select an exact source excerpt and explicitly mark it reviewed by you.
The states distinguish source attached, passage selected, reviewed by you, source
changed and unavailable/changed links. Source changes invalidate the current
review status; attaching the new version clears excerpt selection and review.
This records a human review decision and never stamps a claim as true.

## Reviewer response desk

Paste a reviewer comment, link its passage and draft a replacement and response.
Save edited drafts and explicitly choose open/addressed/declined. Reviewing a
revision produces a normal proposal. Accepting does not automatically mark the
comment addressed. Download or copy the Markdown response letter with comments,
locations, decisions, draft replies and proposed revisions.

All record types offer explicit relinking to the active document and, where
applicable, a current source file, including after a rename. Relinking evidence
clears the previous review. Bindings with a different selector can be removed
and created again.

## Review and persistence contract

Proposals freeze their target file ID/path, source dependency versions, metadata
version and compile input. A dedicated local worker compiles the scratch project;
Accept stays disabled until that exact scratch compile succeeds. Failed or
unavailable compilation remains visible and proposals can always be rejected.
Scratch preview output is sanitized through the existing Preview component.

Accept rechecks the active file identity, current target passage, metadata and
source versions. It also synchronously reconstructs the full current compile input,
including all text files, the main entry and resolved binary byte identities, and
checks both the frozen baseline and proposed scratch identities. Any project input
change requires a new reviewed compile; workbench proposals deliberately do not
rebase onto uncompiled concurrent typing. `resolveAccept` remains the conflict
check; `applyAcceptedFileSetAsAgent` stages both document and metadata edits
on a clone and merges one CRDT update. Any validation failure leaves both intact.
Concurrent typing can therefore conflict instead of being silently overwritten.

Metadata changes (linking, reviewing, saving drafts, resolving, removing) require
explicit user actions and are blocked for viewers. Whole metadata saves use a
fresh compare-and-swap check. Unsupported or malformed JSON is preserved and
blocks saving. Limits are 100 total records, 500 KB per retained source version,
64 KB per other field and 2 MB serialized metadata. CSV supports quoted commas,
newlines and escaped quotes; ambiguous headers and non-scalar JSON are rejected.

Project browser persistence retains these records. Native source bundles (`.tar`)
and git projections explicitly carry only validated `.galley/workbench.json` from
the reserved namespace, alongside their existing manifest/instructions contracts.
Import a native bundle through **Import project**, review the preserved Typst,
main entry and user records, then Accept to create a new project. Native manifest
imports preserve text paths, extensions and contents verbatim, including `.tex`,
`.cls`, `.sty` and extensionless evidence/read assets, alongside exact binary bytes.
They never invoke LaTeX conversion; conversion is reserved for LaTeX projects. ZIP projects
may also include the exact validated metadata path. The Git comparison/import
flow restores that same exact file after human acceptance. Normal GitHub snapshot
and generic Git push callbacks use the same validated workbench projection as
source/bare-git exports, including when pushing from a saved local project.

Incoming metadata is validated before conversion can deduplicate entries and again
before any live restore or project creation. Unknown fields, duplicate record IDs,
duplicate metadata entries and malformed/over-limit records fail closed. Other
reserved/device/secret paths remain excluded; lookalike or normalized aliases do
not gain metadata admission. Version snapshots retain their existing config-free
projection and a restore omitting workbench records leaves current records intact.
Only the bounded regular-file ustar format emitted by Galley's source bundle is
supported (`.tar.gz`, Git-repository archives and general tar extensions are not).
The separate response letter download is portable Markdown. No automatic claim
checking, implicit data replacement, provider-based response generation or
unlinked dependency discovery is implied.
