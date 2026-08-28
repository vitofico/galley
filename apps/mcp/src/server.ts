import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyEdits } from "@galley/agent";
import {
  PROPOSAL_LIMITS,
  proposalSizeViolation,
  FILE_PROPOSAL_LIMITS,
  fileProposalSizeViolation,
  inferMime,
  sha256Hex,
  type FileProposalOp,
} from "@galley/collab";
import { isSafeProjectPath, type Diagnostic, type EditBlock } from "@galley/shared";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { isAbsolute as pathIsAbsolute } from "node:path";
import type { CompileService } from "./compile-client.js";
import { READ_LIMITS, type ToolSurface } from "./surface.js";
import {
  summarizeListTruncation,
  summarizeContextTruncation,
} from "./truncation-summary.js";
import type { Liveness } from "./session.js";

/**
 * The Galley MCP local kernel (#16.1, ADR-0020).
 *
 * A LOCAL stdio MCP server that joins a shared project's Yjs room as a peer
 * (session.ts) and exposes the three sacred tools over a WRAPPED capability
 * surface (surface.ts) that can only read file text and write pending-proposal
 * records:
 *
 *   - `read_document` reads the scoped file from the replicated project.
 *   - `list_files` / `read_file` (#16.2a) give READ-ONLY single-project
 *     context: list the live files (path + size) and read any of them by
 *     exact path. Responses are bounded by READ_LIMITS (surface.ts) — an
 *     over-cap file is refused with an honest error, never dumped — and the
 *     WRITE scope is unchanged: `propose_edit` still targets only the
 *     session's one configured file.
 *   - `project_context` (#16.2b) is retrieval-aware READ-ONLY context across
 *     the WHOLE project: structural chunks ranked against a query (BM25, the
 *     in-app agent's retrieval substrate) and selected under a response
 *     budget, with provenance (path + line range + heading path) and honest
 *     skip/truncation accounting. Work AND output are hard-bounded
 *     (READ_LIMITS): metadata-first scan, per-file cap, cumulative
 *     materialization budget, excerpt count cap.
 *   - `propose_edit` NEVER mutates file text: it applies the agent's
 *     search/replace contract (`applyEdits` — unique-match, all-or-nothing) to
 *     a scratch copy and publishes a pending-proposal record into the shared
 *     mailbox. The browser's mandatory DiffReview Accept gate is the only path
 *     that can land it; the kernel returns `pending_review` and waits for a
 *     human.
 *   - `compile` POSTs the document to the explicitly configured loopback
 *     compile service and relays its diagnostics; unconfigured → a structured
 *     `not_configured` result.
 *
 * Without `tools` (no joined room) the server exposes only the `galley_ping`
 * liveness tool — an unconfigured kernel has no document surface to serve.
 * Failure discipline: operational failures (file missing, service down) are
 * `isError` results with an honest one-line message — never a stack; contract
 * failures from `propose_edit` (`no_match` etc.) are structured DATA the
 * client model uses to retry, exactly like the in-app agent loop.
 */
export const GALLEY_MCP_SERVER_NAME = "galley";
export const GALLEY_MCP_SERVER_VERSION = "0.0.0";

/** The document capabilities the three sacred tools serve (absent = ping only). */
export interface KernelTools {
  surface: ToolSurface;
  /** The compile seam; absent → `compile` reports `not_configured`. */
  compileService?: CompileService;
  /**
   * Browser-routed compile fallback (F9/F5). When the loopback {@link compileService}
   * is ABSENT, `compile` routes a DIAGNOSTICS-ONLY compile through the paired BROWSER
   * over the control RPC (`deps.rpc("compile", {projectId})`) — the browser already
   * compiles its live preview, so it relays the `{ok, pageCount, diagnostics}` it
   * already computed (no new build, no document leaves the browser). The loopback
   * service ALWAYS wins when configured (`--compile-url`): this seam is only consulted
   * when `compileService === undefined`. ABSENT — or returning `{unavailable:true}` —
   * → the historical `not_configured` no-op, byte-for-byte. `{error}` → an honest
   * one-line `isError` result (no stack). Scope is diagnostics only; PDF bytes remain
   * `export_compiled`'s separate, blob-channel path.
   */
  compileBrowser?: () => Promise<
    | { ok: boolean; pageCount: number | null; diagnostics: Diagnostic[] }
    | { error: string }
    | { unavailable: true }
  >;
  /**
   * Honest, room-derived liveness (ADR-0024 §1). When supplied, server.ts MERGES
   * the current {@link Liveness} into EVERY per-project tool result, and
   * `propose_*` downgrade their status to `pending_review_unwatched` when no
   * browser is attached. ABSENT (the existing surface-only path used by the unit
   * fixtures) → results are byte-for-byte as before — additive + default-safe.
   * Read on demand so each call reflects the live roster, never a stale snapshot.
   */
  liveness?: () => Liveness;
  /**
   * Binary upload seam (A2) — push image bytes to the browser over the
   * galley-blob-v1 channel and return the content-addressed pointer. The kernel
   * is the SENDER: per call it computes `hash = sha256(bytes)` + `size`, asks the
   * browser to RESERVE inbound capacity (the `expect_blob` control RPC), then
   * `putBlob`s the bytes (resolving only on the browser's verified COMPLETE).
   * Returns the `{hash,size,mime}` pointer on success, or a STRUCTURED reason
   * (`blob_too_large` / `blob_quota_exceeded` / `push_failed`) on failure — the
   * propose_files handler publishes NO proposal if any upload fails. ABSENT (a
   * local/sync-only join with no blob channel) → propose_files refuses any
   * create-binary op with `binary_unsupported`, leaving text-only behavior
   * byte-for-byte unchanged.
   */
  uploadBinary?: (
    bytes: Uint8Array,
    mime: string,
  ) => Promise<
    | { ok: true; hash: string; size: number; mime: string }
    | { ok: false; reason: "blob_too_large" | "blob_quota_exceeded" | "push_failed"; message: string }
  >;
  /**
   * Best-effort blob RELEASE seam (A2 / C1). When an upload fails partway through a
   * multi-binary proposal, or `publishFileProposal` throws AFTER bytes were
   * uploaded, the handler calls this with the hashes already pushed so the browser
   * can DROP the reservation + the stored-but-now-unreferenced bytes — bounding the
   * orphan/quota-pin. Best-effort: never awaited for correctness, errors swallowed.
   * Absent (no blob channel) → nothing to release.
   */
  releaseBinary?: (hashes: { hash: string; size: number }[]) => Promise<void>;
}

/**
 * The live project binding a STATIC per-project tool resolves at call time
 * (ADR-0024 §2). It is exactly {@link KernelTools} by shape, but the static
 * surface reads it through a `() => ProjectAttachment | undefined` provider so
 * the tools stay registered (and the tool list stays byte-stable across
 * reconnect/teardown) while the project they serve attaches and detaches.
 */
export type ProjectAttachment = KernelTools;

/**
 * The structured idle result a STATIC per-project tool returns when no project
 * is attached (ADR-0024 §2): non-throwing DATA, never a missing tool. `compile`
 * keeps its own `not_configured` (it has always been a structured no-op).
 */
const NO_PROJECT_RESULT = {
  status: "no_project_attached",
  message: "call open_project first",
} as const;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * The honesty note (ADR-0024 §1) attached to a propose_* result when no browser
 * is attached to review it. The proposal is still published — a browser may
 * attach later — but the agent is told nobody is watching so it can ask the user
 * to open the project.
 */
const UNWATCHED_NOTE =
  "published, but no browser is attached to review — ask the user to open the project in Galley";

/** Max characters of a failing block's `search` echoed back in `edit_failed`. */
const MAX_FAILURE_ECHO_CHARS = 200;

function truncateEcho(text: string): string {
  return text.length <= MAX_FAILURE_ECHO_CHARS
    ? text
    : `${text.slice(0, MAX_FAILURE_ECHO_CHARS)}… [truncated]`;
}

/**
 * Decode a STRICT, CANONICAL base64 string (A2-D2) → bytes, or null when it is not
 * canonical base64. `Buffer.from(s, "base64")` is lenient (it silently drops
 * invalid chars and tolerates wrong padding), so a forged/garbled payload would
 * decode to truncated bytes. We instead (1) reject any character outside the
 * base64 alphabet / padding, (2) decode, then (3) RE-ENCODE and require an EXACT
 * round-trip match — so only the one canonical encoding of the bytes is accepted.
 * Rejects the empty string (a create-binary op must carry content).
 */
function decodeStrictBase64(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  // Canonical base64: groups of 4, alphabet [A-Za-z0-9+/], at most "==" / "=" of
  // padding only at the very end, and a length that is a multiple of 4.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  if (s.length % 4 !== 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(s, "base64");
  } catch {
    return null;
  }
  if (buf.length === 0) return null;
  // The injective check: the bytes must re-encode to EXACTLY the input (canonical
  // padding included), so a non-canonical/over-padded form is rejected.
  if (buf.toString("base64") !== s) return null;
  return new Uint8Array(buf);
}

/**
 * The DECODED byte length of a STRICT canonical base64 string WITHOUT decoding it
 * (A1 preflight — avoids materializing up to maxOps×64MiB of bytes just to reject
 * an over-cap request). Validates only the cheap structural shape (alphabet,
 * length%4, ≤2 trailing '='); returns the exact decoded length (`b64len/4*3` minus
 * the padding count) or null when the shape is not canonical base64. The full
 * round-trip `decodeStrictBase64` still runs later, on the survivors only, to catch
 * a non-canonical interior the shape regex can't (e.g. a non-zero tail-bit pattern).
 */
function strictBase64DecodedLength(s: string): number | null {
  if (s.length === 0) return null;
  if (s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const n = (s.length / 4) * 3 - pad;
  return n > 0 ? n : null;
}

/** A 64-zero placeholder hash for the PRE-upload aggregate gate (patched post-upload). */
const PLACEHOLDER_HASH = "0".repeat(64);

/**
 * How long an auto-accept-eligible propose_* call waits for the browser's
 * applier to flip the published proposal's status before answering
 * `pending_review` (ADR-0023): the applier runs in another peer's event loop,
 * so a signed proposal usually resolves within a render frame or two. The wait
 * is short — long enough to turn the common auto-apply into an honest
 * "applied", short enough never to stall the tool call on a closed tab.
 */
const AUTO_ACCEPT_AWAIT_MS = 750;

/**
 * Reshape a just-published propose_* result into an HONEST disposition.
 *
 * The unsigned/local path can never auto-apply (the browser authenticates a
 * signature it does not have), so it returns `pending_review` immediately with
 * wording that stays accurate. The signed/auto-accept path instead AWAITS the
 * browser's verdict (which replicates back as a `status` flip) and reports what
 * actually happened — `applied`, `rejected`, or, on no verdict in the window,
 * an honest `pending_review` that says the apply may still be in flight. The
 * caller supplies the per-path identity fields (filePath / ops) folded into
 * each branch's payload.
 */
async function proposalDisposition(
  surface: ToolSurface,
  kind: "single" | "file",
  proposalId: string,
  identity: Record<string, unknown>,
  liveness?: () => Liveness,
): Promise<ToolResult> {
  // ADR-0024 §1: merge room liveness into every disposition, and when a
  // proposal lands in an UNWATCHED room (a browser may attach later, but none is
  // there now) report the honest `pending_review_unwatched` status with a note.
  // `applied` / `rejected` are left intact — a browser was demonstrably present
  // to act. The unwatched downgrade only ever applies to a `pending_review`
  // disposition. With no provider (the surface-only fixtures) the result is
  // byte-for-byte as before — additive + default-safe.
  const live = liveness?.();
  const unwatched = live !== undefined && !live.browserAttached;
  const finish = (value: Record<string, unknown>): ToolResult => {
    const downgrade = unwatched && value.status === "pending_review";
    const payload = downgrade
      ? { ...value, status: "pending_review_unwatched", note: UNWATCHED_NOTE }
      : value;
    return liveness === undefined ? jsonResult(payload) : jsonResult({ ...payload, liveness: live });
  };

  if (!surface.autoAcceptEligible) {
    return finish({
      status: "pending_review",
      proposalId,
      ...identity,
      message:
        "Published to Galley — a human must Accept it in the review gate before the document changes.",
    });
  }
  const resolution = await surface.awaitProposalResolution(kind, proposalId, AUTO_ACCEPT_AWAIT_MS);
  if (resolution === "accepted") {
    return finish({
      status: "applied",
      proposalId,
      ...identity,
      // Status-factual: a fast HUMAN Accept flips a signed proposal to
      // "accepted" too, so don't claim the apply was automatic — only that the
      // document changed.
      message:
        "Accepted in Galley — the document has changed; re-read it (read_document / list_files) to see the result.",
    });
  }
  if (resolution === "rejected") {
    return finish({
      status: "rejected",
      proposalId,
      ...identity,
      message: "A human rejected this proposal in Galley; the document is unchanged.",
    });
  }
  // Timeout ≠ "will apply shortly": it can be a closed tab, a disarmed/forged
  // signature the applier ignored, or a conflict fallback to manual review.
  // Say only what is certain — published, no verdict yet, re-check.
  return finish({
    status: "pending_review",
    proposalId,
    ...identity,
    message:
      "Published to Galley (no accepted/rejected verdict within 750ms). Auto-accept may still be in flight, " +
      "or the proposal may await a manual Accept — re-check with read_document / list_files.",
  });
}

export function createGalleyMcpServer(tools?: KernelTools): McpServer {
  const server = new McpServer({
    name: GALLEY_MCP_SERVER_NAME,
    version: GALLEY_MCP_SERVER_VERSION,
  });

  // galley_ping stops meaning process-only health (ADR-0024 §1): when a session
  // is bound (a liveness provider is present) it reports the relay/browser status
  // alongside pong+version as JSON; with NO session it keeps the historical plain
  // `pong <version>` line byte-for-byte (the unconfigured/control-mode path).
  const liveness = tools?.liveness;
  server.registerTool(
    "galley_ping",
    {
      title: "Ping the Galley MCP kernel",
      description: "Liveness check. Returns 'pong' with the kernel version.",
      inputSchema: { echo: z.string().optional() },
    },
    async ({ echo }) => {
      if (liveness === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `pong ${GALLEY_MCP_SERVER_VERSION}${echo ? ` ${echo}` : ""}`,
            },
          ],
        };
      }
      const live = liveness();
      return jsonResult({
        pong: true,
        version: GALLEY_MCP_SERVER_VERSION,
        relayConnected: live.relayConnected,
        browserAttached: live.browserAttached,
        humanPeers: live.humanPeers,
        ...(echo !== undefined ? { echo } : {}),
      });
    },
  );

  if (tools === undefined) return server;
  registerProjectTools(server, tools);
  return server;
}

/**
 * Register the per-project document tools for one joined session. Split out of
 * {@link createGalleyMcpServer} for control mode (#16.3a, ADR-0021): there the
 * kernel starts with only the control tools and registers THESE dynamically
 * after a successful `open_project` handed it a project room (the MCP SDK
 * notifies connected clients that the tool list changed).
 */
export function registerProjectTools(
  server: McpServer,
  tools: KernelTools | (() => ProjectAttachment | undefined),
): void {
  // The static surface (ADR-0024 §2) reads the live binding through a provider so
  // the tools stay registered while the project attaches/detaches; the existing
  // eager path passes a concrete {@link KernelTools}, which we wrap in a constant
  // provider — one code path, byte-for-byte behavior for the eager callers.
  const provider: () => ProjectAttachment | undefined =
    typeof tools === "function" ? tools : () => tools;

  // ADR-0024 §1 honesty helpers, resolved per call. When a liveness provider is
  // present on the live attachment, EVERY per-project result carries the current
  // room status; when ABSENT (the surface-only fixtures), results are
  // byte-for-byte as before.
  //
  // - `withLiveness` merges the field into a JSON payload (read at send time so
  //   it reflects the live roster).
  // - `textOrJson` keeps the historical PLAIN-TEXT read result when there is no
  //   liveness provider, and upgrades to a `{ text, liveness }` JSON sidecar when
  //   there is (a read must never imply a browser is attached — ADR-0024 §1).
  const withLiveness = (
    att: ProjectAttachment,
    value: Record<string, unknown>,
  ): ToolResult =>
    jsonResult(att.liveness === undefined ? value : { ...value, liveness: att.liveness() });
  const textOrJson = (att: ProjectAttachment, text: string): ToolResult =>
    att.liveness === undefined ? textResult(text) : jsonResult({ text, liveness: att.liveness() });

  server.registerTool(
    "read_document",
    {
      title: "Read the Galley document",
      description:
        "Returns the current text of the session's target file from the live shared project.",
      inputSchema: {},
    },
    async () => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      const read = att.surface.readDocument();
      if (!read.ok) return errorResult(`read_document: ${read.error}`);
      return textOrJson(att, read.text);
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List the project's files",
      description:
        "Lists the live (non-deleted) files of the shared project — exact path + size " +
        "(UTF-8 bytes when sizeExact, else a cheap lower bound), deterministic order; " +
        "duplicate-path conflicts are flagged per entry. BINARY files (images/PDFs) appear " +
        'too, carrying a { kind:"binary", hash, mime } pointer descriptor with an exact ' +
        "sizeBytes — pass that path to read_file to get the pointer. Read-only context: edits " +
        "still go through propose_edit and target only the session's file.",
      inputSchema: {},
    },
    async () => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      const listed = att.surface.listFiles();
      if (!listed.ok) return errorResult(`list_files: ${listed.error}`);
      // D1: one human-readable line when the listing was cut (entry cap, hidden
      // forged paths, or sizes reported as lower bounds). Null ⇒ omitted, so a
      // complete listing's result is byte-for-byte unchanged.
      const truncationSummary = summarizeListTruncation({
        truncated: listed.truncated,
        omitted: listed.omitted,
        inexactSizes: listed.files.filter((f) => !f.sizeExact).length,
      });
      return withLiveness(att, {
        files: listed.files,
        truncated: listed.truncated,
        omitted: listed.omitted,
        ...(truncationSummary !== null ? { truncationSummary } : {}),
      });
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a project file by path",
      description:
        "Returns the live replicated text of any project file by EXACT path (as listed by " +
        "list_files — no normalization, no globbing). Read-only. Files over " +
        `${READ_LIMITS.maxFileBytes} UTF-8 bytes are refused with an error, never truncated. ` +
        "A BINARY file (image/PDF) returns structured metadata { kind: \"binary\", path, hash, " +
        "size, mime } instead of text — its bytes are not available through this tool.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .max(READ_LIMITS.maxPathChars)
          .describe("Exact file path as returned by list_files, e.g. /notes.typ."),
      },
    },
    async ({ path }) => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      // ALL read_file bounding lives in the surface (Security round 2): the
      // byte cap is enforced BEFORE the text is materialized (O(1) length
      // pre-check), duplicate-path conflicts are a structured refusal, and
      // hostile path echoes come back JSON-escaped. The tool layer only
      // relays the structured outcome.
      const read = att.surface.readFile(path);
      if (!read.ok) return errorResult(`read_file: ${read.error}`);
      // A3: a binary file has no text — return its structured pointer
      // ({ kind:"binary", path, hash, size, mime }) so the agent learns it is
      // binary + its content-address, without bytes (no transport for them yet).
      if ("kind" in read) {
        return withLiveness(att, {
          kind: "binary",
          path: read.path,
          hash: read.hash,
          size: read.size,
          mime: read.mime,
        });
      }
      return textOrJson(att, read.text);
    },
  );

  server.registerTool(
    "project_context",
    {
      title: "Query-relevant project context",
      description:
        "Returns the most RELEVANT excerpts across ALL the project's live files for a query " +
        "(lexical ranking over structural chunks), each with provenance: file path, 1-based " +
        "line range, and Typst heading path. Budget-limited and read-only: files with " +
        "duplicate-path conflicts or over the per-file cap are skipped (listed in `skipped` " +
        "with a reason), and `selectionTruncated` reports when relevant chunks did not fit " +
        "the budget. Use read_file for a complete file.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(READ_LIMITS.maxQueryChars)
          .describe("What you are looking for — ranks chunks across the whole project."),
        budget: z
          .number()
          .int()
          .min(READ_LIMITS.minContextChars)
          .max(READ_LIMITS.maxContextChars)
          .optional()
          .describe(
            `Response budget in characters of excerpt text (default ${READ_LIMITS.defaultContextChars}).`,
          ),
      },
    },
    async ({ query, budget }) => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      // ALL context bounding lives in the surface (the read_file pattern): the
      // metadata-first scan, the per-file cap, the cumulative materialization
      // budget, and the response budget are enforced there — the tool layer
      // only relays the structured outcome. Surface errors echo no
      // caller-controlled text (the query is ranking input, never an echo).
      const ctx = att.surface.projectContext(query, budget);
      if (!ctx.ok) return errorResult(`project_context: ${ctx.error}`);
      // D1: one human-readable line aggregating what was left out of the ranking
      // / selection (file cap, hidden forged paths, per-reason skips, response
      // budget). Null ⇒ omitted, so an untruncated result is unchanged.
      const truncationSummary = summarizeContextTruncation({
        omitted: ctx.omitted,
        filesTruncated: ctx.filesTruncated,
        scanTruncated: ctx.scanTruncated,
        chunksTruncated: ctx.chunksTruncated,
        selectionTruncated: ctx.selectionTruncated,
        skippedReasons: ctx.skipped.map((s) => s.reason),
      });
      return withLiveness(att, {
        excerpts: ctx.excerpts,
        skipped: ctx.skipped,
        omitted: ctx.omitted,
        filesTruncated: ctx.filesTruncated,
        scanTruncated: ctx.scanTruncated,
        chunksTruncated: ctx.chunksTruncated,
        selectionTruncated: ctx.selectionTruncated,
        ...(truncationSummary !== null ? { truncationSummary } : {}),
      });
    },
  );

  server.registerTool(
    "propose_edit",
    {
      title: "Propose an edit (published for review)",
      description:
        "Applies search/replace edits to a scratch copy of the session's file and publishes the result " +
        "as a proposal. It never edits the document directly: the change is published for review — if this " +
        "project has agent auto-accept armed it may apply automatically (the response says status \"applied\"), " +
        "otherwise it awaits a human Accept in Galley. Inspect the returned `status` to know what happened. " +
        "Each `search` must match the current text exactly once; failures come back as structured data " +
        "(status: \"edit_failed\") — refine and retry.",
      inputSchema: {
        // Input caps mirror PROPOSAL_LIMITS (finding 1): the protocol boundary
        // rejects oversized requests before any work; the byte-exact check
        // below (proposalSizeViolation) is the authoritative second gate.
        request: z
          .string()
          .min(1)
          .max(PROPOSAL_LIMITS.maxRequestChars)
          .describe("A short human-readable title for the change (shown in the review card)."),
        edits: z
          .array(
            z.object({
              search: z
                .string()
                .max(PROPOSAL_LIMITS.maxBlockBytes)
                .describe("Exact text to find — must match exactly once."),
              replace: z
                .string()
                .max(PROPOSAL_LIMITS.maxBlockBytes)
                .describe("Replacement text."),
            }),
          )
          .min(1)
          .max(PROPOSAL_LIMITS.maxBlocks)
          .describe("Search/replace blocks, applied in order against the running text."),
      },
    },
    async ({ request, edits }) => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      const surface = att.surface;
      const read = surface.readDocument();
      if (!read.ok) return errorResult(`propose_edit: ${read.error}`);

      const blocks: EditBlock[] = edits.map((e) => ({ search: e.search, replace: e.replace }));
      // The agent edit contract, applied to a SCRATCH copy only (all-or-nothing,
      // unique-match; apply-edits.ts). The live document is never touched here.
      const result = applyEdits(read.text, blocks);
      if (!result.ok) {
        return withLiveness(att, {
          status: "edit_failed",
          message:
            "No proposal was published: one or more blocks did not apply. Fix the failing blocks and retry.",
          failures: result.failures.map((f) => ({
            reason: f.reason,
            ...(f.matchCount !== undefined ? { matchCount: f.matchCount } : {}),
            // Echo a bounded prefix only — failure payloads must not become a
            // second oversized channel (finding 1).
            search: truncateEcho(f.block.search),
          })),
        });
      }

      // Byte-exact size gate (PROPOSAL_LIMITS, shared with the mailbox): an
      // over-limit result — e.g. a near-cap document grown past the cap — is a
      // structured rejection, and nothing is published into the room's CRDT.
      const proposal = {
        filePath: surface.filePath,
        baseText: read.text,
        proposedText: result.source,
        blocks,
        request,
      };
      const violation = proposalSizeViolation(proposal);
      if (violation !== null) {
        return withLiveness(att, {
          status: "proposal_too_large",
          message: `No proposal was published: ${violation}. Propose a smaller change.`,
        });
      }

      const proposalId = await surface.publishProposal({
        baseText: read.text,
        proposedText: result.source,
        blocks,
        request,
      });
      // The publish side-effect above is byte-for-byte unchanged; we only
      // report the proposal's HONEST disposition (ADR-0023: signed → await the
      // verdict; unsigned → manual review) with ADR-0024 §1 liveness merged in —
      // a pending proposal downgrades to pending_review_unwatched when no
      // browser is attached to review it.
      return proposalDisposition(
        surface,
        "single",
        proposalId,
        { filePath: surface.filePath },
        att.liveness,
      );
    },
  );

  server.registerTool(
    "propose_files",
    {
      title: "Propose a multi-file change (published for review)",
      description:
        "Proposes a change set across MULTIPLE files as ONE atomic proposal — create new " +
        "files, edit existing ones, rename/move them (rename also moves into a folder), or delete them " +
        "(e.g. add chapters/intro.typ and #include it from main.typ). It never changes the project " +
        "directly: the set is published for review — if this project has agent auto-accept armed it may " +
        "apply automatically (the response says status \"applied\"), otherwise it awaits a human Accept in " +
        "Galley. Inspect the returned `status` to know what happened; the whole set lands all-or-nothing. " +
        "For `edit` ops each `search` must match that file's current text exactly once; " +
        "failures come back as structured data — refine and retry. Delete is a recoverable soft-delete. " +
        "Paths must be safe in-tree project paths (leading slash, no traversal, not under /.galley). " +
        "For binary files you may either inline the bytes (create-binary, base64) or, when the source " +
        "already lives on the machine running the Galley kernel, reference it by ABSOLUTE local path " +
        "(create-binary-path) so no base64 transfer is needed — both publish the same content-addressed pointer. " +
        "A single proposal is capped at 32 ops (with aggregate size limits); to change more files, split the work " +
        "across multiple sequential propose_files calls — each is reviewed and lands independently (there is no " +
        "import-group transaction spanning proposals).",
      inputSchema: {
        request: z
          .string()
          .min(1)
          .max(FILE_PROPOSAL_LIMITS.maxRequestChars)
          .describe("A short human-readable title for the whole change set (shown in the review card)."),
        ops: z
          .array(
            z.discriminatedUnion("kind", [
              z.object({
                kind: z.literal("create"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Canonical path of the NEW file, e.g. /chapters/intro.typ."),
                text: z
                  .string()
                  .max(FILE_PROPOSAL_LIMITS.maxTextBytes)
                  .describe("Full text of the new file."),
              }),
              z.object({
                kind: z.literal("edit"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Exact path of the EXISTING file to edit (as listed by list_files)."),
                edits: z
                  .array(
                    z.object({
                      search: z
                        .string()
                        .max(FILE_PROPOSAL_LIMITS.maxBlockBytes)
                        .describe("Exact text to find in this file — must match exactly once."),
                      replace: z
                        .string()
                        .max(FILE_PROPOSAL_LIMITS.maxBlockBytes)
                        .describe("Replacement text."),
                    }),
                  )
                  .min(1)
                  .max(FILE_PROPOSAL_LIMITS.maxBlocks)
                  .describe("Search/replace blocks, applied in order against this file's text."),
              }),
              z.object({
                kind: z.literal("rename"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Exact CURRENT path of the EXISTING file to move (as listed by list_files)."),
                newPath: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe(
                    "Destination path — also moves into a folder (e.g. /draft.typ → /chapters/intro.typ). " +
                      "Must be a free, safe in-tree path. References (#include/#image) are NOT auto-rewritten — " +
                      "bundle the corrective `edit` ops in the same proposal.",
                  ),
              }),
              z.object({
                kind: z.literal("delete"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Exact path of the EXISTING file to remove (recoverable soft-delete on Accept)."),
              }),
              z.object({
                kind: z.literal("create-binary"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Canonical path of the NEW binary file, e.g. /figures/logo.png."),
                bytes: z
                  .string()
                  .min(1)
                  // base64 expands ~4/3; bound the encoded string so the DECODED
                  // bytes can never exceed the blob cap (re-checked exactly after decode).
                  .max(Math.ceil((FILE_PROPOSAL_LIMITS.maxBlobBytes * 4) / 3) + 4)
                  .describe("The file's bytes, base64-encoded (standard base64; decoded size is capped)."),
                mime: z
                  .string()
                  .min(1)
                  .max(FILE_PROPOSAL_LIMITS.maxMimeChars)
                  .optional()
                  .describe("Optional media type; inferred from the bytes/extension when omitted."),
              }),
              z.object({
                kind: z.literal("create-binary-path"),
                path: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe("Canonical IN-TREE path of the NEW binary file, e.g. /figures/logo.png."),
                srcPath: z
                  .string()
                  .min(1)
                  .max(READ_LIMITS.maxPathChars)
                  .describe(
                    "ABSOLUTE path of the source file on the machine running the Galley kernel — the kernel reads its bytes locally (no base64 transfer). Decoded size is capped at the blob limit.",
                  ),
                mime: z
                  .string()
                  .min(1)
                  .max(FILE_PROPOSAL_LIMITS.maxMimeChars)
                  .optional()
                  .describe("Optional media type; inferred from the file's bytes/extension when omitted."),
              }),
            ]),
          )
          .min(1)
          .max(FILE_PROPOSAL_LIMITS.maxOps)
          .describe("The file operations — applied all-or-nothing on Accept."),
      },
    },
    async ({ request, ops }) => {
      const att = provider();
      if (att === undefined) return jsonResult(NO_PROJECT_RESULT);
      const surface = att.surface;
      // The fully-built op set, preserving the CALLER'S INPUT ORDER (A2-D3): each
      // entry is filled in below at the SAME index as its input op — a binary op's
      // pointer is patched in after upload, never appended out of order.
      const built: (FileProposalOp | null)[] = new Array(ops.length).fill(null);
      const seenPaths = new Set<string>();
      // A1: create-binary ops are PREFLIGHTED here (base64 shape + DECODED-LENGTH
      // only, no decode/hash/allocation) so the WHOLE proposal — path-safety, dup,
      // per-op + AGGREGATE text AND binary caps — is validated BEFORE any byte is
      // materialized. Only after the full gate passes are the survivors decoded →
      // hashed → uploaded (below), so an over-cap multi-binary request allocates
      // NOTHING. `b64` is the raw base64 string; `mime` is the caller-supplied one
      // (or undefined → inferred from the decoded bytes in the upload phase).
      const pendingBinary: {
        index: number;
        path: string;
        mime: string | undefined;
        // EITHER a base64 string to decode in the upload phase (create-binary)…
        // …OR bytes already read from disk (create-binary-path). Exactly one is set.
        b64?: string;
        bytes?: Uint8Array;
        declaredLen: number;
      }[] = [];
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!;
        // Every path is caller-supplied here (unlike the session-bound
        // propose_edit), so it must pass the same in-tree safety gate the
        // version store and mailbox enforce — fail BEFORE any work, as data.
        if (!isSafeProjectPath(op.path)) {
          return withLiveness(att, {
            status: "invalid_path",
            path: op.path,
            message: `No proposal was published: ${op.path} is not a safe in-tree project path (needs a leading slash, no traversal, not under /.galley).`,
          });
        }
        if (seenPaths.has(op.path)) {
          return withLiveness(att, {
            status: "duplicate_path",
            path: op.path,
            message: `No proposal was published: two ops target ${op.path}. Combine them into one op.`,
          });
        }
        seenPaths.add(op.path);

        if (op.kind === "create") {
          built[i] = { kind: "create", path: op.path, baseText: "", proposedText: op.text, blocks: [] };
          continue;
        }

        if (op.kind === "rename") {
          // The destination is caller-supplied too — gate it through the same
          // safety + uniqueness rules as `path` before publishing.
          if (!isSafeProjectPath(op.newPath)) {
            return withLiveness(att, {
              status: "invalid_path",
              path: op.newPath,
              message: `No proposal was published: ${op.newPath} is not a safe in-tree project path (needs a leading slash, no traversal, not under /.galley).`,
            });
          }
          if (seenPaths.has(op.newPath)) {
            return withLiveness(att, {
              status: "duplicate_path",
              path: op.newPath,
              message: `No proposal was published: two ops target ${op.newPath}. Combine them into one op.`,
            });
          }
          seenPaths.add(op.newPath);
          built[i] = {
            kind: "rename",
            path: op.path,
            newPath: op.newPath,
            baseText: "",
            proposedText: "",
            blocks: [],
          };
          continue;
        }

        if (op.kind === "delete") {
          built[i] = { kind: "delete", path: op.path, baseText: "", proposedText: "", blocks: [] };
          continue;
        }

        if (op.kind === "create-binary") {
          // The kernel must have a blob channel to upload over — a local/sync-only
          // join has none, so refuse the create-binary op honestly (text-only
          // proposals are unaffected; this gate never fires without a binary op).
          if (att.uploadBinary === undefined) {
            return withLiveness(att, {
              status: "binary_unsupported",
              path: op.path,
              message: `No proposal was published: this session has no secure byte channel, so the binary file ${op.path} cannot be uploaded. Open the project with Agent Access to enable binary uploads.`,
            });
          }
          // A1 PREFLIGHT — validate the base64 SHAPE and compute the DECODED LENGTH
          // from the string WITHOUT decoding/hashing/allocating the bytes. This caps
          // each blob AND feeds the aggregate gate below, so an over-cap multi-binary
          // request is rejected with NO bytes ever materialized (no pre-gate DoS).
          // The actual decode + injective canonical check runs in the upload phase,
          // on the survivors only, after the whole proposal has passed.
          const declaredLen = strictBase64DecodedLength(op.bytes);
          if (declaredLen === null) {
            return withLiveness(att, {
              status: "invalid_bytes",
              path: op.path,
              message: `No proposal was published: the bytes for ${op.path} are not valid (canonical) base64.`,
            });
          }
          if (declaredLen > FILE_PROPOSAL_LIMITS.maxBlobBytes) {
            return withLiveness(att, {
              status: "blob_too_large",
              path: op.path,
              message: `No proposal was published: ${op.path} is ${declaredLen} bytes — the limit is ${FILE_PROPOSAL_LIMITS.maxBlobBytes}.`,
            });
          }
          // mime is inferred from the BYTES (magic numbers) in the upload phase when
          // the caller didn't supply one — preflight only knows a caller-supplied mime.
          pendingBinary.push({ index: i, path: op.path, b64: op.bytes, declaredLen, mime: op.mime });
          // PROVISIONAL pointer for the aggregate gate: a placeholder (valid-shape)
          // hash + the declared length + a placeholder mime. Patched with the real
          // {hash,size,mime} after upload; the gate only needs a well-formed shape
          // and the real declared SIZE to enforce the binary byte caps.
          built[i] = {
            kind: "create-binary",
            path: op.path,
            baseText: "",
            proposedText: "",
            blocks: [],
            binaryAsset: {
              type: "binary",
              hash: PLACEHOLDER_HASH,
              size: declaredLen,
              mime: op.mime ?? "application/octet-stream",
            },
          };
          continue;
        }

        if (op.kind === "create-binary-path") {
          // Same blob-channel requirement as create-binary: a local/sync-only join
          // has no uploader, so refuse honestly (nothing published).
          if (att.uploadBinary === undefined) {
            return withLiveness(att, {
              status: "binary_unsupported",
              path: op.path,
              message: `No proposal was published: this session has no secure byte channel, so the binary file ${op.path} cannot be uploaded. Open the project with Agent Access to enable binary uploads.`,
            });
          }
          // srcPath is a HOST filesystem path, NOT an in-tree project path. Require it
          // be absolute so the read is unambiguous (no dependence on the kernel's cwd)
          // and a relative-path typo can never silently resolve somewhere surprising.
          if (!pathIsAbsolute(op.srcPath)) {
            return withLiveness(att, {
              status: "invalid_src_path",
              path: op.path,
              message: `No proposal was published: srcPath for ${op.path} must be an absolute path on the machine running the Galley kernel.`,
            });
          }
          // Reject a directory (or non-regular file) BEFORE reading: stat first.
          let st;
          try {
            st = await fsStat(op.srcPath);
          } catch (err) {
            return withLiveness(att, {
              status: "src_unreadable",
              path: op.path,
              message: `No proposal was published: could not read ${op.srcPath} for ${op.path} — ${err instanceof Error ? err.message : String(err)}.`,
            });
          }
          if (!st.isFile()) {
            return withLiveness(att, {
              status: "src_unreadable",
              path: op.path,
              message: `No proposal was published: ${op.srcPath} for ${op.path} is not a regular file.`,
            });
          }
          // Cheap pre-read size cap from the stat size — refuse an over-cap file
          // WITHOUT reading its bytes (DoS posture matches the create-binary preflight).
          if (st.size > FILE_PROPOSAL_LIMITS.maxBlobBytes) {
            return withLiveness(att, {
              status: "blob_too_large",
              path: op.path,
              message: `No proposal was published: ${op.srcPath} is ${st.size} bytes — the limit is ${FILE_PROPOSAL_LIMITS.maxBlobBytes}.`,
            });
          }
          let bytes: Uint8Array;
          try {
            const buf = await fsReadFile(op.srcPath);
            bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          } catch (err) {
            return withLiveness(att, {
              status: "src_unreadable",
              path: op.path,
              message: `No proposal was published: could not read ${op.srcPath} for ${op.path} — ${err instanceof Error ? err.message : String(err)}.`,
            });
          }
          // Re-check the ACTUAL byte length (a file can grow between stat and read; an
          // empty file is meaningless for a binary asset).
          if (bytes.length === 0) {
            return withLiveness(att, {
              status: "src_unreadable",
              path: op.path,
              message: `No proposal was published: ${op.srcPath} for ${op.path} is empty.`,
            });
          }
          if (bytes.length > FILE_PROPOSAL_LIMITS.maxBlobBytes) {
            return withLiveness(att, {
              status: "blob_too_large",
              path: op.path,
              message: `No proposal was published: ${op.srcPath} is ${bytes.length} bytes — the limit is ${FILE_PROPOSAL_LIMITS.maxBlobBytes}.`,
            });
          }
          pendingBinary.push({ index: i, path: op.path, mime: op.mime, bytes, declaredLen: bytes.length });
          // PROVISIONAL pointer for the aggregate gate, identical shape to create-binary.
          built[i] = {
            kind: "create-binary",
            path: op.path,
            baseText: "",
            proposedText: "",
            blocks: [],
            binaryAsset: {
              type: "binary",
              hash: PLACEHOLDER_HASH,
              size: bytes.length,
              mime: op.mime ?? "application/octet-stream",
            },
          };
          continue;
        }

        // edit: read the live file and apply the blocks to a SCRATCH copy only —
        // the kernel computes the proposed text (never trusts a model-supplied
        // full body), exactly like propose_edit.
        const read = surface.readFile(op.path);
        if (!read.ok) {
          return withLiveness(att, {
            status: "file_unreadable",
            path: op.path,
            message: `No proposal was published: could not read ${op.path} — ${read.error}.`,
          });
        }
        // A3: an edit op targets a text file's body — a binary file (no Y.Text)
        // can't take search/replace blocks, so refuse the whole change set
        // honestly rather than apply edits to a phantom empty string.
        if ("kind" in read) {
          return withLiveness(att, {
            status: "file_unreadable",
            path: op.path,
            message: `No proposal was published: ${op.path} is a binary file (${read.mime}) and cannot be edited as text.`,
          });
        }
        const blocks: EditBlock[] = op.edits.map((e) => ({ search: e.search, replace: e.replace }));
        const result = applyEdits(read.text, blocks);
        if (!result.ok) {
          return withLiveness(att, {
            status: "edit_failed",
            path: op.path,
            message: `No proposal was published: one or more blocks did not apply to ${op.path}. Fix the failing blocks and retry.`,
            failures: result.failures.map((f) => ({
              reason: f.reason,
              ...(f.matchCount !== undefined ? { matchCount: f.matchCount } : {}),
              search: truncateEcho(f.block.search),
            })),
          });
        }
        built[i] = {
          kind: "edit",
          path: op.path,
          baseText: read.text,
          proposedText: result.source,
          blocks,
        };
      }

      // Every slot is filled (the loop sets built[i] or returns) — assert + narrow.
      const fullySet: FileProposalOp[] = built.map((o) => o!);

      // A1: the FULL byte-exact aggregate gate (FILE_PROPOSAL_LIMITS — text caps,
      // total proposed text, total blocks, AND the aggregate BINARY-byte cap) runs
      // NOW, on the complete set WITH the (provisional) binary pointers, BEFORE any
      // upload. So a multi-binary request whose blobs sum over maxTotalBlobBytes is
      // rejected as proposal_too_large and uploads NOTHING.
      const violation = fileProposalSizeViolation({ request, ops: fullySet });
      if (violation !== null) {
        return withLiveness(att, {
          status: "proposal_too_large",
          message: `No proposal was published: ${violation}. Propose a smaller change set.`,
        });
      }

      // A1/A2/C1: ONLY now — after the whole proposal validated — DECODE → HASH →
      // UPLOAD every binary blob (the decode/allocation happens here, on survivors
      // only). On ANY upload failure, BEST-EFFORT RELEASE the blobs we already
      // uploaded (release the browser's reservation + the stored-but-now-
      // unreferenced bytes) so a partial upload leaves no orphan/pin, then publish
      // NOTHING (binary + text ops compose atomically).
      const uploaded: { hash: string; size: number }[] = [];
      const releaseUploaded = async (): Promise<void> => {
        if (att.releaseBinary !== undefined && uploaded.length > 0) {
          await att.releaseBinary([...uploaded]).catch(() => {});
        }
      };
      for (const b of pendingBinary) {
        let bytes: Uint8Array;
        if (b.bytes !== undefined) {
          // create-binary-path: bytes already read from disk in the preflight loop.
          bytes = b.bytes;
        } else {
          // create-binary: decode the base64 NOW (the injective canonical round-trip
          // the preflight length-check could not do) — reject a non-canonical
          // interior, then re-assert the length matches what the aggregate gate was
          // charged. Release any prior uploads on rejection so a late bad op never
          // orphans an earlier blob.
          const decoded = decodeStrictBase64(b.b64!);
          if (decoded === null || decoded.length !== b.declaredLen) {
            await releaseUploaded();
            return withLiveness(att, {
              status: "invalid_bytes",
              path: b.path,
              message: `No proposal was published: the bytes for ${b.path} are not valid (canonical) base64.`,
            });
          }
          bytes = decoded;
        }
        const mime = b.mime ?? inferMime(bytes, b.path);
        // The content hash we EXPECT (content addressing) — computed here, on the
        // survivor's decoded bytes, so the uploader's echoed pointer is verified.
        const expectedHash = await sha256Hex(bytes);
        const r = await att.uploadBinary!(bytes, mime);
        if (!r.ok) {
          await releaseUploaded();
          return withLiveness(att, {
            status: r.reason,
            path: b.path,
            message: `No proposal was published: ${b.path} — ${r.message}`,
          });
        }
        // The uploaded pointer MUST match the bytes we hashed + size-gated; a
        // mismatch means the channel returned a different artifact — fail closed
        // and release everything uploaded so far rather than publish a pointer we
        // never validated.
        if (r.hash !== expectedHash || r.size !== bytes.length) {
          uploaded.push({ hash: r.hash, size: r.size });
          await releaseUploaded();
          return withLiveness(att, {
            status: "push_failed",
            path: b.path,
            message: `No proposal was published: ${b.path} — the uploaded bytes did not match the expected content hash.`,
          });
        }
        uploaded.push({ hash: r.hash, size: r.size });
        // Patch the final mime in place (the uploader echoes it; keep the slot/order).
        const slot = fullySet[b.index]!;
        if (slot.kind === "create-binary") {
          slot.binaryAsset = { type: "binary", hash: r.hash, size: r.size, mime: r.mime };
        }
      }

      let proposalId: string;
      try {
        proposalId = await surface.publishFileProposal({ request, ops: fullySet });
      } catch (err) {
        // C1: publish threw AFTER the bytes were uploaded — release the orphaned
        // blobs (best-effort) so they don't pin the browser store/quota, then fail.
        await releaseUploaded();
        return withLiveness(att, {
          status: "publish_failed",
          message: `No proposal was published: ${err instanceof Error ? err.message : String(err)}.`,
        });
      }
      // The publish side-effect above is byte-for-byte unchanged; we only
      // report the proposal's HONEST disposition (ADR-0023) with ADR-0024 §1
      // liveness merged in — pending downgrades to pending_review_unwatched
      // when no browser is attached to review the change set.
      return proposalDisposition(
        surface,
        "file",
        proposalId,
        {
          ops: fullySet.map((op) => ({
            kind: op.kind,
            path: op.path,
            ...(op.kind === "rename" ? { newPath: op.newPath } : {}),
          })),
        },
        att.liveness,
      );
    },
  );

  server.registerTool(
    "compile",
    {
      title: "Compile the document for diagnostics",
      description:
        "Type-checks the shared project and returns its diagnostics (errors/warnings + page count); " +
        "never modifies the document. Uses the configured loopback compile service when one is set " +
        "(--compile-url); otherwise falls back to the paired browser's live preview compiler. Call " +
        "this after propose_files/propose_edit to confirm the change set type-checks before asking " +
        "the human to Accept.",
      inputSchema: {},
    },
    async () => {
      const att = provider();
      // ADR-0024 §2: compile keeps its existing structured not_configured no-op
      // when nothing is attached (no project ⇒ no compile seam either).
      const compileService = att?.compileService;
      // The historical no-op result — emitted when nothing is attached, when no
      // loopback service AND no browser fallback exist, or when the browser
      // fallback reports `{unavailable:true}`. Byte-for-byte unchanged.
      const notConfigured = (): ToolResult => {
        const base = {
          status: "not_configured",
          message:
            "compile service not configured — start the kernel with --compile-url (e.g. http://localhost:3001).",
        };
        return att === undefined ? jsonResult(base) : withLiveness(att, base);
      };
      if (att === undefined) return notConfigured();
      // F9/F5: when no loopback service is configured, route a DIAGNOSTICS-ONLY
      // compile through the paired BROWSER (the loopback service ALWAYS wins when
      // present — checked first below). The browser already compiles its live
      // preview, so it relays the diagnostics it computed; no document leaves it.
      if (compileService === undefined) {
        if (att.compileBrowser === undefined) return notConfigured();
        try {
          const browser = await att.compileBrowser();
          if ("unavailable" in browser) return notConfigured();
          if ("error" in browser) return errorResult(`compile: ${browser.error}`);
          return withLiveness(att, {
            status: "ok",
            source: "browser",
            ok: browser.ok,
            pageCount: browser.pageCount,
            diagnostics: browser.diagnostics,
          });
        } catch (err) {
          // Fail-closed: honest one-line message, never a stack.
          return errorResult(`compile: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const input = att.surface.compileInput();
      if (typeof input === "object" && input !== null && "error" in input) {
        return errorResult(`compile: ${input.error}`);
      }
      try {
        const check = await compileService.check(input);
        return withLiveness(att, {
          status: "ok",
          // ADDITIVE (F9): symmetry with the browser-routed path so an agent can
          // tell which diagnostics source answered.
          source: "loopback",
          ok: check.ok,
          pageCount: check.pageCount,
          diagnostics: check.diagnostics,
          durationMs: check.durationMs,
          // ADDITIVE (D3): when the compile produced output bytes, surface a
          // descriptor (size + sha256 + mime) so the agent knows the build
          // genuinely succeeded and how big it is. Omitted on a failed/empty
          // compile or a service that predates the field.
          ...(check.artifact !== undefined ? { artifact: check.artifact } : {}),
        });
      } catch (err) {
        // Honest message, no stack: the client sees what failed, not our internals.
        return errorResult(`compile: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
