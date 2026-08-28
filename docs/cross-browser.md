# Cross-browser e2e smoke matrix

Galley is **local-first**: it leans hard on a ~28 MB Typst **WASM** compiler running in a
**Web Worker**, **IndexedDB** (via `y-indexeddb`) for persistence, and **CRDTs** for collab —
exactly the surface where Firefox and WebKit diverge from Chromium. The canonical e2e suite
(`apps/web/e2e/`) runs **Chromium-only**; a small **cross-browser smoke matrix** runs the
riskiest specs on Firefox + WebKit so those divergences get caught without destabilizing the
canonical gate.

## The canonical gate is Chromium-only

The green-gate:

```
docker compose -f docker-compose.test.yml run --rm --build test
```

runs `pnpm typecheck && pnpm test && pnpm --filter @galley/web build && pnpm --filter @galley/web e2e`,
and `e2e` is pinned to `playwright test --project=chromium` — the full suite on the chromium
project. The `firefox`/`webkit` projects are **never** picked up by the gate: Playwright runs
every project only when none is named, and the gate always names `chromium`.

## The smoke subset (3 specs, selected by path)

The cross matrix runs a **small, high-value** subset — the specs that exercise the risky
cross-browser surface — not the whole suite. They are selected by **file path** (`testMatch` on
the firefox/webkit projects in `apps/web/playwright.config.ts`); the spec files themselves are
shared with the canonical suite, unmodified.

| Spec | Why it's in the smoke set |
|------|---------------------------|
| `e2e/preview.spec.ts` | App boot → live-preview loop: the **WASM compiler** loads in a Web Worker, the sample renders to **SVG**, and a syntax error surfaces a **located diagnostic**. The core happy path in a real browser. |
| `e2e/offline.spec.ts` | Web Worker + bundled WASM + **local fonts** with **zero external network**, asserting real **glyph geometry** (`<path>` count > 0). The strongest font/glyph + worker canary across engines. |
| `e2e/save-state.spec.ts` | **IndexedDB** persistence end-to-end (`y-indexeddb`): the save-state badge settles to *Saved*, flips to *Saving…* on an edit, then back to *Saved*. |

Together they cover: app boot, WASM compiler load, Web Worker execution, font/glyph rendering, and
IndexedDB persistence — the areas most likely to break on a non-Chromium engine.

## Run it locally

The Playwright Docker image (`mcr.microsoft.com/playwright:v1.60.0-jammy`, the `test` stage) ships
**chromium, firefox, and webkit** pre-installed — no browser install needed.

```sh
# Build the bundle, then run the firefox+webkit smoke subset:
docker compose -f docker-compose.test.yml run --rm --build --entrypoint sh test -lc \
  "pnpm --filter @galley/web build && pnpm --filter @galley/web e2e:cross"
```

Or, if you already have a built bundle + the Playwright browsers on the host:

```sh
pnpm --filter @galley/web e2e:cross   # = playwright test --project=firefox --project=webkit
```

## CI — non-blocking, for now

The `cross-browser-smoke` job in `.github/workflows/ci.yml` builds the web bundle and runs
`e2e:cross` inside the Playwright image on every PR / branch push. It is **`continue-on-error: true`
(non-blocking) on purpose**: a newly-surfaced cross-browser issue should be reported and triaged
(recorded in [`known-issues.md`](./known-issues.md)) rather than hard-blocking every PR. Intent:
flip `continue-on-error` to `false` (blocking) once the smoke set proves reliably green on the CI
runners (which may be slower than local for the ~28 MB WASM load). The canonical chromium gate is
unaffected either way.

## Status

The smoke subset is green on both engines: the WASM compiler loads, glyphs render
(`<path>` count > 0), and IndexedDB persistence settles to *Saved* on Firefox and WebKit alike.
No engine divergences are currently known. If a run surfaces one, record it in
[`known-issues.md`](./known-issues.md) (prefix `XBROWSER-…`) — the non-blocking CI keeps it
visible without breaking the build.
