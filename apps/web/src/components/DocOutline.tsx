import { useMemo } from "react";
import { parseHeadings } from "./doc-stats.js";
import "./doc-stats.css";

/**
 * Document outline navigator (roadmap #12.7). Extracted from the old DocStats
 * card block: the heading list now lives on its own so it can dock in the rail
 * (ProjectApp) or collapse behind the status strip's toggle (single-file shell)
 * instead of occupying the center column. PRESENTATIONAL: source in, clicks out.
 */
export interface DocOutlineProps {
  /** The current document source text. */
  source: string;
  /**
   * Called with a heading's absolute UTF-16 offset when its outline entry is
   * clicked, so the host can move/scroll the editor to that position.
   */
  onJump?: (offset: number) => void;
}

export function DocOutline({ source, onJump }: DocOutlineProps) {
  const headings = useMemo(() => parseHeadings(source), [source]);

  return (
    <nav className="doc-outline" data-testid="doc-outline" aria-label="Document outline">
      {headings.length === 0 ? (
        <div className="doc-outline-empty" data-testid="doc-outline-empty">
          No headings yet
        </div>
      ) : (
        <ul className="doc-outline-list">
          {headings.map((h, i) => (
            <li key={`${h.offset}-${i}`}>
              <button
                type="button"
                className="doc-outline-item"
                data-testid="doc-outline-item"
                data-level={h.level}
                style={{ paddingLeft: `${0.45 + (h.level - 1) * 0.75}rem` }}
                title={h.title}
                onClick={() => onJump?.(h.offset)}
              >
                {h.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
