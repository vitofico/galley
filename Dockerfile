# syntax=docker/dockerfile:1
#
# Galley multi-stage build. Docker is the sandbox from cycle one (see the
# manifest): build, test, and deliver all happen in-container with pinned,
# lean images. The WASM compiler + default fonts are baked into the image in
# M0 (never fetched from a CDN at runtime).
#
# Stages:
#   base   — Node + pnpm, pinned.
#   deps   — workspace dependencies, installed from the frozen lockfile (cached
#            on the manifests so source edits don't reinstall).
#   source — deps + full source tree.
#   test   — the canonical green-gate: typecheck -> unit (-> e2e once web lands).
#
# Pinned base: Node 20 LTS. Bump deliberately, with a recorded reason.
# 2026-06-20: 20.18.1 -> 20.20.2 to clear runtime-image security debt — the older
# tag's node binary + Debian-12 base had aged enough that fixable HIGH/CRITICAL CVEs
# accrued faster than the `apt-get upgrade` below could close them. The fresher tag
# resets the node binary and base layers to the latest 20-LTS point release.
FROM node:20.20.2-bookworm-slim AS base
ENV CI=1
# fonts-dejavu-core: a small default font baked into the image so typst can lay
# out and render text offline (never a runtime CDN fetch). The web build bundles
# its own font assets for the browser; this serves Node compiler tests + dev.
# Update corepack first: the version bundled in node:20.18.1 ships an expired
# signing key and fails to verify pnpm's signature (a known corepack bug).
# `apt-get upgrade` pulls the latest bookworm security point-releases so the
# runtime image clears trivy's fixable HIGH/CRITICAL OS-package CVEs (the node
# base tag stays pinned; only Debian packages are patched).
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g corepack@latest \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate \
  && pnpm config set store-dir /pnpm-store --global
WORKDIR /app

# --- dependencies (cached layer) ---------------------------------------------
# Copy only the manifests first so `pnpm install` is cached until a package.json
# or the lockfile changes. Source edits below never bust this layer.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/compiler/package.json packages/compiler/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/collab/package.json packages/collab/package.json
COPY packages/agent-client/package.json packages/agent-client/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY apps/proxy/package.json apps/proxy/package.json
COPY apps/sync/package.json apps/sync/package.json
COPY apps/compile/package.json apps/compile/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web-server/package.json apps/web-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile

# --- full source -------------------------------------------------------------
FROM deps AS source
COPY . .

# Stage the typst runtime fonts (incl. the NewCMMath math font) into
# apps/web/public/fonts so the Node examples compile-gate registers the SAME
# font set the browser serves from /fonts/. Without the math font, real math
# mode ($...$) errors "no font could be found". Network is available at build
# (like the pnpm install above); never fetched at test/runtime.
RUN pnpm --filter @galley/web copy-wasm

# --- unit (fast) -------------------------------------------------------------
# Lightweight typecheck + unit run on the slim image, for quick iteration:
#   docker compose -f docker-compose.test.yml run --build unit
FROM source AS unit
CMD ["sh", "-lc", "pnpm typecheck && pnpm test"]

# --- green-gate (full suite incl. e2e) ---------------------------------------
# `docker compose -f docker-compose.test.yml up --build --exit-code-from test`
# runs this: typecheck -> Vitest unit -> web build -> Playwright e2e. Based on
# the Playwright image (browsers + system deps baked in), pinned to the
# @playwright/test version. The gate command never changes; this entrypoint is it.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS test
ENV CI=1
WORKDIR /app
RUN npm install -g corepack@latest \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate \
  && pnpm config set store-dir /pnpm-store --global
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/compiler/package.json packages/compiler/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/collab/package.json packages/collab/package.json
COPY packages/agent-client/package.json packages/agent-client/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY apps/proxy/package.json apps/proxy/package.json
COPY apps/sync/package.json apps/sync/package.json
COPY apps/compile/package.json apps/compile/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web-server/package.json apps/web-server/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile
COPY . .
# Stage the typst runtime fonts + WASM BEFORE the unit run. The compile-gate unit
# tests (examples/templates .compile.test.ts) register fonts from apps/web/public/
# fonts, which is gitignored — so a clean checkout (CI / fresh worktree) has none
# until `copy-wasm` runs. Since the gate CMD runs `pnpm test` BEFORE `build`, we
# must stage here or those tests fail "No fonts in .../public/fonts". Mirrors the
# `source` stage; network is available at build, never at test/runtime.
RUN pnpm --filter @galley/web copy-wasm
CMD ["sh", "-lc", "pnpm typecheck && pnpm test && pnpm --filter @galley/web build && pnpm --filter @galley/web e2e"]

# --- runtime (run, not just build/test) --------------------------------------
# The self-host runtime image (roadmap #5, ADR-0017). Builds the workspace once
# (web -> apps/web/dist incl. the typst WASM via copy-wasm; the Node services ->
# tsc dist) and serves it. ONE image runs every service; `docker compose up`
# selects which by overriding `command:` — web-server (default), proxy, sync, or
# compile. This stage is NOT part of the green-gate; the build/test stages above
# are byte-for-byte unchanged.
#
#   docker build --target runtime -t galley-runtime .
#   docker run -p 8080:8080 galley-runtime            # serves the SPA
FROM source AS runtime
ENV NODE_ENV=production
# Build ONLY the web bundle (vite -> apps/web/dist) — the sole build output served
# at runtime. The Node services run from their TS source via tsx (their @galley/*
# imports resolve to `src/index.ts`), so no tsc dist is needed at runtime.
RUN pnpm --filter @galley/web build
# Prune to production via a CLEAN reinstall: drop all node_modules, then install
# only production deps. (`pnpm prune --prod` leaves the workspace `.bin` symlinks
# dangling, and `install --prod` is a no-op on a warm tree — a fresh install is the
# reliable way to get a correct prod-only structure.) This drops the build toolchain
# (vite / vitest / playwright / typescript / the stray esbuild@0.21.5 that carried
# the Go-stdlib CVEs); `tsx` + the services' runtime deps stay (tsx is now a
# production dependency). apps/web/dist (built above) is outside node_modules.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules
RUN --mount=type=cache,target=/pnpm-store pnpm install --prod --frozen-lockfile
# Strip the package-manager machinery so the published image ships NO build tools:
# the corepack pnpm cache + global npm/pnpm/corepack. This clears trivy's node-pkg
# toolchain CVEs (npm-/pnpm-bundled cross-spawn/glob/minimatch/tar) at the source.
# The runtime execs the package-local tsx binary directly, never npm/pnpm.
RUN rm -rf /root/.cache/node/corepack /root/.npm \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/pnpx
# Document the service ports: web-server 8080, proxy 8787, sync 1234, compile 3001.
EXPOSE 8080 8787 1234 3001
# Drop privileges — the slim node image ships a non-root `node` user (uid 1000).
# Everything under /app is world-readable, so reading dist/ + running tsx is fine.
USER node
# Default service: serve the built web bundle. Compose overrides this per service
# (proxy/sync/compile each invoke their own package's tsx the same way). We exec
# the package-local `tsx` binary DIRECTLY rather than `pnpm start`, so container
# startup pulls nothing from the network — corepack would otherwise try to fetch
# pnpm for the `node` user, breaking the offline-first / air-gapped guarantee.
CMD ["apps/web-server/node_modules/.bin/tsx", "apps/web-server/src/server.ts"]
