/**
 * Kernel configuration (#16.1 + #16.3a; ADR-0020/ADR-0021) — CLI flags with env
 * fallbacks, parsed pure (injectable argv/env) so it is unit-testable and FAILS
 * LOUD: a missing, malformed, or contradictory value throws with the exact flag
 * named; the kernel never starts on a guessed default.
 *
 * The kernel runs in exactly ONE of two modes:
 *
 *   PER-PROJECT mode (#16.1, ADR-0020): join one shared project room, scoped to
 *   one file.
 *     --sync <ws(s) url>        (GALLEY_MCP_SYNC)        the apps/sync relay
 *     --room <id>               (GALLEY_MCP_ROOM)        the room id from the browser's Share link
 *     --file </path.typ>        (GALLEY_MCP_FILE)        the ONE target file this session is scoped to
 *     --compile-url <http url>  (GALLEY_MCP_COMPILE_URL) OPTIONAL loopback compile service
 *
 *   CONTROL mode (#16.3a, ADR-0021): join the browser's Agent Access control
 *   room and ask it to list/open projects; opening a project hands the session
 *   over to the per-project machinery.
 *     --sync <ws(s) url>          (GALLEY_MCP_SYNC)         the apps/sync relay
 *     --control-room <id>         (GALLEY_MCP_CONTROL_ROOM) the control-room id from the browser's Agent Access surface
 *     --response-key <base64url>  (GALLEY_MCP_RESPONSE_KEY) REQUIRED: the per-session response-auth
 *                                 key from the SAME pairing command (HIGH-1). The kernel verifies an
 *                                 HMAC-SHA-256 signature on EVERY control response with it and ignores
 *                                 anything unsigned/badly signed — a room peer cannot forge answers.
 *     --compile-url <http url>    (GALLEY_MCP_COMPILE_URL)  OPTIONAL loopback compile service
 *
 * `--room`/`--file` and `--control-room` are MUTUALLY EXCLUSIVE — mixing them
 * is ambiguous about which authority scopes the session, so it fails loud
 * rather than guessing. `--help` prints the usage and exits without starting.
 *
 * Scope and trust model: the kernel only JOINS rooms named in its config — both
 * room ids are unguessable capabilities minted by the browser (Share /
 * Agent Access); the kernel never creates or enumerates rooms. The control-room
 * id is HIGH-AUTHORITY session state (any holder can ask the browser to list
 * and open projects for this session) — pass it like a secret. No credentials
 * are read, stored, or forwarded anywhere in this process. The compile URL is
 * ENFORCED loopback-only (localhost / 127.0.0.0/8 / ::1, no embedded
 * credentials): the kernel POSTs the project's text there on every `compile`,
 * so any other host would exfiltrate the document (Security-Analyst finding 2).
 */

import { base64UrlToBytes, CONTROL_RESPONSE_KEY_BYTES, PAIRING_CODE_BYTES } from "@galley/collab";
import { READ_LIMITS, type ReadLimitOverrides } from "./surface.js";

export interface ProjectKernelConfig {
  mode: "project";
  /** The sync relay WebSocket URL (ws:// or wss://). */
  syncUrl: string;
  /** The shared room id (the capability from the browser's Share surface). */
  room: string;
  /** The target file's project path, canonicalized to a leading slash. */
  filePath: string;
  /** The loopback compile service base URL (http:// or https://), if configured. */
  compileUrl?: string;
  /** Lowered read caps from launch args (D2); absent ⇒ READ_LIMITS defaults. */
  readLimits?: ReadLimitOverrides;
}

export interface ControlKernelConfig {
  mode: "control";
  /** The sync relay WebSocket URL (ws:// or wss://). */
  syncUrl: string;
  /**
   * How the kernel OBTAINS its control-room + responseKey authority (B2, ADR-0026):
   *   - `"args"`: legacy/manual/CI — `controlRoom` + `responseKey` came straight
   *     from `--control-room`/`--response-key`. MEMORY-ONLY: never written to the
   *     durable store (args are an explicit, ephemeral override).
   *   - `"pairing-code"`: B2 — the operator pasted only a one-time `--pairing-code`.
   *     `controlRoom`/`responseKey` are NOT yet known here; main.ts first tries a
   *     MAC-verified durable pairing, then runs the handshake with `pairingCode`,
   *     then persists the result so future runs need no re-paste.
   */
  authSource: "args" | "pairing-code";
  /** The control-room id — present for `authSource:"args"`, else resolved at runtime. */
  controlRoom?: string;
  /**
   * The per-session response-auth key (HIGH-1): 32 raw bytes. Present for
   * `authSource:"args"` (decoded from `--response-key`); for `"pairing-code"` it is
   * obtained by the handshake / durable store at startup, never from argv.
   */
  responseKey?: Uint8Array;
  /** The one-time pairing code (B2) — present ONLY for `authSource:"pairing-code"`. */
  pairingCode?: string;
  /** The loopback compile service base URL (http:// or https://), if configured. */
  compileUrl?: string;
  /** Lowered read caps from launch args (D2); absent ⇒ READ_LIMITS defaults. */
  readLimits?: ReadLimitOverrides;
  /**
   * Non-fatal, non-secret startup notices (F6): e.g. legacy
   * --control-room/--response-key were present but a fresh --pairing-code took
   * precedence. main.ts emits each to stderr; never contains a room id or key value.
   */
  warnings?: string[];
}

export type KernelConfig = ProjectKernelConfig | ControlKernelConfig;

/** What a parse yields: a runnable config, or the explicit request for --help. */
export type KernelCliResult = KernelConfig | { mode: "help" };

export const KERNEL_USAGE = [
  "usage:",
  "  per-project mode (ADR-0020) — join ONE shared project room, scoped to ONE file:",
  "    galley-mcp --sync ws://localhost:1234 --room <share-room-id> --file /main.typ \\",
  "               [--compile-url http://localhost:3001]",
  "  control mode (B2, ADR-0026) — pair with a ONE-TIME code (no secret in argv):",
  "    galley-mcp --sync ws://localhost:1234 --pairing-code <code> \\",
  "               [--compile-url http://localhost:3001]",
  "    The kernel runs a handshake to obtain the room + response key, then stores",
  "    them durably so later runs need no re-paste. Re-paste only after a Revoke.",
  "  control mode (legacy, #16.3a/ADR-0021) — paste the room + key directly (CI/manual):",
  "    galley-mcp --sync ws://localhost:1234 --control-room <control-room-id> \\",
  "               --response-key <base64url-key> [--compile-url http://localhost:3001]",
  "",
  "  Optional read-cap overrides (each may only LOWER its default; applied in",
  "  per-project mode — control-mode wiring is deferred, so they parse but are",
  "  not yet plumbed into a control-opened project):",
  "    --max-file-bytes <n>          (GALLEY_MCP_MAX_FILE_BYTES)        per-file read cap",
  "    --max-list-entries <n>        (GALLEY_MCP_MAX_LIST_ENTRIES)      list_files entry cap",
  "    --default-context-chars <n>   (GALLEY_MCP_DEFAULT_CONTEXT_CHARS) project_context default budget",
  "",
  "  --room/--file and --control-room are mutually exclusive (one mode per kernel).",
  "  --response-key is REQUIRED in control mode: the per-session key from the same",
  "  pairing command; responses without a valid signature under it are ignored.",
  "  If a --pairing-code is also present it WINS (prefer-fresh, ADR-0026); the",
  "  legacy room/key are ignored with a warning.",
  "  Env fallbacks: GALLEY_MCP_SYNC, GALLEY_MCP_ROOM, GALLEY_MCP_FILE,",
  "  GALLEY_MCP_CONTROL_ROOM, GALLEY_MCP_RESPONSE_KEY, GALLEY_MCP_COMPILE_URL.",
  "  Flags win over env. Room ids and the response key are capabilities minted by",
  "  the browser (Share / Agent Access) — treat them like secrets. --compile-url",
  "  must be loopback (the document is POSTed there on every compile).",
].join("\n");

function fail(message: string): never {
  throw new Error(`${message}\n${KERNEL_USAGE}`);
}

/**
 * Decode + validate the base64url response-auth key (HIGH-1): exactly
 * {@link CONTROL_RESPONSE_KEY_BYTES} bytes or fail loud. The key VALUE never
 * appears in the error — only what was wrong with its shape.
 */
function parseResponseKey(raw: string): Uint8Array {
  const bytes = base64UrlToBytes(raw);
  if (bytes === null) {
    fail("--response-key is not valid base64url — re-copy the pairing command from Settings");
  }
  if (bytes.length !== CONTROL_RESPONSE_KEY_BYTES) {
    fail(
      `--response-key must decode to exactly ${CONTROL_RESPONSE_KEY_BYTES} bytes — ` +
        "re-copy the FULL pairing command from Settings → Agent Access",
    );
  }
  return bytes;
}

/** Collect `--flag value` / `--flag=value` pairs; reject anything unrecognized. */
function parseFlags(argv: string[]): Map<string, string> {
  const known = new Set([
    "--sync",
    "--room",
    "--file",
    "--control-room",
    "--response-key",
    "--pairing-code",
    "--compile-url",
    "--max-file-bytes",
    "--default-context-chars",
    "--max-list-entries",
  ]);
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // Skip a bare `--` separator: launchers (pnpm run, `claude mcp add … --`)
    // can forward a literal `--` into argv. It is never a flag, so tolerate it
    // rather than rejecting the documented launch commands as unknown arguments.
    if (arg === "--") continue;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!known.has(flag)) fail(`unknown argument: ${arg}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === "") fail(`${flag} requires a value`);
    out.set(flag, value);
  }
  return out;
}

/**
 * A short, non-reversible log fingerprint of a room capability (Security
 * round 2, finding 2): first 4 chars + the length. Room ids are SECRETS — the
 * kernel must never write one verbatim to stderr (logs get persisted/shared);
 * this is just enough to tell two configured rooms apart when debugging.
 */
export function roomFingerprint(room: string): string {
  return `${room.slice(0, 4)}…(${room.length} chars)`;
}

/** Is `hostname` (as parsed by `URL`; IPv6 keeps its brackets) a loopback host? */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  // 127.0.0.0/8 — every octet a plain decimal in range (no exotic shorthand).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets[0] === 127 && octets.every((o) => o <= 255);
}

/**
 * Enforce ADR-0020's compile-service stance (Security-Analyst finding 2): the
 * URL must parse, must carry NO embedded credentials, and must point at a
 * LOOPBACK host (localhost / 127.0.0.0/8 / ::1). The kernel compiles by POSTing
 * the project's full text — a non-loopback URL would exfiltrate the document on
 * every `compile` call, so anything else fails loud at startup.
 */
function validateCompileUrl(raw: string): void {
  if (!/^https?:\/\//.test(raw)) {
    fail(`--compile-url must be an http:// or https:// URL; got ${JSON.stringify(raw)}`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`--compile-url is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.username !== "" || url.password !== "") {
    fail("--compile-url must not contain credentials (the kernel handles no secrets)");
  }
  if (!isLoopbackHost(url.hostname)) {
    fail(
      `--compile-url must be a loopback URL (localhost / 127.0.0.0/8 / ::1) — the document is ` +
        `POSTed there on every compile; got host ${JSON.stringify(url.hostname)}`,
    );
  }
}

/**
 * Parse a positive-integer cap flag, bounded to (0, max] (D2). The kernel may
 * only LOWER a read cap, never raise it past its READ_LIMITS default — raising
 * `--max-file-bytes` past the proposal/compile cap would let a read return more
 * than a proposal could ever carry, so an over-default value fails loud rather
 * than silently weakening the bound. Non-integer / non-positive also fails loud
 * with the flag named.
 */
function parseBoundedInt(flag: string, raw: string, max: number): number {
  // Strict: only an optionally-signed run of digits, no "10px"/"1e3"/" 5 ".
  if (!/^-?\d+$/.test(raw.trim())) {
    fail(`${flag} must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${flag} must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  if (n > max) {
    fail(`${flag} must be <= the default cap (${max}); a read cap may be lowered, never raised`);
  }
  return n;
}

/**
 * Parse the OPTIONAL read-cap overrides (D2): each absent flag keeps the
 * READ_LIMITS default (returns no field for it). `--default-context-chars` is
 * clamped to the projectContext range [minContextChars, maxContextChars];
 * `--max-file-bytes` / `--max-list-entries` to (0, default]. Returns undefined
 * when no override flag was passed, so the shipped surface is unchanged.
 */
function parseReadLimits(
  pick: (flag: string, envKey: string) => string | undefined,
): ReadLimitOverrides | undefined {
  const overrides: ReadLimitOverrides = {};

  const maxFileBytesRaw = pick("--max-file-bytes", "GALLEY_MCP_MAX_FILE_BYTES");
  if (maxFileBytesRaw !== undefined) {
    overrides.maxFileBytes = parseBoundedInt(
      "--max-file-bytes",
      maxFileBytesRaw,
      READ_LIMITS.maxFileBytes,
    );
  }

  const maxListEntriesRaw = pick("--max-list-entries", "GALLEY_MCP_MAX_LIST_ENTRIES");
  if (maxListEntriesRaw !== undefined) {
    overrides.maxListEntries = parseBoundedInt(
      "--max-list-entries",
      maxListEntriesRaw,
      READ_LIMITS.maxListEntries,
    );
  }

  const defaultContextCharsRaw = pick(
    "--default-context-chars",
    "GALLEY_MCP_DEFAULT_CONTEXT_CHARS",
  );
  if (defaultContextCharsRaw !== undefined) {
    // Lower-only invariant: the override may only LOWER the default budget, so
    // the UPPER bound is READ_LIMITS.defaultContextChars (NOT maxContextChars —
    // that is the per-CALL ceiling a client may still request explicitly, not a
    // license to raise the default). parseBoundedInt rejects anything above the
    // default with "may be lowered, never raised"; we add the lower bound below.
    const n = parseBoundedInt(
      "--default-context-chars",
      defaultContextCharsRaw,
      READ_LIMITS.defaultContextChars,
    );
    if (n < READ_LIMITS.minContextChars) {
      fail(
        `--default-context-chars must be between ${READ_LIMITS.minContextChars} and ` +
          `${READ_LIMITS.defaultContextChars}; got ${n}`,
      );
    }
    overrides.defaultContextChars = n;
  }

  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

export function parseKernelConfig(
  argv: string[],
  env: Record<string, string | undefined> = {},
): KernelCliResult {
  // --help anywhere wins: the caller prints KERNEL_USAGE and exits cleanly.
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };

  const flags = parseFlags(argv);
  const pick = (flag: string, envKey: string): string | undefined =>
    flags.get(flag) ?? (env[envKey]?.trim() || undefined);

  const syncUrl = pick("--sync", "GALLEY_MCP_SYNC");
  if (!syncUrl) fail("missing --sync (or GALLEY_MCP_SYNC): the sync relay WebSocket URL");
  if (!/^wss?:\/\//.test(syncUrl)) {
    fail(`--sync must be a ws:// or wss:// URL; got ${JSON.stringify(syncUrl)}`);
  }

  const room = pick("--room", "GALLEY_MCP_ROOM");
  const file = pick("--file", "GALLEY_MCP_FILE");
  const controlRoom = pick("--control-room", "GALLEY_MCP_CONTROL_ROOM");
  const responseKeyRaw = pick("--response-key", "GALLEY_MCP_RESPONSE_KEY");
  const pairingCode = pick("--pairing-code", "GALLEY_MCP_PAIRING_CODE");

  const compileUrl = pick("--compile-url", "GALLEY_MCP_COMPILE_URL");
  if (compileUrl !== undefined) validateCompileUrl(compileUrl);
  const compilePart =
    compileUrl !== undefined ? { compileUrl: compileUrl.replace(/\/+$/, "") } : {};

  // D2: optional lowered read caps; absent ⇒ READ_LIMITS defaults (no field).
  const readLimits = parseReadLimits(pick);
  const readLimitsPart = readLimits !== undefined ? { readLimits } : {};

  // Mode selection is EXPLICIT — never guessed from partial flags.
  const controlMode = controlRoom !== undefined || pairingCode !== undefined;
  if (controlMode && (room !== undefined || file !== undefined)) {
    fail(
      "control mode (--control-room or --pairing-code) is mutually exclusive with --room/--file: " +
        "a kernel session runs in EITHER control mode (ADR-0021/ADR-0026) OR per-project mode " +
        "(ADR-0020), never both",
    );
  }
  if (pairingCode !== undefined) {
    // B2: the operator pasted the one-time code. The control room + response
    // key are obtained at startup (durable store → handshake), never from argv.
    // STRICT: a valid code is base64url of exactly PAIRING_CODE_BYTES (128-bit) —
    // a wrong-length code is a paste error / weak material, so fail loud (it is
    // NOT a silent fall-back to any legacy room/key that may also be present).
    const codeBytes = base64UrlToBytes(pairingCode);
    if (codeBytes === null || codeBytes.length !== PAIRING_CODE_BYTES) {
      fail("--pairing-code is malformed — re-copy the pairing command from Settings → Agent Access");
    }
    // F6 prefer-fresh (ADR-0026 §3): a well-formed --pairing-code ALWAYS wins.
    // If legacy --control-room/--response-key (or their env fallbacks) are ALSO
    // present we DROP them and pair freshly with the code, attaching a loud,
    // non-secret warning rather than failing loud or letting stale env silently
    // override the operator's explicit intent. The message names the FLAGS only —
    // never a room id or key value (rooms/keys are capabilities, ADR-0021/0023).
    const warnings: string[] = [];
    if (controlRoom !== undefined || responseKeyRaw !== undefined) {
      warnings.push(
        "--pairing-code takes precedence: ignoring the legacy --control-room/--response-key " +
          "(or GALLEY_MCP_CONTROL_ROOM/GALLEY_MCP_RESPONSE_KEY) also present. Pairing freshly " +
          "with the one-time code; the durable store is updated on success. Unset the legacy " +
          "values to silence this warning.",
      );
    }
    return {
      mode: "control",
      syncUrl: syncUrl.replace(/\/+$/, ""),
      authSource: "pairing-code",
      pairingCode,
      ...compilePart,
      ...readLimitsPart,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  if (controlRoom !== undefined) {
    // HIGH-1: legacy control mode REQUIRES the response-auth key — without it the
    // kernel could not tell the browser's answers from a room peer's forgeries,
    // so it refuses to start rather than run unauthenticated.
    if (responseKeyRaw === undefined) {
      fail(
        "missing --response-key (or GALLEY_MCP_RESPONSE_KEY): legacy control mode requires the " +
          "per-session response-auth key — or pair with a one-time --pairing-code instead " +
          "(B2, ADR-0026)",
      );
    }
    const responseKey = parseResponseKey(responseKeyRaw);
    return {
      mode: "control",
      syncUrl: syncUrl.replace(/\/+$/, ""),
      authSource: "args",
      controlRoom,
      responseKey,
      ...compilePart,
      ...readLimitsPart,
    };
  }
  if (responseKeyRaw !== undefined) {
    // Fail loud rather than silently ignore a security flag in the wrong mode.
    fail("--response-key is only valid in legacy control mode (with --control-room)");
  }

  if (!room && !file) {
    fail(
      "missing a mode: pass --room + --file (per-project mode), --pairing-code (B2 control " +
        "mode), or --control-room + --response-key (legacy control mode)",
    );
  }
  if (!room) fail("missing --room (or GALLEY_MCP_ROOM): the shared room id from the Share link");
  if (!file) fail("missing --file (or GALLEY_MCP_FILE): the target file path, e.g. /main.typ");

  return {
    mode: "project",
    syncUrl: syncUrl.replace(/\/+$/, ""),
    room,
    filePath: file.startsWith("/") ? file : `/${file}`,
    ...compilePart,
    ...readLimitsPart,
  };
}
