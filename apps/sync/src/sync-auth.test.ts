/**
 * Roadmap #4 slice 5: the sync server's upgrade-authorization gate (default OFF).
 * Over a real `ws` socket: an approved room connects (receives the initial sync
 * frame); a denied room is closed with 1008 before any doc data; the gate fails
 * closed on a throw; async gates work. The existing open-room tests prove the
 * default (no gate) path is unchanged.
 */
import { describe, it, expect } from "vitest";
import { WebSocket as WS } from "ws";
import { startSyncServer } from "./index.js";

interface Outcome {
  opened: boolean;
  code?: number;
}

function connectOutcome(port: number, room: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/${room}`);
    let opened = false;
    ws.on("message", () => {
      opened = true; // an allowed connection gets the server's initial sync frame
      ws.close();
      resolve({ opened: true });
    });
    ws.on("close", (code: number) => resolve({ opened, code }));
    ws.on("error", () => {
      /* a denied upgrade can surface as error then close — handled by close */
    });
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ opened });
    }, 2000);
  });
}

describe("sync server — upgrade authorization (slice 5)", () => {
  it("allows an approved room; closes a denied room with 1008 (before any data)", async () => {
    const server = await startSyncServer(0, { authorizeUpgrade: ({ room }) => room === "ok" });
    // Keep the approved socket OPEN while we count: an emptied room is now reaped
    // (the DoS hardening), so a closed approved socket would leave 0 rooms. With it
    // held open, roomCount===1 deterministically proves the approved room is live
    // and the denied "secret" connection never created a room of its own.
    const approved = new WS(`ws://127.0.0.1:${server.port}/ok`);
    try {
      await new Promise<void>((resolve, reject) => {
        approved.on("message", () => resolve()); // initial sync frame ⇒ allowed + live
        approved.on("close", () => reject(new Error("approved connection was closed")));
        approved.on("error", reject);
      });
      const denied = await connectOutcome(server.port, "secret");
      expect(denied.opened).toBe(false);
      expect(denied.code).toBe(1008);
      // A denied connection never created the room; only the live "ok" room exists.
      expect(server.roomCount()).toBe(1);
    } finally {
      approved.close();
      await server.close();
    }
  });

  it("fails closed (1008) when the gate throws", async () => {
    const server = await startSyncServer(0, {
      authorizeUpgrade: () => {
        throw new Error("boom");
      },
    });
    try {
      const res = await connectOutcome(server.port, "any");
      expect(res.opened).toBe(false);
      expect(res.code).toBe(1008);
    } finally {
      await server.close();
    }
  });

  it("supports an async gate", async () => {
    const server = await startSyncServer(0, {
      authorizeUpgrade: async ({ room }) => {
        await Promise.resolve();
        return room === "ok";
      },
    });
    try {
      expect((await connectOutcome(server.port, "ok")).opened).toBe(true);
      expect((await connectOutcome(server.port, "no")).opened).toBe(false);
    } finally {
      await server.close();
    }
  });
});
