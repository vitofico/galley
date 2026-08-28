import { useMemo } from "react";
import { hasConstraints } from "@galley/agent";
import type { DocumentConstraints } from "@galley/agent";
import { computeWritingGoals } from "../writing-goals.js";
import "./writing-goals.css";

/**
 * `WritingGoals` (roadmap 18.7) — an ambient, opt-in card that surfaces LIVE
 * progress against the project's `.galley/instructions` deterministic constraints
 * (word cap/floor, required sections, forbidden words) to the WRITER, recomputed
 * as they type. It mirrors the agent loop's iterate-until-clean checks: the
 * met/unmet verdict is derived STRICTLY from `computeWritingGoals` →
 * `checkConstraints`, never a reimplementation, so the writer's "met" can never
 * disagree with the agent's.
 *
 * Read-only display — no CRDT writes, no Accept/diff gate involvement. Renders
 * NOTHING when the project has no actual constraints (defensive; ProjectApp also
 * gates), so the shipped path stays byte-for-byte unchanged.
 */
export interface WritingGoalsProps {
  /** The project's parsed deterministic constraints (the opt-in trigger). */
  constraints: DocumentConstraints;
  /** The main (or active) document text to measure against. */
  source: string;
}

export function WritingGoals({ constraints, source }: WritingGoalsProps) {
  const status = useMemo(
    () => computeWritingGoals(source, constraints),
    [source, constraints],
  );

  // Defensive: nothing to show when no real constraints are set.
  if (!hasConstraints(constraints)) return null;

  const remaining = status.totalCount - status.metCount;
  const summary = status.allMet
    ? "All goals met"
    : `${remaining} to go`;

  const word = status.word;
  const wordPct =
    word === undefined
      ? 0
      : word.max !== undefined
        ? Math.min(100, (status.wordCount / word.max) * 100)
        : word.min !== undefined
          ? Math.min(100, (status.wordCount / word.min) * 100)
          : 0;

  return (
    <section
      className="writing-goals"
      data-testid="writing-goals"
      aria-label="Writing goals — live progress against project constraints"
    >
      <header className="writing-goals-head">
        <span className="writing-goals-title">Writing goals</span>
        <span
          className={`writing-goals-summary${status.allMet ? " is-met" : ""}`}
          data-testid="writing-goals-summary"
        >
          {summary}
          <span className="writing-goals-count" aria-hidden="true">
            {status.metCount}/{status.totalCount}
          </span>
        </span>
      </header>

      {word && (
        <div
          className={`writing-goals-words${word.ok ? " is-met" : " is-unmet"}`}
          data-testid="writing-goals-words"
        >
          <div className="writing-goals-words-row">
            <span className="writing-goals-words-label">
              {word.max !== undefined && word.min !== undefined ? (
                <>
                  {status.wordCount} words{" "}
                  <span className="writing-goals-muted">
                    ({word.min}–{word.max})
                  </span>
                </>
              ) : word.max !== undefined ? (
                <>
                  {status.wordCount} / {word.max} words
                </>
              ) : (
                <>
                  {status.wordCount} words{" "}
                  <span className="writing-goals-muted">(min {word.min})</span>
                </>
              )}
            </span>
            {word.over !== undefined && (
              <span className="writing-goals-flag" data-testid="writing-goals-words-over">
                {word.over} over
              </span>
            )}
            {word.short !== undefined && (
              <span className="writing-goals-flag" data-testid="writing-goals-words-short">
                {word.short} short
              </span>
            )}
          </div>
          <div className="writing-goals-bar" role="presentation">
            <span
              className="writing-goals-bar-fill"
              style={{ width: `${wordPct}%` }}
            />
          </div>
        </div>
      )}

      {status.sections.length > 0 && (
        <ul className="writing-goals-sections">
          {status.sections.map((s) => (
            <li
              key={s.name}
              className={`writing-goals-section${s.present ? " is-met" : " is-unmet"}`}
              data-testid="writing-goals-section"
            >
              <span className="writing-goals-check" aria-hidden="true">
                {s.present ? "✓" : "○"}
              </span>
              <span className="writing-goals-section-name">{s.name}</span>
            </li>
          ))}
        </ul>
      )}

      {status.forbidden.length > 0 && (
        <ul className="writing-goals-forbidden-list">
          {status.forbidden.map((f) => (
            <li
              key={f.word}
              className="writing-goals-forbidden"
              data-testid="writing-goals-forbidden"
            >
              <span className="writing-goals-check" aria-hidden="true">
                ✕
              </span>
              <span className="writing-goals-forbidden-word">{f.word}</span>
              <span className="writing-goals-forbidden-count">×{f.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
