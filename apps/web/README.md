# @galley/web

The Galley front-end: a React + Vite + TypeScript single-page app.

**Status:** implemented — a full History-API-routed SPA (editor, live preview, agent
panel, diff review, multi-file projects, collaboration, settings). See [`docs/roadmap.md`](../../docs/roadmap.md).

## Panes (target layout)

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

| Path | Surface | Notes |
| --- | --- | --- |
| `/` | **Projects page** | the landing surface (create / open / import) |
| `/p/<id>` | a persistent project | local-first, auto-saved, reload-survivable |
| `/library` | project dashboard | |
| `/join/<room>` | share-link entry | joins a collaboration room (`?sync=` / `?role=` carried) |
| `/settings` | device-scoped settings | |

The only editor-on-home hatch is `?seed=…` (the seeded Einstein showcase, also the
e2e entry). Collaboration stays an explicit Share/Connect action, never default-on.

## Responsibilities (and what lives elsewhere)

| Concern | Owner |
| --- | --- |
| Editor, panes, app state, diff review UI | **this package** |
| Typst compile/render/export (in a Worker) | [`@galley/compiler`](../../packages/compiler) |
| Agent loop, tools, provider abstraction | [`@galley/agent`](../../packages/agent) |
| Shared types/contracts | [`@galley/shared`](../../packages/shared) |

The web app owns the **live document state** and is the only place that mutates
it — and only after a user clicks **Accept** on an agent diff.

## Develop

```bash
# Docker is the canonical gate (see docs/self-host.md); for a quick local loop:
pnpm --filter @galley/web dev     # runs `copy-wasm` then `vite`
pnpm --filter @galley/web build   # production bundle (served by @galley/web-server)
```

See [`docs/architecture.md`](../../docs/architecture.md) for the data-flow diagram.
