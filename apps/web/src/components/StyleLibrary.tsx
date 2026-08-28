import { useEffect, useRef, useState } from "react";
import type { Style, Styleability } from "../style-manifest.js";
import { negotiate } from "../style-manifest.js";
import { BUILT_IN_STYLES } from "../styles-library/index.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./style-library.css";

/**
 * Calm one-liner under the picker header: says what a style change does — it
 * re-skins the document's appearance only, the content is untouched. Exported so
 * the copy is asserted in tests.
 */
export const STYLE_LIBRARY_INTRO =
  "Pick a style to change how this document looks — its content stays exactly as it is. Styles are appearance only.";

/**
 * The doc-GLOBAL blocking notice: a document that can't switch styles at all.
 * Only `incompatible` (fail-closed wildcard import) and `non-conforming` (no
 * /style.typ to swap) are globally blocked; `clean`/`shimmed` are switchable in
 * principle and return null — whether a SPECIFIC style applies is decided
 * per-style by {@link styleCapabilityGap}. The reason text comes from the
 * classifier (style-manifest.ts) so the copy stays in one place.
 */
export function styleabilityNotice(s: Styleability): string | null {
  if (s.state === "incompatible" || s.state === "non-conforming") {
    return s.reason ?? "This document can't switch styles automatically yet.";
  }
  return null;
}

/**
 * The PER-STYLE capability gap (Phase 2): the helpers the document requires that
 * this style does not provide (sorted). Empty ⇒ this style can apply. For a
 * doc-globally-blocked document this is empty — `styleabilityNotice` owns that
 * case, and `requiredCapabilities` is empty there anyway.
 */
export function styleCapabilityGap(s: Styleability, style: Style): string[] {
  const result = negotiate(s.requiredCapabilities, style.manifest.capabilities);
  return result.ok ? [] : result.missing;
}

/** The async remote-catalog loading state a host can hand the picker (see `useStyleSources`). */
export interface StyleListing {
  loading: boolean;
  errors: readonly { sourceId: string; message: string }[];
}

/**
 * The calm inline note for the async remote-catalog lane: `null` (render
 * nothing) unless a source is loading or some failed. Kept pure + exported so
 * the copy is pinned in tests and an ABSENT `listing` prop is byte-for-byte the
 * current picker. Failures are counted by distinct source, not raw error rows.
 */
export function styleListingNote(
  listing?: StyleListing,
): { kind: "loading" | "error"; text: string } | null {
  if (!listing) return null;
  if (listing.loading) return { kind: "loading", text: "Loading more styles…" };
  if (listing.errors.length > 0) {
    const sources = new Set(listing.errors.map((e) => e.sourceId)).size;
    return { kind: "error", text: `Some styles couldn't be loaded (${sources} source${sources === 1 ? "" : "s"}).` };
  }
  return null;
}

/**
 * StyleLibrary (styles WS-C) — browse the bundled appearance-only styles and
 * pick one to apply to the current document.
 *
 * PRESENTATIONAL + CONTROLLED, modeled on TemplatePicker: a backdrop + centered
 * card with Escape/close, a selectable grid of style cards, and an explicit
 * "Apply" confirm. It owns only the local highlight; the chosen style is handed
 * back through `onApply` and the HOST owns the trial-compile + apply transaction
 * (it drives `busy` while a trial-compile is in flight). When the document can't
 * switch styles (`styleabilityNotice` non-null), a prominent banner explains why
 * and Apply is disabled. Defaults `styles` to the bundled `BUILT_IN_STYLES` so a
 * bare `<StyleLibrary open … />` shows the catalog.
 */
export interface StyleLibraryProps {
  open: boolean;
  onClose: () => void;
  /** Catalog to browse; defaults to the bundled `BUILT_IN_STYLES`. */
  styles?: Style[];
  /**
   * Loading/error state of the async remote-catalog lane (`useStyleSources`).
   * Absent ⇒ the picker renders byte-for-byte as before; when present a calm
   * inline note reports loading or a failed source. Remote styles themselves
   * arrive via `styles` (the host appends them), never through this prop.
   */
  listing?: StyleListing;
  /** How (and whether) the current document can switch styles. */
  styleability: Styleability;
  /** True while the host runs a trial-compile; disables Apply + shows pending. */
  busy?: boolean;
  /** The user picked a style (their explicit confirm). */
  onApply: (style: Style) => void;
  /**
   * Capture the project's CURRENT `/style.typ` as a named local style (save your
   * own). When omitted the "Save current style…" button is not rendered, so the
   * picker stays byte-for-byte as before for hosts that don't wire it.
   */
  onSaveCurrent?: (name: string) => void;
  /**
   * Delete a saved (non-builtin) style by id. When omitted, saved cards render no
   * delete affordance. Only non-builtin cards ever show it.
   */
  onDeleteStyle?: (id: string) => void;
}

export function StyleLibrary({
  open,
  onClose,
  styles,
  listing,
  styleability,
  busy = false,
  onApply,
  onSaveCurrent,
  onDeleteStyle,
}: StyleLibraryProps) {
  const catalog = styles ?? BUILT_IN_STYLES;
  // Local highlight only; the host is the source of truth for what gets applied.
  // Defaults to the first style so Enter/confirm always has a target.
  const [selectedId, setSelectedId] = useState<string | null>(
    catalog[0]?.manifest.id ?? null,
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const applyRef = useRef<HTMLButtonElement | null>(null);

  // A11y: trap Tab within the dialog + restore focus to the trigger on close.
  useFocusTrap(dialogRef, open);

  // Re-seed the highlight whenever the panel (re)opens or the catalog changes, so
  // a stale id from a previous open never lingers.
  useEffect(() => {
    if (open) setSelectedId(catalog[0]?.manifest.id ?? null);
  }, [open, catalog]);

  // A11y: move focus INTO the dialog on open (the primary "Apply" action) so
  // keyboard users land inside it, not on the page behind.
  useEffect(() => {
    if (open) applyRef.current?.focus();
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

  const notice = styleabilityNotice(styleability);
  const listingNote = styleListingNote(listing);
  const blocked = notice !== null;
  const selected = catalog.find((s) => s.manifest.id === selectedId) ?? null;
  // The selected style can't apply if it lacks a helper this document needs.
  const selectedGap = selected ? styleCapabilityGap(styleability, selected) : [];
  const applyDisabled = selected === null || blocked || selectedGap.length > 0 || busy;

  return (
    <div
      className="style-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Change style"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="style-panel"
        data-testid="style-library"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="style-header">
          <h2 className="style-title">Change style</h2>
          <button type="button" className="style-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="style-intro" data-testid="style-intro">
          {STYLE_LIBRARY_INTRO}
        </p>

        {notice !== null && (
          <div className="style-notice" role="alert" data-testid="style-notice">
            {notice}
          </div>
        )}

        {listingNote !== null && (
          // Async remote-catalog lane: a calm inline note (muted while loading,
          // an alert-styled line if a source failed). Never blocks Apply — the
          // built-ins/local styles are always already present in `styles`.
          <div
            className={listingNote.kind === "error" ? "style-notice" : "style-intro"}
            role="status"
            aria-live="polite"
            data-testid="style-listing"
            data-kind={listingNote.kind}
          >
            {listingNote.text}
          </div>
        )}

        <div
          className="style-grid"
          role="radiogroup"
          aria-label="Document styles"
          data-testid="style-grid"
        >
          {catalog.map((s) => {
            const active = s.manifest.id === selectedId;
            // Per-style negotiation: a style missing a helper this document needs
            // can't apply — the card is disabled and names what's missing.
            const gap = blocked ? [] : styleCapabilityGap(styleability, s);
            const cardBlocked = gap.length > 0;
            // A saved (non-builtin) style can be deleted, when the host wires it.
            const deletable = !s.manifest.builtin && onDeleteStyle !== undefined;
            return (
              <button
                type="button"
                key={s.manifest.id}
                className="style-card"
                data-testid="style-card"
                data-style-id={s.manifest.id}
                data-builtin={s.manifest.builtin ? "true" : "false"}
                data-selected={active ? "true" : "false"}
                data-blocked={cardBlocked ? "true" : "false"}
                role="radio"
                aria-checked={active}
                disabled={cardBlocked}
                aria-disabled={cardBlocked}
                onClick={() => {
                  if (!cardBlocked) setSelectedId(s.manifest.id);
                }}
                onDoubleClick={() => {
                  if (!applyDisabled && !cardBlocked) onApply(s);
                }}
              >
                <span className="style-card-name">{s.manifest.name}</span>
                {s.manifest.description !== undefined && (
                  <span className="style-card-desc">{s.manifest.description}</span>
                )}
                {cardBlocked && (
                  <span className="style-card-gap" data-testid="style-card-gap">
                    Needs: {gap.join(", ")}
                  </span>
                )}
                {deletable && (
                  // Not a nested <button> (invalid inside the card button): a
                  // role=button span that stops propagation so deleting never
                  // also selects/applies the card.
                  <span
                    className="style-card-delete"
                    data-testid="style-delete"
                    data-style-id={s.manifest.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Delete ${s.manifest.name}`}
                    title="Delete this saved style"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteStyle?.(s.manifest.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onDeleteStyle?.(s.manifest.id);
                      }
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <footer className="style-footer">
          {onSaveCurrent !== undefined && (
            // Save your own: capture the project's current /style.typ under a
            // name. Prompt for the name; an empty/cancelled prompt is a no-op.
            <button
              type="button"
              className="style-secondary style-save"
              data-testid="style-save"
              title="Save the document's current style so you can re-apply it later"
              onClick={() => {
                const name = window.prompt("Name this style")?.trim();
                if (name) onSaveCurrent(name);
              }}
            >
              Save current style…
            </button>
          )}
          <button
            type="button"
            className="style-secondary"
            data-testid="style-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            ref={applyRef}
            className="style-primary"
            data-testid="style-apply"
            data-busy={busy ? "true" : "false"}
            disabled={applyDisabled}
            aria-busy={busy}
            onClick={() => {
              if (selected && !applyDisabled) onApply(selected);
            }}
          >
            {busy ? "Applying…" : "Apply"}
          </button>
        </footer>
      </div>
    </div>
  );
}
