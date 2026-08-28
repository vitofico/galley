import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { chunkDocument } from "@galley/agent";
import type { Author } from "@galley/shared";
import {
  CollabProject,
  getPendingProposals,
  getPendingFileProposals,
  getPendingRunGroups,
  readRunOpen,
  resolveProposal,
  resolveFileProposal,
  type ProposalSigner,
} from "@galley/collab";
import {
  READ_LIMITS,
  RUN_IDLE_MS,
  chunkSafePrefix,
  createToolSurface,
  estimateChunks,
  utf8ByteLength,
} from "./surface.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const MCP: Author = { kind: "agent", runId: "mcp" };

/**
 * The ADR-0020 capability pin: the object handed to the tool layer exposes
 * EXACTLY file-reads + proposal-writes. If anyone widens this surface (a
 * mutator, the raw project, a room handle), these tests fail the gate.
 */
describe("kernel tool surface — read + proposal-write ONLY", () => {
  function fixture() {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    return { project, surface: createToolSurface(project, "/main.typ", MCP) };
  }

  it("exposes exactly the pinned capability set (no mutators, no project escape)", () => {
    const { surface } = fixture();
    expect(Object.keys(surface).sort()).toEqual([
      "autoAcceptEligible",
      "awaitProposalResolution",
      "compileInput",
      "filePath",
      "getProposal",
      "listFiles",
      "projectContext",
      "publishFileProposal",
      "publishProposal",
      "readDocument",
      "readFile",
    ]);
    // Every capability is a read except the two proposal writes; none returns the project.
    for (const value of Object.values(surface)) {
      expect(value).not.toBeInstanceOf(CollabProject);
    }
  });

  it("readDocument is a value copy — mutating the result cannot reach the doc", () => {
    const { project, surface } = fixture();
    const read = surface.readDocument();
    expect(read).toEqual({ ok: true, path: "/main.typ", text: "= Title\nbody\n" });
    if (read.ok) (read as { text: string }).text = "clobbered";
    expect(project.getFile(project.mainFileId()!)?.text).toBe("= Title\nbody\n");
  });

  it("publishProposal writes ONLY a mailbox record — file text stays byte-for-byte", async () => {
    const { project, surface } = fixture();
    const before = project.snapshot().files.map((f) => [f.path, f.text]);
    const id = await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nmore\n",
      blocks: [{ search: "body\n", replace: "body\nmore\n" }],
      request: "more",
    });
    expect(project.snapshot().files.map((f) => [f.path, f.text])).toEqual(before);
    expect(getPendingProposals(project).map((p) => p.id)).toEqual([id]);
    // The record is scoped to the session's one file — the path is not caller-chosen.
    expect(getPendingProposals(project)[0]!.filePath).toBe("/main.typ");
  });

  it("publishFileProposal writes ONLY the sibling mailbox — no file text, no created file", async () => {
    const { project, surface } = fixture();
    const before = project.snapshot().files.map((f) => [f.path, f.text]);
    const id = await surface.publishFileProposal({
      request: "intro chapter",
      ops: [
        { kind: "create", path: "/chapters/intro.typ", baseText: "", proposedText: "= Intro\n", blocks: [] },
        {
          kind: "edit",
          path: "/main.typ",
          baseText: "= Title\nbody\n",
          proposedText: "= Title\nbody\nmore\n",
          blocks: [{ search: "body\n", replace: "body\nmore\n" }],
        },
      ],
    });
    expect(typeof id).toBe("string");
    // No file text changed, and the proposed new file was NOT created.
    expect(project.snapshot().files.map((f) => [f.path, f.text])).toEqual(before);
    expect(project.snapshot().files.some((f) => f.path === "/chapters/intro.typ")).toBe(false);
    expect(getPendingFileProposals(project).map((p) => p.id)).toEqual([id]);
  });

  it("threads the injected signer into BOTH publishes (ADR-0023 §1) — records carry the per-mailbox sig", async () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    // A trivial signer that just echoes the mailbox name (a valid base64url
    // string) — this asserts WIRING, not crypto (Task 1 covers the crypto).
    const surface = createToolSurface(project, "/main.typ", MCP, async (_signable, mailbox) =>
      mailbox === "mcpProposals" ? "AAAA" : "BBBB",
    );
    await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nmore\n",
      blocks: [{ search: "body\n", replace: "body\nmore\n" }],
      request: "more",
    });
    await surface.publishFileProposal({
      request: "intro",
      ops: [{ kind: "create", path: "/intro.typ", baseText: "", proposedText: "= Intro\n", blocks: [] }],
    });
    expect(getPendingProposals(project)[0]!.sig).toBe("AAAA");
    expect(getPendingFileProposals(project)[0]!.sig).toBe("BBBB");
  });

  it("with NO signer (local/un-paired join) proposals publish unsigned — sig absent", async () => {
    const { project, surface } = fixture();
    await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nx\n",
      blocks: [{ search: "body\n", replace: "body\nx\n" }],
      request: "x",
    });
    expect(getPendingProposals(project)[0]!.sig).toBeUndefined();
  });

  // --- F5: autoAcceptEligible + awaitProposalResolution (ADR-0023) ----------

  it("autoAcceptEligible reflects signer presence (the ONLY auto-accept condition)", () => {
    const { surface: unsigned } = fixture();
    expect(unsigned.autoAcceptEligible).toBe(false);
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    const signer: ProposalSigner = async () => "AAAA";
    const signed = createToolSurface(project, "/main.typ", MCP, signer);
    expect(signed.autoAcceptEligible).toBe(true);
  });

  it("awaitProposalResolution resolves on a status flip that lands DURING the wait (single)", async () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    const signer: ProposalSigner = async () => "AAAA";
    const surface = createToolSurface(project, "/main.typ", MCP, signer);
    const id = await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nx\n",
      blocks: [{ search: "body\n", replace: "body\nx\n" }],
      request: "x",
    });
    const pending = surface.awaitProposalResolution("single", id, 1000);
    queueMicrotask(() => resolveProposal(project, id, "accepted", HUMAN));
    await expect(pending).resolves.toBe("accepted");
  });

  it("awaitProposalResolution is race-safe: a verdict already present resolves immediately (re-read after subscribe)", async () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    const signer: ProposalSigner = async () => "AAAA";
    const surface = createToolSurface(project, "/main.typ", MCP, signer);
    const id = await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nx\n",
      blocks: [{ search: "body\n", replace: "body\nx\n" }],
      request: "x",
    });
    // The verdict lands BEFORE the await is even called — no observer event will
    // ever fire for it, so only the post-subscribe re-read can catch it.
    resolveProposal(project, id, "rejected", HUMAN);
    await expect(surface.awaitProposalResolution("single", id, 1000)).resolves.toBe("rejected");
  });

  it("awaitProposalResolution times out when no verdict arrives (single)", async () => {
    const { project, surface } = fixture();
    const id = await surface.publishProposal({
      baseText: "= Title\nbody\n",
      proposedText: "= Title\nbody\nx\n",
      blocks: [{ search: "body\n", replace: "body\nx\n" }],
      request: "x",
    });
    await expect(surface.awaitProposalResolution("single", id, 20)).resolves.toBe("timeout");
  });

  it("awaitProposalResolution resolves on the FILE mailbox too", async () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    const signer: ProposalSigner = async () => "BBBB";
    const surface = createToolSurface(project, "/main.typ", MCP, signer);
    const id = await surface.publishFileProposal({
      request: "intro",
      ops: [{ kind: "create", path: "/intro.typ", baseText: "", proposedText: "= Intro\n", blocks: [] }],
    });
    const pending = surface.awaitProposalResolution("file", id, 1000);
    queueMicrotask(() => resolveFileProposal(project, id, "accepted", HUMAN));
    await expect(pending).resolves.toBe("accepted");
  });

  it("listFiles/readFile are reads — using them publishes nothing and mutates nothing", () => {
    const { project, surface } = fixture();
    const before = project.snapshot();
    surface.listFiles();
    surface.readFile("/main.typ");
    expect(project.snapshot()).toEqual(before);
    expect(getPendingProposals(project)).toHaveLength(0);
  });

  it("compileInput prefers the whole project (imports resolve) and reports an honest error when the scoped file is gone", () => {
    const { project, surface } = fixture();
    expect(surface.compileInput()).toMatchObject({ kind: "project", main: "/main.typ" });
    project.delete(project.mainFileId()!, HUMAN);
    // Main deleted → no project input; the scoped file is also gone → error.
    expect(surface.compileInput()).toEqual({
      error: "file /main.typ is not present in this room",
    });
  });
});

/**
 * #16.2a — single-project READ context. The surface widens on the read side
 * only: live-files listing + exact-path sibling reads, bounded by READ_LIMITS.
 */
describe("kernel tool surface — project read context (listFiles/readFile)", () => {
  function fixture() {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    return { project, surface: createToolSurface(project, "/main.typ", MCP) };
  }

  it("listFiles returns live files only, in deterministic path order, with UTF-8 byte sizes", () => {
    const { project, surface } = fixture();
    project.create("/zeta.typ", "z\n", HUMAN);
    project.create("/accents.typ", "café\n", HUMAN); // 4 chars + \n = 6 UTF-8 bytes
    const listed = surface.listFiles();
    expect(listed).toEqual({
      ok: true,
      truncated: false,
      omitted: 0,
      files: [
        { path: "/accents.typ", sizeBytes: 6, sizeExact: true, duplicate: false },
        {
          path: "/main.typ",
          sizeBytes: utf8ByteLength("= Title\nbody\n"),
          sizeExact: true,
          duplicate: false,
        },
        { path: "/zeta.typ", sizeBytes: 2, sizeExact: true, duplicate: false },
      ],
    });
  });

  it("listFiles agrees with snapshot() on live paths and order — pins the cheap CRDT-map scan to collab's layout", () => {
    const { project, surface } = fixture();
    project.create("/b.typ", "b", HUMAN);
    project.create("/a.typ", "a", HUMAN);
    const gone = project.create("/dead.typ", "x", HUMAN);
    project.delete(gone, HUMAN);
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      // If collab ever renames its fileMeta/fileTexts maps, the cheap scan
      // would see an empty project — this cross-check fails loudly.
      expect(listed.files.map((f) => f.path)).toEqual(
        project
          .snapshot()
          .files.filter((f) => !f.deleted)
          .map((f) => f.path),
      );
    }
  });

  it("listFiles excludes deleted files (tombstones never surface to the tool layer)", () => {
    const { project, surface } = fixture();
    const id = project.create("/gone.typ", "bye\n", HUMAN);
    project.delete(id, HUMAN);
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.files.map((f) => f.path)).toEqual(["/main.typ"]);
  });

  it("listFiles SKIPS a live entry with a forged over-long path (counted in `omitted`) — forged-record tolerance", () => {
    const { project, surface } = fixture();
    // The UI cannot create this; only a hostile peer writing straight into the
    // Y.Map can. The kernel must not echo a megabyte-scale path back out.
    project.create(`/${"a".repeat(READ_LIMITS.maxPathChars + 100)}.typ`, "x", HUMAN);
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.files.map((f) => f.path)).toEqual(["/main.typ"]);
      expect(listed.omitted).toBe(1);
      expect(listed.truncated).toBe(false);
    }
  });

  it("listFiles caps the entry count at READ_LIMITS.maxListEntries and marks the cut", () => {
    const { project, surface } = fixture();
    for (let i = 0; i < READ_LIMITS.maxListEntries; i++) {
      project.create(`/f${String(i).padStart(4, "0")}.typ`, "x", HUMAN);
    }
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.files).toHaveLength(READ_LIMITS.maxListEntries);
      expect(listed.truncated).toBe(true);
      expect(listed.omitted).toBe(0);
    }
  });

  it("readFile reads any LIVE sibling by exact path", () => {
    const { project, surface } = fixture();
    project.create("/notes.typ", "notes\n", HUMAN);
    expect(surface.readFile("/notes.typ")).toEqual({
      ok: true,
      path: "/notes.typ",
      text: "notes\n",
    });
    // The session's own target file is readable through the same capability.
    expect(surface.readFile("/main.typ")).toMatchObject({ ok: true, path: "/main.typ" });
  });

  it("readFile is EXACT-match only — no normalization, no traversal semantics", () => {
    const { project, surface } = fixture();
    project.create("/notes.typ", "notes\n", HUMAN);
    for (const probe of ["notes.typ", "/NOTES.typ", "/a/../notes.typ", "/notes.typ/", "//notes.typ"]) {
      const read = surface.readFile(probe);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error).toContain("not present");
    }
  });

  it("readFile returns a structured not-found for deleted files (tombstones are not readable)", () => {
    const { project, surface } = fixture();
    const id = project.create("/gone.typ", "bye\n", HUMAN);
    project.delete(id, HUMAN);
    const read = surface.readFile("/gone.typ");
    expect(read).toEqual({
      ok: false,
      error:
        'file "/gone.typ" is not present in this room (no live file with that exact path — see list_files)',
    });
  });

  // --- Security round 2: duplicate paths, escaped echoes, bounded WORK -------

  it("readFile REFUSES a duplicate-path conflict instead of silently picking a winner", () => {
    const { project, surface } = fixture();
    project.create("/dup.typ", "first\n", HUMAN);
    project.create("/dup.typ", "second\n", HUMAN); // concurrent-create conflict
    const read = surface.readFile("/dup.typ");
    expect(read).toEqual({
      ok: false,
      error:
        'file "/dup.typ" resolves to 2 live files (duplicate-path conflict) — ' +
        "resolve the conflict in Galley before reading",
    });
  });

  it("listFiles flags every entry of a duplicated path so the agent can see the conflict", () => {
    const { project, surface } = fixture();
    project.create("/dup.typ", "first\n", HUMAN);
    project.create("/dup.typ", "second\n", HUMAN);
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.files.filter((f) => f.duplicate).map((f) => f.path)).toEqual([
        "/dup.typ",
        "/dup.typ",
      ]);
      expect(listed.files.find((f) => f.path === "/main.typ")?.duplicate).toBe(false);
    }
  });

  it("readFile echoes hostile paths JSON-escaped — a control-char path cannot break the error out of one line", () => {
    const { surface } = fixture();
    const hostile = "/evil\n\r.typ";
    const read = surface.readFile(hostile);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      // One clean line: no raw newline/carriage-return/control byte survives,
      // because the path is echoed via JSON.stringify.
      expect(read.error).not.toMatch(/[\n\r\u0000-\u001f]/);
      expect(read.error).toContain(JSON.stringify(hostile));
    }
  });

  it("readFile refuses an over-cap file from the O(1) length alone — the text is NEVER materialized", () => {
    const { project, surface } = fixture();
    project.create("/huge.typ", "x".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const read = surface.readFile("/huge.typ");
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error).toContain(`at least ${READ_LIMITS.maxFileBytes + 1} bytes`);
        expect(read.error).toContain(`${READ_LIMITS.maxFileBytes}-byte read cap`);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("readFile of one small file materializes EXACTLY that file, even with huge live and deleted siblings", () => {
    const { project, surface } = fixture();
    project.create("/big-live.typ", "y".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
    const dead = project.create("/big-dead.typ", "z".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
    project.delete(dead, HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      expect(surface.readFile("/main.typ")).toEqual({
        ok: true,
        path: "/main.typ",
        text: "= Title\nbody\n",
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("listFiles never touches tombstone text and stops exact-sizing once the per-call budget is spent (honest lower bounds after)", () => {
    const { project, surface } = fixture();
    // Three live files of 5Mi chars each against an 8Mi budget: the first
    // (deterministic order) is sized exactly, the rest fall back to the O(1)
    // length lower bound. A huge tombstone costs nothing at all.
    const five = 5 * 1024 * 1024;
    project.create("/big-a.typ", "a".repeat(five), HUMAN);
    project.create("/big-b.typ", "b".repeat(five), HUMAN);
    project.create("/big-c.typ", "c".repeat(five), HUMAN);
    const dead = project.create("/big-dead.typ", "d".repeat(five), HUMAN);
    project.delete(dead, HUMAN);

    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const listed = surface.listFiles();
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.files).toEqual([
          { path: "/big-a.typ", sizeBytes: five, sizeExact: true, duplicate: false },
          { path: "/big-b.typ", sizeBytes: five, sizeExact: false, duplicate: false },
          { path: "/big-c.typ", sizeBytes: five, sizeExact: false, duplicate: false },
          {
            path: "/main.typ",
            sizeBytes: utf8ByteLength("= Title\nbody\n"),
            sizeExact: true,
            duplicate: false,
          },
        ]);
      }
      // Exactly the two exact-sized LIVE files were materialized — never the
      // budget-exhausted ones, never the tombstone.
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("readFile refuses junk input without throwing (empty, non-string, over-long)", () => {
    const { surface } = fixture();
    expect(surface.readFile("")).toEqual({ ok: false, error: "path must be a non-empty string" });
    expect(surface.readFile(42 as unknown as string)).toEqual({
      ok: false,
      error: "path must be a non-empty string",
    });
    expect(surface.readFile(`/${"p".repeat(READ_LIMITS.maxPathChars)}`)).toEqual({
      ok: false,
      error: `path exceeds ${READ_LIMITS.maxPathChars} characters`,
    });
  });
});

/**
 * #16.2b — retrieval-aware WHOLE-project context. `projectContext` gives the
 * tool layer budget-limited, query-relevant excerpts across every live file,
 * with provenance (path + 1-based line range + heading path) — under the same
 * security posture as the other reads: metadata-first scan, hard work budgets,
 * structured skip accounting, never a throw, never an unbounded dump.
 */
describe("kernel tool surface — retrieval-aware project context (projectContext)", () => {
  function ctxFixture(files: [string, string][], target = files[0]?.[0] ?? "/main.typ") {
    const project = new CollabProject();
    for (const [path, text] of files) project.create(path, text, HUMAN);
    return { project, surface: createToolSurface(project, target, MCP) };
  }

  const QUANTUM = "= Quantum\n\nQuantum entanglement links distant particle states across space.\n";

  it("surfaces the file matching the query — with path, line-range, and heading provenance", () => {
    const { surface } = ctxFixture([
      ["/alpha.typ", `= Alpha\n\n${"filler words only here. ".repeat(20)}\n`],
      ["/beta.typ", QUANTUM],
    ]);
    const ctx = surface.projectContext("quantum entanglement particles", 256);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      // Only beta's chunk fits the 256-char budget; relevance ranked it first.
      expect(ctx.excerpts).toEqual([
        {
          path: "/beta.typ",
          startLine: 1,
          endLine: 3,
          headingPath: ["Quantum"],
          headingPathTruncated: false,
          text: QUANTUM,
          truncated: false,
        },
      ]);
      expect(ctx.selectionTruncated).toBe(true); // alpha's chunk did not fit
      expect(ctx.skipped).toEqual([]);
      expect(ctx.omitted).toBe(0);
      expect(ctx.filesTruncated).toBe(false);
      expect(ctx.scanTruncated).toBe(false);
    }
  });

  it("maps excerpt offsets to TRUE 1-based line ranges mid-file", () => {
    const secOne = `= One\n\n${"alpha ".repeat(60)}\n\n`;
    const secTwo = "= Two\nquantum entanglement lives here\n";
    const { surface } = ctxFixture([["/doc.typ", secOne + secTwo]]);
    const ctx = surface.projectContext("quantum entanglement", 256);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      // Section one occupies lines 1–4 (heading, blank, body, blank);
      // the selected section-two chunk is exactly lines 5–6.
      expect(ctx.excerpts).toEqual([
        {
          path: "/doc.typ",
          startLine: 5,
          endLine: 6,
          headingPath: ["Two"],
          headingPathTruncated: false,
          text: secTwo,
          truncated: false,
        },
      ]);
    }
  });

  it("returns excerpts in stable order (file order, then offset) regardless of rank — within the budget", () => {
    const { surface } = ctxFixture([
      ["/a.typ", "= Notes\nshared topic words here\n"],
      ["/empty.typ", ""],
      ["/z.typ", "= More\nshared topic words here too, twice the topic\n"],
    ]);
    const ctx = surface.projectContext("shared topic words");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.excerpts.map((e) => e.path)).toEqual(["/a.typ", "/z.typ"]);
      const total = ctx.excerpts.reduce((n, e) => n + e.text.length, 0);
      expect(total).toBeLessThanOrEqual(READ_LIMITS.defaultContextChars);
      expect(ctx.selectionTruncated).toBe(false); // everything fit
    }
  });

  it("EXCLUDES duplicate-path files from context and notes them in skipped (no silent winner, no content leak)", () => {
    const { surface } = ctxFixture([
      ["/main.typ", "= Title\nbody\n"],
      ["/dup.typ", "first secret\n"],
      ["/dup.typ", "second secret\n"],
    ]);
    const ctx = surface.projectContext("secret");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.skipped).toEqual([
        { path: "/dup.typ", reason: "duplicate-path" },
        { path: "/dup.typ", reason: "duplicate-path" },
      ]);
      expect(ctx.excerpts.map((e) => e.path)).toEqual(["/main.typ"]);
      for (const e of ctx.excerpts) expect(e.text).not.toContain("secret");
    }
  });

  it("skips an over-cap file from the O(1) length alone — its text (and any tombstone's) is NEVER materialized", () => {
    const { project, surface } = ctxFixture([["/main.typ", "= Title\nbody\n"]]);
    project.create("/huge.typ", "x".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
    const dead = project.create("/dead.typ", "y".repeat(READ_LIMITS.maxFileBytes + 1), HUMAN);
    project.delete(dead, HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const ctx = surface.projectContext("title body");
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.skipped).toEqual([{ path: "/huge.typ", reason: "over-cap" }]);
        expect(ctx.excerpts.map((e) => e.path)).toEqual(["/main.typ"]);
        expect(ctx.scanTruncated).toBe(false);
      }
      expect(spy).toHaveBeenCalledTimes(1); // /main.typ only
    } finally {
      spy.mockRestore();
    }
  });

  it("stops materializing at the cumulative scan budget — later files (even tiny ones) are budget-skipped, flagged, never touched", () => {
    // Five in-cap files (each EXACTLY the per-file cap, so the over-cap gate
    // does not fire) against the 8Mi cumulative budget: a–d consume it
    // exactly; e and everything after are budget-skipped without a read.
    const cap = READ_LIMITS.maxFileBytes;
    const { project, surface } = ctxFixture([["/big-a.typ", "a".repeat(cap)]]);
    project.create("/big-b.typ", "b".repeat(cap), HUMAN);
    project.create("/big-c.typ", "c".repeat(cap), HUMAN);
    project.create("/big-d.typ", "d".repeat(cap), HUMAN);
    project.create("/big-e.typ", "e".repeat(cap), HUMAN);
    project.create("/zz-tiny.typ", "tiny\n", HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const ctx = surface.projectContext("tiny");
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.scanTruncated).toBe(true);
        // Stop-early semantics: once the budget is hit, EVERY later file is
        // budget-skipped — including a tiny one that would have fit.
        expect(ctx.skipped).toEqual([
          { path: "/big-e.typ", reason: "scan-budget" },
          { path: "/zz-tiny.typ", reason: "scan-budget" },
        ]);
        // The materialized files still yield a HARD-bounded excerpt: the best
        // single cap-size paragraph chunk is cut to the response budget,
        // minus its charged provenance metadata (path + overhead).
        expect(ctx.excerpts).toHaveLength(1);
        expect(ctx.excerpts[0]).toMatchObject({
          path: "/big-a.typ",
          startLine: 1,
          endLine: 1,
          truncated: true,
        });
        expect(ctx.excerpts[0]!.text.length).toBe(
          READ_LIMITS.defaultContextChars -
            "/big-a.typ".length -
            READ_LIMITS.excerptOverheadChars,
        );
        expect(ctx.selectionTruncated).toBe(true);
      }
      expect(spy).toHaveBeenCalledTimes(4); // /big-a.typ … /big-d.typ only
    } finally {
      spy.mockRestore();
    }
  });

  it("enforces the response budget even when the single best chunk is over-budget (prefix excerpt, honest flag)", () => {
    const line = `${"x".repeat(100)}\n`;
    const { surface } = ctxFixture([["/wall.typ", line.repeat(100)]]);
    const ctx = surface.projectContext("anything", 256);
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      // The fallback prefix is the budget minus the excerpt's charged
      // provenance metadata (path + overhead) — the WHOLE record is bounded.
      const room = 256 - "/wall.typ".length - READ_LIMITS.excerptOverheadChars;
      expect(ctx.excerpts).toEqual([
        {
          path: "/wall.typ",
          startLine: 1,
          endLine: 2, // the prefix reaches into the second 101-char line
          headingPath: [],
          headingPathTruncated: false,
          text: line.repeat(100).slice(0, room),
          truncated: true,
        },
      ]);
      expect(ctx.selectionTruncated).toBe(true);
    }
  });

  it("caps the excerpt COUNT — the provenance metadata channel stays bounded under thousands of tiny chunks", () => {
    const { surface } = ctxFixture([["/shards.typ", "= h\n\n".repeat(300)]]);
    const ctx = surface.projectContext("h");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.excerpts.length).toBeLessThanOrEqual(READ_LIMITS.maxContextExcerpts);
      expect(ctx.selectionTruncated).toBe(true);
    }
  });

  it("hides forged over-long paths entirely (counted in omitted, never echoed)", () => {
    const { project, surface } = ctxFixture([["/main.typ", "= Title\nbody\n"]]);
    project.create(`/${"a".repeat(READ_LIMITS.maxPathChars + 100)}.typ`, "x", HUMAN);
    const ctx = surface.projectContext("title");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.omitted).toBe(1);
      expect(ctx.skipped).toEqual([]);
      expect(ctx.excerpts.map((e) => e.path)).toEqual(["/main.typ"]);
    }
  });

  it("never considers live files past READ_LIMITS.maxListEntries (hostile many-file rooms stay bounded)", () => {
    const { project, surface } = ctxFixture([["/a-main.typ", "= Title\nbody\n"]]);
    for (let i = 0; i < READ_LIMITS.maxListEntries; i++) {
      project.create(`/f${String(i).padStart(4, "0")}.typ`, "x", HUMAN);
    }
    const ctx = surface.projectContext("title");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) expect(ctx.filesTruncated).toBe(true);
  });

  it("refuses junk input without throwing (empty/non-string/over-long query; out-of-range budget)", () => {
    const { surface } = ctxFixture([["/main.typ", "= Title\nbody\n"]]);
    expect(surface.projectContext("")).toEqual({
      ok: false,
      error: "query must be a non-empty string",
    });
    expect(surface.projectContext(42 as unknown as string)).toEqual({
      ok: false,
      error: "query must be a non-empty string",
    });
    expect(surface.projectContext("q".repeat(READ_LIMITS.maxQueryChars + 1))).toEqual({
      ok: false,
      error: `query exceeds ${READ_LIMITS.maxQueryChars} characters`,
    });
    const budgetError = {
      ok: false,
      error: `budget must be an integer between ${READ_LIMITS.minContextChars} and ${READ_LIMITS.maxContextChars}`,
    };
    expect(surface.projectContext("ok", READ_LIMITS.minContextChars - 1)).toEqual(budgetError);
    expect(surface.projectContext("ok", READ_LIMITS.maxContextChars + 1)).toEqual(budgetError);
    expect(surface.projectContext("ok", 1000.5)).toEqual(budgetError);
    expect(surface.projectContext("ok", Number.NaN)).toEqual(budgetError);
  });

  it("projectContext is a pure read — nothing mutates, nothing is published", () => {
    const { project, surface } = ctxFixture([
      ["/main.typ", "= Title\nbody\n"],
      ["/notes.typ", "notes\n"],
    ]);
    const before = project.snapshot();
    surface.projectContext("notes");
    expect(project.snapshot()).toEqual(before);
    expect(getPendingProposals(project)).toHaveLength(0);
  });

  it("answers honestly over an empty project (no excerpts, nothing skipped)", () => {
    const project = new CollabProject();
    const surface = createToolSurface(project, "/main.typ", MCP);
    expect(surface.projectContext("anything")).toEqual({
      ok: true,
      excerpts: [],
      skipped: [],
      omitted: 0,
      filesTruncated: false,
      scanTruncated: false,
      chunksTruncated: false,
      selectionTruncated: false,
    });
  });

  // --- Security round 2: metadata bounds, UTF-8 parity, chunk-storm cap ------

  it("bounds headingPath provenance — a megabyte-scale hostile heading cannot ride the metadata channel past the budget", () => {
    // An in-cap file whose parent heading is enormous: every child chunk's
    // headingPath would otherwise repeat it verbatim, once per excerpt.
    const huge = `H${"x".repeat(300_000)}`;
    const body = `= ${huge}\n\n${"== sub\ntopic words here\n\n".repeat(40)}`;
    const { surface } = ctxFixture([["/bomb.typ", body]]);
    const ctx = surface.projectContext("topic words");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      expect(ctx.excerpts.length).toBeGreaterThan(0);
      for (const e of ctx.excerpts) {
        for (const h of e.headingPath) {
          // Each entry is cut to the cap (+1 for the ellipsis marker).
          expect(h.length).toBeLessThanOrEqual(READ_LIMITS.maxHeadingChars + 1);
        }
      }
      expect(ctx.excerpts.some((e) => e.headingPathTruncated)).toBe(true);
      // The SERIALIZED excerpt records stay budget-scale — not heading-scale.
      expect(JSON.stringify(ctx.excerpts).length).toBeLessThan(
        2 * READ_LIMITS.defaultContextChars,
      );
    }
  });

  it("caps headingPath DEPTH — hostile deep nesting keeps provenance (and ranking) bounded", () => {
    let body = "";
    for (let i = 1; i <= 20; i++) body += `${"=".repeat(i)} h${i}\n`;
    body += "needle paragraph\n";
    const { surface } = ctxFixture([["/deep.typ", body]]);
    const ctx = surface.projectContext("needle paragraph");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      const hit = ctx.excerpts.find((e) => e.text.includes("needle"));
      expect(hit).toBeDefined();
      // Only the most specific maxHeadingDepth entries survive, flagged.
      expect(hit!.headingPath).toEqual(
        Array.from({ length: READ_LIMITS.maxHeadingDepth }, (_, i) => `h${20 - READ_LIMITS.maxHeadingDepth + 1 + i}`),
      );
      expect(hit!.headingPathTruncated).toBe(true);
    }
  });

  it("skips a multibyte file whose EXACT UTF-8 size exceeds the cap — projectContext never reads what readFile refuses", () => {
    const { project, surface } = ctxFixture([["/main.typ", "= Title\nbody\n"]]);
    // UTF-16 length is in-cap (the O(1) lower bound passes) but every char is
    // 2 UTF-8 bytes — the exact size is over the cap.
    const sneaky = "é".repeat(READ_LIMITS.maxFileBytes / 2 + 1);
    project.create("/sneaky.typ", sneaky, HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const ctx = surface.projectContext("title");
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.skipped).toEqual([{ path: "/sneaky.typ", reason: "over-cap" }]);
        expect(ctx.excerpts.map((e) => e.path)).toEqual(["/main.typ"]);
        for (const e of ctx.excerpts) expect(e.text).not.toContain("é");
      }
      // The exact check REQUIRES materializing (that work is charged to the
      // scan budget) — but only once, and the content never surfaces.
      expect(spy).toHaveBeenCalledTimes(2); // /main.typ + the one sizing read
    } finally {
      spy.mockRestore();
    }
    // Parity pin: read_file refuses the very same file.
    const read = surface.readFile("/sneaky.typ");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("read cap");
  });

  it("caps chunk CREATION (not just retention) at maxContextChunks — a ~2 MiB heading storm is prefix-chunked and its tail provably never enters ranking", () => {
    // ~349k tiny heading sections, no blank lines (so the estimator is tight),
    // with a UNIQUE needle in the very last section. If the whole body were
    // ever chunked, the needle chunk would dominate the BM25 ranking for the
    // query below — its absence pins that chunking stopped at the prefix.
    const storm = `${"= h\nx\n".repeat(349_000)}= last\nneedle target paragraph\n`;
    expect(storm.length).toBeLessThanOrEqual(READ_LIMITS.maxFileBytes); // in-cap
    const { project, surface } = ctxFixture([["/a-storm.typ", storm]]);
    // A later file whose FIRST line is a heading: no chunk capacity remains
    // for a new section, so it is refused whole ("chunk-cap"), unread by the
    // chunker — while a plain tiny file after it still fits.
    project.create("/m-heading.typ", "= boom\nmore needle text\n", HUMAN);
    project.create("/zz-calm.typ", "calm words\n", HUMAN);
    const spy = // toString lives on the yjs AbstractType prototype, outside vitest's typed
    // method-key union — a structural cast keeps the runtime spy + strict types.
    vi.spyOn(Y.Text.prototype as unknown as { toString(): string }, "toString");
    try {
      const ctx = surface.projectContext("needle calm words");
      expect(ctx.ok).toBe(true);
      if (ctx.ok) {
        expect(ctx.chunksTruncated).toBe(true);
        expect(ctx.skipped).toEqual([{ path: "/m-heading.typ", reason: "chunk-cap" }]);
        // The needle (storm tail + skipped file) never entered the ranking set.
        expect(ctx.excerpts.every((e) => !e.text.includes("needle"))).toBe(true);
        // Capacity-based, not stop-early: the tiny later file still made it.
        expect(ctx.excerpts.some((e) => e.path === "/zz-calm.typ")).toBe(true);
        expect(ctx.excerpts.length).toBeLessThanOrEqual(READ_LIMITS.maxContextExcerpts);
      }
      // All three files were sized/estimated (one read each) — bounded work.
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("estimateChunks is a TRUE upper bound on chunkDocument's yield (the creation cap rests on it)", () => {
    const bodies = [
      "",
      "plain paragraph\n",
      "x".repeat(10_000), // one huge blank-line-free paragraph -> 1 chunk
      "= h\n\n".repeat(300), // blank-line heading storm
      "= h\nx\n".repeat(300), // dense heading storm, no blanks
      `= A\n${"x".repeat(5000)}\n\npara two\n\n= B\nz\n`, // oversized section splits
      "one\n\ntwo\n\nthree\n\n",
      `${"=".repeat(10)} deep\nbody\n= top\n${"y".repeat(2500)}\n`,
      "=not-a-heading\n= \t \n  \nreal text\n", // malformed headings / ws-only lines
    ];
    for (const body of bodies) {
      expect(chunkDocument(body).length).toBeLessThanOrEqual(estimateChunks(body));
    }
  });

  it("chunkSafePrefix bounds the chunker's INPUT: a ~2 MiB storm is cut to a tiny line-boundary prefix whose estimate fits capacity", () => {
    const storm = "= h\nx\n".repeat(349_000);
    const cut = chunkSafePrefix(storm, READ_LIMITS.maxContextChunks);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(storm.length / 50); // the chunker never sees ~2 MiB
    expect(storm.charCodeAt(cut - 1)).toBe(10); // cut lands on a line boundary
    expect(estimateChunks(storm.slice(0, cut))).toBeLessThanOrEqual(
      READ_LIMITS.maxContextChunks,
    );
  });

  it("never splits a surrogate pair when cutting a hostile heading", () => {
    const title = `${"x".repeat(READ_LIMITS.maxHeadingChars - 1)}😀rest`;
    const { surface } = ctxFixture([["/emoji.typ", `= ${title}\n\ncontent words here\n`]]);
    const ctx = surface.projectContext("content words");
    expect(ctx.ok).toBe(true);
    if (ctx.ok) {
      // The cut would land mid-😀 (a surrogate pair): it backs off one unit.
      expect(ctx.excerpts[0]?.headingPath).toEqual([
        `${"x".repeat(READ_LIMITS.maxHeadingChars - 1)}…`,
      ]);
      expect(ctx.excerpts[0]?.headingPathTruncated).toBe(true);
    }
  });
});

/**
 * Task 3 (ADR-0025 §5): the surface tags one agent run's proposals with one
 * `runId`, persists the run boundary in the CRDT (`mcpRuns`), and closes the run
 * on idle. `runId`/run-state is a UI grouping hint ONLY — it never gates apply.
 */
describe("kernel tool surface — run boundaries (runId tagging + idle-close)", () => {
  const SINGLE = {
    baseText: "= Title\nbody\n",
    proposedText: "= Title\nbody\nmore\n",
    blocks: [{ search: "body\n", replace: "body\nmore\n" }],
    request: "more",
  };

  function runFixture(idleMs = RUN_IDLE_MS) {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    let clock = 1000;
    const surface = createToolSurface(project, "/main.typ", MCP, undefined, {
      runIdleMs: idleMs,
      now: () => clock,
    });
    return { project, surface, advanceClock: (ms: number) => (clock += ms) };
  }

  it("two proposals in one open run share ONE runId and mark the run open", async () => {
    const { project, surface } = runFixture();
    await surface.publishProposal(SINGLE);
    await surface.publishFileProposal({
      request: "intro",
      ops: [{ kind: "create", path: "/intro.typ", baseText: "", proposedText: "= Intro\n", blocks: [] }],
    });

    const { groups } = getPendingRunGroups(project);
    // Both records collapse into ONE run group with a shared runId, marked open.
    expect(groups).toHaveLength(1);
    expect(groups[0]!.records).toHaveLength(2);
    expect(groups[0]!.streaming).toBe(true);
    const runId = groups[0]!.runId;
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThanOrEqual(32); // CSPRNG, not a record id
    expect(readRunOpen(project, runId)).toBe(true);
  });

  it("idle-close marks the run closed after RUN_IDLE_MS with no new proposal", async () => {
    vi.useFakeTimers();
    try {
      const { project, surface, advanceClock } = runFixture(50);
      const id = await surface.publishProposal(SINGLE);
      const runId = getPendingRunGroups(project).groups[0]!.runId;
      expect(readRunOpen(project, runId)).toBe(true);

      advanceClock(50);
      vi.advanceTimersByTime(50);
      expect(readRunOpen(project, runId)).toBe(false);
      // The record is still pending (idle-close never accepts/rejects anything).
      expect(getPendingProposals(project).map((p) => p.id)).toEqual([id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NEW run after an idle-close gets a fresh, distinct runId", async () => {
    vi.useFakeTimers();
    try {
      const { project, surface, advanceClock } = runFixture(50);
      await surface.publishProposal(SINGLE);
      const firstRun = getPendingRunGroups(project).groups[0]!.runId;

      advanceClock(50);
      vi.advanceTimersByTime(50); // close the first run
      expect(readRunOpen(project, firstRun)).toBe(false);

      await surface.publishProposal(SINGLE);
      const groups = getPendingRunGroups(project).groups;
      const secondRun = groups.find((g) => g.streaming)!.runId;
      expect(secondRun).not.toBe(firstRun);
      expect(readRunOpen(project, secondRun)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a proposal within the idle window EXTENDS the run (no close, same runId)", async () => {
    vi.useFakeTimers();
    try {
      const { project, surface, advanceClock } = runFixture(100);
      await surface.publishProposal(SINGLE);
      const runId = getPendingRunGroups(project).groups[0]!.runId;

      advanceClock(60);
      vi.advanceTimersByTime(60); // before idle — still open
      expect(readRunOpen(project, runId)).toBe(true);
      await surface.publishProposal(SINGLE); // resets the idle timer
      expect(getPendingRunGroups(project).groups[0]!.runId).toBe(runId);

      advanceClock(60);
      vi.advanceTimersByTime(60); // 60ms since the 2nd publish — still under 100
      expect(readRunOpen(project, runId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the run timer never gates apply — closing a run leaves records pending and acceptable", async () => {
    vi.useFakeTimers();
    try {
      const { project, surface, advanceClock } = runFixture(50);
      const id = await surface.publishProposal(SINGLE);
      const runId = getPendingRunGroups(project).groups[0]!.runId;
      advanceClock(50);
      vi.advanceTimersByTime(50);
      expect(readRunOpen(project, runId)).toBe(false);
      // A human can still accept the (closed-run) record — boundary is UI-only.
      resolveProposal(project, id, "accepted", HUMAN);
      expect(getPendingProposals(project)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("read-cap overrides (D2)", () => {
  it("honors an injected lower maxFileBytes (a file in the default cap is now refused)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "0123456789", HUMAN); // 10 UTF-8 bytes
    const surface = createToolSurface(project, "/main.typ", MCP, undefined, {
      readLimits: { maxFileBytes: 4 },
    });
    const read = surface.readFile("/main.typ");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/over the 4-byte read cap/);
  });

  it("honors an injected lower maxListEntries (excess marked truncated)", () => {
    const project = new CollabProject();
    project.create("/a.typ", "a", HUMAN);
    project.create("/b.typ", "b", HUMAN);
    project.create("/c.typ", "c", HUMAN);
    const surface = createToolSurface(project, "/a.typ", MCP, undefined, {
      readLimits: { maxListEntries: 2 },
    });
    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.files).toHaveLength(2);
      expect(listed.truncated).toBe(true);
    }
  });

  it("honors an injected lower defaultContextChars (used when no budget is passed)", () => {
    const project = new CollabProject();
    // Two distinct sections so selection has room to truncate under a tiny budget.
    project.create("/main.typ", "= One\nalpha alpha alpha\n\n= Two\nbeta beta beta\n", HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP, undefined, {
      readLimits: { defaultContextChars: READ_LIMITS.minContextChars },
    });
    const tiny = surface.projectContext("alpha");
    const big = surface.projectContext("alpha", READ_LIMITS.maxContextChars);
    expect(tiny.ok && big.ok).toBe(true);
    if (tiny.ok && big.ok) {
      // The tiny default budget can carry no more excerpt text than the big one.
      const sum = (o: typeof tiny & { ok: true }): number =>
        o.excerpts.reduce((n, e) => n + e.text.length, 0);
      expect(sum(tiny)).toBeLessThanOrEqual(sum(big));
    }
  });

  it("with no overrides the surface uses the READ_LIMITS defaults (unchanged)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "x".repeat(READ_LIMITS.maxFileBytes), HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);
    const read = surface.readFile("/main.typ");
    // Exactly at the default cap → still allowed (proves the default is in force).
    expect(read.ok).toBe(true);
  });
});

describe("read_file — binary pointer (A3)", () => {
  const ASSET = {
    type: "binary" as const,
    hash: "f".repeat(64),
    size: 2048,
    mime: "image/png",
  };

  it("returns structured pointer metadata for a binary file, never text", () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    project.createBinary("/logo.png", ASSET, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const read = surface.readFile("/logo.png");
    expect(read.ok).toBe(true);
    expect(read).toEqual({
      ok: true,
      kind: "binary",
      path: "/logo.png",
      hash: ASSET.hash,
      size: ASSET.size,
      mime: ASSET.mime,
    });
    // No `text` field leaks for a binary read.
    expect("text" in read).toBe(false);
  });

  it("returns text unchanged for a text file (binary detection never alters text reads)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\nbody\n", HUMAN);
    project.createBinary("/logo.png", ASSET, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const read = surface.readFile("/main.typ");
    expect(read).toEqual({ ok: true, path: "/main.typ", text: "= Title\nbody\n" });
  });

  it("excludes a tombstoned binary file (deleted → not present)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "x", HUMAN);
    const id = project.createBinary("/logo.png", ASSET, HUMAN);
    project.deleteBinary(id, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const read = surface.readFile("/logo.png");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/not present in this room/);
  });

  it("refuses a text↔binary path collision as a duplicate-path conflict", () => {
    const project = new CollabProject();
    project.create("/clash.typ", "text", HUMAN);
    project.createBinary("/clash.typ", ASSET, HUMAN);
    const surface = createToolSurface(project, "/clash.typ", MCP);

    const read = surface.readFile("/clash.typ");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/duplicate-path conflict/);
  });
});

describe("listFiles — binary entries (F14)", () => {
  const ASSET = {
    type: "binary" as const,
    hash: "a".repeat(64),
    size: 4096,
    mime: "image/svg+xml",
  };

  it("surfaces a live binary file with a {kind:'binary', hash, mime} pointer + exact pointer size", () => {
    const project = new CollabProject();
    project.create("/main.typ", "= Title\n", HUMAN);
    project.createBinary("/pictures/fig.svg", ASSET, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const fig = listed.files.find((f) => f.path === "/pictures/fig.svg");
    expect(fig).toEqual({
      path: "/pictures/fig.svg",
      sizeBytes: ASSET.size,
      sizeExact: true,
      duplicate: false,
      kind: "binary",
      hash: ASSET.hash,
      mime: ASSET.mime,
    });
    // The agent can now feed that path straight to read_file.
    expect(surface.readFile("/pictures/fig.svg")).toEqual({
      ok: true,
      kind: "binary",
      path: "/pictures/fig.svg",
      hash: ASSET.hash,
      size: ASSET.size,
      mime: ASSET.mime,
    });
  });

  it("text rows stay byte-for-byte unchanged (no kind/hash/mime keys) when binaries are present", () => {
    const project = new CollabProject();
    project.create("/main.typ", "body\n", HUMAN);
    project.createBinary("/logo.png", ASSET, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const text = listed.files.find((f) => f.path === "/main.typ");
    expect(text).toEqual({
      path: "/main.typ",
      sizeBytes: utf8ByteLength("body\n"),
      sizeExact: true,
      duplicate: false,
    });
    expect(text && "kind" in text).toBe(false);
  });

  it("flags a text↔binary path collision as duplicate on BOTH rows (parity with read_file)", () => {
    const project = new CollabProject();
    project.create("/clash.typ", "text", HUMAN);
    project.createBinary("/clash.typ", ASSET, HUMAN);
    const surface = createToolSurface(project, "/clash.typ", MCP);

    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = listed.files.filter((f) => f.path === "/clash.typ");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.duplicate)).toBe(true);
    // read_file refuses the same collision — the two seams agree.
    expect(surface.readFile("/clash.typ").ok).toBe(false);
  });

  it("a binary's size never draws down the text sizing budget (binaries size from their pointer)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "x", HUMAN);
    // A binary whose pointer size dwarfs the whole sizing budget must NOT flip a
    // following text file to an inexact lower-bound.
    project.createBinary("/huge.bin", {
      type: "binary",
      hash: "b".repeat(64),
      size: READ_LIMITS.maxSizingChars * 10,
      mime: "application/octet-stream",
    }, HUMAN);
    project.create("/after.typ", "still-exact\n", HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const after = listed.files.find((f) => f.path === "/after.typ");
    expect(after?.sizeExact).toBe(true);
    expect(after?.sizeBytes).toBe(utf8ByteLength("still-exact\n"));
  });

  it("omits a binary entry with a forged over-long path (counted in `omitted`, like text)", () => {
    const project = new CollabProject();
    project.create("/main.typ", "x", HUMAN);
    project.createBinary(`/${"z".repeat(READ_LIMITS.maxPathChars + 50)}.png`, ASSET, HUMAN);
    const surface = createToolSurface(project, "/main.typ", MCP);

    const listed = surface.listFiles();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.files.map((f) => f.path)).toEqual(["/main.typ"]);
    expect(listed.omitted).toBe(1);
  });
});
