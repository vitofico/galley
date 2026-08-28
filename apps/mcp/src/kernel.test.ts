import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket as WS } from "ws";
import type { Author, CheckResult, CompileInput } from "@galley/shared";
import {
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  getPendingProposals,
  getProposal,
  resolveProposal,
  type WebSocketLike,
} from "@galley/collab";
import { createGalleyMcpServer, type KernelTools } from "./server.js";
import { roomFingerprint } from "./config.js";
import { READ_LIMITS } from "./surface.js";
import { joinRoom, type KernelSession } from "./session.js";

/**
 * Kernel integration (#16.1, ADR-0020): an MCP client over the SDK's in-memory
 * transport pair driving a kernel session that joined a REAL @galley/sync relay
 * on an ephemeral port (the same client wiring as apps/sync's own tests). This
 * is the end-to-end proof of the kernel half of the contract:
 *
 *   browser-ish peer ⇄ real ws relay ⇄ kernel session ⇄ MCP tools
 *
 * The browser half (DiffReview + Accept gate) is covered by the web unit tests
 * and apps/web/e2e/mcp-proposals.spec.ts.
 */

interface SyncHandle {
  port: number;
  close(): Promise<void>;
}

// apps/mcp's tsconfig rootDir forbids a STATIC cross-package source import, so
// the real sync server is loaded with a runtime (variable-specifier) import —
// vitest resolves it; tsc never follows it. Structural type above.
const SYNC_SERVER_SPECIFIER = "../../sync/src/sync-server.js";

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

/** A "browser-side" peer that seeds the shared project into a room. */
function browserPeer(room: string) {
  const project = new CollabProject();
  project.create("/main.typ", "= Title\nbody\n", HUMAN);
  project.create("/notes.typ", "notes\n", HUMAN);
  const url = `ws://127.0.0.1:${server.port}/${room}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike),
    { author: HUMAN },
  );
  connection.connect();
  return { project, connection };
}

/**
 * A "background agent-apply HOST" peer (F13): a browser editor that carries a
 * normal `human` author but advertises the honest `agentWorker: true` presence
 * marker — so the kernel's liveness count must NOT treat it as a watching human.
 * It seeds the file like browserPeer so the room has content to apply against.
 */
function workerPeer(room: string) {
  const project = new CollabProject();
  project.create("/main.typ", "= Title\nbody\n", HUMAN);
  const url = `ws://127.0.0.1:${server.port}/${room}`;
  const connection = new CollabConnection(
    project,
    new WebSocketTransport(() => new WS(url) as unknown as WebSocketLike),
    { author: HUMAN, agentWorker: true },
  );
  connection.connect();
  return { project, connection };
}

/** Join the kernel to `room` and wire an MCP client to its tools. */
async function kernelClient(room: string, extra: Omit<KernelTools, "surface"> = {}) {
  const session = joinRoom({
    syncUrl: `ws://127.0.0.1:${server.port}`,
    room,
    filePath: "/main.typ",
  });
  await session.whenFileReady();
  const mcp = createGalleyMcpServer({ surface: session.surface, ...extra });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "kernel-int-test", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { session, client };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  expect(first?.type).toBe("text");
  return first?.text ?? "";
}

describe("mcp kernel ⇄ real sync relay", () => {
  it("read_document round-trips the replicated file text", async () => {
    const room = "kernel-read";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const k = await kernelClient(room);
      session = k.session;
      const result = await k.client.callTool({ name: "read_document", arguments: {} });
      expect(firstText(result)).toBe("= Title\nbody\n");
    } finally {
      session?.destroy();
      browser.connection.destroy();
      browser.project.destroy();
    }
  });

  it("propose_edit publishes to the mailbox, returns pending_review, and leaves the room's file text unchanged on BOTH peers", async () => {
    const room = "kernel-propose";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const k = await kernelClient(room);
      session = k.session;

      const result = await k.client.callTool({
        name: "propose_edit",
        arguments: {
          request: "Add a closing line",
          edits: [{ search: "body\n", replace: "body\nThe end.\n" }],
        },
      });
      const payload = JSON.parse(firstText(result)) as { status: string; proposalId: string };
      expect(payload.status).toBe("pending_review");

      // The proposal replicates to the browser peer over the real relay…
      await vi.waitFor(() => {
        const pending = getPendingProposals(browser.project);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          id: payload.proposalId,
          filePath: "/main.typ",
          baseText: "= Title\nbody\n",
          proposedText: "= Title\nbody\nThe end.\n",
          request: "Add a closing line",
          author: "mcp",
          status: "pending",
        });
      }, settle);

      // …while every file's text stays byte-for-byte unchanged on both peers
      // (the ADR-0020 security pin: only the browser Accept gate can land it).
      const texts = (p: CollabProject) =>
        p
          .snapshot()
          .files.map((f) => [f.path, f.text])
          .sort();
      expect(texts(browser.project)).toEqual([
        ["/main.typ", "= Title\nbody\n"],
        ["/notes.typ", "notes\n"],
      ]);
      // Kernel side: the only view it has is the read-only surface, and it
      // reports the same unchanged text.
      const kernelRead = session.surface.readDocument();
      expect(kernelRead).toEqual({ ok: true, path: "/main.typ", text: "= Title\nbody\n" });

      // The browser's verdict replicates back to the kernel's surface.
      resolveProposal(browser.project, payload.proposalId, "rejected", HUMAN);
      await vi.waitFor(() => {
        expect(getProposal(browser.project, payload.proposalId)?.status).toBe("rejected");
      }, settle);
    } finally {
      session?.destroy();
      browser.connection.destroy();
      browser.project.destroy();
    }
  });

  it("list_files/read_file give read context over the replicated project — and an oversized hostile sibling stays bounded (#16.2a)", async () => {
    const room = "kernel-read-context";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const k = await kernelClient(room);
      session = k.session;

      // The kernel sees the whole live project, not just its target file.
      const listed = await k.client.callTool({ name: "list_files", arguments: {} });
      expect(JSON.parse(firstText(listed))).toEqual({
        files: [
          { path: "/main.typ", sizeBytes: 13, sizeExact: true, duplicate: false },
          { path: "/notes.typ", sizeBytes: 6, sizeExact: true, duplicate: false },
        ],
        truncated: false,
        omitted: 0,
      });

      // …and can read a sibling by exact path.
      const sibling = await k.client.callTool({
        name: "read_file",
        arguments: { path: "/notes.typ" },
      });
      expect(sibling.isError).toBeFalsy();
      expect(firstText(sibling)).toBe("notes\n");

      // A hostile/oversized sibling seeded by the OTHER peer replicates in…
      const hugeBytes = 2 * 1024 * 1024 + 1;
      browser.project.create("/huge.typ", "x".repeat(hugeBytes), HUMAN);
      await vi.waitFor(async () => {
        const again = JSON.parse(
          firstText(await k.client.callTool({ name: "list_files", arguments: {} })),
        ) as { files: { path: string; sizeBytes: number; sizeExact: boolean }[] };
        expect(again.files).toContainEqual({
          path: "/huge.typ",
          sizeBytes: hugeBytes,
          sizeExact: true,
          duplicate: false,
        });
      }, settle);

      // …but a read of it is REFUSED within bounds — never an unbounded dump.
      const refused = await k.client.callTool({
        name: "read_file",
        arguments: { path: "/huge.typ" },
      });
      expect(refused.isError).toBe(true);
      expect(firstText(refused)).toContain("read cap");
      expect(firstText(refused).length).toBeLessThan(300);
    } finally {
      session?.destroy();
      browser.connection.destroy();
      browser.project.destroy();
    }
  });

  it("project_context retrieves a relevant excerpt with path provenance over the replicated project — and a hostile oversized sibling is skipped within bounds (#16.2b)", async () => {
    const room = "kernel-project-context";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const k = await kernelClient(room);
      session = k.session;

      // A query about the sibling's topic surfaces ITS text, with provenance.
      const result = await k.client.callTool({
        name: "project_context",
        arguments: { query: "notes" },
      });
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(firstText(result)) as {
        excerpts: { path: string; startLine: number; endLine: number; text: string }[];
        skipped: { path: string; reason: string }[];
      };
      expect(payload.excerpts).toContainEqual({
        path: "/notes.typ",
        startLine: 1,
        endLine: 1,
        headingPath: [],
        headingPathTruncated: false,
        text: "notes\n",
        truncated: false,
      });
      expect(payload.skipped).toEqual([]);

      // A hostile/oversized sibling seeded by the OTHER peer replicates in…
      browser.project.create("/huge.typ", "x".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
      await vi.waitFor(async () => {
        const again = await k.client.callTool({
          name: "project_context",
          arguments: { query: "notes" },
        });
        const p = JSON.parse(firstText(again)) as { skipped: { path: string; reason: string }[] };
        expect(p.skipped).toContainEqual({ path: "/huge.typ", reason: "over-cap" });
      }, settle);

      // …and the response stays bounded: budget-limited excerpts + provenance,
      // never a dump of the oversized file.
      const after = await k.client.callTool({
        name: "project_context",
        arguments: { query: "notes" },
      });
      const text = firstText(after);
      expect(text.length).toBeLessThan(20_000);
      expect(text).not.toContain("xxxx");
    } finally {
      session?.destroy();
      browser.connection.destroy();
      browser.project.destroy();
    }
  });

  it("compile posts the replicated project to the injected service", async () => {
    const room = "kernel-compile";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const seen: CompileInput[] = [];
      const fake = {
        check: async (input: CompileInput): Promise<CheckResult> => {
          seen.push(input);
          return { ok: true, diagnostics: [], pageCount: 1, durationMs: 2 };
        },
      };
      const k = await kernelClient(room, { compileService: fake });
      session = k.session;
      const result = await k.client.callTool({ name: "compile", arguments: {} });
      const payload = JSON.parse(firstText(result)) as { status: string; pageCount: number };
      expect(payload.status).toBe("ok");
      expect(payload.pageCount).toBe(1);
      expect(seen[0]).toMatchObject({
        kind: "project",
        main: "/main.typ",
        files: [
          { path: "/main.typ", text: "= Title\nbody\n" },
          { path: "/notes.typ", text: "notes\n" },
        ],
      });
    } finally {
      session?.destroy();
      browser.connection.destroy();
      browser.project.destroy();
    }
  });

  it("liveness over the REAL relay: browserAttached true with a human peer, the kernel's own agent presence excluded (ADR-0024 §1)", async () => {
    const room = "kernel-liveness";
    const browser = browserPeer(room);
    let session: KernelSession | undefined;
    try {
      const k = await kernelClient(room);
      session = k.session;
      // The human browser peer is in the room: liveness must SEE it…
      await vi.waitFor(() => {
        const live = session!.liveness();
        expect(live.relayConnected).toBe(true);
        expect(live.browserAttached).toBe(true);
        expect(live.humanPeers).toBe(1); // the kernel's own agent presence excluded
        expect(typeof live.lastBrowserSeenMs).toBe("number");
      }, settle);

      // …and when the browser LEAVES the room, browserAttached falls to false
      // (deterministic awareness lifecycle — a stale replica cannot mask it),
      // while lastBrowserSeenMs retains the last time a human was seen.
      browser.connection.destroy();
      browser.project.destroy();
      await vi.waitFor(() => {
        const live = session!.liveness();
        expect(live.browserAttached).toBe(false);
        expect(live.humanPeers).toBe(0);
        expect(typeof live.lastBrowserSeenMs).toBe("number");
      }, settle);
    } finally {
      session?.destroy();
    }
  });

  it("liveness flows into a per-project tool result and reports pending_review_unwatched when no browser is attached (ADR-0024 §1)", async () => {
    const room = "kernel-liveness-merge";
    let session: KernelSession | undefined;
    try {
      // No browser peer ever joins this room. The kernel still joins as a peer,
      // but seeds the file itself is impossible (no human), so use a short-lived
      // browser ONLY to seed /main.typ, then drop it before asserting.
      const seeder = browserPeer(room);
      const k = await kernelClient(room);
      session = k.session;
      // Build a server WITH the liveness provider (the production wiring).
      const mcp = createGalleyMcpServer({
        surface: session.surface,
        liveness: () => session!.liveness(),
      });
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "liveness-merge", version: "0.0.0" });
      await Promise.all([mcp.connect(st), client.connect(ct)]);

      // While the seeder (a human) is present, list_files carries browserAttached:true.
      await vi.waitFor(async () => {
        const listed = JSON.parse(
          firstText(await client.callTool({ name: "list_files", arguments: {} })),
        ) as { liveness: { browserAttached: boolean } };
        expect(listed.liveness.browserAttached).toBe(true);
      }, settle);

      // Drop the human; the room becomes unwatched.
      seeder.connection.destroy();
      seeder.project.destroy();
      await vi.waitFor(() => {
        expect(session!.liveness().browserAttached).toBe(false);
      }, settle);

      const result = await client.callTool({
        name: "propose_edit",
        arguments: { request: "x", edits: [{ search: "body\n", replace: "body!\n" }] },
      });
      const payload = JSON.parse(firstText(result)) as {
        status: string;
        note: string;
        liveness: { browserAttached: boolean };
      };
      expect(payload.status).toBe("pending_review_unwatched");
      expect(payload.note).toMatch(/no browser is attached/i);
      expect(payload.liveness.browserAttached).toBe(false);
    } finally {
      session?.destroy();
    }
  });

  it("a headless agent-worker peer does NOT flip browserAttached (F13: honest liveness)", async () => {
    // The room has ONLY a background agent-apply host attached (agentWorker:true),
    // no human watching. The kernel must report browserAttached:false and a
    // propose_edit must still downgrade to pending_review_unwatched — a worker is
    // not a watcher, so it never silently suppresses the unwatched signal.
    const room = "kernel-liveness-worker";
    let session: KernelSession | undefined;
    try {
      // Seed the file with a short-lived human, then drop it; the worker (which
      // also seeds /main.typ) stays attached for the assertions.
      const seeder = browserPeer(room);
      const worker = workerPeer(room);
      const k = await kernelClient(room);
      session = k.session;
      const mcp = createGalleyMcpServer({
        surface: session.surface,
        liveness: () => session!.liveness(),
      });
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "liveness-worker", version: "0.0.0" });
      await Promise.all([mcp.connect(st), client.connect(ct)]);

      // Drop the human seeder; ONLY the agentWorker peer remains in the room.
      seeder.connection.destroy();
      seeder.project.destroy();
      await vi.waitFor(() => {
        // The worker is present, but it must not count as a watching human.
        expect(session!.liveness().browserAttached).toBe(false);
        expect(session!.liveness().humanPeers).toBe(0);
      }, settle);

      const result = await client.callTool({
        name: "propose_edit",
        arguments: { request: "x", edits: [{ search: "body\n", replace: "body!\n" }] },
      });
      const payload = JSON.parse(firstText(result)) as {
        status: string;
        liveness: { browserAttached: boolean };
      };
      expect(payload.status).toBe("pending_review_unwatched");
      expect(payload.liveness.browserAttached).toBe(false);

      worker.connection.destroy();
      worker.project.destroy();
    } finally {
      session?.destroy();
    }
  });

  it("fails loud when the target file never appears (absent room/file)", async () => {
    const session = joinRoom({
      syncUrl: `ws://127.0.0.1:${server.port}`,
      room: "kernel-empty-room",
      filePath: "/main.typ",
    });
    try {
      await expect(session.whenFileReady(300)).rejects.toThrow(
        /timed out waiting for \/main\.typ/,
      );
    } finally {
      session.destroy();
    }
  });

  it("per-project STARTUP-FAILURE stderr never contains the room capability — only its fingerprint (Security round 3)", async () => {
    const room = `share-${"d".repeat(32)}`; // a realistic Share capability
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const session = joinRoom({
      syncUrl: `ws://127.0.0.1:${server.port}`,
      room,
      filePath: "/main.typ",
    });
    try {
      let message = "";
      try {
        await session.whenFileReady(300);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        // EXACTLY main()'s startup-failure stderr line (main.ts catch): the
        // session's timeout message is what reaches stderr verbatim, so the
        // capability must already be absent at the SOURCE.
        console.error(`galley mcp kernel failed to start: ${message}`);
      }
      expect(message).toMatch(/timed out waiting for \/main\.typ/);
      expect(message).toContain(roomFingerprint(room)); // still distinguishable…
      for (const text of [message, ...lines]) {
        expect(text).not.toContain(room); // …but never the capability,
        expect(text).not.toContain(encodeURIComponent(room)); // encoded either,
        expect(text).not.toMatch(/share-[A-Za-z0-9-]{16,}/); // nor any share id.
      }
    } finally {
      spy.mockRestore();
      session.destroy();
    }
  });
});
