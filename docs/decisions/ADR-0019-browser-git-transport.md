# ADR-0019 — Browser git transport: in-memory fs, token stays client-side

- **Status:** Accepted (architecture); to be built core-first in one slice. Opens the
  remaining half of roadmap **#17.2** (git-sync UI).
- **Relates to:** ADR-0018 (CRDT is truth, git is a one-way projection), the E6
  git-remote core (`packages/persistence/src/git-remote.ts`).
- **Review:** the transport fork was decided via an **Architect (GPT)** tradeoff
  consult (2026-06-09).

## Context

The E6 git-remote core (`pushTree`/`fetchTree` behind a `RemoteSync` seam, with token
redaction and `DEFAULT_FETCH_LIMITS`) is built and tested, but **Node-only**: both
`HttpRemoteSync` (the live smart-HTTP edge) and `LocalBareRemoteSync` use `node:fs`
(scratch dirs via `mkdtemp(tmpdir())`, top-level `import`). Importing the core into
`apps/web` therefore breaks the Vite browser build. isomorphic-git *can* run in the
browser, but needs an injected fs (not `node:fs`) and `isomorphic-git/http/web`.

The fork: how should browser push/fetch run? (a) hand-rolled in-memory git fs injected
into a browser `HttpRemoteSync`; (b) add `@isomorphic-git/lightning-fs`; (c) a
server-side git proxy.

## Decision

**Option (a): browser-side `HttpRemoteSync` with a hand-rolled, isolated in-memory git
fs, after splitting `git-remote.ts` into a browser-safe core and Node-only adapters.**

This preserves Galley's posture — the git **token stays in the browser** (never sent
to any Galley service), fetch remains a pure import candidate (ADR-0018), and no new
external dependency is added (rejecting (b) for dep/lockfile/bundle churn; rejecting
(c) for token egress). The scratch repo is ephemeral, so in-memory beats lightning-fs's
persistent IndexedDB semantics.

### Plan

1. Split `git-remote.ts` → browser-safe core (`RemoteSync`, `RemoteConfig`, `pushTree`,
   `fetchTree`, `HttpRemoteSync`, `GitHttpClient`, redaction, limits, shared plumbing —
   no `node:fs`/`node:os`/`node:path`; replace `Buffer`-based base64 with a
   runtime-neutral helper) + a Node-only module (`LocalBareRemoteSync`, Node scratch).
2. Make `HttpRemoteSync` fs/scratch injectable (inject `fs` + `makeScratchGitdir`/
   `cleanup`); push/fetch semantics unchanged.
3. Browser adapter constructs `HttpRemoteSync(createBrowserGitHttp(), createMemoryGitFs())`;
   the in-memory fs implements only the isomorphic-git subset (read/write/mkdir/readdir/
   stat/lstat/unlink/rmdir/symlink/readlink), per-op scratch root + deterministic cleanup.
4. Canaries: keep `LocalBareRemoteSync` tests green; add a memory-fs canary running the
   same object-plumbing; pin the isomorphic-git fs-contract assumption with a loud test;
   add a check that `apps/web` pulls no `node:fs`.
5. Wire UI only after the transport is browser-safe: add `apps/web → @galley/persistence`
   workspace dep; push via `materializeProject`; fetch routes through the existing
   Accept-gated compare/restore path. The live smart-HTTP round-trip is **manual-verify**
   (not hermetically gate-testable).

## Consequences

- **Effort:** Medium (1–2d). **Risk:** isomorphic-git's fs expectations may exceed the
  adapter on upgrade → isolated fs module + pinned-version canary fail in the gate, not
  in users' browsers. Browser CORS/auth varies by host → honest UI errors + manual host
  verification; **no proxy** unless the user explicitly consents to token egress.
