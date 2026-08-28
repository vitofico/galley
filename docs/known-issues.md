# Known limitations & accepted risks

> The current list of known limitations, accepted security trade-offs, and triaged
> advisories. Each entry states what the limitation is, its impact, and why it is
> accepted (or where the real control lives). Fixed issues are not listed — git
> history records them. The overall threat model and per-surface posture live in
> [`security-model.md`](./security-model.md); CI scanning is documented in
> [`security-scanning.md`](./security-scanning.md).

## Accepted security trade-offs

These are deliberate dispositions, not open bugs. Each is either better solved at
the network/infra layer or requires a substantial feature that an in-process control
would poorly approximate. The deployment-hardening checklist in
[`security-model.md`](./security-model.md) covers the corresponding infra controls.

### SEC-SYNC-1 · CRDT update bloat in a never-idle room — MED
A busy collaboration room's in-memory `Y.Doc` grows monotonically; nothing compacts
or persists it until the room empties and is reaped. Growth *rate* is bounded (8 MiB
frame cap, 2 000 msgs/s per-connection rate cap) but total size is not. A real fix
needs CRDT persistence + compaction in the relay, which holds no persistence today.
Only reachable when the opt-in relay is enabled (default-OFF, ClusterIP-only).

### SEC-SYNC-2 · no per-IP connection-count cap on the sync relay — LOW
A single host can open many concurrent WebSocket connections (rooms are bounded by
`MAX_ROOMS = 10 000`; connections per IP are not). A robust in-process per-IP cap
must account for the trusted-proxy `X-Forwarded-For` chain to avoid both spoofing
and collapsing NATed users — easy to get wrong. In the intended posture (relay
behind a gateway, not directly exposed) the gateway is the right place for
connection caps.

### SEC-COMPILE-1 · no absolute compile output-size cap — LOW
A pathological document could render a very large SVG/PDF within the time budget;
output is bounded only by the hard compile timeout (default 20 s, worker
`terminate()`). Capping output bytes cleanly needs WASM-engine support — post-hoc
truncation would corrupt the artifact. The compile service is opt-in and
ClusterIP-only.

### SEC-COMPILE-2 · no in-process compile concurrency limit — LOW
The compile service accepts unlimited concurrent compiles, bounded only by
OS/container resources. Concurrency belongs at the deployment edge (k8s resource
requests/limits + HPA, an ingress concurrency cap, or a fronting queue); an
in-process semaphore would duplicate that and risk head-of-line blocking.

### SEC-COMPILE-3 · DNS rebinding past the registry host guard
`isBlockedRegistryHost` blocks link-local / cloud-metadata IP *literals* (and known
metadata hostnames) in `REGISTRY_BASE_URL`, but a public-looking hostname that
*resolves* to an internal address cannot be caught by a string check. The
authoritative SSRF boundary is infra egress control: a NetworkPolicy that allows
egress only to the real registry host and drops the route to `169.254.169.254`.
The in-code guard is defense-in-depth against operator misconfiguration.

### SEC-IMPORT-1 · no total input-size cap on the text converters — INFO
The LaTeX/Markdown/BibTeX/RIS converters have no byte cap on direct (paste) input.
All are strictly linear, so a multi-MB input is slow-but-bounded, never a hang; the
`.zip` import path is byte-capped upstream (32 MiB/entry, 128 MiB total, 5 000
entries). An input cap would change behavior for large-but-valid documents, so none
is imposed. Related: LaTeX inline markup nested deeper than 200 levels
(`MAX_INLINE_DEPTH`) is truncated-with-report — inner content is preserved as
escaped literal text. Real documents nest a handful of levels.

### In-process resource limits are defense-in-depth, not a gateway substitute
The web-server and proxy set generous in-process limits — 16 MiB proxy body cap
(strict `Content-Length` pre-check plus a streaming byte counter), 30 s header /
60 s request timeouts — so they degrade gracefully if directly exposed. They are
not a replacement for a fronting reverse proxy: internet-facing deployments must
terminate TLS and apply per-IP rate, connection-count, and request-size limits at
the gateway.

### Auth ships in-memory stores only
`@galley/auth` provides only `InMemorySessionStore` / `InMemoryOidcLoginStateStore`:
sessions do not survive a server restart, and there is no at-rest session storage to
protect. If a persistent (e.g. filesystem-backed) store is added, its file
permissions, at-rest format, and expiry sweep need their own security review.

### SEC-SHARE-1 · collaboration roles are enforced client-side only — MED
Share links carry a viewer/editor role that fails closed (absent/unknown ⇒
viewer) and gates every mutation path in the client behind one `canMutate`
source of truth. A determined "viewer" running a modified client can still emit
CRDT updates, because the sync relay relays room frames without inspecting
authorship or role. Real enforcement is server-side (per-connection role at the
relay, write-frame rejection for viewers) and composes with networked auth /
room membership gating. Related: "Stop sharing" disconnects and clears local
share state, but the relay holds no room tombstone — an already-distributed
link can rejoin until relay-side revocation lands with the same server-side
enforcement work.

## Toolchain advisories (triaged, not runtime risks)

Four dependency advisories are triaged in
[`.security/audit-ignore.json`](../.security/audit-ignore.json) — all in the dev
toolchain (vite / vitest / esbuild), none of which ship in the `galley-runtime`
production image (it serves prebuilt `dist` via `tsx`). Each entry carries a written
rationale and a review-by date; the weekly scan re-surfaces them. Details and the
ignore-list policy: [`security-scanning.md`](./security-scanning.md).

| Advisory | Module | Severity | Why not a runtime risk |
| --- | --- | --- | --- |
| `GHSA-5xrq-8626-4rwp` | vitest | critical | File read via the Vitest **UI server**, only when that server is started and exposed. Tests run headless (`vitest run`); the UI is never started. Clears on vitest ≥ 3 (major bump). |
| `GHSA-gv7w-rqvm-qjhr` | esbuild | high | RCE only via esbuild's **Deno** module-install path fetching its binary from an attacker-controlled `NPM_CONFIG_REGISTRY`. Galley consumes esbuild only transitively (vite/vitest) under Node + pnpm with a locked registry — never the Deno loader; the runtime image ships prebuilt `dist`. Clears when vite/vitest pull a fixed esbuild. |
| `GHSA-67mh-4wv8-2f99` | esbuild | moderate | Dev-server CORS leak, reachable only via vite's **dev** server, which CI/production never run. Clears at esbuild ≥ 0.25.0. |
| `GHSA-4w7w-66w2-5vf9` | vite | moderate | Path traversal in optimized-deps `.map` handling — only against a running vite **dev** server. Clears at vite ≥ 6.4.2. |

The secret scan allowlists a handful of fake `ghp_…` sentinel constants in
`*.test.ts`/`*.spec.ts` files that exercise token-redaction logic — never real,
never on the wire (allowlisted by exact value in
[`.gitleaks.toml`](../.gitleaks.toml)).

## Product limitations

### Projects are text-only — no binary assets (images, fonts)
The project substrate carries text files only, end to end (CRDT model, compile
contract, exports). Binary assets in an imported Overleaf `.zip` are not
imported; the import review lists them as dropped, grouped by reason. Carrying
binary assets would require a binary file channel through the CRDT model, the
compile worker protocol, the engine binding (typst.ts `mapShadow`), versioning,
and export — a deliberate future extension, not a quick fix.

### No browsable Typst Universe catalog in-app
The template picker offers the bundled offline templates only. Typst Universe
templates and `@preview` packages require a configured server compiler (Settings →
Compile); the picker explains this and marks package-backed templates accordingly,
but there is no in-app gallery for browsing the Universe.

### Typst is the only document language — no LaTeX compile or round-trip
Galley's canonical document language is Typst end to end (the CRDT substrate, the
compile contract, exports). LaTeX is supported ONLY as a best-effort, one-way
IMPORT converter (LaTeX/Overleaf `.zip` → Typst, see
`packages/agent/src/latex-to-typst.ts` and `import-latex-project.ts`); there is no
LaTeX compiler, no `.tex` compile target, and no Typst→LaTeX export. An imported
project is converted to Typst once and edited as Typst thereafter. This is a
deliberate product stance (see the README: "AI-enhanced ShareLaTeX, but Typst
instead of LaTeX"), not a missing feature.

### image() accepts raster + SVG only — PDF/EPS are not figures
Typst's `image()` decodes PNG, JPEG, GIF and SVG. Passing a PDF, EPS, TIFF, WebP or
AVIF fails to compile; Typst's raw diagnostic ("failed to parse image") does not
name the accepted formats, so Galley appends a clarifying hint (see
`enrichImageHint` in `packages/compiler/src/diagnostics.ts`). Convert the asset to
PNG or SVG before referencing it. Vector figures should be authored in Typst or
supplied as SVG.

### Multi-file proposals are capped at 32 ops; there is no import-group concept
The MCP `propose_files` tool publishes ONE atomic change set bounded by
`FILE_PROPOSAL_LIMITS` in `packages/collab/src/proposal-mailbox.ts`: at most
`maxOps = 32` ops per proposal (plus aggregate caps: `maxTotalProposedBytes` 8 MiB,
`maxTotalBlocks` 256). To change more than 32 files an agent must split the work
across MULTIPLE sequential `propose_files` calls, each reviewed/applied
independently — there is no higher-level "import group" or transaction that spans
proposals, and split proposals are not atomic with respect to each other. (Mirrors
SEC-IMPORT-1's anti-DoS posture.)

### Server-side compile is opt-in
A plain `docker compose up` starts the web service only — the compile service sits
behind the `compile` profile with no URL advertised, and Settings → Compile reports
"Not configured" with guidance. To enable it:
`docker compose -f docker-compose.yml -f docker-compose.compile.yml --profile compile up --build`.

### Collaboration rooms are in-memory only
The sync relay persists nothing: a room lives only while peers are connected (the
local-first CRDT in each browser remains the source of truth, so no document data
is lost when a room is reaped). See SEC-SYNC-1 for the memory-growth consequence.
