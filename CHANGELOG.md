# Changelog

Galley releases are tagged [CalVer](https://calver.org) (`vYYYY.MM.PATCH`) by
the release workflow on merge to `main`. Notable changes land here; the
granular record is the git history.

## Unreleased — current state (2026-06)

The first public cut. Everything below is built, tested (2300+ unit tests,
120+ Playwright e2e, all in Docker), and on by default unless marked opt-in.

### The core product

- **Local-first Typst workspace** — CodeMirror 6 editor, live SVG preview
  compiled in-browser by [typst.ts](https://github.com/Myriad-Dreamin/typst.ts)
  (WASM in a Web Worker), PDF and PNG export. `/` boots a persistent project
  (IndexedDB, reload-survivable); documents never need to leave the machine.
- **The agent loop** — request → the agent edits a scratch copy → compiles →
  reads diagnostics → self-corrects → you review a unified diff and
  **Accept/Reject**. The human Accept gate is mandatory everywhere, including
  selection-scoped revisions (⌘⇧E) and "Refine…" on a pending proposal.
- **Bring-your-own-model** — any OpenAI-compatible endpoint, Anthropic, or
  local Ollama; optional stateless proxy keeps cloud keys off the browser; a
  built-in offline Demo agent works with no provider at all.
- **Real-time collaboration (opt-in)** — one-click Share upgrades a project to
  a sync room (Yjs CRDT): presence, per-author attribution, and the AI agent as
  a distinct CRDT peer. Local drafts persist offline either way.
- **Multi-file projects** — file tree with folders, rename, full-text search
  with replace/replace-all (conflict-safe: an apply that races a collaborator's
  edit aborts whole rather than clobbering it); templates; Typst Universe
  packages via the opt-in server-side compile with an integrity-pinned registry
  manifest.
- **Versioning & interop** — named versions with visual compare (git-backed
  storage core); Markdown/LaTeX import with repair preview; Overleaf `.zip`
  import; Zotero citations; `.bib` support; git remote push/fetch projection.
- **MCP agent interop (opt-in, default-OFF)** — external agents can pair with
  an explicit consent flow; read access to a project's files requires a
  per-project, per-session grant in Settings, and responses are
  HMAC-authenticated against an out-of-band pairing key; by default every MCP edit
  goes through the same human Accept gate, with an opt-in (off-by-default, signed,
  checkpointed, revertable) auto-accept that drives that same gate.
- **Connect GitHub (opt-in)** — paste a PAT (stays in your browser), then push
  one-way project snapshots to a GitHub repo from the Git panel; the local
  project remains the source of truth.
- **OIDC sign-in (opt-in)** — with `GALLEY_AUTH_MODE=oidc` the app gates boot
  on a session: a full-screen sign-in that returns you to the page you asked
  for, and an account chip with sign-out. Off by default — the local mode
  stays login-free, byte-for-byte.
- **Self-hosting** — one runtime image + `docker compose up`; Kubernetes
  kustomize base with composable overlays (compile, registry, auth/OIDC);
  hardened defaults (CSP, default-deny NetworkPolicy, read-only rootfs).
- **Hosted connector, first step (opt-in, in progress)** — on a signed-in
  deployment whose operator enabled it, a project can be connected in
  Settings: the relay then keeps a server copy of it, and only of it, so an AI
  client will be able to work on it with no tab open
  ([ADR-0033](docs/decisions/ADR-0033-hosted-connector.md)). The same card
  issues per-client access tokens, shown once and stored only as a
  fingerprint. A new connector service answers at `/mcp` and lets a client
  holding a token list, read, search and compile a connected project, and
  change it. In Ask mode a change waits for the owner's Accept in Galley. In
  Auto mode the server applies it with no tab open: it saves a checkpoint of
  the whole project first and records the change, the owner sees the record
  in Settings and can return to the checkpoint from the project's History.
- **A connected project opens on your other devices** — sign in on a phone and
  the Projects page lists the projects you connected elsewhere, under "On the
  server". One opens from its server copy at `/c/<project id>`: read it, edit
  text, accept or reject what an AI client proposed. The room's secret id is
  looked up behind sign-in and never put in the address or in that device's
  storage, and such a session never applies a proposal on its own
  ([ADR-0034](docs/decisions/ADR-0034-connected-project-second-device.md)).
  Text only for now: images and project fonts are not in the server copy.
- **Phone layout** — on a narrow touch screen the tabbed workspace opens on
  the typeset page, with finger-sized controls and a header that leaves the
  page most of the screen. A proposal survives switching tabs and its
  Accept/Reject can be reached; an external proposal opens as a full-height
  review sheet. Preview zoom now sizes the page (it was a visual scale that
  could not be panned), so a zoomed page scrolls to every edge at any width,
  and Fit fills the pane when the page is wider than it.

### Security & robustness

- Six-surface adversarial security audit (import parsers, sync relay,
  web-server + proxy, compile + registry, MCP, auth) with fuzz harnesses in the
  suite and a consolidated [threat model](docs/security-model.md).
- CI security baseline: dependency audit, secret scan, SAST, image scan, SBOM.
- Storage durability nudges, forward-only schema migrations, Firefox/WebKit
  smoke matrix, keyboard/focus a11y pass.

### Migration notes

- **The local MCP bridge takes the hosted connector's tool shapes (breaking for
  MCP clients).** The two ways in now share one tool list
  ([ADR-0033](docs/decisions/ADR-0033-hosted-connector.md) §5). What changes for
  an agent using `galley-mcp`:
  - every project tool takes a required `project`, the `projectId` from
    `list_projects`: `list_files`, `read_file`, `project_context`, `compile`,
    `propose_edit`, `propose_files`, `export_compiled`. A kernel started with
    `--room` has one project, `current`;
  - `propose_edit` takes the `path` of the file to edit instead of always
    editing the session's file;
  - `read_document` is gone: use `read_file` with the path;
  - the control-mode tools that took `projectId` take `project` instead
    (`open_project`, `list_versions`, `search_project`, `list_bibliography`,
    `list_version_files`, `read_version_file`, `request_restore_version`).
    Results still say `projectId`;
  - the tool list is static. Nothing appears after `open_project` and nothing is
    retired by it: a tool that needs an open project answers
    `status: "no_project_attached"` until one is open.

  Agents discover tools and their inputs from the server, so most clients adapt
  on reconnect. Saved prompts or scripts that name `read_document`, pass
  `projectId`, or call `propose_edit` without a `path` need updating.

- **Server-side compile now isolates by default.** `GALLEY_COMPILE_ISOLATION`
  left unset now resolves to `worker` — each compile runs in a terminable
  `worker_thread`, so a runaway document returns 503 instead of wedging the
  service; it previously defaulted to the `inline` engine. Non-registry
  deployments **silently gain worker isolation** on upgrade, which is safe and
  perf-equivalent (~1–2 ms over inline in steady state; the one-time ~106 ms WASM
  module compile is paid once per process and reused across threads). **Custom
  deployments that set `REGISTRY_BASE_URL` for Universe packages MUST set
  `GALLEY_COMPILE_ISOLATION=inline` before upgrading**: worker isolation is
  incompatible with a registry, and with the var unset the service now resolves to
  `worker`, so it will **refuse to start** (worker + registry throws at startup).
  The shipped `compile` / `compile-registry` kustomize components and the
  `docker-compose.yml` compile service already set the correct value explicitly —
  only hand-rolled registry deployments that relied on the old unset default are
  affected.

### License

- Relicensed **Apache-2.0 → AGPL-3.0-only** (2026-06-11, before any external
  contribution; ADR-0022) with a contributor CLA and a trademark policy.
