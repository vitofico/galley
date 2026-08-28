/**
 * `WebSocketTransport` — a `Transport` (ADR-0008) over an INJECTED WebSocket.
 *
 * It references only the structural `WebSocket` interface, never a network
 * library, so `@galley/collab` stays dependency-free (the same injection
 * discipline as the WASM compiler): the browser passes `() => new WebSocket(url)`
 * and a Node test passes `() => new WS(url)` from the `ws` package.
 *
 * `CollabConnection.connect()` writes its handshake synchronously, before the
 * socket is open, so sends are buffered until the `open` event and then flushed.
 *
 * RECONNECTION (2026-06-15 audit): a dropped socket used to leave the transport
 * permanently `connected` with frames piling into a dead outbox. Now `close`/
 * `error` on a non-intentional drop emit `"closed"` and schedule a reconnect with
 * capped exponential backoff; each reopened socket emits `"open"` so the consumer
 * (`CollabConnection`) re-runs its sync handshake and the doc reconciles. The
 * outbox is bounded — a re-handshake re-syncs full state, so dropping the oldest
 * buffered frames during a long outage is safe and keeps memory bounded.
 */
import type { Transport, TransportStatus } from "./transport.js";

/** The slice of the standard WebSocket API this transport needs. */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export type WebSocketFactory = () => WebSocketLike;

/** Timer seam so tests can drive backoff deterministically (no real clock). */
export interface SchedulerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Reconnect/backoff tuning. Sensible defaults; all overridable for tests. */
export interface ReconnectOptions {
  /** Reconnect on an unexpected drop. Default true. */
  enabled?: boolean;
  /** First backoff delay (ms). Default 500. */
  baseDelayMs?: number;
  /** Ceiling on the backoff delay (ms). Default 15_000. */
  maxDelayMs?: number;
  /** Backoff growth factor. Default 2. */
  factor?: number;
  /** Max buffered frames while the link is down (drop oldest past this). Default 1024. */
  maxOutboxFrames?: number;
}

const OPEN = 1; // WebSocket.OPEN

const DEFAULTS: Required<ReconnectOptions> = {
  enabled: true,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  factor: 2,
  maxOutboxFrames: 1024,
};

const defaultScheduler: SchedulerLike = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return undefined;
}

export class WebSocketTransport implements Transport {
  private socket: WebSocketLike | undefined;
  private readonly handlers = new Set<(data: Uint8Array) => void>();
  private readonly statusHandlers = new Set<(status: TransportStatus) => void>();
  private readonly outbox: Uint8Array[] = [];
  private bound:
    | {
        open: (e: unknown) => void;
        message: (e: unknown) => void;
        close: (e: unknown) => void;
        error: (e: unknown) => void;
      }
    | undefined;
  /** True between `connect()` and `disconnect()` — i.e. we WANT a live link. */
  private wantConnected = false;
  /** Pending reconnect timer handle, if any. */
  private reconnectTimer: unknown;
  /** Consecutive failed-link count, for exponential backoff. */
  private attempt = 0;
  private readonly opts: Required<ReconnectOptions>;

  constructor(
    private readonly factory: WebSocketFactory,
    options?: { reconnect?: ReconnectOptions; scheduler?: SchedulerLike },
  ) {
    this.opts = { ...DEFAULTS, ...(options?.reconnect ?? {}) };
    this.scheduler = options?.scheduler ?? defaultScheduler;
  }

  private readonly scheduler: SchedulerLike;

  send(data: Uint8Array): void {
    const socket = this.socket;
    if (socket !== undefined && socket.readyState === OPEN) socket.send(data);
    else {
      this.outbox.push(data); // buffered until 'open'
      // Bound the buffer: a reconnect re-handshakes full state, so the oldest
      // raw-update frames are redundant — drop them rather than grow unbounded.
      while (this.outbox.length > this.opts.maxOutboxFrames) this.outbox.shift();
    }
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: (status: TransportStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: TransportStatus): void {
    for (const h of [...this.statusHandlers]) h(status);
  }

  connect(): void {
    if (this.socket !== undefined) return;
    this.wantConnected = true;
    this.attempt = 0;
    this.openSocket();
  }

  /** Open (or re-open) the underlying socket and bind its lifecycle handlers. */
  private openSocket(): void {
    const socket = this.factory();
    socket.binaryType = "arraybuffer";
    const open = (): void => {
      this.attempt = 0; // a clean open resets the backoff
      for (const frame of this.outbox.splice(0)) {
        if (socket.readyState === OPEN) socket.send(frame);
      }
      this.emitStatus("open");
    };
    const message = (event: unknown): void => {
      const data = asBytes((event as { data?: unknown }).data);
      if (data !== undefined) for (const h of [...this.handlers]) h(data);
    };
    const onDrop = (): void => this.handleDrop(socket);
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("close", onDrop);
    socket.addEventListener("error", onDrop);
    this.bound = { open, message, close: onDrop, error: onDrop };
    this.socket = socket;
  }

  /**
   * A socket dropped unexpectedly (close/error). Unbind it, emit `"closed"`, and
   * schedule a backoff reconnect — unless we intentionally disconnected or
   * reconnection is disabled. Idempotent: a close after an error is ignored.
   */
  private handleDrop(socket: WebSocketLike): void {
    if (this.socket !== socket) return; // already handled / superseded
    this.unbind(socket);
    this.socket = undefined;
    this.emitStatus("closed");
    if (!this.wantConnected || !this.opts.enabled) return;
    const delay = Math.min(
      this.opts.maxDelayMs,
      this.opts.baseDelayMs * this.opts.factor ** this.attempt,
    );
    this.attempt += 1;
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.wantConnected && this.socket === undefined) this.openSocket();
    }, delay);
  }

  private unbind(socket: WebSocketLike): void {
    if (this.bound !== undefined) {
      socket.removeEventListener("open", this.bound.open);
      socket.removeEventListener("message", this.bound.message);
      socket.removeEventListener("close", this.bound.close);
      socket.removeEventListener("error", this.bound.error);
    }
    this.bound = undefined;
  }

  /**
   * L6: user-initiated "Retry now". Cancel any pending backoff timer, reset the
   * backoff, and re-open the socket immediately. No-op when we don't want a
   * connection (intentionally disconnected) or a socket already exists
   * (connecting/open) — only a DOWN link waiting on backoff is forced sooner, so
   * the button can't disturb a healthy or already-reconnecting link.
   */
  retryNow(): void {
    if (!this.wantConnected || this.socket !== undefined) return;
    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.attempt = 0;
    this.openSocket();
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer !== undefined) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.outbox.length = 0;
    if (socket === undefined) return;
    this.unbind(socket);
    this.socket = undefined;
    try {
      socket.close();
    } catch {
      // closing an already-closing socket is fine
    }
  }
}
