# Contributing to Galley

Thanks for your interest. Read [`docs/vision.md`](docs/vision.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/roadmap.md`](docs/roadmap.md) before picking up work. Everything builds
and tests **in Docker** (see the root README's quick start).

## Prerequisites

- **Node ≥ 20**
- **pnpm 9** (`corepack enable` then `corepack prepare pnpm@9 --activate`)

## Setup

```bash
pnpm install
```

## Common scripts (root)

```bash
pnpm dev         # run the web app (@galley/web)
pnpm build       # build all packages
pnpm typecheck   # type-check all packages
pnpm test        # run unit tests across packages (Vitest)
pnpm lint        # ast-grep structural lint (alias of lint:ast)
pnpm lint:ast    # ast-grep structural rules only (rules/ + sgconfig.yml)
pnpm format      # prettier --write .
pnpm format:check # prettier --check . (no writes)
```

Per-package scripts live in each `package.json`. The canonical green-gate runs
the **full** suite (typecheck + unit + web build + Playwright e2e) in Docker:

```bash
docker compose -f docker-compose.test.yml run --rm --build test
```

Pass `--build`: plain `run` reuses a cached image and would silently test **stale**
code after a change. And use `run`, **not** `up --exit-code-from test`: `up` starts
every service and `--exit-code-from` tears the shared env down when the slim `unit`
service exits first, which can abort the e2e container mid-run. The Docker gate is
the source of truth — host `pnpm test` is a partial unit subset (host vitest needs
WASM/font staging the Docker image handles) and is not authoritative.

## Local checks (pre-commit)

[pre-commit](https://pre-commit.com) runs fast structural checks before each
commit — generic hygiene (trailing whitespace, EOF, merge markers), the
**ast-grep** rules in `rules/`, and **prettier** on the files you touch
(format-on-touch; the repo is normalized gradually, not all at once).

```bash
pip install pre-commit        # or: brew install pre-commit
pre-commit install            # enable the git hook
pre-commit run ast-grep --all-files     # optional: lint the whole tree
```

The ast-grep rules (`rules/*.yml`, wired via `sgconfig.yml`) flag `eval`, the
`Function` constructor, `debugger`, focused/skipped tests (`.only` / `.skip`),
stray `console.log`, `@ts-ignore`, and `TODO/FIXME`. Errors block a commit;
warnings and hints are advisory.

## CI

- **`.github/workflows/ci.yml`** — every branch push / PR: ast-grep + typecheck
  on the host, plus the unit green-gate in Docker.
- **`.github/workflows/release.yml`** — on merge to `main`: the full green-gate,
  then a [CalVer](scripts/calver.mjs) tag + GitHub release and a runtime image
  published to GHCR.

## Repo layout

```
apps/web          React + Vite app (owns live document state)
packages/compiler typst.ts wrapper (Web Worker) — framework-agnostic
packages/agent    agent loop + provider abstraction — framework-agnostic
packages/shared   cross-package types only
docs/             foundation docs + ADRs
```

See [`docs/architecture.md`](docs/architecture.md) for the dependency rules.

## Ground rules

- **Respect the scope.** Check [`docs/roadmap.md`](docs/roadmap.md) and the
  non-goals in [`docs/vision.md`](docs/vision.md) before building something new.
  If unsure, open an issue first.
- **Respect the invariants** in [`AGENTS.md`](AGENTS.md) — human-in-the-loop,
  scratch isolation, framework-agnostic core, no secrets in logs. These need an
  ADR to change.
- **Keep `shared` types-only.** No runtime logic there.
- **Update docs with contracts.** Changing a cross-package type or a behavioral
  contract means updating the relevant `docs/` page in the same PR.
- **Tests for the loop use fakes** (fake model + fake compiler), not live
  providers or real WASM.

## Decisions

Significant or hard-to-reverse decisions get an ADR in
[`docs/decisions/`](docs/decisions). Don't rewrite an accepted ADR — supersede
it with a new one.

## Commits & PRs

- Write clear, present-tense commit messages describing the change and its _why_.
- Keep PRs scoped to one focused change where possible.
- Make sure the Docker green-gate (`docker compose -f docker-compose.test.yml run
  --rm --build test`) passes before requesting review — it is the authoritative
  check.

## License & CLA

Galley is licensed under **AGPL-3.0-only** (see [`LICENSE`](LICENSE)). The name
and logo are covered by the [trademark policy](TRADEMARKS.md), not the license.

Contributions require agreeing to the **Contributor License Agreement**
([`CLA.md`](CLA.md)) — it licenses your contribution to the project (including
the right to dual-license, which keeps the open-core hosted offering viable)
while your code stays available to everyone under the AGPL. State in your first
PR: *"I have read and agree to the Galley CLA (CLA.md), version 1.0."*
