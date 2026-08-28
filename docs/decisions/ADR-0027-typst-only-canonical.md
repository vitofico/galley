# ADR-0027 — Typst is the canonical document language; LaTeX is one-way import only

- **Status:** Accepted (2026-06-19)
- **Context:** an MCP road-test agent assumed a LaTeX import/compile path
  existed and tried to operate on `.tex` source. This ADR records the standing
  product stance so that assumption is documented, not rediscovered.

## Context

Galley's bet is Typst's fast, structured-diagnostics compile loop. Typst is the
single document language across the whole stack: the CRDT substrate stores Typst
source, the compile contract (`@galley/compiler`) compiles Typst, and exports
produce PDF from Typst. LaTeX appears only at the *door*: an imported
LaTeX/Overleaf `.zip` is run through a best-effort converter to Typst, surfaced
for an import-repair review, and from then on edited as Typst.

A road-test agent reasonably-but-wrongly inferred that LaTeX was a first-class,
round-trippable format. It is not — and supporting it as one would double the
compile, diagnostics, and edit surface for a product whose core advantage is
Typst.

## Decision

1. **Typst is canonical, end to end** — the CRDT substrate, the compile
   contract, and all exports operate on Typst source only. The agent and the MCP
   tools only ever read/propose Typst.
2. **LaTeX is import-only and best-effort** — the LaTeX/Overleaf `.zip` →
   Typst converter (`packages/agent/src/latex-to-typst.ts`,
   `import-latex-project.ts`) is a one-way, lossy conversion that produces Typst
   the user then edits as Typst.
3. **No LaTeX compiler, no `.tex` compile target, no Typst→LaTeX export** —
   there is no round-trip.

## Consequences

- Import is lossy/best-effort and surfaces an import-repair review; users cannot
  round-trip back to LaTeX.
- Every downstream surface (compile, diagnostics, agent, MCP) is simpler because
  it only handles one language.
- The stance is durable: the README ("AI-enhanced ShareLaTeX, but Typst instead
  of LaTeX") and `docs/roadmap.md` import notes already frame Galley this way.

## Alternatives considered

- **Dual-language (LaTeX + Typst) support** — rejected. It would double the
  compile/diagnostics/edit surface and dilute the product's core bet on Typst's
  fast structured-diagnostics loop, for a feature that the one-way import
  already covers in practice.
