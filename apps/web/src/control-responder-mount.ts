/**
 * The Agent Access RESPONDER MOUNT (roadmap #16.3 responder-mount slice,
 * ADR-0021) — the module-scope SINGLETON that wires the pure responder core
 * ({@link answerControlRequest}, control-responder.ts) to the live browser:
 * the control-room join, the IndexedDB-backed seams, and the drain/prune loop
 * that mirrors the reference responder (apps/mcp/src/fake-control-responder.ts).
 *
 * SECURITY POSTURE — DEFAULT-OFF, fail-closed, PERSISTENT across reload/restart:
 *   - A fresh manager with NO persisted session is fully INERT: it mints no room,
 *     joins no relay, observes no mailbox, and answers no RPC. The shipped bundle
 *     is behaviorally unchanged until the user explicitly enables Agent Access in
 *     /settings.
 *   - `enable()` mints a control room (a CSPRNG `share-<random>` via
 *     {@link mintShareRoom}), resolves the relay, joins the control room as a
 *     peer, builds the live seams, starts the loop, and PERSISTS the capability
 *     (room id + the response-auth key) to the localStorage-backed store.
 *   - RESUME (operator decision — reverses the original "dies with the tab" H3
 *     posture): on construction the singleton READS that persisted blob and, when
 *     it is valid, re-joins the SAME room with the SAME key instead of wiping it,
 *     so Agent Access SURVIVES A RELOAD (and, while the store lives, a tab-close /
 *     browser restart). It is wiped only by Revoke, by a malformed/absent blob, or
 *     (auth-on) a failed re-registration. The capability now lives in
 *     localStorage, not just memory — treat the store as sensitive (an XSS or
 *     same-origin script can read it until Revoke).
 *   - `disable()` (Revoke) stops the observer, disconnects + destroys the
 *     control doc, clears pending state. The next `enable()` mints a FRESH room —
 *     a revoked capability never comes back.
 *   - RESPONSE AUTHENTICATION (HIGH-1): `enable()` also mints a per-session
 *     256-bit response-auth key (CSPRNG, fail-closed) that lives ONLY in this
 *     manager's memory and the pairing command — never in any Y.Doc. EVERY
 *     response this responder publishes is HMAC-SHA-256-signed with it, and the
 *     control-mode kernel REJECTS unsigned/badly-signed responses: a peer that
 *     merely holds the room capability can read the mailbox but cannot forge an
 *     answer the kernel acts on. Publishing uses the mailbox's `overwrite`
 *     privilege and the drain reads `includeAnswered`, so a forged response
 *     squatting a request can neither silence this responder nor block the
 *     authentic verdict. Revoke zeroes the key; re-enable mints a fresh one.
 *   - FIRST-SLICE SCOPE: `open_project` is DEFERRED by design (it needs
 *     per-request consent + ProjectApp share-upgrade state owned by another
 *     lane). The drain loop PRE-FILTERS it and answers an explicit `ok:false`
 *     refusal BEFORE the core's open path is ever reached — so this slice can
 *     never mint a project share room or open a project. `list_projects` /
 *     `list_versions` (metadata only) go through the pure core unchanged.
 *   - READ-ONLY TOOL OPS (#1 slice 1): the registry's read-only tools
 *     (search_project / list_files / read_file / read_document / compile) are
 *     additionally routed through the pure adapter (control-tool-adapter.ts) —
 *     but ONLY behind a HARD per-project CONTENT-CONSENT gate
 *     (agent-content-consent.ts): a tool request whose projectId the user has
 *     not explicitly granted file access (Settings → Agent Access, per-project,
 *     session-scoped, default ZERO grants) is answered with a STATIC
 *     `consent-required` refusal BEFORE any project store is touched — the
 *     refusal is identical for existing and non-existing projects, so the
 *     pre-consent surface leaks nothing beyond what list_projects already
 *     reveals. Grants can ONLY be minted by the settings UI; no mailbox
 *     request shape can create one, and the grant set never rides into the
 *     mailbox doc. Seams are resolved PER REQUEST against the request's
 *     projectId (membership-checked, read from the persisted local store), so
 *     a revoke takes effect on the very next request. Mutating tools
 *     (propose_edit) are refused by the adapter's access filter, full stop.
 *
 * IDEMPOTENCY: `enable()` is a no-op when already enabled (React StrictMode
 * double-invoke, route changes, a second user click) — one responder per control
 * room per tab. The singleton holds at most one live link at a time.
 *
 * TESTABILITY: every side effect is INJECTED via {@link ControlResponderMountDeps}
 * so the unit gate (Node, no relay/IndexedDB/DOM) runs fully offline. The
 * production singleton ({@link getControlResponderManager} with no deps) wires the
 * real browser implementations lazily.
 */
import {
  answerControlRequest,
  answerVersionFileRequest,
  versionFileOps,
  answerExportCompiledRequest,
  exportCompiledOps,
  answerCompileRequest,
  compileOps,
  answerExpectBlobRequest,
  expectBlobOps,
  answerReleaseBlobRequest,
  releaseBlobOps,
  answerRestoreVersionRequest,
  restoreVersionOps,
  type ProjectMeta,
  type VersionMeta,
  type VersionFile,
  type RestoreFile,
  type RestoreVersionSeams,
  type OpenedProject,
  type OpenProjectRefusal,
  type ExportedCompiled,
  type ExportCompiledSeam,
  type CompileSeam,
  type CompileDiagnostics,
  type ExpectBlobSeam,
  type ReleaseBlobSeam,
} from "./control-responder.js";
import type { FileProposalOp } from "@galley/collab";
import { answerReadonlyToolRequest, readonlyToolOps } from "./control-tool-adapter.js";
import {
  grantContentAccess,
  isContentGranted,
  revokeAllContentGrants,
} from "./agent-content-consent.js";
import { buildProjectToolsSeam } from "./agent-project-tools.js";
import { materializeProjectTreeFromIdb } from "./git-sync-ops.js";
import { isReservedProjectPath, isCapabilityRoomId } from "@galley/shared";
import type { ToolSeams } from "@galley/agent";
import {
  publishControlResponse,
  readControlRequests,
  observeControlRequests,
  pruneControlMailbox,
  controlResponseSigningString,
  hmacControlResponse,
  bytesToBase64Url,
  base64UrlToBytes,
  deriveProposalKey,
  verifyProposal,
  buildBlobTerminalAuth,
  mintPairingCode,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  verifyClaimMac,
  computeClaimMac,
  sealPairingPayload,
  PAIRING_EPH_PUBLIC_BYTES,
  CONTROL_LIMITS,
  CONTROL_RESPONSE_KEY_BYTES,
  CollabDocument,
  CollabConnection,
  WebSocketTransport,
  type DocHost,
  type ControlRequest,
  type ControlResponseInput,
  type WebSocketLike,
  type ProposalScope,
  type SignableProposal,
  type BlobTerminalSigner,
  type BlobTerminalVerifier,
} from "@galley/collab";
import {
  macGrant,
  parseGrant,
  serializeGrant,
  grantAuthorizesHeadlessAttach,
  type ProposalGrant,
} from "./proposal-grant.js";
import { readHeadlessStamp, clearHeadlessStamp } from "./headless-access-stamp.js";
import type { Author } from "@galley/shared";
import { mintShareRoom, resolveSyncUrl, configuredSyncUrlOverride } from "./share.js";
import {
  capabilityAuthActive,
  registerCapabilityRoom,
  revokeCapabilityRoomBestEffort,
  type RegisterCapabilityRoomResult,
} from "./capability-rooms-client.js";
import { loadLocalProfile } from "./local-profile.js";
import { IdbProjectStore } from "./idb-project-store.js";
import { IdbVersionStore } from "./idb-version-store.js";
import { createLibraryProject } from "./create-library-project.js";
import { AutoAcceptAudit, auditStorageKey } from "./auto-accept-audit.js";

/** The browser identity the responder writes its answers under. */
const RESPONDER_AUTHOR: Author = { kind: "human", userId: "agent-access-responder" };

/**
 * Storage key for the PERSISTED Agent Access session (room id + response-auth
 * key), in the localStorage-backed store so it survives reload/restart. Written
 * by `enable()`, read on construction to RESUME, removed by Revoke / a malformed
 * blob / a failed auth-on re-registration.
 */
export const AGENT_ACCESS_SESSION_KEY = "galley.agentAccess.session";

/**
 * Storage key for the PERSISTED, MAC'd agent GRANT (ADR-0023 §4) — the
 * already-consented `open_project` share coordinates that re-bind the project
 * room after a reload, sibling of {@link AGENT_ACCESS_SESSION_KEY}. Written by
 * {@link ControlResponderManager.recordGrant}, re-loaded on RESUME by re-parsing
 * the blob with the resumed `responseKey` (dropped if its MAC fails), cleared on
 * Revoke/disable so a revoked capability's grant never returns.
 */
export const AGENT_ACCESS_GRANT_KEY = "galley.agentAccess.grant";

/**
 * The persisted Agent Access session blob. Only the room id and the response-auth
 * key (base64url) are stored; the relay URL is re-resolved on resume (so a moved
 * relay is picked up) and grants persist independently under their own key.
 */
export interface PersistedAgentAccessSession {
  controlRoom: string;
  /** base64url of the 32-byte response-auth key. */
  responseKey: string;
}

/**
 * Parse + VALIDATE the persisted session blob, fail-closed to null on anything
 * off (absent, unreadable, unparsable, wrong shape, a non-`share-` room id, or a
 * response key that does not base64url-decode to exactly
 * {@link CONTROL_RESPONSE_KEY_BYTES} bytes). A garbage blob can therefore only
 * ever mean "no resume", never a weak/forged session.
 */
export function readPersistedAgentAccessSession(
  store: SessionStoreLike | null,
): { controlRoom: string; responseKey: Uint8Array } | null {
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(AGENT_ACCESS_SESSION_KEY);
  } catch {
    return null; // storage access can throw (privacy mode) — no resume
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed blob — no resume, never a throw
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { controlRoom, responseKey } = parsed as Record<string, unknown>;
  if (!isCapabilityRoomId(controlRoom)) return null;
  if (typeof responseKey !== "string") return null;
  const key = base64UrlToBytes(responseKey);
  if (key === null || key.length !== CONTROL_RESPONSE_KEY_BYTES) return null;
  return { controlRoom, responseKey: key };
}

/** Best-effort persist of the session blob (room + base64url key); never throws. */
function writePersistedAgentAccessSession(
  store: SessionStoreLike | null,
  controlRoom: string,
  responseKeyB64: string,
): void {
  if (store === null) return;
  try {
    const blob: PersistedAgentAccessSession = { controlRoom, responseKey: responseKeyB64 };
    store.setItem(AGENT_ACCESS_SESSION_KEY, JSON.stringify(blob));
  } catch {
    // best-effort: a failed write just means no resume next load (fail-closed)
  }
}

/**
 * The refusal returned by the open seam when NO live ProjectApp handler is
 * registered (no project is open in the tab). Static — never peer-derived.
 *
 * (The old `OPEN_PROJECT_REFUSAL` pre-filter is gone: open_project now flows to
 * the ProjectApp consent handler. This is the only static open-path refusal the
 * mount itself can emit; every other refusal originates in the handler.)
 */
export const NO_OPEN_HANDLER_REFUSAL = "no project is open to share with the agent";

/**
 * The STATIC, typed refusal a tool op gets when its projectId has no content
 * grant (#1 slice 1). The `consent-required` prefix is the machine-readable
 * marker the kernel maps to a friendly "go grant it" message. Deliberately
 * GENERIC: the same string for unknown and existing projects (no existence
 * oracle beyond list_projects), no project name, no file data, no grant list.
 */
export const CONTENT_CONSENT_REQUIRED_ERROR =
  "consent-required: file access for this project has not been granted in this " +
  "browser session — in Galley, open Settings → Agent Access and click " +
  "“Allow file access (this session)” for the project, then retry";

/** The refusal for a tool op missing its mandatory projectId param. Static. */
export const TOOL_PROJECT_ID_REQUIRED_ERROR =
  "this tool requires a 'projectId' parameter (use list_projects to find it)";

/** The generic tool failure (unknown project after a grant, store error, …). Static. */
export const TOOL_FAILED_ERROR = "the tool could not complete this request";

/**
 * A project's files as the read-only tool seams consume them: VISIBLE files
 * only (the reserved `.galley/*` config namespace excluded — the same set the
 * file tree shows), canonical leading-slash paths, plus the main-file path for
 * `read_document`.
 */
export interface ProjectToolFiles {
  files: { path: string; text: string }[];
  /** Canonical (leading-slash) main-file path, or null when unset. */
  mainPath: string | null;
}

/**
 * The live `open_project` handler ProjectApp registers (#16.3). It runs the
 * per-request consent + share-upgrade and resolves to the handoff coordinates,
 * a structured `{refused}`, or `null` (unknown project — ProjectApp does not use
 * null today, but the type matches the seam so the core's null→"unknown project"
 * mapping stays available).
 *
 * `isRequestLive` (SEC-16.3a) is the mount-supplied, REQUEST-SCOPED liveness
 * probe: TRUE while the originating control request is still present in the
 * mailbox (i.e. the kernel has not withdrawn it). Consent can take up to 90s;
 * the handler MUST re-check it after the human approves and BEFORE it mints or
 * connects a share room, so a withdrawn-then-approved request can no longer
 * create a live (listenerless) share. Guardrail #5 below still suppresses the
 * RESPONSE for a withdrawn request; this probe lets the handler suppress the
 * SHARE itself.
 */
export type OpenProjectHandler = (
  projectId: string,
  isRequestLive: () => boolean,
) => Promise<OpenedProject | OpenProjectRefusal | null>;

/**
 * The live `export_compiled` handler ProjectApp registers (A1). It compiles the
 * OPEN project's current document, obtains the PDF bytes, ensures the project's
 * blob channel is connected, PUSHES the bytes over it under the SAME kernel-minted
 * `transferId`, and resolves `{hash, size}` ONLY after the push is accepted — or a
 * structured `{refused}` (nothing open, no compiler, blocked export, push failed)
 * or null (unknown project). At most ONE handler is live; the latest wins. Like the
 * open handler, it is read at CALL time (a project opened/closed after pairing is
 * reflected without re-enabling).
 */
export type ExportCompiledHandler = (
  projectId: string,
  transferId: string,
  maxBytes: number,
) => Promise<ExportedCompiled | OpenProjectRefusal | null>;

/**
 * The live `compile` handler ProjectApp registers (F9/F5). It reads the OPEN
 * project's CURRENT preview diagnostics + pageCount (the live preview already
 * compiled them — no fresh build is triggered) and resolves
 * `{ok, pageCount, diagnostics}`, a structured `{refused}` (nothing open / not
 * ready / a shared session that cannot compile), or null (not the OPEN project).
 * DIAGNOSTICS ONLY — no PDF bytes (that is the export handler's blob-channel job).
 * At most ONE handler is live; the latest wins; read at CALL time like the export
 * handler (a project opened/closed after pairing is reflected without re-enabling).
 */
export type CompileHandler = (
  projectId: string,
) => Promise<CompileDiagnostics | OpenProjectRefusal | null>;

/**
 * The live `expect_blob` handler ProjectApp registers (A2). It RESERVES inbound
 * capacity on the OPEN project's blob channel (`blobChannel.expect(hash, size)`)
 * so a subsequent kernel PUSH for that hash is accepted — the binary-upload path
 * of propose_files. It resolves `true` iff the reservation succeeded (the channel
 * exists, is authenticated, and the quota fit), `false` otherwise (no channel /
 * not authenticated / quota exceeded), or null for a project that is not the OPEN
 * one. At most ONE handler is live; the latest wins; read at CALL time like the
 * export handler (a project opened/closed after pairing is reflected).
 */
export type ExpectBlobHandler = (
  projectId: string,
  hash: string,
  size: number,
) => Promise<boolean | null>;

/**
 * The live `release_blob` handler ProjectApp registers (A2/C1b). It DROPS earlier
 * `expect_blob` reservations on the OPEN project's blob channel (and their lease
 * timers) when the kernel reports a failed upload. Resolves `true` when handled,
 * `false` (no channel), or null (not the OPEN project). Read at CALL time like the
 * expect handler; at most ONE live, latest wins, token-guarded unregister.
 */
export type ReleaseBlobHandler = (
  projectId: string,
  hashes: { hash: string; size: number }[],
) => Promise<boolean | null>;

/**
 * The live `request_restore_version` handler ProjectApp registers (B3). BOTH
 * halves require the OPEN project (the live CRDT + its doc host), which only
 * ProjectApp owns, so they live together in one registered handler read at CALL
 * time (a project opened/closed after pairing is reflected without re-enabling):
 *   - `liveFileSet(projectId)` returns the OPEN project's live TEXT files
 *     (path + text) when `projectId` matches the open project, else null. It
 *     MUST exclude binary assets (binaryMeta-backed files) so the restore diff's
 *     binary-delete-safety invariant holds (a binary is never in the diff, so it
 *     is never deleted). A null means nothing is open for that id.
 *   - `publish({request, ops})` publishes the computed restore proposal into the
 *     OPEN project's live doc via the existing `publishFileProposal` (the mailbox
 *     is unchanged — a NORMAL file proposal that flows through the existing
 *     Ask/Auto + Accept/apply path). Returns the minted proposal id.
 * At most ONE handler is live; the latest wins; the unregister is token-guarded
 * (StrictMode-safe), mirroring {@link registerExportCompiledHandler}.
 */
export interface RestoreVersionHandler {
  liveFileSet(projectId: string): Promise<RestoreFile[] | null>;
  publish(input: { request: string; ops: FileProposalOp[] }): Promise<string>;
}

/**
 * The grant-scoped proposal verifier the mount hands to ProjectApp (ADR-0023 §1).
 * Live ONLY while there is both a session `responseKey` AND an active grant — null
 * otherwise. `scopeFor` builds the per-mailbox {@link ProposalScope} from the
 * active grant; `verifyFor` derives `K = HKDF(responseKey; scope)` (memoized per
 * mailbox) and HMAC-verifies a signed proposal. FAIL CLOSED: any throw → false.
 */
export interface ProposalVerifier {
  verifyFor(scope: ProposalScope, signable: SignableProposal, sig: unknown): Promise<boolean>;
  scopeFor(mailbox: "mcpProposals" | "mcpFileProposals"): ProposalScope;
}

/**
 * Hard cap on the local "already answered" id cache (Security H1). The cache is a
 * pure OPTIMIZATION — answer-once is also enforced by the mailbox itself
 * (`publishControlResponse` is a no-op for an already-answered id, and
 * `readControlRequests` excludes answered ids) — so it can be a bounded FIFO that
 * evicts the oldest ids without ever causing a double-answer. Sized at a small
 * multiple of the mailbox's own per-read cap so an honest drain never evicts an id
 * it is still actively working in the SAME pass, while a process issuing endless
 * fresh-id requests can never grow this set without bound.
 */
export const ANSWERED_CACHE_CAP = CONTROL_LIMITS.maxReadRequests * 4;

/** A joined control room: the responder's mailbox host + a teardown. */
export interface ControlLink {
  /** The Y.Doc-backed host the mailbox reads/writes (the control room's doc). */
  host: DocHost;
  /** Disconnect from the relay and destroy the doc. Idempotent. */
  destroy(): void;
}

/** A tiny Storage-like seam so the unit gate can pass a fake (no DOM). */
export interface SessionStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Everything the manager needs from the outside world, injected so tests run
 * offline. The production factory supplies the real browser implementations.
 */
export interface ControlResponderMountDeps {
  /** Mint a fresh, unguessable control-room id (default: {@link mintShareRoom}). */
  mintControlRoom: () => string;
  /** Resolve the relay ws(s) URL the control room lives on. */
  resolveSyncUrl: () => string;
  /**
   * Resolve a LOOPBACK compile endpoint to fold into the kernel pairing command
   * as `--compile-url`, or null when none applies (F4). OPTIONAL: absent →
   * treated as null, so the pairing command stays compile-less (its long-time
   * shape). Production reads the serve-time compile URL and returns it only when
   * loopback (the kernel rejects non-loopback URLs); see {@link loopbackCompileUrl}.
   */
  resolveKernelCompileUrl?: () => string | null;
  /** The stable local user id whose projects the seams enumerate. */
  currentUserId: () => string;
  /** Library metadata (drives list_projects). */
  listProjects: () => Promise<ProjectMeta[]>;
  /** A project's named versions metadata, or null when unknown (drives list_versions). */
  listVersions: (projectId: string) => Promise<VersionMeta[] | null>;
  /**
   * create_project seam (F1, drives create_project). Production registers a
   * REGISTRY-ONLY project (no navigation, no CRDT seed) under the local profile
   * user; seeding happens when the user later opens it in the editor. NOTE:
   * create_project does NOT ride the content-consent gate (no pre-existing project
   * to grant) and is NOT in any of the manager's `*Ops` Sets — it flows through the
   * metadata core exactly like list_projects.
   */
  createProject: (name: string) => Promise<{ projectId: string; name: string }>;
  /**
   * open_project seam (#16.3). Delegates to the CURRENT registered ProjectApp
   * handler at CALL time (read fresh on every request, never captured at
   * enable()), or returns the no-handler refusal when nothing is open. The
   * production default reads the manager's own handler slot.
   */
  openProjectForControl: (projectId: string) => Promise<OpenedProject | OpenProjectRefusal | null>;
  /** Join the control room as a peer and return its mailbox host + teardown. */
  joinControlRoom: (controlRoom: string, syncUrl: string) => ControlLink;
  /**
   * Join the derived PAIRING room as a peer (B2, ADR-0026) and return its mailbox
   * host + teardown — the transient bootstrap channel the kernel's one-time
   * `--pairing-code` handshake runs on. OPTIONAL: the production default is the
   * SAME live join as the control room ({@link joinControlRoomLive}); tests inject
   * a fake. Absent → no pairing room is joined (the legacy/manual flow), so a
   * deployment without it simply shows no code-based pairing command.
   */
  joinPairingRoom?: (pairingRoom: string, syncUrl: string) => ControlLink;
  /** Mint the one-time pairing code (B2, default {@link mintPairingCode}). */
  mintPairingCode?: () => string;
  /** Override the pairing-code TTL (B2). Default {@link PAIRING_CODE_TTL_MS}; tests use a short value. */
  pairingCodeTtlMs?: () => number;
  /**
   * Persistent storage for the Agent Access session (capability blob + content
   * grants). Production wires this to window.localStorage so the session
   * SURVIVES a reload/restart (operator decision; reverses the original H3
   * "dies with the tab" posture). Null when storage is unavailable (privacy
   * mode / Node) — then the session is purely in-memory and does not resume.
   */
  sessionStore: SessionStoreLike | null;
  /**
   * Resolve a project's VISIBLE files (+ main path) for the read-only tool ops
   * (#1 slice 1), or null when the project is unknown/unreadable. Called ONLY
   * AFTER the content-consent gate passed for that projectId — never before —
   * and resolved fresh PER REQUEST. The production default membership-checks
   * the id against the local registry, then materializes the persisted CRDT
   * read-only (`materializeProjectTreeFromIdb`). OPTIONAL and FAIL-CLOSED:
   * when absent, every tool op resolves null and is refused generically.
   */
  projectFilesForTools?: (projectId: string) => Promise<ProjectToolFiles | null>;
  /**
   * Resolve the FILES captured in one named version of a project (B4), or null
   * when the project/version is unknown OR the version does not belong to the
   * project. Drives the consent-gated `list_version_files` / `read_version_file`
   * ops. Called ONLY AFTER the content-consent gate passed for that projectId —
   * never before — and resolved fresh PER REQUEST. The production default
   * membership-checks the id against the local registry, then reads the persisted
   * version tree read-only (`IdbVersionStore.getProjectVersionTree`, which also
   * binds version⇄project). OPTIONAL and FAIL-CLOSED: when absent, every version
   * file op resolves null and is refused generically.
   */
  projectVersionTree?: (projectId: string, versionId: string) => Promise<VersionFile[] | null>;
  /**
   * Whether this deployment runs with auth ON (#1 slice 2) — the served
   * runtime-config flag, never a probe. Optional: absent → the production
   * default reads `__GALLEY_CONFIG__.auth`, which in any auth-off run (and in
   * the Node unit gate) is false, keeping enable() byte-for-byte today's
   * synchronous path with ZERO registry calls.
   */
  authActive?: () => boolean;
  /**
   * Register the freshly minted CONTROL room with the server (#1 slice 2).
   * Consulted ONLY when `authActive()` — enable() awaits SUCCESS before
   * joining the relay or surfacing the pairing command; on failure the
   * manager stays disabled and exposes the error. Absent while auth is on →
   * fail closed (registration is unavailable, enable() errors out).
   */
  registerControlRoom?: (roomId: string) => Promise<RegisterCapabilityRoomResult>;
  /**
   * Best-effort server-side revocation of a REGISTERED control room, fired on
   * disable() (#1 slice 2). Never awaited on the teardown path — local
   * teardown always proceeds; the relay denies future joins either way once
   * the record is tombstoned (or the session expires).
   */
  revokeControlRoom?: (roomId: string) => Promise<void>;
}

/** UI-facing snapshot of the manager. */
export interface ControlResponderMountState {
  enabled: boolean;
  /** The active control room, or null when disabled. */
  controlRoom: string | null;
  /** The relay URL in use, or null when disabled. */
  syncUrl: string | null;
  /** The copyable kernel pairing command, or null when disabled. */
  pairingCommand: string | null;
  /**
   * TRUE while an auth-on enable() awaits server registration (#1 slice 2):
   * the room is minted but NOT yet joined and no pairing command exists.
   * Always false in auth-off runs (enable() stays synchronous there).
   */
  pending: boolean;
  /**
   * The user-facing failure of the LAST auth-on enable() attempt (cap hit /
   * not signed in / server unreachable), or null. Cleared by the next enable().
   */
  error: string | null;
}

/**
 * The kernel pairing command the user pastes (B2, ADR-0026). It now carries ONLY
 * the one-time `--pairing-code` — NO secret. The kernel runs a handshake (see
 * pairing-bootstrap.ts) to derive the pairing room + bootstrap keys from the code,
 * proves it knows the code, and OBTAINS the control room + response key over an
 * AES-GCM-sealed channel — so the long-lived `responseKey` never rides in argv
 * (shell history / process listings / logs) the way the legacy
 * `--control-room`/`--response-key` command did. The code is still bearer
 * material (a 10-minute, one-time secret), so treat the command like a password —
 * but a leaked code AFTER it is consumed (or after 10 min) is inert.
 */
export function buildPairingCommand(syncUrl: string, pairingCode: string, compileUrl?: string): string {
  const base = `galley-mcp --sync ${syncUrl} --pairing-code ${pairingCode}`;
  // Fold in --compile-url only when one was resolved (loopback-gated by the
  // caller, see loopbackCompileUrl): a compile-less command stays the default.
  return compileUrl !== undefined ? `${base} --compile-url ${compileUrl}` : base;
}

/** The control-mailbox op name the kernel's pairing claim rides on (must match control.ts). */
export const PAIRING_CLAIM_OP = "pairing_claim";

/** The one-time pairing code's lifetime (ADR-0026): 10 minutes, then it is voided. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Gate a compile endpoint for inclusion in the kernel pairing command. The
 * kernel POSTs the whole document to `--compile-url` on every compile, so
 * `apps/mcp/src/config.ts` REFUSES any non-loopback URL (a remote one would
 * exfiltrate the document). We therefore only fold a compile endpoint into the
 * pairing command when it is loopback (localhost / 127.0.0.0/8 / ::1) — the
 * self-host case where the kernel and the compile service share the host (e.g.
 * the docker-compose.compile.yml overlay serves `http://127.0.0.1:3001/compile`).
 * Returns the URL unchanged when loopback-and-parseable, else null (the kernel
 * would reject it, so a paired self-hoster falls back to the documented manual
 * `--compile-url`).
 */
export function loopbackCompileUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let hostname: string;
  try {
    hostname = new URL(raw).hostname;
  } catch {
    return null;
  }
  // URL.hostname keeps IPv6 brackets ("[::1]") — strip them before matching.
  const host = hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  return loopback ? raw : null;
}

/**
 * Mint the per-session 256-bit response-auth key (HIGH-1). FAIL-CLOSED, like
 * `mintShareRoom`: no CSPRNG → throw, never a weak key.
 */
function mintResponseKey(): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("agent access requires a secure random source (crypto.getRandomValues)");
  }
  return c.getRandomValues(new Uint8Array(CONTROL_RESPONSE_KEY_BYTES));
}

/**
 * The singleton manager type. Created once per tab; `enable`/`disable` flip the
 * live responder on and off without re-creating it.
 */
export interface ControlResponderManager {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  getState(): ControlResponderMountState;
  /** Subscribe to state changes (for the React UI). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Register the live `open_project` handler (ProjectApp owns it — it runs the
   * consent modal + share-upgrade). At most ONE handler is live at a time; the
   * latest registration wins. Returns an unregister that ONLY clears the slot if
   * THIS registration is still the current one (token match) — so a stale unmount
   * (StrictMode double-invoke, a slow teardown) can never clobber a newer handler.
   */
  registerOpenProjectHandler(handler: OpenProjectHandler): () => void;
  /**
   * Register the live `export_compiled` handler (A1) — ProjectApp owns it (it
   * compiles + pushes the PDF over the project blob channel). At most ONE handler
   * is live; the latest wins; the returned unregister is token-guarded so a stale
   * unmount cannot clobber a newer registration (StrictMode-safe), mirroring
   * {@link registerOpenProjectHandler}.
   */
  registerExportCompiledHandler(handler: ExportCompiledHandler): () => void;
  /**
   * Register the live `compile` handler (F9/F5) — ProjectApp owns it (it reads the
   * OPEN project's live preview diagnostics). At most ONE handler is live; the
   * latest wins; the returned unregister is token-guarded so a stale unmount cannot
   * clobber a newer registration (StrictMode-safe), mirroring
   * {@link registerExportCompiledHandler}.
   */
  registerCompileHandler(handler: CompileHandler): () => void;
  /**
   * Register the live `expect_blob` handler (A2) — ProjectApp owns it (it reserves
   * inbound capacity on the project's blob channel before the kernel pushes binary
   * bytes). At most ONE handler is live; the latest wins; the returned unregister
   * is token-guarded so a stale unmount cannot clobber a newer registration
   * (StrictMode-safe), mirroring {@link registerExportCompiledHandler}.
   */
  registerExpectBlobHandler(handler: ExpectBlobHandler): () => void;
  /**
   * Register the live `release_blob` handler (A2/C1b) — ProjectApp owns it (it
   * drops earlier blob-channel reservations + their leases on a kernel-reported
   * upload failure). At most ONE live; latest wins; token-guarded unregister.
   */
  registerReleaseBlobHandler(handler: ReleaseBlobHandler): () => void;
  /**
   * Register the live `request_restore_version` handler (B3) — ProjectApp owns it
   * (it reads the OPEN project's live text files AND publishes the restore proposal
   * into the live doc). At most ONE handler is live; the latest wins; the returned
   * unregister is token-guarded so a stale unmount cannot clobber a newer one
   * (StrictMode-safe), mirroring {@link registerExportCompiledHandler}.
   */
  registerRestoreVersionHandler(handler: RestoreVersionHandler): () => void;
  /**
   * Persist a freshly consented grant (ADR-0023 §4), MAC'd with the live
   * `responseKey`, and hold it in memory for re-bind + the verifier. Best-effort
   * (a failed persist never throws); a no-op when there is no live session key.
   */
  recordGrant(grant: ProposalGrant): void;
  /**
   * F13 (consent collapse): mint per-project content (file-read) access for the
   * ACTIVE grant's project, so the single open_project consent grants BOTH the
   * share/apply scope AND read access — no separate "Allow file access" click.
   * `isContentGranted` stays the sole read predicate (the seven tool gates are
   * unchanged); this just satisfies it at the moment of open consent. A no-op
   * when there is no active grant. Idempotent.
   */
  grantContentForActiveGrant(): void;
  /** The active in-memory grant (re-parsed on resume), or null when none/invalid. */
  getActiveGrant(): ProposalGrant | null;
  /**
   * The active grant ONLY when its full scope matches the caller's project
   * (H1 — broken authority scoping): returns the grant iff
   * `grant.projectId === projectId` AND, when `shareRoom` is supplied, the grant's
   * `shareRoom` matches too. Else null. Every per-project MCP-authority READ (the
   * Auto mode the final-apply gate consults) and the panel's mode WRITE route
   * through this so a project-B surface can never read/write project-A's grant.
   */
  getActiveGrantForProject(projectId: string, shareRoom?: string): ProposalGrant | null;
  /** Set the active grant's acceptance mode, then re-MAC + re-persist it. */
  setGrantMode(mode: "ask" | "auto"): void;
  /**
   * F13: set the active grant's standing `persistentAccess` flag (the background-
   * agent opt-in), re-MAC + re-persist it, and — when turning ON — grant per-project
   * file (read) access too so the background host can materialise the doc. Default-
   * OFF; a no-op when there is no active grant or the flag is already in that state.
   * OFF does not revoke content access (Revoke is the explicit teardown).
   */
  setGrantPersistentAccess(on: boolean): void;
  /**
   * The grant-scoped proposal verifier (ADR-0023 §1), or null unless there is BOTH
   * a live `responseKey` AND an active grant. Re-read fresh per call.
   */
  getProposalVerifier(): ProposalVerifier | null;
  /**
   * The grant-scoped blob-terminal {signer, verifier} (A1 export channel), or null
   * unless there is BOTH a live `responseKey` AND an active grant. Built from the
   * SAME per-grant `responseKey` + scope as the proposal verifier (the kernel
   * derives the identical key), so the browser's export blob channel can VERIFY the
   * kernel's COMPLETE — a forged/unsigned COMPLETE from a 3rd peer is then rejected
   * and the browser's `send().done` does NOT resolve (no descriptor returned).
   * Re-read fresh per call (the grant may change).
   */
  getBlobTerminalAuth(): { terminalSigner: BlobTerminalSigner; terminalVerifier: BlobTerminalVerifier } | null;
  /**
   * Build the blob-terminal {signer, verifier} for an EXPLICIT scope (A1) using the
   * live session `responseKey`, independent of the currently-stored grant — so a
   * share-connect that opens the blob channel BEFORE `recordGrant` lands can still
   * wire authenticated completion from the scope it already knows. Null when there
   * is no live `responseKey` (no Agent Access session). The scope MUST match the
   * one the kernel receives in the open_project handoff, or the derived keys differ.
   */
  buildBlobTerminalAuthForScope(scope: {
    grantId: string;
    controlRoom: string;
    syncUrl: string;
    projectId: string;
    shareRoom: string;
  }): { terminalSigner: BlobTerminalSigner; terminalVerifier: BlobTerminalVerifier } | null;
  /**
   * The durable auto-accept tombstone audit for the active grant (ADR-0023 §3),
   * or null when there is no active grant / no store. The manager owns it so a
   * Revoke clears the audit alongside the grant. Re-read fresh per call.
   */
  getAudit(): AutoAcceptAudit | null;
  /**
   * Clear the active grant WITHOUT revoking the whole Agent Access session
   * (ADR-0024 §3 security fix): drop the in-memory + persisted grant, the derived
   * verifier keys, the auto-accept armed-state, and the tombstone audit; bump the
   * persist epoch (so a racing arm cannot resurrect it) and emit. Used by "Stop
   * sharing" — ending the share must end the grant it authorized, so a later
   * reload re-bind / reuse fast-path can NEVER reopen the just-closed share room.
   * Idempotent; a no-op when there is no grant. The control room / responseKey
   * stay live (the agent stays paired) — only the share grant is withdrawn.
   */
  clearActiveGrant(): void;
}

class ControlResponderMountManager implements ControlResponderManager {
  private link: ControlLink | undefined;
  private unobserve: (() => void) | undefined;
  private controlRoom: string | null = null;
  private syncUrl: string | null = null;
  /**
   * The per-session response-auth key (HIGH-1): minted at enable(), held ONLY
   * in this manager's memory (the same lifecycle as the control-room
   * capability — H3: no resume path, dies with the tab/Revoke), surfaced ONLY
   * inside the pairing command. Every published response is HMAC-signed with
   * it; the kernel rejects anything else. Zeroed + dropped on disable().
   */
  private responseKey: Uint8Array | null = null;
  /**
   * The B2 pairing channel (ADR-0026): the one-time CODE the user pastes (the
   * ONLY thing surfaced in the pairing command — no secret), the derived bootstrap
   * (pairing room + mac/seal keys), the transient pairing-room link the kernel's
   * claim arrives on, the TTL timer that voids the code at 10 minutes, and a
   * `voided` flag so a CONSUMED or EXPIRED code can never be claimed twice. All
   * cleared on disable()/Revoke and once the code is consumed.
   */
  private pairingCode: string | null = null;
  private pairingLink: ControlLink | undefined;
  private pairingUnobserve: (() => void) | undefined;
  private pairingTtlTimer: ReturnType<typeof setTimeout> | undefined;
  private pairingVoided = false;
  /** The pairing room registered server-side under auth-on (#3) — revoked on teardown. */
  private registeredPairingRoom: string | null = null;
  /**
   * The active consented grant (ADR-0023 §4), held in memory for re-bind + the
   * grant-scoped verifier. Loaded on RESUME by re-parsing the persisted blob with
   * the resumed `responseKey` (dropped if its MAC fails), set by
   * {@link recordGrant}, cleared on disable()/clearSession(). Null when none.
   */
  private grant: ProposalGrant | null = null;
  /**
   * Monotonic epoch for grant PERSISTENCE (review High-3). `persistGrant` is async
   * (it MACs before writing); without this a slow earlier write (e.g. an arm) could
   * land AFTER a later one (a disarm/revoke) and resurrect a stale grant on reload.
   * Each recordGrant / setGrantMode / clearGrant bumps it; a persist only
   * writes if its captured epoch is still current — the last call always wins.
   */
  private grantPersistEpoch = 0;
  /**
   * Memoized per-mailbox derived verify keys for the active grant. Cleared
   * whenever the grant or `responseKey` changes so a stale key never verifies.
   */
  private verifyKeys: Map<string, ReturnType<typeof deriveProposalKey>> | null = null;
  /**
   * Already-answered request ids, as a BOUNDED FIFO (Security H1). A `Set`
   * preserves insertion order, so the first entry is the oldest; once it exceeds
   * {@link ANSWERED_CACHE_CAP} we evict the oldest. Eviction is harmless: an
   * answered request never reappears in `readControlRequests` (it filters on the
   * mailbox response), and `publishControlResponse` is answer-once — so even a
   * re-seen evicted id cannot be double-answered.
   */
  private readonly answered = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /**
   * The CURRENT live `open_project` handler and a monotonic token identifying it
   * (#16.3). One slot: a new registration replaces the old; the returned
   * unregister only clears the slot when its token still matches the live one, so
   * a stale unmount cannot clobber a newer registration (StrictMode-safe).
   */
  private openHandler: OpenProjectHandler | null = null;
  private openHandlerToken = 0;
  /**
   * The CURRENT live `export_compiled` handler + its monotonic token (A1). One
   * slot, latest-wins, token-guarded unregister — same StrictMode-safe discipline
   * as the open handler. Null when no project is open to export.
   */
  private exportHandler: ExportCompiledHandler | null = null;
  private exportHandlerToken = 0;
  /**
   * The CURRENT live `compile` handler + its monotonic token (F9/F5). One slot,
   * latest-wins, token-guarded unregister — same StrictMode-safe discipline as the
   * export handler. Null when no project is open to read diagnostics from.
   */
  private compileHandler: CompileHandler | null = null;
  private compileHandlerToken = 0;
  /**
   * The CURRENT live `expect_blob` handler + its monotonic token (A2). One slot,
   * latest-wins, token-guarded unregister — same StrictMode-safe discipline as the
   * export handler. Null when no project is open to reserve capacity on.
   */
  private expectBlobHandler: ExpectBlobHandler | null = null;
  private expectBlobHandlerToken = 0;
  /** The CURRENT live `release_blob` handler + token (A2/C1b). One slot, latest-wins. */
  private releaseBlobHandler: ReleaseBlobHandler | null = null;
  private releaseBlobHandlerToken = 0;
  /**
   * The CURRENT live `request_restore_version` handler + its monotonic token (B3).
   * One slot, latest-wins, token-guarded unregister — same StrictMode-safe
   * discipline as the export handler. Null when no project is open to restore.
   */
  private restoreHandler: RestoreVersionHandler | null = null;
  private restoreHandlerToken = 0;

  /**
   * #1 slice 2 (auth-on only): TRUE while enable() awaits server registration;
   * the user-facing failure of the last attempt; the room we ACTUALLY
   * registered (revoked best-effort on disable); and a monotonic epoch so a
   * disable() (or test reset) cancels an in-flight registration's continuation.
   * All inert in auth-off runs.
   */
  private pendingEnable = false;
  private lastError: string | null = null;
  private registeredControlRoom: string | null = null;
  private enableEpoch = 0;

  /** The op names routed through the read-only tool adapter (#1 slice 1). */
  private readonly toolOps = new Set(readonlyToolOps());
  /** The version-file ops (B4) — same content-consent gate, version-tree seam. */
  private readonly versionFileOps = new Set(versionFileOps());
  /** The export op (A1) — same content-consent gate, project export-handler seam. */
  private readonly exportCompiledOps = new Set(exportCompiledOps());
  /** The compile op (F9/F5) — same content-consent gate, project compile-handler seam. */
  private readonly compileOps = new Set(compileOps());
  /** The expect_blob op (A2) — same content-consent gate, project blob-channel reserve seam. */
  private readonly expectBlobOps = new Set(expectBlobOps());
  /** The release_blob op (A2/C1b) — same content-consent gate, project blob-channel release seam. */
  private readonly releaseBlobOps = new Set(releaseBlobOps());
  /** The restore op (B3) — same content-consent gate, project restore-handler seam. */
  private readonly restoreVersionOps = new Set(restoreVersionOps());

  constructor(private readonly deps: ControlResponderMountDeps) {
    // RESUME (operator decision — reverses the original H3 "dies with the tab"
    // posture): if the persisted store holds a VALID session, re-join the SAME
    // room with the SAME key so Agent Access survives a reload/restart, and KEEP
    // any persisted grants. Otherwise default-zero: clear the (absent/malformed)
    // blob and every stale grant. Construction is the app-boot hook (main.tsx),
    // so a resumed session is live again without the user re-opening /settings.
    const persisted = readPersistedAgentAccessSession(this.deps.sessionStore);
    if (persisted !== null) {
      this.resume(persisted.controlRoom, persisted.responseKey);
      return;
    }
    try {
      this.deps.sessionStore?.removeItem(AGENT_ACCESS_SESSION_KEY);
    } catch {
      // best-effort
    }
    // No resumable session → grants without a capability are orphans; default
    // ZERO (a malformed blob or a closed session must not leak old grants). The
    // persisted agent grant (ADR-0023 §4) is one such orphan — drop it too.
    this.clearGrant();
    revokeAllContentGrants(this.deps.sessionStore);
  }

  /** Test-only: current size of the bounded answered-id FIFO (H1 assertion). */
  answeredCacheSize(): number {
    return this.answered.size;
  }

  /** Test-only: the live response-auth key (the B2 command no longer carries it). */
  responseKeyForTests(): Uint8Array | null {
    return this.responseKey;
  }

  /** Record an id as answered, evicting the oldest when the FIFO is full (H1). */
  private markAnswered(id: string): void {
    this.answered.add(id);
    while (this.answered.size > ANSWERED_CACHE_CAP) {
      const oldest = this.answered.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.answered.delete(oldest);
    }
  }

  isEnabled(): boolean {
    return this.link !== undefined;
  }

  getState(): ControlResponderMountState {
    const enabled = this.isEnabled();
    return {
      enabled,
      controlRoom: enabled ? this.controlRoom : null,
      syncUrl: enabled ? this.syncUrl : null,
      // B2 (ADR-0026): the surfaced command carries the one-time CODE, NEVER the
      // responseKey. It exists only while a live, NON-voided code is available (a
      // pairing room was joined and the code has not been consumed / expired) —
      // once the kernel claims it (one-time) or 10 min pass, the code is voided
      // and the command disappears (re-enable to mint a fresh one).
      pairingCommand:
        enabled && this.syncUrl !== null && this.pairingCode !== null && !this.pairingVoided
          ? buildPairingCommand(
              this.syncUrl,
              this.pairingCode,
              // A loopback compile endpoint (self-host) gives the paired kernel a
              // working `compile` tool zero-config; otherwise the command is
              // unchanged (F4). The dep is optional → default to no compile-url.
              this.deps.resolveKernelCompileUrl?.() ?? undefined,
            )
          : null,
      pending: this.pendingEnable,
      error: this.lastError,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  registerOpenProjectHandler(handler: OpenProjectHandler): () => void {
    const token = ++this.openHandlerToken;
    this.openHandler = handler;
    return () => {
      // Token-guarded: only retract if THIS registration is still the live one.
      // A stale unmount (its token superseded by a newer register) is a no-op,
      // so it can't clear a handler a fresher mount installed.
      if (this.openHandlerToken === token) {
        this.openHandler = null;
      }
    };
  }

  registerExportCompiledHandler(handler: ExportCompiledHandler): () => void {
    const token = ++this.exportHandlerToken;
    this.exportHandler = handler;
    return () => {
      if (this.exportHandlerToken === token) {
        this.exportHandler = null;
      }
    };
  }

  registerCompileHandler(handler: CompileHandler): () => void {
    const token = ++this.compileHandlerToken;
    this.compileHandler = handler;
    return () => {
      if (this.compileHandlerToken === token) {
        this.compileHandler = null;
      }
    };
  }

  registerExpectBlobHandler(handler: ExpectBlobHandler): () => void {
    const token = ++this.expectBlobHandlerToken;
    this.expectBlobHandler = handler;
    return () => {
      if (this.expectBlobHandlerToken === token) {
        this.expectBlobHandler = null;
      }
    };
  }

  registerReleaseBlobHandler(handler: ReleaseBlobHandler): () => void {
    const token = ++this.releaseBlobHandlerToken;
    this.releaseBlobHandler = handler;
    return () => {
      if (this.releaseBlobHandlerToken === token) {
        this.releaseBlobHandler = null;
      }
    };
  }

  registerRestoreVersionHandler(handler: RestoreVersionHandler): () => void {
    const token = ++this.restoreHandlerToken;
    this.restoreHandler = handler;
    return () => {
      if (this.restoreHandlerToken === token) {
        this.restoreHandler = null;
      }
    };
  }

  /**
   * The export seam (A1), resolved against the CURRENT handler at CALL time. No
   * handler registered → the static no-handler refusal (nothing open to export).
   * The mount gates this behind the SAME per-project content consent as the tool
   * ops BEFORE this runs, so a compile + push only ever happens for a granted,
   * open project. Returns the `{hash,size}` descriptor (after the push), a
   * `{refused}`, or null (unknown project).
   */
  private async callExportHandler(
    projectId: string,
    transferId: string,
    maxBytes: number,
  ): Promise<ExportedCompiled | OpenProjectRefusal | null> {
    const handler = this.exportHandler;
    if (handler === null) return { refused: NO_OPEN_HANDLER_REFUSAL };
    return handler(projectId, transferId, maxBytes);
  }

  /**
   * The compile seam (F9/F5), resolved against the CURRENT handler at CALL time.
   * No handler registered → the static no-handler refusal (nothing open). The
   * mount gates this behind the SAME per-project content consent as the tool ops
   * BEFORE this runs, so the diagnostics (build feedback over the project text) are
   * only ever read for a granted, open project.
   */
  private async callCompileHandler(
    projectId: string,
  ): Promise<CompileDiagnostics | OpenProjectRefusal | null> {
    const handler = this.compileHandler;
    if (handler === null) return { refused: NO_OPEN_HANDLER_REFUSAL };
    return handler(projectId);
  }

  /**
   * The expect_blob seam (A2), resolved against the CURRENT handler at CALL time.
   * No handler registered → null (nothing open to reserve on; the core maps null
   * to an "unknown project" refusal, so the kernel will NOT push). The mount gates
   * this behind the SAME per-project content consent as the tool ops BEFORE this
   * runs, so a buffer reservation only ever happens for a granted, open project.
   */
  private async callExpectBlobHandler(
    projectId: string,
    hash: string,
    size: number,
  ): Promise<boolean | null> {
    const handler = this.expectBlobHandler;
    if (handler === null) return null;
    return handler(projectId, hash, size);
  }

  /**
   * The release_blob seam (A2/C1b), resolved against the CURRENT handler at CALL
   * time. No handler → null (nothing open; the kernel's release is best-effort, so
   * a null is harmless). Consent-gated by the mount before this runs.
   */
  private async callReleaseBlobHandler(
    projectId: string,
    hashes: { hash: string; size: number }[],
  ): Promise<boolean | null> {
    const handler = this.releaseBlobHandler;
    if (handler === null) return null;
    return handler(projectId, hashes);
  }

  /**
   * The open seam, resolved against the CURRENT handler at CALL time (never the
   * one captured at enable()). No handler registered → the static no-handler
   * refusal. Never throws across the seam boundary — the core wraps it too, but
   * a structured refusal keeps the kernel's message precise. `isRequestLive` is
   * the request-scoped liveness probe (SEC-16.3a) threaded through to the
   * handler so it can refuse a withdrawn request BEFORE minting a share.
   */
  private async callOpenHandler(
    projectId: string,
    isRequestLive: () => boolean,
  ): Promise<OpenedProject | OpenProjectRefusal | null> {
    // F13 (headless attach): a request for a project that is NOT the foregrounded
    // editor document re-attaches its already-consented share WITHOUT a modal when a
    // standing, MAC-verified, exact-scope, non-idle `persistentAccess` grant matches
    // it EXACTLY. Tried FIRST so a non-foreground persisted-grant project is served
    // (the foreground editor handler would refuse it as REFUSAL_WRONG_PROJECT, and
    // with no editor open there is no handler at all → today's NO_OPEN_HANDLER
    // refusal). On a hit the background host (mounted at the app root) actually
    // re-connects the share + runs the apply loop; this only returns the handoff the
    // kernel binds to. A miss/doubt returns null and we fall through to the
    // foreground handler (which still owns its own project + the full consent modal).
    // Liveness-gated like the reuse fast-path. Fail closed: any doubt → fall through.
    const headless = await this.tryHeadlessAttach(projectId, isRequestLive);
    if (headless !== null) return headless;
    // Prefer the live ProjectApp-registered handler (the production path). A test
    // may instead inject the handler through `deps.openProjectForControl`; honor
    // that as the fallback. Only when NEITHER exists is nothing open to share.
    const handler = this.openHandler;
    if (handler !== null) return handler(projectId, isRequestLive);
    return this.deps.openProjectForControl(projectId);
  }

  /**
   * F13 headless-attach resolver (ADR-0024 §3.1 / ADR-0026 §6). Returns the live
   * `OpenedProject` handoff for `requestedProjectId` to re-attach its already-
   * consented share WITHOUT consent — ONLY when ALL hold:
   *   - there is a live session (responseKey + controlRoom + syncUrl);
   *   - the active grant carries `persistentAccess` and is for EXACTLY this project;
   *   - {@link grantAuthorizesHeadlessAttach}: exact canonical scope match against
   *     the LIVE coordinates AND not idle past the 7-day TTL (`lastActiveAt`, from
   *     the per-grant stamp, falling back to `grantedAt`);
   *   - the request is still live (SEC-16.3a) — re-checked BEFORE returning the
   *     handoff so a withdrawn request never hands back a share capability.
   * Any miss/doubt → null (the caller falls through to the foreground gate). The
   * handoff is built from the SAME grant fields the kernel signs against, so the
   * background host's verifier + the kernel derive identical keys. Never throws.
   *
   * NOTE: this returns the handoff only; the actual share RE-CONNECT + apply loop is
   * the app-root background host's job (useAgentApplyHost). The kernel needs the
   * coordinates regardless, and the host attaches independently off the same grant.
   */
  private async tryHeadlessAttach(
    requestedProjectId: string,
    isRequestLive: () => boolean,
  ): Promise<OpenedProject | null> {
    try {
      const grant = this.grant;
      const controlRoom = this.controlRoom;
      const syncUrl = this.syncUrl;
      if (grant === null || controlRoom === null || syncUrl === null) return null;
      if (this.responseKey === null) return null; // no live session key → no headless
      if (grant.persistentAccess !== true) return null;
      if (grant.projectId !== requestedProjectId) return null;
      // The LIVE scope the headless attach must match EXACTLY (mirrors the reuse
      // fast-path's GrantReuseScope): the mount's live control room + relay, plus the
      // grant's own project/share/main.
      const liveScope = {
        controlRoom,
        syncUrl,
        projectId: grant.projectId,
        shareRoom: grant.shareRoom,
        mainFile: grant.mainFile,
      };
      const stamp = readHeadlessStamp(this.deps.sessionStore, grant.grantId);
      const lastActiveAt = stamp ?? grant.grantedAt;
      if (!grantAuthorizesHeadlessAttach(grant, liveScope, lastActiveAt, Date.now())) return null;
      // SEC-16.3a: a request the kernel already withdrew must NOT receive a share
      // handoff — re-check liveness at the LAST step before returning the capability.
      if (!isRequestLive()) return null;
      return {
        room: grant.shareRoom,
        syncUrl: grant.syncUrl,
        mainFile: grant.mainFile,
        grantId: grant.grantId,
      };
    } catch {
      return null; // fail closed: any error → fall through to the foreground gate
    }
  }

  /** Auth flag (#1 slice 2): injected, else the served runtime config. */
  private authActive(): boolean {
    try {
      if (this.deps.authActive !== undefined) return this.deps.authActive();
      return capabilityAuthActive();
    } catch {
      return false; // a broken probe never blocks the local mode (the relay still enforces)
    }
  }

  enable(): void {
    // Idempotent: one responder per control room per tab (StrictMode / re-clicks),
    // including while an auth-on registration is still in flight.
    if (this.link !== undefined || this.pendingEnable) return;
    // A fresh session: mint a NEW room and a NEW response-auth key, and (B2) a
    // NEW one-time pairing code — a fresh enable() always offers a fresh code.
    this.beginSession(this.deps.mintControlRoom(), mintResponseKey(), true);
  }

  /**
   * RESUME a PERSISTED session on construction (operator opt-in to cross-reload
   * persistence): re-join the SAME room with the SAME key. Goes through the same
   * auth gating as enable() — under auth-on the room is RE-REGISTERED (idempotent
   * for the same creator while the server record is still active) before
   * re-joining, and a failed re-registration leaves the manager disabled (the
   * persisted blob stays for the next load to retry; Revoke / a fresh Enable
   * overwrite it).
   */
  private resume(controlRoom: string, responseKey: Uint8Array): void {
    if (this.link !== undefined || this.pendingEnable) return;
    // RESUME does NOT mint a pairing code (B2): a resumed session was already
    // paired (the kernel re-runs from its durable store), so no command is shown.
    // The user can Revoke + re-enable to mint a fresh code for a new kernel.
    this.beginSession(controlRoom, responseKey, false);
  }

  /**
   * The shared enable/resume body. Resolve the relay, then either go live
   * synchronously (auth OFF — the default local mode, ZERO registry calls) or
   * REGISTER BEFORE JOINING (auth ON, #1 slice 2): the pairing command (the
   * capability!) is not surfaced — and the relay is not joined — until the server
   * accepts the registration; a failure leaves the manager disabled with a
   * user-facing error. The epoch cancels a stale continuation if the user (or a
   * test reset) disables mid-flight. `startSession` persists the blob so the next
   * load can resume.
   */
  private beginSession(controlRoom: string, responseKey: Uint8Array, mintCode: boolean): void {
    const syncUrl = this.deps.resolveSyncUrl();

    if (!this.authActive()) {
      this.startSession(controlRoom, syncUrl, responseKey, mintCode);
      return;
    }

    const epoch = ++this.enableEpoch;
    this.pendingEnable = true;
    this.lastError = null;
    this.emit();
    void (async () => {
      let result: RegisterCapabilityRoomResult;
      try {
        const register = this.deps.registerControlRoom;
        result =
          register === undefined
            ? // Fail closed: auth is on but no registration seam exists — never
              // join the relay with an unregistered capability.
              { ok: false, error: "agent access registration is unavailable in this build" }
            : await register(controlRoom);
      } catch {
        result = { ok: false, error: "the server could not register this agent session" };
      }
      if (this.enableEpoch !== epoch) return; // disabled/reset while registering
      this.pendingEnable = false;
      if (!result.ok) {
        this.lastError = result.error;
        this.emit();
        return;
      }
      this.registeredControlRoom = controlRoom;
      this.startSession(controlRoom, syncUrl, responseKey, mintCode);
    })();
  }

  /**
   * Bring the responder LIVE for an (auth-on: already-registered) control room.
   * Takes the response-auth key from the caller — enable() mints a fresh one,
   * resume() supplies the persisted one.
   */
  private startSession(
    controlRoom: string,
    syncUrl: string,
    responseKey: Uint8Array,
    mintCode: boolean,
  ): void {
    // HIGH-1: the response-auth key is set BEFORE joining anything — fail-closed,
    // so a session without a key never starts answering at all.
    this.responseKey = responseKey;
    this.controlRoom = controlRoom;
    this.syncUrl = syncUrl;
    this.answered.clear();
    // RESUME the persisted grant (ADR-0023 §4): re-parse the blob with THIS
    // session's responseKey. A grant whose MAC was minted under a different key
    // (a fresh enable() after Revoke, or a tampered/forged blob) fails to parse
    // and is dropped — the verifier stays null until a fresh recordGrant. Async
    // (WebCrypto), best-effort: a load failure just leaves no active grant.
    this.grant = null;
    this.verifyKeys = null;
    void this.loadPersistedGrant(responseKey);

    // PERSIST the capability (room + key) so a reload/restart RESUMES it (operator
    // decision; reverses the original H3 non-persistence). Revoke clears it, a
    // malformed/absent blob never resumes. Best-effort — a failed write just means
    // no resume next load (fail-closed).
    writePersistedAgentAccessSession(
      this.deps.sessionStore,
      controlRoom,
      bytesToBase64Url(responseKey),
    );

    const link = this.deps.joinControlRoom(controlRoom, syncUrl);
    this.link = link;

    // Seams are bound PER REQUEST (not once at enable) so the open path can
    // thread a REQUEST-SCOPED liveness probe into the consent handler
    // (SEC-16.3a): the probe is TRUE while the originating request is still in
    // the mailbox AND this link is still live. The ProjectApp handler re-checks
    // it AFTER the human approves and BEFORE it mints/connects a share room, so
    // a request the kernel already withdrew can no longer cause a live
    // (listenerless) share. The handler itself is still read at CALL time (via
    // callOpenHandler) — a project opened/closed after pairing is reflected
    // without re-enabling.
    const answer = (request: ControlRequest): Promise<ControlResponseInput> => {
      // F9/F5: the `compile` op exposes the open project's live preview diagnostics
      // (build feedback over the project text), so it rides the SAME per-project
      // content-consent gate as the other content ops. It MUST be checked BEFORE the
      // toolOps branch: `compile` is also a read-only registry op (readonlyToolOps()
      // lists it), but the registry adapter has NO compiler on the control surface
      // (buildControlToolSeams's `compiler.check` throws), so routing it there would
      // only ever fail-closed. The dedicated handler reads the browser's real
      // diagnostics instead; returning here makes the (dead) toolOps path
      // unreachable for `compile`.
      if (this.compileOps.has(request.op)) return this.answerCompileRequest(request);
      // #1 slice 1: the registry's read-only tool ops route through the adapter
      // behind the per-project content-consent gate. Every other op — including
      // every UNKNOWN op — keeps today's behavior via the metadata core.
      if (this.toolOps.has(request.op)) return this.answerToolRequest(request);
      // B4: the version-file ops carry file CONTENTS too, so they ride the SAME
      // per-project content-consent gate (never the metadata-only pairing surface).
      if (this.versionFileOps.has(request.op)) return this.answerVersionFileRequest(request);
      // A1: export_compiled returns the compiled PDF over the blob channel — it
      // exposes the build output, so it rides the SAME per-project content-consent
      // gate as the other content ops (never the metadata pairing surface).
      if (this.exportCompiledOps.has(request.op)) return this.answerExportCompiledRequest(request);
      // A2: expect_blob reserves browser blob-channel capacity before a kernel
      // binary push (the propose_files upload path) — it commits buffer quota for
      // the open project, so it rides the SAME per-project content-consent gate.
      if (this.expectBlobOps.has(request.op)) return this.answerExpectBlobRequest(request);
      // A2/C1b: release_blob drops earlier reservations on an upload failure — it
      // touches the open project's blob channel, so the SAME content-consent gate.
      if (this.releaseBlobOps.has(request.op)) return this.answerReleaseBlobRequest(request);
      // B3: request_restore_version reads the live project AND publishes a
      // proposal into it, so it rides the SAME per-project content-consent gate.
      // It NEVER mutates files directly — it only triggers the proposal, which
      // flows through the existing Accept/apply path.
      if (this.restoreVersionOps.has(request.op)) return this.answerRestoreVersionRequest(request);
      // Liveness = the REQUEST is still present (includeAnswered: a hostile
      // peer squatting a forged response must not flip a live request "dead").
      const isRequestLive = (): boolean =>
        this.link === link &&
        readControlRequests(link.host, { includeAnswered: true }).some(
          (r) => r.id === request.id,
        );
      return answerControlRequest(request, {
        configuredSyncUrl: syncUrl,
        controlRoom,
        listProjects: this.deps.listProjects,
        listVersions: this.deps.listVersions,
        createProject: (name) => this.deps.createProject(name),
        openProjectForControl: (projectId) => this.callOpenHandler(projectId, isRequestLive),
        // The version-file ops are intercepted ABOVE (consent-gated via
        // answerVersionFileRequest) and never reach this metadata core, so this
        // seam is unreachable here — wire a fail-closed stub (returning the real
        // ungated tree here would bypass the content-consent gate). Consent lives
        // in answerVersionFileRequest, in front of the gated seam.
        versionTree: async () => null,
      });
    };

    const drain = (): void => {
      // Detached after a disable() — never answer on a stale doc.
      if (this.link !== link) return;
      void this.runDrain(link, answer);
    };
    this.unobserve = observeControlRequests(link.host, drain);
    // Requests that replicated before the observer attached (mirrors the
    // reference responder's startup drain).
    drain();

    // B2 (ADR-0026): a FRESH enable() also mints a one-time pairing code and joins
    // the derived pairing room to hand the (just-set) control room + responseKey to
    // the kernel's handshake. A RESUME does not (the kernel re-runs from its durable
    // store), so no code is shown until a fresh enable().
    if (mintCode) this.startPairing(controlRoom, syncUrl, responseKey);

    this.emit();
  }

  // -------------------------------------------------------------------------
  // B2 pairing handshake (ADR-0026) — the browser side of the one-time code.
  // -------------------------------------------------------------------------

  /**
   * Mint a one-time pairing code, derive (from the code only) the pairing room +
   * bootstrap mac/seal keys, join the pairing room, and listen for the kernel's
   * CLAIM. On a VALID claim (claimMac verified constant-time BEFORE the code is
   * consumed), SEAL `{syncUrl, controlRoom, responseKey}` under the seal key
   * (AES-256-GCM, AAD = nonce/requestId/room) and respond, then CONSUME the code
   * (one-time — a second claim is ignored). A 10-minute TTL voids an unclaimed
   * code. The code is the ONLY thing surfaced (the pairing command); the secret
   * responseKey is encrypted in transit and never appears in any message.
   *
   * OPTIONAL + best-effort: with no `joinPairingRoom` dep, no pairing room is
   * joined and the code stays voided (legacy/manual flow). A mint/derive failure
   * leaves the responder fully live on the control room — only the code-pairing
   * convenience is absent.
   */
  private startPairing(controlRoom: string, syncUrl: string, responseKey: Uint8Array): void {
    const join = this.deps.joinPairingRoom;
    if (join === undefined) {
      // No code-pairing in this build/test — the responder is still live; the
      // command just won't appear (pairingCode stays null).
      this.pairingVoided = true;
      return;
    }
    let code: string;
    try {
      code = (this.deps.mintPairingCode ?? mintPairingCode)();
    } catch {
      this.pairingVoided = true;
      return; // no secure RNG — skip code-pairing, the responder stays live
    }
    this.pairingCode = code;
    this.pairingVoided = false;

    void (async () => {
      let bootstrap: Awaited<ReturnType<typeof deriveBootstrap>>;
      try {
        bootstrap = await deriveBootstrap(code);
      } catch {
        this.voidPairing();
        return;
      }
      // A disable()/re-enable raced the async derive — abandon this code.
      if (this.pairingCode !== code) return;

      // #3 (ADR-0026): under auth-on the relay only admits a REGISTERED capability
      // room. The pairing room is a `share-` capability minted by THIS signed-in
      // session — register it (as a session-bounded `control`-kind room) BEFORE the
      // cookie-less kernel tries to join, else the kernel's join is denied. Auth-off
      // (the default + the unit gate) skips this entirely. A failed registration
      // voids the code (the responder stays live; the user re-enables).
      if (this.authActive() && this.deps.registerControlRoom !== undefined) {
        let ok = false;
        try {
          const res = await this.deps.registerControlRoom(bootstrap.pairingRoom);
          ok = res.ok;
        } catch {
          ok = false;
        }
        if (this.pairingCode !== code) return; // raced a disable/re-enable
        if (!ok) {
          this.voidPairing();
          return;
        }
        this.registeredPairingRoom = bootstrap.pairingRoom;
      }

      const link = join(bootstrap.pairingRoom, syncUrl);
      this.pairingLink = link;

      const drain = (): void => {
        if (this.pairingLink !== link) return; // detached
        void this.runPairingDrain(link, code, bootstrap, controlRoom, syncUrl, responseKey);
      };
      this.pairingUnobserve = observeControlRequests(link.host, drain);
      drain(); // claims that replicated before the observer attached

      // 10-minute TTL (ADR-0026): an unclaimed code voids itself.
      const ttl = this.deps.pairingCodeTtlMs?.() ?? PAIRING_CODE_TTL_MS;
      this.pairingTtlTimer = setTimeout(() => this.voidPairing(), ttl);
    })();
  }

  /**
   * One pairing-room drain pass: find the kernel's `pairing_claim`, VERIFY the
   * claimMac under the derived mac key (constant-time) BEFORE consuming the code,
   * SEAL the payload, respond, and consume the code (one-time). A claim whose MAC
   * does not verify is answered with a generic refusal (no oracle) and the code is
   * NOT consumed. The drain is a no-op once the code is voided/consumed.
   */
  private async runPairingDrain(
    link: ControlLink,
    code: string,
    bootstrap: Awaited<ReturnType<typeof deriveBootstrap>>,
    controlRoom: string,
    syncUrl: string,
    responseKey: Uint8Array,
  ): Promise<void> {
    if (this.pairingLink !== link || this.pairingVoided || this.pairingCode !== code) return;
    for (const request of readControlRequests(link.host, { includeAnswered: true })) {
      if (this.pairingLink !== link || this.pairingVoided) return;
      if (request.op !== PAIRING_CLAIM_OP) continue;
      const ephPubB64 = request.params["ephPub"];
      const nonceB64 = request.params["nonce"];
      const claimMac = request.params["claimMac"];
      if (typeof ephPubB64 !== "string" || typeof nonceB64 !== "string" || typeof claimMac !== "string") {
        continue;
      }
      const nonce = base64UrlToBytes(nonceB64);
      const kernelPub = base64UrlToBytes(ephPubB64);
      if (nonce === null || kernelPub === null || kernelPub.length !== PAIRING_EPH_PUBLIC_BYTES) {
        continue;
      }
      // #2: bind the ACTUAL mailbox request.id (the map key) — NEVER a peer-supplied
      // param. The kernel's claimMac covers request.id, so a captured claim copied
      // onto a SECOND mailbox id fails this verify (the recomputed id differs), and
      // the code is NOT consumed for a foreign id.
      const requestId = request.id;
      // VERIFY the kernel's proof (direction="kernel") BEFORE consuming the code.
      let ok: boolean;
      try {
        ok = await verifyClaimMac(
          bootstrap.macKey,
          { direction: "kernel", ephPublicRaw: kernelPub, nonce, requestId },
          claimMac,
        );
      } catch {
        ok = false;
      }
      // A racing void/consume during the await invalidates this answer.
      if (this.pairingLink !== link || this.pairingVoided) return;
      if (!ok) {
        // No oracle: a generic refusal, code NOT consumed (an attacker guessing
        // the code can keep trying until TTL — but the code is unguessable).
        try {
          publishControlResponse(
            link.host,
            { id: request.id, ok: false, error: "pairing claim rejected" },
            RESPONDER_AUTHOR,
            { overwrite: true },
          );
        } catch {
          // best-effort
        }
        continue;
      }
      // CONSUME the code NOW (one-time): void before the async seal so a second,
      // concurrent claim cannot also be sealed.
      this.pairingCode = null;
      this.pairingVoided = true;

      // Forward secrecy: mint OUR OWN ephemeral ECDH keypair, derive the seal key
      // from ECDH(browser eph priv, kernel eph pub) ‖ codeSecret, and DISCARD the
      // private key when this scope returns. A recorded transcript + a later code
      // leak then cannot recover the responseKey (no ephemeral private key).
      let result: { bEphPub: string; bClaimMac: string; sealed: { iv: string; ct: string } };
      try {
        const browserEph = await generateEphemeralKeyPair();
        const browserPubRaw = await exportEphemeralPublic(browserEph);
        const sealKey = await deriveSealKey(
          browserEph.privateKey,
          kernelPub,
          bootstrap.codeSecret,
          nonce,
        );
        // Authenticate OUR ephemeral pubkey too (direction="browser"), binding the
        // same nonce + request.id — so the kernel knows the response is from the
        // code-holder, not a peer, and cannot be a reflected kernel claim.
        const bClaimMac = await computeClaimMac(bootstrap.macKey, {
          direction: "browser",
          ephPublicRaw: browserPubRaw,
          nonce,
          requestId,
        });
        const sealed = await sealPairingPayload(
          sealKey,
          { syncUrl, controlRoom, responseKey: bytesToBase64Url(responseKey) },
          { nonce: nonceB64, requestId, pairingRoom: bootstrap.pairingRoom },
        );
        result = { bEphPub: bytesToBase64Url(browserPubRaw), bClaimMac, sealed };
      } catch {
        // Crypto failed — the code is already voided; tear down (the kernel times out).
        this.stopPairing();
        this.emit();
        return;
      }
      if (this.pairingLink !== link) {
        this.stopPairing();
        this.emit();
        return;
      }
      try {
        publishControlResponse(
          link.host,
          { id: request.id, ok: true, result: result as unknown },
          RESPONDER_AUTHOR,
          { overwrite: true },
        );
      } catch {
        // best-effort — the kernel times out and the user re-pairs
      }
      // The code is consumed; tear down the transient pairing room and surface the
      // now-null command. The control room responder stays live.
      this.stopPairing();
      this.emit();
      return;
    }
    if (this.pairingLink === link) pruneControlMailbox(link.host, RESPONDER_AUTHOR);
  }

  /** Void the code (TTL/consume) and tear down the pairing room; surface the change. */
  private voidPairing(): void {
    if (this.pairingVoided && this.pairingLink === undefined) return;
    this.pairingCode = null;
    this.pairingVoided = true;
    this.stopPairing();
    this.emit();
  }

  /** Tear down the transient pairing-room link + observer + TTL timer (idempotent). */
  private stopPairing(): void {
    if (this.pairingTtlTimer !== undefined) {
      clearTimeout(this.pairingTtlTimer);
      this.pairingTtlTimer = undefined;
    }
    this.pairingUnobserve?.();
    this.pairingUnobserve = undefined;
    const link = this.pairingLink;
    this.pairingLink = undefined;
    link?.destroy();
    // #3: best-effort server-side revoke of the registered pairing room (auth-on),
    // never awaited — the transient room also expires with the registering session.
    const registered = this.registeredPairingRoom;
    this.registeredPairingRoom = null;
    if (registered !== null) {
      try {
        void (this.deps.revokeControlRoom ?? revokeCapabilityRoomBestEffort)(registered);
      } catch {
        // best-effort only
      }
    }
  }

  /**
   * One drain pass (mirrors fake-control-responder): answer each unanswered
   * request EXACTLY ONCE, then run the responder GC on EVERY wake (answered or
   * not). open_project now flows through the core → the open seam → the
   * ProjectApp consent handler (no pre-filter); guardrail #5 (below) protects
   * against publishing a share into an already-withdrawn request.
   */
  private async runDrain(
    link: ControlLink,
    answer: (request: ControlRequest) => Promise<ControlResponseInput>,
  ): Promise<void> {
    // includeAnswered (HIGH-1 anti-squatting): a hostile peer can write a
    // forged response onto a fresh request before we ever see it; the default
    // read mode would then hide that request from us FOREVER while the kernel
    // (which rejects the forged signature) waits in vain. So this loop sees
    // squatted requests too and skips only what IT already answered (the
    // bounded local FIFO) — publishing with overwrite, so the authentic,
    // signed verdict replaces any squatter. A FIFO-evicted id (needs > cap
    // in-flight ids, attacker-driven only) is at worst re-answered with an
    // identical fresh verdict — never double-acted-upon by the kernel.
    for (const request of readControlRequests(link.host, { includeAnswered: true })) {
      if (this.link !== link) return; // disabled mid-pass
      if (this.answered.has(request.id)) continue;
      // Mark BEFORE awaiting so a re-entrant observer wake during the await does
      // not double-process (bounded FIFO; H1).
      this.markAnswered(request.id);

      let response: ControlResponseInput = await answer(request);

      // The async answer may have raced a disable(); don't publish on a dead link.
      if (this.link !== link) return;

      // GUARDRAIL #5 (orphan-capability leak): open_project consent can take many
      // seconds; the kernel may WITHDRAW its request on its own timeout while we
      // wait. If the now-successful answer would hand back a freshly minted SHARE
      // ROOM but the request is no longer live, publishing it would leak that
      // capability into an orphan response no requester will read. Re-check the
      // request is still present (includeAnswered — a squatted forged response
      // must not make a live request look withdrawn); if it vanished, SKIP
      // publishing the ok:true and continue (prune still runs). A refusal
      // (ok:false) carries no capability, so it's harmless to drop too — but we
      // only gate the success path.
      if (response.ok && request.op === "open_project") {
        const stillLive = readControlRequests(link.host, { includeAnswered: true }).some(
          (r) => r.id === request.id,
        );
        if (!stillLive) continue;
      }

      // HIGH-1: SIGN the verdict with the session response key, then publish
      // with the responder's overwrite privilege — a forged squatter response
      // is replaced, and only THIS signature passes the kernel's verifier.
      response = await this.signResponse(response);

      // The signing await may also have raced a disable().
      if (this.link !== link) return;

      // H2: never let one bad response wedge the pass. publishControlResponse
      // THROWS on an over-limit record (a metadata response should never be, but
      // fail-closed): catch it and publish a small ok:false instead, so the id is
      // not left marked-answered-but-unpublished and the loop keeps draining.
      try {
        publishControlResponse(link.host, response, RESPONDER_AUTHOR, { overwrite: true });
      } catch {
        try {
          const fallback = await this.signResponse({
            id: request.id,
            ok: false,
            error: "the responder could not encode a response",
          });
          if (this.link !== link) return;
          publishControlResponse(link.host, fallback, RESPONDER_AUTHOR, { overwrite: true });
        } catch {
          // Even the tiny fail response could not be written (doc gone / racing
          // teardown). Nothing more to do for this id; continue the pass so prune
          // still runs and other requests are still served.
        }
      }
    }
    // Responder GC (contract step 4): the hard-bounds pass runs on every wake,
    // even if a per-request publish above failed.
    if (this.link === link) pruneControlMailbox(link.host, RESPONDER_AUTHOR);
  }

  /**
   * Attach the HMAC-SHA-256 response signature (HIGH-1). With no key (disabled
   * race) or a signing failure, the response goes out UNSIGNED — fail-closed
   * for integrity: the kernel ignores it and the RPC times out, rather than
   * anything ever vouching for an unauthenticated verdict.
   */
  private async signResponse(response: ControlResponseInput): Promise<ControlResponseInput> {
    const key = this.responseKey;
    if (key === null) return response;
    try {
      const sig = await hmacControlResponse(key, controlResponseSigningString(response));
      return { ...response, sig };
    } catch {
      return response;
    }
  }

  /**
   * Answer one READ-ONLY TOOL op (#1 slice 1). The order here IS the security
   * design — think of each step as a wall the request must pass:
   *
   *   1. projectId is MANDATORY (string, bounded). Without it: a static refusal.
   *   2. THE CONSENT GATE, synchronous and FIRST: no content grant for that
   *      projectId → the static `consent-required` refusal. Nothing async has
   *      run yet — no store opened, no membership probed — so an ungranted
   *      request cannot distinguish an existing project from a made-up id, and
   *      cannot burn IO. The grant set is re-read on EVERY request (a revoke
   *      in the settings UI bites immediately).
   *   3. Only then are the project files resolved (membership-checked,
   *      read-only) and the seams built PER REQUEST — never cached across
   *      requests, never shared mutable state.
   *   4. The pure adapter dispatches: read-only registry entries only;
   *      mutating ops (propose_edit) and unknown names are refused inside it.
   *
   * Never throws; any failure is a static generic refusal.
   */
  private async answerToolRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      const resolve = this.deps.projectFilesForTools;
      const project = resolve === undefined ? null : await resolve(projectId);
      if (project === null) return { id, ok: false, error: TOOL_FAILED_ERROR };
      return await answerReadonlyToolRequest(request, buildControlToolSeams(project));
    } catch {
      // Fail-closed: a seam/store failure is refused with a static string,
      // never surfaced (an underlying message could leak internals).
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one VERSION-FILE op (B4) — `list_version_files` / `read_version_file`.
   * The SAME wall order as {@link answerToolRequest}: projectId mandatory, then
   * the synchronous content-consent gate FIRST (no store touched before it), then
   * the version-tree seam resolved fresh PER REQUEST (membership + version⇄project
   * bound in the production seam), then the pure core does the path/size shaping.
   * Never throws; any failure is a static generic refusal — these ops are
   * READ-ONLY (no restore, no mutate).
   */
  private async answerVersionFileRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      const resolve = this.deps.projectVersionTree;
      if (resolve === undefined) return { id, ok: false, error: TOOL_FAILED_ERROR };
      // The pure core reads the tree through this seam (the consent gate already
      // passed for this projectId); it validates versionId/path + bounds the result.
      return await answerVersionFileRequest(request, (pid, versionId) => resolve(pid, versionId));
    } catch {
      // Fail-closed: a seam/store failure is refused with a static string,
      // never surfaced (an underlying message could leak internals).
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one `export_compiled` request (A1). The SAME wall order as the other
   * content ops: projectId mandatory, the synchronous content-consent gate FIRST
   * (no compile/push before it), then the export handler (resolved fresh PER
   * REQUEST via the registered ProjectApp slot). The pure core validates the
   * transferId/maxBytes params + shapes the signed descriptor. Never throws; any
   * failure is a static generic refusal. The export itself is READ-ONLY (it
   * compiles + pushes the current build, never mutates the project).
   */
  private async answerExportCompiledRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      // The pure core validates transferId/maxBytes + shapes the response; the
      // handler (read at CALL time) compiles + pushes the PDF under the transferId.
      const seam: ExportCompiledSeam = (pid, transferId, maxBytes) =>
        this.callExportHandler(pid, transferId, maxBytes);
      return await answerExportCompiledRequest(request, seam);
    } catch {
      // Fail-closed: a seam/handler failure is refused with a static string,
      // never surfaced (an underlying message could leak internals).
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one `compile` request (F9/F5). The SAME wall order as the other content
   * ops: projectId mandatory, the synchronous content-consent gate FIRST (no
   * diagnostics read before it — compile exposes build feedback over the project
   * text), then the compile handler (resolved fresh PER REQUEST via the registered
   * ProjectApp slot). The pure core validates the params + shapes/bounds the
   * diagnostics. Never throws; any failure is a static generic refusal. The compile
   * is DIAGNOSTICS-ONLY (it reads the live preview's diagnostics, never mutates the
   * project, never pushes bytes).
   */
  private async answerCompileRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      // The pure core validates the projectId + bounds the diagnostics; the handler
      // (read at CALL time) reads the open project's live preview diagnostics.
      const seam: CompileSeam = (pid) => this.callCompileHandler(pid);
      return await answerCompileRequest(request, seam);
    } catch {
      // Fail-closed: a seam/handler failure is refused with a static string,
      // never surfaced (an underlying message could leak internals).
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one `expect_blob` request (A2). The SAME wall order as the other
   * content ops: projectId mandatory, the synchronous content-consent gate FIRST
   * (no channel reservation before it), then the pure core validates hash/size and
   * calls the registered ProjectApp handler (resolved fresh PER REQUEST) to reserve
   * inbound capacity on the open project's blob channel. Reserving capacity commits
   * browser buffer quota for a binary the kernel is about to push, so it must sit
   * behind the same consent as the content ops. Never throws; any failure is a
   * static generic refusal.
   */
  private async answerExpectBlobRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      const seam: ExpectBlobSeam = (pid, hash, size) =>
        this.callExpectBlobHandler(pid, hash, size);
      return await answerExpectBlobRequest(request, seam);
    } catch {
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one `release_blob` request (A2/C1b). Same wall order as expect_blob:
   * projectId mandatory, content-consent gate FIRST, then the pure core validates
   * the hashes array and the ProjectApp handler drops the reservations. Never throws.
   */
  private async answerReleaseBlobRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      const seam: ReleaseBlobSeam = (pid, hashes) => this.callReleaseBlobHandler(pid, hashes);
      return await answerReleaseBlobRequest(request, seam);
    } catch {
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * Answer one `request_restore_version` request (B3). The SAME wall order as the
   * other content ops: projectId mandatory, the synchronous content-consent gate
   * FIRST (no live read, no publish before it), then the pure core computes the
   * diff and publishes via the ProjectApp restore handler (resolved fresh PER
   * REQUEST). NEVER a direct mutation — the handler only publishes a NORMAL file
   * proposal that flows through the existing Accept/apply path. Never throws; any
   * failure is a static generic refusal.
   *
   *   - `liveFileSet` / `publishRestore` come from the registered restore handler;
   *     with NO handler (nothing open) the live set resolves null → the pure core
   *     answers the structured `not_open` refusal (it can't restore into the void).
   *   - `versionTree` is the B4 idb version-tree seam (the restore TARGET source,
   *     version⇄project bound, membership-checked in the production default).
   *   - `versionName` is derived from the same `listVersions` metadata (find by id).
   */
  private async answerRestoreVersionRequest(request: ControlRequest): Promise<ControlResponseInput> {
    const { id, params } = request;
    try {
      const projectId = params["projectId"];
      if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
        return { id, ok: false, error: TOOL_PROJECT_ID_REQUIRED_ERROR };
      }
      if (!isContentGranted(this.deps.sessionStore, projectId)) {
        return { id, ok: false, error: CONTENT_CONSENT_REQUIRED_ERROR };
      }
      const seams: RestoreVersionSeams = {
        // The restore handler (read at CALL time) owns BOTH live halves. No handler
        // → no project open → null live set → the core's structured not_open refusal.
        liveFileSet: (pid) => this.callRestoreLiveFileSet(pid),
        // The B4 idb version-tree seam supplies the restore TARGET. Absent → null
        // (the core maps it to unknown_version), fail-closed.
        versionTree: (pid, versionId) =>
          this.deps.projectVersionTree?.(pid, versionId) ?? Promise.resolve(null),
        // The version's display NAME for the proposal title, from the SAME
        // metadata listVersions surfaces (membership-checked, version⇄project bound).
        versionName: (pid, versionId) => this.resolveVersionName(pid, versionId),
        // Publishing happens in the OPEN project's live doc — only the registered
        // handler has it. No handler → publish throws → the core fails closed.
        publishRestore: (input) => this.callRestorePublish(input),
      };
      return await answerRestoreVersionRequest(request, seams);
    } catch {
      // Fail-closed: a seam/handler failure is refused with a static string,
      // never surfaced (an underlying message could leak internals).
      return { id, ok: false, error: TOOL_FAILED_ERROR };
    }
  }

  /**
   * The live-file-set half of the restore handler (B3), resolved against the
   * CURRENT registered handler at CALL time. No handler → null (nothing open to
   * restore — the pure core maps that to the structured not_open refusal).
   */
  private async callRestoreLiveFileSet(projectId: string): Promise<RestoreFile[] | null> {
    const handler = this.restoreHandler;
    if (handler === null) return null;
    return handler.liveFileSet(projectId);
  }

  /**
   * The publish half of the restore handler (B3), resolved at CALL time. With no
   * handler there is no live doc to publish into — throw so the pure core fails
   * closed (a restore can only publish into an open project). The core wraps this
   * throw into a generic refusal; it is only reached AFTER a non-null live set,
   * so in practice the same handler that produced the diff publishes it.
   */
  private async callRestorePublish(input: {
    request: string;
    ops: FileProposalOp[];
  }): Promise<string> {
    const handler = this.restoreHandler;
    if (handler === null) throw new Error("no project is open to publish the restore proposal");
    return handler.publish(input);
  }

  /**
   * Resolve a version's display name from the project's version metadata (B3) —
   * the SAME `listVersions` seam list_versions surfaces (membership-authorized,
   * version⇄project bound), so a leaked/foreign version id resolves null and the
   * core refuses with unknown_version. Returns null when the project is unknown
   * (listVersions null) or the id is not among its versions.
   */
  private async resolveVersionName(projectId: string, versionId: string): Promise<string | null> {
    const versions = await this.deps.listVersions(projectId);
    if (versions === null) return null;
    const match = versions.find((v) => v.id === versionId);
    return match?.name ?? null;
  }

  // -------------------------------------------------------------------------
  // Grant persistence + the grant-scoped proposal verifier (ADR-0023 §1/§4).
  // -------------------------------------------------------------------------

  /**
   * RESUME the persisted grant on startSession: re-parse the blob with the live
   * `responseKey`. The epoch is captured so a disable()/fresh-enable that races
   * the async parse cannot install a stale grant. A MAC mismatch / absent blob
   * leaves no active grant (fail-closed). Best-effort: never throws.
   */
  private async loadPersistedGrant(responseKey: Uint8Array): Promise<void> {
    const epoch = this.enableEpoch;
    let raw: string | null;
    try {
      raw = this.deps.sessionStore?.getItem(AGENT_ACCESS_GRANT_KEY) ?? null;
    } catch {
      return; // storage access threw (privacy mode) — no grant
    }
    const grant = await parseGrant(raw, responseKey);
    // A disable()/re-enable while we were parsing invalidates this load.
    if (this.enableEpoch !== epoch || this.responseKey !== responseKey) return;
    if (grant === null) return;
    // A recordGrant during the async parse already installed a fresher grant —
    // never clobber it with the resumed (older) blob.
    if (this.grant !== null) return;
    this.grant = grant;
    this.verifyKeys = null; // fresh keys derive lazily against the loaded grant
    this.emit();
  }

  recordGrant(grant: ProposalGrant): void {
    // No live key → nothing can MAC it; a grant without a session is meaningless.
    const key = this.responseKey;
    if (key === null) return;
    this.grant = grant;
    this.verifyKeys = null; // the scope changed → drop memoized verify keys
    void this.persistGrant(grant, key, ++this.grantPersistEpoch);
    this.emit();
  }

  getActiveGrant(): ProposalGrant | null {
    return this.grant;
  }

  grantContentForActiveGrant(): void {
    const grant = this.grant;
    if (grant === null) return;
    // Mint into the SAME store the seven tool gates read (this.deps.sessionStore),
    // so the open_project consent that recorded this grant also satisfies
    // isContentGranted for its project — one consent, both authorities.
    grantContentAccess(this.deps.sessionStore, grant.projectId);
  }

  /**
   * SCOPED grant read (H1): the active grant only when it is THIS project's
   * (and, when supplied, THIS share room's). A grant from another project/room is
   * a different authorization context — returning it would let a project-B UI
   * read project-A's Auto disposition (privilege carry-over). Fail closed → null
   * on any scope mismatch.
   */
  getActiveGrantForProject(projectId: string, shareRoom?: string): ProposalGrant | null {
    const grant = this.grant;
    if (grant === null) return null;
    if (grant.projectId !== projectId) return null;
    if (shareRoom !== undefined && grant.shareRoom !== shareRoom) return null;
    return grant;
  }

  setGrantMode(mode: "ask" | "auto"): void {
    const key = this.responseKey;
    const grant = this.grant;
    if (key === null || grant === null) return;
    if (grant.mode === mode) return;
    const next: ProposalGrant = { ...grant, mode };
    this.grant = next;
    // `mode` is NOT part of the verifier scope, but it IS MAC'd — re-MAC +
    // re-persist so the flipped disposition survives a reload. Verify keys are
    // scope-derived (grant id/room/etc.), so they need not be dropped here. The
    // epoch bump ensures a slow earlier write can never land after this one (High-3).
    void this.persistGrant(next, key, ++this.grantPersistEpoch);
    this.emit();
  }

  setGrantPersistentAccess(on: boolean): void {
    const key = this.responseKey;
    const grant = this.grant;
    if (key === null || grant === null) return;
    const current = grant.persistentAccess === true;
    if (current === on) return;
    // `persistentAccess` is MAC-COVERED (proposal-grant.ts grantArray): re-MAC +
    // re-persist so the standing-access flip survives a reload and a tampered blob
    // that flips it is rejected. Only set the field when true so an OFF grant MACs
    // byte-identically to a legacy/pre-F13 blob (the spread drops an undefined key).
    const next: ProposalGrant = { ...grant };
    if (on) next.persistentAccess = true;
    else delete next.persistentAccess;
    this.grant = next;
    // The flag is not part of the verifier scope, so verify keys need not drop.
    void this.persistGrant(next, key, ++this.grantPersistEpoch);
    // Turning standing access ON also grants per-project file (read) access so the
    // background host can materialise the doc — one toggle, both authorities. (OFF
    // does NOT revoke content access; Revoke is the explicit teardown.)
    if (on) grantContentAccess(this.deps.sessionStore, next.projectId);
    this.emit();
  }

  getProposalVerifier(): ProposalVerifier | null {
    const key = this.responseKey;
    const grant = this.grant;
    if (key === null || grant === null) return null;
    const { controlRoom, syncUrl, projectId, shareRoom, grantId } = grant;
    if (this.verifyKeys === null) this.verifyKeys = new Map();
    const keys = this.verifyKeys;
    const scopeFor = (mailbox: "mcpProposals" | "mcpFileProposals"): ProposalScope => ({
      grantId,
      controlRoom,
      syncUrl,
      projectId,
      shareRoom,
      mailbox,
    });
    const keyFor = (scope: ProposalScope): ReturnType<typeof deriveProposalKey> => {
      const existing = keys.get(scope.mailbox);
      if (existing !== undefined) return existing;
      const derived = deriveProposalKey(key, scope);
      keys.set(scope.mailbox, derived);
      return derived;
    };
    return {
      scopeFor,
      verifyFor: async (scope, signable, sig) => {
        try {
          const K = await keyFor(scope);
          return await verifyProposal(K, scope, signable, sig);
        } catch {
          return false; // FAIL CLOSED: any throw → unauthenticated
        }
      },
    };
  }

  getBlobTerminalAuth(): { terminalSigner: BlobTerminalSigner; terminalVerifier: BlobTerminalVerifier } | null {
    const key = this.responseKey;
    const grant = this.grant;
    if (key === null || grant === null) return null;
    // Build from the SAME per-grant key + scope the kernel uses to SIGN its
    // COMPLETE (the kernel is the RECEIVER of the export bytes). The browser is the
    // SENDER; it uses the VERIFIER so an unsigned/forged COMPLETE is rejected and
    // `send().done` never resolves — the export descriptor is only returned after a
    // VERIFIED COMPLETE. The signer is included for symmetry (the browser may also
    // RECEIVE blobs over the same channel, e.g. an import push).
    const { grantId, controlRoom, syncUrl, projectId, shareRoom } = grant;
    return buildBlobTerminalAuth(key, { grantId, controlRoom, syncUrl, projectId, shareRoom });
  }

  buildBlobTerminalAuthForScope(scope: {
    grantId: string;
    controlRoom: string;
    syncUrl: string;
    projectId: string;
    shareRoom: string;
  }): { terminalSigner: BlobTerminalSigner; terminalVerifier: BlobTerminalVerifier } | null {
    const key = this.responseKey;
    if (key === null) return null;
    return buildBlobTerminalAuth(key, scope);
  }

  getAudit(): AutoAcceptAudit | null {
    const grant = this.grant;
    const store = this.deps.sessionStore;
    if (grant === null || store === null) return null;
    return new AutoAcceptAudit(store, grant.grantId);
  }

  clearActiveGrant(): void {
    // No grant → nothing to do (idempotent; avoids a spurious emit/store touch).
    if (this.grant === null) return;
    // Reuse the EXACT clearing the Revoke path runs (epoch bump, audit clear,
    // verifier-key drop, persisted-key removal) — but keep the session (control
    // room + responseKey) live: only the share GRANT is withdrawn. Emit so the
    // ProjectApp grant mirror (bar visibility, the rebind effect) updates.
    this.clearGrant();
    this.emit();
  }

  /**
   * Best-effort MAC + persist of a grant; never throws. The MAC is async, so a
   * concurrent recordGrant/setGrantMode/clearGrant may have superseded this
   * write by the time the MAC resolves — `epoch` guards it so ONLY the latest
   * intent reaches storage (High-3: no stale-write resurrection).
   */
  private async persistGrant(
    grant: ProposalGrant,
    responseKey: Uint8Array,
    epoch: number,
  ): Promise<void> {
    try {
      const mac = await macGrant(responseKey, grant);
      if (epoch !== this.grantPersistEpoch) return; // a newer write/clear superseded us
      this.deps.sessionStore?.setItem(AGENT_ACCESS_GRANT_KEY, serializeGrant(grant, mac));
    } catch {
      // best-effort: a failed MAC/write just means no re-bind next load (fail-closed)
    }
  }

  /** Clear the persisted + in-memory grant AND its tombstone audit (Revoke). */
  private clearGrant(): void {
    // Bump the persist epoch so any in-flight persistGrant (a racing arm) cannot
    // write a grant blob back AFTER this clear (High-3).
    this.grantPersistEpoch++;
    // Clear the audit FIRST so no orphan tombstone blob is left behind. On a normal
    // Revoke `this.grant` is set and getAudit() reads its grantId. But on the
    // constructor no-resume path `this.grant` is still null (it only loads via
    // resume), so getAudit() returns null — recover the orphan grantId from the
    // persisted grant blob (a plaintext JSON field; no MAC needed since it only
    // computes a storage key to DELETE, granting no access) and clear that audit
    // blob so closed/malformed sessions don't accrete permanent localStorage cruft.
    const audit = this.getAudit();
    if (audit !== null) audit.clear();
    else this.clearOrphanAudit();
    // F13: drop the per-grant headless `lastActiveAt` stamp too (Revoke must leave no
    // standing-access residue). Use the live grant's id, or recover the orphan id from
    // the persisted blob (a plaintext field used only to compute a key to DELETE).
    const grantId = this.grant?.grantId ?? this.persistedGrantIdBestEffort();
    if (grantId !== null) clearHeadlessStamp(this.deps.sessionStore, grantId);
    this.grant = null;
    this.verifyKeys = null;
    try {
      this.deps.sessionStore?.removeItem(AGENT_ACCESS_GRANT_KEY);
    } catch {
      // best-effort
    }
  }

  /**
   * Best-effort read of the persisted grant blob's plaintext `grantId` (F13) — used
   * ONLY to compute the localStorage keys of the audit + headless stamp to DELETE on
   * an orphan-clear path where `this.grant` is null. The id authenticates nothing
   * here (no access is granted by reading it), so no MAC check is needed. Null on
   * absent/malformed/throwing storage.
   */
  private persistedGrantIdBestEffort(): string | null {
    const store = this.deps.sessionStore;
    if (store === null) return null;
    let raw: string | null;
    try {
      raw = store.getItem(AGENT_ACCESS_GRANT_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const id = (JSON.parse(raw) as Record<string, unknown>)["grantId"];
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * Delete the audit blob of an ORPHAN grant (no live `this.grant`) by reading the
   * grantId from the persisted grant blob. The id is used ONLY to compute the
   * localStorage key to remove — it authenticates nothing, so no MAC check is
   * needed. Best-effort; never throws.
   */
  private clearOrphanAudit(): void {
    const store = this.deps.sessionStore;
    if (store === null) return;
    let raw: string | null;
    try {
      raw = store.getItem(AGENT_ACCESS_GRANT_KEY);
    } catch {
      return;
    }
    if (raw === null) return;
    let grantId: unknown;
    try {
      grantId = (JSON.parse(raw) as Record<string, unknown>)["grantId"];
    } catch {
      return; // malformed blob: nothing recoverable to clean
    }
    if (typeof grantId !== "string" || grantId === "") return;
    try {
      store.removeItem(auditStorageKey(grantId));
    } catch {
      // best-effort
    }
  }

  disable(): void {
    // Cancel an in-flight auth-on registration (#1 slice 2): the epoch bump
    // makes its continuation a no-op, so a Revoke during "Enabling…" can never
    // be raced into a live session afterwards. (The room may still get
    // registered server-side; it is never joined, expires with the session,
    // and the next enable() mints a fresh one.)
    this.enableEpoch++;
    if (this.pendingEnable) {
      this.pendingEnable = false;
      this.emit();
    }
    if (this.link === undefined) return;
    this.unobserve?.();
    this.unobserve = undefined;
    const link = this.link;
    this.link = undefined;
    this.controlRoom = null;
    this.syncUrl = null;
    // HIGH-1: destroy the response-auth key with the session (zero, then drop).
    // A revoked key never signs again; re-enable mints a FRESH one.
    this.responseKey?.fill(0);
    this.responseKey = null;
    // B2: void + tear down the transient pairing channel too — a revoked session's
    // code can never be claimed, and re-enable mints a fresh one.
    this.pairingCode = null;
    this.pairingVoided = true;
    this.stopPairing();
    this.answered.clear();
    this.clearSession();
    // #1 slice 2: revoke the registered control room server-side, BEST-EFFORT
    // and never awaited — the local teardown below must not depend on the
    // network, and the relay denies future joins once the tombstone lands
    // (live connections drain on disconnect; the record also expires with the
    // session regardless).
    const registered = this.registeredControlRoom;
    this.registeredControlRoom = null;
    if (registered !== null) {
      try {
        void (this.deps.revokeControlRoom ?? revokeCapabilityRoomBestEffort)(registered);
      } catch {
        // best-effort only
      }
    }
    // Destroy AFTER detaching so a racing async answer sees this.link === undefined.
    link.destroy();
    this.emit();
  }

  private clearSession(): void {
    try {
      this.deps.sessionStore?.removeItem(AGENT_ACCESS_SESSION_KEY);
    } catch {
      // best-effort
    }
    // ADR-0023 §4: Revoke clears the persisted + in-memory grant too — a revoked
    // capability's re-bind/verifier never returns.
    this.clearGrant();
    // Revoking Agent Access revokes EVERY per-project content grant too (#1
    // slice 1): the control room dies with the session, and the next enable()
    // starts from zero grants — a grant never outlives the session it was
    // given in.
    revokeAllContentGrants(this.deps.sessionStore);
  }
}

/**
 * Build the per-request {@link ToolSeams} for one resolved project (#1 slice 1).
 * Fresh state per request (no cross-request leakage); `read_document` maps to
 * the project's MAIN file (the closest control-surface analogue of "the
 * document" — covered by the same whole-project grant); `compile` has no
 * compiler on this surface, so its seam throws and the adapter converts that
 * into its generic fail-closed refusal. Mutating entries never reach a seam:
 * the adapter's access filter refuses them before any run.
 */
function buildControlToolSeams(project: ProjectToolFiles): ToolSeams {
  const files = project.files.map((f) => ({ fileId: f.path, path: f.path, text: f.text }));
  const main =
    project.mainPath === null ? undefined : project.files.find((f) => f.path === project.mainPath);
  return {
    state: {
      scratch: main?.text ?? "",
      blocks: [],
      lastCheck: null,
      lastViolations: [],
      compileIters: 0,
      failedConsecutive: 0,
    },
    compiler: {
      check: async () => {
        throw new Error("compile is not available over the control surface");
      },
    },
    max: 1,
    constraints: null,
    retrieval: { active: false },
    projectTools: buildProjectToolsSeam(() => files),
  };
}

/**
 * The real browser control-room join: a fresh `CollabDocument` joined to the
 * control room over a `WebSocketTransport`, the same primitive Share uses. The
 * responder is "just another peer" in the room.
 */
function joinControlRoomLive(controlRoom: string, syncUrl: string): ControlLink {
  const doc = new CollabDocument("");
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(controlRoom)}`;
  const connection = new CollabConnection(
    doc,
    new WebSocketTransport(() => new WebSocket(url) as unknown as WebSocketLike),
    { author: RESPONDER_AUTHOR },
  );
  connection.connect();
  return {
    host: doc,
    destroy() {
      connection.destroy();
      doc.destroy();
    },
  };
}

/**
 * Resolve the real localStorage, or null when unavailable (privacy mode / Node).
 * localStorage (NOT sessionStorage) so an enabled Agent Access session — its
 * capability AND its content grants — survives a reload, a tab-close, and a
 * browser restart, resuming on the next boot (operator decision; reverses the
 * original session-scoped posture). Revoke is the only thing that clears it.
 */
function defaultSessionStore(): SessionStoreLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // access can throw (privacy mode) — degrade to no persistence (no resume)
  }
  return null;
}

/** The production deps: real share-room mint, relay resolution, idb-backed seams. */
function defaultDeps(): ControlResponderMountDeps {
  // Built lazily so a disabled manager never constructs idb stores or touches the
  // user profile — the inert-by-default guarantee.
  let projectStore: IdbProjectStore | undefined;
  let versionStore: IdbVersionStore | undefined;
  const projects = (): IdbProjectStore => (projectStore ??= new IdbProjectStore());
  const versions = (): IdbVersionStore => (versionStore ??= new IdbVersionStore());

  return {
    mintControlRoom: () => mintShareRoom(),
    resolveSyncUrl: () => resolveSyncUrl(configuredSyncUrlOverride(), window.location),
    // The serve-time compile URL (window.__GALLEY_CONFIG__.compileUrl, same
    // source the in-app compiler reads) folded into the pairing command ONLY
    // when loopback — the self-host case where the kernel can reach it (F4).
    resolveKernelCompileUrl: () => {
      const cfg = (window as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__;
      const raw =
        typeof cfg === "object" && cfg !== null
          ? (cfg as { compileUrl?: unknown }).compileUrl
          : undefined;
      return loopbackCompileUrl(typeof raw === "string" ? raw : null);
    },
    currentUserId: () => loadLocalProfile().userId,
    listProjects: async () => {
      const userId = loadLocalProfile().userId;
      const rows = await projects().listProjectsForUser(userId);
      // Metadata only — the core strips again, but we never source file content.
      return rows.map((p) => ({ projectId: p.id, name: p.name }));
    },
    listVersions: async (projectId) => {
      // Authorize by membership: only enumerate versions of a project this user
      // owns/belongs to (fail-closed for an unknown/foreign id → null).
      const userId = loadLocalProfile().userId;
      const membership = await projects().getMembership(projectId, userId);
      if (membership === null) return null;
      // `listVersionMetadata` (not `listVersions`) so each row also carries its
      // `createdAt` (epoch ms) — `list_versions` over the control surface surfaces
      // creation time (F2). `message`/`createdAt` are included only when present so
      // legacy rows (no createdAt) and message-less versions stay omitted, never
      // `: undefined` (exactOptionalPropertyTypes; the VersionMeta the core relays).
      const rows = await versions().listVersionMetadata(projectId);
      return rows.map((v) => ({
        id: v.id,
        name: v.name,
        ...(v.message !== undefined ? { message: v.message } : {}),
        ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
      }));
    },
    // create_project (F1): register a REGISTRY-ONLY project under the local profile
    // user — no navigation, no CRDT seed (the editor seeds blank starter content on
    // first open). Gated only by the Agent Access pairing, like list_projects.
    createProject: async (name) => {
      const userId = loadLocalProfile().userId;
      return createLibraryProject(name, { store: projects(), ownerId: userId });
    },
    // The production open seam is the manager's tokenized handler registry, which
    // callOpenHandler consults FIRST; this deps entry is only the fallback when no
    // ProjectApp handler is registered — i.e. nothing is open to share.
    openProjectForControl: async () => ({ refused: NO_OPEN_HANDLER_REFUSAL }),
    joinControlRoom: joinControlRoomLive,
    // B2 (ADR-0026): the pairing room is joined the same way as the control room
    // (just another relay peer), and the code is minted from the shared CSPRNG.
    joinPairingRoom: joinControlRoomLive,
    mintPairingCode: () => mintPairingCode(),
    sessionStore: defaultSessionStore(),
    // #1 slice 2: under an auth-on deployment the control room must be
    // registered (cookie-authenticated) BEFORE pairing; Revoke tombstones it
    // best-effort. Both are inert with auth off (authActive gates them).
    authActive: () => capabilityAuthActive(),
    registerControlRoom: (roomId) => registerCapabilityRoom(roomId, "control"),
    revokeControlRoom: (roomId) => revokeCapabilityRoomBestEffort(roomId),
    // #1 slice 1: resolve a GRANTED project's visible files for the tool seams.
    // Called only after the consent gate. Membership-authorized (the same gate
    // listVersions applies), then a strictly read-only materialization of the
    // persisted CRDT — the live session's own persistence is undisturbed.
    projectFilesForTools: async (projectId) => {
      const userId = loadLocalProfile().userId;
      const membership = await projects().getMembership(projectId, userId);
      if (membership === null) return null;
      const tree = await materializeProjectTreeFromIdb(projectId);
      if (!tree.ok) return null;
      // Canonical leading-slash paths; the reserved `.galley/*` namespace (the
      // manifest + instructions the materializer carries) is NOT a project file
      // the file tree shows, so it is excluded from the tool-visible set.
      const files = tree.files
        .map((f) => ({ path: f.path.startsWith("/") ? f.path : `/${f.path}`, text: f.text }))
        .filter((f) => !isReservedProjectPath(f.path));
      let mainPath: string | null = null;
      const manifest = tree.files.find(
        (f) => f.path === ".galley/project.json" || f.path === "/.galley/project.json",
      );
      if (manifest !== undefined) {
        try {
          const main = (JSON.parse(manifest.text) as { main?: string | null }).main;
          mainPath = typeof main === "string" && main.length > 0 ? main : null;
        } catch {
          // a malformed manifest just means no main — read_document degrades
        }
      }
      return { files, mainPath };
    },
    // B4: resolve a GRANTED project's files AT a named version for the version-file
    // ops. Called only after the consent gate. Membership-authorized (the same gate
    // listVersions / projectFilesForTools apply), then a read-only project-scoped
    // tree read (getProjectVersionTree also binds version⇄project, so a leaked
    // version id can't read a foreign project). Paths canonicalized leading-slash;
    // the reserved `.galley/*` namespace excluded (the file tree doesn't show it).
    projectVersionTree: async (projectId, versionId) => {
      const userId = loadLocalProfile().userId;
      const membership = await projects().getMembership(projectId, userId);
      if (membership === null) return null;
      const tree = await versions().getProjectVersionTree(projectId, versionId);
      if (tree === null) return null;
      return tree
        .map((f) => ({ path: f.path.startsWith("/") ? f.path : `/${f.path}`, text: f.text }))
        .filter((f) => !isReservedProjectPath(f.path));
    },
  };
}

let singleton: ControlResponderMountManager | undefined;

/**
 * The module-scope singleton manager. The first call wires the deps (production
 * defaults, or test fakes); later calls return the same instance and ignore the
 * argument — the singleton is shared across the whole tab. Creating it is INERT:
 * nothing is minted/joined until `enable()` is called.
 */
export function getControlResponderManager(
  deps?: ControlResponderMountDeps,
): ControlResponderManager {
  if (singleton === undefined) {
    singleton = new ControlResponderMountManager(deps ?? defaultDeps());
  }
  return singleton;
}

/** Test-only: drop the singleton so each test starts from a clean module state. */
export function __resetControlResponderManagerForTests(): void {
  if (singleton?.isEnabled()) singleton.disable();
  singleton = undefined;
}

/** Test-only: the current size of the bounded answered-id cache (H1 assertion). */
export function __answeredCacheSizeForTests(mgr: ControlResponderManager): number {
  return (mgr as ControlResponderMountManager).answeredCacheSize();
}

/**
 * Test-only: the live session response-auth key (the secret the B2 pairing command
 * no longer carries). Tests that verify response SIGNATURES need it the way the
 * paired kernel learns it via the sealed handshake; expose it here rather than in
 * the (now code-only) pairing command.
 */
export function __responseKeyForTests(mgr: ControlResponderManager): Uint8Array | null {
  return (mgr as ControlResponderMountManager).responseKeyForTests();
}
