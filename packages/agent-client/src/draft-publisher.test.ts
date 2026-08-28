import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WS } from "ws";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  getFileProposals,
  getPendingProposals,
  resolveProposal,
  PROPOSAL_LIMITS,
  FILE_PROPOSAL_LIMITS,
  type WebSocketLike,
} from "@galley/collab";
import {
  connectDraftPublisher,
  DRAFT_PUBLISHER_RUN_ID,
  type DraftPublisher,
} from "./draft-publisher.js";

/**
 * Draft-publisher integration: a headless client joining a REAL @galley/sync
 * relay on an ephemeral port (the same harness apps/mcp's kernel tests build).
 * This is the end-to-end proof of the A2 draft contract's galley half:
 *
 *   room-holding peer ⇄ real ws relay ⇄ draft-publisher client
 *
 * publishes are UNSIGNED (manual in-editor Accept gate only — never
 * auto-accept), and `close()` = flush-then-disconnect gets a short-lived
 * publish APPLIED to the live room before the socket drops — delivery, NOT
 * persistence: the relay holds no storage and reaps a room's doc on last
 * disconnect, so a delivered record survives only while a peer keeps the room
 * open (here, the holder peer below).
 */

interface SyncHandle {
  port: number;
  close(): Promise<void>;
}

// This package's tsconfig rootDir forbids a STATIC cross-package source import,
// so the real sync server is loaded with a runtime (variable-specifier) import —
// vitest resolves it; tsc never follows it. Structural type above. (Mirrors
// apps/mcp/src/kernel.test.ts.)
const SYNC_SERVER_SPECIFIER = "../../../apps/sync/src/sync-server.js";

const HUMAN: Author = { kind: "human", userId: "browser" };
const settle = { timeout: 4000, interval: 20 };

let server: SyncHandle;

beforeAll(async () => {
  const { startSyncServer } = (await import(SYNC_SERVER_SPECIFIER)) as {
    startSyncServer: (port?: number) => Promise<SyncHandle>;
  };
  server = await startSyncServer(0);
});

afterAll(async () => {
  await server.close();
});

/**
 * A "browser-ish" peer that seeds the shared project and HOLDS the room open.
 * The relay reaps an empty room on last-disconnect and holds no persistence, so
 * a delivered record survives across a publisher's lifetime only while some peer
 * keeps the room alive — exactly the A2 topology, where the editor side owns the
 * room.
 */
function holderPeer(room: string) {
  const project = new CollabProject();
  project.create("/main.typ", "= Title\nbody\n", HUMAN);
  const url = `ws://127.0.0.1:${server.port}/${room}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike),
    { author: HUMAN },
  );
  connection.connect();
  return { project, connection };
}

function connect(room: string): DraftPublisher {
  return connectDraftPublisher({
    syncUrl: `ws://127.0.0.1:${server.port}`,
    room,
  });
}

describe("draft publisher ⇄ real sync relay", () => {
  it("publishes an UNSIGNED multi-file draft the room's mailbox sees — op kind + runId intact, no signature", async () => {
    const room = "draft-publish";
    const holder = holderPeer(room);
    const client = connect(room);
    try {
      await client.whenSynced();
      const id = await client.publishFileProposal({
        request: "Land the A2 draft",
        runId: "run-a2-0001",
        ops: [
          {
            kind: "create",
            path: "/drafts/a2.typ",
            baseText: "",
            proposedText: "= Draft\n",
            blocks: [],
          },
        ],
      });

      // The record replicates to the room-holding peer over the real relay…
      await vi.waitFor(() => {
        const records = getFileProposals(holder.project);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          id,
          request: "Land the A2 draft",
          runId: "run-a2-0001",
          status: "pending",
          author: "mcp",
          ops: [
            {
              kind: "create",
              path: "/drafts/a2.typ",
              proposedText: "= Draft\n",
            },
          ],
        });
        // …UNSIGNED (the A2 contract): no `sig` ⇒ the browser's MANUAL Accept
        // gate reviews it — an unsigned record is never auto-accepted.
        expect(records[0]!.sig).toBeUndefined();
      }, settle);

      // The client presents honestly as an AGENT peer in the room's presence.
      await vi.waitFor(() => {
        const agents = holder.connection
          .presences()
          .filter((p) => p.author.kind === "agent");
        expect(agents).toHaveLength(1);
        expect(agents[0]!.author).toEqual({
          kind: "agent",
          runId: DRAFT_PUBLISHER_RUN_ID,
        });
      }, settle);
    } finally {
      client.destroy();
      holder.connection.destroy();
      holder.project.destroy();
    }
  });

  it("a single-file publish is visible pending, never touches file text, and the room's verdict replicates back (status read + observe)", async () => {
    const room = "draft-status";
    const holder = holderPeer(room);
    const client = connect(room);
    try {
      await client.whenSynced();
      const base = client
        .snapshot()
        .files.find((f) => f.path === "/main.typ")!.text;
      const id = await client.publishProposal({
        filePath: "/main.typ",
        baseText: base,
        proposedText: "= Title\nbody\nThe end.\n",
        blocks: [{ search: "body\n", replace: "body\nThe end.\n" }],
        request: "Add a closing line",
        runId: "run-a2-0002",
      });
      expect(client.getProposal(id)?.status).toBe("pending");

      await vi.waitFor(() => {
        expect(getPendingProposals(holder.project)).toHaveLength(1);
      }, settle);
      // Publishing writes ONLY the mailbox, never file text (the ADR-0020 pin).
      expect(
        holder.project.snapshot().files.find((f) => f.path === "/main.typ")!
          .text,
      ).toBe(base);

      // The room's verdict lands back on the client — via observe + read.
      const seen: string[] = [];
      const off = client.observeProposals(() => {
        const status = client.getProposal(id)?.status;
        if (status !== undefined) seen.push(status);
      });
      resolveProposal(holder.project, id, "rejected", HUMAN);
      await vi.waitFor(() => {
        expect(client.getProposal(id)?.status).toBe("rejected");
      }, settle);
      expect(seen).toContain("rejected");
      off();
    } finally {
      client.destroy();
      holder.connection.destroy();
      holder.project.destroy();
    }
  });

  it("close() = flush-then-disconnect: a SECOND client joining after the first is gone still reads the record", async () => {
    const room = "draft-delivery";
    const holder = holderPeer(room); // keeps the room alive across the publisher's exit
    let reader: DraftPublisher | undefined;
    try {
      const publisher = connect(room);
      await publisher.whenSynced();
      const id = await publisher.publishFileProposal({
        request: "delivered draft",
        runId: "run-a2-0003",
        ops: [
          {
            kind: "create",
            path: "/drafts/delivered.typ",
            baseText: "",
            proposedText: "ok\n",
            blocks: [],
          },
        ],
      });
      // No settling wait between publish and close: the flush round-trip is the
      // ONLY thing that gets this record into the live room before the socket
      // drops (the transport's outbox is discarded on disconnect). The holder
      // then keeps that room — and the record — alive; the relay itself does not
      // persist it.
      await publisher.close();

      // A fresh client joins ONLY NOW — the publisher is gone, so the record
      // can only come from the room's replicated doc, never a live broadcast.
      reader = connect(room);
      await reader.whenSynced();
      const record = reader.getFileProposal(id);
      expect(record).toBeDefined();
      expect(record!.status).toBe("pending");
      expect(record!.sig).toBeUndefined();
      expect(record!.ops[0]).toMatchObject({
        kind: "create",
        path: "/drafts/delivered.typ",
      });
    } finally {
      reader?.destroy();
      holder.connection.destroy();
      holder.project.destroy();
    }
  });

  it("an over-cap publish surfaces the mailbox's typed size-violation error and writes NOTHING into the room", async () => {
    const room = "draft-size-cap";
    const holder = holderPeer(room);
    const client = connect(room);
    try {
      await client.whenSynced();
      await expect(
        client.publishProposal({
          filePath: "/main.typ",
          baseText: "",
          proposedText: "",
          blocks: [],
          request: "r".repeat(PROPOSAL_LIMITS.maxRequestChars + 1),
        }),
      ).rejects.toThrow(
        `publishProposal: request exceeds ${PROPOSAL_LIMITS.maxRequestChars} characters`,
      );
      await expect(
        client.publishFileProposal({
          request: "too big",
          ops: [
            {
              kind: "create",
              path: "/big.typ",
              baseText: "",
              proposedText: "x".repeat(FILE_PROPOSAL_LIMITS.maxTextBytes + 1),
              blocks: [],
            },
          ],
        }),
      ).rejects.toThrow(
        `publishFileProposal: an op's proposedText exceeds ${FILE_PROPOSAL_LIMITS.maxTextBytes} bytes`,
      );

      // The refused publishes never entered the CRDT: after a full round-trip,
      // the room-side mailboxes are still empty.
      await client.flush();
      expect(getPendingProposals(holder.project)).toHaveLength(0);
      expect(getFileProposals(holder.project)).toHaveLength(0);
    } finally {
      client.destroy();
      holder.connection.destroy();
      holder.project.destroy();
    }
  });

  it("flush()/publish after destroy reject instead of hanging", async () => {
    const client = connect("draft-destroyed");
    client.destroy();
    await expect(client.flush(100)).rejects.toThrow(/after disconnect/);
    await expect(
      client.publishFileProposal({
        request: "late",
        ops: [
          {
            kind: "create",
            path: "/x.typ",
            baseText: "",
            proposedText: "x",
            blocks: [],
          },
        ],
      }),
    ).rejects.toThrow(/after disconnect/);
  });

  it("a publish issued after close() begins is REJECTED, and the close still completes", async () => {
    const room = "draft-close-race";
    const holder = holderPeer(room); // keeps the room alive so the close's flush lands
    const client = connect(room);
    try {
      await client.whenSynced();
      // Begin the close: it raises the closing barrier synchronously, then runs
      // the flush round-trip before tearing down.
      const closed = client.close();
      // A publish racing in after close() began must NOT be silently discarded
      // on the imminent teardown — it rejects instead.
      await expect(
        client.publishFileProposal({
          request: "raced in after close",
          runId: "run-a2-race",
          ops: [
            {
              kind: "create",
              path: "/late.typ",
              baseText: "",
              proposedText: "late\n",
              blocks: [],
            },
          ],
        }),
      ).rejects.toThrow(/after close/);
      // …and the in-flight close still completes cleanly.
      await expect(closed).resolves.toBeUndefined();
    } finally {
      client.destroy();
      holder.connection.destroy();
      holder.project.destroy();
    }
  });

  it("destroy() rejects an in-flight whenSynced() promptly (a short-lived process never hangs to the timeout)", async () => {
    const client = connect("draft-sync-abort");
    const pending = client.whenSynced(4000);
    // Tear down before the initial sync can land: the waiter rejects AT ONCE,
    // rather than hanging until the 4 s timeout.
    client.destroy();
    await expect(pending).rejects.toThrow(/before the initial room sync/);
  });

  it("a malformed syncUrl throws synchronously WITHOUT leaking the room capability or the URL", () => {
    const room = "top-secret-capability-0xC0FFEE";
    const syncUrl = "this is not a url";
    let caught: unknown;
    try {
      connectDraftPublisher({ syncUrl, room });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(room);
    expect(message).not.toContain(encodeURIComponent(room));
    expect(message).not.toContain(syncUrl);
  });

  it("a synchronous socket-construction throw is re-thrown with the room + URL redacted", () => {
    const room = "capability-leak-guard-9001";
    const syncUrl = "ws://127.0.0.1:1";
    let caught: unknown;
    try {
      connectDraftPublisher(
        { syncUrl, room },
        {
          // A socket library that fails synchronously, embedding the
          // room-bearing URL in its message — exactly the leak the wrap scrubs.
          socketFactory: (u) => {
            throw new Error(`ENETUNREACH while opening ${u}`);
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(room);
    expect(message).not.toContain(encodeURIComponent(room));
    expect(message).not.toContain(`${syncUrl}/${encodeURIComponent(room)}`);
  });
});
