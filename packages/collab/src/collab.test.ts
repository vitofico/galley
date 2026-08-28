import { describe, it, expect } from "vitest";
import type { Author } from "@galley/shared";
import { CollabDocument, applyAgentEdits, seedIfPristine } from "./index.js";

const HUMAN: Author = { kind: "human", userId: "u1" };
const AGENT: Author = { kind: "agent", runId: "r1" };

describe("seedIfPristine", () => {
  it("seeds initial content into a fresh (pristine) document", () => {
    const doc = new CollabDocument("");
    const seeded = seedIfPristine(doc, "= Title\nbody\n", HUMAN);
    expect(seeded).toBe(true);
    expect(doc.getSource()).toBe("= Title\nbody\n");
  });

  it("does NOT re-seed a document that already has content (the duplication footgun)", () => {
    // Simulates a persisted draft loaded into the doc before seeding runs:
    // re-seeding would merge to duplicated CRDT text. It must be a no-op.
    const doc = new CollabDocument("restored draft\n");
    const seeded = seedIfPristine(doc, "= Title\nbody\n", HUMAN);
    expect(seeded).toBe(false);
    expect(doc.getSource()).toBe("restored draft\n");
  });

  it("does NOT re-seed a deliberately-emptied draft (text empty but has history)", () => {
    // The delete-all footgun: a draft the user cleared still carries CRDT
    // history, so it must NOT resurrect the template on reload.
    const doc = new CollabDocument("");
    doc.transact((t) => t.insert(0, "my draft"), HUMAN);
    doc.transact((t) => t.delete(0, t.length), HUMAN);
    expect(doc.getSource()).toBe("");
    const seeded = seedIfPristine(doc, "= Title\nbody\n", HUMAN);
    expect(seeded).toBe(false);
    expect(doc.getSource()).toBe("");
  });

  it("is a no-op when the initial content is empty", () => {
    const doc = new CollabDocument("");
    const seeded = seedIfPristine(doc, "", HUMAN);
    expect(seeded).toBe(false);
    expect(doc.getSource()).toBe("");
  });

  it("tags the seed transaction with the author origin", () => {
    const doc = new CollabDocument("");
    let origin: unknown;
    const off = doc.onUpdate((_u, o) => (origin = o));
    seedIfPristine(doc, "hello", HUMAN);
    off();
    expect(origin).toBe("human:u1");
  });
});

describe("CollabDocument", () => {
  it("holds the source and seeds a fresh peer via an update", () => {
    const a = new CollabDocument("= Title\nbody\n");
    expect(a.getSource()).toBe("= Title\nbody\n");
    const b = new CollabDocument();
    b.applyUpdate(a.encodeState());
    expect(b.getSource()).toBe("= Title\nbody\n");
  });

  it("tags transactions with the author origin", () => {
    const a = new CollabDocument("hi");
    let origin: unknown;
    const off = a.onUpdate((_u, o) => (origin = o));
    applyAgentEdits(a, [{ search: "hi", replace: "bye" }], { kind: "agent", runId: "r9" });
    off();
    expect(origin).toBe("agent:r9");
    expect(a.getSource()).toBe("bye");
  });
});

describe("applyAgentEdits — the agent as a peer", () => {
  it("applies search/replace blocks to the CRDT doc", () => {
    const doc = new CollabDocument("hello world");
    const r = applyAgentEdits(doc, [{ search: "world", replace: "Typst" }], AGENT);
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("hello Typst");
  });

  it("applies multiple blocks sequentially in one transaction", () => {
    const doc = new CollabDocument("a b c");
    let updates = 0;
    const off = doc.onUpdate(() => (updates += 1));
    const r = applyAgentEdits(
      doc,
      [
        { search: "a", replace: "x" },
        { search: "x b", replace: "y" }, // sees the first block's replacement
      ],
      AGENT,
    );
    off();
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("y c");
    expect(updates).toBe(1); // one atomic transaction
  });

  it("is all-or-nothing and never clobbers on a non-unique match", () => {
    const doc = new CollabDocument("hello world");
    const r = applyAgentEdits(
      doc,
      [
        { search: "hello", replace: "hi" },
        { search: "absent", replace: "x" }, // fails
      ],
      AGENT,
    );
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.reason)).toEqual(["no_match"]);
    expect(doc.getSource()).toBe("hello world"); // untouched
  });
});

describe("hardening — line endings and astral-character safety", () => {
  it("edits a CRLF document at the correct position without corruption", () => {
    // The agent loop normalizes to "\n"; the live doc may hold CRLF. The ops
    // must still land in the raw document's own coordinates.
    const doc = new CollabDocument("line1\r\nline2\r\nline3\r\n");
    const r = applyAgentEdits(doc, [{ search: "line2", replace: "LINE2" }], AGENT);
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("line1\r\nLINE2\r\nline3\r\n");
  });

  it("matches a multi-line search across CRLF boundaries (agent emits \\n)", () => {
    const doc = new CollabDocument("alpha\r\nbeta\r\ngamma");
    const r = applyAgentEdits(doc, [{ search: "alpha\nbeta", replace: "X" }], AGENT);
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("X\r\ngamma");
  });

  it("preserves the document's CRLF convention in inserted lines", () => {
    const doc = new CollabDocument("head\r\ntail\r\n");
    const r = applyAgentEdits(doc, [{ search: "tail", replace: "a\nb" }], AGENT);
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("head\r\na\r\nb\r\n"); // no mixed endings
  });

  it("positions edits correctly after astral (multi-code-unit) characters", () => {
    const doc = new CollabDocument("😀 hello 🌍 world");
    const r = applyAgentEdits(doc, [{ search: "world", replace: "Typst" }], AGENT);
    expect(r.ok).toBe(true);
    expect(doc.getSource()).toBe("😀 hello 🌍 Typst");
  });

  it("treats an empty search as a no_match, not a clobber", () => {
    const doc = new CollabDocument("content");
    const r = applyAgentEdits(doc, [{ search: "", replace: "x" }], AGENT);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.reason)).toEqual(["no_match"]);
    expect(doc.getSource()).toBe("content");
  });

  it("converges with no clobber when the base document uses CRLF", () => {
    const peerA = new CollabDocument("Hello world\r\nGoodbye world\r\n");
    const peerB = new CollabDocument();
    peerB.applyUpdate(peerA.encodeState());
    peerB.transact((text) => text.insert(text.length, "Added by a human.\r\n"), HUMAN);
    expect(applyAgentEdits(peerA, [{ search: "Hello", replace: "Hi" }], AGENT).ok).toBe(true);
    peerA.applyUpdate(peerB.encodeStateSince(peerA.stateVector()));
    peerB.applyUpdate(peerA.encodeStateSince(peerB.stateVector()));
    expect(peerA.getSource()).toBe(peerB.getSource());
    expect(peerA.getSource()).toContain("Hi world");
    expect(peerA.getSource()).toContain("Added by a human.");
  });
});

describe("agent + human edits merge conflict-free (the payoff)", () => {
  it("converges with no clobber when a human and the agent edit concurrently", () => {
    // Two peers start from the same document.
    const peerA = new CollabDocument("Hello world\nGoodbye world\n");
    const peerB = new CollabDocument();
    peerB.applyUpdate(peerA.encodeState());
    expect(peerB.getSource()).toBe(peerA.getSource());

    // Concurrently: a human appends a line on peer B...
    peerB.transact((text) => text.insert(text.length, "Added by a human.\n"), HUMAN);
    // ...and the agent edits a DISJOINT region on peer A.
    const r = applyAgentEdits(peerA, [{ search: "Hello", replace: "Hi" }], AGENT);
    expect(r.ok).toBe(true);

    // Exchange updates (no websocket — just hand the bytes over).
    const fromA = peerA.encodeStateSince(peerB.stateVector());
    const fromB = peerB.encodeStateSince(peerA.stateVector());
    peerA.applyUpdate(fromB);
    peerB.applyUpdate(fromA);

    // Both converge to the SAME text containing BOTH edits — neither clobbered.
    expect(peerA.getSource()).toBe(peerB.getSource());
    expect(peerA.getSource()).toContain("Hi world");
    expect(peerA.getSource()).toContain("Added by a human.");
  });

  it("an agent edit and a human edit inside the same line both survive", () => {
    const peerA = new CollabDocument("the quick brown fox\n");
    const peerB = new CollabDocument();
    peerB.applyUpdate(peerA.encodeState());

    // Human changes "quick" -> "quickest" on B; agent changes "fox" -> "cat" on A.
    peerB.transact((text) => {
      const i = text.toString().indexOf("quick") + "quick".length;
      text.insert(i, "est");
    }, HUMAN);
    applyAgentEdits(peerA, [{ search: "fox", replace: "cat" }], AGENT);

    peerA.applyUpdate(peerB.encodeStateSince(peerA.stateVector()));
    peerB.applyUpdate(peerA.encodeStateSince(peerB.stateVector()));

    expect(peerA.getSource()).toBe(peerB.getSource());
    expect(peerA.getSource()).toBe("the quickest brown cat\n");
  });
});
