# Vision & Principles

> The product context document. What Galley is, why it exists, what it
> deliberately is not, and the honest definitions behind its slogans.

## One sentence

Galley is an open-source, local-first, model-agnostic, AI-native document
workspace built on Typst, whose core experience is a tight
**edit → compile → read diagnostics → self-correct** agent loop.

## The problem

AI writing assistants for documents are mostly **autocomplete** bolted onto a
slow toolchain. With LaTeX, the compile is a slow multi-pass affair, so an AI
that wants to verify its own work pays a painful cost per iteration — the loop
becomes a frustrating slideshow. Most AI document tools are also **cloud-only**
and **single-vendor**: your document leaves your machine, and your model choice
is dictated by the product.

## The three bets

These are the reasons Galley can exist as something a cloud-only, single-vendor
competitor structurally cannot copy.

### 1. Agentic, not autocomplete

Typst compiles in **milliseconds** (Rust + `comemo` incremental compilation) and
emits **structured, machine-readable diagnostics** (message, span, severity).
That makes the **edit → compile → read errors/output → self-correct** loop cheap
enough to be the default interaction, not a luxury. The agent sees its own
compile errors and fixes them *before the human ever sees a broken document.*

**This loop is the product.** Everything else is in service of it.

### 2. Local-first

The Typst compiler runs in the browser via WASM (`typst.ts`). The document and
its compilation never have to leave the user's machine. Server-side compile is an
optional enhancement for heavy projects, never a dependency.

### 3. Bring-your-own-model

A provider abstraction lets the agent run against any OpenAI-compatible endpoint,
Anthropic, or a local Ollama instance. Model choice is **first-class config**,
never a fork. Adding a provider should be configuration, not code.

## What "local-first" means (and doesn't)

Be honest about this in the product UI, not just the docs.

- ✅ **Local document state.** Your `.typ` source lives in the browser; there is
  no server round-trip to edit.
- ✅ **Local compilation.** `typst.ts` compiles on your machine. Diagnostics and
  preview never touch a server.
- ⚠️ **Remote model = remote data.** If you configure a cloud model
  (OpenAI/Anthropic/any remote OpenAI-compatible endpoint), the agent **sends
  your document context to that endpoint.** "The document never leaves your
  machine" is only fully true when the model is also local (e.g. Ollama).
- ⚠️ **The optional proxy holds your key, not your privacy.** Galley ships a thin,
  self-hostable [model proxy](providers.md) (ADR-0004) so cloud API keys stay off
  the browser. In proxy mode your document context transits the proxy host (run it
  locally to keep that hop yours) and then the provider. The proxy protects the
  *key*; it does not make a cloud model private.

The app must show clear privacy copy reflecting where document context goes for
the configured provider (local / cloud-direct / cloud-via-proxy). See
[`providers.md`](providers.md).

## What "model-agnostic" means (and doesn't)

BYO-model is **capability-gated, not just config-gated.** Two endpoints with the
same wire format can differ in whether they support streaming, tool calling, a
given auth scheme, or strict JSON. Galley probes capabilities and degrades or
warns; it does not assume them. The honest promise is *"any configured endpoint
that supports the required capabilities."* See [`providers.md`](providers.md).

## Design principles

1. **The loop is sacred.** Optimize relentlessly for the
   edit→compile→correct→review experience. Features that don't serve it wait.
2. **Human-in-the-loop is mandatory.** The agent proposes; the human disposes.
   No in-app agent edit reaches the live document without an explicit Accept. (The
   one exception is operator-armed, off-by-default MCP auto-accept —
   [ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md) — which still drives
   that same Accept handler and is signed, checkpointed, and revertable.)
3. **Scratch isolation is architecture, not a feature.** The agent works on a
   copy. Concurrent human typing must never corrupt an in-flight run.
4. **Pragmatic minimalism.** The simplest thing that makes the loop feel good.
   Resist hypothetical future needs; the roadmap is where they wait.
5. **Framework-agnostic core.** `compiler` and `agent` know nothing about React,
   so they can run server-side later without a rewrite.
6. **Honest slogans.** Local-first and model-agnostic are claims with edges; the
   UI states the edges plainly.

## Non-goals

Galley is not a citation manager and not a full language server (LSP). More
broadly, anything that doesn't serve the edit→compile→correct→review loop is
out of scope: the loop stays sacred, the manual Accept gate is the default apply
chokepoint, and features earn their place by serving it. (The one exception is
operator-armed, off-by-default MCP auto-accept —
[ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md) — which is signed,
checkpointed, and revertable, and drives that same gate.) See the
[roadmap](roadmap.md) for directions under consideration.

## Licensing & branding

- The Typst compiler is **Apache-2.0**: permissive, no copyleft, **no SaaS
  clause**. Building a commercial or open-source product on it is fine.
- Galley's own code is **AGPL-3.0-only** (see [`/LICENSE`](../LICENSE);
  [ADR-0022](decisions/ADR-0022-licensing-agpl.md)) — network copyleft protects
  the open-core hosted model; contributions go through a CLA (`/CLA.md`) so
  dual-licensing stays possible; the brand is protected by `/TRADEMARKS.md`.
- **Hard constraints:**
  - **Trademark.** Keep the name and logo distinct. Do **not** name the product
    "Typst" or "Typst + descriptive word."
  - **NOTICE.** If you ever redistribute the Typst binary, ship Typst's `NOTICE`
    file.

## Success criterion

Galley is proven if this feels *magical*:

> A user types a request → the agent proposes an edit → the system applies it to
> a scratch copy and compiles → the agent reads the diagnostics and self-corrects
> until the document compiles cleanly → the user is shown a reviewable diff to
> Accept or Reject.

If that loop is delightful, the thesis holds. Everything else is downstream of
getting it right.
