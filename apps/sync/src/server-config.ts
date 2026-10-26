/**
 * Pure startup-config decision for the sync server, split out so it is unit
 * testable without binding a socket. See `server.ts` for the entrypoint.
 *
 * Authorization (default OFF — rooms are open, the no-auth collab path):
 *   - `GALLEY_SYNC_AUTH=required`  — gate the ws upgrade on session + membership.
 *   - `GALLEY_SESSION_DIR`         — the shared session volume (minted by web-server).
 *   - `GALLEY_DATA_DIR`            — the projects volume (FsProjectStore membership).
 *   - `GALLEY_INSECURE_COOKIES=1`  — match web-server's cookie name in dev.
 *
 * Origin allowlist (default OFF — #22.2 S2, CSWSH defense), INDEPENDENT of auth and
 * mirroring how `apps/compile` parses `ALLOWED_ORIGINS`:
 *   - `GALLEY_SYNC_ALLOWED_ORIGINS` — comma-separated exact Origins permitted to
 *     open a ws upgrade. Unset/empty → no Origin check (behavior unchanged). When
 *     set, an upgrade with an absent or unlisted Origin is rejected (close 1008)
 *     before the room join. Applies whether or not auth is required.
 *
 * CRDT persistence (default OFF — B1.3, roadmap S2), INDEPENDENT of auth:
 *   - `GALLEY_SYNC_PERSIST_DIR` — a durable volume for the relay's CRDT update
 *     log. Unset/blank → the relay stays stateless across restarts (behavior
 *     unchanged). When set, an `FsCrdtStore` rooted there makes every room's doc
 *     state survive crash/restart: loaded on room create, appended per update,
 *     compacted on reap/shutdown.
 *
 * FAIL CLOSED: all three pieces must agree across containers via mounted volumes.
 * When auth is required but the durable, SHARED `GALLEY_SESSION_DIR` (and/or the
 * `GALLEY_DATA_DIR`) is missing, we THROW rather than silently use an in-memory
 * store. An in-memory session store in this process can never see the sessions the
 * web-server minted in its own process, so it would authorize nobody while
 * reporting healthy — an "enforcing" server that actually enforces nothing. A loud
 * crash on misconfig is the safe outcome.
 */
import type { SyncServerOptions, StorageQuota } from "./sync-server.js";
import {
  FsCrdtStore,
  FsHostedStorage,
  FsSessionStore,
  FsProjectStore,
  FsCapabilityRoomRegistry,
  FsGroupStore,
  projectOrGroupMembershipAuthorizer,
} from "@galley/persistence";
import {
  authorizeSyncUpgrade,
  authorizeCapabilityRoomUpgrade,
  createAccountResourcePolicyReader,
} from "@galley/auth";
import { isCapabilityRoomId } from "@galley/shared";
import { readFileSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { compactUpdates } from "@galley/collab";
import { AggregateStorageQuota } from "./aggregate-storage-quota.js";

export type SyncEnv = Record<string, string | undefined>;

/**
 * Strict enum parse of `GALLEY_SYNC_AUTH`. Fail closed on a typo: an unrecognized
 * non-empty value (e.g. `"requireed"`, `"on"`, `"1"`) THROWS rather than silently
 * selecting the open path — a malformed toggle must never disable enforcement.
 * Trimmed + lowercased, so `"Required "` resolves to `"required"`.
 */
export function isSyncAuthRequired(env: SyncEnv = process.env): boolean {
  const raw = env.GALLEY_SYNC_AUTH?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "off") return false; // open rooms (default, unchanged)
  if (raw === "required") return true;
  throw new Error(
    `GALLEY_SYNC_AUTH has an unrecognized value. Refusing to start: accepted values are ` +
      `"required" (gate the ws upgrade) or "off"/unset (open rooms). A typo must never ` +
      `silently leave rooms open.`,
  );
}

/**
 * Parse `GALLEY_SYNC_ALLOWED_ORIGINS` exactly like compile's `ALLOWED_ORIGINS`:
 * comma-split, trimmed, blanks dropped. Empty → no Origin check (default).
 */
export function parseAllowedOrigins(env: SyncEnv = process.env): string[] {
  return (env.GALLEY_SYNC_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a byte-count env var into a positive safe integer, or `undefined` when
 * unset/blank. THROWS on an invalid value rather than falling through — a silent
 * fallthrough on a typo would hide a misconfigured cap (mirrors
 * `parseMaxConcurrentCompiles`: a clean positive integer only, failing loud).
 */
export function parseStorageBytesEnv(
  env: SyncEnv,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (bytes); got "${raw}"`);
  }
  return n;
}

/**
 * Flat per-deployment storage caps for self-hosters (B2), INDEPENDENT of auth and
 * persistence wiring. All unset ⇒ no `storageQuota` ⇒ byte-for-byte stateless
 * accounting-off behavior. When any is set, `getCaps` trivially returns the flat
 * `maxContentBytes` for every room (per-room caps are a cloud concern; the
 * self-hosted knob is one number). Caps only bite on PERSISTED rooms.
 *   - `GALLEY_SYNC_MAX_CONTENT_BYTES` — per-room CRDT content cap.
 *   - `GALLEY_SYNC_MAX_LOG_BYTES`     — flat raw append-log hard ceiling.
 *   - `GALLEY_SYNC_COMPACT_FLOOR_BYTES` — compaction high-water floor (default 16 MiB).
 */
export function buildStorageOptions(
  env: SyncEnv = process.env,
): SyncServerOptions {
  const maxContentBytes = parseStorageBytesEnv(
    env,
    "GALLEY_SYNC_MAX_CONTENT_BYTES",
  );
  const maxLogBytes = parseStorageBytesEnv(env, "GALLEY_SYNC_MAX_LOG_BYTES");
  const compactionFloorBytes = parseStorageBytesEnv(
    env,
    "GALLEY_SYNC_COMPACT_FLOOR_BYTES",
  );
  if (
    maxContentBytes === undefined &&
    maxLogBytes === undefined &&
    compactionFloorBytes === undefined
  ) {
    return {};
  }
  const storageQuota: StorageQuota = {
    // Present the key only when a cap is set (exactOptionalPropertyTypes): an
    // absent `maxContentBytes` means unlimited content, log ceiling still applies.
    getCaps: async () =>
      maxContentBytes !== undefined ? { maxContentBytes } : {},
    ...(maxLogBytes !== undefined ? { maxLogBytes } : {}),
    ...(compactionFloorBytes !== undefined ? { compactionFloorBytes } : {}),
  };
  return { storageQuota };
}

export function buildSyncOptions(
  env: SyncEnv = process.env,
): SyncServerOptions {
  for (const dir of [
    env.GALLEY_DATA_DIR,
    env.GALLEY_SESSION_DIR,
    env.GALLEY_SYNC_PERSIST_DIR,
  ])
    if (dir && existsSync(join(dir, "RESTORE-QUARANTINE.json")))
      throw new Error(
        "Restored data requires lifecycle reconciliation before serving",
      );
  const allowedOrigins = parseAllowedOrigins(env);
  // Only attach the key when non-empty so the default config stays byte-for-byte
  // `{}` (the open, unchanged path) — an empty allowlist is the OFF state anyway.
  const originOpt: SyncServerOptions =
    allowedOrigins.length > 0 ? { allowedOrigins } : {};

  // CRDT persistence (B1.3), independent of auth. Constructing FsCrdtStore does
  // no IO, so a bad path surfaces on first use, not here — matching how the
  // session/project stores behave. Unset/blank → key absent, stateless relay.
  const persistDir = env.GALLEY_SYNC_PERSIST_DIR?.trim();
  let persistOpt: SyncServerOptions = persistDir
    ? { crdtStore: new FsCrdtStore(persistDir) }
    : {};

  // Storage caps (B2), independent of auth. Unset ⇒ `{}` so the default config
  // stays byte-for-byte `{}` (accounting off).
  let storageOpt = buildStorageOptions(env);
  const policyUrl = env.GALLEY_STORAGE_POLICY_URL?.trim();
  if (policyUrl) {
    const target = new URL(policyUrl);
    const keyFile = env.GALLEY_STORAGE_POLICY_KEY_FILE?.trim();
    if (
      !["https:", "http:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !keyFile ||
      !persistDir ||
      !env.GALLEY_DATA_DIR ||
      !isSyncAuthRequired(env)
    )
      throw new Error(
        "Storage policy requires service URL, key, persistent data and required auth",
      );
    const info = lstatSync(keyFile);
    const key = readFileSync(keyFile);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      key.byteLength !== 32
    )
      throw new Error("Storage policy key must be a private 32-byte file");
    const flat = storageOpt.storageQuota;
    const perRoomContent = parseStorageBytesEnv(
      env,
      "GALLEY_SYNC_MAX_CONTENT_BYTES",
    );
    const quota = new AggregateStorageQuota({
      ...(perRoomContent !== undefined
        ? { maxContentBytes: perRoomContent }
        : {}),
      ...(flat?.maxLogBytes !== undefined
        ? { maxLogBytes: flat.maxLogBytes }
        : {}),
      ...(flat?.compactionFloorBytes !== undefined
        ? { compactionFloorBytes: flat.compactionFloorBytes }
        : {}),
      dataDir: env.GALLEY_DATA_DIR,
      persistDir,
      policy: createAccountResourcePolicyReader({
        url: target.toString(),
        key,
      }),
    });
    storageOpt = { storageQuota: quota };
  }
  const hostedRaw = env.GALLEY_SYNC_HOSTED_BLOBS?.trim();
  if (hostedRaw && hostedRaw !== "0" && hostedRaw !== "1")
    throw new Error("GALLEY_SYNC_HOSTED_BLOBS must be 0 or 1");
  if (hostedRaw === "1") {
    if (
      !persistDir ||
      !policyUrl ||
      !allowedOrigins.length ||
      !isSyncAuthRequired(env)
    )
      throw new Error(
        "Hosted assets require persistent aggregate policy, required auth and exact Origins",
      );
    const maxVersions =
      parseStorageBytesEnv(env, "GALLEY_SYNC_HISTORY_MAX_VERSIONS") ?? 20;
    const days = parseStorageBytesEnv(env, "GALLEY_SYNC_HISTORY_DAYS") ?? 30;
    if (maxVersions > 1000 || days > 365)
      throw new Error("Hosted history retention exceeds safety ceiling");
    const hostedStorage = new FsHostedStorage(
      persistDir,
      storageOpt.storageQuota as AggregateStorageQuota,
      { maxVersions, maxAgeMs: days * 86400000 },
    );
    const store = persistOpt.crdtStore!;
    persistOpt = {
      hostedStorage,
      revalidateConnections: true,
      crdtStore: {
        appendUpdate: (room, bytes) => store.appendUpdate(room, bytes),
        loadUpdates: (room) => store.loadUpdates(room),
        flush: (room) => store.flush!(room),
        retire: (room) => store.retire!(room),
        compact: async (room) => {
          await store.compact(room);
          const updates = await store.loadUpdates(room);
          if (updates.length) {
            // History is optional: exhausted budget must not break durable live writes.
            await hostedStorage
              .checkpoint(room, compactUpdates(updates))
              .catch(() => undefined);
          }
        },
      },
    };
  }
  const durableRaw = env.GALLEY_SYNC_DURABLE_DELIVERY?.trim();
  if (durableRaw && durableRaw !== "0" && durableRaw !== "1")
    throw new Error("GALLEY_SYNC_DURABLE_DELIVERY must be 0 or 1");
  if (durableRaw === "1") {
    if (!persistOpt.crdtStore?.flush)
      throw new Error("Durable delivery requires persistent flush support");
    persistOpt = { ...persistOpt, durableDelivery: true };
  }
  const keyPath = env.GALLEY_ACCOUNT_LIFECYCLE_KEY_FILE?.trim();
  let lifecycleOpt: SyncServerOptions = {};
  if (keyPath) {
    const info = lstatSync(keyPath);
    const key = readFileSync(keyPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      key.byteLength !== 32 ||
      !persistDir ||
      !isSyncAuthRequired(env)
    )
      throw new Error(
        "Lifecycle requires a private 32-byte key, persistence and required auth",
      );
    lifecycleOpt = { lifecycleKey: key, revalidateConnections: true };
  }

  if (!isSyncAuthRequired(env))
    return { ...originOpt, ...persistOpt, ...storageOpt }; // open rooms (default, unchanged)

  const sessionDir = env.GALLEY_SESSION_DIR?.trim();
  const dataDir = env.GALLEY_DATA_DIR?.trim();
  // Fail closed: an enforcing relay with no shared session dir can NEVER validate
  // a web-minted session (separate process → separate in-memory store). Refuse.
  if (!sessionDir) {
    throw new Error(
      "GALLEY_SYNC_AUTH=required but GALLEY_SESSION_DIR is unset. Refusing to start: " +
        "without a durable, shared session volume the sync relay cannot validate " +
        "sessions minted by the web-server (it would authorize no one while reporting " +
        "healthy). Mount the same session dir into both containers and set GALLEY_SESSION_DIR.",
    );
  }
  if (!dataDir) {
    throw new Error(
      "GALLEY_SYNC_AUTH=required but GALLEY_DATA_DIR is unset. Refusing to start: " +
        "membership (project access) cannot be checked without the shared projects volume.",
    );
  }
  // Fail closed (#1 slice 2 security round, HIGH-1): an enforcing relay MUST
  // have an Origin allowlist. Capability rooms are authorized WITHOUT a cookie
  // (the room id is the capability), so the Origin wall is what stops a hostile
  // page (evil.example) from silently driving a leaked room id from a victim's
  // browser. The carve-out for ABSENT Origins (the cookie-less Node kernel)
  // stays — but a PRESENT, unlisted Origin must always be deniable, which
  // requires a configured allowlist. An auth-required relay without one is a
  // misconfiguration; refuse to start rather than run half-enforcing.
  if (allowedOrigins.length === 0) {
    throw new Error(
      "GALLEY_SYNC_AUTH=required but GALLEY_SYNC_ALLOWED_ORIGINS is unset/empty. " +
        "Refusing to start: capability rooms (Share / Agent Access) are authorized by " +
        "room registration, not cookies, so without an Origin allowlist any web page " +
        "could drive a leaked room id from a visitor's browser (CSWSH). Set " +
        "GALLEY_SYNC_ALLOWED_ORIGINS to the exact browser origin(s) of your deployment " +
        "(e.g. https://galley.example.com). Auth-off relays are unaffected.",
    );
  }

  const sessionStore = new FsSessionStore(sessionDir, undefined, dataDir);
  const authorizer = projectOrGroupMembershipAuthorizer(
    new FsProjectStore(dataDir),
    new FsGroupStore(dataDir),
  );
  const cookieName =
    env.GALLEY_INSECURE_COOKIES === "1" ? "galley.sid" : "__Host-galley.sid";
  // Capability rooms (#1 slice 2): the durable registry lives on the SAME shared
  // data volume membership uses — the web-server registers (cookie-authenticated
  // POST), this relay reads. Reserved-namespace rooms are authorized by an active
  // registry record (no cookie); every other room keeps the session+membership
  // gate below, unchanged.
  const capabilityRegistry = new FsCapabilityRoomRegistry(dataDir);
  return {
    ...originOpt,
    ...persistOpt,
    ...storageOpt,
    ...lifecycleOpt,
    capabilityRooms: {
      isCapabilityRoom: isCapabilityRoomId,
      authorize: async (room) => {
        const record = await capabilityRegistry.get(room);
        if (record && (await sessionStore.isUserClosed(record.createdBy)))
          return false;
        return authorizeCapabilityRoomUpgrade({
          room,
          registry: capabilityRegistry,
          nowMs: Date.now(),
        });
      },
    },
    authorizeUpgrade: ({ room, req }) =>
      authorizeSyncUpgrade({
        cookieHeader: req.headers.cookie,
        room,
        sessionStore,
        authorizer,
        nowMs: Date.now(),
        cookieName,
      }),
  };
}
