/**
 * The kernel's control-room session (#16.3a, ADR-0021): join the browser's
 * Agent Access control room as a peer — a BARE replicated Y.Doc, not a
 * CollabProject; the only shared state is the control mailbox — and expose one
 * bounded RPC primitive to the control tool layer.
 *
 * Trust model: the kernel only JOINS the control room named in its config (an
 * unguessable capability minted by the browser's Agent Access surface). Every
 * RPC is fail-closed and bounded:
 *   - the request is size/shape-capped at publish (CONTROL_LIMITS),
 *   - RESPONSE AUTHENTICATION (HIGH-1): only a response whose HMAC-SHA-256
 *     verifies (timing-safe) under the out-of-band pairing key is accepted —
 *     a room peer can read and write the mailbox but cannot forge an answer
 *     this kernel acts on; forged/unsigned responses are ignored and the wait
 *     continues until the authentic one or the timeout,
 *   - the answer must arrive within the timeout or the call FAILS with one
 *     honest line — no retries here or anywhere above (no retry storms; the
 *     human fix is "open Galley and enable Agent Access", not hammering),
 *   - even a VERIFIED failure surfaces only as a LOCAL error line (MEDIUM-3):
 *     the consent-required marker is recognized and substituted, everything
 *     else maps to one generic refusal — no responder bytes reach the client,
 *   - the settled request is withdrawn either way (success OR timeout), so the
 *     kernel cleans up its own mailbox records and a late responder is less
 *     likely to act on an abandoned ask,
 *   - the response body is opaque `unknown` here — the TOOL layer
 *     schema-validates it per op (the responder is just another peer).
 */
import * as Y from "yjs";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket as WS } from "ws";
import {
  CollabConnection,
  WebSocketTransport,
  publishControlRequest,
  awaitControlResponse,
  withdrawControlRequest,
  controlResponseSigningString,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  openPairingPayload,
  bytesToBase64Url,
  base64UrlToBytes,
  CONTROL_RESPONSE_KEY_BYTES,
  PAIRING_NONCE_BYTES,
  PAIRING_EPH_PUBLIC_BYTES,
  type ControlParams,
  type ControlResponse,
  type WebSocketLike,
} from "@galley/collab";
import type { DocHost } from "@galley/collab";
import { isCapabilityRoomId } from "@galley/shared";
import { MCP_AUTHOR } from "./session.js";

/** Default per-RPC deadline: ample for a human-less browser answer, never open-ended. */
export const CONTROL_RPC_TIMEOUT_MS = 10_000;

/** The control-mailbox op name the pairing claim rides on (lowercase snake_case). */
export const PAIRING_CLAIM_OP = "pairing_claim";

/** A human-less pairing wait: the operator may take a moment to click Enable + paste. */
export const PAIRING_HANDSHAKE_TIMEOUT_MS = 120_000;

/** What a successful handshake yields: the durable control pairing + the relay it used. */
export interface PairingHandshakeResult {
  controlRoom: string;
  responseKey: Uint8Array;
  syncUrl: string;
}

export interface PairingHandshakeOptions {
  /** The relay ws(s) URL to join the derived pairing room on (production path). */
  syncUrl?: string;
  /** An already-joined pairing-room host (tests inject an in-memory Y.Doc; no relay). */
  host?: DocHost;
  /** Injectable socket for tests; defaults to the `ws` package. */
  socketFactory?: (url: string) => WebSocketLike;
  /** Override the handshake deadline (default {@link PAIRING_HANDSHAKE_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Run the kernel side of the B2 pairing handshake (ADR-0026, v2 — forward secrecy).
 * From the one-time pairing CODE the kernel derives — WITHOUT transmitting it — the
 * pairing room id + a bootstrap MAC key + a code SECRET. It mints an EPHEMERAL ECDH
 * keypair + a CSPRNG nonce + a CSPRNG request id, and publishes a CLAIM under THAT
 * id = `{ ephPub, nonce, claimMac = HMAC(macKey, kernel ‖ ephPub ‖ nonce ‖ id) }`
 * (PROOF it knows the code that AUTHENTICATES its ephemeral pubkey + nonce + the
 * mailbox id, NEVER the code). The browser verifies the claim, replies with ITS
 * ephemeral pubkey (also MAC-authenticated, direction="browser") + the SEALED
 * payload. The kernel verifies the browser's claim, derives the seal key from
 * ECDH(its eph priv, the browser eph pub) ‖ codeSecret, OPENS the seal, validates
 * the shape, and DISCARDS its ephemeral private key.
 *
 * FORWARD SECRECY: the seal key needs an ephemeral private key (discarded here), so
 * a recorded transcript + a later code leak cannot recover the responseKey. ID-REPLAY
 * (#2): the claimMac binds the mailbox request id, so a pairing-room peer copying the
 * claim onto a SECOND id fails the browser's MAC check (the browser recomputes over
 * the actual request.id) — it can no longer consume the code under a foreign id.
 * THROWS on timeout, an unverifiable browser claim, an unopenable seal, or a
 * bad-shape payload — the kernel does not start unauthenticated.
 */
export async function runPairingHandshake(
  code: string,
  opts: PairingHandshakeOptions,
): Promise<PairingHandshakeResult> {
  const timeoutMs = opts.timeoutMs ?? PAIRING_HANDSHAKE_TIMEOUT_MS;
  const { pairingRoom, macKey, codeSecret } = await deriveBootstrap(code);

  // The pairing-room host: a test-injected in-memory doc, or a real relay join.
  let connection: CollabConnection | undefined;
  let ownsHost = false;
  let host: DocHost;
  if (opts.host !== undefined) {
    host = opts.host;
  } else {
    if (opts.syncUrl === undefined) {
      throw new Error("runPairingHandshake: a syncUrl is required to join the pairing room");
    }
    host = { doc: new Y.Doc() };
    ownsHost = true;
    const url = `${opts.syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(pairingRoom)}`;
    const makeSocket =
      opts.socketFactory ??
      ((u: string) => {
        const socket = new WS(u);
        // A pairing-room socket error must never escalate to an uncaught
        // exception; the handshake fails closed via the timeout below. (The
        // pairing room id is a public HKDF derivative, so it is not scrubbed.)
        socket.addEventListener("error", (event) => {
          const raw = (event as { message?: string }).message ?? "connection error";
          console.error(`galley mcp kernel: pairing-room socket error: ${raw}`);
        });
        return socket as unknown as WebSocketLike;
      });
    connection = new CollabConnection(
      host,
      new WebSocketTransport(() => makeSocket(url)),
      { author: MCP_AUTHOR },
    );
    connection.connect();
  }

  // The kernel's ephemeral ECDH keypair + the CSPRNG nonce. The PRIVATE key never
  // leaves this scope and is dropped when the function returns (forward secrecy).
  const ephemeral = await generateEphemeralKeyPair();
  const ephPublicRaw = await exportEphemeralPublic(ephemeral);
  const ephPubB64 = bytesToBase64Url(ephPublicRaw);
  const nonce = new Uint8Array(randomBytes(PAIRING_NONCE_BYTES));
  const nonceB64 = bytesToBase64Url(nonce);
  // Mint OUR OWN request id so we can bind it into the claim MAC BEFORE publishing.
  const requestId = randomUUID();

  let published = false;
  try {
    const claimMac = await computeClaimMac(macKey, {
      direction: "kernel",
      ephPublicRaw,
      nonce,
      requestId,
    });
    // The claim: ephPub + nonce + claimMac (PROOF). The code NEVER enters params.
    // We publish under OUR pre-minted id so the MAC binds the actual mailbox key.
    publishControlRequest(
      host,
      { op: PAIRING_CLAIM_OP, params: { ephPub: ephPubB64, nonce: nonceB64, claimMac } },
      MCP_AUTHOR,
      requestId,
    );
    published = true;
    const response = await awaitControlResponse(host, requestId, { timeoutMs });
    if (!response.ok) {
      throw new Error(`pairing handshake refused: ${response.error}`);
    }
    const result = response.result;
    if (typeof result !== "object" || result === null) {
      throw new Error("pairing handshake response was not a sealed payload");
    }
    const { bEphPub, bClaimMac, sealed } = result as {
      bEphPub?: unknown;
      bClaimMac?: unknown;
      sealed?: unknown;
    };
    if (typeof bEphPub !== "string" || typeof bClaimMac !== "string") {
      throw new Error("pairing handshake response was missing the browser ephemeral key/claim");
    }
    const browserPub = base64UrlToBytes(bEphPub);
    if (browserPub === null || browserPub.length !== PAIRING_EPH_PUBLIC_BYTES) {
      throw new Error("pairing handshake browser ephemeral public key was malformed");
    }
    // Verify the BROWSER's claim (direction="browser") binds ITS eph pubkey + the
    // SAME nonce + the SAME request id under the code-derived macKey: a peer without
    // the code cannot have produced it, and it cannot be a reflected kernel claim.
    const browserOk = await verifyClaimMac(
      macKey,
      { direction: "browser", ephPublicRaw: browserPub, nonce, requestId },
      bClaimMac,
    );
    if (!browserOk) {
      throw new Error(
        "pairing handshake browser claim did not verify — the response was not from your browser " +
          "(the pairing code is wrong/expired; re-copy the --pairing-code from Settings → Agent Access)",
      );
    }
    if (typeof sealed !== "object" || sealed === null) {
      throw new Error("pairing handshake response carried no sealed payload");
    }
    // Derive the seal key from ECDH(kernel eph priv, browser eph pub) ‖ codeSecret.
    const sealKey = await deriveSealKey(ephemeral.privateKey, browserPub, codeSecret, nonce);
    const opened = await openPairingPayload(sealKey, sealed as { iv: string; ct: string }, {
      nonce: nonceB64,
      requestId,
      pairingRoom,
    });
    if (opened === null) {
      throw new Error(
        "pairing handshake seal could not be opened — the pairing code is wrong/expired, or the " +
          "response was not from your browser (re-copy the --pairing-code from Settings → Agent Access)",
      );
    }
    const responseKey = base64UrlToBytes(opened.responseKey);
    if (responseKey === null || responseKey.length !== CONTROL_RESPONSE_KEY_BYTES) {
      throw new Error("pairing handshake payload responseKey did not decode to 32 bytes");
    }
    // Defense-in-depth: the responseKey must NOT echo a bootstrap value, nor be
    // all-zero. An honest browser mints a fresh CSPRNG responseKey.
    if (
      (responseKey.length === macKey.length && timingSafeEqual(responseKey, macKey)) ||
      (responseKey.length === codeSecret.length && timingSafeEqual(responseKey, codeSecret)) ||
      (responseKey.length === sealKey.length && timingSafeEqual(responseKey, sealKey))
    ) {
      throw new Error("pairing handshake payload responseKey equals a derived key (rejected)");
    }
    if (responseKey.every((b) => b === 0)) {
      throw new Error("pairing handshake payload responseKey is all-zero (rejected)");
    }
    // The controlRoom must be a real capability room id (the kernel will JOIN it).
    if (!isCapabilityRoomId(opened.controlRoom)) {
      throw new Error("pairing handshake payload controlRoom is not a capability room id");
    }
    return {
      controlRoom: opened.controlRoom,
      responseKey,
      syncUrl: opened.syncUrl,
    };
  } finally {
    if (published) {
      try {
        withdrawControlRequest(host, requestId, MCP_AUTHOR);
      } catch {
        // best-effort cleanup
      }
    }
    if (ownsHost) {
      connection?.destroy();
      host.doc.destroy();
    }
  }
}

/** A structured RPC outcome (never throws across the tool boundary). */
export type ControlRpcOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * The kernel's LOCAL consent-required line (MEDIUM-3): when a VERIFIED browser
 * refusal carries the `consent-required` marker, the kernel substitutes THIS
 * string — same meaning, zero wire bytes — so the tool layer can keep its
 * friendly "grant it in Settings" mapping without ever relaying responder text.
 */
export const CONSENT_REQUIRED_REFUSAL =
  "consent-required: the browser has not granted file access for this project in this session";

/** The kernel's LOCAL generic refusal for every other responder-sent failure (MEDIUM-3). */
export const GENERIC_REFUSAL = "the responder refused this request";

/**
 * Classify a VERIFIED responder failure into a LOCAL error string (MEDIUM-3 —
 * peer-text reflection): even though the refusal is HMAC-authenticated browser
 * text, NO wire bytes ride into the MCP client. Only the locally generated
 * lines below (and the kernel's own timeout/config messages) ever surface.
 */
function classifyRefusal(wireError: string): string {
  if (wireError.startsWith("consent-required")) return CONSENT_REQUIRED_REFUSAL;
  return GENERIC_REFUSAL;
}

/**
 * Verify a response's HMAC (HIGH-1). Constant-time comparison; absent sig,
 * wrong length, or any mismatch → false. The expected MAC is recomputed over
 * `expectedId` — the id of the request THIS KERNEL IS AWAITING — never the
 * record's self-asserted `response.id` (HIGH-2, cross-request replay): a
 * validly signed response for request A replayed under request B's key then
 * fails verification BY CONSTRUCTION (the recomputed string carries B's id;
 * the signature covers A's). `respondedAt` and `sig` itself are outside the
 * signed string by contract.
 */
export function verifyControlResponseSig(
  response: ControlResponse,
  expectedId: string,
  key: Uint8Array,
): boolean {
  if (key.length !== CONTROL_RESPONSE_KEY_BYTES) return false;
  if (response.sig === undefined) return false;
  // Belt-and-braces: the mailbox read path already rejects a key↔id mismatch
  // (getControlResponse binds record.id to the map key), but this verifier
  // must hold on its own — defense in depth.
  if (response.id !== expectedId) return false;
  const payload = response.ok
    ? { id: expectedId, ok: true as const, result: response.result }
    : { id: expectedId, ok: false as const, error: response.error };
  const expected = createHmac("sha256", key)
    .update(controlResponseSigningString(payload))
    .digest("base64url");
  const offered = Buffer.from(response.sig, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (offered.length !== wanted.length) return false;
  return timingSafeEqual(offered, wanted);
}

export interface ControlSession {
  /**
   * One bounded request/response round-trip over the control mailbox.
   * `ok: false` covers BOTH a responder-sent failure and a local/timeout
   * failure — always one honest line, never a stack.
   */
  rpc(op: string, params: ControlParams, timeoutMs?: number): Promise<ControlRpcOutcome>;
  destroy(): void;
}

export interface JoinControlRoomOptions {
  /** Injectable socket for tests; defaults to the `ws` package. */
  socketFactory?: (url: string) => WebSocketLike;
}

export function joinControlRoom(
  config: { syncUrl: string; room: string; responseKey: Uint8Array },
  opts: JoinControlRoomOptions = {},
): ControlSession {
  const host: DocHost = { doc: new Y.Doc() };
  const url = `${config.syncUrl}/${encodeURIComponent(config.room)}`;
  const makeSocket =
    opts.socketFactory ??
    ((u: string) => {
      const socket = new WS(u);
      // One stderr line per socket failure (never a throw/stack): an
      // unreachable relay surfaces to the MCP client as fail-closed RPC
      // timeouts; this tells the HUMAN why. Without a listener, `ws` would
      // escalate the error event to an uncaught exception. The room id is a
      // CAPABILITY (Security round 2, finding 2): scrub it — plain and
      // URL-encoded — from whatever text the socket library produced (some
      // errors embed the request URL) before the line reaches stderr.
      socket.addEventListener("error", (event) => {
        const raw = (event as { message?: string }).message ?? "connection error";
        const scrubbed = raw
          .split(config.room)
          .join("<control-room>")
          .split(encodeURIComponent(config.room))
          .join("<control-room>");
        console.error(`galley mcp kernel: control-room socket error: ${scrubbed}`);
      });
      return socket as unknown as WebSocketLike;
    });
  const connection = new CollabConnection(
    host,
    new WebSocketTransport(() => makeSocket(url)),
    { author: MCP_AUTHOR },
  );
  connection.connect();

  return {
    async rpc(op, params, timeoutMs = CONTROL_RPC_TIMEOUT_MS): Promise<ControlRpcOutcome> {
      let id: string;
      try {
        id = publishControlRequest(host, { op, params }, MCP_AUTHOR);
      } catch (err) {
        // Publish-side cap violations (oversize, pending-cap) — honest line.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      try {
        // HIGH-1: settle ONLY on a response whose HMAC verifies under the
        // pairing key — forged/unsigned responses are silently ignored and the
        // wait continues (the browser's overwrite publish can still land).
        const response = await awaitControlResponse(host, id, {
          timeoutMs,
          // HIGH-2: verify over the id THIS rpc is awaiting — a signed response
          // replayed from another request can never pass for this one.
          accept: (candidate) => verifyControlResponseSig(candidate, id, config.responseKey),
        });
        // MEDIUM-3: even a VERIFIED failure surfaces as a LOCAL string only —
        // the consent marker keeps its meaning, everything else goes generic.
        // No wire bytes ever ride into an MCP-client-visible error.
        return response.ok
          ? { ok: true, result: response.result }
          : { ok: false, error: classifyRefusal(response.error) };
      } catch {
        return {
          ok: false,
          error:
            `no responder answered '${op}' within ${timeoutMs}ms — open Galley in the browser ` +
            "and make sure Agent Access is enabled for this control room (responses without a " +
            "valid pairing signature are ignored; if you re-enabled Agent Access, re-copy the " +
            "pairing command)",
        };
      } finally {
        // Requester self-GC: the pair is withdrawn once the RPC settles —
        // after a timeout too (best-effort revocation of the abandoned ask).
        withdrawControlRequest(host, id, MCP_AUTHOR);
      }
    },

    destroy(): void {
      connection.destroy();
      host.doc.destroy();
    },
  };
}
