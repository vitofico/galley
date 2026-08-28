import { describe, it, expect } from "vitest";
import {
  activeMentionQuery,
  resolveFileMentions,
  suggestMentions,
  composeAgentRequest,
  MENTION_ATTACH_MAX_CHARS,
  type MentionableFile,
} from "./agent-mentions.js";

const FILES: MentionableFile[] = [
  { path: "/main.typ", text: "= Main\nbody" },
  { path: "/chapters/intro.typ", text: "= Intro" },
  { path: "/refs.bib", text: "@book{a, title={A}}" },
];

describe("agent-mentions.activeMentionQuery", () => {
  it("returns the tail query after a just-typed @ (possibly empty)", () => {
    expect(activeMentionQuery("look at @")).toBe("");
    expect(activeMentionQuery("look at @main")).toBe("main");
    expect(activeMentionQuery("@/chapters/in")).toBe("/chapters/in");
  });
  it("is null when the tail isn't an open mention", () => {
    expect(activeMentionQuery("plain prompt")).toBeNull();
    expect(activeMentionQuery("@main.typ done ")).toBeNull(); // trailing space closes it
    expect(activeMentionQuery("email a@b")).toBeNull(); // @ not at a word boundary
  });
});

describe("agent-mentions.resolveFileMentions", () => {
  it("matches a path with or without the leading slash", () => {
    expect(resolveFileMentions("see @main.typ", FILES).map((f) => f.path)).toEqual(["/main.typ"]);
    expect(resolveFileMentions("see @/main.typ", FILES).map((f) => f.path)).toEqual(["/main.typ"]);
  });
  it("requires an EXACT path (a prefix does not resolve)", () => {
    expect(resolveFileMentions("see @main", FILES)).toEqual([]);
  });
  it("dedupes and preserves first-mention order", () => {
    const got = resolveFileMentions("@refs.bib then @main.typ then @refs.bib", FILES);
    expect(got.map((f) => f.path)).toEqual(["/refs.bib", "/main.typ"]);
  });
  it("returns nothing for no mentions or no files", () => {
    expect(resolveFileMentions("nothing here", FILES)).toEqual([]);
    expect(resolveFileMentions("@main.typ", [])).toEqual([]);
  });
});

describe("agent-mentions.suggestMentions", () => {
  it("offers all files for an empty query", () => {
    expect(suggestMentions("", FILES)).toHaveLength(3);
  });
  it("substring-matches the path, case-insensitively, ignoring a leading slash", () => {
    expect(suggestMentions("intro", FILES).map((f) => f.path)).toEqual(["/chapters/intro.typ"]);
    expect(suggestMentions("/MAIN", FILES).map((f) => f.path)).toEqual(["/main.typ"]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `/f${i}.typ`, text: "" }));
    expect(suggestMentions("f", many, 5)).toHaveLength(5);
  });
});

describe("agent-mentions.composeAgentRequest", () => {
  it("returns the request unchanged when nothing resolves", () => {
    expect(composeAgentRequest("just do it", FILES)).toBe("just do it");
    expect(composeAgentRequest("ref @missing.typ", FILES)).toBe("ref @missing.typ");
  });
  it("appends an attached-context block with each mentioned file's content", () => {
    const out = composeAgentRequest("summarize @main.typ", FILES);
    expect(out).toContain("summarize @main.typ");
    expect(out).toContain("[Attached file context");
    expect(out).toContain("--- /main.typ ---");
    expect(out).toContain("= Main\nbody");
  });
  it("caps a huge file and marks the truncation", () => {
    const big: MentionableFile[] = [{ path: "/big.typ", text: "x".repeat(MENTION_ATTACH_MAX_CHARS + 500) }];
    const out = composeAgentRequest("read @big.typ", big);
    expect(out).toContain("…(truncated)");
    expect(out.length).toBeLessThan("read @big.typ".length + MENTION_ATTACH_MAX_CHARS + 200);
  });
});
