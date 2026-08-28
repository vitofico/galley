import type { RefObject } from "react";
import type { LatexProjectReport, ProjectTextFile } from "@galley/agent";
import { summarizeDroppedPaths, toSafeProjectFiles } from "./import-project.js";
import { Notice } from "./Notice.js";
import "./import-project.css";

/**
 * The presentational review UI for a multi-file project (.zip) import (roadmap
 * #17.3) — the zip picker, the honest per-file migration report, and Accept.
 *
 * Extracted from `ImportPanel` so it can be shared between the document's Insert
 * panel (paste-text import) and the **Projects page** import flow, where a zip —
 * being a whole project — now lives. Purely presentational + controlled: it owns
 * no zip-reading or project-creation logic; the host drives `onPickZip` /
 * `onAccept`.
 */

/** The result of unpacking + migrating a project zip, held for review. */
export interface ProjectImport {
  files: ProjectTextFile[];
  report: LatexProjectReport;
  mainPath: string | null;
  /** The picked zip's filename, carried so the new project can be named after it. */
  filename: string;
}

export interface ProjectImportBodyProps {
  projectImport: ProjectImport | null;
  zipError: string | null;
  unpacking: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPickZip: (file: File) => void | Promise<void>;
  onClear: () => void;
  onAccept: () => void;
}

/** Count outcomes by action for the headline summary. */
function summarizeOutcomes(report: LatexProjectReport): Record<string, number> {
  const counts: Record<string, number> = { converted: 0, passthrough: 0, skipped: 0, asset: 0 };
  for (const o of report.outcomes) counts[o.action] = (counts[o.action] ?? 0) + 1;
  return counts;
}

export function ProjectImportBody({
  projectImport,
  zipError,
  unpacking,
  fileInputRef,
  onPickZip,
  onClear,
  onAccept,
}: ProjectImportBodyProps) {
  return (
    <div className="import-project" data-testid="import-project">
      <p className="import-project-hint">
        Import an Overleaf / LaTeX project as a <code>.zip</code>. The whole tree is
        converted to Typst and you review the migration report before anything lands.
      </p>

      <div className="authoring-actions">
        <label className="authoring-primary import-project-pick" data-testid="import-project-pick">
          {unpacking ? "Unpacking…" : "Choose .zip…"}
          <input
            ref={fileInputRef as RefObject<HTMLInputElement>}
            type="file"
            accept=".zip,application/zip"
            data-testid="import-project-file"
            disabled={unpacking}
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickZip(file);
            }}
          />
        </label>
        {projectImport && (
          <button type="button" className="authoring-secondary" data-testid="import-project-clear" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      {zipError && (
        <Notice severity="error" testId="import-project-error" message={zipError} />
      )}

      {projectImport && (
        <ProjectReport projectImport={projectImport} onAccept={onAccept} />
      )}
    </div>
  );
}

function ProjectReport({
  projectImport,
  onAccept,
}: {
  projectImport: ProjectImport;
  onAccept: () => void;
}) {
  const { files, report, mainPath } = projectImport;
  const counts = summarizeOutcomes(report);
  // The SAME VFS gate the create step applies at Accept time, run at review time
  // so the headline + Accept counts are honest about what will land — and the
  // dropped paths are grouped by reason BEFORE the user accepts.
  const kept = toSafeProjectFiles(files).kept;
  const droppedGroups = summarizeDroppedPaths(files, report);
  const droppedCount = droppedGroups.reduce((n, g) => n + g.paths.length, 0);
  return (
    <div className="import-project-report" data-testid="import-project-report">
      <div className="import-project-summary" data-testid="import-project-summary">
        <strong>{kept.length}</strong> file(s) ready ·{" "}
        {counts.converted} converted · {counts.passthrough} passed through ·{" "}
        {counts.skipped} skipped · {report.assets.length} asset(s)
        {mainPath && (
          <>
            {" "}· main <code>{mainPath}</code>
          </>
        )}
      </div>

      {droppedGroups.length > 0 && (
        <details className="authoring-report" data-testid="import-project-dropped" open>
          <summary>{droppedCount} path(s) won't be imported</summary>
          {droppedGroups.map((g) => (
            <div
              key={g.reason}
              className="import-dropped-group"
              data-testid="import-project-dropped-group"
              data-reason={g.reason}
            >
              <p className="import-dropped-label">{g.label}</p>
              <ul>
                {g.paths.map((p) => (
                  <li key={p} data-testid="import-project-dropped-path">
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}

      <details className="authoring-report" data-testid="import-project-outcomes" open>
        <summary>Per-file outcomes</summary>
        <ul>
          {report.outcomes.map((o, i) => (
            <li key={i} data-testid="import-project-outcome">
              <code>{o.action}</code> · {o.sourcePath}
              {o.outputPath && o.outputPath !== o.sourcePath ? ` → ${o.outputPath}` : ""}
              {o.orphaned ? " (orphaned)" : ""}
              {o.note ? ` — ${o.note}` : ""}
            </li>
          ))}
        </ul>
      </details>

      {report.unconverted.length > 0 && (
        <details className="authoring-report" data-testid="import-project-unconverted">
          <summary>{report.unconverted.length} construct(s) not fully converted</summary>
          <ul>
            {report.unconverted.map((u, i) => (
              <li key={i}>
                <code>{u.kind}</code> · {u.path} line {u.line}: {u.snippet}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.unresolvedIncludes.length > 0 && (
        <details className="authoring-report" data-testid="import-project-unresolved">
          <summary>{report.unresolvedIncludes.length} unresolved include(s)</summary>
          <ul>
            {report.unresolvedIncludes.map((u, i) => (
              <li key={i}>
                {u.from} line {u.line}: <code>{u.target}</code> ({u.reason})
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.assets.length > 0 && (
        <details className="authoring-report" data-testid="import-project-assets">
          <summary>{report.assets.length} asset(s) — bytes not imported</summary>
          <ul>
            {report.assets.map((a, i) => (
              <li key={i}>
                <code>{a.path}</code>
                {a.referencedBy.length > 0 ? ` · referenced by ${a.referencedBy.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.warnings.length > 0 && (
        <details className="authoring-report" data-testid="import-project-warnings" open>
          <summary>{report.warnings.length} warning(s)</summary>
          <ul>
            {report.warnings.map((w, i) => (
              <li key={i}>
                <code>{w.kind}</code>: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="authoring-actions">
        <button
          type="button"
          className="authoring-primary"
          data-testid="import-project-accept"
          disabled={kept.length === 0}
          onClick={onAccept}
        >
          Add {kept.length} file(s) to project
        </button>
      </div>
    </div>
  );
}
