import { useEffect, useRef, useState } from "react";
import { markdownToTypst, latexToTypst, importLatexProject } from "@galley/agent";
import type { LatexProjectReport, ProjectTextFile } from "@galley/agent";
import { DiffReview } from "./DiffReview.js";
import { appendSnippet } from "./authoring-insert.js";
import type { ImportRepairDepsProp, RepairCompiler } from "./import-repair.js";
import { repairStatusLabel, runImportRepair } from "./import-repair.js";
import { readProjectZip, ZipImportError, MAX_ZIP_BYTES } from "./import-project.js";
import { ProjectImportBody, type ProjectImport } from "./project-import-review.js";
import { Notice } from "./Notice.js";
import "./authoring-panels.css";
import "./import-project.css";

/**
 * Import wedge UI (roadmap #15) — paste Markdown or LaTeX, convert to Typst with
 * the deterministic offline converters (`markdownToTypst` / `latexToTypst`), and
 * review the result as a normal reviewable diff before it lands in the document.
 *
 * PRESENTATIONAL + CONTROLLED: it owns only its draft input/format/result; the
 * actual insertion goes through the host's conflict-aware `onInsert` (the same
 * Accept flow the agent uses), so the import is reviewable and never clobbers a
 * concurrent edit. Conversion is lossy by nature, so the honest unmapped/
 * unconverted report is shown alongside the diff — never silently dropped.
 */

export type ImportFormat = "markdown" | "latex";

interface ConversionReportItem {
  kind: string;
  line: number;
  snippet: string;
}

interface Conversion {
  typst: string;
  report: ConversionReportItem[];
}

export interface ImportPanelProps {
  open: boolean;
  onClose: () => void;
  /** The live document the converted Typst will be appended to (for the diff). */
  currentSource: string;
  /** Insert the converted Typst (conflict-aware). Returns true if applied. */
  onInsert: (snippet: string) => boolean;
  /**
   * OPTIONAL agent-repair step (roadmap #15.1). When provided, a "Repair with
   * agent" affordance appears on a converted result; running it drives the
   * `repairImportedTypst` loop and surfaces the repaired Typst as the new
   * reviewable result (Accept stays mandatory). When OMITTED — today's shell
   * call sites — the panel behaves byte-for-byte as before.
   */
  repair?: ImportRepairDepsProp;
  /**
   * Rail & Islands (#19.2): when true the panel renders as a DOCKED card (no
   * fixed backdrop, no modal dialog semantics) inside the shell's dock host.
   * Default false — the modal presentation is byte-for-byte unchanged.
   */
  docked?: boolean;
  /**
   * OPTIONAL multi-file project import (roadmap #17.3, project-model redesign
   * §3). When provided, a "Project (.zip)" mode appears: pick an Overleaf/LaTeX
   * `.zip`, unpack it with the narrow zip reader, run `importLatexProject`,
   * review the honest per-file migration report, and Accept to create a NEW
   * project from the converted tree (named after the zip). Async: it returns true
   * on success. When OMITTED — the single-file App.tsx shell — the zip mode does
   * not render and the panel behaves byte-for-byte as before.
   */
  onImportProject?: (
    files: ProjectTextFile[],
    report: LatexProjectReport,
    filename: string,
  ) => boolean | Promise<boolean>;
}

/** Run the chosen converter, normalizing both result shapes to one report list. */
export function convert(format: ImportFormat, input: string): Conversion {
  if (format === "latex") {
    const r = latexToTypst(input);
    return { typst: r.typst, report: r.unconverted };
  }
  const r = markdownToTypst(input);
  return { typst: r.typst, report: r.unmapped };
}

export function ImportPanel({ open, onClose, currentSource, onInsert, repair, docked, onImportProject }: ImportPanelProps) {
  const [format, setFormat] = useState<ImportFormat>("markdown");
  const [input, setInput] = useState("");
  const [conversion, setConversion] = useState<Conversion | null>(null);
  // Project (.zip) mode (#17.3) — only reachable when `onImportProject` is set.
  const [mode, setMode] = useState<"paste" | "project">("paste");
  const [projectImport, setProjectImport] = useState<ProjectImport | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [unpacking, setUnpacking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // The agent-repaired Typst, once a repair round has run. When set, it REPLACES
  // the converted `.typst` as the reviewable result; the converter's report is
  // still shown (the repair never re-reports unmapped constructs).
  const [repaired, setRepaired] = useState<string | null>(null);
  const [repairOk, setRepairOk] = useState(false);
  const [repairStatus, setRepairStatus] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  // The repair compiler, created lazily on first repair (its own worker, like
  // the agent's / Figure flow's) and disposed on unmount / close.
  const compilerRef = useRef<RepairCompiler | null>(null);

  const disposeCompiler = () => {
    compilerRef.current?.dispose?.();
    compilerRef.current = null;
  };

  useEffect(() => {
    return () => disposeCompiler();
  }, []);

  // Dispose the compiler whenever the panel closes, mirroring the lazy-create on
  // open — a closed panel holds no worker.
  useEffect(() => {
    if (!open) disposeCompiler();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const clearRepair = () => {
    setRepaired(null);
    setRepairOk(false);
    setRepairStatus(null);
    setRepairError(null);
  };
  const runConvert = () => {
    clearRepair();
    setConversion(convert(format, input));
  };
  const reset = () => {
    setInput("");
    setConversion(null);
    clearRepair();
  };

  const resetProject = () => {
    setProjectImport(null);
    setZipError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Unpack a picked .zip → run importLatexProject → hold the result for review.
  // Honest failure: a typed ZipImportError surfaces its message; nothing lands
  // until the user Accepts.
  const onPickZip = async (file: File) => {
    if (!onImportProject) return;
    setUnpacking(true);
    setZipError(null);
    setProjectImport(null);
    try {
      // Cap the RAW file BEFORE reading it into memory — a multi-GB pick would
      // OOM/freeze the tab in `file.arrayBuffer()` before any cap could apply.
      if (file.size > MAX_ZIP_BYTES) {
        throw new ZipImportError(
          "archive-too-large",
          `zip file is ${file.size} bytes; the limit is ${MAX_ZIP_BYTES}`,
        );
      }
      const buf = await file.arrayBuffer();
      const tree = await readProjectZip(buf);
      const result = importLatexProject(tree);
      setProjectImport({
        files: result.files,
        report: result.report,
        mainPath: result.mainPath,
        filename: file.name,
      });
    } catch (err) {
      const msg =
        err instanceof ZipImportError
          ? `Could not import this .zip: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setZipError(msg);
    } finally {
      setUnpacking(false);
    }
  };

  const runRepair = async () => {
    if (!repair || !conversion || repairing) return;
    setRepairing(true);
    setRepairError(null);
    try {
      if (!compilerRef.current) compilerRef.current = await repair.compilerFactory();
      const compiler = compilerRef.current;
      const result = await runImportRepair(
        { typst: conversion.typst, sourceKind: format, report: conversion.report },
        { model: repair.model, compiler, ...(repair.maxAttempts !== undefined ? { maxAttempts: repair.maxAttempts } : {}) },
      );
      setRepaired(result.typst);
      setRepairOk(result.ok);
      setRepairStatus(repairStatusLabel(result));
    } catch (err) {
      setRepairError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairing(false);
    }
  };

  // The reviewable Typst: the repaired draft once available, else the raw
  // conversion. Accept always inserts whatever is currently under review.
  const reviewTypst = repaired ?? conversion?.typst ?? "";
  const next = conversion ? appendSnippet(currentSource, reviewTypst) : currentSource;

  const panel = (
      <div
        className={`authoring-panel${docked ? " authoring-panel--docked" : ""}`}
        data-testid="import-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="authoring-header">
          <h2 className="authoring-title">Import → Typst</h2>
          <button type="button" className="authoring-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="authoring-body">
          {onImportProject && (
            <div className="import-mode-tabs" role="tablist" aria-label="Import source">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "paste"}
                className={`import-mode-tab${mode === "paste" ? " import-mode-tab--active" : ""}`}
                data-testid="import-mode-paste"
                onClick={() => setMode("paste")}
              >
                Paste text
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "project"}
                className={`import-mode-tab${mode === "project" ? " import-mode-tab--active" : ""}`}
                data-testid="import-mode-project"
                onClick={() => setMode("project")}
              >
                Project (.zip)
              </button>
            </div>
          )}

          {(!onImportProject || mode === "paste") && (
          <>
          <div className="authoring-format" role="radiogroup" aria-label="Source format">
            <label>
              <input
                type="radio"
                name="import-format"
                data-testid="import-format-markdown"
                checked={format === "markdown"}
                onChange={() => setFormat("markdown")}
              />
              Markdown
            </label>
            <label>
              <input
                type="radio"
                name="import-format"
                data-testid="import-format-latex"
                checked={format === "latex"}
                onChange={() => setFormat("latex")}
              />
              LaTeX
            </label>
          </div>

          <textarea
            className="authoring-input"
            data-testid="import-input"
            value={input}
            placeholder={`Paste ${format === "latex" ? "LaTeX" : "Markdown"} here…`}
            aria-label="Source to import"
            rows={6}
            onChange={(e) => setInput(e.target.value)}
          />

          <div className="authoring-actions">
            <button
              type="button"
              className="authoring-primary"
              data-testid="import-convert"
              disabled={input.trim().length === 0}
              onClick={runConvert}
            >
              Convert
            </button>
            {conversion && (
              <button type="button" className="authoring-secondary" data-testid="import-reset" onClick={reset}>
                Clear
              </button>
            )}
          </div>

          {conversion && (
            <>
              {conversion.report.length > 0 && (
                <details className="authoring-report" data-testid="import-report" open>
                  <summary>
                    {conversion.report.length} construct(s) not fully converted (review below)
                  </summary>
                  <ul>
                    {conversion.report.map((item, i) => (
                      <li key={i} data-testid="import-report-item">
                        <code>{item.kind}</code> · line {item.line}: {item.snippet}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {repair && (
                <div className="authoring-actions" data-testid="import-repair-actions">
                  <button
                    type="button"
                    className="authoring-secondary"
                    data-testid="import-repair-run"
                    disabled={repairing}
                    onClick={() => void runRepair()}
                  >
                    {repairing ? "Repairing…" : repaired ? "Repair again" : "Repair with agent"}
                  </button>
                </div>
              )}

              {repairError && (
                <Notice
                  severity="error"
                  testId="import-repair-error"
                  message={`Error: ${repairError}`}
                />
              )}

              {repairStatus && (
                <div
                  className="authoring-status"
                  data-testid="import-repair-result"
                  data-ok={repairOk ? "true" : "false"}
                >
                  {repairStatus}
                </div>
              )}

              <DiffReview
                base={currentSource}
                next={next}
                outcome="import"
                onAccept={() => {
                  if (onInsert(reviewTypst)) onClose();
                }}
                onReject={reset}
              />
            </>
          )}
          </>
          )}

          {onImportProject && mode === "project" && (
            <ProjectImportBody
              projectImport={projectImport}
              zipError={zipError}
              unpacking={unpacking}
              fileInputRef={fileInputRef}
              onPickZip={onPickZip}
              onClear={resetProject}
              onAccept={() => {
                if (!projectImport) return;
                // §3: creating the new project is async (registry write + nav).
                // On success the host navigates away (this panel unmounts); on
                // failure surface the existing import error UI and stay put so a
                // half-created project is never opened.
                void (async () => {
                  try {
                    const ok = await onImportProject(
                      projectImport.files,
                      projectImport.report,
                      projectImport.filename,
                    );
                    if (ok) {
                      resetProject();
                      onClose();
                    }
                  } catch (err) {
                    setZipError(err instanceof Error ? err.message : String(err));
                  }
                })();
              }}
            />
          )}
        </div>
      </div>
  );
  if (docked) return panel;
  return (
    <div
      className="authoring-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Import a document"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}
