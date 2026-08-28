/**
 * #22.2 sync-relay adversarial audit — property/fuzz harnesses.
 *
 * These drive a REAL relay (the same `startSyncServer` the app runs) with hostile
 * peers and pin the fail-safe invariants the audit relies on, plus the two new
 * default-OFF hardenings (Origin allowlist + per-connection message-rate cap).
 *
 * Deterministic + fast: caps are tripped with a small-but-over-limit case (a single
 * over-cap frame, a short burst just past the rate ceiling), never a multi-second
 * real flood. We assert the SERVER's reaction (connection terminated / room reaped /
 * upgrade refused), which is observable over the wire.
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocket as WS } from "ws";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { startSyncServer } from "./index.js";

const settle = { timeout: 4000, interval: 20 };

/** Open a raw ws to a room and await the socket OPEN (optionally with headers). */
async function openRaw(
  port: number,
  room: string,
  opts?: { headers?: Record<string, string> },
): Promise<WS> {
  const ws = new WS(`ws://127.0.0.1:${port}/${room}`, opts);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  // After open, swallow client-side socket errors (a server-forced close on an
  // over-cap/malformed frame can surface as 'error' then 'close') so they don't
  // become an unhandled rejection in the test process.
  ws.removeAllListeners("error");
  ws.on("error", () => {
    /* expected on hostile-frame tests; the close handler carries the verdict */
  });
  return ws;
}

/** Connect and resolve { opened, code }: opened iff the initial sync frame arrives. */
function connectOutcome(
  port: number,
  room: string,
  opts?: { headers?: Record<string, string> },
): Promise<{ opened: boolean; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/${room}`, opts);
    let opened = false;
    ws.on("message", () => {
      opened = true;
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

describe("#22.2 sync relay — DoS / isolation fail-safes hold", () => {
  it("distinct ws paths map to distinct, separately-accounted rooms (no merge, no leak)", async () => {
    // MAX_ROOMS (10_000) is a hard module constant — too large to exhaust in a fast
    // unit test — so the ceiling itself is pinned by code review + the over-cap
    // guard in `proceed()`. Here we pin the accounting it protects: distinct ws
    // paths must allocate distinct Room entries (the per-room Y.Doc isolation the
    // cap and the cross-room leak test both depend on), counted exactly.
    const server = await startSyncServer(0);
    try {
      // Open 3 distinct rooms; the relay must track exactly 3 (no leak, no merge).
      const a = await openRaw(server.port, "iso-a");
      const b = await openRaw(server.port, "iso-b");
      const c = await openRaw(server.port, "iso-c");
      await vi.waitFor(() => expect(server.roomCount()).toBe(3), settle);
      a.close();
      b.close();
      c.close();
    } finally {
      await server.close();
    }
  });

  it("an over-cap single ws frame is rejected by the 8 MiB payload limit (no crash)", async () => {
    const server = await startSyncServer(0);
    try {
      const ws = await openRaw(server.port, "fat-frame");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // A single frame just past MAX_WS_PAYLOAD_BYTES (8 MiB). `ws` enforces
      // maxPayload server-side and closes the offending connection (1009 = too big)
      // WITHOUT delivering it to our handler — the relay never allocates the payload
      // into a doc. We assert the connection is dropped and the room is reaped.
      const over = new Uint8Array(8 * 1024 * 1024 + 16);
      const closed = new Promise<number>((resolve) => ws.on("close", (code: number) => resolve(code)));
      ws.send(over);
      const code = await closed;
      expect(code).toBe(1009); // RFC 6455 "message too big"
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
    } finally {
      await server.close();
    }
  });

  it("an awareness frame over the per-frame id cap terminates the connection", async () => {
    const server = await startSyncServer(0);
    try {
      const ws = await openRaw(server.port, "aware-overcap");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // 65 ids — one past MAX_AWARENESS_CLIENTS_PER_FRAME (64). The server reads the
      // declared count and terminates BEFORE applying (close handler reaps the room).
      const aw = new Awareness(new Y.Doc());
      const ids: number[] = [];
      for (let i = 1; i <= 65; i++) {
        ids.push(i);
        aw.states.set(i, { user: i });
        aw.meta.set(i, { clock: 1, lastUpdated: 0 });
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1 /* messageAwareness */);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(aw, ids));
      ws.send(encoding.toUint8Array(enc));

      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
      aw.destroy();
      try {
        ws.close();
      } catch {
        /* server may have already closed it */
      }
    } finally {
      await server.close();
    }
  });

  it("a denied auth upgrade gets 1008 and never receives a data frame", async () => {
    const server = await startSyncServer(0, { authorizeUpgrade: ({ room }) => room === "ok" });
    try {
      const denied = await connectOutcome(server.port, "secret");
      expect(denied.opened).toBe(false); // no initial sync frame ever arrived
      expect(denied.code).toBe(1008);
      // The denied connection created no room.
      expect(server.roomCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("MALFORMED frames are dropped, not crash the relay (#22.2 S5 — uncaught-exception DoS)", async () => {
    const server = await startSyncServer(0);
    try {
      const ws = await openRaw(server.port, "garbage");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // Frames that make the lib0 decoder THROW ("Unexpected end of array") if the
      // parse loop is unguarded: a sync frame with no body, an awareness type with a
      // truncated body, plus an unknown type and an empty frame. Before the #22.2
      // try/catch hardening these threw OUT of the message listener — an uncaught
      // exception that crashes the whole relay process from a SINGLE hostile frame.
      // Now each malformed frame is dropped and the connection stays alive.
      ws.send(new Uint8Array([99])); // unknown type 99 → bail out of frame
      ws.send(new Uint8Array([0])); // messageSync with no body → decoder throws
      ws.send(new Uint8Array([])); // empty frame → no content, no-op
      ws.send(new Uint8Array([1, 0xff])); // awareness type then a dangling byte → throws
      ws.send(new Uint8Array([0, 2, 0xff, 0xff])); // sync-update, garbage update → throws

      // Still alive: open a second peer and confirm the room is intact (relay
      // survived the garbage; the process did not crash).
      const ws2 = await openRaw(server.port, "garbage");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);
      expect(ws.readyState).toBe(WS.OPEN);
      ws.close();
      ws2.close();
    } finally {
      await server.close();
    }
  });

  it("cross-room writes do not leak: a peer in room X never sees room Y's doc", async () => {
    const server = await startSyncServer(0);
    try {
      // Seed room X with a Y.Doc update, then connect a peer to room Y and assert it
      // only ever receives room Y's (empty) initial sync — never X's content.
      const docX = new Y.Doc();
      docX.getText("t").insert(0, "SECRET-X");
      const updateX = Y.encodeStateAsUpdate(docX);

      const xWs = await openRaw(server.port, "roomX");
      const encX = encoding.createEncoder();
      encoding.writeVarUint(encX, 0 /* messageSync */);
      // sync step2 (update) message: type 2 then the update bytes.
      encoding.writeVarUint(encX, 2);
      encoding.writeVarUint8Array(encX, updateX);
      xWs.send(encoding.toUint8Array(encX));

      const yFrames: Uint8Array[] = [];
      const yWs = new WS(`ws://127.0.0.1:${server.port}/roomY`);
      yWs.binaryType = "arraybuffer";
      yWs.on("message", (d: ArrayBuffer) => yFrames.push(new Uint8Array(d)));
      await new Promise<void>((res, rej) => {
        yWs.on("open", () => res());
        yWs.on("error", rej);
      });

      // Give the relay time to (incorrectly, if buggy) cross-deliver.
      await new Promise((r) => setTimeout(r, 300));
      const all = Buffer.concat(yFrames.map((u) => Buffer.from(u)));
      expect(all.includes(Buffer.from("SECRET-X"))).toBe(false);

      xWs.close();
      yWs.close();
    } finally {
      await server.close();
    }
  });
});

describe("#22.2 hardening A — Origin allowlist (default OFF)", () => {
  it("UNSET allowlist: behavior unchanged — any/absent Origin connects", async () => {
    // No allowedOrigins → the check is OFF; a native ws client (no Origin header)
    // and a browser-like Origin both connect and get the initial sync frame.
    const server = await startSyncServer(0);
    try {
      const noOrigin = await connectOutcome(server.port, "open");
      expect(noOrigin.opened).toBe(true);
      const withOrigin = await connectOutcome(server.port, "open", {
        headers: { origin: "https://evil.example" },
      });
      expect(withOrigin.opened).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("SET allowlist: a matching Origin is allowed", async () => {
    const server = await startSyncServer(0, { allowedOrigins: ["https://app.galley.test"] });
    try {
      const ok = await connectOutcome(server.port, "room", {
        headers: { origin: "https://app.galley.test" },
      });
      expect(ok.opened).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("SET allowlist: a mismatched Origin is rejected (1008, no data, no room)", async () => {
    const server = await startSyncServer(0, { allowedOrigins: ["https://app.galley.test"] });
    try {
      const bad = await connectOutcome(server.port, "room", {
        headers: { origin: "https://evil.example" },
      });
      expect(bad.opened).toBe(false);
      expect(bad.code).toBe(1008);
      expect(server.roomCount()).toBe(0); // never joined a room
    } finally {
      await server.close();
    }
  });

  it("SET allowlist: an ABSENT Origin is rejected (fail-closed)", async () => {
    // A configured allowlist denies anything it does not list, including a request
    // with no Origin header at all — a cross-site attacker can't simply omit it.
    const server = await startSyncServer(0, { allowedOrigins: ["https://app.galley.test"] });
    try {
      const absent = await connectOutcome(server.port, "room"); // no headers
      expect(absent.opened).toBe(false);
      expect(absent.code).toBe(1008);
      expect(server.roomCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("Origin check runs BEFORE the auth gate (a forbidden origin is refused even for an allowed room)", async () => {
    const server = await startSyncServer(0, {
      allowedOrigins: ["https://app.galley.test"],
      authorizeUpgrade: () => true, // auth would allow everyone…
    });
    try {
      const bad = await connectOutcome(server.port, "ok", {
        headers: { origin: "https://evil.example" },
      });
      expect(bad.opened).toBe(false); // …but the Origin check refuses first
      expect(bad.code).toBe(1008);
    } finally {
      await server.close();
    }
  });
});

describe("#22.2 hardening B — per-connection message-rate cap (generous default)", () => {
  it("a burst over the cap terminates the connection; the room is reaped", async () => {
    const server = await startSyncServer(0);
    try {
      const ws = await openRaw(server.port, "flood");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // Send well past MAX_MESSAGES_PER_WINDOW (2000) tiny frames synchronously in
      // one tick — they land inside a single rate window, so the counter trips and
      // the server terminates the socket. We use empty frames (cheap, parsed as a
      // no-op) so the cost is the rate-limit accounting, not the payload.
      const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
      // Empty frames: hasContent() is false so the parse loop is a no-op — this
      // isolates the RATE accounting (which still counts every message) from frame
      // parsing, so the test pins the rate cap and nothing else.
      for (let i = 0; i < 2100; i++) ws.send(new Uint8Array([]));

      await closed; // connection dropped by the rate cap
      await vi.waitFor(() => expect(server.roomCount()).toBe(0), settle);
    } finally {
      await server.close();
    }
  });

  it("normal two-peer traffic stays well under the cap and is unaffected", async () => {
    // A handful of frames per peer — orders of magnitude below the ceiling — must
    // sync cleanly. (The existing sync-server.test.ts exercises the full CollabDoc
    // path; here we just assert a modest raw burst never trips the cap.)
    const server = await startSyncServer(0);
    try {
      const a = await openRaw(server.port, "normal");
      await vi.waitFor(() => expect(server.roomCount()).toBe(1), settle);

      // 50 frames — far under 2000/s; the connection must stay open.
      let stillOpen = true;
      a.on("close", () => {
        stillOpen = false;
      });
      for (let i = 0; i < 50; i++) a.send(new Uint8Array([]));
      await new Promise((r) => setTimeout(r, 200));
      expect(stillOpen).toBe(true);
      expect(a.readyState).toBe(WS.OPEN);
      expect(server.roomCount()).toBe(1);
      a.close();
    } finally {
      await server.close();
    }
  });
});
