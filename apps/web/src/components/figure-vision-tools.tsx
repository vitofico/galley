import { useRef, useState } from "react";
import {
  figureFromSketch,
  suggestAltText,
  judgeLayout,
  cetzScaffold,
} from "@galley/agent";
import type { LanguageModelClient, LayoutFeedback, FigureResult } from "@galley/agent";
import type { ProviderCapabilities } from "@galley/shared";
import type { VerifyCompiler, VerifyCompilerFactory } from "./figure-verify.js";
import type { SvgToPngCapture } from "./preview-image-capture.js";
import { svgToPngDataUrl } from "./preview-image-capture.js";
import { Notice } from "./Notice.js";
import "./figure-vision.css";

/**
 * Multimodal figure tools (roadmap #8 sketch half + #10 layout judge + alt-text)
 * — the UI activation of the vision cores already on main. Mounted INSIDE
 * FigurePanel, GATED on the transport's `supportsImageInput` capability so the
 * affordances only appear when an image-capable model is actually wired.
 *
 * HUMAN-ACCEPT GATE, per affordance:
 *  - From sketch (#8): `figureFromSketch` → a CeTZ draft that flows through the
 *    SAME reviewable `onInsert` path as describe→generate (caller still Accepts).
 *  - Suggest alt-text: `suggestAltText` → a suggestion shown for copy / insert;
 *    insertion (when chosen) goes through `onInsert`. Never auto-written.
 *  - Judge layout (#10): capture the live preview → `judgeLayout` → render the
 *    `LayoutFeedback` as ADVISORY text only. NEVER applied, never inserted.
 *
 * The three orchestrations are exported as PURE async helpers (no React) so the
 * Node unit gate drives the exact injected interaction with fakes; the component
 * is a thin shell over them. The capture function is an INJECTABLE prop so tests
 * stub it (Canvas is unavailable in the unit env).
 */

// ── Pure orchestrations (Node-testable; the component is a shell over these) ──

/** Read a `File` as raw bytes for the multimodal image part. */
export async function fileToImageBytes(
  file: Blob,
): Promise<{ data: Uint8Array; mimeType?: string }> {
  const buf = await file.arrayBuffer();
  const mimeType = (file as { type?: string }).type || undefined;
  return mimeType ? { data: new Uint8Array(buf), mimeType } : { data: new Uint8Array(buf) };
}

/**
 * Sketch → CeTZ draft. Builds the verify/generate compiler from the injected
 * factory, runs `figureFromSketch`, and normalizes the snippet exactly like
 * FigurePanel's describe→generate path (fall back to a scaffold when the model
 * didn't return CeTZ). Returns the draft + the raw result for status display.
 * The caller routes the snippet through `onInsert` — this NEVER inserts.
 */
export async function runSketchToFigure(args: {
  image: { data: string | Uint8Array; mimeType?: string };
  description?: string;
  model: LanguageModelClient;
  compiler: VerifyCompiler;
}): Promise<{ result: FigureResult; snippet: string }> {
  const description = args.description?.trim() ? args.description.trim() : undefined;
  const result = await figureFromSketch({
    sketch: args.image,
    ...(description ? { description } : {}),
    model: args.model,
    compiler: { check: (s: string) => args.compiler.check(s) },
    // CeTZ can't resolve in the fail-closed browser compiler; if the host
    // injected a server-capable one it can self-correct, else one honest round.
    maxAttempts: 1,
  });
  const snippet = result.typst.includes("cetz")
    ? result.typst
    : cetzScaffold(description ?? "figure from sketch");
  return { result, snippet };
}

/** Alt-text suggestion for the current figure/source. Returns a string only. */
export async function runSuggestAltText(args: {
  image: { data: string | Uint8Array; mimeType?: string };
  context?: string;
  model: LanguageModelClient;
}): Promise<string> {
  const context = args.context?.trim() ? args.context.trim() : undefined;
  return suggestAltText({
    image: args.image,
    ...(context ? { context } : {}),
    model: args.model,
  });
}

/**
 * Judge the live preview's layout. Captures the preview SVG to a PNG via the
 * injected capture seam (fail-closed → null) and asks `judgeLayout`. Returns the
 * structured ADVISORY feedback, or null when capture failed (so the caller can
 * show an honest "couldn't capture the preview" hint WITHOUT calling the model).
 */
export async function runJudgeLayout(args: {
  source: string;
  previewSvg: string;
  model: LanguageModelClient;
  capture: SvgToPngCapture;
}): Promise<LayoutFeedback | null> {
  const png = await args.capture(args.previewSvg);
  if (!png) return null;
  return judgeLayout({
    source: args.source,
    image: { data: png, mimeType: "image/png" },
    model: args.model,
  });
}

// ── The React shell ─────────────────────────────────────────────────────────

export interface FigureVisionToolsProps {
  model: LanguageModelClient;
  currentSource: string;
  /** Routes accepted snippets through the host's conflict-aware insert (Accept). */
  onInsert: (snippet: string) => boolean;
  /** Gate: multimodal tools only render enabled when the transport carries images. */
  capabilities?: ProviderCapabilities;
  /** The live preview markup to rasterize for the #10 layout judge. */
  previewSvg?: string;
  /** Server-capable compiler factory for the sketch self-correction loop (#8). */
  verifyCompilerFactory?: VerifyCompilerFactory;
  /** INJECTABLE capture seam (Canvas-free in tests). Defaults to the real one. */
  capture?: SvgToPngCapture;
}

export function FigureVisionTools({
  model,
  currentSource,
  onInsert,
  capabilities,
  previewSvg,
  verifyCompilerFactory,
  capture = svgToPngDataUrl,
}: FigureVisionToolsProps) {
  const enabled = capabilities?.supportsImageInput === true;

  // Lazily-built compiler for the sketch loop, disposed on unmount/close by the
  // parent's lifecycle (the panel disposes via its own ref); we build on demand.
  const compilerRef = useRef<VerifyCompiler | null>(null);

  const [busy, setBusy] = useState<null | "sketch" | "alt" | "judge">(null);
  const [error, setError] = useState<string | null>(null);

  // Sketch draft (reviewable via DiffReview-less inline insert through onInsert).
  const [sketchSnippet, setSketchSnippet] = useState<string | null>(null);
  const [sketchOk, setSketchOk] = useState(false);

  const [altText, setAltText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [feedback, setFeedback] = useState<LayoutFeedback | null>(null);
  const [captureFailed, setCaptureFailed] = useState(false);

  if (!enabled) {
    return (
      <div className="figure-vision" data-testid="figure-vision">
        <div className="figure-vision-hint" data-testid="figure-vision-disabled">
          Connect a vision-capable model to use sketch import, alt-text, and layout
          review.
        </div>
      </div>
    );
  }

  const acquireCompiler = async (): Promise<VerifyCompiler> => {
    if (compilerRef.current) return compilerRef.current;
    if (!verifyCompilerFactory) {
      throw new Error("No compiler available to verify the figure (server compile required).");
    }
    compilerRef.current = await verifyCompilerFactory();
    return compilerRef.current;
  };

  const onSketchFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy("sketch");
    setError(null);
    setSketchSnippet(null);
    try {
      const image = await fileToImageBytes(file);
      const compiler = await acquireCompiler();
      const { result, snippet } = await runSketchToFigure({
        image,
        model,
        compiler,
      });
      setSketchSnippet(snippet);
      setSketchOk(result.ok && result.typst.includes("cetz"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onSuggestAlt = async () => {
    if (busy) return;
    setBusy("alt");
    setError(null);
    setAltText(null);
    setCopied(false);
    try {
      // The current source IS the document context; alt-text uses it (no preview
      // bitmap is required for a source-grounded suggestion). When a preview is
      // present we capture it as the figure image; else we pass the source as
      // context only with a 1×1 placeholder so the core's image part is honest.
      const png = previewSvg ? await capture(previewSvg) : null;
      const image = png
        ? { data: png, mimeType: "image/png" }
        : { data: TRANSPARENT_PNG, mimeType: "image/png" };
      const text = await runSuggestAltText({
        image,
        context: currentSource,
        model,
      });
      setAltText(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onJudge = async () => {
    if (busy) return;
    setBusy("judge");
    setError(null);
    setFeedback(null);
    setCaptureFailed(false);
    try {
      if (!previewSvg) {
        setCaptureFailed(true);
        return;
      }
      const fb = await runJudgeLayout({
        source: currentSource,
        previewSvg,
        model,
        capture,
      });
      if (!fb) {
        setCaptureFailed(true);
        return;
      }
      setFeedback(fb);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const insertAlt = () => {
    if (!altText) return;
    if (onInsert(altText)) setAltText(null);
  };

  const copyAlt = () => {
    if (!altText) return;
    const clip = (navigator as { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
    if (clip?.writeText) void clip.writeText(altText);
    setCopied(true);
  };

  return (
    <div className="figure-vision" data-testid="figure-vision">
      <div className="figure-vision-title">Vision tools</div>

      {/* 1) From sketch (#8) — draft routed through onInsert (Accept-gated). */}
      <section className="figure-vision-tool" data-testid="figure-vision-sketch">
        <label className="figure-vision-label">
          From sketch
          <input
            type="file"
            accept="image/*"
            data-testid="figure-vision-sketch-input"
            disabled={busy !== null}
            onChange={(e) => void onSketchFile(e.target.files?.[0])}
          />
        </label>
        {sketchSnippet && (
          <div className="figure-vision-sketch-result">
            <div
              className="authoring-status"
              data-testid="figure-vision-sketch-status"
              data-ok={sketchOk ? "true" : "false"}
            >
              {sketchOk
                ? "Reproduced the sketch as a CeTZ draft (compiled clean)."
                : "Drafted a CeTZ figure from the sketch — review before inserting."}
            </div>
            <pre className="figure-vision-snippet" data-testid="figure-vision-sketch-snippet">
              {sketchSnippet}
            </pre>
            <button
              type="button"
              className="authoring-primary"
              data-testid="figure-vision-sketch-insert"
              onClick={() => {
                if (onInsert(sketchSnippet)) setSketchSnippet(null);
              }}
            >
              Insert figure
            </button>
          </div>
        )}
      </section>

      {/* 2) Suggest alt-text — copy or insert-via-onInsert. Never auto-written. */}
      <section className="figure-vision-tool" data-testid="figure-vision-alt">
        <button
          type="button"
          className="authoring-secondary"
          data-testid="figure-vision-alt-run"
          disabled={busy !== null}
          onClick={() => void onSuggestAlt()}
        >
          {busy === "alt" ? "Suggesting…" : "Suggest alt-text"}
        </button>
        {altText !== null && (
          <div className="figure-vision-alt-result">
            <output className="figure-vision-alt-text" data-testid="figure-vision-alt-text">
              {altText || "(no suggestion)"}
            </output>
            {altText && (
              <div className="figure-vision-alt-actions">
                <button
                  type="button"
                  className="authoring-secondary"
                  data-testid="figure-vision-alt-copy"
                  onClick={copyAlt}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="authoring-secondary"
                  data-testid="figure-vision-alt-insert"
                  onClick={insertAlt}
                >
                  Insert
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3) Judge layout (#10) — ADVISORY text only, never applied. */}
      <section className="figure-vision-tool" data-testid="figure-vision-judge">
        <button
          type="button"
          className="authoring-secondary"
          data-testid="figure-vision-judge-run"
          disabled={busy !== null}
          onClick={() => void onJudge()}
        >
          {busy === "judge" ? "Reviewing…" : "Review layout"}
        </button>
        {captureFailed && (
          <div className="authoring-status" data-testid="figure-vision-judge-no-capture">
            Couldn’t capture the preview to review (open the preview and try again).
          </div>
        )}
        {feedback && (
          <div className="figure-vision-feedback" data-testid="figure-vision-judge-feedback">
            <div className="figure-vision-feedback-note">
              Advisory only — these notes are not applied to your document.
            </div>
            <p className="figure-vision-feedback-summary" data-testid="figure-vision-judge-summary">
              {feedback.summary}
            </p>
            {feedback.observations.length > 0 && (
              <ul data-testid="figure-vision-judge-observations">
                {feedback.observations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            )}
            {feedback.suggestedEdits && (
              <p
                className="figure-vision-feedback-edits"
                data-testid="figure-vision-judge-edits"
              >
                {feedback.suggestedEdits}
              </p>
            )}
          </div>
        )}
      </section>

      {error && (
        <Notice severity="error" testId="figure-vision-error" message={`Error: ${error}`} />
      )}
    </div>
  );
}

/** A 1×1 transparent PNG data URL — an honest placeholder image part for the
 *  source-grounded alt-text path when no preview bitmap is available. */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
