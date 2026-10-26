/** Point-to-point hosted storage. Never joins the peer relay or signs peer MACs. */
import type { WebSocket } from "ws";
import {
  BLOB_MAX_TRANSFER_BYTES,
  BlobTransport,
  decodeFrame,
  encodeFrame,
  type WebSocketLike,
} from "@galley/collab";
import type { HostedStorage } from "@galley/shared";
export const HOSTED_BLOB_SUBPROTOCOL = "galley-hosted-blob-v1";
const MAX_BUFFERED = 128 * 1024 * 1024;
export class HostedBlobHandler {
  private readonly rooms = new Map<string, Set<() => void>>();
  private buffered = 0;
  private connections = 0;
  private transfers = 0;
  private readonly idleWaiters = new Set<() => void>();
  whenIdle(): Promise<void> {
    if (this.transfers === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
  private settled(): void {
    this.transfers--;
    if (this.transfers === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }
  constructor(private readonly store: HostedStorage) {}
  handleConnection(
    ws: WebSocket,
    room: string,
    authorize: () => Promise<boolean> = async () => true,
  ): void {
    if (this.connections >= 128 || (this.rooms.get(room)?.size ?? 0) >= 16) {
      ws.close(1013, "Hosted storage busy");
      return;
    }
    this.connections++;
    const cleanups = this.rooms.get(room) ?? new Set<() => void>();
    this.rooms.set(room, cleanups);
    const inbound = new Map<
      string,
      { size: number; chunks: number; seen: Set<number>; finishing: boolean }
    >();
    const outbound = new Map<string, number>();
    let closed = false,
      windowStart = Date.now(),
      messages = 0,
      bytes = 0;
    const listeners = new Map<(e: unknown) => void, (e: unknown) => void>();
    const release = (id: string): void => {
      const n = inbound.get(id);
      if (n !== undefined) {
        this.buffered -= n.size;
        inbound.delete(id);
        this.settled();
      }
    };
    const adapter: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      binaryType: "arraybuffer",
      send: (data) => {
        const f = decodeFrame(data);
        if (f.kind === "complete" || f.kind === "abort") release(f.transferId);
        if (closed || ws.bufferedAmount > 4 * 1024 * 1024) {
          ws.terminate();
          return;
        }
        ws.send(data);
      },
      close: () => ws.close(),
      addEventListener: (type, listener) => {
        if (type !== "message") {
          ws.addEventListener(type as "close", listener);
          return;
        }
        const wrapped = (e: unknown): void => {
          if (closed) return;
          const raw = (e as { data: unknown }).data;
          if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) {
            ws.terminate();
            return;
          }
          const data =
            raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          if (Date.now() - windowStart >= 1000) {
            windowStart = Date.now();
            messages = 0;
            bytes = 0;
          }
          if (
            ++messages > 2000 ||
            (bytes += data.byteLength) > 128 * 1024 * 1024
          ) {
            ws.terminate();
            return;
          }
          let frame;
          try {
            frame = decodeFrame(data);
          } catch {
            ws.terminate();
            return;
          }
          // Async verification/storage owns the completed id until its terminal frame.
          // Reusing it cannot start a second uncharged reassembly.
          if (
            (frame.kind === "header" || frame.kind === "data") &&
            inbound.get(frame.transferId)?.finishing
          )
            return;
          if (frame.kind === "header" && !inbound.has(frame.transferId)) {
            if (
              inbound.size >= 2 ||
              this.buffered + frame.size > MAX_BUFFERED
            ) {
              ws.send(
                encodeFrame({
                  kind: "abort",
                  transferId: frame.transferId,
                  reason: "Hosted storage busy",
                }),
              );
              return;
            }
            inbound.set(frame.transferId, {
              size: frame.size,
              chunks: frame.totalChunks,
              seen: new Set(),
              finishing: frame.totalChunks === 0,
            });
            this.buffered += frame.size;
            this.transfers++;
          }
          if (frame.kind === "data") {
            const held = inbound.get(frame.transferId);
            if (held && frame.index < held.chunks) {
              held.seen.add(frame.index);
              if (held.seen.size === held.chunks) held.finishing = true;
            }
          }
          if (
            frame.kind === "abort" &&
            !inbound.get(frame.transferId)?.finishing
          )
            release(frame.transferId);
          listener({ data });
        };
        listeners.set(listener, wrapped);
        ws.addEventListener("message", wrapped);
      },
      removeEventListener: (type, listener) => {
        const wrapped = listeners.get(listener) ?? listener;
        ws.removeEventListener(type as "message", wrapped);
        listeners.delete(listener);
      },
    };
    const transport = new BlobTransport(() => adapter, {
      reconnect: false,
      requireExpectation: false,
      onReceiveSettled: release,
      maxInflightReceives: 2,
      maxExpectedBytes: MAX_BUFFERED,
      onBlob: async (blob) => {
        const allowed = await authorize();
        if (closed || !allowed) throw new Error("Room access revoked");
        await this.store.putAsset(room, blob.hash, blob.bytes);
      },
      onRequest: (request) => {
        if (
          outbound.has(request.transferId) ||
          outbound.size >= 2 ||
          this.buffered + BLOB_MAX_TRANSFER_BYTES > MAX_BUFFERED
        )
          return;
        // The requested size is untrusted until the stored bytes are read.
        // Charge a full transfer before materializing them, including mismatches.
        outbound.set(request.transferId, BLOB_MAX_TRANSFER_BYTES);
        this.buffered += BLOB_MAX_TRANSFER_BYTES;
        this.transfers++;
        void (async () => {
          const allowed = await authorize();
          if (closed || !allowed) return;
          const data = await this.store.getAsset(room, request.hash);
          if (!closed && data && data.byteLength === request.size)
            await transport.send(
              data,
              request.hash,
              "application/octet-stream",
              { transferId: request.transferId },
            ).done;
        })()
          .catch(() => undefined)
          .finally(() => {
            const n = outbound.get(request.transferId);
            if (n !== undefined) {
              this.buffered -= n;
              outbound.delete(request.transferId);
              this.settled();
            }
          });
      },
    });
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      // Completed reassemblies still hashing/storing retain their process reservation
      // until terminal publication. Reads also release only in their async finally.
      for (const [id, held] of inbound) if (!held.finishing) release(id);
      transport.disconnect();
      ws.terminate();
      this.connections--;
      cleanups.delete(cleanup);
      if (cleanups.size === 0) this.rooms.delete(room);
    };
    cleanups.add(cleanup);
    ws.once("close", cleanup);
    ws.on("error", cleanup);
    transport.connect();
    // A silent/incomplete upload cannot retain the global memory reservation forever.
    const timer = setInterval(() => {
      if (inbound.size) ws.terminate();
    }, 60000);
    timer.unref();
    ws.once("close", () => clearInterval(timer));
  }
  closeRoom(room: string): void {
    for (const close of [...(this.rooms.get(room) ?? [])]) close();
  }
  closeAll(): void {
    for (const room of [...this.rooms.keys()]) this.closeRoom(room);
  }
}
