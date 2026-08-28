/**
 * Share/Connect helpers (roadmap #14-C) — pure, framework-free, so they unit-test
 * in the Node gate (no jsdom). These let the project shell open a collaborative
 * session WITHOUT the user hand-editing the URL: derive the sync-server URL,
 * mint an unguessable room, and build the link a collaborator opens to join.
 *
 * Collaboration stays an EXPLICIT user action — nothing here runs unless the user
 * clicks Share. The default boot never touches a sync server.
 */

/** The fixed port the `apps/sync` relay listens on (mirrors apps/sync/server.ts). */
export const SYNC_PORT = 1234;

/** A `Location`-like shape (only the fields we read) so this is testable offline. */
export interface LocationLike {
  protocol: string;
  hostname: string;
}

/**
 * Resolve the sync-server WebSocket URL. A build-time override
 * (`VITE_GALLEY_SYNC_URL`) wins; otherwise derive it from the page's own origin —
 * the sync relay is co-located with the web app in the self-host profile, so
 * `ws(s)://<this host>:1234` is the right default and also matches the e2e
 * (preview on :4173, sync on :1234). `wss:` is chosen on a secure page so a
 * mixed-content block can't silently break Share.
 *
 * @param override an explicit ws/wss URL (e.g. `import.meta.env.VITE_GALLEY_SYNC_URL`)
 * @param loc      the page location (origin to co-locate the relay against)
 */
export function resolveSyncUrl(override: string | undefined, loc: LocationLike): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed.replace(/\/+$/, "");
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  // IPv6 literals must keep their brackets in a URL authority.
  const host = loc.hostname.includes(":") ? `[${loc.hostname}]` : loc.hostname;
  return `${scheme}://${host}:${SYNC_PORT}`;
}

/**
 * Read the serve-time sync URL out of the `window.__GALLEY_CONFIG__` global
 * (injected by apps/web-server's same-origin /config.js when the operator sets
 * `GALLEY_SYNC_URL`). DEFENSIVE: anything but a non-empty string in the expected
 * slot is treated as absent. This only EXTRACTS the value — `resolveSyncUrl`
 * still trims it, and the share path validates the `wss?://` scheme before use.
 * Mirrors compiler-assets.ts's `runtimeConfigUrl` for the compile URL. Pure.
 */
export function runtimeSyncUrl(
  config: unknown = (globalThis as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__,
): string | null {
  if (typeof config !== "object" || config === null) return null;
  const url = (config as { syncUrl?: unknown }).syncUrl;
  return typeof url === "string" && url.trim() !== "" ? url : null;
}

/**
 * The effective sync-URL OVERRIDE for this deploy, with the SAME precedence as
 * the compile URL (runtime config wins over build-time env): the serve-time
 * `window.__GALLEY_CONFIG__.syncUrl` (set per-deploy, so a single shared image
 * needn't bake a deployment-specific relay URL) beats the build-time
 * `VITE_GALLEY_SYNC_URL`. Both absent → `undefined`, so `resolveSyncUrl` derives
 * `ws(s)://<page host>:1234` exactly as before. `buildEnvUrl` is injectable so
 * the Node gate exercises the precedence offline.
 */
export function configuredSyncUrlOverride(
  buildEnvUrl: string | undefined = import.meta.env.VITE_GALLEY_SYNC_URL,
): string | undefined {
  return runtimeSyncUrl() ?? buildEnvUrl ?? undefined;
}

/**
 * Mint a fresh, unguessable room id for a share. We deliberately do NOT reuse the
 * stable local project id: sync rooms are open/unauthenticated until #14-E, so the
 * room id is the ONLY capability gating access — it must be hard to guess, and a
 * private project id must never leak into a shareable URL.
 *
 * Because the id IS the access capability, it must come from a CSPRNG. We never
 * fall back to `Math.random()` (predictable); if no secure source exists we fail
 * closed (the caller surfaces a notice) rather than mint a guessable room.
 */
export function mintShareRoom(): string {
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (a: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (c && typeof c.randomUUID === "function") return `share-${c.randomUUID()}`;
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `share-${hex}`;
  }
  throw new Error("share: a secure random source (crypto) is required to mint a room id");
}

/**
 * Mint a fresh, unguessable per-grant `grantId` for the #16 auto-accept
 * provenance handoff (ADR-0023 §1): `open_project` mints one at consent and the
 * kernel binds every proposal signature to it, so a kernel that still holds the
 * session `responseKey` but not the CURRENT `grantId` cannot sign for a future
 * grant (it closes the stale-signer attack). The id is bound into the per-grant
 * HKDF key derivation, so — like a share room — it MUST come from a CSPRNG.
 *
 * 16 random bytes → base64url (charset `[A-Za-z0-9_-]`, no padding), MIRRORING
 * {@link mintShareRoom}'s crypto pattern: `crypto.getRandomValues` is the
 * source, and we FAIL CLOSED (no `Math.random` fallback — a predictable grant
 * id is worse than none) when no secure source exists. We use the byte path
 * (not `randomUUID`) so the value is a compact 22-char base64url token within
 * the grant's bounded charset on both the responder and kernel side.
 */
export function mintGrantId(): string {
  const c = (
    globalThis as {
      crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    let out = "";
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]!;
      const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
      const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
      out += A[b0 >> 2]!;
      out += A[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
      if (b1 !== undefined) out += A[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
      if (b2 !== undefined) out += A[b2 & 0x3f]!;
    }
    return out;
  }
  throw new Error("share: a secure random source (crypto) is required to mint a grant id");
}

/**
 * A share grants one of two access levels (B19-sharing-roles). `editor` is the
 * full read+write capability; `viewer` is read-only — the joiner sees the whole
 * project but every mutating UI path is gated off. A join URL must EXPLICITLY ask
 * for `editor` (`?role=editor`) to grant write — an absent/forged role fails
 * closed to `viewer` (see {@link parseShareRole}). Server enforcement (and a
 * fully read-only editor binding) is a later slice; this slice carries the role
 * on the link + presence and gates the client UI fail-closed.
 */
export type ShareRole = "viewer" | "editor";

/**
 * The access level granted to the LOCAL project owner — the peer who owns the
 * project and is NOT joining through an untrusted share URL. The owner is always
 * a full editor (they own the doc). This default applies ONLY to the local-owner
 * / host-minting paths; it is deliberately NOT the fallback for a role decoded
 * from a join URL (see {@link parseShareRole}, which fails closed to `viewer`).
 */
export const DEFAULT_SHARE_ROLE: ShareRole = "editor";

/**
 * Narrow an arbitrary string (an UNTRUSTED join-URL query value) to a
 * {@link ShareRole}, FAILING CLOSED to the least-privilege `viewer` for anything
 * that is not EXPLICITLY one of the two literal roles. A forged/unknown/empty
 * value (`?role=owner`, `?role=bogus`, `?role=`) and an absent role all resolve
 * to `viewer` — a join link can only ever GRANT edit when it explicitly carries
 * `role=editor`, never by omission. (Fail-open here was a privilege-escalation
 * hole: a link with no role, or a forged one, used to boot the recipient as an
 * editor.) The local project owner does NOT route through this parser — their
 * editor session is sourced from {@link DEFAULT_SHARE_ROLE} directly — so this
 * least-privilege default never downgrades the owner's own session.
 */
export function parseShareRole(value: string | null | undefined): ShareRole {
  return value === "editor" || value === "viewer" ? value : "viewer";
}

/**
 * Decide THIS session's effective access level (B19-sharing-roles).
 *
 * The CONNECTION is the source of truth for the role. A solo/local session (no
 * live connection) is always the project owner → full {@link DEFAULT_SHARE_ROLE}
 * editor. Once a connection exists, the role the connection was ESTABLISHED with
 * decides: the host's live Share upgrade always connects as `editor`, while a
 * joiner's connection carries the role decoded from THEIR join link. Only when
 * the connection somehow carries no role do we fall back to the (already
 * fail-closed) `?role=` parse, then to `viewer` as the least-privilege default.
 *
 * This fixes the regression where merely HAVING a connection (the owner clicking
 * Share) was conflated with "joined via a link": the owner's own `/p/<id>` URL
 * has no `?role=`, so the URL-only path failed closed to `viewer` and rendered
 * the owner read-only until a reload dropped the connection.
 *
 * @param connected      whether a live connection exists for this session.
 * @param connectionRole the role the live connection was established with (the
 *                       host is `editor`; a joiner is their link's decoded role).
 * @param urlRole        the fail-closed `?role=` parse, used only when the
 *                       connection carries no role (legacy/path-based joins).
 */
export function resolveSessionRole(
  connected: boolean,
  connectionRole: ShareRole | undefined,
  urlRole: ShareRole | undefined,
): ShareRole {
  if (!connected) return DEFAULT_SHARE_ROLE;
  return connectionRole ?? urlRole ?? "viewer";
}

/**
 * Build the link a collaborator opens to JOIN the session (#19.4, spec §5):
 * a clean `/join/<room>` path. The joiner's own boot derives the sync URL from
 * ITS origin (same `resolveSyncUrl` derivation/build-time override as the
 * sharer, and the link shares the sharer's origin), so the link carries no
 * `?sync=` by default. Pass `syncOverride` only for a NON-default relay — it
 * rides along as `?sync=` and survives the join path (and the legacy
 * `?project=1&collab=1&room=…&sync=…` redirect preserves an explicit override
 * the same way).
 *
 * `role` (B19-sharing-roles) rides along as `?role=<role>`. BOTH roles are now
 * encoded EXPLICITLY: since {@link parseShareRole} fails closed to `viewer` for
 * any absent/unknown role, an editor invite MUST carry `role=editor` or the
 * recipient would (correctly, least-privilege) be downgraded to a viewer. An
 * omitted `role` (when the caller passes none) means "use the historical
 * everyone-edits share with no explicit role" — those links resolve to `viewer`
 * on join, the fail-closed default; pass `role="editor"` to grant edit.
 *
 * Old query-param share links keep working via `legacyRedirect` (router.ts).
 */
export function buildShareLink(room: string, syncOverride?: string, role?: ShareRole): string {
  const path = `/join/${encodeURIComponent(room)}`;
  const params = new URLSearchParams();
  if (syncOverride) params.set("sync", syncOverride);
  // Encode the role EXPLICITLY when given — an editor link must say `role=editor`
  // because the join-side parser fails closed to `viewer` on an absent role.
  if (role) params.set("role", role);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Recover the room id from a share link built by {@link buildShareLink} —
 * relative (`/join/<room>?…`) or absolute (`https://host/join/<room>`). The
 * inverse the Share popover needs to look up the room's registration state
 * (#1 slice 2) without new plumbing through the host shell. Null for anything
 * that isn't a `/join/` link (the popover then renders exactly as before).
 */
export function roomFromShareLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const match = /\/join\/([^/?#]+)/.exec(link);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null; // malformed percent-encoding — not a link we minted
  }
}
