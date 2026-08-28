# Roadmap

> Where Galley is and where it can go. The historical build record lives in the
> git history and [`CHANGELOG.md`](../CHANGELOG.md); the product principles and
> deliberate non-goals live in [`vision.md`](vision.md).

## Where we are

The core product is **complete and green**: the local-first Typst workspace,
the human-in-the-loop agent loop (request → scratch compile → self-correct →
diff → Accept/Reject), bring-your-own-model providers, opt-in real-time
collaboration with the agent as a CRDT peer, multi-file projects with
templates and Universe packages, versioning with visual compare, import/export
breadth (Markdown, LaTeX, Overleaf, Zotero, PDF/PNG, git remotes), MCP agent
interop behind explicit consent, self-host packaging (Docker + Kubernetes), an
adversarial security audit of every network surface with a consolidated
[threat model](security-model.md), and product robustness (durability,
migrations, cross-browser, a11y). See the
[CHANGELOG](../CHANGELOG.md) for the full feature inventory.

## Next — gated on environment, not code

These are built and tested; they activate with configuration:

- **Networked auth (OIDC).** The Auth Code + PKCE core, session stores,
  sync-room membership gating, and the SPA sign-in/account UX (boot gate,
  full-screen sign-in, account chip with sign-out) are implemented and tested.
  Activation is deployment config (`GALLEY_AUTH_MODE=oidc` + an IdP) — see
  [`self-host.md`](self-host.md) and the k8s `auth` overlay. The session layer
  gets a re-audit when first activated in production.
- **Networked MCP.** Remote agent access composes on top of auth activation;
  the local consent-gated MCP surface ships today.
- **Vision-capable providers.** Layout judgment, figure-from-sketch, and AI
  alt-text have wired cores and capability-gated UI; they light up when a
  vision-capable model is configured.

## Future directions (no commitment, in rough order of pull)

- **"Connect GitHub" repo sync** — distinct from *login with* GitHub: an
  account-level GitHub connection (GitHub App preferred; PAT as the minimal
  v0) that can create a repository and push version snapshots through the
  existing git projection (`pushTree`/`fetchTree`, ADR-0019). The CRDT stays
  the single source of truth; git remains a one-way projection. Ladder:
  v0 paste-a-PAT + manual push → v1 GitHub App with one-click "create repo &
  sync" → v2 auto-push on version snapshots.
- **Literature search & citation dedup** on top of the existing Zotero/BibTeX
  support.
- **HTML export** — blocked upstream: typst.ts has no HTML target yet.
- **Richer import** — asset/multi-file mapping for LaTeX/Overleaf bundles;
  docx via a pandoc service.
- **In-browser Universe package resolution** — currently server-side only, by
  deliberate security choice.
- **Semantic context ranking** — a real embedder behind the existing context
  seam.
- **LSP-grade editing** (tinymist) — deliberately deprioritized: typst.ts
  already covers compile-feedback needs; revisit only for genuine
  language-server authoring features.
- **Ideas held in reserve:** anchored review comments, hunspell spell-check,
  gamification-free writing goals beyond the current constraints card.

## Invariants that bound all of it

- The human **Accept gate is the default and only apply chokepoint** — the
  internal agent, quick-fix, import, and figure surfaces never auto-apply. The one
  exception is operator-armed per-room **MCP auto-accept**
  ([ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md)): OFF by default,
  opt-in, signed + conflict-clean + checkpointed + revertable, with an instant
  kill-switch — and even then it only drives the same Accept gate.
- **Collaboration is an explicit Share action**, never default-on.
- **The CRDT is the single source of truth**; git is a one-way projection.
- **Local-first stays honest** — server pieces remain optional enhancements.
