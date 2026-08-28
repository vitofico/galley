# Galley security model

> The threat model and per-surface security posture for Galley. Open limitations
> and accepted trade-offs are tracked in [`known-issues.md`](./known-issues.md);
> CI security scanning is documented in [`security-scanning.md`](./security-scanning.md).
>
> **Audience:** operators self-hosting Galley and contributors reasoning about a
> change's blast radius. If you are deploying Galley on a network, read §3
> (Deployment hardening checklist) before exposing any service.

---

## 1. System trust model & assets

Galley is **local-first**. The authoritative copy of a user's work lives in their
own browser (IndexedDB-backed CRDT). The optional server-side services exist to add
capabilities (collaboration, server compile, model-API key custody, agent access),
not to hold the source of truth. This shapes the entire threat model: most surfaces
are **opt-in and ClusterIP-only by default**, so the attack surface that is exposed
out of the box is deliberately small.

### Core trust principles

- **CRDT-as-truth.** A project is a Yjs document persisted locally. Edits converge
  via CRDT merge; there is no server-authoritative document to corrupt. Server
  components relay or transform, they do not own state.
- **The Accept gate.** By default the AI agent never writes to a user's document
  directly — it produces a *proposal* the user must **Accept** before any change
  lands. An operator may arm opt-in **MCP auto-accept**
  ([ADR-0023](decisions/ADR-0023-mcp-auto-accept-provenance.md); OFF by default,
  per-grant, signature-authenticated, checkpointed and revertable, with an instant
  kill-switch), which delegates write authority to the paired kernel for that
  grant; even then the same Accept handler is the sole apply chokepoint. The agent
  loop is sandboxed behind injected model + compiler seams and parses no privileged
  bytes on the user's behalf without that gate.
- **Default-OFF sharing & agent access.** Collaboration rooms (Share) and the
  MCP **Agent Access** mount are both **off until the user explicitly turns them
  on**. A fresh, un-configured deployment exposes only the static SPA.
- **ClusterIP-only sensitive services.** The model-API **proxy** (which holds the
  provider key), the **compile** service, the **sync** relay, and the **MCP** kernel
  are intended to run as cluster-internal services. The **web-server** (static SPA)
  is the only service meant to be internet-facing by default.
- **Untrusted input is the user's own.** Imported `.zip`/`.tex`/`.bib`/`.md` and
  typed Typst are *the user's own content compiled in the user's own session*. The
  parser/compiler hardening below is about **availability** (no hang/crash/OOM/output
  bomb) and **output integrity** (no injection into generated artifacts), not about
  a cross-user confidentiality boundary — there generally isn't one in the
  single-user local-first case.

### Assets worth protecting

| Asset | Where it lives | Primary risk |
|-------|----------------|--------------|
| The user's documents | Browser IndexedDB (CRDT) | Loss / corruption / unwanted exposure via an opened Share room |
| The model-API key | The **proxy** process (env) | Exfiltration via SSRF / open-relay / log leak |
| A live collaboration room | The **sync** relay (in-memory Y.Doc) | Cross-room leakage, hijack (CSWSH), DoS |
| Compile service availability | The **compile** worker | Wedge / OOM / output-bomb DoS, registry SSRF |
| Session / identity (when auth on) | `@galley/auth` (cookies, JWKS, session store) | Replay, open-redirect, token/JWKS abuse |

---

## 2. Per-surface posture

Every surface below has been adversarially reviewed and carries fuzz/property
regression tests pinning its defenses. Residual risks reference the entries in
[`known-issues.md`](./known-issues.md).

### 2.1 Posture table

| Surface | Code | Default exposure | Key defenses | Residual risk | Deploy guidance |
|---------|------|------------------|--------------|---------------|-----------------|
| **Import parsers** | `packages/agent/src/{latex-to-typst,md-to-typst,import-latex-project,citation,bibliography,reference-import}.ts`, `apps/web/src/components/import-project.ts` | In-browser (the user's own session) | Recursion depth cap; linear directive/keying/env scans (no quadratic paths); zip caps (32 MiB/entry, 128 MiB total, 5000 entries) + zip-slip path gates; YAML-injection-safe emit; escaped generated Typst | No total input-size cap on text converters — linear, slow-but-bounded (SEC-IMPORT-1) | None network-facing; this is client code |
| **Sync / WebSocket relay** | `apps/sync/src/` | **OFF** (ClusterIP, opt-in via Share; gated when `GALLEY_SYNC_AUTH=required`) | 8 MiB frame cap; `MAX_ROOMS`; awareness caps (per-frame ids / per-conn live ids / per-room `meta` count / per-frame state bytes), refuse-before-mutate + drop-on-apply-throw + a burst-safe drop latch (SEC-SYNC-3); auth-before-join; malformed-frame + ws-error tolerance (no process crash); per-conn message-rate cap; opt-in Origin allowlist; per-room Y.Doc isolation; **capability-room gate** (auth=required: reserved `share-…` rooms are admitted only when ACTIVE in the shared registry — registered by a signed-in user, not revoked, not expired; an unlisted-Origin browser is denied regardless, while an absent-Origin native client is admitted only for an active capability room — §2.1.1) | CRDT update bloat in a never-idle room (SEC-SYNC-1); no per-IP connection cap (SEC-SYNC-2); revocation does not kick live connections (SEC-CAP-1) | Keep ClusterIP; front with a gateway; set `GALLEY_SYNC_ALLOWED_ORIGINS`; require auth for closed rooms |
| **Web-server (static SPA)** | `apps/web-server/src/` | **Internet-facing** (the one public service) | Triple-layer path-traversal defense; breakout-proof `/config.js` (`JSON.stringify` + `<`/`>`/U+2028/9 escaping); OIDC guards (`safeReturnTo`, one-time state, PKCE/nonce, `__Host-` cookies); `headersTimeout`/`requestTimeout` (slow-loris); strict `DEFAULT_CSP` header + a matching baseline `<meta>` CSP in `index.html` (static-host fallback); compiled-preview SVG sanitized with DOMPurify before injection (SEC-PREVIEW-1) | In-process limits are defense-in-depth, not a gateway substitute | **Put a reverse proxy in front** (TLS, per-IP rate, request-size, conn-count) |
| **Model-API proxy** | `apps/proxy/src/` | **OFF / ClusterIP** (holds the key) | SSRF-proof by construction (named-upstream Map, never a client URL); client auth stripped, server key injected server-side; keys/bodies never logged; CORS allowlist; 16 MiB body cap (strict `Content-Length` pre-check → 400/413 + streaming counter); request timeouts; **optional `PROXY_ACCESS_TOKEN` bearer gate** — when set, `/forward/*` requires a matching `Authorization: Bearer` (constant-time) checked BEFORE the upstream key is injected, so an exposed deployment that forgets edge auth fails CLOSED (SEC-PROXY-1) | None user-reachable (no client-controlled URL ever reaches `fetch`); the bearer gate is opt-in defense-in-depth, NOT a substitute for edge auth | Keep ClusterIP — it custodies the model key; never expose directly. If exposed, wire edge auth AND set `PROXY_ACCESS_TOKEN` |
| **Compile + Universe registry** | `apps/compile/src/` | **OFF / ClusterIP**, opt-in | 8 MiB body + per-file/total/count caps → 413; WASM isolation + hard `terminate()` timeout; injection-proof registry URL build; link-local / cloud-metadata SSRF block (`isBlockedRegistryHost`); fail-closed integrity (`timingSafeEqual` sha256 + size); hardened ustar parser | DNS-rebind is out of the in-code layer (SEC-COMPILE-3); no absolute output-byte cap (SEC-COMPILE-1); no in-process concurrency cap (SEC-COMPILE-2) | Restrict egress with a **NetworkPolicy** (drop `169.254.169.254`); cap concurrency/resources at k8s; keep ClusterIP |
| **MCP mount (Agent Access)** | `apps/mcp/src/`, `apps/web/src/control-responder*.ts`, `apps/web/src/agent-content-consent.ts`, `packages/collab/src/control-mailbox.ts` | **OFF** (default-OFF pairing; file-content tools additionally OFF until a **per-project, session-scoped grant**; `open_project` consented per-request) | Pairing is explicit + default-off; **response authentication**: every responder answer is HMAC-SHA-256-signed with a per-session 256-bit key that travels ONLY in the out-of-band pairing command (never through any Y.Doc) — the kernel requires the key at startup, verifies with a timing-safe compare, and ignores unsigned/badly-signed responses, so a control-room peer can read/write the mailbox but cannot **forge** an answer the kernel acts on (anti-squatting: the responder overwrites forged records); the read-only file tools (`search_project`/`list_files`/`read_file`, plus mailbox-level `read_document`→main-file and a fail-closed `compile`) answer **only** for projects the user granted file access in Settings (grants browser-UI-mintable only; checked synchronously BEFORE any store IO; static `consent-required` refusal identical for known/unknown ids — no existence oracle; default zero grants, swept on construction and on Revoke); `open_project` is consented per request (blocking modal, request-liveness re-check, single-consent lock, auto-deny timeout); handoff self-validation (room shape, relay posture, safe paths); tool outputs registry-clamped + kernel-revalidated; mutating ops refused outright; **no responder text ever reaches the MCP client** (verified refusals map to local generic/consent lines); room ids scrubbed from logs | The control room is a **pure capability**: anyone holding the FULL pairing command (room + response key) is local-agent-equivalent for that session — granted projects' files are readable to them until Revoke; a room-capability-only peer can still deny service (flood/withdraw/overwrite), just not forge. Under `GALLEY_SYNC_AUTH=required` the capability is additionally **accounted** (#1 slice 2): the room must be REGISTERED by a signed-in user before the relay admits anyone (§2.1.1), and Revoke tombstones it server-side — but registration gates *creation*, not *possession*: within an active registration the room id (+ key) is still a bearer secret | Leave Agent Access off unless pairing a trusted local agent; grant file access per project, only while needed; never paste the pairing command anywhere shared; keep the kernel ClusterIP |
| **Auth (`@galley/auth`)** | `packages/auth/`, `apps/web-server/src/auth-router.ts` | OFF unless OIDC configured | OIDC Auth Code + PKCE, nonce, signature verify (alg-confusion rejected), one-time login state (replay → 400), `__Host-`/HttpOnly/Secure/SameSite cookies, fail-closed startup, generic errors (no stack/key/path leak); **capability-room routes** (#1 slice 2): strict same-origin `Origin` check on the mutating routes (a CSRF wall on top of SameSite=Lax), cookie-session auth, namespace-gated traversal-proof room ids, 4 KiB JSON-only bodies, per-user caps (≤128 active rooms, ≤8 control), tombstoned revocation (no resurrection within the 512-deep per-user FIFO tombstone retention; see §2.1.1), constant `{ok,code}` shapes (no enumeration/ownership oracle) | `/auth/logout` predates the Origin check (SEC-CAP-2); only in-memory + Fs session stores ship — a future DB store needs its own at-rest review (see `known-issues.md`) | Terminate TLS (Secure cookies require it); configure a generic OIDC provider (Auth Code + PKCE) behind the seam |

#### 2.1.1 Capability rooms under `GALLEY_SYNC_AUTH=required` (#1 slice 2)

Share rooms and Agent Access control rooms are minted in the browser as
unguessable `share-<CSPRNG>` ids — the id IS the capability. With sync auth
**off** (the default local mode) that is the whole story, unchanged. With
`GALLEY_SYNC_AUTH=required` the relay additionally requires every capability
room to be **registered and active**:

- **Registration** — the signed-in browser POSTs `/auth/capability-rooms`
  (cookie session + strict same-origin `Origin` check) BEFORE connecting or
  showing the link/pairing command. The server derives `createdBy`, timestamps
  and expiry itself (control rooms expire with the registering session; share
  rooms have no default expiry). The record lives on the shared
  `GALLEY_DATA_DIR` volume (`capability-rooms/<roomId>.json`), where the relay
  reads it — the same cross-container pattern as sessions.
- **Authorization at the upgrade, never per message** — the relay's order is:
  parse room → Origin policy (an absent Origin proceeds only for a capability
  room, preserving the cookie-less Node kernel; browsers always send Origin
  and face the exact allowlist) → reserved-namespace rooms must be ACTIVE in
  the registry (no cookie consulted; they never fall through to the membership
  gate, so an unregistered/revoked room is denied even with a valid session) →
  all other rooms keep the cookie→session→membership path unchanged → room
  cap + join.
- **The Origin allowlist is MANDATORY under `GALLEY_SYNC_AUTH=required`** —
  capability rooms carry no cookie, so the Origin wall is the only thing
  stopping a hostile page from driving a leaked room id out of a victim's
  browser (CSWSH). The relay REFUSES TO START when auth is required and
  `GALLEY_SYNC_ALLOWED_ORIGINS` is unset/empty, the same fail-closed posture as
  the missing session/data dirs. With auth off the allowlist stays opt-in,
  unchanged.
- **Revocation closes the door, not active sessions** — "Stop sharing" /
  Agent Access **Revoke** tombstone the record: future joins and reconnects are
  denied, but connections already inside a room persist until they disconnect
  (no live-kick channel; SEC-CAP-1). Registration-time GC never touches a
  tombstone; instead each user's tombstones are FIFO-capped at **512** (pruned
  on revoke, oldest first) so a register→revoke loop cannot exhaust the shared
  volume with permanent files. The trade-off is deliberate and bounded: pruning
  an ancient tombstone re-opens resurrection ONLY for that exact leaked id, and
  ONLY via an authenticated user deliberately re-registering it — the most
  recent 512 revocations are absolutely protected, and a revoked CONTROL room
  is moot anyway once its session expires.
- **No grandfathering** — turning sync auth on fail-closes every previously
  minted capability link until it is re-shared / re-enabled (the old rooms were
  never registered).

### 2.2 Why the public surface is small

A default `docker compose up` starts the **web, proxy, and sync** services (only
`compile` is profile-gated, behind `--profile compile`). What keeps the surface
small is not the profiles — it is that **every published port binds to
`127.0.0.1`**, so nothing is reachable off the host out of the box, and in a
cluster these services are meant to stay ClusterIP-only.

The web app is also standalone by construction: it compiles in an in-browser
worker against a local CRDT, and only talks to proxy/sync when a user opts in
(query params / settings). So a running stack exposes to the host: a static file
server that serves an in-root body or a 404, emits a breakout-proof `/config.js`,
and (when auth is enabled) an OIDC router with the guards in the table above —
plus the proxy and sync listeners, which are loopback-bound and, in sync's case,
have **no auth or persistence unless the auth seam is enabled**.

The security boundary is therefore the **network bind / gateway**, not service
selection: publishing any of these ports (changing the bind, or fronting them
without the checklist in §3) is an explicit, deliberate act.

### 2.3 Binary-blob disclosure: the servable-provenance boundary

Binary asset bytes never enter the CRDT and never persist server-side; in a
shared room they are pulled peer-to-peer over the `galley-blob-v1` byte channel,
with discovery riding the CRDT awareness channel (see
[`server-and-collaboration.md`](server-and-collaboration.md)). The relay is a
**blind byte forwarder** — it sees neither bytes, nor client-asserted roles, nor
any blob marker — so *which bytes a peer may disclose* is a purely client-side
trust decision. Getting that decision wrong is a confidentiality bug, so it has
its own boundary.

**The rule: a peer may serve a hash only if it is _servable_ on that device** —
it holds a durable, device-local `servable:<hash>` provenance marker **and** the
verified bytes are present. The marker is set **only** after a *trusted local
action lands*: a local upload/paste/drag-drop, a committed import/restore, or a
successful Accept — including a valid operator-armed auto-accept — of an agent/MCP
binary create (commit order is *persist neutral bytes → apply the local
pointer/Accept → then mark servable*, so a crash never opens a pre-commit
disclosure window).

**Why not "I reference this hash in my snapshot".** The project snapshot is
**peer-writable**: any room member can write a binary *pointer*. If serve
authority came from the snapshot, a hostile peer could write a pointer whose hash
equals a victim's **pending, not-yet-Accepted** imported blob and then "want" it —
and the victim would serve pre-Accept bytes it never chose to share. So the
requester's snapshot is used *only* to compute that peer's **own** demand (what
bytes it needs); it is structurally never fed to the holder's serve decision. The
two roles live behind separate pure planners precisely so requester state cannot
be reused as holder authority.

**Role honesty.** There is no server-enforced "can serve" role, and none is
claimed. The honest statement a serving peer makes is *"this device locally
authorized these bytes for room sharing"* — never *"the server authorized this
role to serve."* The relay cannot observe or enforce a client-asserted role, so
the trust decision stays entirely on the authorizing device.

**Non-transitive; legacy fails closed.** Bytes received over the channel are a
**neutral cache** — renderable/exportable locally but never re-servable (generic
`put()` never grants a marker), so a mere renderer is never turned into an
involuntary distributor and byte-receipt is never itself an authorization. The
cost is an honest online-only limitation: at least one *locally-authorized* holder
must stay online. Pre-existing/legacy blobs are **default-deny** — a marker is
never back-filled from a snapshot; such a blob becomes servable only after a new
qualifying local action. Serve work is bounded per `(peer, hash)` to two attempts,
and the want-list `requestId` carries no authorization or work-budget meaning (a
rotating `requestId` buys no extra transfers), closing a want-list amplification
vector.

---

## 3. Deployment hardening checklist

Apply these before exposing Galley on a network. The in-code defenses are
defense-in-depth; the **gateway and network layer are the authoritative boundary**.

- [ ] **Front the web-server with a reverse proxy** (nginx / cloud LB / ingress).
      Terminate TLS there. Apply per-IP **rate limits**, **connection-count caps**,
      and **request-size limits** at the gateway — the in-process timeouts and body
      caps degrade gracefully if directly exposed but are not a substitute.
- [ ] **Keep the proxy, compile, sync, and MCP services ClusterIP-only.** The proxy
      holds the model key; none of these should be internet-reachable. If a browser
      must reach the proxy/compile, route it through the same fronting gateway, not a
      public IP.
- [ ] **Restrict registry egress with a NetworkPolicy** if `REGISTRY_BASE_URL` is
      set. The in-code `isBlockedRegistryHost` guard blocks metadata/link-local IP
      *literals*, but a hostname that *resolves* to an internal address (DNS rebind /
      split-horizon) can only be caught at the network layer. Drop the route to
      `169.254.169.254` / cloud-metadata at the node, and allow egress only to the
      real registry host.
- [ ] **Set `GALLEY_SYNC_ALLOWED_ORIGINS`** if the sync relay is ever reachable by a
      browser without a fronting gateway, to prevent cross-site WebSocket hijacking
      (CSWSH). Set `GALLEY_SYNC_AUTH=required` for closed/membership-gated rooms —
      and note that under auth=required the allowlist is MANDATORY (the relay
      refuses to start without it; see §2.1.1).
- [ ] **Mount `GALLEY_DATA_DIR` into the web-server too when sync auth is required.**
      The capability-room registry (§2.1.1) is written by the web-server's
      `/auth/capability-rooms` routes and read by the relay from the SAME shared
      volume. Without it, Share links and Agent Access pairing fail closed under an
      auth-required relay (the web-server logs a loud startup warning). Remember:
      enabling sync auth fail-closes every PREVIOUSLY minted share/pairing link until
      it is re-shared / re-enabled — there is no grandfathering.
- [ ] **Enable OIDC for any multi-user or exposed deployment.** Use a generic OIDC
      provider (Auth Code + PKCE). Secure cookies require TLS, so HTTPS is mandatory
      for the auth path. Keep login state one-time and verify the `returnTo` redirect
      stays same-origin (the code already collapses off-origin `returnTo` to `/`).
- [ ] **Bound compile resources at the orchestrator** (k8s requests/limits + HPA, or
      an ingress concurrency cap / fronting queue). The hard compile timeout bounds
      wall-clock per compile; the output-byte cap and concurrency limit live at the
      infra layer (see §4).
- [ ] **Leave Agent Access (MCP mount) OFF** unless deliberately pairing a trusted
      local agent. Pairing is default-off, file access is a separate per-project,
      session-scoped grant (default zero), `open_project` is consented per
      request, and the kernel acts only on responses HMAC-signed with the
      per-session response key. Since B2 ([ADR-0026](./decisions/ADR-0026-mcp-durable-pairing.md))
      the pairing command carries only a **one-time pairing code** (10-min TTL, no
      secret in argv): the kernel runs an authenticated **ephemeral-ECDH** handshake
      (forward-secret — a recorded transcript + a later code leak cannot recover the
      key) to obtain the room+key and stores them durably (0600, integrity-MAC'd +
      shape-validated so a copied `pairing.json` fails on another host). Treat the
      code as bearer material for its window; once consumed/expired it is inert. Under
      `GALLEY_SYNC_AUTH=required`, Share/Agent Access capability rooms work only
      when REGISTERED by a signed-in user (§2.1.1): registration happens
      automatically on Share / Enable, revocation tombstones the room, and the
      cookie-less kernel is admitted solely through the active-registration gate.
- [ ] **Keep secrets out of client-visible config.** Provider keys live only in the
      proxy env; they are never sent to the client, never logged, and stripped from
      forwarded client requests.

---

## 4. Residual-risk disposition

The open residual risks and the reasoning behind each disposition are recorded in
[`known-issues.md`](./known-issues.md):

| Finding | Surface | Severity | Disposition |
|---------|---------|----------|-------------|
| **SEC-SYNC-1** — CRDT update bloat (busy never-idle room) | Sync relay | MED | **Accepted.** A real fix needs CRDT persistence + compaction (the relay holds no persistence today). Rate-bounded and reaped on empty. |
| **SEC-SYNC-2** — no per-IP / per-connection-count cap | Sync relay | LOW | **Infra.** A robust per-IP cap must account for the trusted-proxy XFF chain; the gateway is the right place when the relay is fronted (the default posture). |
| **SEC-SYNC-3** — awareness `meta`/state memory-DoS (distinct from SEC-SYNC-1) | Sync relay | MED | **Mitigated.** `state:null` ids that fire no `'update'` event used to grow `awareness.meta` unbounded across frames, bypassing the per-conn live-id cap. Now: a refuse-before-mutate pre-parse caps per-frame ids, per-frame state bytes, and the per-room `meta.size` ceiling (`maxAwarenessMetaPerRoom`, default 16384); a `dropped` latch makes termination burst-safe (async `terminate()` can't stop already-queued frames); and any `applyAwarenessUpdate` throw drops the peer (partial mutations are bounded by the caps). Per-room live-state memory is hard-bounded by `meta-ceiling × per-frame-state-cap` (≈ 256 MiB worst case, only with many concurrent authorized connections); a per-room live-state byte budget would tighten it further (deferred). |
| **SEC-COMPILE-1** — no absolute compile output-size cap | Compile | LOW | **Accepted.** Needs WASM-engine support to abort on an output-byte budget mid-render; post-hoc truncation would corrupt the artifact. The hard timeout bounds wall-clock. |
| **SEC-COMPILE-2** — unbounded /compile concurrency | Compile | LOW | **Mitigated.** A bounded in-flight cap (`maxConcurrentCompiles`, default 4, tunable via `GALLEY_COMPILE_MAX_CONCURRENCY`) now LOAD-SHEDS with `503 Retry-After` when full — a load-shed, not a queue, so no head-of-line blocking. An exposed endpoint should still sit behind a deployment-edge auth / rate-limit. |
| **SEC-COMPILE-3** — DNS rebinding past the registry host guard | Compile | LOW | **Infra.** The in-code guard blocks IP literals; resolving-hostname SSRF is covered by NetworkPolicy egress control (§3). |
| **SEC-IMPORT-1** — no total input-size cap on text converters | Import parser | INFO | **Accepted, low priority.** Converters are linear (slow-but-bounded, not a hang); the `.zip` path is byte-capped upstream. |
| **SEC-PREVIEW-1** — compiled SVG injected via `dangerouslySetInnerHTML` (latent XSS) | Web app (Preview) | MED | **Mitigated.** The SVG is our own typst render, but a *document* is attacker-controlled (a shared/imported doc can steer the renderer into an `<a xlink:href="javascript:…">` or hostile `<foreignObject>` content). Was safe only behind the web-server CSP; a plain static host sends none. Now the SVG is DOMPurify-sanitized (`apps/web/src/components/sanitize-svg.ts`) before injection — `<script>`, `on*` handlers and `javascript:` URIs are stripped while the SVG vocabulary, the text-bearing `<foreignObject>`, and `data:` binary-asset images survive — and `index.html` ships a baseline `<meta>` CSP mirroring `DEFAULT_CSP` so a CSP-less static host is still protected. Either control alone closes the hole. |
| **SEC-CAP-1** — revoking a capability room does not kick LIVE connections | Sync relay | LOW | **Accepted (by design, #1 slice 2).** Authorization is at the upgrade only; a live-kick needs a relay-side room-close channel keyed to registry state — a separate feature. Revocation denies all future joins/reconnects; control records also expire with their session. |
| **SEC-CAP-2** — `/auth/logout` predates the strict Origin check the capability routes use | Auth router | LOW | **Accepted, trivial follow-up.** `SameSite=Lax` already withholds the session cookie on cross-site POSTs; the worst case is a logout annoyance, not a state/credential compromise. Found in the #1 slice 2 session re-audit; align it with the capability routes' Origin wall in a hygiene pass. |
| **SEC-CSP-1** — `script-src 'unsafe-eval'` (whole-document) + `style-src 'unsafe-inline'` + wide `connect-src` | Web-server CSP | LOW/INFO | **Accepted (ADR-0017), documented.** `'unsafe-eval'` is REQUIRED by typst.ts 0.7's WASM init (string `eval`); `script-src` correctly omits `'unsafe-inline'`, which is the control that actually blocks injected-markup script — so there is no reachable injection sink today (config.js is `JSON.stringify`-escaped, the SPA renders no untrusted HTML, and the preview SVG is DOMPurify-sanitized per SEC-PREVIEW-1). Re-test dropping `'unsafe-eval'` (move the compiler to a Worker, or a typst.ts build needing no string eval) on each typst upgrade — `e2e/web-server-csp.spec.ts` already asserts the compiler renders under policy. `connect-src` can be narrowed to operator origins at deploy time via the templated `CSP` env override; `style-src 'unsafe-inline'` would need hashed/nonced inline styles to drop. |
| **SEC-PAT-1** — GitHub PAT + LLM apiKey persisted in `localStorage` plaintext | Web app (secrets-at-rest) | INFO | **Accepted by design (local-first).** The git-remote PAT and model apiKey are device-local: write-only to the UI (`redactedView`/`hasToken`), userinfo stripped from stored URLs, NEVER transmitted to any Galley server — shipping a token to a backend would be strictly worse. The residual is the standard `localStorage` threat model: any same-origin XSS, shared device, or malicious browser extension can read it. The real mitigation is the CSP/XSS posture (above + SEC-PREVIEW-1), not encryption-at-rest. Guidance: use fine-grained, least-privilege, short-lived PATs. |

The common thread: each is either a **substantial feature** (CRDT persistence, a
WASM output budget) or **better solved at the network/infra layer** (per-IP caps,
compile concurrency, egress control) than with an in-process control that would
duplicate infra and risk new failure modes. The §3 checklist is where those infra
controls live.

---

## 5. Reporting & maintenance

- Open limitations and accepted risks are tracked in
  [`known-issues.md`](./known-issues.md).
- CI security scanning (deps / secrets / SAST / image / SBOM) is documented in
  [`security-scanning.md`](./security-scanning.md).
- When this synthesis disagrees with `known-issues.md`, the latter (per-finding)
  wins, and this file should be reconciled to it.
