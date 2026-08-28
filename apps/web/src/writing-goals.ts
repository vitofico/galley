import { countWords, checkConstraints } from "@galley/agent";
import type { DocumentConstraints } from "@galley/agent";

/**
 * Roadmap 18.7 — Writing Goals (pure helper). Surfaces the SAME deterministic
 * `.galley/instructions` constraints the agent loop checks (iterate-until-clean)
 * as LIVE, opt-in progress for the WRITER. The met/unmet verdict is derived
 * STRICTLY from `checkConstraints` (the agent's source of truth) — never a
 * reimplementation of the threshold logic — so a writer can never see "met"
 * while the agent sees a violation. `countWords` supplies the displayed number.
 *
 * Pure + never throws. When neither a word cap/floor nor any required section /
 * forbidden word is set, the status is empty (`totalCount === 0`, `allMet`).
 */

/** Word-goal status (only present when a max and/or min word constraint is set). */
export interface WordGoalStatus {
  /** Which bound(s) are configured. `null` is never produced (word is omitted then). */
  kind: "max" | "min" | "range";
  /** Configured maximum, when `max-words` is set. */
  max?: number;
  /** Configured minimum, when `min-words` is set. */
  min?: number;
  /** Words over the maximum (only when currently over). */
  over?: number;
  /** Words short of the minimum (only when currently under). */
  short?: number;
  /** True when the word constraint is currently satisfied (per checkConstraints). */
  ok: boolean;
}

/** One required-section goal. */
export interface SectionGoalStatus {
  name: string;
  present: boolean;
}

/** One forbidden word that ACTUALLY appears (absent ones are not listed). */
export interface ForbiddenGoalStatus {
  word: string;
  count: number;
}

/** Live progress against a project's deterministic constraints. */
export interface WritingGoalsStatus {
  /** Markup-aware prose word count (always computed, for display). */
  wordCount: number;
  /** Word-goal status, present only when max and/or min words is configured. */
  word?: WordGoalStatus;
  /** One entry per required section, in declared order. */
  sections: SectionGoalStatus[];
  /** One entry per forbidden word currently present (carrying its count). */
  forbidden: ForbiddenGoalStatus[];
  /** Goals currently satisfied. */
  metCount: number;
  /** Distinct goals: 1 for the word goal (if any bound set) + sections + forbidden rules. */
  totalCount: number;
  /** True when every configured goal is met (metCount === totalCount). */
  allMet: boolean;
}

/**
 * Compute live writing-goals progress. The over/short deltas and every met/unmet
 * decision come from `checkConstraints` violations (the agent's deterministic
 * verdict); only the displayed `wordCount` is computed directly via `countWords`.
 */
export function computeWritingGoals(
  source: string,
  constraints: DocumentConstraints,
): WritingGoalsStatus {
  const src = source ?? "";
  const wordCount = countWords(src);
  const violations = checkConstraints(src, constraints);

  const hasWordGoal =
    constraints.maxWords !== undefined || constraints.minWords !== undefined;

  let word: WordGoalStatus | undefined;
  if (hasWordGoal) {
    const maxV = violations.find((v) => v.kind === "max-words");
    const minV = violations.find((v) => v.kind === "min-words");
    const kind: WordGoalStatus["kind"] =
      constraints.maxWords !== undefined && constraints.minWords !== undefined
        ? "range"
        : constraints.maxWords !== undefined
          ? "max"
          : "min";
    word = {
      kind,
      ...(constraints.maxWords !== undefined ? { max: constraints.maxWords } : {}),
      ...(constraints.minWords !== undefined ? { min: constraints.minWords } : {}),
      ...(maxV && maxV.kind === "max-words"
        ? { over: maxV.actual - maxV.limit }
        : {}),
      ...(minV && minV.kind === "min-words"
        ? { short: minV.limit - minV.actual }
        : {}),
      ok: !maxV && !minV,
    };
  }

  const missing = new Set(
    violations
      .filter((v): v is Extract<typeof v, { kind: "missing-section" }> => v.kind === "missing-section")
      .map((v) => v.section),
  );
  const sections: SectionGoalStatus[] = constraints.requiredSections.map((name) => ({
    name,
    present: !missing.has(name),
  }));

  const forbidden: ForbiddenGoalStatus[] = violations
    .filter((v): v is Extract<typeof v, { kind: "forbidden-word" }> => v.kind === "forbidden-word")
    .map((v) => ({ word: v.word, count: v.count }));

  // Total = distinct GOALS (rules), not violations: one word goal if any bound is
  // set, one per required section, one per forbidden-word RULE (declared).
  const totalCount =
    (hasWordGoal ? 1 : 0) +
    constraints.requiredSections.length +
    constraints.forbiddenWords.length;

  // Met = goals currently satisfied. Word goal met iff no word violation; each
  // section met iff present; each forbidden rule met iff that word is absent.
  const metCount =
    (hasWordGoal ? (word!.ok ? 1 : 0) : 0) +
    sections.filter((s) => s.present).length +
    (constraints.forbiddenWords.length - forbidden.length);

  return {
    wordCount,
    ...(word ? { word } : {}),
    sections,
    forbidden,
    metCount,
    totalCount,
    allMet: metCount === totalCount,
  };
}
