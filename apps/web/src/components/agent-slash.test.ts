import { describe, it, expect } from "vitest";
import {
  activeSlashQuery,
  suggestSlash,
  expandSlash,
  SLASH_ACTIONS,
  type SlashAction,
} from "./agent-slash.js";

const ACTIONS: SlashAction[] = [
  { id: "fix", label: "Fix compile errors", hint: "smallest change", template: "FIX TEMPLATE" },
  { id: "shorten", label: "Shorten", hint: "tighten prose", template: "SHORTEN TEMPLATE" },
  { id: "proofread", label: "Proofread", hint: "grammar only", template: "PROOFREAD TEMPLATE" },
];

describe("agent-slash.activeSlashQuery", () => {
  it("returns the query after a leading slash (empty on a bare `/`)", () => {
    expect(activeSlashQuery("/")).toBe("");
    expect(activeSlashQuery("/fi")).toBe("fi");
    expect(activeSlashQuery("/proofread")).toBe("proofread");
  });
  it("is START-ANCHORED: a `/` after prose is not an action", () => {
    // Unlike `@`, a slash action is a whole-prompt prefix — mid-text slashes are
    // ordinary characters (paths, URLs, and/or).
    expect(activeSlashQuery("please /fix")).toBeNull();
    expect(activeSlashQuery("see /main.typ")).toBeNull();
    expect(activeSlashQuery("read http://example.com")).toBeNull();
  });
  it("is null once a space closes the token", () => {
    expect(activeSlashQuery("/fix ")).toBeNull();
    expect(activeSlashQuery("/fix the intro")).toBeNull();
  });
  it("is null for prose with no leading slash at all", () => {
    expect(activeSlashQuery("plain prompt")).toBeNull();
    expect(activeSlashQuery("")).toBeNull();
  });
});

describe("agent-slash.suggestSlash", () => {
  it("offers every action for an empty query", () => {
    expect(suggestSlash("", ACTIONS)).toHaveLength(3);
  });
  it("substring-matches the id, case-insensitively", () => {
    expect(suggestSlash("fi", ACTIONS).map((a) => a.id)).toEqual(["fix"]);
    expect(suggestSlash("PROOF", ACTIONS).map((a) => a.id)).toEqual(["proofread"]);
    expect(suggestSlash("read", ACTIONS).map((a) => a.id)).toEqual(["proofread"]);
  });
  it("offers nothing for a query that matches no action", () => {
    expect(suggestSlash("nope", ACTIONS)).toEqual([]);
  });
  it("caps the list", () => {
    const many: SlashAction[] = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      label: `A ${i}`,
      hint: "",
      template: "T",
    }));
    expect(suggestSlash("a", many, 5)).toHaveLength(5);
  });
});

describe("agent-slash.expandSlash", () => {
  const fix = ACTIONS[0]!;

  it("replaces the leading token with the action's template", () => {
    expect(expandSlash("/fix", fix)).toBe("FIX TEMPLATE");
    expect(expandSlash("/", fix)).toBe("FIX TEMPLATE");
  });
  it("preserves any trailing text the author already typed", () => {
    expect(expandSlash("/fix the intro", fix)).toBe("FIX TEMPLATE the intro");
    expect(expandSlash("/sho rest", fix)).toBe("FIX TEMPLATE rest");
  });
  it("replaces ONLY the leading token, never a later slash", () => {
    expect(expandSlash("/fix see /main.typ", fix)).toBe("FIX TEMPLATE see /main.typ");
  });

  // THE DISCIPLINE INVARIANT: slash actions are additive. A composer buffer that
  // is not a slash prompt must come back byte-for-byte as it went in — this is
  // what keeps today's send path (and every existing test) unchanged.
  it("returns a buffer with no leading `/` BYTE-IDENTICAL", () => {
    for (const text of ["plain prompt", "", "email a@b /fix", "  /fix", "summarize @/main.typ"]) {
      expect(expandSlash(text, fix)).toBe(text);
    }
  });
});

describe("agent-slash.SLASH_ACTIONS catalog", () => {
  it("has unique ids that are typeable slash tokens", () => {
    const ids = SLASH_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });
  it("ships a real prompt for every action, not a stub", () => {
    for (const a of SLASH_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.hint.length).toBeGreaterThan(0);
      // A template IS the feature here: a one-liner like "fix it" is a failed slice.
      expect(a.template.length).toBeGreaterThan(60);
    }
  });
  it("every catalog action round-trips through the picker flow", () => {
    for (const a of SLASH_ACTIONS) {
      expect(suggestSlash(a.id, SLASH_ACTIONS).map((x) => x.id)).toContain(a.id);
      expect(expandSlash(`/${a.id}`, a)).toBe(a.template);
      // Expanding clears the leading `/`, which is what closes the picker.
      expect(activeSlashQuery(expandSlash(`/${a.id}`, a))).toBeNull();
    }
  });
});
