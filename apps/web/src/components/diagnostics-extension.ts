/**
 * In-editor diagnostics (roadmap #11.4, mechanism only).
 *
 * Paints compiler diagnostics into a CodeMirror 6 editor:
 *   - squiggly underline marks over each diagnostic's span (error vs warning),
 *   - a gutter marker on each diagnostic's start line (error vs warning).
 *
 * Diagnostics live in a `StateField`, updated out-of-band via a `StateEffect`
 * (`setDiagnosticsEffect`) which a host dispatches with `setDiagnostics(view, …)`.
 * All CSS ships via `EditorView.baseTheme(…)` so this never touches `styles.css`.
 *
 * DEFAULT-OFF: the field starts empty, so an editor that never dispatches an
 * effect renders byte-for-byte identically to one without this extension — no
 * marks, no gutter, no behaviour change. Callers that don't pass a `diagnostics`
 * prop hit exactly this path.
 *
 * Span coordinates: `Diagnostic.span` uses 1-based line/column (UTF-16 columns),
 * per `@galley/shared`'s `SourcePosition`. `diagnosticsToRanges` derives absolute
 * UTF-16 offsets from the document text + line/column (it does NOT trust the
 * span's cached `offset`/`endOffset`, which may be stale against the live doc).
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import {
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { Diagnostic } from "@galley/shared";

/** A resolved, paintable diagnostic range in absolute UTF-16 offsets. */
export interface DiagnosticRange {
  from: number;
  to: number;
  severity: string;
}

/**
 * PURE: map diagnostics' 1-based line/column spans into absolute UTF-16 offsets
 * into `docText`. Diagnostics without a span are skipped. Out-of-range lines and
 * columns are clamped into the document; zero/negative-width ranges are dropped.
 * Output order mirrors input order.
 */
export function diagnosticsToRanges(
  docText: string,
  diagnostics: Diagnostic[],
): DiagnosticRange[] {
  // Precompute the absolute start offset of each 1-based line.
  const lineStarts = lineStartOffsets(docText);
  const docLen = docText.length;
  const out: DiagnosticRange[] = [];

  for (const d of diagnostics) {
    if (!d.span) continue; // no span -> nothing to paint (safe skip)
    const from = posToOffset(d.span.start.line, d.span.start.column, lineStarts, docLen);
    const to = posToOffset(d.span.end.line, d.span.end.column, lineStarts, docLen);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    if (hi <= lo) continue; // zero/negative width -> nothing to underline
    out.push({ from: lo, to: hi, severity: d.severity });
  }
  return out;
}

/** Absolute offset where each line begins (index 0 == line 1's start). */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/**
 * Convert a 1-based (line, column) into an absolute offset, clamped to the doc.
 * Column is 1-based, so column N sits at lineStart + (N - 1). The result is
 * clamped to [0, docLen] and never past the line's own end (the next line's
 * start, or docLen for the last line).
 */
function posToOffset(line: number, column: number, lineStarts: number[], docLen: number): number {
  const li = Math.max(0, Math.min(line - 1, lineStarts.length - 1));
  const lineStart = lineStarts[li] ?? 0;
  // End of this line's content = start of next line minus its newline, or docLen.
  const lineEnd = li + 1 < lineStarts.length ? (lineStarts[li + 1] ?? docLen) - 1 : docLen;
  const col0 = Math.max(0, column - 1);
  return Math.max(0, Math.min(lineStart + col0, lineEnd, docLen));
}

// ---------------------------------------------------------------------------
// CM6 extension
// ---------------------------------------------------------------------------

/** Effect carrying the latest diagnostics set into the editor state. */
export const setDiagnosticsEffect = StateEffect.define<Diagnostic[]>();

/** The diagnostics currently held in editor state. */
const diagnosticsField = StateField.define<Diagnostic[]>({
  create() {
    return [];
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiagnosticsEffect)) return e.value;
    }
    return value;
  },
});

const errorMark = Decoration.mark({ class: "cm-diagnostic-error" });
const warningMark = Decoration.mark({ class: "cm-diagnostic-warning" });

/** Build the underline decoration set from the field's diagnostics. */
const underlineField = StateField.define<DecorationSet>({
  create(state) {
    return buildUnderlines(state.field(diagnosticsField), state.doc.toString());
  },
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(setDiagnosticsEffect))) {
      return buildUnderlines(tr.state.field(diagnosticsField), tr.state.doc.toString());
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildUnderlines(diagnostics: Diagnostic[], docText: string): DecorationSet {
  const ranges = diagnosticsToRanges(docText, diagnostics);
  // RangeSetBuilder requires ascending `from`; sort defensively.
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    builder.add(r.from, r.to, r.severity === "error" ? errorMark : warningMark);
  }
  return builder.finish();
}

class DiagnosticGutterMarker extends GutterMarker {
  constructor(private readonly severity: string) {
    super();
  }
  override eq(other: DiagnosticGutterMarker): boolean {
    return other.severity === this.severity;
  }
  override toDOM(): Node {
    const span = document.createElement("span");
    span.className =
      this.severity === "error" ? "cm-diagnostic-gutter-error" : "cm-diagnostic-gutter-warning";
    span.textContent = this.severity === "error" ? "●" : "▲"; // ● / ▲
    return span;
  }
}

const errorGutterMarker = new DiagnosticGutterMarker("error");
const warningGutterMarker = new DiagnosticGutterMarker("warning");

/**
 * Gutter showing one marker per diagnostic line. Error wins over warning when
 * both land on the same line. Built lazily per line from the underline ranges.
 */
const diagnosticGutter = gutter({
  class: "cm-diagnostic-gutter",
  lineMarker(view, line) {
    const diagnostics = view.state.field(diagnosticsField);
    if (diagnostics.length === 0) return null;
    const ranges = diagnosticsToRanges(view.state.doc.toString(), diagnostics);
    let severity: string | null = null;
    for (const r of ranges) {
      // A range touches this line if it overlaps [line.from, line.to].
      if (r.from <= line.to && r.to >= line.from) {
        if (r.severity === "error") {
          severity = "error";
          break;
        }
        severity = "warning";
      }
    }
    if (severity === null) return null;
    return severity === "error" ? errorGutterMarker : warningGutterMarker;
  },
  // Only rebuild markers when diagnostics actually change.
  lineMarkerChange: (update) =>
    update.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect))) ||
    update.docChanged,
  // No `initialSpacer`: with no diagnostics the gutter reserves no width, so the
  // default-off path stays visually identical to an editor without this gutter.
});

const diagnosticsTheme = EditorView.baseTheme({
  ".cm-diagnostic-error": {
    // Design tokens (styles.css :root): proofreader's vermilion / olive warn.
    textDecoration: "underline wavy var(--err, #c0392b)",
    textDecorationSkipInk: "none",
  },
  ".cm-diagnostic-warning": {
    textDecoration: "underline wavy var(--warn, #8a5a0a)",
    textDecorationSkipInk: "none",
  },
  ".cm-diagnostic-gutter": {
    width: "1.1em",
    textAlign: "center",
  },
  ".cm-diagnostic-gutter-error": {
    color: "var(--err, #c0392b)",
    fontSize: "0.7em",
    lineHeight: "1",
  },
  ".cm-diagnostic-gutter-warning": {
    color: "var(--warn, #8a5a0a)",
    fontSize: "0.7em",
    lineHeight: "1",
  },
});

/**
 * The diagnostics extension. Holds an (initially empty) diagnostics set and
 * paints underlines + a gutter from it. Inert until `setDiagnostics` is
 * dispatched, so editors that never call it are unchanged.
 */
export function diagnosticsExtension(): Extension {
  return [diagnosticsField, underlineField, diagnosticGutter, diagnosticsTheme];
}

/**
 * Dispatch a new diagnostics set into a live view (no remount). Pass `undefined`
 * or `[]` to clear. Safe to call from a React effect keyed on the prop.
 */
export function setDiagnostics(view: EditorView, diagnostics?: Diagnostic[]): void {
  view.dispatch({ effects: setDiagnosticsEffect.of(diagnostics ?? []) });
}

/**
 * The absolute offset of a diagnostic's start (1-based line/column → UTF-16
 * offset against `docText`), or null when it has no span. Shares the same pure
 * mapping as `diagnosticsToRanges`.
 */
export function diagnosticToPos(docText: string, d: Diagnostic): number | null {
  if (!d.span) return null;
  const lineStarts = lineStartOffsets(docText);
  return posToOffset(d.span.start.line, d.span.start.column, lineStarts, docText.length);
}

/**
 * Move the cursor to a diagnostic's location, scroll it into view, and focus the
 * editor — the "click a diagnostic to jump" affordance. No-op for a null view or
 * a span-less diagnostic, so a caller can wire it unconditionally.
 */
export function jumpToDiagnostic(view: EditorView | null, d: Diagnostic): void {
  if (!view) return;
  const pos = diagnosticToPos(view.state.doc.toString(), d);
  if (pos == null) return;
  jumpToOffset(view, pos);
}

/**
 * Move the cursor to an absolute UTF-16 offset, scroll it into view, and focus
 * the editor — the "click an outline heading to jump" affordance (#12.7). The
 * offset is clamped into the live document, so a stale offset never throws.
 * No-op for a null view, so a caller can wire it unconditionally.
 */
export function jumpToOffset(view: EditorView | null, offset: number): void {
  if (!view) return;
  const pos = Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}

// Re-export for callers/tests that want the empty set sentinel.
export const emptyDecorations: DecorationSet = RangeSet.empty;
