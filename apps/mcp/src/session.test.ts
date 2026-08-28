import { describe, expect, it, vi } from "vitest";
import {
  deriveProposalKey,
  verifyProposal,
  type ProposalScope,
  type SignableProposal,
  type WebSocketLike,
} from "@galley/collab";
import { joinRoom, buildProposalSigner, type KernelSession } from "./session.js";

/**
 * A WebSocketLike the test drives by hand (mirrors reconnect.test.ts's FakeSocket):
 * `joinRoom` never lands a peer over it, so it exercises the liveness fields that
 * do NOT depend on remote awareness — relayConnected + the empty-room baseline.
 */
class FakeSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  binaryType = "arraybuffer";
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  send(): void {}
  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close", {});
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  /** Test driver: flip to OPEN and fire the open event the transport listens for. */
  open(): void {
    this.readyState = 1; // OPEN
    this.emit("open", {});
  }
  private emit(type: string, event: unknown): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }
}

/**
 * SEC-16.3c — the kernel's PROJECT-room socket error path must be room-id
 * scrubbed, exactly like the control room's (control.ts). The project room id is
 * a CAPABILITY (the share-<random> handoff from open_project); a failing
 * relay/socket whose error text embeds the request URL must never put it — raw
 * OR URL-encoded — into stderr/support bundles.
 *
 * Mirrors control.test.ts's "stderr never contains the control-room id" pin:
 * the DEFAULT socket factory (the runtime stderr path) against a dead relay.
 */
describe("session joinRoom — project-room capability redaction (SEC-16.3c)", () => {
  it("the default socket's error line is emitted scrubbed: no raw or URL-encoded room id", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    // A room id with a character that URL-encodes differently (the slash), so
    // the raw and encoded forms are DISTINCT strings — both must be scrubbed.
    const room = "share-secret/0123456789abcdef";
    let session: KernelSession | undefined;
    try {
      // A dead relay: the connection fails and the error line must be scrubbed.
      session = joinRoom({ syncUrl: "ws://127.0.0.1:9", room, filePath: "main.typ" });
      await vi.waitFor(
        () => {
          expect(lines.length).toBeGreaterThan(0);
        },
        { timeout: 4000, interval: 50 },
      );
      expect(lines.some((l) => l.includes("project-room socket error"))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain(room);
        expect(line).not.toContain(encodeURIComponent(room));
      }
    } finally {
      spy.mockRestore();
      session?.destroy();
    }
  });
});

/**
 * ADR-0024 §1: honest liveness derived from the room (relay socket + awareness),
 * never from the local replica. These pin the fields that do NOT need a remote
 * peer (the human-peer exclusion + lastBrowserSeenMs are pinned end-to-end over
 * the REAL relay in kernel.test.ts, where a real browser peer joins the room).
 */
describe("session liveness — honest, room-derived (ADR-0024 §1)", () => {
  it("reports relayConnected=false and an empty-room baseline before the socket opens", () => {
    const fake = new FakeSocket();
    const session = joinRoom(
      { syncUrl: "ws://127.0.0.1:9", room: "share-aaaaaaaaaaaaaaaa", filePath: "/main.typ" },
      { socketFactory: () => fake },
    );
    try {
      const live = session.liveness();
      expect(live.relayConnected).toBe(false);
      expect(live.browserAttached).toBe(false);
      expect(live.humanPeers).toBe(0);
      expect(live.lastBrowserSeenMs).toBeNull();
    } finally {
      session.destroy();
    }
  });

  it("flips relayConnected true once the socket opens, and back to false on close — with no human peer it stays unwatched", () => {
    const fake = new FakeSocket();
    const session = joinRoom(
      { syncUrl: "ws://127.0.0.1:9", room: "share-aaaaaaaaaaaaaaaa", filePath: "/main.typ" },
      { socketFactory: () => fake },
    );
    try {
      fake.open();
      const open = session.liveness();
      expect(open.relayConnected).toBe(true);
      // The kernel's OWN agent presence must never count as a watching browser.
      expect(open.browserAttached).toBe(false);
      expect(open.humanPeers).toBe(0);
      expect(open.lastBrowserSeenMs).toBeNull();

      fake.close();
      expect(session.liveness().relayConnected).toBe(false);
    } finally {
      session.destroy();
    }
  });
});

/**
 * ADR-0023 §1: the kernel's per-grant signer must produce a signature the BROWSER
 * re-derives and verifies. This pins the cross-process contract — same
 * responseKey + same scope on both sides — without a live socket, by driving the
 * extracted {@link buildProposalSigner} directly.
 */
describe("buildProposalSigner — kernel signatures are browser-verifiable (ADR-0023 §1)", () => {
  const RESPONSE_KEY = new Uint8Array(32).fill(7);
  const base = {
    grantId: "g0aBcDeF1234_-ZyXwVu",
    controlRoom: "ctl-0123456789abcdef",
    syncUrl: "ws://127.0.0.1:1234",
    projectId: "proj-1",
    shareRoom: `share-${"a1".repeat(16)}`,
  };
  const signable: SignableProposal = {
    id: "abc",
    createdAt: 100,
    seq: 0,
    request: "do x",
    ops: [
      { kind: "edit", path: "/main.typ", newPath: null, baseText: "x", proposedText: "y", blocks: [{ search: "x", replace: "y" }] },
    ],
  };

  it("a signed proposal verifies under the SAME responseKey + scope", async () => {
    const signer = buildProposalSigner(base, RESPONSE_KEY);
    const sig = await signer(signable, "mcpProposals");
    const scope: ProposalScope = { ...base, mailbox: "mcpProposals" };
    const key = await deriveProposalKey(RESPONSE_KEY, scope);
    expect(await verifyProposal(key, scope, signable, sig)).toBe(true);
  });

  it("a different responseKey (un-paired peer) never verifies", async () => {
    const signer = buildProposalSigner(base, RESPONSE_KEY);
    const sig = await signer(signable, "mcpProposals");
    const scope: ProposalScope = { ...base, mailbox: "mcpProposals" };
    const wrong = await deriveProposalKey(new Uint8Array(32).fill(9), scope);
    expect(await verifyProposal(wrong, scope, signable, sig)).toBe(false);
  });

  it("the two mailboxes get distinct, non-interchangeable signatures", async () => {
    const signer = buildProposalSigner(base, RESPONSE_KEY);
    const sigSingle = await signer(signable, "mcpProposals");
    const fileScope: ProposalScope = { ...base, mailbox: "mcpFileProposals" };
    const fileKey = await deriveProposalKey(RESPONSE_KEY, fileScope);
    // A single-file signature must NOT verify against the file mailbox scope/key.
    expect(await verifyProposal(fileKey, fileScope, signable, sigSingle)).toBe(false);
  });
});
