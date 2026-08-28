/**
 * Control-mode tools (#16.3a, ADR-0021): `list_projects`, `list_versions`,
 * `open_project` — the kernel ASKS the browser over the control mailbox; the
 * browser is the sole authority and answers from its own stores. (No create
 * ops, no restore — ADR-0021 non-goals.) B4 ADDS two consent-gated READ-ONLY
 * version-file tools (`list_version_files`, `read_version_file`) so an agent can
 * see a file's contents at a past named version — still no restore/mutate.
 *
 * #1 slice 1 adds the consent-gated READ-ONLY content tools —
 * `search_project`, `list_files`, `read_file`, each taking an explicit
 * `projectId` — which the browser answers ONLY for projects the user granted
 * file access (Settings → Agent Access, per-project, session-scoped, default
 * zero). An ungranted project comes back as a typed `consent-required`
 * refusal, which this layer surfaces as a clean "go grant it in Settings"
 * error. The kernel grants NOTHING itself: consent lives entirely in the
 * browser, and these tools are retired when `open_project` binds the session
 * (the per-project tools then own the `list_files`/`read_file` names).
 *
 * The RESPONDER IS JUST ANOTHER PEER: every response body is schema-validated
 * here (zod + custom posture checks) before anything acts on it, exactly the
 * 16.1/16.2 stance toward room peers. The high-stakes one is `open_project`:
 * its response tells the kernel which relay/room to JOIN, so it is gated by
 *   - a room-id format check (`share-` prefixed capability, bounded charset/
 *     length, and never the control room itself), and
 *   - a syncUrl posture consistent with the kernel's compile-URL rules
 *     (local-first): ws/wss, parseable, NO embedded credentials, NO
 *     query/fragment, and the host must be LOOPBACK (any port) or the EXACT
 *     relay the kernel was configured with (same scheme + host + port + path).
 *     A hostile responder can therefore never point the kernel at a foreign
 *     relay.
 * Only after all of that does the kernel join the project room with the
 * EXISTING per-project session machinery and register the per-project tools.
 *
 * ONE project per kernel session (the per-project mode's own scope): the first
 * successful `open_project` binds the session; later calls return a structured
 * `already_open` — restart the kernel to switch projects. Every RPC is
 * timeout-bounded and fail-closed (control.ts); there are no retries.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isSafeProjectPath } from "@galley/shared";
import { TOOL_REGISTRY, escapeControlChars } from "@galley/agent";
import { sha256Hex, type ReceivedBlob } from "@galley/collab";
import type { CompileService } from "./compile-client.js";
import { isLoopbackHost } from "./config.js";
import type { ControlRpcOutcome } from "./control.js";
import { joinRoom, type KernelSession } from "./session.js";
import type { KernelBlobSession } from "./blob-session.js";
import { registerProjectTools, jsonResult, errorResult, textResult, type KernelTools } from "./server.js";

/**
 * Caps on what the kernel ACCEPTS from a responder (the read side of the
 * contract; the mailbox already caps raw response bytes). Entries beyond the
 * list caps are cut off with an honest `truncated` flag, never silently.
 */
export const CONTROL_TOOL_LIMITS = {
  /** Max characters of a projectId (ours are `proj-<uuid>`-scale). */
  maxProjectIdChars: 256,
  /** Max characters of a project/version display name surfaced to the client. */
  maxNameChars: 500,
  /** Max characters of a version message surfaced to the client. */
  maxMessageChars: 500,
  /** Max project entries one list_projects result carries. */
  maxProjectEntries: 200,
  /** Max version entries one list_versions result carries. */
  maxVersionEntries: 200,
  /**
   * Max diagnostics one browser-routed `compile` result carries (F9). A project
   * (or a hostile peer seeding the room) could carry thousands of diagnostics;
   * this — together with the per-message `maxToolTextChars` cap — bounds the
   * control-RPC record so a downstream model is never flooded. The browser core
   * slices to its own COMPILE_MAX_DIAGNOSTICS first; this is the kernel-side wall.
   */
  maxDiagnostics: 2000,
  /** Max characters of an open_project room id (mintShareRoom yields ~42). */
  maxRoomChars: 128,
  /** Max characters of an open_project syncUrl. */
  maxSyncUrlChars: 2048,
  /** Max characters of an open_project mainFile path (READ_LIMITS.maxPathChars). */
  maxMainFileChars: 1024,
  /** Max characters of an open_project grantId (a base64url 16-byte token is 22). */
  maxGrantIdChars: 128,
  /**
   * Max characters of a content-tool `text` body the kernel ACCEPTS from the
   * responder (#1 slice 1). The honest responder clamps to the registry's
   * PROJECT_TOOL_CAPS.resultMaxChars (28k); this sits comfortably above it so
   * honest answers always pass, while a hostile peer racing the correlation
   * cannot flood the MCP client through this channel.
   */
  maxToolTextChars: 60_000,
  /** Max characters of a content-tool `summary` line. */
  maxToolSummaryChars: 500,
  /** Max characters of a search_project query forwarded to the responder. */
  maxToolQueryChars: 1000,
} as const;

/**
 * A1 export channel caps. The kernel reserves inbound capacity for the PDF up
 * front, so it picks a sane PDF ceiling (32 MiB) within the blob channel's
 * BLOB_MAX_TRANSFER_BYTES (64 MiB), and a 30s deadline for the whole handshake
 * (compile + push). On any failure → fail closed + release the reservation.
 */
export const EXPORT_COMPILED_MAX_BYTES = 32 * 1024 * 1024;
export const EXPORT_COMPILED_TIMEOUT_MS = 30_000;
/** The only artifact media type A1 produces. */
const EXPORT_COMPILED_MIME = "application/pdf";

/** Max characters of a save_artifact destPath the kernel accepts (F11). */
export const SAVE_ARTIFACT_MAX_PATH_CHARS = 4096;

/** A lowercase 64-hex sha256 — the descriptor's integrity anchor. */
const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * The validated `export_compiled` control response (A1): the browser responder
 * answers `{transferId, hash, size, mime}`, HMAC-signed with the per-grant
 * responseKey (the kernel verifies the signature in the rpc layer). The kernel
 * accepts the pushed blob ONLY when its {hash,size} match THIS signed descriptor —
 * so a 3rd room peer cannot forge a descriptor the kernel matches bytes against.
 * Bounded + extra fields dropped, like every other responder payload.
 */
const exportCompiledResultSchema = z
  .object({
    transferId: z.string().min(1).max(64),
    hash: z.string().regex(HEX64_RE),
    size: z.number().int().nonnegative().max(EXPORT_COMPILED_MAX_BYTES),
    // The ONLY artifact media type A1 accepts — validated on the descriptor (rd-A1
    // §6); the received blob's mime is checked against it too.
    mime: z.literal(EXPORT_COMPILED_MIME),
  })
  .passthrough();

/**
 * A project room id must look like what the browser's Share/open flow MINTS:
 * the `share-` prefix plus >=16 chars of CSPRNG body (uuid/hex charset). The
 * stable project id is NEVER itself a room capability (ADR-0021), so anything
 * else — including the control room id — is refused before any join.
 */
const PROJECT_ROOM_RE = /^share-[A-Za-z0-9-]{16,}$/;

/**
 * The per-grant token's accepted shape (ADR-0023 §1): a non-empty, bounded
 * base64url token (`[A-Za-z0-9_-]`). It is bound into the proposal signing scope
 * AND the HKDF key, so a value outside this charset would derive a mismatched
 * key — the kernel re-checks it (the browser responder validated it too) before
 * binding it to the joined session.
 */
const GRANT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Why an open_project grantId is unacceptable, or null when it passes (ADR-0023 §1). */
export function projectGrantViolation(grantId: string): string | null {
  if (grantId.length === 0) return "grantId must be a non-empty string";
  if (grantId.length > CONTROL_TOOL_LIMITS.maxGrantIdChars) {
    return `grantId exceeds ${CONTROL_TOOL_LIMITS.maxGrantIdChars} characters`;
  }
  if (!GRANT_ID_RE.test(grantId)) {
    return "grantId is not a base64url token (charset [A-Za-z0-9_-])";
  }
  return null;
}

/** Why an open_project room id is unacceptable, or null when it passes. */
export function projectRoomViolation(room: string, controlRoom: string): string | null {
  if (room.length > CONTROL_TOOL_LIMITS.maxRoomChars) {
    return `room id exceeds ${CONTROL_TOOL_LIMITS.maxRoomChars} characters`;
  }
  if (!PROJECT_ROOM_RE.test(room)) {
    return "room id is not a freshly minted share room (expected share-<random> — " +
      "the browser must mint a project room, never reuse another identifier)";
  }
  if (room === controlRoom) {
    return "room id is the control room itself — a project room must be a fresh share room";
  }
  return null;
}

/**
 * Why an open_project syncUrl is unacceptable, or null when it passes. The
 * accepted set, documented (local-first, mirroring the compile-URL posture):
 *   - scheme ws:// or wss://, parseable, no embedded credentials, no query or
 *     fragment (the session appends `/<room>` — extra URL parts would smuggle
 *     state into the join), AND
 *   - a LOOPBACK host (localhost / 127.0.0.0/8 / ::1; any port), OR exactly
 *     the relay this kernel was configured with (same scheme, host, port, and
 *     path) — the project room lives on the same relay as the control room in
 *     every supported deployment, so anything else is treated as a redirect
 *     attempt and refused.
 */
export function projectSyncUrlViolation(raw: string, configuredSyncUrl: string): string | null {
  if (raw.length > CONTROL_TOOL_LIMITS.maxSyncUrlChars) {
    return `syncUrl exceeds ${CONTROL_TOOL_LIMITS.maxSyncUrlChars} characters`;
  }
  if (!/^wss?:\/\//.test(raw)) return "syncUrl must be a ws:// or wss:// URL";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "syncUrl is not a valid URL";
  }
  if (url.username !== "" || url.password !== "") {
    return "syncUrl must not contain credentials";
  }
  if (url.search !== "" || url.hash !== "") {
    return "syncUrl must not contain a query or fragment";
  }
  if (isLoopbackHost(url.hostname)) return null;
  let configured: URL;
  try {
    configured = new URL(configuredSyncUrl);
  } catch {
    return "the kernel's configured sync URL is not parseable"; // unreachable: config validated it
  }
  const trim = (p: string): string => p.replace(/\/+$/, "");
  const sameRelay =
    url.protocol === configured.protocol &&
    url.hostname === configured.hostname &&
    url.port === configured.port &&
    trim(url.pathname) === trim(configured.pathname);
  if (!sameRelay) {
    // Described, never quoted (Security round 3): the OFFERED url is hostile
    // peer text, and the CONFIGURED relay url is deployment detail — neither
    // belongs in a client-visible payload.
    return (
      "the offered sync URL is neither loopback nor this kernel's configured relay " +
      "(scheme, host, port, and path must all match) — refusing to join a foreign relay"
    );
  }
  return null;
}

/** One validated project row surfaced by list_projects. */
const projectEntrySchema = z
  .object({
    projectId: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxProjectIdChars),
    name: z.string().max(CONTROL_TOOL_LIMITS.maxNameChars),
    lastModified: z.number().finite().optional(),
  })
  // Tolerate (and DROP) extra fields a newer responder may add — the kernel
  // re-emits only the validated picks, never a passthrough of peer data.
  .passthrough();

const projectListSchema = z.array(projectEntrySchema);

/**
 * The validated `create_project` control response (F1): the browser (the
 * project-library authority) minted a brand-new registry-only project and
 * returned its `{projectId, name}`. Bounded on the read side like every other
 * responder payload; extra fields tolerated and DROPPED.
 */
const createProjectResultSchema = z
  .object({
    projectId: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxProjectIdChars),
    name: z.string().max(CONTROL_TOOL_LIMITS.maxNameChars),
  })
  .passthrough();

/** One validated version-metadata row surfaced by list_versions (NO file contents). */
const versionEntrySchema = z
  .object({
    id: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxProjectIdChars),
    name: z.string().max(CONTROL_TOOL_LIMITS.maxNameChars),
    message: z.string().max(CONTROL_TOOL_LIMITS.maxMessageChars).optional(),
    createdAt: z.number().finite().optional(),
  })
  .passthrough();

const versionListSchema = z.array(versionEntrySchema);

/** The open_project handoff payload (shape only — posture checks follow). */
const openProjectSchema = z
  .object({
    syncUrl: z.string().max(CONTROL_TOOL_LIMITS.maxSyncUrlChars),
    room: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxRoomChars),
    projectId: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxProjectIdChars),
    mainFile: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxMainFileChars),
    grantId: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxGrantIdChars),
  })
  .passthrough();

/**
 * A validated content-tool result (#1 slice 1): the browser-side registry
 * adapter answers `{ text, summary }`. Bounded on the read side like every
 * other responder payload; extra fields are tolerated and DROPPED.
 */
const toolResultSchema = z
  .object({
    text: z.string().max(CONTROL_TOOL_LIMITS.maxToolTextChars),
    summary: z.string().max(CONTROL_TOOL_LIMITS.maxToolSummaryChars).optional(),
  })
  .passthrough();

/**
 * A validated list_version_files result (B4): the browser answers `{files, truncated}`
 * where each file is `{path, size}` — METADATA ONLY, never the text. Bounded on the
 * read side like every other responder payload; extra fields tolerated and DROPPED.
 */
const versionFileEntrySchema = z
  .object({
    path: z.string().max(CONTROL_TOOL_LIMITS.maxMainFileChars),
    size: z.number().finite().nonnegative(),
  })
  .passthrough();

const versionFilesResultSchema = z
  .object({
    files: z.array(versionFileEntrySchema).max(CONTROL_TOOL_LIMITS.maxVersionEntries),
    truncated: z.boolean().optional(),
  })
  .passthrough();

/**
 * A validated read_version_file result (B4): the browser answers `{text}` — one
 * file's contents at a named version. Bounded by the same `maxToolTextChars` cap
 * as every other content-tool text body (the honest responder clamps far below it).
 */
const versionFileTextSchema = z
  .object({
    text: z.string().max(CONTROL_TOOL_LIMITS.maxToolTextChars),
  })
  .passthrough();

/**
 * A validated `request_restore_version` result (B3): the browser computed the
 * restore diff and returned a STRUCTURED domain outcome. The kernel NEVER writes
 * files — it only relays this. The DOMAIN outcomes ride on `ok:true` (C2) so they
 * survive the rpc layer's refusal-flattening (a non-consent `ok:false` is
 * collapsed to one generic line, losing the reason); the agent can therefore tell
 * a `not_open` from a `too_large` from a real `restore_proposed`. The status is a
 * CLOSED enum so a hostile/buggy peer cannot smuggle an "applied" claim through
 * this channel; `proposalId` rides only with `restore_proposed`. Extra fields
 * tolerated and DROPPED.
 */
const restoreVersionResultSchema = z
  .object({
    status: z.enum([
      "restore_proposed",
      "no_changes",
      "not_open",
      "unknown_version",
      "too_large",
      "conflict",
    ]),
    proposalId: z.string().min(1).max(CONTROL_TOOL_LIMITS.maxProjectIdChars).optional(),
  })
  .passthrough();

/**
 * The responder's machine-readable consent marker (#1 slice 1): a refusal whose
 * error starts with this means "the human has not granted file access for that
 * project yet" — the kernel maps it to a clean tell-the-user-where-to-click
 * message instead of relaying the raw refusal envelope.
 */
const CONSENT_REQUIRED_MARKER = "consent-required";

/** The clean MCP error for a consent-required refusal. Static, helpful, honest.
 * The projectId is the CLIENT's own argument (bounded by the input schema), and
 * it is JSON-escaped anyway so a control character can never break the line. */
function consentRequiredError(tool: string, projectId: string): string {
  return (
    `${tool}: the browser has not granted file access for project ${JSON.stringify(projectId)} ` +
    "in this session — in Galley, open Settings → Agent Access and click " +
    '"Allow file access (this session)" for that project, then retry'
  );
}

/** The registry's own description for a tool name (the specs are workspace-shared). */
function registryDescription(name: string): string {
  return TOOL_REGISTRY.find((e) => e.spec.name === name)?.spec.description ?? "";
}

export interface ControlToolDeps {
  /** The bounded control-room RPC (control.ts). */
  rpc(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ControlRpcOutcome>;
  /** The kernel's OWN configured relay — the origin anchor for the syncUrl posture. */
  configuredSyncUrl: string;
  /** The control room id (an open_project response must never name it as the project room). */
  controlRoom: string;
  /**
   * The per-session pairing secret (ADR-0021 HIGH-1). The kernel already holds it
   * to VERIFY control responses; ADR-0023 §1 also uses it to derive the per-grant
   * key that SIGNS proposals, so it is threaded into the project-room join.
   */
  responseKey: Uint8Array;
  /** The compile seam for the per-project tools registered after open_project. */
  compileService?: CompileService;
  /** Injectable project-room join for tests; defaults to the REAL session machinery. */
  joinProject?: (config: {
    syncUrl: string;
    room: string;
    filePath: string;
    grantId: string;
    controlRoom: string;
    projectId: string;
    responseKey: Uint8Array;
  }) => KernelSession;
  /** How long open_project waits for the project file to replicate after the join. */
  projectReadyTimeoutMs?: number;
  /**
   * How long the open_project RPC waits for the browser to ANSWER (#16.3).
   * Default 120_000ms — far longer than the default control RPC timeout
   * (CONTROL_RPC_TIMEOUT_MS, 10s) because a human must approve the per-request
   * consent modal in the browser first. The browser auto-denies at 90s, so the
   * kernel (waiting 120s) always gets a definite answer before its own deadline.
   * list_projects / list_versions keep the default. Injectable for tests.
   */
  openProjectRpcTimeoutMs?: number;
}

/** Default open_project RPC wait (#16.3) — accommodates human consent in the browser. */
export const OPEN_PROJECT_RPC_TIMEOUT_MS = 120_000;

/** Mint a fresh, unguessable transferId (A1) — 16 CSPRNG bytes as 32 lowercase hex. */
function mintExportTransferId(): string {
  return randomBytes(16).toString("hex");
}

/** Deps for {@link registerExportCompiledTool} (A1) — the control RPC + the joined session. */
export interface ExportCompiledToolDeps {
  rpc(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ControlRpcOutcome>;
  /** The blob channel of the joined project room (opt-in — connected on first use). */
  blob: KernelBlobSession;
  /** The bound project id (echoed in the RPC; the responder must answer for it). */
  projectId: string;
  /** Injectable caps/timeout for tests; default to the module constants. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Injectable transferId minter for tests; default CSPRNG. */
  mintTransferId?: () => string;
}

/** Deps for {@link buildBinaryUploader} (A2) — the control RPC + the joined session blob channel. */
export interface BinaryUploaderDeps {
  rpc(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ControlRpcOutcome>;
  /** The blob channel of the joined project room (opt-in — connected on first use). */
  blob: KernelBlobSession;
  /** The bound project id (echoed in the expect_blob RPC; the responder must answer for it). */
  projectId: string;
}

/** The expect_blob RPC result shape the browser returns (A2): whether it reserved capacity. */
const expectBlobResultSchema = z.object({ reserved: z.boolean() });

/**
 * Build the binary-upload seam (A2) the per-project `propose_files` tool calls per
 * create-binary op. The kernel is the SENDER. Per blob:
 *   1. hash = sha256(bytes), size = bytes.length;
 *   2. ensure the blob channel is connected, then ASK the browser to RESERVE
 *      inbound capacity via the `expect_blob {projectId, hash, size}` control RPC
 *      (the descriptor + the bytes race on different sockets, so the reservation
 *      must exist before the push). A non-ok RPC / a `{reserved:false}` →
 *      `blob_quota_exceeded` (the browser refused — no channel / not authenticated
 *      / buffer full); publish NOTHING.
 *   3. `putBlob(bytes, mime)` — push the bytes; resolves ONLY on the browser's
 *      MAC-verified COMPLETE. A reject → `push_failed`; publish NOTHING.
 * Returns the content-addressed `{hash,size,mime}` pointer on success. Fail-closed
 * + structured: the propose_files handler turns a failure into a no-publish result.
 */
export function buildBinaryUploader(deps: BinaryUploaderDeps): NonNullable<KernelTools["uploadBinary"]> {
  return async (bytes, mime) => {
    const size = bytes.length;
    if (size > BLOB_UPLOAD_MAX_BYTES) {
      return {
        ok: false,
        reason: "blob_too_large",
        message: `the file is ${size} bytes — the limit is ${BLOB_UPLOAD_MAX_BYTES}`,
      };
    }
    let hash: string;
    try {
      hash = await sha256Hex(bytes);
    } catch {
      return { ok: false, reason: "push_failed", message: "the bytes could not be hashed" };
    }
    deps.blob.connect(); // opt-in; idempotent
    // RESERVE on the browser BEFORE pushing — the bytes may arrive before the
    // browser would otherwise expect them, and an unexpected inbound transfer is
    // rejected. A non-ok/`reserved:false` means the browser declined (no channel,
    // unauthenticated, or buffer full) → fail closed, push nothing.
    let reserved = false;
    try {
      const outcome = await deps.rpc("expect_blob", { projectId: deps.projectId, hash, size });
      if (outcome.ok) {
        const parsed = expectBlobResultSchema.safeParse(outcome.result);
        reserved = parsed.success && parsed.data.reserved;
      }
    } catch {
      reserved = false;
    }
    if (!reserved) {
      return {
        ok: false,
        reason: "blob_quota_exceeded",
        message: "the browser could not reserve capacity for the upload (channel unavailable or buffer full)",
      };
    }
    // PUSH the bytes; `putBlob` resolves ONLY on the browser's verified COMPLETE.
    try {
      const result = await deps.blob.putBlob(bytes, mime);
      return { ok: true, hash: result.hash, size: result.size, mime };
    } catch {
      // The push failed/aborted/timed out. Best-effort release of the browser's
      // reservation is not exposed here (the transport aborts its own in-flight
      // transfer); the reservation expires browser-side. Publish nothing.
      return { ok: false, reason: "push_failed", message: "the upload could not be delivered to the browser" };
    }
  };
}

/** The hard ceiling on ONE binary upload (A2). Mirrors the mailbox blob cap (64 MiB). */
export const BLOB_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Build the binary-RELEASE seam (A2/C1b) the propose_files tool calls when an
 * upload fails partway, or publish throws after bytes were uploaded. It sends a
 * best-effort `release_blob {projectId, hashes:[{hash,size}]}` control RPC so the
 * browser drops the earlier reservations (and their lease timers). Never throws;
 * a failed release is swallowed (the browser's lease will still auto-release).
 */
export function buildBinaryReleaser(deps: {
  rpc(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ControlRpcOutcome>;
  projectId: string;
}): NonNullable<KernelTools["releaseBinary"]> {
  return async (hashes) => {
    if (hashes.length === 0) return;
    try {
      await deps.rpc("release_blob", { projectId: deps.projectId, hashes });
    } catch {
      // best-effort: the browser's expect_blob lease auto-releases regardless.
    }
  };
}

/**
 * The validated browser-routed `compile` result (F9). The browser answers
 * `{ok, pageCount, diagnostics}` — the diagnostics it already computed for its
 * live preview. Bound the array length AND each diagnostic's message/path so a
 * project (or a hostile peer seeding the room) cannot overflow the control-RPC
 * record cap or flood a downstream model; drop any extra fields the responder
 * sends (`.passthrough()` tolerates them but we re-emit only the validated picks).
 */
const compileBrowserResultSchema = z
  .object({
    ok: z.boolean(),
    pageCount: z.number().int().nonnegative().nullable(),
    diagnostics: z
      .array(
        z
          .object({
            severity: z.enum(["error", "warning"]),
            message: z.string().max(CONTROL_TOOL_LIMITS.maxToolTextChars),
            path: z.string().max(CONTROL_TOOL_LIMITS.maxMainFileChars).optional(),
          })
          .passthrough(),
      ),
  })
  .passthrough();

/**
 * Build the browser-routed compile seam (F9/F5) the per-project `compile` tool
 * uses when NO loopback `--compile-url` is configured. It asks the paired browser
 * — which already compiles its live preview — to relay the diagnostics it computed
 * via the `compile {projectId}` control RPC. DIAGNOSTICS ONLY: no document leaves
 * the browser, no PDF bytes ride along (that is export_compiled's blob-channel job).
 * Fail-closed + structured:
 *   - a non-ok RPC (refusal / timeout) → `{error}` with the kernel-local text
 *     (control.ts already flattens a peer refusal into `outcome.error`);
 *   - a result that does not parse → `{error: "the browser returned an invalid
 *     compile result"}` (never the raw payload);
 *   - on success re-emit ONLY the validated picks, escaping control chars on the
 *     author-controlled message/path (same policy as list_files/list_versions).
 * The kernel's `compile` handler maps `{error}` → an isError result and a parsed
 * `{ok,pageCount,diagnostics}` → its `source:"browser"` payload.
 */
export function buildBrowserCompiler(deps: {
  rpc(op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<ControlRpcOutcome>;
  projectId: string;
}): NonNullable<KernelTools["compileBrowser"]> {
  return async () => {
    const outcome = await deps.rpc("compile", { projectId: deps.projectId });
    if (!outcome.ok) return { error: outcome.error };
    const parsed = compileBrowserResultSchema.safeParse(outcome.result);
    if (!parsed.success) return { error: "the browser returned an invalid compile result" };
    return {
      ok: parsed.data.ok,
      pageCount: parsed.data.pageCount,
      // Bound the relayed set: a project (or hostile peer) may seed more than the
      // cap — slice rather than reject so a valid compile result with many
      // diagnostics still reaches the agent (F9/F5).
      diagnostics: parsed.data.diagnostics.slice(0, CONTROL_TOOL_LIMITS.maxDiagnostics).map((d) => ({
        severity: d.severity,
        message: escapeControlChars(d.message),
        ...(d.path !== undefined ? { path: escapeControlChars(d.path) } : {}),
      })),
    };
  };
}

/**
 * Register the `export_compiled` tool (A1) for a joined session. The handshake:
 *   1. MINT a fresh transferId, ensure the kernel blob channel is connected, and
 *      RESERVE inbound capacity (`expectTransfer`) BEFORE sending the RPC — the
 *      descriptor + bytes race on different sockets, so the reservation must exist
 *      before the browser pushes.
 *   2. Send the control RPC `export_compiled {projectId, transferId, maxBytes}`.
 *   3. The browser compiles, pushes the PDF over the blob channel under the SAME
 *      transferId, and returns the SIGNED `{transferId, hash, size, mime}`.
 *   4. The kernel awaits BOTH the verified signed response (the rpc layer checks
 *      the HMAC) AND the matching received blob, and SUCCEEDS only when the blob's
 *      {hash,size} EQUAL the signed descriptor's. THE SECURITY CRUX: a 3rd room
 *      peer can push bytes but cannot forge the signed descriptor, and the kernel
 *      accepts only a blob matching that descriptor.
 *   5. On RPC failure / id or {hash,size} mismatch / timeout → FAIL CLOSED and
 *      release the reservation (`unexpectTransfer`).
 * The artifact stays in the kernel blob buffer accessible by hash; the tool
 * returns `{status:"exported", hash, size, mime}` (no inline bytes — A1 exposes
 * the metadata + a takeable handle).
 */
export function registerExportCompiledTool(server: McpServer, deps: ExportCompiledToolDeps): void {
  const maxBytes = deps.maxBytes ?? EXPORT_COMPILED_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? EXPORT_COMPILED_TIMEOUT_MS;
  const mint = deps.mintTransferId ?? mintExportTransferId;

  server.registerTool(
    "export_compiled",
    {
      title: "Export the compiled PDF",
      description:
        "Asks the browser to compile the OPEN project's document and return the resulting PDF to " +
        "this kernel over the secure byte channel. Read-only — it never changes the document. " +
        "Returns the artifact's { hash, size, mime } once the verified PDF has been received; the " +
        "bytes are held by the kernel keyed by that hash and can be written to local disk with " +
        "save_artifact { hash, destPath }. Requires the project to be open and shared with Agent " +
        "Access; fails closed (with a structured error) on a compile failure, a descriptor " +
        "mismatch, or a timeout.",
      inputSchema: {},
    },
    async () => {
      const blob = deps.blob;
      // MINT + RESERVE before the RPC (the bytes may arrive before the response).
      const transferId = mint();
      blob.connect(); // opt-in; idempotent
      if (!blob.expectTransfer(transferId, maxBytes)) {
        return errorResult(
          "export_compiled: could not reserve buffer capacity for the export (the kernel blob " +
            "buffer is full) — try again shortly",
        );
      }
      // CENTRALIZED failure cleanup (rd-A1 §4): on EVERY non-success exit, DRAIN any
      // delivered-but-unpromoted candidate AND withdraw the reservation (which also
      // aborts a bound in-flight transfer), so a delivered blob is never orphaned and
      // the quota is freed exactly once. `unexpectTransfer` itself drops the buffered
      // candidate, so this is leak-free.
      const fail = (message: string): ReturnType<typeof errorResult> => {
        blob.unexpectTransfer(transferId);
        return errorResult(message);
      };
      // ONE absolute deadline for the WHOLE handshake (rd-A1 §6): the RPC wait AND
      // the blob wait share it, so the export honors the single documented budget
      // instead of stacking two full timeouts.
      const deadline = Date.now() + timeoutMs;
      try {
        const outcome = await deps.rpc(
          "export_compiled",
          { projectId: deps.projectId, transferId, maxBytes },
          timeoutMs,
        );
        if (!outcome.ok) return fail(`export_compiled: ${outcome.error}`);
        const parsed = exportCompiledResultSchema.safeParse(outcome.result);
        if (!parsed.success) {
          return fail(
            "export_compiled: the responder returned an invalid response (expected " +
              "{transferId, hash, size, mime:'application/pdf'})",
          );
        }
        const descriptor = parsed.data;
        // The responder must answer for the id WE minted — a swapped id is refused
        // (it would correlate the bytes with a different reservation).
        if (descriptor.transferId !== transferId) {
          return fail(
            "export_compiled: the responder answered for a different transfer — refusing the export",
          );
        }
        // THE SECURITY CRUX + the candidate/promote LOOP (rd-A1 §2). Now the SIGNED
        // descriptor {hash,size,mime} is known, wait for a CANDIDATE that MATCHES it,
        // within the REMAINING budget of the SINGLE absolute deadline. A 3rd peer's
        // forged early candidate (wrong hash/size/mime) is DISCARDED and the wait
        // continues with the reservation STILL LIVE — so the real browser's transfer
        // still promotes. Only a matching candidate succeeds; a deadline with no match
        // fails closed. The reservation is withdrawn exactly once (on promotion via
        // the success path's unexpectTransfer, or on timeout/error via fail()).
        const remaining = Math.max(0, deadline - Date.now());
        const matches = (b: ReceivedBlob): boolean =>
          b.hash === descriptor.hash && b.size === descriptor.size && b.mime === descriptor.mime;
        const received = await blob.awaitMatchingCandidate(transferId, matches, remaining);
        if (received === undefined) {
          return fail(
            "export_compiled: a compiled PDF matching the signed descriptor was not received " +
              "within the deadline — the export did not complete",
          );
        }
        // Success: TAKE the verified, descriptor-matching artifact (transferId-scoped,
        // so concurrent same-hash exports never collide), RETAIN it in the hash-keyed
        // buffer so save_artifact can later fetch it by hash, then withdraw the
        // transferId reservation (net-neutral accounting — retainBlob charges one
        // buffer slot, unexpectTransfer frees the >= blob.size transfer reservation).
        // A1 does not inline the bytes in the MCP response.
        const artifact = blob.takeBlobByTransfer(transferId);
        const retained = artifact !== undefined ? blob.retainBlob(artifact) : false;
        blob.unexpectTransfer(transferId);
        return jsonResult({
          status: "exported",
          hash: received.hash,
          size: received.size,
          mime: descriptor.mime,
          note: retained
            ? "bytes held by the kernel — call save_artifact { hash, destPath } to write them to local disk"
            : "artifact bytes already consumed",
        });
      } catch (err) {
        return fail(`export_compiled: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

/** Deps for {@link registerSaveArtifactTool} (F11) — the joined session blob channel. */
export interface SaveArtifactToolDeps {
  /** The blob channel of the joined project room — holds exported PDFs keyed by hash. */
  blob: KernelBlobSession;
  /** Injectable fs writer for tests; defaults to node:fs/promises writeFile. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>;
}

/**
 * Register the `save_artifact` tool (F11) for a joined session. It writes the
 * bytes of a previously exported artifact (the PDF held by export_compiled, keyed
 * by its sha256 hash) to a path on THIS kernel host's LOCAL filesystem.
 *
 * Retention/consume semantics (road-test note): export_compiled RETAINS the
 * verified PDF in the hash-keyed buffer; save_artifact CONSUMES that pin on the
 * first successful write (takeBlob removes it), so a second save of the same hash
 * fails closed and the agent must re-run export_compiled. A transient write failure
 * (e.g. a bad/unwritable destPath) RE-PINS the bytes so the only copy is not lost
 * and the agent can retry with a corrected path.
 *
 * Security posture (documented, MVP): destPath is NOT confined — the kernel will
 * write to any path its process can write. The bytes themselves are integrity-
 * verified (sha256 matched the signed descriptor at export time), but an agent
 * could overwrite arbitrary files the kernel can write. Path confinement (reject
 * traversal / confine to an output dir) is a follow-up if the operator wants it.
 * isSafeProjectPath is deliberately NOT used here (it validates CRDT project paths,
 * not host FS paths). Fails closed (structured error) on unknown/expired hash or an
 * unwritable destPath, mirroring export_compiled.
 */
export function registerSaveArtifactTool(server: McpServer, deps: SaveArtifactToolDeps): void {
  const write = deps.writeFile ?? ((p: string, d: Uint8Array) => writeFile(p, d));
  server.registerTool(
    "save_artifact",
    {
      title: "Save an exported artifact to local disk",
      description:
        "Writes the bytes of a previously exported artifact (the PDF returned by export_compiled, " +
        "identified by its sha256 hash) to a path on THIS kernel host's local filesystem. The bytes " +
        "must already be held by the kernel (run export_compiled first; the hold is consumed on the " +
        "first successful save). Read-only with respect to the project — it never changes the " +
        "document. Returns { status: \"saved\", path, size }. Fails closed with a structured error " +
        "when the hash is unknown or expired (export_compiled was not run, or the buffer evicted/" +
        "already-consumed it) or when destPath cannot be written.",
      inputSchema: {
        hash: z
          .string()
          .regex(HEX64_RE)
          .describe("The sha256 hash returned by export_compiled (lowercase 64-hex)."),
        destPath: z
          .string()
          .min(1)
          .max(SAVE_ARTIFACT_MAX_PATH_CHARS)
          .describe(
            "An absolute or relative path on the kernel host to write the bytes to. " +
              "Existing files are overwritten.",
          ),
      },
    },
    async ({ hash, destPath }) => {
      const artifact = deps.blob.takeBlob(hash);
      if (artifact === undefined) {
        return errorResult(
          "save_artifact: no held artifact with that hash — run export_compiled first (the held " +
            "bytes are consumed on the first successful save, and may expire if the buffer is reused)",
        );
      }
      try {
        await write(destPath, artifact.bytes);
      } catch (err) {
        // Re-PIN the bytes so a transient write failure (e.g. a bad path) does not
        // silently discard the only copy — the agent can retry with a corrected
        // destPath. Best-effort; if re-pin fails the bytes are gone but the error
        // is still structured.
        deps.blob.retainBlob(artifact);
        return errorResult(
          `save_artifact: could not write to the destination path (${
            err instanceof Error ? err.message : String(err)
          }) — the artifact is still held; retry with a writable path`,
        );
      }
      return jsonResult({ status: "saved", path: destPath, size: artifact.size });
    },
  );
}

/**
 * Register the three control tools on `server`. After the first successful
 * `open_project` this ALSO registers the existing per-project tools, bound to
 * the joined project room (the MCP SDK notifies clients of the change).
 */
export function registerControlTools(server: McpServer, deps: ControlToolDeps): void {
  const joinProject = deps.joinProject ?? joinRoom;

  /** The one project this session is bound to, once open_project succeeded. */
  let bound: { projectId: string; room: string } | undefined;
  /** Guards CONCURRENT open_project calls — only one join may be in flight. */
  let opening = false;

  /**
   * Handles for the consent-gated CONTENT tools (#1 slice 1), so a successful
   * open_project can RETIRE them before registering the per-project tools —
   * the per-project mode reuses the `list_files`/`read_file` names (different,
   * room-scoped semantics), and the SDK refuses duplicate registrations. The
   * fake servers in tests return no handle; removal is strictly best-effort.
   */
  const contentToolHandles: Array<{ remove?: () => void } | undefined> = [];

  /** Run one consent-gated content tool over the control mailbox (#1 slice 1). */
  const runContentTool = async (
    tool: string,
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<ReturnType<typeof jsonResult>> => {
    const outcome = await deps.rpc(tool, { projectId, ...params });
    if (!outcome.ok) {
      // The typed consent refusal → a clean "go grant it" message. Since
      // MEDIUM-3, `outcome.error` is ALWAYS kernel-local text (the rpc layer
      // classifies even VERIFIED, HMAC-authenticated responder refusals into
      // local strings), so nothing relayed here ever originated on the wire.
      if (outcome.error.includes(CONSENT_REQUIRED_MARKER)) {
        return errorResult(consentRequiredError(tool, projectId));
      }
      return errorResult(`${tool}: ${outcome.error}`);
    }
    const parsed = toolResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return errorResult(
        `${tool}: the responder returned an invalid response (expected {text, summary?})`,
      );
    }
    // Re-emit only the validated text — never a passthrough of peer data.
    return textResult(parsed.data.text);
  };

  /**
   * Run one consent-gated VERSION-FILE tool over the control mailbox (B4). Same
   * consent-refusal mapping as runContentTool, but the two ops have DISTINCT
   * result shapes (a `{files, truncated}` metadata list vs a `{text}` body), so
   * each is validated against its own schema and re-emitted as VALIDATED picks
   * only — never a passthrough of peer data.
   */
  const runVersionFileTool = async (
    tool: "list_version_files" | "read_version_file",
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<ReturnType<typeof jsonResult>> => {
    const outcome = await deps.rpc(tool, { projectId, ...params });
    if (!outcome.ok) {
      if (outcome.error.includes(CONSENT_REQUIRED_MARKER)) {
        return errorResult(consentRequiredError(tool, projectId));
      }
      return errorResult(`${tool}: ${outcome.error}`);
    }
    if (tool === "list_version_files") {
      const parsed = versionFilesResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        return errorResult(
          "list_version_files: the responder returned an invalid response (expected " +
            "{files: [{path, size}], truncated?})",
        );
      }
      // Re-emit only the validated picks: author-controlled paths get the same
      // control-char escape as list_files/list_versions (a crafted filename must
      // not fake new lines of output to a downstream model); zod capped lengths.
      const files = parsed.data.files.map((f) => ({
        path: escapeControlChars(f.path),
        size: f.size,
      }));
      return jsonResult({ files, truncated: parsed.data.truncated === true });
    }
    const parsed = versionFileTextSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return errorResult(
        "read_version_file: the responder returned an invalid response (expected {text})",
      );
    }
    return textResult(parsed.data.text);
  };

  /**
   * Run the consent-gated `request_restore_version` tool over the control mailbox
   * (B3). Consent stays a REFUSAL (mapped to the clean "grant it in Settings"
   * error). Every other DOMAIN outcome rides on `ok:true` as a STRUCTURED status
   * (C2) — `restore_proposed` (a proposal was published for the human's Accept),
   * `no_changes`, `not_open`, `unknown_version`, `too_large`, `conflict` — so the
   * agent learns WHY rather than getting one flattened "refused" line. The kernel
   * NEVER mutates; it relays only the VALIDATED status + a kernel-local human
   * message per status; an invalid/unknown status is refused, never relayed, so a
   * peer can't fake an "applied" claim.
   */
  const restoreStatusMessage: Record<string, string> = {
    restore_proposed:
      "A restore proposal was published — open Galley and Accept it (the compare card) to apply it.",
    no_changes: "The project already matches that version — nothing to restore.",
    not_open: "That project is not open in Galley — open it there, then retry.",
    unknown_version: "No such version for that project.",
    too_large: "That version is too large to restore atomically — too many changed files.",
    conflict:
      "The project has duplicate file paths, so the restore is ambiguous — resolve the duplicates in Galley, then retry.",
  };
  const runRestoreVersionTool = async (
    projectId: string,
    versionId: string,
  ): Promise<ReturnType<typeof jsonResult>> => {
    const outcome = await deps.rpc("request_restore_version", { projectId, versionId });
    if (!outcome.ok) {
      // Consent is the ONLY refusal path here (kept a refusal to avoid an
      // existence oracle); everything else is a structured ok:true status below.
      if (outcome.error.includes(CONSENT_REQUIRED_MARKER)) {
        return errorResult(consentRequiredError("request_restore_version", projectId));
      }
      return errorResult(`request_restore_version: ${outcome.error}`);
    }
    const parsed = restoreVersionResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      return errorResult(
        "request_restore_version: the responder returned an invalid response (expected " +
          "{status:'restore_proposed'|'no_changes'|'not_open'|'unknown_version'|'too_large'|'conflict', proposalId?})",
      );
    }
    // Re-emit only the validated picks (drop any extra peer fields) + a local
    // human message so the agent can act on the outcome without parsing raw text.
    return jsonResult({
      status: parsed.data.status,
      message: restoreStatusMessage[parsed.data.status] ?? "",
      ...(parsed.data.proposalId !== undefined ? { proposalId: parsed.data.proposalId } : {}),
    });
  };

  const projectIdArg = z
    .string()
    .min(1)
    .max(CONTROL_TOOL_LIMITS.maxProjectIdChars)
    .describe(
      "The project id as returned by list_projects. File access for that project must be " +
        "granted in Galley (Settings → Agent Access) for this session.",
    );

  const consentNote =
    " Requires the per-project file-access grant in Galley (Settings → Agent Access, " +
    "session-scoped); without it this fails with a consent-required error. Read-only.";

  // --- The consent-gated READ-ONLY content tools (#1 slice 1) --------------
  // Descriptions come from the shared registry specs (the same text the in-app
  // agent sees), plus the consent note. Registered ONLY in control mode and
  // retired when open_project binds the session to a project room.

  contentToolHandles.push(
    server.registerTool(
      "search_project",
      {
        title: "Search a granted project's files",
        description: registryDescription("search_project") + consentNote,
        inputSchema: {
          projectId: projectIdArg,
          query: z
            .string()
            .min(1)
            .max(CONTROL_TOOL_LIMITS.maxToolQueryChars)
            .describe("The literal text to search for (taken verbatim, case-insensitive)."),
        },
      },
      async ({ projectId, query }) => runContentTool("search_project", projectId, { query }),
    ) as unknown as { remove?: () => void } | undefined,
  );

  contentToolHandles.push(
    server.registerTool(
      "list_files",
      {
        title: "List a granted project's files",
        description: registryDescription("list_files") + consentNote,
        inputSchema: { projectId: projectIdArg },
      },
      async ({ projectId }) => runContentTool("list_files", projectId, {}),
    ) as unknown as { remove?: () => void } | undefined,
  );

  contentToolHandles.push(
    server.registerTool(
      "read_file",
      {
        title: "Read a granted project's file by path",
        description: registryDescription("read_file") + consentNote,
        inputSchema: {
          projectId: projectIdArg,
          path: z
            .string()
            .min(1)
            .max(CONTROL_TOOL_LIMITS.maxMainFileChars)
            .describe("The project path of the file to read (e.g. /main.typ)."),
        },
      },
      async ({ projectId, path }) => runContentTool("read_file", projectId, { path }),
    ) as unknown as { remove?: () => void } | undefined,
  );

  contentToolHandles.push(
    server.registerTool(
      "list_bibliography",
      {
        title: "List a granted project's bibliography",
        description: registryDescription("list_bibliography") + consentNote,
        inputSchema: { projectId: projectIdArg },
      },
      async ({ projectId }) => runContentTool("list_bibliography", projectId, {}),
    ) as unknown as { remove?: () => void } | undefined,
  );

  // --- The consent-gated READ-ONLY version-file tools (B4) -----------------
  // Read a past NAMED VERSION's files. Same per-project file-access grant as the
  // other content tools; metadata-shaped results (list) or one file's text (read),
  // bounded the same way and re-emitted as validated JSON. READ-ONLY — never a
  // restore (that is a separate, later capability).

  const versionIdArg = z
    .string()
    .min(1)
    .max(CONTROL_TOOL_LIMITS.maxProjectIdChars)
    .describe("The version id as returned by list_versions (the `id` field).");

  contentToolHandles.push(
    server.registerTool(
      "list_version_files",
      {
        title: "List the files captured in a project's named version",
        description:
          "Asks the browser for the file paths (and their sizes, in characters) captured in ONE " +
          "named version of a project — never the file contents. Use read_version_file to read a " +
          "file's text at that version." +
          consentNote,
        inputSchema: { projectId: projectIdArg, versionId: versionIdArg },
      },
      async ({ projectId, versionId }) =>
        runVersionFileTool("list_version_files", projectId, { versionId }),
    ) as unknown as { remove?: () => void } | undefined,
  );

  contentToolHandles.push(
    server.registerTool(
      "read_version_file",
      {
        title: "Read a file's contents at a named version",
        description:
          "Asks the browser for the TEXT of one file AS IT WAS in a named version of a project " +
          "(read-only — this never restores or changes anything). Oversized or binary files are " +
          "refused with a structured error rather than returned." +
          consentNote,
        inputSchema: {
          projectId: projectIdArg,
          versionId: versionIdArg,
          path: z
            .string()
            .min(1)
            .max(CONTROL_TOOL_LIMITS.maxMainFileChars)
            .describe("The project path of the file to read (e.g. /main.typ)."),
        },
      },
      async ({ projectId, versionId, path }) =>
        runVersionFileTool("read_version_file", projectId, { versionId, path }),
    ) as unknown as { remove?: () => void } | undefined,
  );

  // --- The consent-gated RESTORE-REQUEST tool (B3) -------------------------
  // REQUEST restoring a project to a past named version. This is NEVER a direct
  // mutation (ADR-0021): the browser computes the diff (live project → the target
  // version) and PUBLISHES it as a normal file proposal for the human's explicit
  // Accept (the compare/review card). The kernel only TRIGGERS the proposal and
  // relays the structured outcome. Same per-project file-access grant as the other
  // content tools; retired on open_project bind.

  contentToolHandles.push(
    server.registerTool(
      "request_restore_version",
      {
        title: "Request restoring a project to a named version",
        description:
          "Asks Galley to RESTORE a project to one of its past named versions. This NEVER changes " +
          "anything directly: the browser computes the difference between the project's current " +
          "files and the version's files and publishes it as a normal proposal that a human must " +
          "review and Accept (the compare card). Returns { status: 'restore_proposed', proposalId } " +
          "when a proposal was created, or { status: 'no_changes' } when the project already matches " +
          "the version. The project must be OPEN in Galley and file access granted for it." +
          consentNote,
        inputSchema: { projectId: projectIdArg, versionId: versionIdArg },
      },
      async ({ projectId, versionId }) => runRestoreVersionTool(projectId, versionId),
    ) as unknown as { remove?: () => void } | undefined,
  );

  /** Retire the content tools (idempotent, best-effort) before a project bind. */
  const removeContentTools = (): void => {
    for (const handle of contentToolHandles) {
      try {
        handle?.remove?.();
      } catch {
        // best-effort: a failed removal surfaces as the SDK's duplicate-name
        // error on the project bind, never as silent misbehavior.
      }
    }
    contentToolHandles.length = 0;
  };

  server.registerTool(
    "list_projects",
    {
      title: "List the Galley project library",
      description:
        "Asks the browser (the project-library authority) for its projects' METADATA: " +
        "projectId, name, and optionally lastModified. Requires Galley open in a browser " +
        "with Agent Access enabled; fails with a timeout otherwise. Read-only.",
      inputSchema: {},
    },
    async () => {
      const outcome = await deps.rpc("list_projects", {});
      if (!outcome.ok) return errorResult(`list_projects: ${outcome.error}`);
      const parsed = projectListSchema.safeParse(outcome.result);
      if (!parsed.success) {
        return errorResult(
          "list_projects: the responder returned an invalid response (expected an array of " +
            "{projectId, name, lastModified?})",
        );
      }
      const projects = parsed.data
        .slice(0, CONTROL_TOOL_LIMITS.maxProjectEntries)
        .map((p) => ({
          projectId: p.projectId,
          // Author-controlled name: escape control chars so a crafted name can't
          // fake new "lines" of output to a downstream model (one echo policy with
          // the project-tool path's sanitizeEcho; zod already caps the length).
          name: escapeControlChars(p.name),
          ...(p.lastModified !== undefined ? { lastModified: p.lastModified } : {}),
        }));
      return jsonResult({
        projects,
        truncated: parsed.data.length > projects.length,
      });
    },
  );

  // create_project (F1) is a CONTROL-mode tool (sibling of list_projects):
  // available before any open_project bind, gated ONLY by the Agent Access
  // pairing — there is no pre-existing project to grant per-project content
  // consent on. It is NOT in the `contentToolHandles` retire-on-bind set (it has
  // no per-project scope and never collides with the per-project tool names). The
  // browser is the project-library authority; the kernel only relays + validates.
  server.registerTool(
    "create_project",
    {
      title: "Create a new Galley project",
      description:
        "Asks the browser (the project-library authority) to create a brand-new, empty project " +
        "with the given name and add it to the library. Returns its { projectId, name }. The " +
        "project opens with blank starter content the first time a human opens it in Galley. " +
        "Requires Galley open with Agent Access enabled; fails with a timeout otherwise.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(CONTROL_TOOL_LIMITS.maxNameChars)
          .describe("A name for the new project (shown in the Galley project library)."),
      },
    },
    async ({ name }) => {
      const outcome = await deps.rpc("create_project", { name });
      if (!outcome.ok) return errorResult(`create_project: ${outcome.error}`);
      const parsed = createProjectResultSchema.safeParse(outcome.result);
      if (!parsed.success) {
        return errorResult(
          "create_project: the responder returned an invalid response (expected {projectId, name})",
        );
      }
      // Re-emit only the validated picks; the author-controlled name gets the same
      // control-char escape as list_projects (a crafted name must not fake new
      // "lines" of output to a downstream model; zod already capped the length).
      return jsonResult({
        projectId: parsed.data.projectId,
        name: escapeControlChars(parsed.data.name),
      });
    },
  );

  server.registerTool(
    "list_versions",
    {
      title: "List a project's named versions (metadata only)",
      description:
        "Asks the browser for one project's named-version METADATA (id, name, message, " +
        "createdAt) — never file contents. Use list_version_files / read_version_file to read " +
        "a file at a named version. Read-only.",
      inputSchema: {
        projectId: z
          .string()
          .min(1)
          .max(CONTROL_TOOL_LIMITS.maxProjectIdChars)
          .describe("The project id as returned by list_projects."),
      },
    },
    async ({ projectId }) => {
      const outcome = await deps.rpc("list_versions", { projectId });
      if (!outcome.ok) return errorResult(`list_versions: ${outcome.error}`);
      const parsed = versionListSchema.safeParse(outcome.result);
      if (!parsed.success) {
        return errorResult(
          "list_versions: the responder returned an invalid response (expected an array of " +
            "{id, name, message?, createdAt?})",
        );
      }
      const versions = parsed.data
        .slice(0, CONTROL_TOOL_LIMITS.maxVersionEntries)
        .map((v) => ({
          id: v.id,
          // Author-controlled name/message: same control-char escape as above.
          name: escapeControlChars(v.name),
          ...(v.message !== undefined ? { message: escapeControlChars(v.message) } : {}),
          ...(v.createdAt !== undefined ? { createdAt: v.createdAt } : {}),
        }));
      return jsonResult({
        projectId,
        versions,
        truncated: parsed.data.length > versions.length,
      });
    },
  );

  server.registerTool(
    "open_project",
    {
      title: "Open a project (the browser shares it; this session joins it)",
      description:
        "Asks the browser to OPEN a project: the browser opens it visibly, mints a fresh " +
        "share room for it, and this kernel joins that room — after which the per-project " +
        "tools (read_document, list_files, read_file, project_context, propose_edit, propose_files, compile) " +
        "become available, scoped to the project's main file. ONE project per kernel session: " +
        "once bound, further open_project calls fail until the kernel is restarted.",
      inputSchema: {
        projectId: z
          .string()
          .min(1)
          .max(CONTROL_TOOL_LIMITS.maxProjectIdChars)
          .describe("The project id as returned by list_projects."),
      },
    },
    async ({ projectId }) => {
      if (bound !== undefined) {
        return jsonResult({
          status: "already_open",
          projectId: bound.projectId,
          message:
            "this kernel session is already bound to a project — restart the kernel to open " +
            "a different one",
        });
      }
      if (opening) {
        return jsonResult({
          status: "open_in_progress",
          message: "another open_project call is in flight — wait for it to settle",
        });
      }
      opening = true;
      try {
        // Longer RPC budget than the metadata rpcs: the browser blocks on a
        // human consent modal before it can answer (#16.3).
        const outcome = await deps.rpc(
          "open_project",
          { projectId },
          deps.openProjectRpcTimeoutMs ?? OPEN_PROJECT_RPC_TIMEOUT_MS,
        );
        if (!outcome.ok) return errorResult(`open_project: ${outcome.error}`);
        const parsed = openProjectSchema.safeParse(outcome.result);
        if (!parsed.success) {
          return errorResult(
            "open_project: the responder returned an invalid response (expected " +
              "{syncUrl, room, projectId, mainFile, grantId})",
          );
        }
        const handoff = parsed.data;

        // The responder must echo the project we asked for — a swap is refused.
        if (handoff.projectId !== projectId) {
          return errorResult(
            "open_project: the responder answered for a DIFFERENT project id — refusing the handoff",
          );
        }
        const roomViolation = projectRoomViolation(handoff.room, deps.controlRoom);
        if (roomViolation !== null) return errorResult(`open_project: ${roomViolation}`);
        const urlViolation = projectSyncUrlViolation(handoff.syncUrl, deps.configuredSyncUrl);
        if (urlViolation !== null) return errorResult(`open_project: ${urlViolation}`);
        const mainFile = handoff.mainFile.startsWith("/")
          ? handoff.mainFile
          : `/${handoff.mainFile}`;
        if (!isSafeProjectPath(mainFile)) {
          return errorResult(
            "open_project: the responder returned an unsafe mainFile path — refusing the handoff",
          );
        }
        // The per-grant token (ADR-0023 §1): fail closed on a missing/oversized/
        // bad-charset grantId — the session binds it for proposal signing, and a
        // malformed value would derive a mismatched key. The browser validated it
        // too; the kernel is the second wall (responder is just another peer).
        const grantViolation = projectGrantViolation(handoff.grantId);
        if (grantViolation !== null) return errorResult(`open_project: ${grantViolation}`);

        // Join the project room with the EXISTING per-project machinery, binding
        // the validated grantId + the full scope + the pairing secret so the
        // session SIGNS every proposal it publishes (ADR-0023 §1). The browser
        // re-derives the same key from the same responseKey + scope to verify.
        const session = joinProject({
          syncUrl: handoff.syncUrl.replace(/\/+$/, ""),
          room: handoff.room,
          filePath: mainFile,
          grantId: handoff.grantId,
          controlRoom: deps.controlRoom,
          projectId,
          responseKey: deps.responseKey,
        });
        try {
          await session.whenFileReady(deps.projectReadyTimeoutMs ?? 15_000);
        } catch {
          session.destroy();
          // GENERIC on purpose (Security round 2, finding 2): the underlying
          // timeout message names the share room — a capability that must
          // reach neither the MCP client nor any log. No err.message echo.
          return errorResult(
            "open_project: the project room did not become ready in time (the project's main " +
              "file never replicated) — make sure the project stayed open in Galley, then retry",
          );
        }
        // The session is binding to ONE project room: retire the control-mode
        // content tools first (their `list_files`/`read_file` names belong to
        // the per-project tools from here on; #1 slice 1).
        removeContentTools();
        registerProjectTools(server, {
          surface: session.surface,
          // ADR-0024 §1: per-project results carry honest room-derived liveness.
          liveness: () => session.liveness(),
          ...(deps.compileService !== undefined ? { compileService: deps.compileService } : {}),
          // F9/F5: when NO loopback compile service is configured, route `compile`
          // through the BROWSER's live preview compiler over the control RPC. The
          // loopback service ALWAYS wins when present (we wire ONLY one of the two);
          // unlike export_compiled/uploadBinary this rides the control RPC, NOT the
          // blob socket, so it is wired even on a sync-only join (open_project always
          // has deps.rpc). server.ts consults this seam only when compileService is
          // absent, so the two never both answer.
          ...(deps.compileService === undefined
            ? { compileBrowser: buildBrowserCompiler({ rpc: deps.rpc, projectId }) }
            : {}),
          // A2 binary upload: wire the create-binary upload seam ONLY when this
          // join minted a blob channel (the real ws path always does; a sync-only
          // test injection may not). Both the control RPC (expect_blob) and the
          // session blob channel (putBlob) are in scope here. Absent → propose_files
          // refuses create-binary ops with `binary_unsupported`.
          ...(session.blob !== undefined
            ? {
                uploadBinary: buildBinaryUploader({
                  rpc: deps.rpc,
                  blob: session.blob,
                  projectId,
                }),
                // C1b: the release seam frees a failed upload's browser reservation.
                releaseBinary: buildBinaryReleaser({ rpc: deps.rpc, projectId }),
              }
            : {}),
        });
        // A1 export channel: register export_compiled ONLY when this join minted a
        // blob channel (the real ws path always does; a sync-only test injection may
        // not). It reaches BOTH the control RPC (deps.rpc) and the joined session's
        // blob channel here — the one place both are in scope.
        if (session.blob !== undefined) {
          registerExportCompiledTool(server, {
            rpc: deps.rpc,
            blob: session.blob,
            projectId,
          });
          // F11: save_artifact writes an export_compiled artifact (held by hash on
          // the same blob channel) to the kernel host's local disk.
          registerSaveArtifactTool(server, { blob: session.blob });
        }
        bound = { projectId, room: handoff.room };
        return jsonResult({
          status: "opened",
          projectId,
          mainFile,
          message:
            "project opened — the per-project tools (read_document, list_files, read_file, " +
            "project_context, propose_edit, propose_files, compile, export_compiled, save_artifact) are now available in this session",
        });
      } finally {
        opening = false;
      }
    },
  );
}
