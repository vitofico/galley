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

### Security & robustness

- Six-surface adversarial security audit (import parsers, sync relay,
  web-server + proxy, compile + registry, MCP, auth) with fuzz harnesses in the
  suite and a consolidated [threat model](docs/security-model.md).
- CI security baseline: dependency audit, secret scan, SAST, image scan, SBOM.
- Storage durability nudges, forward-only schema migrations, Firefox/WebKit
  smoke matrix, keyboard/focus a11y pass.

### Migration notes

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
