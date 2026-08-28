/**
 * The browser-side Agent Access RESPONDER core (roadmap #16.3b, ADR-0021) —
 * the pure half of the control-mailbox contract whose REQUESTER half (the MCP
 * kernel) landed in #16.3a. The kernel ASKS over the control room's shared doc;
 * the browser is the SOLE AUTHORITY and answers from its own stores. This module
 * turns one validated {@link ControlRequest} into one {@link ControlResponseInput}
 * the kernel can accept — nothing here touches the network, IndexedDB, or the
 * DOM. All of those are INJECTED as {@link ControlResponderSeams} so the core
 * stays pure and exhaustively testable, and so the later (deferred) live mount
 * can supply real implementations without rewriting the dispatch.
 *
 * First slice (ADR-0021 scope): pairing + `list_projects` + `list_versions` +
 * `open_project`. METADATA ONLY for those three — no create op. B4 ADDS two
 * READ-ONLY consent-gated version-file ops, `list_version_files` (path + size)
 * and `read_version_file` (one file's text AT a named version), both derived
 * from the injected {@link ControlResponderSeams.versionTree} seam and bounded
 * by the same list/size caps as `read_file`. Still NO restore/mutate op — a
 * version is only ever READ here. Anything outside that set is refused.
 *
 * SECURITY POSTURE — correct-by-construction against the kernel's acceptance
 * checks (apps/mcp/src/control-tools.ts). The kernel re-validates every response
 * before it acts (the responder is "just another peer"), so this core is the
 * SECOND wall, not the only one — but it is fail-closed in its own right:
 *   - It mirrors {@link CONTROL_TOOL_LIMITS} caps (entry counts) so a sloppy
 *     seam can't overflow the contract.
 *   - For `open_project` it RE-CHECKS the room id (`share-<random>`, never the
 *     control room), the syncUrl posture (ws/wss, no credentials, no
 *     query/fragment, loopback OR the exact configured relay), and the mainFile
 *     path (`isSafeProjectPath`) BEFORE returning. If a seam hands back
 *     something malformed the core answers `ok:false` rather than forward
 *     garbage the kernel would only reject anyway.
 *   - Every seam call is wrapped: a throw becomes `ok:false`, never an
 *     unhandled rejection that could wedge the drain loop.
 *   - Error strings describe the violation; they never quote the offered
 *     hostile URL (that peer text must not ride back into a client-visible
 *     payload — Security round 3 in control-tools.ts).
 *
 * This core is PURE: it owns no I/O and no state. The live wiring — pairing UI,
 * mailbox subscription/drain loop, and the real seam implementations — lives in
 * control-responder-mount.ts, which the app mounts from main.tsx.
 */
import { isSafeProjectPath } from "@galley/shared";
import type { ControlRequest, ControlResponseInput, FileProposalOp } from "@galley/collab";
import { fileProposalSizeViolation } from "@galley/collab";

/**
 * Caps the responder honors so it never exceeds the contract the kernel
 * accepts. These MIRROR apps/mcp/src/control-tools.ts `CONTROL_TOOL_LIMITS`
 * (kept in lockstep by the open_project self-check tests). The kernel clamps
 * again on its side; an honest-but-sloppy responder still shouldn't ship more.
 */
const RESPONDER_LIMITS = {
  maxProjectEntries: 200,
  maxVersionEntries: 200,
  maxRoomChars: 128,
  maxSyncUrlChars: 2048,
  /** Max characters of an open_project grantId (a base64url 16-byte token is 22). */
  maxGrantIdChars: 128,
  /**
   * Max file entries one list_version_files result carries (B4). Mirrors the
   * read side's list caps (CONTROL_TOOL_LIMITS.maxVersionEntries /
   * PROJECT_TOOL_CAPS.listFilesMaxEntries, both 200) — extra entries are cut off
   * with an honest `truncated` flag, never silently.
   */
  maxVersionFileEntries: 200,
  /** Max characters of a read_version_file path param this core accepts (B4). */
  maxVersionFilePathChars: 1024,
} as const;

/**
 * The hard ceiling on a single version file's text the control surface will hand
 * back (B4). Mirrors the in-app `read_file` raw cap (PROJECT_TOOL_CAPS
 * .readFileMaxChars, 24_000) and sits well under both the 256 KB control-RPC
 * record cap and the kernel's `maxToolTextChars` (60_000), so an honest small
 * file always passes while an oversized one is REFUSED with a structured error
 * (never the bytes). Exported so the unit gate can assert the boundary.
 */
export const VERSION_FILE_TEXT_MAX_CHARS = 24_000;

/**
 * A grantId's accepted shape (ADR-0023 §1): a non-empty, bounded base64url token
 * (`mintGrantId` yields 22 chars of `[A-Za-z0-9_-]`). It is bound into both the
 * signing scope and the HKDF key, so the same charset is enforced kernel-side —
 * a grantId outside it would derive a mismatched key. Kept narrow so a malformed
 * value fails closed at the handoff rather than silently breaking signing later.
 */
const GRANT_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The kernel's project-room rule (control-tools.ts `PROJECT_ROOM_RE`): a freshly
 * minted share capability, `share-` + >=16 chars of CSPRNG body. The stable
 * project id is NEVER itself a room capability, so anything else — including the
 * control room id — is refused before the handoff goes out.
 */
const PROJECT_ROOM_RE = /^share-[A-Za-z0-9-]{16,}$/;

/** A project's library metadata row — what `list_projects` surfaces. */
export interface ProjectMeta {
  projectId: string;
  name: string;
  lastModified?: number;
}

/** A named-version metadata row — what `list_versions` surfaces (NO file contents). */
export interface VersionMeta {
  id: string;
  name: string;
  message?: string;
  createdAt?: number;
}

/** One file captured in a named version — its path and TEXT (B4). */
export interface VersionFile {
  path: string;
  text: string;
}

/** One entry in a `list_version_files` result: a path + its size, NO contents (B4). */
export interface VersionFileEntry {
  path: string;
  /** Size of the file's text in UTF-16 code units (the same measure `read_file` caps on). */
  size: number;
}

/** What an `openProjectForControl` impl returns once it has opened + shared a project. */
export interface OpenedProject {
  /** A freshly minted `share-<random>` room (validated here before handoff). */
  room: string;
  /** The relay the project room lives on — must be loopback or the configured relay. */
  syncUrl: string;
  /** The project's main file (validated as a safe in-tree path before handoff). */
  mainFile: string;
  /**
   * A fresh per-grant CSPRNG token (ADR-0023 §1) minted at consent and echoed to
   * the kernel inside the signed control response. It binds every later proposal
   * signature to THIS consent event (closing the stale-signer attack), so the
   * core validates it (non-empty, bounded, safe charset) before handoff.
   */
  grantId: string;
}

/**
 * A structured, human-meaningful REFUSAL from the open seam (#16.3 open_project):
 * the live handler declined for a reason the operator should see (the request
 * named a project other than the one open; the user denied/timed-out consent; no
 * project is open to share). Distinct from `null` (an UNKNOWN project id) and from
 * an `OpenedProject` (a successful share). The `reason` is the handler's OWN text,
 * never peer-derived — the core truncates it before it rides back to the kernel.
 */
export interface OpenProjectRefusal {
  refused: string;
}

/** The core's truncation cap for a seam-supplied refusal reason (never unbounded). */
export const OPEN_REFUSAL_MAX_CHARS = 200;

/**
 * Max characters of a `create_project` name this core accepts (F1). Mirrors the
 * kernel's `CONTROL_TOOL_LIMITS.maxNameChars` (kept in lockstep by the self-check
 * test), so the responder never accepts a name the kernel's input schema rejects.
 * The headless create clamps the STORED name far below this (to
 * MAX_PROJECT_NAME_LENGTH); this is the fail-closed bound on the raw request param.
 */
export const MAX_CREATE_PROJECT_NAME_CHARS = 500;

/**
 * The injected side-effecting surface the pure core depends on. The deferred
 * live mount supplies real implementations; tests supply fakes.
 */
export interface ControlResponderSeams {
  /** The kernel's OWN configured relay — the origin anchor for the syncUrl posture. */
  configuredSyncUrl: string;
  /** The control room id — an open_project room must never be this. */
  controlRoom: string;
  /** The project library, metadata only. */
  listProjects(): Promise<ProjectMeta[]>;
  /** A project's named versions (metadata only), or null when the id is unknown. */
  listVersions(projectId: string): Promise<VersionMeta[] | null>;
  /**
   * Create a brand-new empty project in the library and return its id + name (F1).
   * The mount supplies a headless REGISTRY-ONLY create (no navigation, no CRDT
   * seed); tests supply a fake. Gated ONLY by the Agent Access pairing — there is
   * no pre-existing project to grant per-project content consent on.
   */
  createProject(name: string): Promise<{ projectId: string; name: string }>;
  /**
   * The files captured in ONE named version of a project (B4), or null when the
   * project or version is unknown — OR when the version does not belong to that
   * project (the seam binds version⇄project, so a leaked/guessed version id can
   * never read another project's files). READ-ONLY: the core derives BOTH
   * `list_version_files` (path + size) and `read_version_file` (one file's text)
   * from this single tree, so all the shaping/size/path validation stays in this
   * pure, testable core. The mount gates the call behind the per-project content
   * consent before this seam ever runs.
   */
  versionTree(projectId: string, versionId: string): Promise<VersionFile[] | null>;
  /**
   * VISIBLY open the project, mint a fresh share room, join it, and return the
   * handoff coordinates — OR a structured `{refused}` when the live handler
   * declined (wrong project, consent denied/timed out, nothing open) — OR null
   * when the id is unknown. The core validates + echoes the success path,
   * truncates + forwards the refusal text, and maps null → "unknown project".
   */
  openProjectForControl(projectId: string): Promise<OpenedProject | OpenProjectRefusal | null>;
}

/** An ok:false response carrying the request's correlation id. */
function refuse(id: string, error: string): ControlResponseInput {
  return { id, ok: false, error };
}

/** The `projectId` param as a non-empty string, or undefined when absent/ill-typed. */
function projectIdParam(params: Record<string, unknown>): string | undefined {
  const value = params["projectId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A required non-empty string param by name, or undefined when absent/ill-typed. */
function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mirror of the kernel's `projectSyncUrlViolation` (control-tools.ts): why an
 * open_project syncUrl is unacceptable, or null when it passes. Kept in lockstep
 * so the responder never forwards a URL the kernel would reject. The error text
 * NEVER quotes the offered URL (peer text must not ride back).
 */
function syncUrlViolation(raw: string, configuredSyncUrl: string): string | null {
  if (raw.length > RESPONDER_LIMITS.maxSyncUrlChars) {
    return `syncUrl exceeds ${RESPONDER_LIMITS.maxSyncUrlChars} characters`;
  }
  if (!/^wss?:\/\//.test(raw)) return "syncUrl must be a ws:// or wss:// URL";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "syncUrl is not a valid URL";
  }
  if (url.username !== "" || url.password !== "") return "syncUrl must not contain credentials";
  if (url.search !== "" || url.hash !== "") return "syncUrl must not contain a query or fragment";
  if (isLoopbackHost(url.hostname)) return null;
  let configured: URL;
  try {
    configured = new URL(configuredSyncUrl);
  } catch {
    return "the configured sync URL is not parseable";
  }
  const trim = (p: string): string => p.replace(/\/+$/, "");
  const sameRelay =
    url.protocol === configured.protocol &&
    url.hostname === configured.hostname &&
    url.port === configured.port &&
    trim(url.pathname) === trim(configured.pathname);
  if (!sameRelay) {
    return "the offered sync URL is neither loopback nor the configured relay — refusing to hand off a foreign relay";
  }
  return null;
}

/**
 * Mirror of the kernel's `isLoopbackHost` (config.ts) posture: localhost, the
 * 127.0.0.0/8 block, and ::1 (with or without brackets). A hostname-only check,
 * matching how the kernel anchors the syncUrl rule.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "::1" || h === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Why an open_project grantId is unacceptable, or null when it passes (ADR-0023
 * §1). Mirrors the `roomViolation` style: a bounded, non-empty, safe-charset
 * token. The kernel re-checks the same rule before it binds the grant to the
 * session, so this is the fail-closed second wall, not the only one.
 */
function grantViolation(grantId: string): string | null {
  if (grantId.length === 0) return "grantId must be a non-empty string";
  if (grantId.length > RESPONDER_LIMITS.maxGrantIdChars) {
    return `grantId exceeds ${RESPONDER_LIMITS.maxGrantIdChars} characters`;
  }
  if (!GRANT_ID_RE.test(grantId)) {
    return "grantId is not a base64url token (charset [A-Za-z0-9_-])";
  }
  return null;
}

/** Mirror of the kernel's `projectRoomViolation`: why a room id is unacceptable, or null. */
function roomViolation(room: string, controlRoom: string): string | null {
  if (room.length > RESPONDER_LIMITS.maxRoomChars) {
    return `room id exceeds ${RESPONDER_LIMITS.maxRoomChars} characters`;
  }
  if (!PROJECT_ROOM_RE.test(room)) {
    return "room id is not a freshly minted share room (expected share-<random>)";
  }
  if (room === controlRoom) {
    return "room id is the control room itself — a project room must be a fresh share room";
  }
  return null;
}

/**
 * Answer one control request using the injected seams, producing a kernel-valid
 * {@link ControlResponseInput}. Pure dispatch + fail-closed validation; the only
 * side effects are inside the seams. Never throws — a seam throw becomes
 * `ok:false` so a drain loop calling this can keep going.
 */
export async function answerControlRequest(
  request: ControlRequest,
  seams: ControlResponderSeams,
): Promise<ControlResponseInput> {
  const { id, op, params } = request;
  try {
    if (op === "list_projects") {
      const projects = await seams.listProjects();
      // Emit ONLY the contract picks (drop any extra seam fields — no
      // file contents can ride along) and clamp to the kernel's entry cap.
      const result = projects.slice(0, RESPONDER_LIMITS.maxProjectEntries).map((p) => ({
        projectId: p.projectId,
        name: p.name,
        ...(p.lastModified !== undefined ? { lastModified: p.lastModified } : {}),
      }));
      return { id, ok: true, result };
    }

    if (op === "list_versions") {
      const projectId = projectIdParam(params);
      if (projectId === undefined) return refuse(id, "list_versions requires a projectId");
      const versions = await seams.listVersions(projectId);
      if (versions === null) return refuse(id, "unknown project");
      const result = versions.slice(0, RESPONDER_LIMITS.maxVersionEntries).map((v) => ({
        id: v.id,
        name: v.name,
        ...(v.message !== undefined ? { message: v.message } : {}),
        ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
      }));
      return { id, ok: true, result };
    }

    if (op === "list_version_files" || op === "read_version_file") {
      return answerVersionFileRequest(request, seams.versionTree);
    }

    if (op === "create_project") {
      return answerCreateProjectRequest(request, seams.createProject);
    }

    if (op === "open_project") {
      const projectId = projectIdParam(params);
      if (projectId === undefined) return refuse(id, "open_project requires a projectId");
      const opened = await seams.openProjectForControl(projectId);
      if (opened === null) return refuse(id, "unknown project");
      // A structured refusal from the live handler (wrong project / denied /
      // timed out / nothing open): forward the handler's OWN reason, but TRUNCATE
      // it to a hard cap — the handler is trusted (same-origin app code, not a
      // peer), yet a bounded string keeps the response well inside the mailbox cap.
      if ("refused" in opened) {
        const reason = opened.refused.slice(0, OPEN_REFUSAL_MAX_CHARS);
        return refuse(id, reason);
      }

      // Self-check the seam's handoff against the kernel's acceptance rules
      // BEFORE returning — fail closed if the seam produced something malformed
      // (e.g. a non-share room, a foreign relay, an unsafe path) rather than
      // forward garbage the kernel would only reject.
      const rViolation = roomViolation(opened.room, seams.controlRoom);
      if (rViolation !== null) return refuse(id, `open_project: ${rViolation}`);
      const uViolation = syncUrlViolation(opened.syncUrl, seams.configuredSyncUrl);
      if (uViolation !== null) return refuse(id, `open_project: ${uViolation}`);
      const mainFile = opened.mainFile.startsWith("/") ? opened.mainFile : `/${opened.mainFile}`;
      if (opened.mainFile.length === 0 || !isSafeProjectPath(mainFile)) {
        return refuse(id, "open_project: the project main file path is not safe");
      }
      // The per-grant token (ADR-0023 §1): fail closed on a missing/oversized/
      // bad-charset grantId rather than hand the kernel one it would only reject
      // (or, worse, derive a mismatched signing key from).
      const gViolation = grantViolation(opened.grantId);
      if (gViolation !== null) return refuse(id, `open_project: ${gViolation}`);

      return {
        id,
        ok: true,
        // Echo the REQUESTED projectId — never whatever the seam might claim
        // (the kernel refuses a project-id swap; this keeps them aligned). The
        // validated grantId rides along so the kernel can bind it to the session.
        result: {
          syncUrl: opened.syncUrl,
          room: opened.room,
          projectId,
          mainFile: opened.mainFile,
          grantId: opened.grantId,
        },
      };
    }

    return refuse(id, `unsupported op: ${op}`);
  } catch {
    // Fail-closed: any seam failure is refused, never surfaced (an underlying
    // message could leak a capability or store internals), and never thrown.
    return refuse(id, "the responder could not complete this request");
  }
}

/** The two READ-ONLY version-file ops (B4) — the mount gates these on content consent. */
export function versionFileOps(): readonly string[] {
  return ["list_version_files", "read_version_file"];
}

/**
 * Answer ONE `create_project` request (F1) through the injected seam. PURE +
 * fail-closed validation; the only side effect (registering the new project) is
 * inside the seam. Never throws — a seam throw becomes `ok:false`, so a drain loop
 * calling this can keep going. Mirrors the doc-comment style of
 * {@link answerExpectBlobRequest}.
 *
 *   - `name` is a MANDATORY non-empty string, bounded by
 *     {@link MAX_CREATE_PROJECT_NAME_CHARS}. A missing/over-long name is refused with
 *     NO seam call.
 *   - the seam registers a REGISTRY-ONLY project (no navigation, no CRDT seed) and
 *     returns its `{projectId, name}` — the (sanitized/clamped) stored name. The
 *     core echoes exactly that pair.
 *   - it is gated ONLY by the Agent Access pairing (no per-project content consent —
 *     there is no pre-existing project to grant), so it flows through the metadata
 *     core exactly like list_projects.
 */
export async function answerCreateProjectRequest(
  request: ControlRequest,
  createProject: ControlResponderSeams["createProject"],
): Promise<ControlResponseInput> {
  const { id, params } = request;
  try {
    const name = stringParam(params, "name");
    if (name === undefined) return refuse(id, "create_project requires a name");
    if (name.length > MAX_CREATE_PROJECT_NAME_CHARS) {
      return refuse(id, "create_project name is too long");
    }
    const created = await createProject(name);
    // Echo the seam's (sanitized/clamped) stored name + id; no peer-derived data
    // and no optional fields — the name is always present (clamped, with a random
    // fallback for an empty result).
    return { id, ok: true, result: { projectId: created.projectId, name: created.name } };
  } catch {
    // Fail-closed: any seam failure is refused, never surfaced, never thrown.
    return refuse(id, "the responder could not complete this request");
  }
}

/**
 * The single CONTROL-mode op name (F1). Exposed for symmetry with the other
 * `*Ops` helpers; the mount does NOT gate it on per-project content consent (there
 * is no pre-existing project to grant) — it flows through the metadata core like
 * list_projects, reachable with only the Agent Access pairing.
 */
export function createProjectOps(): readonly string[] {
  return ["create_project"];
}

// ---------------------------------------------------------------------------
// export_compiled (A1) — return the BROWSER's compiled PDF to the kernel over the
// galley-blob-v1 byte channel. READ-ONLY: it compiles + pushes the current build,
// it never mutates the project. The descriptor (this control response) and the
// bytes (the blob socket) travel on DIFFERENT sockets with NO ordering guarantee,
// so the kernel RESERVES the inbound transfer (by the kernel-minted transferId)
// BEFORE it sends this RPC, and only accepts a pushed blob whose {hash,size} match
// the SIGNED descriptor here. This core validates the params + shapes the response;
// the live mount supplies the seam that actually compiles, computes the hash, and
// pushes the bytes under the SAME transferId.
// ---------------------------------------------------------------------------

/** The single op name (A1) — the mount gates it on the same content consent as the tool ops. */
export function exportCompiledOps(): readonly string[] {
  return ["export_compiled"];
}

/** The compiled-export artifact's media type (the only one A1 produces). */
export const EXPORT_COMPILED_MIME = "application/pdf";

/**
 * The hard ceiling on a compiled PDF this op will push (A1). 32 MiB — comfortably
 * above a large document's build, well under the blob channel's
 * BLOB_MAX_TRANSFER_BYTES (64 MiB) so the reservation + transfer always fit. The
 * KERNEL caps maxBytes too (it reserves up front); this is the responder-side wall.
 */
export const EXPORT_COMPILED_MAX_BYTES = 32 * 1024 * 1024;

/** Max characters of a transferId param the core accepts (mirrors the blob id cap). */
const EXPORT_TRANSFER_ID_MAX_CHARS = 64;

/** A successful export: the descriptor the kernel matches the pushed blob against. */
export interface ExportedCompiled {
  hash: string;
  size: number;
}

/**
 * The injected export seam (A1). Given the request's `{projectId, transferId,
 * maxBytes}` (already validated + consent-gated by the mount), it must: compile
 * the open project's current document, obtain the PDF bytes, ensure the project's
 * blob channel is connected, PUSH the bytes over it under the SAME `transferId`,
 * and resolve `{hash, size}` (sha256hex + byte length) ONLY after the push is
 * accepted (the receiver's verified COMPLETE). Returns a structured `{refused}`
 * when it cannot (no project open, no compiler, the export is blocked, the push
 * failed), or null for an unknown project. NEVER throws across the boundary — the
 * core wraps it, but a structured refusal keeps the kernel's message precise.
 */
export type ExportCompiledSeam = (
  projectId: string,
  transferId: string,
  maxBytes: number,
) => Promise<ExportedCompiled | OpenProjectRefusal | null>;

/**
 * Answer ONE `export_compiled` request (A1) through the injected seam. PURE +
 * fail-closed validation; the only side effects (compile + blob push) are inside
 * the seam. Never throws — a seam throw becomes `ok:false`.
 *
 *   - `projectId`, `transferId` are MANDATORY non-empty strings; `transferId` is
 *     bounded (the blob-id cap). `maxBytes` must be a positive integer, capped at
 *     {@link EXPORT_COMPILED_MAX_BYTES}. A bad param is refused with NO seam call.
 *   - the seam returns null (unknown project) → a generic refusal; `{refused}` →
 *     the (truncated) handler reason; `{hash,size}` → the signed descriptor the
 *     kernel verifies the pushed blob against.
 *   - the response carries the ECHOED transferId + the validated {hash,size,mime}.
 *     The mount SIGNS this response with the per-grant responseKey, so a 3rd room
 *     peer cannot forge the descriptor the kernel matches the bytes against.
 */
export async function answerExportCompiledRequest(
  request: ControlRequest,
  exportCompiled: ExportCompiledSeam,
): Promise<ControlResponseInput> {
  const { id, params } = request;
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) return refuse(id, "export_compiled requires a projectId");
    const transferId = stringParam(params, "transferId");
    if (transferId === undefined) return refuse(id, "export_compiled requires a transferId");
    if (transferId.length > EXPORT_TRANSFER_ID_MAX_CHARS) {
      return refuse(id, "export_compiled transferId is too long");
    }
    const rawMax = params["maxBytes"];
    if (typeof rawMax !== "number" || !Number.isInteger(rawMax) || rawMax <= 0) {
      return refuse(id, "export_compiled requires a positive integer maxBytes");
    }
    // Clamp to the responder-side ceiling — never push more than the contract caps
    // (the kernel reserved at most its own cap; honor the smaller of the two).
    const maxBytes = Math.min(rawMax, EXPORT_COMPILED_MAX_BYTES);

    const result = await exportCompiled(projectId, transferId, maxBytes);
    if (result === null) return refuse(id, "unknown project");
    if ("refused" in result) {
      return refuse(id, result.refused.slice(0, OPEN_REFUSAL_MAX_CHARS));
    }
    // The seam already pushed the bytes under `transferId`; echo the validated
    // descriptor. The mount SIGNS this — the kernel only accepts a blob matching it.
    return {
      id,
      ok: true,
      result: {
        transferId,
        hash: result.hash,
        size: result.size,
        mime: EXPORT_COMPILED_MIME,
      },
    };
  } catch {
    // Fail-closed: any seam failure is refused, never surfaced, never thrown.
    return refuse(id, "the responder could not complete this request");
  }
}

// ---------------------------------------------------------------------------
// compile (F9/F5) — relay the BROWSER's live-preview compile DIAGNOSTICS to the
// kernel over the control mailbox, when no loopback --compile-url is configured.
// DIAGNOSTICS ONLY: the browser already compiles its preview, so this returns the
// `{ok, pageCount, diagnostics}` it has — no new build, no document text leaves
// the browser, no PDF bytes (that is export_compiled's separate blob-channel job).
// This core validates the params + shapes the response; the live mount supplies
// the seam reading the open project's current diagnostics, behind the SAME
// per-project content-consent gate as the other content ops (build feedback over
// the project text). Fail-closed: any seam failure becomes a generic refusal.
// ---------------------------------------------------------------------------

/** The single op name (F9) — the mount gates it on the same content consent as the tool ops. */
export function compileOps(): readonly string[] {
  return ["compile"];
}

/** Max diagnostics one compile response carries (F9) — slices a hostile/huge list. */
export const COMPILE_MAX_DIAGNOSTICS = 2000;
/** Max characters of ONE diagnostic message the core emits (F9) — caps a huge message. */
export const COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4000;

/**
 * The diagnostics-only compile result (F9): the open project's current
 * `{ok, pageCount, diagnostics}`. `ok` is `errors.length === 0`; `pageCount` is the
 * live preview's page count (null when not yet rendered). Each diagnostic carries
 * the shared {@link Diagnostic} minimal fields the kernel relays.
 */
export interface CompileDiagnostics {
  ok: boolean;
  pageCount: number | null;
  diagnostics: { severity: "error" | "warning"; message: string; path?: string }[];
}

/**
 * The injected compile seam (F9). Given the request's already-validated +
 * consent-gated `projectId`, it must resolve the OPEN project's CURRENT compile
 * diagnostics + pageCount (the live preview already computed them — no fresh
 * compile is triggered), or a structured `{refused}` (nothing open / compiler not
 * ready / a shared/joined session that cannot compile), or null for an unknown /
 * not-open project. NEVER throws across the boundary — the core wraps it, but a
 * structured refusal keeps the kernel's message precise.
 */
export type CompileSeam = (
  projectId: string,
) => Promise<CompileDiagnostics | OpenProjectRefusal | null>;

/**
 * Answer ONE `compile` request (F9) through the injected seam. PURE + fail-closed
 * validation; the only side effect (reading the live diagnostics) is inside the
 * seam. Never throws — a seam throw becomes a generic refusal.
 *
 *   - `projectId` is a MANDATORY non-empty string; a missing one is refused with
 *     NO seam call.
 *   - the seam returns null (unknown project) → a generic refusal; `{refused}` →
 *     the (truncated) handler reason; `{ok,pageCount,diagnostics}` → ONLY the
 *     contract picks (no file text rides along), with the diagnostics array sliced
 *     to {@link COMPILE_MAX_DIAGNOSTICS} and each message capped to
 *     {@link COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS} so a hostile/huge list cannot
 *     overflow the control-RPC record cap.
 */
export async function answerCompileRequest(
  request: ControlRequest,
  compile: CompileSeam,
): Promise<ControlResponseInput> {
  const { id, params } = request;
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) return refuse(id, "compile requires a projectId");

    const result = await compile(projectId);
    if (result === null) return refuse(id, "unknown project");
    if ("refused" in result) {
      return refuse(id, result.refused.slice(0, OPEN_REFUSAL_MAX_CHARS));
    }
    // Emit ONLY the contract picks — bound the array length and each message so a
    // huge diagnostics list cannot overflow the control-RPC record cap. Drop any
    // extra seam fields (no file text rides along on this channel).
    const diagnostics = result.diagnostics.slice(0, COMPILE_MAX_DIAGNOSTICS).map((d) => ({
      severity: d.severity,
      message: d.message.slice(0, COMPILE_DIAGNOSTIC_MESSAGE_MAX_CHARS),
      ...(d.path !== undefined ? { path: d.path } : {}),
    }));
    return { id, ok: true, result: { ok: result.ok, pageCount: result.pageCount, diagnostics } };
  } catch {
    // Fail-closed: any seam failure is refused, never surfaced, never thrown.
    return refuse(id, "the responder could not complete this request");
  }
}

/**
 * Answer ONE version-file op (B4) — `list_version_files` (path + size) or
 * `read_version_file` (one file's text AT a named version) — from the injected
 * {@link ControlResponderSeams.versionTree} seam. PURE + fail-closed, and the
 * single place all the shaping lives:
 *   - both ops require a non-empty `projectId` AND `versionId`; read additionally
 *     requires a `path`. A missing param is refused with NO seam call.
 *   - read_version_file canonicalizes the path (leading slash) and `isSafeProjectPath`-
 *     validates it BEFORE any tree lookup — a traversal/`.galley`/control-char path
 *     is refused with no store touch, the same gate read_file applies.
 *   - the seam returns null for unknown project/version (and a version that is not
 *     the project's) → a generic "unknown project or version" refusal (no oracle).
 *   - list bounds entries to {@link RESPONDER_LIMITS}.maxVersionFileEntries with an
 *     honest `truncated` flag and emits path + size ONLY (never the text).
 *   - read refuses an oversized file with a STRUCTURED error (never the bytes),
 *     mirroring read_file's {@link VERSION_FILE_TEXT_MAX_CHARS} cap.
 * Never throws — a seam throw becomes `ok:false`, so a drain loop can keep going.
 * The mount calls this ONLY after the per-project content-consent gate passes.
 */
export async function answerVersionFileRequest(
  request: ControlRequest,
  versionTree: ControlResponderSeams["versionTree"],
): Promise<ControlResponseInput> {
  const { id, op, params } = request;
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) return refuse(id, `${op} requires a projectId`);
    const versionId = stringParam(params, "versionId");
    if (versionId === undefined) return refuse(id, `${op} requires a versionId`);

    if (op === "list_version_files") {
      const tree = await versionTree(projectId, versionId);
      if (tree === null) return refuse(id, "unknown project or version");
      const clamped = tree.slice(0, RESPONDER_LIMITS.maxVersionFileEntries);
      // Path + SIZE only — never the text (no file contents on this list, exactly
      // like list_files). Size in UTF-16 code units, the unit read_version_file
      // caps on, so the two answers agree.
      const files: VersionFileEntry[] = clamped.map((f) => ({ path: f.path, size: f.text.length }));
      return { id, ok: true, result: { files, truncated: tree.length > clamped.length } };
    }

    // read_version_file
    const path = stringParam(params, "path");
    if (path === undefined) return refuse(id, "read_version_file requires a path");
    if (path.length > RESPONDER_LIMITS.maxVersionFilePathChars) {
      return refuse(id, "read_version_file path is too long");
    }
    // Canonicalize to a leading slash, then safe-path validate BEFORE any lookup
    // (the same gate read_file / open_project mainFile apply) — a traversal /
    // backslash / control-char / `.galley` path is refused with no store touch.
    const canonical = path.startsWith("/") ? path : `/${path}`;
    if (!isSafeProjectPath(canonical)) {
      return refuse(id, "read_version_file: the path is not a safe project path");
    }
    const tree = await versionTree(projectId, versionId);
    if (tree === null) return refuse(id, "unknown project or version");
    // Match either the canonical path or the seam's stored path verbatim, so a
    // tree stored with or without a leading slash both resolve.
    const file = tree.find((f) => f.path === canonical || f.path === path);
    if (file === undefined) return refuse(id, "no file exists at that path in this version");
    if (file.text.length > VERSION_FILE_TEXT_MAX_CHARS) {
      // Structured refusal — never the bytes. The size is the file's own (not
      // peer-controlled) length; the cap is a constant. Mirrors how read_file
      // refuses oversized content rather than streaming it.
      return refuse(
        id,
        `read_version_file: the file is too large (${file.text.length} characters; the limit is ${VERSION_FILE_TEXT_MAX_CHARS})`,
      );
    }
    return { id, ok: true, result: { text: file.text } };
  } catch {
    // Fail-closed: any seam failure is refused, never surfaced, never thrown.
    return refuse(id, "the responder could not complete this request");
  }
}

// ---------------------------------------------------------------------------
// expect_blob (A2) — the kernel asks the BROWSER to RESERVE inbound capacity for
// a blob it is about to PUSH (binary upload via propose_files). The descriptor
// (this control response) and the bytes (the blob socket) travel on DIFFERENT
// sockets, so the kernel calls this BEFORE it pushes: a matching inbound transfer
// for `{hash,size}` is then accepted (not rejected as unexpected). READ-ONLY of
// the project (it touches no files) but it commits browser buffer quota, so the
// mount gates it on the SAME per-project content consent as the other content
// ops. The HMAC-signed `ok` response tells the kernel the reservation stuck.
//
// QUOTA-PIN POSTURE (C1, v1) — the reservation + the stored bytes are bounded
// FOUR ways:
//   (1) the transport's `maxExpectedBytes` byte quota caps the SUM of outstanding
//       reservations (a request over it returns reserved:false);
//   (2) a per-reservation LEASE/TTL in the ProjectApp handler auto-releases a
//       reservation whose bytes never arrive, and the lease is CLEARED on delivery
//       (no stray no-op timer);
//   (3) an explicit `release_blob` drops still-pending reservations the moment an
//       upload fails partway / publish throws; and
//   (4) for a hash already DELIVERED+stored, `release_blob` DELETES the orphan
//       bytes from the blob store (safe — the proposal did NOT publish, so no live
//       CRDT pointer references the hash; the handler re-checks the live snapshot
//       before deleting). Only the requesting session's OWN reserved/delivered
//       hashes are ever released/deleted.
// REQUEST AUTHENTICATION is deliberately NOT added: control REQUESTS are unsigned
// (peer-writable mailbox, consent-gated by design), so we do not invent a new
// signed-request protocol here. DOCUMENTED RESIDUAL: a CONSENTED room peer can
// transiently reserve up to the bounded/leased quota (a brief, self-healing pin) —
// acceptable for v1. Full GC of a blob that was ACCEPTED (published) and only LATER
// orphaned (the file deleted) — i.e. normal blob GC — remains the deferred item.
// ---------------------------------------------------------------------------

/** The single op name (A2) — the mount gates it on the same content consent as the tool ops. */
export function expectBlobOps(): readonly string[] {
  return ["expect_blob"];
}

/** Max characters of an expect_blob hash param (a sha256 hex is 64). */
const EXPECT_BLOB_HASH_MAX_CHARS = 64;

/** A lowercase-hex sha256 is exactly 64 chars of [0-9a-f] (the BlobStore key shape). */
const EXPECT_BLOB_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The injected expect_blob seam (A2): given `{projectId, hash, size}` (already
 * validated + consent-gated by the mount), it must reserve inbound capacity on
 * the OPEN project's blob channel (`blob.expect(hash, size)`) and resolve `true`
 * iff the reservation succeeded (the channel exists, is authenticated, and the
 * quota fit), else `false`. Returns null for an unknown/non-open project. NEVER
 * throws across the boundary — the core wraps it, but a clean false keeps the
 * kernel's message precise (it will then NOT push).
 */
export type ExpectBlobSeam = (
  projectId: string,
  hash: string,
  size: number,
) => Promise<boolean | null>;

/**
 * Answer ONE `expect_blob` request (A2) through the injected seam. PURE +
 * fail-closed validation; the only side effect (the channel reservation) is
 * inside the seam. Never throws — a seam throw becomes `ok:false`.
 *
 *   - `projectId` MANDATORY non-empty string; `hash` a 64-char lowercase-hex
 *     sha256; `size` a positive integer. A bad param is refused with NO seam call.
 *   - the seam returns null (unknown/non-open project) → a generic refusal;
 *     false (no channel / not authenticated / quota exceeded) → a structured
 *     `{reserved:false}` on an `ok:true` response (so it survives the kernel's
 *     refusal-flattening and the kernel learns to NOT push); true → `{reserved:true}`.
 */
export async function answerExpectBlobRequest(
  request: ControlRequest,
  expectBlob: ExpectBlobSeam,
): Promise<ControlResponseInput> {
  const { id, params } = request;
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) return refuse(id, "expect_blob requires a projectId");
    const hash = stringParam(params, "hash");
    if (hash === undefined) return refuse(id, "expect_blob requires a hash");
    if (hash.length > EXPECT_BLOB_HASH_MAX_CHARS || !EXPECT_BLOB_HASH_RE.test(hash)) {
      return refuse(id, "expect_blob hash must be a 64-character lowercase hex sha256");
    }
    const rawSize = params["size"];
    if (typeof rawSize !== "number" || !Number.isSafeInteger(rawSize) || rawSize <= 0) {
      return refuse(id, "expect_blob requires a positive integer size");
    }
    const reserved = await expectBlob(projectId, hash, rawSize);
    if (reserved === null) return refuse(id, "unknown project");
    // The reservation outcome rides on an ok:true response so the kernel can tell
    // "reserved" from "could not reserve" (vs a flattened generic refusal).
    return { id, ok: true, result: { reserved } };
  } catch {
    return refuse(id, "the responder could not complete this request");
  }
}

// ---------------------------------------------------------------------------
// release_blob (A2 / C1b) — the kernel asks the BROWSER to DROP earlier
// `expect_blob` reservations when an upload failed partway through a multi-binary
// proposal, or the publish threw after bytes were uploaded. It frees the browser's
// reserved quota immediately (rather than at the lease deadline) so a failed
// upload leaves no quota pin. Consent-gated like expect_blob. Best-effort: a
// release for an unknown/already-delivered hash is a no-op.
// ---------------------------------------------------------------------------

/** The single op name (A2/C1b) — the mount gates it on the same content consent. */
export function releaseBlobOps(): readonly string[] {
  return ["release_blob"];
}

/** Max reservations released in one release_blob call (bounds the request work). */
const RELEASE_BLOB_MAX_ENTRIES = 64;

/**
 * The injected release_blob seam (A2/C1b): given `{projectId, hashes:[{hash,size}]}`
 * (validated + consent-gated by the mount), it drops each reservation on the OPEN
 * project's blob channel (`blob.unexpect`). Resolves `true` when handled, `false`
 * when there is no channel, or null for an unknown/non-open project. Never throws.
 */
export type ReleaseBlobSeam = (
  projectId: string,
  hashes: { hash: string; size: number }[],
) => Promise<boolean | null>;

/**
 * Answer ONE `release_blob` request (A2/C1b) through the injected seam. PURE +
 * fail-closed validation; the only side effect (dropping reservations) is in the
 * seam. Never throws — a seam throw becomes `ok:false`.
 *
 *   - `projectId` MANDATORY; `hashes` a non-empty, bounded array of `{hash,size}`
 *     where hash is 64-hex and size a positive integer. A malformed entry is
 *     DROPPED from the set (never fails the whole call) so a partial cleanup still
 *     proceeds; an empty/oversized array is refused.
 *   - the seam returns null → unknown-project refusal; otherwise `{released:bool}`.
 */
export async function answerReleaseBlobRequest(
  request: ControlRequest,
  releaseBlob: ReleaseBlobSeam,
): Promise<ControlResponseInput> {
  const { id, params } = request;
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) return refuse(id, "release_blob requires a projectId");
    const rawHashes = params["hashes"];
    if (!Array.isArray(rawHashes) || rawHashes.length === 0) {
      return refuse(id, "release_blob requires a non-empty hashes array");
    }
    if (rawHashes.length > RELEASE_BLOB_MAX_ENTRIES) {
      return refuse(id, `release_blob accepts at most ${RELEASE_BLOB_MAX_ENTRIES} hashes`);
    }
    const hashes: { hash: string; size: number }[] = [];
    for (const entry of rawHashes) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.hash !== "string" || !EXPECT_BLOB_HASH_RE.test(e.hash)) continue;
      if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size <= 0) continue;
      hashes.push({ hash: e.hash, size: e.size });
    }
    if (hashes.length === 0) return refuse(id, "release_blob had no valid hashes");
    const released = await releaseBlob(projectId, hashes);
    if (released === null) return refuse(id, "unknown project");
    return { id, ok: true, result: { released } };
  } catch {
    return refuse(id, "the responder could not complete this request");
  }
}

/**
 * Bind the seams once and return a per-request answerer — the shape the deferred
 * drain loop will call (`for (const req of readControlRequests()) publish(await
 * answer(req))`). A thin closure over {@link answerControlRequest}.
 */
export function createControlResponder(
  seams: ControlResponderSeams,
): (request: ControlRequest) => Promise<ControlResponseInput> {
  return (request) => answerControlRequest(request, seams);
}

// ---------------------------------------------------------------------------
// request_restore_version (B3) — REQUEST restoring a project to a past named
// version. NEVER a direct mutation (ADR-0021): the responder computes the diff
// (current live project → the target version's file set), expresses it as a
// multi-file FileProposalOp set, and PUBLISHES it as a NORMAL file proposal
// titled `Restore to "<name>"`. It then flows through the EXISTING Ask/Auto +
// Accept/apply path UNCHANGED — the kernel never writes files, it only triggers
// this. A browser-published restore proposal is UNSIGNED, so it surfaces only on
// the manual Accept/compare card (the auto-accept verifier authenticates a
// kernel signature it will never have) — "explicit human Accept" by construction.
//
// The diff is PURE (`computeRestoreDiff`) and operates over the TEXT-file
// universe ONLY. The version tree is text-only and the `liveFileSet` seam returns
// TEXT files only (binary assets excluded), so a binary file is NEVER present in
// `current` — the diff can therefore never emit a `delete` for a binary asset
// just because it is absent from the text-only version tree. That invariant is
// the binary-delete safety the responder relies on; it is tested in
// control-responder-restore.test.ts.
// ---------------------------------------------------------------------------

/** The single op name (B3) — the mount gates it on the same content consent as the read ops. */
export function restoreVersionOps(): readonly string[] {
  return ["request_restore_version"];
}

/** One TEXT file in a restore diff — a path + its full text. Binary files are excluded. */
export interface RestoreFile {
  path: string;
  text: string;
}

/**
 * Compute the restore diff: the multi-file change set that turns the CURRENT live
 * project into the TARGET version's file set. PURE and total — no side effects,
 * fully unit-tested:
 *   - a TARGET file absent from `current` → `create` (baseText "", proposedText
 *     the target text, no blocks);
 *   - a TARGET file in `current` with DIFFERENT text → `edit` (baseText the live
 *     text, proposedText the target text, no blocks);
 *   - a TARGET file identical to `current` → NO op;
 *   - a CURRENT file absent from the target → `delete` (baseText the live text,
 *     proposedText "", no blocks).
 * BINARY-DELETE SAFETY: both inputs are the TEXT-file universe ONLY (the seam
 * excludes binary assets), so a binary file never appears in `current` and is
 * never deleted. Ops are sorted by path so the change set is DETERMINISTIC and
 * matches the mailbox's intra-proposal path-uniqueness checks.
 */
export function computeRestoreDiff(
  current: readonly RestoreFile[],
  target: readonly RestoreFile[],
): FileProposalOp[] {
  const currentByPath = new Map(current.map((f) => [f.path, f.text]));
  const targetByPath = new Map(target.map((f) => [f.path, f.text]));
  const ops: FileProposalOp[] = [];
  // Targets: create (absent live) or edit (present but changed); identical → skip.
  for (const t of target) {
    const live = currentByPath.get(t.path);
    if (live === undefined) {
      ops.push({ kind: "create", path: t.path, baseText: "", proposedText: t.text, blocks: [] });
    } else if (live !== t.text) {
      ops.push({ kind: "edit", path: t.path, baseText: live, proposedText: t.text, blocks: [] });
    }
  }
  // Live TEXT files absent from the target → delete (binary files are never in
  // `current`, so this can never touch a binary asset — the safety invariant).
  for (const c of current) {
    if (!targetByPath.has(c.path)) {
      ops.push({ kind: "delete", path: c.path, baseText: c.text, proposedText: "", blocks: [] });
    }
  }
  // Deterministic: sort by path (the mailbox enforces intra-proposal path
  // uniqueness, so a stable order keeps the published set reproducible).
  ops.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ops;
}

/**
 * The injected side-effecting surface for one restore request (B3). The mount
 * gates the call behind the per-project content consent before any of these run,
 * and supplies the live implementations; tests supply fakes.
 */
export interface RestoreVersionSeams {
  /**
   * The CURRENT live project's TEXT files (path + text) when `projectId` is the
   * OPEN project, else null. Restore REQUIRES the project to be open — it can't
   * apply into the void. MUST return TEXT files only (binary assets excluded) so
   * the diff's binary-delete-safety invariant holds.
   */
  liveFileSet(projectId: string): Promise<RestoreFile[] | null>;
  /**
   * The TEXT files captured in ONE named version (the B4 version-tree seam), or
   * null when the project/version is unknown OR the version does not belong to
   * the project (the seam binds version⇄project).
   */
  versionTree(projectId: string, versionId: string): Promise<RestoreFile[] | null>;
  /** The version's display NAME (for the proposal title), or null when unknown. */
  versionName(projectId: string, versionId: string): Promise<string | null>;
  /**
   * PUBLISH the computed restore proposal via the existing `publishFileProposal`
   * (the mailbox is security-pinned — no new op kind/field). Returns the minted
   * proposal id. The mount wires this to the OPEN project's live doc host.
   */
  publishRestore(input: { request: string; ops: FileProposalOp[] }): Promise<string>;
}

/** An ok:false response carrying the request's correlation id (restore-local). */
function refuseRestore(id: string, error: string): ControlResponseInput {
  return { id, ok: false, error };
}

/**
 * The CLOSED set of structured restore OUTCOMES (B3, C2). These ride on an
 * `ok:true` response so they SURVIVE the kernel's refusal-flattening (control.ts
 * collapses every non-consent `ok:false` to one generic line). Each is a domain
 * outcome the agent should be able to tell apart — never a generic "refused".
 * CONSENT is deliberately NOT here: it stays a refusal, gated in the mount, so the
 * pre-consent surface leaks no existence oracle.
 */
export type RestoreStatus =
  | "restore_proposed"
  | "no_changes"
  | "not_open"
  | "unknown_version"
  | "too_large"
  | "conflict";

/** The first DUPLICATE path in `files`, or null when every path is unique (C3). */
function firstDuplicatePath(files: readonly RestoreFile[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) return f.path;
    seen.add(f.path);
  }
  return null;
}

/**
 * Answer ONE `request_restore_version` request (B3) through the injected seams.
 * PURE dispatch + fail-closed validation; the only side effect (publish) is
 * inside the `publishRestore` seam. Never throws — a seam throw becomes ok:false.
 *
 * THE OUTCOME MODEL (C2): the DOMAIN outcomes are STRUCTURED `ok:true` statuses
 * (a closed {@link RestoreStatus} enum), NOT refusals, so they survive the
 * kernel's refusal-flattening and the agent learns WHY a restore did/didn't
 * happen. Only two things are genuine `ok:false` refusals: a missing/ill-typed
 * param (a malformed request), and a seam THROW (an internal failure). Consent is
 * gated upstream in the mount and never reaches here.
 *
 *   - missing projectId/versionId → ok:false refusal (no seam call);
 *   - no project open (live set null) → `{status:"not_open"}`;
 *   - unknown project/version (tree OR name null) → `{status:"unknown_version"}`;
 *   - a duplicate path in the live set or the version tree (C3) →
 *     `{status:"conflict"}` (never a false no_changes), publishing NOTHING;
 *   - the diff is EMPTY (project already equals the version) → `{status:"no_changes"}`;
 *   - the diff exceeds FILE_PROPOSAL_LIMITS → `{status:"too_large"}` computed
 *     BEFORE publishing (so an oversized restore never enters the CRDT);
 *   - otherwise → publish the proposal and return
 *     `{status:"restore_proposed", proposalId}`.
 */
export async function answerRestoreVersionRequest(
  request: ControlRequest,
  seams: RestoreVersionSeams,
): Promise<ControlResponseInput> {
  const { id, params } = request;
  /** Wrap a structured outcome on an ok:true response (survives refusal-flattening). */
  const status = (
    result: { status: RestoreStatus } & Record<string, unknown>,
  ): ControlResponseInput => ({ id, ok: true, result });
  try {
    const projectId = projectIdParam(params);
    if (projectId === undefined) {
      return refuseRestore(id, "request_restore_version requires a projectId");
    }
    const versionId = stringParam(params, "versionId");
    if (versionId === undefined) {
      return refuseRestore(id, "request_restore_version requires a versionId");
    }

    // The project MUST be open — restore computes against (and lands into) the
    // live project. A null live set means nothing is open for this id.
    const live = await seams.liveFileSet(projectId);
    if (live === null) {
      return status({ status: "not_open" });
    }

    // The target version's text files + display name (version⇄project bound).
    const target = await seams.versionTree(projectId, versionId);
    if (target === null) {
      return status({ status: "unknown_version" });
    }
    const name = await seams.versionName(projectId, versionId);
    if (name === null) {
      return status({ status: "unknown_version" });
    }

    // C3: a duplicate path on EITHER side makes the path→text diff Maps ambiguous
    // (a same-path file could mask a real difference → a FALSE no_changes). Refuse
    // with a structured `conflict` rather than diff/publish through the ambiguity.
    if (firstDuplicatePath(live) !== null || firstDuplicatePath(target) !== null) {
      return status({ status: "conflict" });
    }

    const ops = computeRestoreDiff(live, target);
    if (ops.length === 0) {
      // The project already equals the version — nothing to propose.
      return status({ status: "no_changes" });
    }

    const proposalRequest = `Restore to "${name}"`;
    // Validate the change set against the mailbox's limits BEFORE publishing, so
    // an oversized restore is surfaced as `too_large` rather than thrown by
    // publishFileProposal. (publishFileProposal re-checks authoritatively.)
    const violation = fileProposalSizeViolation({ request: proposalRequest, ops });
    if (violation !== null) {
      return status({ status: "too_large" });
    }

    const proposalId = await seams.publishRestore({ request: proposalRequest, ops });
    return status({ status: "restore_proposed", proposalId });
  } catch {
    // Fail-closed: an internal seam THROW is a refusal (not a domain status) —
    // never surfaced (a message could leak internals), never thrown.
    return refuseRestore(id, "the responder could not complete this request");
  }
}
