import { useEffect, useRef, useState } from "react";
import { figureToTypst, cetzScaffold } from "@galley/agent";
import type { FigureRequest, FigureResult, LanguageModelClient } from "@galley/agent";
import type { Compiler } from "@galley/compiler";
import { initCompiler } from "../compiler-assets.js";
import { DiffReview } from "./DiffReview.js";
import { appendSnippet } from "./authoring-insert.js";
import type { FigureVerifyState, VerifyCompiler, VerifyCompilerFactory } from "./figure-verify.js";
import { runFigureVerify, verifyStatusLabel } from "./figure-verify.js";
import { FigureVisionTools } from "./figure-vision-tools.js";
import type { ProviderCapabilities } from "@galley/shared";
import { Notice } from "./Notice.js";
import "./authoring-panels.css";

/**
 * Figure → Typst UI (roadmap #8) — describe a figure in words and let the offline
 * `figureToTypst` core generate a CeTZ snippet via the iterate-until-clean loop
 * (the injected model + a dedicated compiler), then review it as a normal diff.
 *
 * PRESENTATIONAL + CONTROLLED: insertion goes through the host's conflict-aware
 * `onInsert` (Accept stays mandatory). The compiler is created lazily on first
 * generate (its own worker, like the agent's) and disposed on unmount.
 *
 * Honest offline scope: CeTZ is a `@preview` package, which does NOT resolve in
 * the browser's fail-closed compiler — so an offline generate surfaces a "could
 * not verify" status with the package diagnostic rather than a clean compile. The
 * snippet is still a faithful, reviewable draft; verification arrives with
 * server-side compile / package resolution.
 *
 * Verify seam (roadmap #8): the OPTIONAL `verifyCompilerFactory` prop injects a
 * SERVER-CAPABLE compiler (one that CAN resolve `@preview` packages). When the
 * host provides it, a "Verify compile" affordance appears on a generated draft;
 * running it re-compiles the CeTZ snippet for a real clean-or-diagnostics verdict
 * — turning "could not verify offline" into an actual result. When the prop is
 * OMITTED — today's shell call sites — the panel behaves byte-for-byte as before.
 */
export interface FigurePanelProps {
  open: boolean;
  onClose: () => void;
  model: LanguageModelClient;
  currentSource: string;
  onInsert: (snippet: string) => boolean;
  /**
   * OPTIONAL server-side verify step (roadmap #8). When provided, the panel
   * renders a "Verify compile" affordance on a generated draft and uses this
   * factory to build — and dispose — a package-resolving compiler that actually
   * compiles the snippet. Created lazily on first verify; the host never owns its
   * lifecycle. When OMITTED, the offline "could not verify" status is shown as
   * today (the factory is the only thing that unlocks verification).
   */
  verifyCompilerFactory?: VerifyCompilerFactory;
  /**
   * OPTIONAL multimodal activation (roadmap #8 sketch / #10 layout judge /
   * alt-text). When BOTH this and a vision-capable transport are present, an
   * extra "Vision tools" section mounts (sketch→figure via the same Accept-gated
   * `onInsert`, an alt-text suggestion, and an ADVISORY layout critique). When
   * absent — every shell call site until the coordinator sweep — the panel
   * renders byte-for-byte as before. The tools self-gate on
   * `capabilities.supportsImageInput`; a missing/false capability shows a calm
   * hint and never calls the model.
   */
  capabilities?: ProviderCapabilities;
  /**
   * OPTIONAL live-preview markup (inline `<svg>`) the layout judge rasterizes to
   * a PNG (#10). Passed by the shell from the running preview; absent today.
   */
  previewSvg?: string;
  /**
   * Rail & Islands (#19.2): when true the panel renders as a DOCKED card (no
   * fixed backdrop, no modal dialog semantics) inside the shell's dock host.
   * Default false — the modal presentation is byte-for-byte unchanged.
   */
  docked?: boolean;
}

export function FigurePanel({
  open,
  onClose,
  model,
  currentSource,
  onInsert,
  verifyCompilerFactory,
  capabilities,
  previewSvg,
  docked,
}: FigurePanelProps) {
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<NonNullable<FigureRequest["kind"]>>("diagram");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<FigureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compilerRef = useRef<Compiler | null>(null);
  // The server-capable verify compiler (separate from the browser generate-loop
  // compiler above), created lazily on first verify and disposed on close /
  // unmount. Null whenever no verify has run.
  const verifyCompilerRef = useRef<VerifyCompiler | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyState, setVerifyState] = useState<FigureVerifyState | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const disposeCompilers = () => {
    compilerRef.current?.dispose();
    compilerRef.current = null;
    verifyCompilerRef.current?.dispose?.();
    verifyCompilerRef.current = null;
  };

  useEffect(() => {
    return () => disposeCompilers();
  }, []);

  // Dispose both compilers whenever the panel closes — a closed panel holds no
  // worker (mirrors ImportPanel's lazy-create-on-open / dispose-on-close).
  useEffect(() => {
    if (!open) disposeCompilers();
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

  const clearVerify = () => {
    setVerifyState(null);
    setVerifyError(null);
  };

  const generate = async () => {
    if (description.trim().length === 0 || generating) return;
    setGenerating(true);
    setError(null);
    // A fresh generate invalidates any prior verify verdict.
    clearVerify();
    try {
      if (!compilerRef.current) compilerRef.current = await initCompiler();
      const compiler = compilerRef.current;
      const res = await figureToTypst(
        { description, kind },
        // One round offline: CeTZ can't resolve in the fail-closed browser
        // compiler, so extra self-correction rounds wouldn't converge.
        { model, compiler: { check: (s: string) => compiler.check(s) }, maxAttempts: 1 },
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError(null);
    clearVerify();
  };
  // Display the model's snippet only when it actually looks like CeTZ; otherwise
  // fall back to the deterministic scaffold. This keeps the OFFLINE Demo model
  // (which isn't a figure generator) from inserting unrelated chat text — the
  // real value arrives with a configured model. The core's own empty-output
  // fallback is also cetzScaffold, so this is consistent.
  const snippet = result
    ? result.typst.includes("cetz")
      ? result.typst
      : cetzScaffold(description)
    : "";
  const next = result ? appendSnippet(currentSource, snippet) : currentSource;

  // Verify the DISPLAYED snippet (what Accept would insert) on the injected
  // server-capable compiler. No-op when the factory is absent — the affordance
  // is only rendered then anyway.
  const runVerify = async () => {
    if (!verifyCompilerFactory || !result || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      if (!verifyCompilerRef.current) {
        verifyCompilerRef.current = await verifyCompilerFactory();
      }
      const state = await runFigureVerify(snippet, verifyCompilerRef.current);
      setVerifyState(state);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };

  const panel = (
      <div
        className={`authoring-panel${docked ? " authoring-panel--docked" : ""}`}
        data-testid="figure-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="authoring-header">
          <h2 className="authoring-title">Figure → Typst</h2>
          <button type="button" className="authoring-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="authoring-body">
          <div className="authoring-format" role="radiogroup" aria-label="Figure kind">
            {(["diagram", "plot", "generic"] as const).map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="figure-kind"
                  data-testid={`figure-kind-${k}`}
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {k}
              </label>
            ))}
          </div>

          <textarea
            className="authoring-input"
            data-testid="figure-description"
            value={description}
            placeholder="Describe the figure, e.g. “a labelled box-and-arrow flow: Input → Model → Output”"
            aria-label="Figure description"
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="authoring-actions">
            <button
              type="button"
              className="authoring-primary"
              data-testid="figure-generate"
              disabled={description.trim().length === 0 || generating}
              onClick={() => void generate()}
            >
              {generating ? "Generating…" : "Generate"}
            </button>
            {result && (
              <button type="button" className="authoring-secondary" data-testid="figure-reset" onClick={reset}>
                Clear
              </button>
            )}
          </div>

          {error && <Notice severity="error" testId="figure-error" message={`Error: ${error}`} />}

          {result && (
            <>
              {(() => {
                const verified = result.ok && result.typst.includes("cetz");
                return (
                  <div
                    className="authoring-status"
                    data-testid="figure-status"
                    data-ok={verified ? "true" : "false"}
                  >
                    {verified
                      ? `Compiles cleanly (in ${result.attempts} round${result.attempts === 1 ? "" : "s"}).`
                      : "Generated a CeTZ draft — review before inserting (CeTZ requires package resolution to compile; available with server-side compile)."}
                  </div>
                );
              })()}

              {verifyCompilerFactory && (
                <div className="authoring-actions" data-testid="figure-verify-actions">
                  <button
                    type="button"
                    className="authoring-secondary"
                    data-testid="figure-verify-run"
                    disabled={verifying}
                    onClick={() => void runVerify()}
                  >
                    {verifying ? "Verifying…" : verifyState ? "Verify again" : "Verify compile"}
                  </button>
                </div>
              )}

              {verifyError && (
                <Notice
                  severity="error"
                  testId="figure-verify-error"
                  message={`Error: ${verifyError}`}
                />
              )}

              {verifyState && (
                <div
                  className="authoring-status"
                  data-testid="figure-verify-result"
                  data-ok={verifyState.ok ? "true" : "false"}
                >
                  {verifyStatusLabel(verifyState)}
                </div>
              )}

              <DiffReview
                base={currentSource}
                next={next}
                outcome="figure"
                onAccept={() => {
                  if (onInsert(snippet)) onClose();
                }}
                onReject={reset}
              />
            </>
          )}

          {capabilities !== undefined && (
            <FigureVisionTools
              model={model}
              currentSource={currentSource}
              onInsert={onInsert}
              capabilities={capabilities}
              {...(previewSvg !== undefined ? { previewSvg } : {})}
              {...(verifyCompilerFactory ? { verifyCompilerFactory } : {})}
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
      aria-label="Generate a figure"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}
