import { describe, it, expect } from "vitest";
import type { Author } from "@galley/shared";
import {
  CollabDocument,
  CollabConnection,
  InMemoryNetwork,
  applyAgentEdits,
  type Presence,
  type Transport,
} from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const HUMAN2: Author = { kind: "human", userId: "u2" };
const AGENT: Author = { kind: "agent", runId: "r1" };

/** A transport wrapper that counts frames sent + received (for echo assertions). */
function counting(inner: Transport): Transport & { sent: number; received: number } {
  const w = {
    sent: 0,
    received: 0,
    send: (data: Uint8Array) => {
      w.sent += 1;
      inner.send(data);
    },
    onMessage: (handler: (data: Uint8Array) => void) =>
      inner.onMessage((data) => {
        w.received += 1;
        handler(data);
      }),
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
  };
  return w;
}

describe("CollabConnection — sync over a Transport", () => {
  it("seeds a fresh peer through the sync handshake", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("= Title\nbody\n");
    const b = new CollabDocument(); // empty
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());

    connA.connect();
    connB.connect(); // B's step1 -> A replies step2 -> B converges on A

    expect(b.getSource()).toBe("= Title\nbody\n");
    connA.destroy();
    connB.destroy();
  });

  it("propagates live edits between connected peers (both directions)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("hello world\n");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();

    a.transact((t) => t.insert(t.length, "from A\n"), HUMAN);
    b.transact((t) => t.insert(0, "from B\n"), HUMAN2);

    expect(a.getSource()).toBe(b.getSource());
    expect(a.getSource()).toContain("from A");
    expect(a.getSource()).toContain("from B");
    connA.destroy();
    connB.destroy();
  });

  it("merges a human edit and an agent edit with no clobber (agent as a peer)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("Hello world\nGoodbye world\n");
    const human = new CollabDocument();
    const agent = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connHuman = new CollabConnection(human, net.endpoint(), { author: HUMAN2 });
    const connAgent = new CollabConnection(agent, net.endpoint(), { author: AGENT });
    connA.connect();
    connHuman.connect();
    connAgent.connect();

    // A human types on one peer; the agent applies its edit blocks on its own peer.
    human.transact((t) => t.insert(t.length, "Added by a human.\n"), HUMAN2);
    const r = applyAgentEdits(agent, [{ search: "Hello", replace: "Hi" }], AGENT);
    expect(r.ok).toBe(true);

    // All three peers converge to the SAME text containing BOTH edits.
    expect(a.getSource()).toBe(human.getSource());
    expect(a.getSource()).toBe(agent.getSource());
    expect(a.getSource()).toContain("Hi world");
    expect(a.getSource()).toContain("Added by a human.");
    connA.destroy();
    connHuman.destroy();
    connAgent.destroy();
  });

  it("lets a late-joining peer catch up via the handshake", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("base\n");
    const connA = new CollabConnection(a, net.endpoint());
    connA.connect();

    // A edits while alone (broadcasts to nobody)...
    a.transact((t) => t.insert(t.length, "edit-1\n"), HUMAN);
    applyAgentEdits(a, [{ search: "base", replace: "BASE" }], AGENT);

    // ...then B joins and must catch up to the full current state.
    const b = new CollabDocument();
    const connB = new CollabConnection(b, net.endpoint());
    connB.connect();

    expect(b.getSource()).toBe(a.getSource());
    expect(b.getSource()).toContain("BASE");
    expect(b.getSource()).toContain("edit-1");
    connA.destroy();
    connB.destroy();
  });
});

describe("CollabConnection — awareness / presence", () => {
  it("announces presence on connect and removes it on disconnect", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("x");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connB = new CollabConnection(b, net.endpoint(), { author: AGENT });
    connA.connect();
    connB.connect();

    // Each peer sees BOTH presences (its own + the other's, via query-awareness).
    const kinds = (c: CollabConnection) => c.presences().map((p) => p.author.kind).sort();
    expect(kinds(connA)).toEqual(["agent", "human"]);
    expect(kinds(connB)).toEqual(["agent", "human"]);

    // B leaves -> A drops B's presence deterministically (no 30s timeout).
    connB.disconnect();
    expect(connA.presences().map((p) => p.author.kind)).toEqual(["human"]);
    connA.destroy();
    connB.destroy();
  });

  it("surfaces the agent as a live { kind: 'agent' } peer", () => {
    const net = new InMemoryNetwork();
    const human = new CollabDocument("doc");
    const agent = new CollabDocument();
    const connHuman = new CollabConnection(human, net.endpoint(), { author: HUMAN });
    const connAgent = new CollabConnection(agent, net.endpoint(), { author: AGENT });
    connHuman.connect();
    connAgent.connect();

    const agentPeer = connHuman.presences().find((p) => p.author.kind === "agent");
    expect(agentPeer).toBeDefined();
    expect((agentPeer!.author as { kind: "agent"; runId: string }).runId).toBe("r1");
    connHuman.destroy();
    connAgent.destroy();
  });

  it("advertises and clears focusedThreadId for the 'N viewing' cue (L6)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("doc");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connB = new CollabConnection(b, net.endpoint(), { author: AGENT });
    connA.connect();
    connB.connect();

    // Both peers open thread "t1": each sees two peers focused on it.
    connA.setLocalFocusedThread("t1");
    connB.setLocalFocusedThread("t1");
    const focusedOn = (c: CollabConnection, id: string) =>
      c.presences().filter((p) => p.focusedThreadId === id).length;
    expect(focusedOn(connA, "t1")).toBe(2);
    expect(focusedOn(connB, "t1")).toBe(2);

    // A closes its card → the key is dropped (not left as undefined), and the role
    // it was carrying survives.
    connA.setLocalFocusedThread(null);
    const aPresence = connB.presences().find((p) => p.author.kind === "human");
    expect(aPresence).toBeDefined();
    expect("focusedThreadId" in aPresence!).toBe(false);
    expect(focusedOn(connB, "t1")).toBe(1);

    connA.destroy();
    connB.destroy();
  });

  it("setLocalFocusedThread is a no-op with no advertised presence", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("doc");
    const conn = new CollabConnection(a, net.endpoint());
    conn.connect();
    // No presence was passed → nothing to spread onto; must not throw or invent one.
    expect(() => conn.setLocalFocusedThread("t1")).not.toThrow();
    expect(conn.presences()).toEqual([]);
    conn.destroy();
  });
});

describe("CollabConnection — reconnect, seeding & lifecycle (review hardening)", () => {
  it("reconciles BOTH directions when two peers diverge offline and reconnect", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("shared\n");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    expect(b.getSource()).toBe("shared\n"); // initial sync

    // Both go offline and edit disjoint regions.
    connA.disconnect();
    connB.disconnect();
    a.transact((t) => t.insert(t.length, "from-A\n"), HUMAN);
    b.transact((t) => t.insert(0, "from-B\n"), HUMAN2);

    // Reconnect: the symmetric handshake must merge BOTH peers' offline edits.
    connA.connect();
    connB.connect();

    expect(a.getSource()).toBe(b.getSource());
    expect(a.getSource()).toContain("from-A");
    expect(a.getSource()).toContain("from-B");
    connA.destroy();
    connB.destroy();
  });

  it("seeds exactly one peer; empty joiners converge with no duplication", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("only-seed-once\n"); // the single creator
    const b = new CollabDocument(); // joiners start EMPTY
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    expect(b.getSource()).toBe("only-seed-once\n");
    expect(a.getSource()).toBe("only-seed-once\n");
    connA.destroy();
    connB.destroy();
  });

  it("documents the footgun: independently seeding the SAME text duplicates it", () => {
    // Locked as executable documentation of why CollabDocument is seeded ONCE
    // (one creator) and every other peer joins empty: two independent inserts
    // are distinct CRDT items, so a naive merge concatenates them.
    const net = new InMemoryNetwork();
    const a = new CollabDocument("dup");
    const b = new CollabDocument("dup"); // WRONG: both seeded independently
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    expect(a.getSource()).toBe("dupdup");
    connA.destroy();
    connB.destroy();
  });

  it("preserves its own presence across a reconnect", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("x");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connB = new CollabConnection(b, net.endpoint(), { author: AGENT });
    connA.connect();
    connB.connect();
    connB.disconnect();
    connB.connect(); // must re-announce AGENT presence without a manual setPresence

    expect(connA.presences().map((p) => p.author.kind).sort()).toEqual(["agent", "human"]);
    connA.destroy();
    connB.destroy();
  });

  it("drops stale remote presence locally when it disconnects", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("x");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connB = new CollabConnection(b, net.endpoint(), { author: AGENT });
    connA.connect();
    connB.connect();
    expect(connA.presences()).toHaveLength(2);

    connA.disconnect(); // offline: A should not keep showing B (it can't hear B leave)
    expect(connA.presences()).toHaveLength(0);
    connA.destroy();
    connB.destroy();
  });

  it("never advertises an author-less peer when no presence is given", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("x");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint(), { author: HUMAN });
    const connB = new CollabConnection(b, net.endpoint()); // no presence
    connA.connect();
    connB.connect();
    // A sees only itself — B's connection has no well-formed presence.
    expect(connA.presences().map((p) => p.author.kind)).toEqual(["human"]);
    connA.destroy();
    connB.destroy();
  });

  it("drains every top-level message in a batched frame", () => {
    // A real server may pack several messages into one frame; the reader loops.
    const s = new CollabDocument("base\n");
    const base = s.encodeState();
    const frames: Uint8Array[] = [];
    const recorder: Transport = {
      send: (d) => frames.push(d),
      onMessage: () => () => {},
      connect: () => {},
      disconnect: () => {},
    };
    const connS = new CollabConnection(s, recorder);
    connS.connect();
    frames.length = 0; // drop handshake frames
    s.transact((t) => t.insert(t.length, "X\n"), HUMAN);
    s.transact((t) => t.insert(t.length, "Y\n"), HUMAN);
    expect(frames).toHaveLength(2);
    const batched = new Uint8Array(frames[0]!.length + frames[1]!.length);
    batched.set(frames[0]!, 0);
    batched.set(frames[1]!, frames[0]!.length);

    const target = new CollabDocument();
    target.applyUpdate(base); // share S's base lineage
    let deliver: ((d: Uint8Array) => void) | undefined;
    const inbound: Transport = {
      send: () => {},
      onMessage: (h) => {
        deliver = h;
        return () => {};
      },
      connect: () => {},
      disconnect: () => {},
    };
    const connT = new CollabConnection(target, inbound);
    connT.connect();
    deliver!(batched); // one frame, two messages

    expect(target.getSource()).toBe("base\nX\nY\n");
    connS.destroy();
    connT.destroy();
  });
});

describe("CollabConnection — echo control & origin semantics", () => {
  it("does not echo: a single edit yields a bounded message exchange", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("seed\n");
    const b = new CollabDocument();
    const ta = counting(net.endpoint());
    const tb = counting(net.endpoint());
    const connA = new CollabConnection(a, ta);
    const connB = new CollabConnection(b, tb);
    connA.connect();
    connB.connect();

    // Settle the handshake, then measure ONE edit.
    const beforeA = ta.sent;
    const beforeB = tb.sent;
    a.transact((t) => t.insert(t.length, "one\n"), HUMAN);

    // A emits exactly one update frame; B applies it and does NOT echo back.
    expect(ta.sent - beforeA).toBe(1);
    expect(tb.sent - beforeB).toBe(0);
    expect(b.getSource()).toBe(a.getSource());
    connA.destroy();
    connB.destroy();
  });

  it("applies remote updates with a local-only origin (attribution does not cross the wire)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("seed\n");
    const b = new CollabDocument();
    const connB = new CollabConnection(b, net.endpoint());
    const connA = new CollabConnection(a, net.endpoint());
    connA.connect();
    connB.connect();

    const origins: unknown[] = [];
    b.doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));

    // Author-tag the edit on A; the receiver B must NOT see that author origin.
    applyAgentEdits(a, [{ search: "seed", replace: "SEED" }], { kind: "agent", runId: "r9" });

    expect(b.getSource()).toBe("SEED\n");
    expect(origins.length).toBeGreaterThan(0);
    // Origin on the receiver is the connection object, never the wire-crossing
    // author string "agent:r9" — Yjs updates don't encode origin.
    for (const o of origins) {
      expect(o).not.toBe("agent:r9");
      expect(o).toBe(connB);
    }
    connA.destroy();
    connB.destroy();
  });
});

describe("CollabConnection — initial-sync (`synced`) signal", () => {
  it("flips synced once the peer's initial state (first step2) is applied", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("= Host\nshared body\n");
    const b = new CollabDocument(); // a fresh joiner: empty doc
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();

    expect(connB.synced).toBe(false); // not connected yet → not loaded
    let fired = 0;
    connB.onSynced(() => (fired += 1));

    connB.connect(); // B's step1 → A replies step2 → B applies it
    expect(connB.synced).toBe(true);
    expect(b.getSource()).toBe("= Host\nshared body\n"); // really did load
    expect(fired).toBe(1);

    connA.destroy();
    connB.destroy();
  });

  it("resolves synced even for an EMPTY room (a step2 still arrives)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument(); // empty host
    const b = new CollabDocument(); // empty joiner
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    // Empty doc still produces a step2 reply, so a joiner to an empty room is not
    // left stuck "syncing" forever.
    expect(connB.synced).toBe(true);
    connA.destroy();
    connB.destroy();
  });

  it("a late onSynced subscriber fires immediately, exactly once (sticky)", () => {
    const net = new InMemoryNetwork();
    const a = new CollabDocument("x\n");
    const b = new CollabDocument();
    const connA = new CollabConnection(a, net.endpoint());
    const connB = new CollabConnection(b, net.endpoint());
    connA.connect();
    connB.connect();
    expect(connB.synced).toBe(true);

    let late = 0;
    connB.onSynced(() => (late += 1));
    expect(late).toBe(1); // already-synced → invoked immediately

    // Further edits (more step2/update traffic) must NOT re-fire it.
    a.transact((t) => t.insert(t.length, "more\n"), HUMAN);
    expect(late).toBe(1);

    connA.destroy();
    connB.destroy();
  });
});
