/**
 * Lane S — per-project git-remote configuration store (#4 / ADR-0018, UI side).
 *
 * Mirrors the PROVIDER_KEY localStorage pattern in `ProjectApp`: a tiny, typed,
 * fail-soft store keyed per project. It holds the {@link RemoteConfig} the UI's
 * Push/Fetch buttons feed to `HttpRemoteSync` — `{ url, ref?, auth?{token} }`.
 *
 * ## Security posture (this lane gets a security review)
 *  - The `auth.token` is stored EXACTLY like the provider `apiKey` already is —
 *    in `localStorage`, on this device only, never sent to any Galley server.
 *  - From the UI's perspective the token is WRITE-ONLY: {@link loadRemoteConfig}
 *    returns the full config for the network call, but {@link redactedView} (what
 *    the panel renders) NEVER carries the token — it exposes only whether one is
 *    set (`hasToken`). The panel renders `redactedView`, so no token reaches the
 *    DOM.
 *  - Clearing is first-class ({@link clearRemoteConfig}) so a user can wipe the
 *    secret from this browser.
 *
 * The storage is an INJECTABLE seam (defaults to `localStorage`) so the unit
 * tests drive an in-memory map with zero globals — no real browser storage.
 *
 * ## HIGH-1 (ADR-0019 security review): URL-embedded credentials are rejected
 *  - {@link saveRemoteConfig} REJECTS a URL carrying `user[:pass]@` userinfo (the
 *    panel shows "put credentials in the token field, not the URL") — a baked-in
 *    PAT would otherwise round-trip into the visible URL input on reopen, breaking
 *    the write-only-token invariant.
 *  - Every LOAD path also strips userinfo from the stored URL ({@link normalize}),
 *    so even a legacy / hand-poisoned stored value can never paint a credential to
 *    the DOM.
 */
import { redactUrl, urlHasUserinfo } from "@galley/persistence/browser";

/** Reach a remote: URL, optional short branch ref, optional write-only token. */
export interface RemoteConfig {
  url: string;
  ref?: string;
  auth?: { token: string };
}

/**
 * What the PANEL is allowed to see. Deliberately omits the token value: only a
 * boolean `hasToken`, so the secret can never be echoed back into the DOM. This
 * is the type the component renders from.
 */
export interface RedactedRemoteConfig {
  url: string;
  ref?: string;
  /** True iff a token is stored — the value itself is never exposed here. */
  hasToken: boolean;
}

/** Minimal Storage seam (the slice of `localStorage` we use); injectable for tests. */
export interface ConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Namespaced, versioned localStorage key prefix — one entry per project id. */
export const GIT_REMOTE_KEY_PREFIX = "galley.git-remote.v1";

/** The full storage key for a given project id. */
export function gitRemoteKey(projectId: string): string {
  return `${GIT_REMOTE_KEY_PREFIX}.${projectId}`;
}

/** Resolve the default storage (browser `localStorage`) or `null` when unavailable. */
function defaultStorage(): ConfigStorage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage as unknown as ConfigStorage;
    }
  } catch {
    // Accessing localStorage can throw (blocked / sandboxed) — treat as absent.
  }
  return null;
}

/**
 * Coerce arbitrary parsed JSON into a valid {@link RemoteConfig}, or `null`.
 * Defense in depth (HIGH-1): any `user[:pass]@` userinfo is STRIPPED from the URL
 * on load, so a legacy / hand-poisoned stored value can never carry a credential
 * into a render path — the credential-bearing URL never leaves this function.
 */
function normalize(raw: unknown): RemoteConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.url !== "string" || obj.url.length === 0) return null;
  const cleanUrl = urlHasUserinfo(obj.url) ? redactUrl(obj.url) : obj.url;
  const cfg: RemoteConfig = { url: cleanUrl };
  if (typeof obj.ref === "string" && obj.ref.trim().length > 0) cfg.ref = obj.ref;
  const auth = obj.auth;
  if (
    typeof auth === "object" &&
    auth !== null &&
    typeof (auth as Record<string, unknown>).token === "string" &&
    ((auth as Record<string, unknown>).token as string).length > 0
  ) {
    cfg.auth = { token: (auth as { token: string }).token };
  }
  return cfg;
}

/**
 * Load the full config (INCLUDING the token) for a project — used to build the
 * `RemoteConfig` handed to `HttpRemoteSync` for a network call. Returns `null`
 * when nothing is stored / storage is unavailable / the stored value is malformed.
 *
 * This is the ONLY accessor that surfaces the token; UI code that renders to the
 * screen must use {@link loadRedactedConfig} instead.
 */
export function loadRemoteConfig(
  projectId: string,
  storage: ConfigStorage | null = defaultStorage(),
): RemoteConfig | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(gitRemoteKey(projectId));
    return raw ? normalize(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Project a full config to the token-free view the panel may render. The URL is
 * userinfo-stripped (HIGH-1 defense in depth) so no credential can ride the URL
 * into the DOM, even if a caller hands a config that bypassed {@link normalize}.
 */
export function redactedView(config: RemoteConfig): RedactedRemoteConfig {
  const url = urlHasUserinfo(config.url) ? redactUrl(config.url) : config.url;
  const view: RedactedRemoteConfig = { url, hasToken: !!config.auth?.token };
  if (config.ref !== undefined) view.ref = config.ref;
  return view;
}

/**
 * Load the panel-safe (token-free) view of a project's config, or `null`. The
 * component renders from this, so the secret never reaches the DOM.
 */
export function loadRedactedConfig(
  projectId: string,
  storage: ConfigStorage | null = defaultStorage(),
): RedactedRemoteConfig | null {
  const cfg = loadRemoteConfig(projectId, storage);
  return cfg ? redactedView(cfg) : null;
}

/** Outcome of {@link saveRemoteConfig}: `ok`, or a user-facing validation `error`. */
export interface SaveResult {
  ok: boolean;
  error?: string;
}

/**
 * Persist a project's config.
 *  - A URL carrying `user[:pass]@` userinfo is REJECTED with a validation error
 *    (HIGH-1) — credentials go in the token field, not the URL.
 *  - A blank/whitespace token PRESERVES any already-stored token (REC-4): only a
 *    non-blank token overwrites it; {@link clearRemoteConfig} is the explicit way
 *    to remove a stored token. A first save with a blank token simply stores none.
 *  - A blank url is rejected (no-op result). Best-effort persist: a storage
 *    failure surfaces as `{ ok:false }` rather than throwing.
 */
export function saveRemoteConfig(
  projectId: string,
  input: { url: string; ref?: string; token?: string },
  storage: ConfigStorage | null = defaultStorage(),
): SaveResult {
  if (!storage) return { ok: false, error: "Storage is unavailable in this browser." };
  const url = input.url.trim();
  if (url.length === 0) return { ok: false, error: "Enter a remote URL." };
  if (urlHasUserinfo(url)) {
    return {
      ok: false,
      error: "Put your access token in the token field, not the URL.",
    };
  }
  const cfg: RemoteConfig = { url };
  const ref = input.ref?.trim();
  if (ref) cfg.ref = ref;
  const token = input.token?.trim();
  if (token) {
    cfg.auth = { token };
  } else {
    // Blank token → keep whatever is already stored for this project (REC-4).
    const existing = loadRemoteConfig(projectId, storage);
    if (existing?.auth?.token) cfg.auth = { token: existing.auth.token };
  }
  try {
    storage.setItem(gitRemoteKey(projectId), JSON.stringify(cfg));
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save in this browser." };
  }
}

/** Remove a project's stored config entirely (the user wiping the secret). */
export function clearRemoteConfig(
  projectId: string,
  storage: ConfigStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(gitRemoteKey(projectId));
  } catch {
    // Best-effort.
  }
}
