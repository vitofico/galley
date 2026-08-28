import { describe, it, expect } from "vitest";
import { checkConstraints, countWords } from "@galley/agent";
import type { DocumentConstraints } from "@galley/agent";
import { computeWritingGoals } from "./writing-goals.js";

/**
 * Unit tests for the PURE writing-goals helper (roadmap 18.7). The contract is
 * that EVERY met/unmet decision matches `checkConstraints` exactly (the agent's
 * deterministic verdict) — these tests assert that equivalence directly, plus the
 * displayed word count, the over/short deltas, and the metCount/totalCount
 * accounting across every constraint kind.
 */

function constraints(over: Partial<DocumentConstraints> = {}): DocumentConstraints {
  return { requiredSections: [], forbiddenWords: [], ...over };
}

describe("computeWritingGoals — word count display", () => {
  it("reports the markup-aware prose word count", () => {
    const src = "one two three four five";
    const s = computeWritingGoals(src, constraints({ maxWords: 3 }));
    expect(s.wordCount).toBe(countWords(src));
    expect(s.wordCount).toBe(5);
  });

  it("never throws on empty source / inert constraints", () => {
    const s = computeWritingGoals("", constraints());
    expect(s.wordCount).toBe(0);
    expect(s.totalCount).toBe(0);
    expect(s.metCount).toBe(0);
    expect(s.allMet).toBe(true);
    expect(s.word).toBeUndefined();
    expect(s.sections).toEqual([]);
    expect(s.forbidden).toEqual([]);
  });
});

describe("computeWritingGoals — word goal (max)", () => {
  it("over max: not ok, over delta, unmet", () => {
    const src = "one two three four five"; // 5 words
    const c = constraints({ maxWords: 3 });
    const s = computeWritingGoals(src, c);
    expect(s.word).toBeDefined();
    expect(s.word!.kind).toBe("max");
    expect(s.word!.max).toBe(3);
    expect(s.word!.over).toBe(2);
    expect(s.word!.short).toBeUndefined();
    expect(s.word!.ok).toBe(false);
    expect(s.metCount).toBe(0);
    expect(s.totalCount).toBe(1);
    expect(s.allMet).toBe(false);
    // ok mirrors checkConstraints exactly:
    expect(s.word!.ok).toBe(checkConstraints(src, c).length === 0);
  });

  it("at/under max: ok, met", () => {
    const src = "one two three"; // 3 words, == max
    const c = constraints({ maxWords: 3 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.ok).toBe(true);
    expect(s.word!.over).toBeUndefined();
    expect(s.metCount).toBe(1);
    expect(s.totalCount).toBe(1);
    expect(s.allMet).toBe(true);
    expect(checkConstraints(src, c)).toHaveLength(0);
  });
});

describe("computeWritingGoals — word goal (min)", () => {
  it("under min: not ok, short delta, unmet", () => {
    const src = "one two"; // 2 words
    const c = constraints({ minWords: 5 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.kind).toBe("min");
    expect(s.word!.min).toBe(5);
    expect(s.word!.short).toBe(3);
    expect(s.word!.over).toBeUndefined();
    expect(s.word!.ok).toBe(false);
    expect(s.metCount).toBe(0);
    expect(s.allMet).toBe(false);
  });

  it("at/over min: ok, met", () => {
    const src = "one two three four five"; // 5 words, == min
    const c = constraints({ minWords: 5 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.ok).toBe(true);
    expect(s.metCount).toBe(1);
    expect(s.allMet).toBe(true);
  });
});

describe("computeWritingGoals — word goal (range)", () => {
  it("counts max+min as ONE goal", () => {
    const src = "one two three four five"; // 5 words
    const c = constraints({ minWords: 2, maxWords: 10 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.kind).toBe("range");
    expect(s.word!.min).toBe(2);
    expect(s.word!.max).toBe(10);
    expect(s.word!.ok).toBe(true);
    expect(s.totalCount).toBe(1); // ONE goal, not two
    expect(s.metCount).toBe(1);
  });

  it("range, under min: short, unmet, still one goal", () => {
    const src = "one"; // 1 word
    const c = constraints({ minWords: 3, maxWords: 10 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.short).toBe(2);
    expect(s.word!.over).toBeUndefined();
    expect(s.word!.ok).toBe(false);
    expect(s.totalCount).toBe(1);
    expect(s.metCount).toBe(0);
  });

  it("range, over max: over, unmet", () => {
    const src = "a b c d e f g h"; // 8 words
    const c = constraints({ minWords: 1, maxWords: 5 });
    const s = computeWritingGoals(src, c);
    expect(s.word!.over).toBe(3);
    expect(s.word!.ok).toBe(false);
  });
});

describe("computeWritingGoals — required sections", () => {
  it("present vs missing reflects checkConstraints", () => {
    const src = "= Introduction\n\nHello world.\n\n= Body\n\nMore.";
    const c = constraints({ requiredSections: ["Introduction", "Conclusion"] });
    const s = computeWritingGoals(src, c);
    expect(s.sections).toEqual([
      { name: "Introduction", present: true },
      { name: "Conclusion", present: false },
    ]);
    expect(s.totalCount).toBe(2);
    expect(s.metCount).toBe(1);
    expect(s.allMet).toBe(false);
    // mirror the agent: the only violation is the missing Conclusion
    const v = checkConstraints(src, c);
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe("missing-section");
  });

  it("all sections present: all met", () => {
    const src = "= Intro\n\ntext\n\n= Outro\n\ntext";
    const c = constraints({ requiredSections: ["Intro", "Outro"] });
    const s = computeWritingGoals(src, c);
    expect(s.metCount).toBe(2);
    expect(s.allMet).toBe(true);
  });
});

describe("computeWritingGoals — forbidden words", () => {
  it("lists only words present, carrying counts", () => {
    const src = "We utilize things and utilize more, but never leverage.";
    const c = constraints({ forbiddenWords: ["utilize", "leverage", "synergy"] });
    const s = computeWritingGoals(src, c);
    // synergy absent → not listed; utilize twice; leverage once
    expect(s.forbidden).toEqual([
      { word: "utilize", count: 2 },
      { word: "leverage", count: 1 },
    ]);
    expect(s.totalCount).toBe(3); // three RULES
    expect(s.metCount).toBe(1); // only synergy is satisfied (absent)
    expect(s.allMet).toBe(false);
  });

  it("no forbidden words present: all rules met", () => {
    const src = "Clean prose with no banned terms.";
    const c = constraints({ forbiddenWords: ["utilize", "leverage"] });
    const s = computeWritingGoals(src, c);
    expect(s.forbidden).toEqual([]);
    expect(s.metCount).toBe(2);
    expect(s.totalCount).toBe(2);
    expect(s.allMet).toBe(true);
  });
});

describe("computeWritingGoals — combined accounting + allMet", () => {
  it("sums word + section + forbidden goals and met counts", () => {
    const src = "= Introduction\n\nWe utilize one two three four five six seven.";
    const c = constraints({
      maxWords: 5, // 9 words → over → unmet
      requiredSections: ["Introduction", "Methods"], // Intro present, Methods missing
      forbiddenWords: ["utilize"], // present → unmet
    });
    const s = computeWritingGoals(src, c);
    expect(s.totalCount).toBe(1 + 2 + 1); // 4 goals
    // met: word unmet(0) + Introduction(1) + Methods(0) + utilize-absent? no→0
    expect(s.metCount).toBe(1);
    expect(s.allMet).toBe(false);
  });

  it("all goals satisfied → allMet true and metCount === totalCount", () => {
    const src = "= Introduction\n\nA clean short body here.\n\n= Methods\n\nMore text.";
    const c = constraints({
      minWords: 2,
      maxWords: 100,
      requiredSections: ["Introduction", "Methods"],
      forbiddenWords: ["utilize"],
    });
    const s = computeWritingGoals(src, c);
    expect(s.metCount).toBe(s.totalCount);
    expect(s.totalCount).toBe(1 + 2 + 1);
    expect(s.allMet).toBe(true);
    expect(checkConstraints(src, c)).toHaveLength(0);
  });
});
