<p align="center">
  <img src="docs/assets/galley-logo.svg" alt="Galley" width="440" />
</p>

<p align="center">
  <em>An open-source, <strong>local-first</strong>, <strong>model-agnostic</strong>,
  <strong>AI-native</strong> document workspace built on
  <a href="https://typst.app">Typst</a>.</em>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue" alt="License: AGPL-3.0-only" /></a>
  <a href="https://typst.app"><img src="https://img.shields.io/badge/built%20on-Typst-239dad" alt="Built on Typst" /></a>
  <a href="docs/security-model.md"><img src="https://img.shields.io/badge/security-threat%20model-success" alt="Security: threat model" /></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs welcome" /></a>
  <a href="https://ko-fi.com/vito507767"><img src="https://img.shields.io/badge/Ko--fi-support%20this%20project-ff5e5b?logo=ko-fi&logoColor=white" alt="Support this project on Ko-fi" /></a>
</p>

A *galley proof* is the preliminary typeset version you check and correct before
final layout — which is exactly this app's core loop: **compile → inspect →
correct → repeat.**

Galley is, conceptually, "AI-enhanced ShareLaTeX, but Typst instead of LaTeX, open source,
and not locked to one vendor's cloud or model." The differentiation is three
bets a cloud-only, single-vendor product structurally cannot make:

1. **Agentic, not autocomplete.** Typst compiles in milliseconds and emits
   structured, machine-readable diagnostics. That makes a tight
   **edit → compile → read errors → self-correct** loop cheap. _That loop is the
   product._
2. **Local-first.** The Typst compiler runs in the browser via WASM
   ([`typst.ts`](https://github.com/Myriad-Dreamin/typst.ts)). Your document and
   your compile stay on your machine. Server-side compile is an optional
   enhancement, never a dependency. _(See the honest [local-first
   definition](docs/vision.md#what-local-first-means-and-doesnt) — remote model
   endpoints still receive your document.)_
3. **Bring-your-own-model.** A provider abstraction runs the agent against any
   OpenAI-compatible endpoint, Anthropic, or a local Ollama. Model choice is
   config, never a fork.

## Status

Galley works end-to-end in the browser today: a CodeMirror editor with a live
SVG preview (typst.ts compiling in a Web Worker) and the human-in-the-loop
agent loop — **request → self-correct → diff → Accept/Reject → re-render**.
Bring your own model (any OpenAI-compatible endpoint, Anthropic, or a local
Ollama) or use the built-in offline **Demo** agent. Real-time collaboration is
opt-in — one-click **Share** upgrades a project to Yjs CRDT co-editing with the
**agent as a peer**, presence, and per-author attribution ([ADRs
0005–0012](docs/decisions)). Multi-file projects and templates, named versions
with visual compare, broad import/export (Markdown, LaTeX, Overleaf `.zip`,
Zotero/`.bib` in; PDF/PNG out), and opt-in MCP access behind an explicit
consent gate round it out. Self-host with Docker compose or Kubernetes; the
whole test suite (typecheck + unit + Playwright e2e) runs **in Docker**. See
the [CHANGELOG](CHANGELOG.md) for the full feature inventory and the
[roadmap](docs/roadmap.md) for what's next.

### Default product & routes

Galley uses **path-based routes** (a tiny History-API router):

- **`/`** — the **Projects page**, the landing surface (create / open / import projects).
- **`/p/<id>`** — a specific **local-first project** (auto-saved to the browser, reload-survivable).
- **`/library`** — the project dashboard.
- **`/join/<room>`** — share-link entry (joins a collaboration room; carries `?sync=` / `?role=`).
- **`/settings`** — device-scoped settings.

Collaboration is an explicit **Share** action, never on by default. The only
editor-on-home hatch is **`?seed=…`** (the seeded Einstein showcase, also the e2e entry).

## The core loop

```
User request
   │
   ▼
Agent proposes edits (search/replace blocks)
   │
   ▼
Apply to a SCRATCH copy ──► compile ──► read diagnostics
   │                                         │
   │   ◄── errors? revise (up to MAX_ITERS) ─┘
   ▼
Clean compile → present a reviewable diff
   │
   ▼
User clicks Accept ──► apply to live document
        or Reject  ──► discard scratch
```

In the editor loop the human is always in control — the in-app agent never
auto-applies an edit. (External MCP agents can be granted opt-in auto-accept — off
by default, signed, checkpointed, and revertable — which only drives the same
Accept path; see the [security model](docs/security-model.md).)

## Monorepo layout

```
galley/
├─ apps/
│  ├─ web/          # React + Vite app: editor, preview, agent panel, diff UI
│  ├─ web-server/   # tiny Hono static server for the built SPA (self-host runtime)
│  ├─ sync/         # @galley/sync — optional y-websocket collaboration server
│  ├─ compile/      # optional server-side Typst compile service (Hono + @galley/compiler)
│  ├─ proxy/        # thin, optional, self-hostable model-API proxy (keys off the browser)
│  └─ mcp/          # inbound MCP local kernel: exposes the agent tools to external MCP clients
├─ packages/
│  ├─ compiler/     # typst.ts wrapper: check(), render(), export() — in a Worker
│  ├─ agent/        # agent loop, tools, provider abstraction
│  ├─ collab/       # Yjs CRDT doc, presence, and cross-peer author attribution
│  ├─ auth/         # generic OIDC (Auth Code + PKCE) auth core
│  ├─ persistence/  # ProjectStore / CrdtStore / VersionStore adapters
│  └─ shared/       # cross-package types: Diagnostic, EditBlock, AgentEvent, …
├─ docs/            # foundation docs (start here ↓)
├─ AGENTS.md        # rules for AI agents working ON this repo
└─ CONTRIBUTING.md
```

`compiler` and `agent` are framework-agnostic (no React) so they can be reused
server-side. The optional server pieces — `apps/proxy` (model proxy, keys off the
browser), `apps/sync` (collaboration relay), and `apps/compile` (server-side
compile) — are stateless, off by default, and self-hostable (see the
[ADRs](docs/decisions)). The default single-user path needs none of them.

## Documentation

Read these in order:

| Doc | Purpose |
| --- | --- |
| [`docs/vision.md`](docs/vision.md) | Product principles, the three bets, non-goals, honest definitions |
| [`docs/architecture.md`](docs/architecture.md) | Package boundaries, data flow, the worker model, source-of-truth rules |
| [`docs/roadmap.md`](docs/roadmap.md) | What's built, what activates with config, future directions |
| [`docs/security-model.md`](docs/security-model.md) | Threat model, per-surface posture, deployment hardening checklist |
| [`docs/self-host.md`](docs/self-host.md) | Docker compose + Kubernetes packaging |
| [`docs/server-and-collaboration.md`](docs/server-and-collaboration.md) | Server topology, accounts/auth, Yjs collaboration, agent-as-peer (design rationale) |
| [`docs/agent-loop.md`](docs/agent-loop.md) | The agent state machine, tools, iteration/error/cancel handling, event stream |
| [`docs/editing-and-diff.md`](docs/editing-and-diff.md) | Search/replace contract, scratch isolation, diff, Accept/Reject conflicts |
| [`docs/compiler.md`](docs/compiler.md) | typst.ts init, worker protocol, fonts, diagnostics normalization, preview/export |
| [`docs/providers.md`](docs/providers.md) | Provider types, capability probing, CORS/key caveats, local vs remote privacy |
| [`docs/decisions/`](docs/decisions) | Architecture Decision Records (ADRs) |

## Quick start

The fastest path — run it with Docker (no toolchain needed):

```bash
docker compose up --build    # → http://localhost:8080
```

The **Demo (offline)** model lets you try the full agent loop with no provider
or API key configured; open **Settings** to point at an OpenAI-compatible
endpoint, Anthropic, or a local Ollama.

For development with a local toolchain (Node ≥ 20, pnpm 9):

```bash
pnpm install
pnpm dev          # runs @galley/web
```

Tests build and run entirely **in Docker**:

```bash
# Full green-gate: typecheck + unit + web build + Playwright e2e
# (--build is required: plain `run` reuses a cached image and would test stale code)
docker compose -f docker-compose.test.yml run --rm --build test

# Fast typecheck + unit only
docker compose -f docker-compose.test.yml run --rm --build unit
```

## Self-hosting

`docker compose up --build` runs Galley (web + proxy + sync) at
http://localhost:8080 — see [`docs/self-host.md`](docs/self-host.md). The web app
compiles Typst in the browser by default, so it is complete on its own.

**Enabling server-side compile (opt-in).** The heavier compile service isn't run
by default, so `Settings → Compile → Server` reports "Not configured." To wire it
up, use the ready-to-run overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.compile.yml \
  --profile compile up --build
```

It pre-sets `GALLEY_COMPILE_URL=http://127.0.0.1:3001/compile` (the
browser-reachable endpoint) so Server/Auto "just work"; the default
`docker compose up` stays web-only. Details in
[`docs/self-host.md`](docs/self-host.md#enabling-server-side-compile).

## License

Galley is licensed under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)): use,
modify, and self-host freely; if you offer a **modified** Galley to others over
a network, you must publish your modified source under the same license. The
"Galley" name and logo are protected separately by the
[trademark policy](TRADEMARKS.md) — forks must rename. Contributions require
the [CLA](CLA.md) (see [CONTRIBUTING](CONTRIBUTING.md)).

The Typst compiler Galley builds on is **Apache-2.0** (permissive — building on
it is fine); keep the name distinct (don't name anything "Typst") and ship
Typst's `NOTICE` if you ever redistribute its binary. See
[`docs/vision.md#licensing--branding`](docs/vision.md#licensing--branding).
