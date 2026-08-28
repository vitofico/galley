/**
 * Pure derivation for the unified status chip (#19.3, spec §2): the brand
 * pill's many readouts (page-count status, save badge, package/compile
 * notices, server indicators) collapse into ONE calm chip — this module
 * decides the chip's leading glyph + tone from the same inputs. No React, no
 * DOM: unit-tested in the node gate.
 */

/** The chip's visual tone (drives the glyph colour). */
export type StatusTone = "busy" | "error" | "warn" | "info" | "ok";

export interface StatusGlyphInputs {
  /** Compiler initialised (status is no longer "Loading compiler…"). */
  ready: boolean;
  /**
   * H1: a recompile is in flight AND has outlasted the busy threshold (~150ms),
   * so the preview on screen is stale. Shows the same `◌` cue as booting. Optional
   * — absent ⇒ not busy, so warm sub-threshold compiles (and existing callers)
   * stay byte-for-byte calm.
   */
  busy?: boolean;
  /** A compile input exists (a live main file, no duplicate-path conflict). */
  hasInput: boolean;
  /** Error-severity diagnostics in the last compile. */
  errorCount: number;
  /** Fail-closed: the doc needs @preview packages and no trusted server exists. */
  packagesUnavailable: boolean;
  /** The doc was routed to the configured compile server (egress notice). */
  packagesOnServer: boolean;
  /** The live preview compiler is a server compiler (mode or auto-fallback). */
  serverActive: boolean;
}

/**
 * Severity ladder (most salient wins): still booting OR recompiling (H1) → errors
 * → blocked packages / no compilable input → server involvement (info) → all good.
 * A live recompile shows the `◌` cue (the visible output is stale) and supersedes
 * the resolved glyphs so the chip never sits on a stale "✓ N pages" mid-compile.
 */
export function statusGlyph(s: StatusGlyphInputs): { tone: StatusTone; glyph: string } {
  if (!s.ready || s.busy) return { tone: "busy", glyph: "◌" };
  if (s.errorCount > 0) return { tone: "error", glyph: "✕" };
  if (s.packagesUnavailable || !s.hasInput) return { tone: "warn", glyph: "⚠" };
  if (s.packagesOnServer || s.serverActive) return { tone: "info", glyph: "↗" };
  return { tone: "ok", glyph: "✓" };
}
