# Galley docs — map

**Start here**

- [`vision.md`](vision.md) — what Galley is, the three bets, non-goals, honest
  definitions.
- [`architecture.md`](architecture.md) — the monorepo/system shape, package
  boundaries, source-of-truth rules.
- [`roadmap.md`](roadmap.md) — where the product is and where it can go.

**Product reference** (how the pieces work)

- [`agent-loop.md`](agent-loop.md) · [`editing-and-diff.md`](editing-and-diff.md) —
  the AI loop and the search/replace + Accept-gate contract.
- [`compiler.md`](compiler.md) · [`server-side-compile.md`](server-side-compile.md) ·
  [`UNIVERSE_INTEGRATION.md`](UNIVERSE_INTEGRATION.md) — in-browser WASM compile, the
  opt-in compile service, and the Typst Universe package-integrity manifest + fail-closed fetch.
- [`providers.md`](providers.md) — model providers, transports, local-Ollama dev.
- [`mcp-kernel-setup.md`](mcp-kernel-setup.md) — connect an external MCP client
  (Claude Code, etc.) to a Galley project via the local kernel.
- [`server-and-collaboration.md`](server-and-collaboration.md) — sync relay, rooms,
  presence, attribution.
- [`github-connect.md`](github-connect.md) — Connect GitHub v0: paste-a-PAT +
  manual one-way snapshot push via the REST Git Data API.
- [`self-host.md`](self-host.md) — Docker/k8s packaging.
- [`storage-migrations.md`](storage-migrations.md) — the forward-only local
  storage schema-migration seam.

**Security & robustness**

- [`security-model.md`](security-model.md) — the threat model: trust
  boundaries, per-surface posture, deployment hardening checklist.
- [`security-scanning.md`](security-scanning.md) — the recurring scan baseline
  (`scripts/security-scan.sh` + `security.yml`): scanners, fail thresholds, the
  audit ignore-list policy.
- [`known-issues.md`](known-issues.md) — known limitations and accepted
  edges, by theme.
- [`cross-browser.md`](cross-browser.md) · [`a11y-notes.md`](a11y-notes.md) ·
  [`perf-notes.md`](perf-notes.md) — engine matrix, accessibility state,
  document-scale behavior.

**Records**

- [`decisions/`](decisions/) — ADRs (immutable; supersede, don't rewrite).
