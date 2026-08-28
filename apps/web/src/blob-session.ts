/**
 * Browser blob-channel session (Phase 1 byte-transport epic).
 *
 * Opens the `galley-blob-v1` side channel for a shared room and bridges it to the
 * project's {@link BlobStore}: every VERIFIED inbound blob (the transport already
 * checked sha256 + size) is stored, and {@link BlobChannelSession.send} pushes a
 * local blob's bytes to the room's other peers (the MCP kernel, a collaborator).
 *
 * The bytes never enter the Yjs CRDT log — only the `BinaryAsset` pointer does
 * (handled elsewhere). This session is the byte path beside that pointer.
 *
 * It mirrors the connected-mode sync wiring in `project-session.ts`: a
 * factory-injected `WebSocketLike` (the browser passes a real `WebSocket`
 * requesting the blob subprotocol; tests inject a fake), the SAME room id, and
 * the SAME URL shape as the sync socket — so the relay's shared auth gate admits
 * it exactly as it admits the sync connection.
 */
import {
  BlobTransport,
  type BlobStore,
  type WebSocketLike,
  type ReceivedBlob,
  type BlobSendHandle,
  type BlobTerminalSigner,
  type BlobTerminalVerifier,
} from "@galley/collab";

/** The websocket subprotocol that selects the relay's blob channel. */
export const BLOB_SUBPROTOCOL = "galley-blob-v1";

export interface BlobChannelDeps {
  /**
   * Injectable blob socket factory (tests). Defaults to a browser `WebSocket`
   * requesting the `galley-blob-v1` subprotocol. The URL is the SAME room URL the
   * sync socket uses, so the relay's auth gate treats them identically.
   */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * A2/C1a: called AFTER a verified inbound blob is stored, with its `{hash,size}`.
   * Lets the expect_blob lease owner CLEAR the lease timer on delivery (no stray
   * no-op timer) and lets the release path know a hash is delivered+stored (so it
   * can DELETE the orphan if the proposal never publishes). Best-effort; a throw
   * is swallowed so it never tears down the channel.
   */
  onInboundStored?: (hash: string, size: number) => void;
  /**
   * Terminal-frame authentication (rework rd3 §1). The MECHANISM is wired through
   * here: when both are supplied (via `buildBlobTerminalAuth(grantResponseKey,
   * scope)`), completion is ENFORCED (a forged COMPLETE/ABORT is rejected).
   *
   * WIRED (A1): the browser's per-session grant `responseKey` + scope ARE threaded
   * in now — `ProjectApp` builds the auth via the manager's
   * `buildBlobTerminalAuthForScope(scope)` and `ensureAuthenticatedBlobChannel`
   * passes it here, so the browser blob channel SIGNS its terminal COMPLETE (the
   * kernel, the PUSH SENDER, verifies it). When both are absent (a direct/local
   * path with no grant) the channel runs WITHOUT terminal auth — completion is
   * advisory/forgeable; the agent paths refuse to push over such a channel.
   */
  terminalSigner?: BlobTerminalSigner;
  terminalVerifier?: BlobTerminalVerifier;
  /**
   * A1 §1: a stable IDENTITY of the terminal-auth SCOPE this channel's
   * signer/verifier were built for (e.g. a canonical string of the full grant
   * scope {grantId,controlRoom,syncUrl,projectId,shareRoom}). Stored on the session
   * so the channel-auth guarantee can detect a STALE scope (a re-consent that minted
   * a new grantId while the share stayed connected) and recreate the channel rather
   * than keep a verifier bound to the OLD key. Absent on the advisory path.
   */
  terminalScopeId?: string;
}

export interface BlobChannelSession {
  /**
   * Push a content-addressed blob to the room's other peers. The caller supplies
   * the already-computed `hash` (it hashed to mint the `BinaryAsset`) + `mime`.
   * Resolves (via the handle's `done`) ONLY when the receiver has verified +
   * stored the bytes and sent a terminal COMPLETE (honest completion).
   *
   * A1 export channel: an optional explicit `transferId` lets the responder push
   * under a kernel-MINTED id the receiver already RESERVED capacity for (the
   * descriptor + bytes travel on different sockets, so the id is the only stable
   * correlator). Omitted ⇒ the transport mints one, exactly as before.
   */
  send(bytes: Uint8Array, hash: string, mime: string, opts?: { transferId?: string }): BlobSendHandle;
  /**
   * Reserve inbound capacity for a transfer arriving under `transferId` whose hash
   * is not yet known (A1 export channel pull, symmetric with the kernel side).
   * Returns false if it would exceed the receiver byte quota.
   */
  expectTransfer(transferId: string, maxBytes: number): boolean;
  /** Release a transferId reservation made by {@link expectTransfer}. */
  unexpectTransfer(transferId: string): void;
  /**
   * Register that an inbound blob `{hash,size}` is EXPECTED (rework §E13). A later
   * inbound transfer that matches a live expectation is verified + stored; an
   * UNEXPECTED inbound transfer is aborted and NEVER stored. Returns false if the
   * registration would exceed the receiver byte quota. A1/A2 (and any pull flow)
   * call this before the kernel pushes a blob into the browser store.
   */
  expect(hash: string, size: number): boolean;
  /** Drop a previously-registered expectation. */
  unexpect(hash: string, size: number): void;
  /** Open the channel (connect the socket). Idempotent. */
  connect(): void;
  /** Close the channel and stop reconnecting. */
  destroy(): void;
  /**
   * Whether this channel ENFORCES authenticated completion (A1 §1) — i.e. it was
   * built with a terminal verifier, so the SENDER resolves a push ONLY on a
   * MAC-verified COMPLETE (a forged COMPLETE from a 3rd peer is rejected). The
   * agent export path REFUSES to push over a channel where this is false — pushing
   * the PDF over an ADVISORY channel would re-expose the forged-COMPLETE DoS.
   */
  readonly authenticated: boolean;
  /**
   * The terminal-auth SCOPE IDENTITY this channel was built for (A1 §1), or
   * undefined on the advisory path. The channel-auth guarantee recreates the channel
   * when a NEW scope is requested (a re-consent minted a new grant) so the verifier
   * never stays bound to a stale key.
   */
  readonly terminalScopeId: string | undefined;
}

/**
 * Create a browser blob-channel session for `room`, storing verified inbound
 * blobs into `store`. Does NOT connect until {@link BlobChannelSession.connect}
 * is called — the caller (project-session) connects it AFTER the sync socket has
 * connected, so both channels share the same lifecycle.
 */
export function createBlobChannelSession(
  syncUrl: string,
  room: string,
  store: BlobStore,
  deps: BlobChannelDeps = {},
): BlobChannelSession {
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
  const makeSocket =
    deps.socketFactory ??
    ((u: string) => new WebSocket(u, BLOB_SUBPROTOCOL) as unknown as WebSocketLike);

  const transport = new BlobTransport(() => makeSocket(url), {
    ...(deps.terminalSigner ? { terminalSigner: deps.terminalSigner } : {}),
    ...(deps.terminalVerifier ? { terminalVerifier: deps.terminalVerifier } : {}),
    onBlob: async (blob: ReceivedBlob) => {
      // The transport already VERIFIED sha256 + size before delivering. Store
      // under the verified hash; PersistentBlobStore re-hashes on put (dedup) and
      // verifies again on read, so a tampered backend can never surface bad bytes
      // to the compiler. We pass the verified mime so the pointer is faithful.
      await store.put(blob.bytes, { mime: blob.mime });
      // A2/C1a: signal delivery so the expect_blob lease can be cleared and the
      // release path knows the bytes are now stored. Best-effort, never throws.
      try {
        deps.onInboundStored?.(blob.hash, blob.size);
      } catch {
        /* a delivery hook error must not tear down the channel */
      }
    },
  });

  // A1 §1: the channel is "authenticated" iff a terminal VERIFIER is wired — only
  // then does the SENDER reject a forged COMPLETE. The export path requires this.
  const authenticated = deps.terminalVerifier !== undefined;
  // The scope identity the auth was built for (undefined on the advisory path).
  const terminalScopeId = authenticated ? deps.terminalScopeId : undefined;

  return {
    authenticated,
    terminalScopeId,
    send(bytes, hash, mime, opts) {
      return transport.send(bytes, hash, mime, opts ?? {});
    },
    expect(hash, size) {
      return transport.expect(hash, size);
    },
    unexpect(hash, size) {
      transport.unexpect(hash, size);
    },
    expectTransfer(transferId, maxBytes) {
      return transport.expectTransfer(transferId, maxBytes);
    },
    unexpectTransfer(transferId) {
      transport.unexpectTransfer(transferId);
    },
    connect() {
      transport.connect();
    },
    destroy() {
      transport.disconnect();
    },
  };
}
