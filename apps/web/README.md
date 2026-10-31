# @galley/web

The Galley front-end: a React + Vite + TypeScript single-page app.

**Status:** implemented — a full History-API-routed SPA (editor, live preview, agent
panel, diff review, multi-file projects, collaboration, settings). See [`docs/roadmap.md`](../../docs/roadmap.md).

## Workspace

The desktop workspace has resizable editor, compiled preview and writing/agent
panes, with Files and other tools on the left rail. Narrow screens use accessible
tabs instead of squeezing three panes into one view.

```
┌──────────────┬───────────────┬──────────────┐
│  Editor      │   Preview     │   Agent      │
│ (CodeMirror) │ (SVG, from    │  (chat +     │
│              │  compiler     │   diff       │
│              │  worker)      │   review)    │
└──────────────┴───────────────┴──────────────┘
```

## Routes

Routing is **path-based** (a tiny History-API router, `src/router.ts`):

| Path           | Surface                | Notes                                                    |
| -------------- | ---------------------- | -------------------------------------------------------- |
| `/`            | **Projects page**      | the landing surface (create / open / import)             |
| `/p/<id>`      | a persistent project   | local-first, auto-saved, reload-survivable               |
| `/library`     | project dashboard      |                                                          |
| `/join/<room>` | share-link entry       | joins a collaboration room (`?sync=` / `?role=` carried) |
| `/settings`    | device-scoped settings |                                                          |

The only editor-on-home hatch is `?seed=…` (the seeded Einstein showcase, also the
e2e entry). Collaboration stays an explicit Share/Connect action, never default-on.

## Responsibilities (and what lives elsewhere)

| Concern                                   | Owner                                         |
| ----------------------------------------- | --------------------------------------------- |
| Editor, panes, app state, diff review UI  | **this package**                              |
| Typst compile/render/export (in a Worker) | [`@galley/compiler`](../../packages/compiler) |
| Agent loop, tools, provider abstraction   | [`@galley/agent`](../../packages/agent)       |
| Shared types/contracts                    | [`@galley/shared`](../../packages/shared)     |

The web app owns canonical **live CRDT state**. Human editing writes that state;
agent runs and review tools work on separate scratch copies. **Ask** is the
agent default and waits for human Accept/Reject. Explicit opt-in agent Auto
modes use the established guarded/checkpointed paths; see
[ADR-0025](../../docs/decisions/ADR-0025-agent-acceptance-unification.md).
Workbench revisions and layout auditions always require explicit human Accept.
Their final gate rechecks current project input, main entry and resolved asset
bytes before applying; stale or failed scratch output cannot authorize a write.

## Document review tools

Open **Agent panel** on the left rail to reveal the writing/agent pane:

- **Before you send** checks current SVG page count/paper geometry and source
  editorial markers, with passed/failed/unavailable states. PDF export compiles
  separately; these checks do not certify its compliance.
- **Meaning changes to check** expands inside standard proposal diffs to flag
  changed numbers, dates, units, citation keys and selected modal/negation words.
  It is a deterministic token inventory, not semantic verification.
- **Document workbench → Living numbers** imports CSV/JSON project files and
  links explicit scalar values to unique document passages. Changed source
  versions flag stale prose; refreshes are compiled, reviewed proposals.
- **Document workbench → Evidence lens** manually attaches claim/source passages
  and retained versions, records review decisions and exposes changed links;
  it does not automatically fact-check claims.
- **Layout auditions** on the main document compiles three margin variants with
  wording, source assets and text-size rules preserved. Compare previews/page
  caps and Accept one; minimum rendered font size is not verified.
- **Document workbench → Reviewer response desk** links pasted comments to
  passages, tracks resolutions, drafts responses and proposes revisions.
  **Download response letter** exports Markdown.

User records live in `/.galley/workbench.json`. Validated native source/Git
roundtrips carry that known record while excluding device/secret metadata. Native
imports preserve paths, source content and binary bytes before human acceptance.
Read the [checks/auditions contract](../../docs/document-checks.md) and
[workbench workflows and limits](../../docs/document-workbench.md).

## Develop

```bash
# From the repository root after pnpm install --frozen-lockfile:
pnpm --filter @galley/web dev     # runs `copy-wasm` then `vite`
pnpm --filter @galley/web build   # production bundle (served by @galley/web-server)
```

The workspace declares Node ≥ 20 and pnpm 9.15.9 in
[`package.json`](../../package.json). Use `scripts/check-ci` for the canonical
Docker gate and `scripts/check-ci cross` for Firefox/WebKit smoke after UI or
compiler changes. The package's `e2e` script runs Chromium; `e2e:cross` selects
Firefox/WebKit. See [`architecture.md`](../../docs/architecture.md) for data flow.
