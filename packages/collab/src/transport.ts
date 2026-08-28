/**
 * `Transport` — the one swappable seam of the sync layer (ADR-0007). A transport
 * is a dumb, framework-agnostic byte pipe: it sends/receives opaque `Uint8Array`
 * frames and has a connect/disconnect lifecycle. `CollabConnection` speaks the
 * Yjs `y-protocols` sync + awareness messages over it; the future y-websocket
 * client implements exactly this interface and nothing else in the core knows
 * about sockets. Room / document routing lives OUTSIDE the transport (in the
 * server), not in this contract.
 */
/**
 * The transport's link lifecycle. `"open"` fires each time a live link is
 * established — the FIRST connect AND every successful reconnect; `"closed"`
 * fires when the link drops (and a reconnecting transport begins backing off).
 * Consumers use the reconnect `"open"` to re-run their protocol handshake.
 */
export type TransportStatus = "open" | "closed";

export interface Transport {
  /** Send a frame to the other peer(s). No-op while disconnected. */
  send(data: Uint8Array): void;
  /** Register an inbound-frame handler. Returns an unsubscribe function. */
  onMessage(handler: (data: Uint8Array) => void): () => void;
  /** Join the network. Idempotent. */
  connect(): void;
  /** Leave the network. Idempotent. */
  disconnect(): void;
  /**
   * OPTIONAL: observe the link lifecycle (open/closed). A transport over an
   * unreliable socket implements this so a consumer can re-handshake on
   * reconnect and surface a "disconnected" state; a stable in-process transport
   * (e.g. `InMemoryNetwork`) omits it and behaves byte-for-byte as before.
   */
  onStatus?(handler: (status: TransportStatus) => void): () => void;
  /**
   * OPTIONAL (corrections L6): force an immediate reconnect, resetting the
   * backoff — a user-initiated "Retry now" while the link is down and waiting on
   * its next scheduled attempt. A no-op when already connected/connecting or
   * intentionally disconnected. A stable in-process transport omits it.
   */
  retryNow?(): void;
}

interface Endpoint {
  connected: boolean;
  deliver(data: Uint8Array): void;
}

/**
 * `InMemoryNetwork` — a synchronous, in-process hub for offline multi-peer tests
 * (the Phase 2 analogue of Phase 1's "hand the encoded bytes over"). Each
 * `endpoint()` is a `Transport`; a frame sent on one endpoint is delivered to
 * every OTHER connected endpoint.
 *
 * Delivery drains a single shared FIFO queue: when handling a frame triggers
 * another `send` (e.g. a doc update arrives → a reply goes out), the new frame is
 * enqueued and processed by the same drain loop rather than recursing. This makes
 * the sync handshake + update propagation deterministic and recursion-free,
 * exactly what the Architect review called for.
 */
export class InMemoryNetwork {
  private readonly endpoints = new Set<Endpoint>();
  private readonly queue: { from: Endpoint; data: Uint8Array }[] = [];
  private draining = false;

  endpoint(): Transport {
    const handlers = new Set<(data: Uint8Array) => void>();
    const self: Endpoint = {
      connected: false,
      deliver: (data) => {
        for (const h of [...handlers]) h(data);
      },
    };

    const enqueue = (data: Uint8Array): void => {
      this.queue.push({ from: self, data });
      this.drain();
    };

    return {
      send: (data) => {
        if (self.connected) enqueue(data);
      },
      onMessage: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      connect: () => {
        if (self.connected) return;
        self.connected = true;
        this.endpoints.add(self);
      },
      disconnect: () => {
        if (!self.connected) return;
        self.connected = false;
        this.endpoints.delete(self);
      },
    };
  }

  private drain(): void {
    if (this.draining) return; // a frame sent mid-delivery just joins the queue
    this.draining = true;
    try {
      for (let msg = this.queue.shift(); msg !== undefined; msg = this.queue.shift()) {
        for (const e of [...this.endpoints]) {
          if (e !== msg.from && e.connected) e.deliver(msg.data);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
