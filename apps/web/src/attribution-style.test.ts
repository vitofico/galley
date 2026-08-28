import { describe, it, expect } from "vitest";
import type { Author } from "@galley/shared";
import { authorKey, authorColor, authorLabel, ANON_AUTHOR_LABEL } from "./attribution-style.js";

const ALICE: Author = { kind: "human", userId: "alice" };
const BOB: Author = { kind: "human", userId: "bob" };
const AGENT: Author = { kind: "agent", runId: "run-7" };

describe("attribution style helpers", () => {
  it("derives a stable key per author identity", () => {
    expect(authorKey(ALICE)).toBe("human:alice");
    expect(authorKey(AGENT)).toBe("agent:run-7");
  });

  it("labels humans as Editor and the agent as Agent", () => {
    expect(authorLabel(ALICE)).toBe("Editor");
    expect(authorLabel(AGENT)).toBe("Agent");
  });

  it("names the anonymous label as ANON_AUTHOR_LABEL and drives authorLabel from it", () => {
    // The single source of truth the commit save-path must adopt, so an
    // anonymous saver's author name equals their contributor label and the
    // self-co-author suppression fires. See version-message's suppression test.
    expect(ANON_AUTHOR_LABEL).toBe("Editor");
    expect(authorLabel({ kind: "human", userId: "anon" })).toBe(ANON_AUTHOR_LABEL);
    expect(authorLabel({ kind: "human", userId: "anon", name: "   " })).toBe(ANON_AUTHOR_LABEL);
  });

  it("shows a human's display name when one travels with the author (#19.4)", () => {
    expect(authorLabel({ kind: "human", userId: "alice", name: "Alice P." })).toBe("Alice P.");
    // Blank names degrade to the anonymous label, never an empty string.
    expect(authorLabel({ kind: "human", userId: "alice", name: "   " })).toBe("Editor");
  });

  it("keeps the identity key and color on userId, regardless of the name", () => {
    const named: Author = { kind: "human", userId: "alice", name: "Alice P." };
    expect(authorKey(named)).toBe("human:alice");
    expect(authorColor(named)).toBe(authorColor(ALICE));
  });

  it("assigns a deterministic color per identity", () => {
    expect(authorColor(ALICE)).toBe(authorColor({ kind: "human", userId: "alice" }));
    expect(authorColor(ALICE)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("gives different identities distinguishable colors where possible", () => {
    // Not a guarantee (palette is finite), but alice/bob/agent should differ here.
    const colors = new Set([authorColor(ALICE), authorColor(BOB), authorColor(AGENT)]);
    expect(colors.size).toBeGreaterThan(1);
  });
});
