import { useState } from "react";
import { renderPreflight } from "../render-preflight.js";
export function BeforeSend({
  source,
  fresh,
  pageCount,
  pages,
  onExport,
}: {
  source: string;
  fresh: boolean;
  pageCount: number | null;
  pages?: { widthPt: number; heightPt: number }[] | undefined;
  onExport: () => void;
}) {
  const [maxPages, setMaxPages] = useState(10);
  const [paper, setPaper] = useState<"any" | "a4" | "letter">("any");
  const checks = renderPreflight({
    source,
    fresh,
    pageCount,
    pages,
    maxPages,
    paper,
  });
  return (
    <details data-testid="before-send">
      <summary>Before you send</summary>
      <p>
        Checks the current preview SVG and project source. PDF accessibility,
        embedded fonts and submission rules are not verified. Settings apply to
        this open session.
      </p>
      <label>
        Maximum pages{" "}
        <input
          aria-label="Maximum pages"
          type="number"
          min="1"
          max="10000"
          value={maxPages}
          onChange={(e) =>
            setMaxPages(
              Math.max(1, Math.min(10000, Number(e.target.value) || 1)),
            )
          }
        />
      </label>
      <label>
        Paper size{" "}
        <select
          aria-label="Paper size"
          value={paper}
          onChange={(e) => setPaper(e.target.value as typeof paper)}
        >
          <option value="any">No paper requirement</option>
          <option value="a4">A4 portrait</option>
          <option value="letter">Letter portrait</option>
        </select>
      </label>
      <ul>
        {checks.map((c) => (
          <li key={c.name}>
            <strong>
              {c.status}: {c.name}
            </strong>{" "}
            — {c.detail}
          </li>
        ))}
      </ul>
      <button onClick={onExport}>Export PDF</button>
      <p>
        Export compiles a PDF separately; these SVG checks are advisory and do
        not certify that PDF.
      </p>
    </details>
  );
}
