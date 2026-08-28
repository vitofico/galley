# ADR-0026 — MCP durable, revocable kernel pairing (one-time code handshake)

- **Status:** Accepted. **Extends** [ADR-0021](./ADR-0021-mcp-library-ops.md)
  (control room + control mailbox), [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md)
  (per-session `responseKey`, per-grant proposal signing) and
  [ADR-0024](./ADR-0024-mcp-workflow-honest-liveness.md). Does **not** supersede
  them — the joined-control-room machinery (HMAC response auth, proposal signing,
  consent gates) is unchanged; only the **origin** of the kernel's room+key moves.
- **Scope:** roadmap #16 (MCP), item B2.

## Context

Before B2 the operator copied a pairing command that baked the long-lived secret
straight into argv:

```
galley-mcp --sync <url> --control-room <room> --response-key <base64url-32B>
```

The 256-bit `responseKey` (which both signs/verifies every control response and
derives every per-grant proposal key) therefore rode in:

- shell history (`~/.zsh_history`, `~/.bash_history`),
- process listings (`ps`, `/proc`),
- any logging that captures launch commands.

A leaked command = a leaked session authority until Revoke. It also had to be
**re-pasted after every re-enable**, because nothing was stored.

## Decision

Replace the baked secret with a short-lived, one-time **pairing CODE**. The
operator pastes only:

```
galley-mcp --sync <url> --pairing-code <code>
```

The kernel runs a **handshake** to OBTAIN the room+key — the code never enters
any mailbox message — and stores the result durably so re-runs need no re-paste.

### 1. The handshake (code never on the wire; FORWARD SECRECY via ephemeral ECDH)

The pure crypto lives in `packages/collab/src/pairing-bootstrap.ts` (framework-
agnostic, WebCrypto; the kernel and the browser run byte-identical derivations).
The handshake is **authenticated ephemeral ECDH (P-256)** — the code AUTHENTICATES
the exchange, while ephemeral keys provide forward secrecy.

1. The browser `enable()` mints a 16-byte CSPRNG code → ~22-char base64url, with
   a **10-minute TTL** and **one-time** use.
2. From the code — and ONLY the code — both sides derive, via **HKDF-SHA-256**
   with domain-separated `info` labels, three values WITHOUT transmitting the
   code: (a) an unguessable **pairing room** id (minted in the `share-` capability
   namespace, see §5), (b) a bootstrap **MAC key**, (c) a 32-byte **code SECRET**.
   These are public one-way derivatives of the code; the MAC key ≠ the code secret.
3. EACH side mints an **EPHEMERAL ECDH (P-256)** keypair (private key
   non-extractable, **discarded** after the handshake). The kernel joins the pairing
   room and publishes — **under its own pre-minted CSPRNG request id** — a **claim**
   `{ ephPub, nonce (32B), claimMac = HMAC(macKey, "kernel" ‖ ephPub ‖ nonce ‖ requestId) }`.
   The claimMac is **proof** it knows the code that **authenticates** its ephemeral
   public key + the nonce + the mailbox request id — NOT the code itself.
4. The browser **verifies** `claimMac` (constant-time) over the **actual mailbox
   `request.id`** **BEFORE** it consumes the code, mints its OWN ephemeral keypair,
   computes `sealKey = HKDF( ECDH(browserEph, kernelEphPub) ‖ codeSecret ; salt=nonce )`,
   **seals** `{syncUrl, controlRoom, responseKey}` with **AES-256-GCM** (AAD =
   `{nonce, request.id, pairingRoom}`), and replies with
   `{ browserEphPub, browserClaimMac = HMAC(macKey, "browser" ‖ browserEphPub ‖ nonce ‖ requestId), sealed }`.
   (Signed plaintext is NOT acceptable — the `responseKey` is **encrypted**.) The
   code is now consumed (one-time); the browser discards its ephemeral private key.
5. The kernel **verifies the browser's claim** (direction-separated, so a kernel
   claim can never be reflected as a browser claim), computes the SAME `sealKey` via
   `ECDH(kernelEph, browserEphPub) ‖ codeSecret`, **opens** the seal, validates the
   shape (`controlRoom` is a capability id; `responseKey` decodes to exactly 32
   bytes, ≠ any derived key, not all-zero), and **discards its ephemeral private key**.

**FORWARD SECRECY (the v2 property):** the seal key requires an **ephemeral private
key** (discarded on both sides), so an attacker who RECORDS the whole pairing-room
transcript (both ephemeral *public* keys + the sealed envelope) AND LATER LEAKS the
code cannot recover the `responseKey` — it lacks an ephemeral private key, so it
cannot recompute the ECDH shared secret, so it cannot derive the seal key. (v1
derived the seal key from the code alone, so a recorded transcript + a later code
leak decrypted the responseKey; v2 closes that.)

**ID-REPLAY DEFENSE:** the `claimMac` binds the mailbox `request.id`, and the
browser verifies it against the **actual map key** (never a peer-supplied param), so
a pairing-room peer who copies a captured claim onto a SECOND request id fails the
MAC — it can no longer make the browser consume the one-time code under a foreign id.
(`publishControlRequest` gained an optional caller-supplied id so the kernel can bind
the id into the MAC before publishing.)

Result: the code never enters a readable message; a room peer who reaches the
pairing room has neither the code (so cannot derive the keys) nor an ephemeral
private key (so cannot derive the seal key) — confidentiality holds even against a
recording relay plus a later code leak.

### 2. The kernel secret at rest (`apps/mcp/src/pairing-store.ts`)

- Stored at `${XDG_STATE_HOME:-$HOME/.local/state}/galley/kernel/pairing.json`,
  env override `GALLEY_MCP_PAIRING_FILE`. Directory mode **0700**, file mode
  **0600**.
- Content: `{ controlRoom, responseKey(base64url), pairedAt, mac(base64url) }`.
- The MAC is a **local integrity check** (copy/tamper detection, NOT
  confidentiality): a separate 32-byte **local integrity key** is generated once
  at the state root (file mode 0600), and the pairing MAC =
  `HMAC-SHA-256(HKDF(localKey, "pairing-store"), canonical(pairing))`. Copying
  **only** `pairing.json` to another machine (whose local key differs) FAILS the
  MAC.
- **Fail-closed + SHAPE-VALIDATED:** a missing / unreadable / malformed /
  wrong-shape / MAC-mismatch file loads as `null`. BOTH save and load additionally
  enforce the pairing SHAPE — `controlRoom` is a capability room id AND
  `responseKey` decodes to exactly 32 non-zero bytes — so even a MAC-verified blob
  (e.g. a future bug, or a same-host attacker who also stole `integrity.key`) cannot
  smuggle a non-capability room or a bad key onto the join path. On load the file +
  dir modes are re-asserted (0600 / 0700) as defense-in-depth.
- Persists **only** the control pairing (controlRoom + responseKey) — never a
  project shareRoom / grantId as reusable kernel authority.

### 3. Resolution order (`apps/mcp/src/{config,main}.ts`)

`--pairing-code` (+ `GALLEY_MCP_PAIRING_CODE`) is added. The legacy
`--control-room`/`--response-key` keeps working (CI/manual) — **memory-only,
NEVER persisted**. **Precedence is prefer-fresh (F6 road-test fix):** a
freshly-pasted `--pairing-code` ALWAYS wins. If legacy room/key are also present
(flags OR lingering env), the parser **DROPS them and attaches a loud non-secret
warning** (emitted to stderr at startup) rather than failing loud or letting
stale env silently override the operator's explicit intent. Startup resolves the
authority in order:

1. **`--pairing-code`** (if given) — try a MAC-verified durable pairing first (no
   re-handshake), else run the handshake, then `savePairing()`. Any legacy room/key
   present alongside it are ignored with a warning.
2. else **legacy args** — ephemeral override, never persisted.
3. else a **MAC-verified durable pairing**.
4. else an honest error.

Rationale: the legacy path bakes a long-lived secret into argv/shell-history (the
very thing B2 retired); when an operator deliberately pastes a one-time code,
honoring the stale legacy creds (often left in a shell profile) would silently
re-expose the secret and defeat the re-pair. A present-but-MALFORMED
`--pairing-code` still fails loud (it is not a silent fall-back to legacy).

The obtained room+key flow into the EXISTING `joinControlRoom` (its HMAC-verify +
proposal-signing logic is unchanged — only the key's origin changes).

### 4. Browser responder + UI

`apps/web/src/control-responder-mount.ts` `enable()` mints the code, derives the
pairing room + keys, joins it, and on a valid claim runs the browser ECDH leg —
seals + responds + consumes the code (one-time, 10-min TTL, claim-verified-before-
consume) and discards its ephemeral private key. A **resume** (reload) does NOT mint
a new code (the kernel re-runs from its durable store). The Agent Access UI shows
`galley-mcp --sync … --pairing-code <CODE>` (no secret) with "expires in 10 minutes"
copy and a copy button.

### 5. The pairing room is a capability room (auth-required deployments)

The transient pairing room is minted in the **`share-` capability namespace** (a
`share-<hex>` HKDF derivative), so the relay's capability gate + the cookie-less
**absent-Origin carve-out** apply unchanged under `GALLEY_SYNC_AUTH=required` — the
Node kernel can join it. Under auth-on the browser (the signed-in party) REGISTERS
the pairing room as a session-bounded `control`-kind capability BEFORE the kernel
joins, and best-effort REVOKES it on code-consume / TTL / teardown. It carries no
durable authority — it is a bootstrap channel only, torn down within ≤10 min.

### 6. A `persistentAccess` grant is a revocable HEADLESS-attach authority (F13, amended 2026-06-20)

The pairing above re-binds the **foreground** tab. F13 lets a paired agent keep
applying proposals for a project even when that project is **not the active editor
document** (or no Galley tab has it open), as long as **some** Galley tab is open
and the human granted standing access **once**.

- **The capability.** The MAC-covered `persistentAccess: true` flag on the
  ADR-0023 grant (`apps/web/src/proposal-grant.ts`) is, by itself, a **standing,
  revocable WRITE capability**: it authorises an in-tab background host to
  re-attach the already-consented share for *exactly* that project (exact-scope
  MAC, cross-project isolation) and auto-apply under the **unchanged** invariant
  set (checkpoint-before-apply, started-tombstone replay guard, volume cap,
  checkpoint-fail-closed pause, single-applier Web-Lock keyed by `grantId`, no
  kernel/server-side apply — authority stays in the browser origin). It is
  **default-OFF / opt-in per project**, set via the Agent-access settings toggle
  (a deliberate human click, re-MAC'd like `setGrantMode`), and it carries content
  (file-read) access for the same project so the host can materialise the doc.
- **Idle TTL.** Because the flag is XSS-readable like the rest of the grant, a
  forgotten standing grant is bounded by a **7-day idle TTL**
  (`HEADLESS_ACCESS_IDLE_TTL_MS`). The host stamps `lastActiveAt` on every
  successful headless apply (`headless-access-stamp.ts`, a non-MAC'd per-grant
  integer — it can only ever *shorten* the window, so it need not be signed) and
  attaches only while `!headlessAccessExpired(lastActiveAt ?? grantedAt, now)`.
  An expired grant **degrades to manual**: the host does not attach and the human
  re-consents (the full foreground modal) to resume.
- **Revoke (define).** A one-click **Revoke** in the Agent-access settings zeroes
  the grant + the content grant + the tombstone audit, **detaches the worker and
  leaves the room**, deletes the `lastActiveAt` stamp, and **bumps the persist
  epoch** so a racing arm cannot resurrect it (mirrors `clearActiveGrant` /
  `disable`). Revoking the whole Agent Access session revokes every standing grant
  too. As in §"v1 cuts", a paired kernel still holding a stored pairing keeps
  working only until it next cannot reach a live responder — but with the worker
  detached and the grant cleared, no further auto-apply happens in this origin.

## v1 cuts (deliberately NOT built)

- **AES-at-rest / OS keychain** for the durable file — v1 is 0600 + MAC + shape
  validation. The file perms are the confidentiality boundary; the MAC is the
  tamper/copy boundary. (Forward secrecy is NOT cut — it is built, see §1.)
- **Relay live-kick / browser revocation broadcast** — Revoke (disable) clears the
  responseKey/session/grant/verifier/audit locally; that IS the v1 revocation. A
  paired kernel still holding a stored pairing keeps working until the next time it
  cannot reach a live responder (every response fails the HMAC / times out).
- **Delete-on-bad-signature** — a bad claim is refused, the code is NOT consumed
  and the session is NOT torn down (a bad-sig-delete would let a peer force-unpair).
- QR/device pairing, multi-kernel, argv-history migration.

## Threat model (residuals)

- **A leaked pairing CODE** is bearer material for its 10-minute, one-time window.
  Once consumed (or expired) it is inert. Crucially, with forward secrecy a code
  leak does NOT retroactively decrypt a previously-recorded handshake — so a leaked
  code after the fact cannot recover the `responseKey` of an already-completed
  pairing. A strict improvement over the old long-lived `responseKey` in argv.
- **A leaked durable `pairing.json` alone** does not pair another machine (the
  local integrity key, never copied, fails the MAC). A leak of `pairing.json` +
  `integrity.key` together (both 0600 in the same dir) is equivalent to a leaked
  `responseKey` — conceded; the v1 boundary is the file permissions.
- **A peer in the derived pairing room** can flood/deny but cannot derive the keys
  (no code), cannot forge or replay a claim onto a new id (the MAC binds the id),
  and cannot derive the seal key (no ephemeral private key) — it cannot obtain the
  room/key.
- **A recording relay + a later code leak** cannot recover the `responseKey`
  (forward secrecy via discarded ephemeral ECDH keys).
- The control room itself remains a pure capability (ADR-0021/0023): anyone who
  obtains the room + responseKey is local-agent-equivalent for that session.
