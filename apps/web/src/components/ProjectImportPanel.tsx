import { useEffect, useRef, useState } from "react";
import { importLatexProject } from "@galley/agent";
import type { LatexProjectReport, ProjectTextFile } from "@galley/agent";
import { readProjectZip, ZipImportError, MAX_ZIP_BYTES } from "./import-project.js";
import { ProjectImportBody, type ProjectImport } from "./project-import-review.js";
import { importProjectFromZip } from "../import-create.js";
import "./authoring-panels.css";
import "./import-project.css";

/**
 * Import a project (.zip) from the **Projects page** (project-model redesign §3,
 * relocated here from the document's Insert menu — a zip is usually a whole
 * project, not a snippet). Pick an Overleaf/LaTeX `.zip`, review the honest
 * per-file migration report, and Accept to create a NEW project from the
 * converted tree (named after the zip) and navigate to it.
 *
 * Self-contained + modal: it owns the zip-pick/review state and reuses the
 * shared `ProjectImportBody` review UI; Accept defaults to the real
 * `importProjectFromZip` (create + navigate), injectable for tests.
 */
export interface ProjectImportPanelProps {
  open: boolean;
  onClose: () => void;
  /** Create the project from the reviewed tree. Defaults to the real flow. */
  onImport?: (
    files: ProjectTextFile[],
    report: LatexProjectReport,
    filename: string,
  ) => boolean | Promise<boolean>;
}

export function ProjectImportPanel({
  open,
  onClose,
  onImport = importProjectFromZip,
}: ProjectImportPanelProps) {
  const [projectImport, setProjectImport] = useState<ProjectImport | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [unpacking, setUnpacking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const reset = () => {
    setProjectImport(null);
    setZipError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Unpack a picked .zip → run importLatexProject → hold the result for review.
  // Honest failure: a typed ZipImportError surfaces its message; nothing lands
  // until the user Accepts. (Same logic the document Insert panel used to run.)
  const onPickZip = async (file: File) => {
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

  const onAccept = () => {
    if (!projectImport) return;
    // Creating the new project is async (registry write + navigate). On success
    // the host navigates away (this page unmounts); on failure surface the error
    // and stay put so a half-created project is never opened.
    void (async () => {
      try {
        const ok = await onImport(projectImport.files, projectImport.report, projectImport.filename);
        if (ok) {
          reset();
          onClose();
        }
      } catch (err) {
        setZipError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  return (
    <div
      className="authoring-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Import a project"
      data-testid="project-import-panel"
      onClick={onClose}
    >
      <div className="authoring-panel" onClick={(e) => e.stopPropagation()}>
        <header className="authoring-header">
          <h2 className="authoring-title">Import a project</h2>
          <button type="button" className="authoring-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="authoring-body">
          <ProjectImportBody
            projectImport={projectImport}
            zipError={zipError}
            unpacking={unpacking}
            fileInputRef={fileInputRef}
            onPickZip={onPickZip}
            onClear={reset}
            onAccept={onAccept}
          />
        </div>
      </div>
    </div>
  );
}
