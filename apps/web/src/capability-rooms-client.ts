/**
 * Browser client for the capability-room registry (#1 slice 2) — the
 * registration/revocation calls Share and Agent Access make against
 * `POST /auth/capability-rooms` when the deployment runs with auth on.
 *
 * AUTH-OFF EQUIVALENCE: every entry point is gated on
 * {@link capabilityAuthActive} (the served runtime-config `auth: true` flag,
 * the same authority the boot gate trusts — never a probe). With auth off —
 * the default local mode — NOTHING here performs any network call, and the
 * registration tracker stays empty, so Share/Agent Access behave byte-for-byte
 * as before.
 *
 * Pure of React and the DOM (injectable fetch, `globalThis` config read), so
 * the Node unit gate exercises everything offline. The tiny module-scope
 * tracker exists so the REGISTRATION INITIATOR (`connectProjectSession` — the
 * host's Share upgrade) and the REGISTRATION OBSERVER (the Share popover,
 * which must hold the link back until success and surface failures) can share
 * one source of truth without threading state through the frozen ProjectApp.
 */
import { isAuthEnabled } from "./auth-gate.js";

/** The room kinds the registry accepts (mirrors `@galley/shared`). */
export type CapabilityRoomKind = "share" | "control";

export type RegisterCapabilityRoomResult =
  | { ok: true }
  | { ok: false; error: string };

/** The minimal fetch surface (same shape as auth-gate's `AuthFetch`). */
export type CapabilityFetch = (
  input: string,
  init?: {
    method?: string;
    credentials?: "same-origin";
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Bound every registry call (verification round, LOW): a never-settling fetch
 * would otherwise wedge whatever awaits it — most critically the open_project
 * handoff gate inside the responder drain. 15s is generous for a same-origin
 * JSON POST; an abort maps to the existing generic failure (fail closed).
 */
export const CAPABILITY_FETCH_TIMEOUT_MS = 15_000;

/** `AbortSignal.timeout` where available, else a manual controller; undefined when neither exists. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const signalCtor = (
    globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignal } }
  ).AbortSignal;
  if (signalCtor && typeof signalCtor.timeout === "function") return signalCtor.timeout(ms);
  const controllerCtor = (globalThis as { AbortController?: new () => AbortController })
    .AbortController;
  if (!controllerCtor) return undefined; // exotic runtime — degrade to no timeout
  const controller = new controllerCtor();
  const timer = setTimeout(() => controller.abort(), ms);
  // Don't let the timer hold a Node process open (no-op in browsers).
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

/**
 * Whether this deployment runs with auth ON — strictly the served runtime
 * config's literal `auth: true` (absent global / wrong type → OFF, the safe
 * default that keeps the local mode untouched).
 */
export function capabilityAuthActive(
  config: unknown = (globalThis as { __GALLEY_CONFIG__?: unknown })
    .__GALLEY_CONFIG__,
): boolean {
  return isAuthEnabled(config);
}

/** User-facing failure copy, keyed off the server's constant error codes. */
const ERROR_NOT_SIGNED_IN =
  "You're not signed in — this deployment requires sign-in before sharing. Sign in and try again.";
const ERROR_CAP =
  "You have too many active shares or agent sessions on this server — stop sharing (or revoke) one and try again.";
const ERROR_GENERIC =
  "The server could not register this share. Try again, or contact the operator if it persists.";

/**
 * Register one capability room with the server (cookie-authenticated,
 * same-origin). Resolves `{ok:false, error}` — never throws — with copy the
 * UI can show verbatim. MUST be awaited to SUCCESS before the capability is
 * used (connect / link shown / pairing command shown): the relay refuses
 * unregistered rooms, and a failed registration must never leak a dead link.
 */
export async function registerCapabilityRoom(
  roomId: string,
  kind: CapabilityRoomKind,
  opts: { projectId?: string; fetchImpl?: CapabilityFetch; timeoutMs?: number } = {},
): Promise<RegisterCapabilityRoomResult> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as CapabilityFetch);
  try {
    const signal = timeoutSignal(opts.timeoutMs ?? CAPABILITY_FETCH_TIMEOUT_MS);
    const res = await fetchImpl("/auth/capability-rooms", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId,
        kind,
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (res.ok) return { ok: true };
    let code: string | undefined;
    try {
      code = ((await res.json()) as { code?: string }).code;
    } catch {
      // non-JSON failure body — fall through to status mapping
    }
    if (res.status === 401 || code === "unauthenticated")
      return { ok: false, error: ERROR_NOT_SIGNED_IN };
    if (res.status === 409 || code === "cap-exceeded")
      return { ok: false, error: ERROR_CAP };
    return { ok: false, error: ERROR_GENERIC };
  } catch {
    return { ok: false, error: ERROR_GENERIC };
  }
}

/**
 * Revoke a capability room, BEST-EFFORT: revocation closes the door server-side
 * (future joins/reconnects), but the local teardown ("Stop sharing" / Agent
 * Access Revoke) must proceed regardless of whether this call lands — so it
 * never throws and callers never await it on the teardown path.
 */
export async function revokeCapabilityRoomBestEffort(
  roomId: string,
  fetchImpl: CapabilityFetch = fetch as unknown as CapabilityFetch,
  timeoutMs: number = CAPABILITY_FETCH_TIMEOUT_MS,
): Promise<void> {
  try {
    const signal = timeoutSignal(timeoutMs);
    await fetchImpl(
      `/auth/capability-rooms/${encodeURIComponent(roomId)}/revoke`,
      {
        method: "POST",
        credentials: "same-origin",
        ...(signal !== undefined ? { signal } : {}),
      },
    );
  } catch {
    // best-effort (incl. timeout/abort): the server may be unreachable or
    // wedged; local teardown already won either way
  }
}

// ---- The share-registration tracker -----------------------------------------
// One memoized registration per room id, observable by the UI. Only the HOST
// path writes to it (ensureShareRoomRegistered, called from the Share
// upgrade); a joiner's popover sees `null` (untracked) and renders unchanged.

export type ShareRegistrationStatus =
  | { status: "pending" }
  | { status: "ok" }
  | { status: "error"; error: string };

const tracked = new Map<string, ShareRegistrationStatus>();
const inflight = new Map<string, Promise<RegisterCapabilityRoomResult>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to tracker changes (the Share popover re-render hook). */
export function subscribeShareRegistrations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The tracked registration state for a room, or null when this tab never
 * initiated one (a joiner, or an auth-off run — both render today's UI).
 */
export function peekShareRegistration(
  roomId: string,
): ShareRegistrationStatus | null {
  return tracked.get(roomId) ?? null;
}

/**
 * Idempotently register a SHARE room (the host path). Memoized per room id: the
 * Share upgrade initiates it, the popover may call it again to read the same
 * promise — only ONE network call happens per room (the server is idempotent
 * anyway). With auth OFF this resolves `{ok:true}` immediately and records
 * NOTHING (zero registry calls — the tracker stays empty).
 */
export function ensureShareRoomRegistered(
  roomId: string,
  opts: { projectId?: string; fetchImpl?: CapabilityFetch; timeoutMs?: number } = {},
): Promise<RegisterCapabilityRoomResult> {
  if (!capabilityAuthActive()) return Promise.resolve({ ok: true });
  const existing = inflight.get(roomId);
  if (existing !== undefined) return existing;
  tracked.set(roomId, { status: "pending" });
  emit();
  const promise = registerCapabilityRoom(roomId, "share", opts).then(
    (result) => {
      tracked.set(
        roomId,
        result.ok ? { status: "ok" } : { status: "error", error: result.error },
      );
      if (!result.ok) inflight.delete(roomId); // a later explicit retry may re-attempt
      emit();
      return result;
    },
  );
  inflight.set(roomId, promise);
  return promise;
}

/**
 * The agent-handoff registration gate (#1 slice 2 security round, M2): the
 * `open_project` handoff must NEVER hand the kernel a room the relay will
 * refuse — under auth the room is only a usable capability once REGISTERED.
 * Awaits the (memoized) share registration and maps failure to a STATIC
 * refusal (the kernel-facing string carries no server error detail; the Share
 * popover shows the precise error via the tracker). Auth OFF resolves ok
 * immediately with zero registry calls, exactly like the underlying ensure.
 */
export async function shareRegistrationHandoffGate(
  roomId: string,
): Promise<{ ok: true } | { ok: false; refused: string }> {
  const result = await ensureShareRoomRegistered(roomId);
  if (result.ok) return { ok: true };
  // No "sharing is unavailable:" prefix — ProjectApp's onShare wraps refusals
  // in exactly that copy, and the kernel-facing refusal reads fine bare.
  return { ok: false, refused: "the share room could not be registered with the server" };
}

/** Test-only: drop all tracked registrations (module-scope state). */
export function __resetCapabilityRoomsClientForTests(): void {
  tracked.clear();
  inflight.clear();
  listeners.clear();
}
