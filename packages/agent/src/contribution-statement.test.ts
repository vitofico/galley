/**
 * Roadmap #13 — agent-based contribution reconstruction (PURE CORE).
 *
 * These tests pin the CRUX: a deterministic, read-only CRediT-style
 * author-contribution-statement DRAFT derived ONLY from the evidence available
 * (version snapshots' `contributors` from #11; per-section authorship shares
 * from #12 blame). The inference rules are simple and explicit — this output is
 * a draft to be human-edited, not an authoritative attribution.
 */
import { describe, it, expect } from "vitest";
import {
  buildContributionStatement,
  renderContributionStatement,
  CREDIT_ROLES,
  type ContributionInput,
  type ContributionStatement,
} from "./contribution-statement.js";

describe("buildContributionStatement", () => {
  it("single author who wrote everything → original draft (no review role)", () => {
    const input: ContributionInput = {
      snapshots: [{ label: "v1", contributors: ["Alice"] }],
      attributions: [
        { section: "Introduction", author: "Alice", weight: 100 },
        { section: "Methods", author: "Alice", weight: 200 },
      ],
    };
    const out = buildContributionStatement(input);
    expect(out.authors).toHaveLength(1);
    const alice = out.authors[0]!;
    expect(alice.author).toBe("Alice");
    expect(alice.roles).toContain("Writing – original draft");
    // A sole author has no one to "review" against beyond themselves; with no
    // later-only contributor evidence, no review role is inferred.
    expect(alice.roles).not.toContain("Writing – review & editing");
    expect(alice.sectionsWritten).toEqual(["Introduction", "Methods"]);
  });

  it("multiple authors with distinct section ownership → each gets original draft for their sections", () => {
    const input: ContributionInput = {
      snapshots: [{ label: "v1", contributors: ["Alice", "Bob"] }],
      attributions: [
        { section: "Introduction", author: "Alice", weight: 500 },
        { section: "Methods", author: "Bob", weight: 500 },
        // Bob also touched a little of the Intro but Alice dominates it.
        { section: "Introduction", author: "Bob", weight: 10 },
      ],
    };
    const out = buildContributionStatement(input);
    const byName = Object.fromEntries(out.authors.map((a) => [a.author, a]));
    expect(byName["Alice"]!.roles).toContain("Writing – original draft");
    expect(byName["Alice"]!.sectionsWritten).toEqual(["Introduction"]);
    expect(byName["Bob"]!.roles).toContain("Writing – original draft");
    expect(byName["Bob"]!.sectionsWritten).toEqual(["Methods"]);
    // Authors are sorted deterministically (by name).
    expect(out.authors.map((a) => a.author)).toEqual(["Alice", "Bob"]);
  });

  it("a reviewer who only appears in later snapshots' contributors → review & editing, no draft", () => {
    const input: ContributionInput = {
      snapshots: [
        { label: "draft", contributors: ["Alice"] },
        { label: "revision", contributors: ["Alice", "Carol"] },
      ],
      attributions: [{ section: "Introduction", author: "Alice", weight: 100 }],
    };
    const out = buildContributionStatement(input);
    const byName = Object.fromEntries(out.authors.map((a) => [a.author, a]));
    expect(byName["Carol"]).toBeDefined();
    expect(byName["Carol"]!.roles).toEqual(["Writing – review & editing"]);
    expect(byName["Carol"]!.sectionsWritten).toEqual([]);
    // Alice wrote the only authored section → original draft. She also appears
    // in a later snapshot but, having authored content, is not demoted to
    // reviewer-only; she may also carry review & editing.
    expect(byName["Alice"]!.roles).toContain("Writing – original draft");
  });

  it("an author present in attributions but never in any snapshot still gets a draft role", () => {
    const input: ContributionInput = {
      snapshots: [],
      attributions: [{ section: "Results", author: "Dana", weight: 42 }],
    };
    const out = buildContributionStatement(input);
    expect(out.authors).toHaveLength(1);
    expect(out.authors[0]!.author).toBe("Dana");
    expect(out.authors[0]!.roles).toContain("Writing – original draft");
  });

  it("empty input → minimal statement, never throws", () => {
    const out = buildContributionStatement({ snapshots: [], attributions: [] });
    expect(out.authors).toEqual([]);
    expect(out.draft).toBe(true);
    expect(() =>
      buildContributionStatement({ snapshots: [], attributions: [] }),
    ).not.toThrow();
  });

  it("degenerate entries (blank author/section, zero/negative weight) are ignored, not thrown", () => {
    const input: ContributionInput = {
      snapshots: [{ label: "", contributors: ["", "  ", "Alice"] }],
      attributions: [
        { section: "Intro", author: "Alice", weight: 100 },
        { section: "  ", author: "Alice", weight: 50 }, // blank section dropped
        { section: "Intro", author: "", weight: 50 }, // blank author dropped
        { section: "Intro", author: "Alice", weight: 0 }, // zero weight dropped
        { section: "Intro", author: "Alice", weight: -5 }, // negative dropped
      ],
    };
    const out = buildContributionStatement(input);
    expect(out.authors).toHaveLength(1);
    expect(out.authors[0]!.author).toBe("Alice");
    expect(out.authors[0]!.sectionsWritten).toEqual(["Intro"]);
  });

  it("is deterministic: same input ⇒ identical output", () => {
    const input: ContributionInput = {
      snapshots: [
        { label: "v1", contributors: ["Bob", "Alice"] },
        { label: "v2", contributors: ["Alice", "Carol"] },
      ],
      attributions: [
        { section: "Methods", author: "Bob", weight: 300 },
        { section: "Intro", author: "Alice", weight: 400 },
        { section: "Intro", author: "Bob", weight: 100 },
      ],
    };
    const a = buildContributionStatement(input);
    const b = buildContributionStatement(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("an author tying for a section is credited as a co-writer of it", () => {
    const input: ContributionInput = {
      snapshots: [{ label: "v1", contributors: ["Alice", "Bob"] }],
      attributions: [
        { section: "Intro", author: "Alice", weight: 100 },
        { section: "Intro", author: "Bob", weight: 100 },
      ],
    };
    const out = buildContributionStatement(input);
    const byName = Object.fromEntries(out.authors.map((a) => [a.author, a]));
    expect(byName["Alice"]!.sectionsWritten).toEqual(["Intro"]);
    expect(byName["Bob"]!.sectionsWritten).toEqual(["Intro"]);
  });

  it("CREDIT_ROLES is the closed vocabulary used by the inference", () => {
    expect(CREDIT_ROLES).toContain("Writing – original draft");
    expect(CREDIT_ROLES).toContain("Writing – review & editing");
  });
});

describe("renderContributionStatement", () => {
  it("renders a CRediT-style sentence per author, one per line", () => {
    const stmt: ContributionStatement = buildContributionStatement({
      snapshots: [
        { label: "draft", contributors: ["Alice"] },
        { label: "rev", contributors: ["Alice", "Carol"] },
      ],
      attributions: [
        { section: "Introduction", author: "Alice", weight: 100 },
        { section: "Methods", author: "Bob", weight: 100 },
      ],
    });
    const text = renderContributionStatement(stmt);
    expect(text).toContain("Alice:");
    expect(text).toContain("Bob:");
    expect(text).toContain("Carol:");
    expect(text).toContain("Writing – original draft");
    expect(text).toContain("Writing – review & editing");
    // One author per line.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.some((l) => l.startsWith("Alice:"))).toBe(true);
  });

  it("renders a heading when requested", () => {
    const stmt = buildContributionStatement({
      snapshots: [{ label: "v1", contributors: ["Alice"] }],
      attributions: [{ section: "Intro", author: "Alice", weight: 1 }],
    });
    const text = renderContributionStatement(stmt, { heading: true });
    expect(text).toContain("Author Contributions");
  });

  it("renders a fallback line for an empty statement, never empty-throws", () => {
    const stmt = buildContributionStatement({ snapshots: [], attributions: [] });
    const text = renderContributionStatement(stmt);
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("no");
  });

  it("is deterministic for the renderer too", () => {
    const stmt = buildContributionStatement({
      snapshots: [{ label: "v1", contributors: ["Bob", "Alice"] }],
      attributions: [
        { section: "Intro", author: "Alice", weight: 10 },
        { section: "Methods", author: "Bob", weight: 10 },
      ],
    });
    expect(renderContributionStatement(stmt)).toBe(
      renderContributionStatement(stmt),
    );
  });
});
