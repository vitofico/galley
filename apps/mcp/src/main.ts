import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bytesToBase64Url, base64UrlToBytes } from "@galley/collab";
import { parseKernelConfig, roomFingerprint, KERNEL_USAGE } from "./config.js";
import type { ControlKernelConfig } from "./config.js";
import { createHttpCompileService } from "./compile-client.js";
import { joinRoom } from "./session.js";
import { joinControlRoom, runPairingHandshake } from "./control.js";
import { loadPairing, savePairing } from "./pairing-store.js";
import { createGalleyMcpServer } from "./server.js";
import { registerControlTools } from "./control-tools.js";

/**
 * Resolve the control-room authority (B2, ADR-0026). Resolution order:
 *   1. `--pairing-code` HANDSHAKE (prefer-fresh, ADR-0026): if the operator pasted
 *      a fresh one-time code it WINS — the parser already dropped any legacy
 *      room/key (warned) — so we try a MAC-verified durable pairing FIRST (no
 *      re-handshake), else run the handshake, then PERSIST.
 *   2. LEGACY ARGS (`authSource:"args"`, only when NO --pairing-code was given):
 *      room+key straight from argv/env, MEMORY-ONLY, never persisted.
 *   3. else: an honest error (the config layer already guaranteed one of the above
 *      is present, so this only fires on a handshake/store failure).
 *
 * The PARSER (not this function) enforces precedence; `authSource` already
 * encodes the winner, so the code branches below stay as-is.
 */
async function resolveControlAuthority(
  config: ControlKernelConfig,
): Promise<{ controlRoom: string; responseKey: Uint8Array }> {
  // 1. Legacy args — ephemeral, never persisted.
  if (config.authSource === "args") {
    if (config.controlRoom === undefined || config.responseKey === undefined) {
      throw new Error("legacy control mode is missing its room/key (internal config error)");
    }
    return { controlRoom: config.controlRoom, responseKey: config.responseKey };
  }

  // 2. A durable, MAC-verified pairing from a prior handshake — no re-paste.
  const durable = await loadPairing(process.env);
  if (durable !== null) {
    const responseKey = base64UrlToBytes(durable.responseKey);
    if (responseKey !== null && responseKey.length === 32) {
      console.error(
        "galley mcp kernel: resumed a durable pairing (no re-paste needed) — " +
          `control room ${roomFingerprint(durable.controlRoom)}`,
      );
      return { controlRoom: durable.controlRoom, responseKey };
    }
    // A shape-valid-but-bad durable blob falls through to the handshake below.
  }

  // 3. Run the one-time --pairing-code handshake, then persist the result.
  if (config.pairingCode === undefined) {
    throw new Error(
      "no durable pairing and no --pairing-code: pair from Settings → Agent Access",
    );
  }
  console.error(
    "galley mcp kernel: no durable pairing — running the pairing handshake " +
      "(open Galley, enable Agent Access, and paste the --pairing-code command once)…",
  );
  const result = await runPairingHandshake(config.pairingCode, { syncUrl: config.syncUrl });
  // Persist ONLY the control pairing (room + key) — best-effort; a write failure
  // is logged but the in-memory pairing still serves THIS run.
  try {
    await savePairing(
      { controlRoom: result.controlRoom, responseKey: bytesToBase64Url(result.responseKey) },
      process.env,
    );
    console.error(
      `galley mcp kernel: paired and stored durably (control room ${roomFingerprint(result.controlRoom)}) ` +
        "— future runs need no re-paste (re-pair only after a Revoke)",
    );
  } catch (err) {
    console.error(
      `galley mcp kernel: paired, but could not persist the pairing (${err instanceof Error ? err.message : String(err)}); ` +
        "this run works, but the next will need the --pairing-code again",
    );
  }
  return { controlRoom: result.controlRoom, responseKey: result.responseKey };
}

/**
 * Stdio entry point (#16.1 + #16.3a; ADR-0020/ADR-0021). Two modes — see
 * `galley-mcp --help` (KERNEL_USAGE in config.ts):
 *
 *   per-project: pnpm --filter @galley/mcp start -- \
 *     --sync ws://localhost:1234 --room <share-room-id> --file /main.typ \
 *     [--compile-url http://localhost:3001]
 *
 *   control:     pnpm --filter @galley/mcp start -- \
 *     --sync ws://localhost:1234 --control-room <control-room-id> \
 *     [--compile-url http://localhost:3001]
 *
 * Both room ids are unguessable capabilities minted by the browser (Share /
 * Agent Access). Per-project mode joins ONE room scoped to ONE file, waits
 * until the file has replicated, then serves the document tools. Control mode
 * joins the Agent Access control room and serves `list_projects` /
 * `list_versions` / `open_project`; a successful open_project joins the
 * project room the BROWSER minted and adds the per-project tools to the same
 * session (one project per kernel run). Control mode does NOT wait for a
 * responder at startup — tools fail closed with a timeout until Galley is open
 * with Agent Access enabled.
 *
 * Local-first and unauthenticated by design — stdio reaches only the user who
 * spawned the process, and both configured endpoints (sync relay, compile
 * service) are explicit, loopback-intended URLs (networked/authenticated MCP is
 * #16.4). stdout carries the MCP protocol EXCLUSIVELY; every human-facing
 * notice or failure goes to stderr (--help, which exits before serving, is the
 * one stdout exception).
 */
async function main(): Promise<void> {
  // Fail loud on bad config: the parse error names the missing/invalid flag.
  const config = parseKernelConfig(process.argv.slice(2), process.env);
  if (config.mode === "help") {
    console.log(KERNEL_USAGE);
    return;
  }

  // F6 (ADR-0026 §3, prefer-fresh): the parser dropped any legacy room/key that
  // co-existed with a fresh --pairing-code and attached a loud, non-secret notice.
  // Print it to stderr BEFORE resolving authority so the operator sees that their
  // explicit code (not the stale legacy creds) is what is being paired with.
  if (config.mode === "control" && config.warnings) {
    for (const w of config.warnings) console.error(`galley mcp kernel: ${w}`);
  }

  const compileService =
    config.compileUrl !== undefined ? createHttpCompileService(config.compileUrl) : undefined;

  if (config.mode === "control") {
    // B2 (ADR-0026): resolve the room+key — legacy args → durable pairing →
    // --pairing-code handshake (persisted). The downstream join + proposal-signing
    // logic is UNCHANGED; only the KEY's ORIGIN moves out of argv.
    const { controlRoom, responseKey } = await resolveControlAuthority(config);
    const control = joinControlRoom({
      syncUrl: config.syncUrl,
      room: controlRoom,
      // HIGH-1: only responses HMAC-signed with this out-of-band key are accepted.
      responseKey,
    });
    const server = createGalleyMcpServer();
    registerControlTools(server, {
      rpc: control.rpc,
      configuredSyncUrl: config.syncUrl,
      controlRoom,
      // ADR-0023 §1: the pairing secret also signs published proposals (derived
      // per-grant), so the project-room join needs it.
      responseKey,
      ...(compileService !== undefined ? { compileService } : {}),
    });
    await server.connect(new StdioServerTransport());
    // Room ids are CAPABILITIES — stderr gets only a non-reversible fingerprint
    // (Security round 2, finding 2; logs get persisted and shared).
    console.error(
      `galley mcp kernel listening on stdio (control room configured: ` +
        `${roomFingerprint(controlRoom)}, compile ${config.compileUrl ?? "not configured"}) ` +
        "— open Galley and enable Agent Access to answer this session",
    );
    return;
  }

  const session = joinRoom(config);
  try {
    await session.whenFileReady();
  } catch (err) {
    session.destroy();
    throw err;
  }
  console.error(`galley mcp kernel: joined room, ${config.filePath} is live`);

  const server = createGalleyMcpServer({
    surface: session.surface,
    // ADR-0024 §1: every per-project result carries honest, room-derived liveness.
    liveness: () => session.liveness(),
    ...(compileService !== undefined ? { compileService } : {}),
  });
  await server.connect(new StdioServerTransport());
  // Same redaction stance as control mode: the share-room id is a capability.
  console.error(
    `galley mcp kernel listening on stdio (room configured: ${roomFingerprint(config.room)}, ` +
      `file ${config.filePath}, compile ${config.compileUrl ?? "not configured"})`,
  );
}

main().catch((err: unknown) => {
  // One honest line — the message, never a stack — then a non-zero exit.
  console.error(`galley mcp kernel failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
