/**
 * Roadmap 14-D — `.galley/instructions` agent steering + deterministic
 * document constraints (the offline core; the VFS read + ProjectApp wiring is
 * the NEXT slice, so nothing here touches fs/network/UI).
 *
 * ## The instructions file format
 *
 * A `.galley/instructions` file is markdown with two parts:
 *
 *   1. **Steering prose** — everything outside the constraints section, kept
 *      VERBATIM and injected into the agent's system preamble (voice, citation
 *      style, target venue, …). The model interprets it; we never do.
 *   2. **An optional `## Constraints` section** (any heading level `#`–`######`,
 *      case-insensitive). It runs until the next markdown heading or EOF and
 *      contains one `key: value` line per constraint. These are DETERMINISTIC
 *      document checks — a non-compile success signal in iterate-until-clean.
 *
 * Supported constraint keys (deterministic ONLY — scope guard: no subjective
 * goals, no LLM-judged checks, no persona library):
 *
 *   max-words: 800              — word cap (Typst-markup-aware count, see below)
 *   min-words: 200              — word floor
 *   required-section: "Intro"   — repeatable; a Typst heading (`= Intro`) must
 *                                 exist whose text equals it (case-insensitive,
 *                                 trailing `<label>` ignored)
 *   forbidden-word: "utilize"   — repeatable; case-insensitive WHOLE-WORD match
 *                                 over the document's prose (markup stripped)
 *
 * Values may be bare or double-quoted. Unknown keys and malformed values
 * produce structured WARNINGS, never errors (forward-compat); `parseInstructions`
 * never throws.
 *
 * ## Word counting (documented approximation — deterministic > perfect)
 *
 * Typst source is not prose, so `countWords` strips markup first:
 *   - block comments (slash-star … star-slash) and ` // …` line comments (a
 *     `//` must start the line or follow whitespace, so `https://…` URLs survive);
 *   - raw blocks: ``` fenced ``` and `inline` backticks;
 *   - whole `#set` / `#show` / `#import` / `#include` / `#let` directive lines
 *     (their arguments are code, not prose);
 *   - other `#func(…)` call syntax (the `#name` and ONE balanced `(…)` argument
 *     list), while `[content]` block text is KEPT (it is prose);
 *   - `<labels>`, `@citations`, heading `=` markers, `*`/`_` emphasis marks and
 *     the `[`/`]` bracket characters themselves.
 * What remains is split on whitespace; a token counts as a word when it
 * contains at least one letter or digit. Math (`$…$`) content is counted as-is.
 * Forbidden-word matching runs over the SAME stripped prose, so a term inside a
 * code fence or comment never violates.
 */

import type { Diagnostic } from "@galley/shared";

/** Deterministic document constraints (the parsed `## Constraints` section). */
export interface DocumentConstraints {
  /** Word cap over the markup-stripped prose. */
  maxWords?: number;
  /** Word floor over the markup-stripped prose. */
  minWords?: number;
  /** Typst headings that must exist (text equality, case-insensitive). */
  requiredSections: string[];
  /** Terms that must not appear (case-insensitive, whole-word, prose only). */
  forbiddenWords: string[];
}

/** A non-fatal parse problem (unknown key, malformed value, stray line). */
export interface InstructionsWarning {
  /** 1-based line number in the instructions file. */
  line: number;
  message: string;
}

/** Structured outcome of `parseInstructions` — malformed input never throws. */
export interface ParsedInstructions {
  /** Freeform steering prose, verbatim (constraints section removed), trimmed. */
  steering: string;
  /** Parsed constraints; `undefined` when the file has no Constraints section. */
  constraints: DocumentConstraints | undefined;
  warnings: InstructionsWarning[];
}

/** What `RunAgentOptions.instructions` carries (additive, default OFF). */
export interface AgentInstructions {
  /** Steering prose injected into the system preamble, clearly delimited. */
  steering?: string;
  /** Deterministic constraints checked after each CLEAN compile. */
  constraints?: DocumentConstraints;
}

/** One deterministic constraint violation (the structured failure signal). */
export type ConstraintViolation =
  | { kind: "max-words"; limit: number; actual: number; message: string }
  | { kind: "min-words"; limit: number; actual: number; message: string }
  | { kind: "missing-section"; section: string; message: string }
  | { kind: "forbidden-word"; word: string; count: number; message: string };

const ANY_HEADING_RE = /^#{1,6}\s/;
const CONSTRAINTS_HEADING_RE = /^#{1,6}\s*constraints\s*$/i;
const KEY_VALUE_RE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;

const KNOWN_KEYS = "max-words, min-words, required-section, forbidden-word";

function emptyConstraints(): DocumentConstraints {
  return { requiredSections: [], forbiddenWords: [] };
}

/** Strip ONE pair of surrounding double quotes, then trim. */
function unquote(value: string): string {
  const t = value.trim();
  const m = /^"(.*)"$/.exec(t);
  return (m ? m[1]! : t).trim();
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Parse a `.galley/instructions` markdown file (format documented in the
 * module docstring). Never throws; problems surface as structured warnings.
 */
export function parseInstructions(text: string): ParsedInstructions {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const steeringLines: string[] = [];
  const warnings: InstructionsWarning[] = [];
  let constraints: DocumentConstraints | undefined;
  let inConstraints = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;
    const trimmed = raw.trim();

    if (CONSTRAINTS_HEADING_RE.test(trimmed)) {
      inConstraints = true;
      constraints ??= emptyConstraints();
      continue;
    }
    if (inConstraints && ANY_HEADING_RE.test(trimmed)) inConstraints = false; // section ends

    if (!inConstraints) {
      steeringLines.push(raw);
      continue;
    }
    if (trimmed === "") continue;

    const kv = KEY_VALUE_RE.exec(trimmed);
    if (!kv) {
      warnings.push({ line, message: `not a "key: value" line; ignored: ${trimmed}` });
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    switch (key) {
      case "max-words":
      case "min-words": {
        const n = parsePositiveInt(value);
        if (n === null) {
          warnings.push({ line, message: `${key} needs a positive integer, got "${value}"; ignored` });
        } else if (key === "max-words") {
          constraints!.maxWords = n;
        } else {
          constraints!.minWords = n;
        }
        break;
      }
      case "required-section": {
        const v = unquote(value);
        if (!v) warnings.push({ line, message: `required-section needs a non-empty heading; ignored` });
        else constraints!.requiredSections.push(v);
        break;
      }
      case "forbidden-word": {
        const v = unquote(value);
        if (!v) warnings.push({ line, message: `forbidden-word needs a non-empty term; ignored` });
        else constraints!.forbiddenWords.push(v);
        break;
      }
      default:
        warnings.push({
          line,
          message: `unknown constraint key "${key}"; ignored (supported: ${KNOWN_KEYS})`,
        });
    }
  }

  return { steering: steeringLines.join("\n").trim(), constraints, warnings };
}

/** True when any deterministic constraint is actually set (inert objects are OFF). */
export function hasConstraints(c: DocumentConstraints | undefined): c is DocumentConstraints {
  return (
    !!c &&
    (c.maxWords !== undefined ||
      c.minWords !== undefined ||
      c.requiredSections.length > 0 ||
      c.forbiddenWords.length > 0)
  );
}

/** Remove `#name` + one balanced `(…)` argument list (a tiny deterministic scanner). */
function stripHashCalls(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "#" && /[A-Za-z_]/.test(s[i + 1] ?? "")) {
      i += 1; // '#'
      while (i < s.length && /[\w.-]/.test(s[i]!)) i += 1; // identifier
      if (s[i] === "(") {
        let depth = 0;
        do {
          if (s[i] === "(") depth += 1;
          else if (s[i] === ")") depth -= 1;
          i += 1;
        } while (i < s.length && depth > 0);
      }
      out += " ";
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Strip Typst markup down to approximate prose (the documented approximation in
 * the module docstring). Used by both `countWords` and forbidden-word matching,
 * so the two are always consistent.
 */
export function stripTypstMarkup(source: string): string {
  let s = String(source ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  s = s.replace(/(^|\s)\/\/[^\n]*/gm, "$1"); // line comments (URLs survive)
  s = s.replace(/```[\s\S]*?```/g, " "); // fenced raw
  s = s.replace(/`[^`\n]*`/g, " "); // inline raw
  s = s
    .split("\n")
    .filter((line) => !/^\s*#(set|show|import|include|let)\b/.test(line))
    .join("\n"); // whole-line code-mode directives
  s = stripHashCalls(s); // #func(...) syntax; [content] survives
  s = s.replace(/<[\w:.-]+>/g, " "); // labels
  s = s.replace(/@[\w:.-]+/g, " "); // citations
  s = s.replace(/^\s*=+\s+/gm, ""); // heading markers (text kept)
  s = s.replace(/[*_[\]]/g, " "); // emphasis marks + content-block brackets
  return s;
}

function countProseTokens(prose: string): number {
  return prose.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** Word count over the markup-stripped prose (documented approximation). */
export function countWords(source: string): number {
  return countProseTokens(stripTypstMarkup(source));
}

/** Typst heading texts (`= Foo`, `== Bar`), trailing `<label>` removed, trimmed. */
function headingTexts(source: string): string[] {
  const out: string[] = [];
  const normalized = String(source ?? "").replace(/\r\n/g, "\n");
  for (const m of normalized.matchAll(/^\s*=+\s+(.+?)\s*$/gm)) {
    out.push(m[1]!.replace(/<[\w:.-]+>\s*$/, "").trim());
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure, deterministic constraint check: returns structured violations in a
 * stable order (word caps, then required sections, then forbidden words, each
 * in declared order). Zero violations = the constraints success signal.
 */
export function checkConstraints(
  source: string,
  constraints: DocumentConstraints,
): ConstraintViolation[] {
  const out: ConstraintViolation[] = [];
  const prose = stripTypstMarkup(source);

  if (constraints.maxWords !== undefined || constraints.minWords !== undefined) {
    const actual = countProseTokens(prose);
    if (constraints.maxWords !== undefined && actual > constraints.maxWords) {
      out.push({
        kind: "max-words",
        limit: constraints.maxWords,
        actual,
        message: `document has ${actual} words; max-words is ${constraints.maxWords} (over by ${actual - constraints.maxWords})`,
      });
    }
    if (constraints.minWords !== undefined && actual < constraints.minWords) {
      out.push({
        kind: "min-words",
        limit: constraints.minWords,
        actual,
        message: `document has ${actual} words; min-words is ${constraints.minWords} (short by ${constraints.minWords - actual})`,
      });
    }
  }

  if (constraints.requiredSections.length > 0) {
    const headings = headingTexts(source).map((h) => h.toLowerCase());
    for (const section of constraints.requiredSections) {
      if (!headings.includes(section.trim().toLowerCase())) {
        out.push({
          kind: "missing-section",
          section,
          message: `required section "${section}" is missing (no heading "= ${section}")`,
        });
      }
    }
  }

  for (const word of constraints.forbiddenWords) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    const count = Array.from(prose.matchAll(re)).length;
    if (count > 0) {
      out.push({
        kind: "forbidden-word",
        word,
        count,
        message: `forbidden word "${word}" appears ${count} time(s)`,
      });
    }
  }

  return out;
}

/**
 * Render violations as the model-facing failure signal — same flavor as
 * `formatCheckForModel`'s compile feedback, so the loop's tool results stay
 * one consistent voice.
 */
export function formatConstraintViolationsForModel(violations: ConstraintViolation[]): string {
  const lines = violations.map((v) => `${v.kind}: ${v.message}`);
  return [
    `The compile is clean, but the document violates ${violations.length} project constraint(s) from .galley/instructions:`,
    ...lines,
    `Edit the document to satisfy every constraint while keeping it compiling.`,
  ].join("\n");
}

/**
 * Violations as `Diagnostic`s (severity "error", no span) so constraint
 * outcomes ride the EXISTING `diagnostics` agent event — additive, no new
 * event kind, and the UI's error counting works unchanged.
 */
export function constraintViolationsToDiagnostics(
  violations: ConstraintViolation[],
): Diagnostic[] {
  return violations.map((v) => ({
    severity: "error" as const,
    message: `constraint: ${v.message}`,
  }));
}
