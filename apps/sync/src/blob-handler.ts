/**
 * Relay-side `galley-blob-v1` channel (Phase 1 byte-transport epic; hardened in
 * the Security/Code-Review rework).
 *
 * The blob channel is a SECOND websocket surface on the SAME sync HTTP server,
 * selected by the `galley-blob-v1` subprotocol. It carries content-addressed blob
 * BYTES between peers (browser ⇄ MCP kernel) so binary content never enters the
 * Yjs CRDT update log. This handler is the relay end: it does NOT persist or
 * reassemble blobs — it FORWARDS frames between peers. Reassembly + sha256 verify
 * + store happen on the receiving CLIENT (`BlobTransport`). Content addressing
 * makes CORRUPTION impossible regardless of relay routing — DATA is broadcast and
 * the real receiver re-hashes, so no peer can poison the bytes.
 *
 * THE RELAY IS KEYLESS + UNTRUSTED FOR COMPLETION. It does NOT authenticate
 * terminal frames — that is END-TO-END between the two paired clients. The
 * trustworthy-completion guarantee lives in the TRANSPORT's terminal-frame MAC
 * (rework rd3 §1): when the clients are paired (a terminal key is configured), the
 * sender resolves a push ONLY on a COMPLETE whose HMAC verifies, so a forged
 * COMPLETE/ABORT relayed by — or injected via — any room peer is IGNORED.
 *
 * DIRECTIONAL ROUTING (rework §A4) narrows the blast radius but is NOT the
 * security boundary: the relay tracks per transferId the SENDER conn (sent the
 * HEADER) and the RECEIVER conn (first OTHER conn to answer a control frame):
 *  - DATA frames forward to the room's OTHER peers (toward the receiver);
 *  - ACK / ABORT / COMPLETE frames route back to the transfer's SENDER conn ONLY;
 *  - once a receiver is bound, control frames from any OTHER conn are dropped.
 * RESIDUAL (documented): an UNAUTHENTICATED terminal frame is FORGEABLE — a
 * malicious 3rd room peer can race to bind as the "receiver" or send an ABORT and
 * thereby DoS ONE transfer (the un-paired/advisory path). It can NEVER cause
 * silent corruption (content addressing) and, when a terminal key IS configured,
 * never a false SUCCESS either (the forged COMPLETE fails the MAC check and is
 * ignored — the push fails closed instead). A forged ACK can likewise at worst
 * DoS one transfer. This is acceptable under the existing peer-trust model: any
 * room member already holds the room capability.
 *
 * The channel reuses the sync server's EXACT auth gate (same room, same
 * authorizeUpgrade/capability check, same Origin allowlist incl. the absent-Origin
 * capability carve-out). It is NOT an unauthenticated entrypoint.
 *
 * DoS hardening (rework §D): per-connection message-rate AND byte-rate limits,
 * a max-peers-per-room cap, a per-connection in-flight-transfer cap, a bounded
 * room registry, and BACKPRESSURE — a peer whose socket `bufferedAmount` exceeds
 * a threshold is terminated rather than letting the relay buffer unboundedly.
 */
import type { WebSocket } from "ws";
import { peekFrameRouting, FrameType } from "@galley/collab";

/** The websocket subprotocol that selects the blob channel. */
export const BLOB_SUBPROTOCOL = "galley-blob-v1";

/**
 * Per-connection sliding-window MESSAGE-rate cap. A blob push is HEADER + N chunk
 * frames + ACKs; even a fat 64 MiB transfer at 256 KiB chunks is ~256 data frames
 * within a 1 s window, well under this. A peer that floods past it is terminated.
 */
const RATE_WINDOW_MS = 1_000;
const MAX_MESSAGES_PER_WINDOW = 4_000;

/**
 * Per-connection sliding-window BYTE-rate cap (rework §D11): message count alone
 * doesn't bound throughput — 4000 × 256 KiB ≈ 1 GiB/s. A legit single push of the
 * 64 MiB max is far under this per-second ceiling; sustained traffic above it is
 * abusive. 256 MiB / 1 s window (≈ a few max transfers/s) is generous headroom.
 */
const MAX_BYTES_PER_WINDOW = 256 * 1024 * 1024;

/** Max peers in a single blob room (rework §D11). Two is the norm (browser+kernel). */
const MAX_PEERS_PER_ROOM = 16;

/** Max concurrent transfers a single connection may ORIGINATE (rework §D11). */
const MAX_INFLIGHT_PER_CONN = 16;

/**
 * Backpressure threshold (rework §D12): if a destination socket's outbound
 * `bufferedAmount` exceeds this, the relay is outrunning a slow peer. Rather than
 * buffer unboundedly we TERMINATE that slow peer (its transfers fail closed and
 * its client reconnects). 16 MiB ≈ 64 unsent max chunks — well past any healthy
 * peer, which drains continuously.
 */
const MAX_PEER_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Bound the number of distinct blob rooms a process holds (reaped when empty). */
const MAX_BLOB_ROOMS = 10_000;

/** Per-transfer routing state: who sends, who receives. */
interface Transfer {
  /** The connection that originated the transfer (sent the HEADER). */
  sender: WebSocket;
  /** The bound receiver conn (first OTHER conn to answer a control frame), if any. */
  receiver: WebSocket | undefined;
}

/** A blob room: its live connections + the in-flight transfers routed within it. */
interface BlobRoom {
  conns: Set<WebSocket>;
  transfers: Map<string, Transfer>;
}

export interface BlobRelayHandle {
  /** Number of live blob rooms (observability/tests). */
  roomCount(): number;
  /** Connection count in `room` (0 if absent). */
  connCount(room: string): number;
  /** In-flight transfer count in `room` (0 if absent; tests/observability). */
  transferCount(room: string): number;
  /** Close all connections + clear rooms (graceful shutdown). */
  closeAll(): void;
}

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return undefined;
}

/** The current outbound buffered bytes on a ws (0 if the lib doesn't expose it). */
function bufferedAmount(ws: WebSocket): number {
  const n = (ws as { bufferedAmount?: number }).bufferedAmount;
  return typeof n === "number" ? n : 0;
}

export function createBlobRelay(): BlobRelay {
  return new BlobRelay();
}

export class BlobRelay implements BlobRelayHandle {
  private readonly rooms = new Map<string, BlobRoom>();

  roomCount(): number {
    return this.rooms.size;
  }
  connCount(room: string): number {
    return this.rooms.get(room)?.conns.size ?? 0;
  }
  transferCount(room: string): number {
    return this.rooms.get(room)?.transfers.size ?? 0;
  }

  /**
   * Adopt an authorized blob connection into `room`. The connection MUST already
   * have passed the sync server's room auth. Returns false (and closes the
   * socket) if the room cap or per-room peer cap is hit.
   */
  handleConnection(ws: WebSocket, room: string): boolean {
    let blobRoom = this.rooms.get(room);
    if (blobRoom === undefined) {
      if (this.rooms.size >= MAX_BLOB_ROOMS) {
        this.closeSocket(ws, 1013, "too many blob rooms");
        return false;
      }
      blobRoom = { conns: new Set(), transfers: new Map() };
      this.rooms.set(room, blobRoom);
    }
    // Per-room peer cap (§D11): refuse a connection past the ceiling.
    if (blobRoom.conns.size >= MAX_PEERS_PER_ROOM) {
      this.closeSocket(ws, 1013, "too many peers in blob room");
      // Reap a freshly-created-but-now-unused room.
      if (blobRoom.conns.size === 0 && this.rooms.get(room) === blobRoom) this.rooms.delete(room);
      return false;
    }
    const peers = blobRoom.conns;
    peers.add(ws);
    const transfers = blobRoom.transfers;

    let dropped = false;
    const drop = (): void => {
      dropped = true;
      try {
        ws.terminate();
      } catch {
        /* terminate is best-effort */
      }
    };

    ws.on("error", () => {
      /* ws closes the socket; don't let it crash the relay */
    });

    let windowStart = Date.now();
    let windowMessages = 0;
    let windowBytes = 0;

    ws.addEventListener("message", (event: unknown) => {
      if (dropped) return;
      const now = Date.now();
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now;
        windowMessages = 0;
        windowBytes = 0;
      }
      // Rate limits (rework rd3 §3): count EVERY message — including non-binary
      // ones — BEFORE the binary-type filter, so a flood of non-binary frames
      // can't bypass the limiter and churn the event loop unbounded. The previous
      // code `return`ed on a non-binary frame before incrementing the counter.
      if (++windowMessages > MAX_MESSAGES_PER_WINDOW) {
        drop();
        return;
      }
      const data = asBytes((event as { data?: unknown }).data);
      if (data === undefined) {
        // A non-binary frame on the blob socket is never legitimate (the protocol
        // is all binary). It already counted toward the message-rate cap above;
        // drop the CONNECTION so a slow non-binary flood can't sit just under the
        // cap forever. Charge a nominal byte cost too, belt-and-braces.
        windowBytes += 1;
        drop();
        return;
      }
      windowBytes += data.length;
      if (windowBytes > MAX_BYTES_PER_WINDOW) {
        drop();
        return;
      }
      // Parse ONLY the routing header (tag + transferId), NEVER slicing the chunk
      // payload (rework rd3 §4). peekFrameRouting is bounds-/cap-checked; a
      // malformed/oversize/unknown frame throws and is dropped (never crash, never
      // forward arbitrary bytes). The ORIGINAL frame bytes are forwarded unchanged.
      let tag: number;
      let transferId: string;
      try {
        const routing = peekFrameRouting(data);
        tag = routing.tag;
        transferId = routing.transferId;
      } catch {
        return; // not a valid blob frame: drop silently
      }

      if (tag === FrameType.Header) {
        // The HEADER establishes (or refreshes) the transfer's SENDER. A second
        // HEADER for the same transferId from a DIFFERENT conn is a hijack attempt
        // — ignore it (the original sender stays bound). A retransmit from the same
        // sender (reconnect) is fine.
        const existing = transfers.get(transferId);
        if (existing === undefined) {
          // §D11 per-conn in-flight cap — counted live from the transfer map so a
          // receiver's terminal COMPLETE (processed in the receiver's handler)
          // correctly frees the sender's budget too.
          if (this.countOriginated(transfers, ws) >= MAX_INFLIGHT_PER_CONN) {
            drop();
            return;
          }
          transfers.set(transferId, { sender: ws, receiver: undefined });
        } else if (existing.sender !== ws) {
          return; // a different conn cannot seize an existing transferId
        }
        // Forward the HEADER toward the OTHER peers (the prospective receiver).
        this.forwardToOthers(ws, peers, data);
        return;
      }

      if (tag === FrameType.Data) {
        // DATA may come only from the transfer's SENDER; forward toward receivers.
        const t = transfers.get(transferId);
        if (t === undefined || t.sender !== ws) return; // unknown / not the sender
        this.forwardToOthers(ws, peers, data);
        return;
      }

      // Control frames: ACK / ABORT / COMPLETE — route back to the SENDER only.
      const t = transfers.get(transferId);
      if (t === undefined) return; // no such transfer
      if (ws === t.sender) {
        // The sender can send a control frame too (e.g. an ABORT to tear down).
        // Forward it toward the bound receiver (or all others if not yet bound).
        if (t.receiver !== undefined) this.forwardTo(t.receiver, data);
        else this.forwardToOthers(ws, peers, data);
        if (tag === FrameType.Abort) transfers.delete(transferId);
        return;
      }
      // A control frame from a NON-sender conn. Bind the receiver on first sight;
      // thereafter only the bound receiver's control frames are honored (§A4/§B6).
      if (t.receiver === undefined) t.receiver = ws;
      if (ws !== t.receiver) return; // a 3rd peer can't inject control frames
      // Route to the sender. On a terminal frame (ABORT/COMPLETE) free the transfer.
      this.forwardTo(t.sender, data);
      if (tag === FrameType.Abort || tag === FrameType.Complete) {
        transfers.delete(transferId);
      }
    });

    ws.addEventListener("close", () => {
      peers.delete(ws);
      // Free transfers this conn was part of so the maps don't leak (§B7). A
      // transfer whose sender OR receiver drops is removed; the surviving peer's
      // client fails it closed via idle-timeout.
      for (const [id, t] of [...transfers]) {
        if (t.sender === ws || t.receiver === ws) transfers.delete(id);
      }
      if (peers.size === 0 && this.rooms.get(room) === blobRoom) {
        this.rooms.delete(room);
      }
    });

    return true;
  }

  /** Forward `data` to every OTHER peer, applying backpressure (§D12). */
  private forwardToOthers(from: WebSocket, peers: Set<WebSocket>, data: Uint8Array): void {
    for (const peer of peers) {
      if (peer === from) continue;
      this.forwardTo(peer, data);
    }
  }

  /** Send `data` to one peer; terminate it if its outbound buffer is overfull. */
  private forwardTo(peer: WebSocket, data: Uint8Array): void {
    if (peer.readyState !== 1 /* OPEN */) return;
    // Backpressure (§D12): a peer whose outbound buffer is already overfull is too
    // slow — terminate it rather than buffer unboundedly. Its transfers fail
    // closed and its client reconnects.
    if (bufferedAmount(peer) > MAX_PEER_BUFFERED_BYTES) {
      try {
        peer.terminate();
      } catch {
        /* best-effort */
      }
      return;
    }
    try {
      peer.send(data);
    } catch {
      /* a peer that fails a send is dropped by its own close handler */
    }
  }

  private countOriginated(transfers: Map<string, Transfer>, ws: WebSocket): number {
    let n = 0;
    for (const t of transfers.values()) if (t.sender === ws) n += 1;
    return n;
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* closing is best-effort */
    }
  }

  closeAll(): void {
    for (const room of this.rooms.values()) {
      for (const ws of room.conns) {
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
      }
    }
    this.rooms.clear();
  }
}
