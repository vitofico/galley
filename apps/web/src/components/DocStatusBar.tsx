import { useMemo } from "react";
import { countWords, countChars, readingTimeMinutes, countFiguresAndTables } from "./doc-stats.js";
import "./doc-stats.css";

/**
 * Document status strip (roadmap #12.7, restyled). Replaces the four-card metric
 * grid that used to sit below the preview — that block was too invasive for the
 * center column, so the metrics collapse to one quiet line pinned at the pane's
 * foot, and the outline moved behind the trailing toggle (it docks in the rail
 * on the project shell). PRESENTATIONAL: source in, one callback out.
 */
export interface DocStatusBarProps {
  /** The current document source text. */
  source: string;
  /** Compiled page count, when the preview knows it. */
  pageCount?: number;
  /**
   * Open the document outline. The project shell docks the outline in the rail;
   * the single-file shell toggles an inline panel. Omit to hide the toggle.
   */
  onShowOutline?: () => void;
  /** Whether the outline is currently shown (drives the toggle's pressed state). */
  outlineOpen?: boolean;
}

function formatReadingTime(minutes: number): string {
  if (minutes <= 0) return "0 min";
  return `${minutes} min`;
}

export function DocStatusBar({ source, pageCount, onShowOutline, outlineOpen }: DocStatusBarProps) {
  const { words, chars, readingTime, figures, tables } = useMemo(() => {
    const w = countWords(source);
    const ft = countFiguresAndTables(source);
    return {
      words: w,
      chars: countChars(source),
      readingTime: readingTimeMinutes(w),
      figures: ft.figures,
      tables: ft.tables,
    };
  }, [source]);

  return (
    <div className="doc-statusbar" data-testid="doc-stats" aria-label="Document statistics">
      <dl className="doc-statusbar-metrics">
        <div className="doc-statusbar-metric" data-testid="doc-stats-words">
          <dt>words</dt>
          <dd>{words.toLocaleString()}</dd>
        </div>
        <div className="doc-statusbar-metric" data-testid="doc-stats-chars">
          <dt>characters</dt>
          <dd>{chars.toLocaleString()}</dd>
        </div>
        <div className="doc-statusbar-metric" data-testid="doc-stats-reading-time">
          <dt>read</dt>
          <dd>{formatReadingTime(readingTime)}</dd>
        </div>
        {pageCount != null && (
          <div className="doc-statusbar-metric" data-testid="doc-stats-pages">
            <dt>{pageCount === 1 ? "page" : "pages"}</dt>
            <dd>{pageCount.toLocaleString()}</dd>
          </div>
        )}
        {figures > 0 && (
          <div className="doc-statusbar-metric" data-testid="doc-stats-figures">
            <dt>{figures === 1 ? "figure" : "figures"}</dt>
            <dd>{figures.toLocaleString()}</dd>
          </div>
        )}
        {tables > 0 && (
          <div className="doc-statusbar-metric" data-testid="doc-stats-tables">
            <dt>{tables === 1 ? "table" : "tables"}</dt>
            <dd>{tables.toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {onShowOutline && (
        <button
          type="button"
          className="doc-statusbar-outline"
          data-testid="doc-outline-toggle"
          aria-label="Outline"
          aria-pressed={outlineOpen ?? false}
          title="Outline — jump to a heading"
          onClick={onShowOutline}
        >
          <span aria-hidden="true">❡</span> Outline
        </button>
      )}
    </div>
  );
}
