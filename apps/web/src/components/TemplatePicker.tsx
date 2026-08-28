import { useEffect, useRef, useState } from "react";
import type { ProjectTemplate } from "../templates/index.js";
import { PROJECT_TEMPLATES } from "../templates/index.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./template-picker.css";

/**
 * Calm one-liner under the picker header (UX-1): says what these are and that
 * Typst Universe templates/packages need a configured server compiler, while
 * Local-only stays offline. Exported so the copy is asserted in tests.
 */
export const TEMPLATE_UNIVERSE_INTRO =
  "Start from a bundled template — these all build offline, no setup. The Typst Universe isn’t browsed here: to use a Universe template or style, enable a server compiler in Settings → Compile, then add `#import \"@preview/name:version\"` to your document — the offline Local compiler can’t fetch packages.";

/** Short, scannable badge label for package-backed templates. */
export const REQUIRES_PACKAGES_BADGE = "Universe packages";

/**
 * Why a package-backed template needs a server compiler, and how to enable it
 * (badge tooltip + aria-label). Actionable, not a dead "can't be built yet."
 */
export const REQUIRES_PACKAGES_HINT =
  "Uses Typst Universe @preview packages — enable a server compiler in Settings → Compile to build this template (Local-only can't resolve packages offline).";

/**
 * TemplatePicker (roadmap #2) — browse the bundled multi-file project templates
 * and pick one to instantiate into a fresh project. UNMOUNTED for now: Lane F
 * mounts it and wires `onPick` to the template→project transaction.
 *
 * PRESENTATIONAL + CONTROLLED, modeled on ImportPanel / the authoring overlays:
 * a backdrop + centered card with Escape/close, a selectable grid of template
 * cards, and an explicit "Use template" confirm. It owns only the local
 * highlight; the chosen template is handed back through `onPick` (the host
 * decides what instantiation means). Defaults `templates` to the bundled catalog
 * so a bare `<TemplatePicker open onClose={…} onPick={…} />` shows the showcase.
 */

export interface TemplatePickerProps {
  open: boolean;
  onClose: () => void;
  /** Catalog to browse; defaults to the bundled `PROJECT_TEMPLATES`. */
  templates?: ProjectTemplate[];
  /** The user picked a template (their explicit confirm). */
  onPick: (template: ProjectTemplate) => void;
}

/**
 * Human-readable file count, e.g. "1 file" / "5 files". The empty/no-op "start
 * from scratch" template (B8) reads "Empty project" rather than a bare "0 files".
 */
export function fileCountLabel(template: ProjectTemplate): string {
  const n = template.files.length;
  if (n === 0) return "Empty project";
  return `${n} file${n === 1 ? "" : "s"}`;
}

/**
 * Whether a template depends on `@preview` packages and therefore cannot be
 * instantiated by the offline/fail-closed browser worker (reserved for a later
 * server-backed slice). The bundled catalog leaves this unset, so every bundled
 * template reads `false`. The picker renders a "needs packages" badge when true.
 */
export function requiresPackages(template: ProjectTemplate): boolean {
  return template.requiresPackages ?? false;
}

export function TemplatePicker({ open, onClose, templates, onPick }: TemplatePickerProps) {
  const catalog = templates ?? PROJECT_TEMPLATES;
  // Local highlight only; the editor/host is the source of truth for what gets
  // created. Defaults to the first template so Enter/confirm always has a target.
  const [selectedId, setSelectedId] = useState<string | null>(catalog[0]?.id ?? null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const pickRef = useRef<HTMLButtonElement | null>(null);

  // A11y (#23.5): trap Tab within the dialog + restore focus to the trigger on
  // close. Additive — Escape is handled separately below.
  useFocusTrap(dialogRef, open);

  // Re-seed the highlight whenever the panel (re)opens or the catalog changes, so
  // a stale id from a previous open never lingers.
  useEffect(() => {
    if (open) setSelectedId(catalog[0]?.id ?? null);
  }, [open, catalog]);

  // A11y (#23.5): move focus INTO the dialog on open (the primary "Use template"
  // action) so keyboard users land inside it, not on the page behind.
  useEffect(() => {
    if (open) pickRef.current?.focus();
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

  const selected = catalog.find((t) => t.id === selectedId) ?? null;

  return (
    <div
      className="template-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Start from a template"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="template-panel"
        data-testid="template-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="template-header">
          <h2 className="template-title">Start from a template</h2>
          <button type="button" className="template-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="template-intro" data-testid="template-intro">
          {TEMPLATE_UNIVERSE_INTRO}
        </p>

        <div
          className="template-grid"
          role="radiogroup"
          aria-label="Project templates"
          data-testid="template-grid"
        >
          {catalog.map((t) => {
            const active = t.id === selectedId;
            const needsPackages = requiresPackages(t);
            return (
              <button
                type="button"
                key={t.id}
                className="template-card"
                data-testid="template-card"
                data-template-id={t.id}
                data-selected={active ? "true" : "false"}
                data-requires-packages={needsPackages ? "true" : "false"}
                role="radio"
                aria-checked={active}
                onClick={() => setSelectedId(t.id)}
                onDoubleClick={() => onPick(t)}
              >
                <span className="template-card-name-row">
                  <span className="template-card-name">{t.name}</span>
                  {needsPackages && (
                    <span
                      className="template-card-badge"
                      data-testid="template-requires-packages"
                      title={REQUIRES_PACKAGES_HINT}
                      aria-label={REQUIRES_PACKAGES_HINT}
                    >
                      {REQUIRES_PACKAGES_BADGE}
                    </span>
                  )}
                </span>
                <span className="template-card-desc">{t.description}</span>
                <span className="template-card-meta">{fileCountLabel(t)}</span>
              </button>
            );
          })}
        </div>

        <footer className="template-footer">
          <button
            type="button"
            className="template-secondary"
            data-testid="template-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={pickRef}
            className="template-primary"
            data-testid="template-pick"
            disabled={selected === null}
            onClick={() => {
              if (selected) onPick(selected);
            }}
          >
            Use template
          </button>
        </footer>
      </div>
    </div>
  );
}
