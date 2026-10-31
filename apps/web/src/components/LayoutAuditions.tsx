import { useEffect, useRef, useState } from "react";
import type { Compiler } from "@galley/compiler";
import type { CompileInput, RenderResult } from "@galley/shared";
import { initCompiler } from "../compiler-assets.js";
import { compileInputKey } from "../useCompiler.js";
import { layoutCandidates, replaceScratchMain } from "../layout-auditions.js";
import { Preview } from "./Preview.js";
import { DiffReview } from "./DiffReview.js";
interface Candidate {
  label: string;
  source: string;
  result?: RenderResult;
  error?: string;
}
interface Run {
  key: string;
  base: string;
  candidates: Candidate[];
}
export function LayoutAuditions({
  input,
  path,
  fileId,
  source,
  canMutate,
  onAccept,
}: {
  input: CompileInput;
  path: string;
  fileId: string;
  source: string;
  canMutate: boolean;
  onAccept: (run: {
    targetFileId: string;
    targetPath: string;
    expectedInputKey: string;
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  }) => boolean;
}) {
  const [margin, setMargin] = useState(20),
    [spread, setSpread] = useState(5),
    [cap, setCap] = useState(10);
  const [run, setRun] = useState<Run | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const generation = useRef(0),
    compiler = useRef<Compiler>();
  const key = compileInputKey(input);
  const stale = run !== null && run.key !== key;
  useEffect(
    () => () => {
      generation.current++;
      compiler.current?.dispose();
    },
    [],
  );
  const generate = async () => {
    const id = ++generation.current;
    compiler.current?.dispose();
    setSelected(null);
    setMessage("");
    setBusy(true);
    try {
      const candidates: Candidate[] = layoutCandidates(source, margin, spread);
      const frozen: Run = { key, base: source, candidates };
      setRun({ ...frozen });
      const worker = await initCompiler("local");
      if (id !== generation.current) {
        worker.dispose();
        return;
      }
      compiler.current = worker;
      for (const candidate of candidates) {
        try {
          candidate.result = await worker.render(
            replaceScratchMain(input, path, candidate.source),
          );
        } catch (error) {
          candidate.error =
            error instanceof Error ? error.message : String(error);
        }
        if (id !== generation.current) return;
        setRun({ ...frozen, candidates: [...candidates] });
      }
    } catch (error) {
      if (id === generation.current)
        setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (id === generation.current) setBusy(false);
    }
  };
  const chosen = selected === null ? undefined : run?.candidates[selected];
  return (
    <details data-testid="layout-auditions">
      <summary>Layout auditions</summary>
      <p>
        Compile three local scratch copies of the main document. Wording, assets
        and text-size rules stay unchanged. Existing page rules can override
        these margins; compare actual previews. Minimum rendered text size is
        not verified.
      </p>
      <label>
        Center margin (mm)
        <input
          aria-label="Center margin (mm)"
          type="number"
          min="10"
          max="50"
          value={margin}
          onChange={(e) => setMargin(Number(e.target.value))}
        />
      </label>
      <label>
        Margin spread (mm)
        <input
          aria-label="Margin spread (mm)"
          type="number"
          min="1"
          max="10"
          value={spread}
          onChange={(e) => setSpread(Number(e.target.value))}
        />
      </label>
      <label>
        Candidate page cap
        <input
          aria-label="Candidate page cap"
          type="number"
          min="1"
          value={cap}
          onChange={(e) => setCap(Math.max(1, Number(e.target.value) || 1))}
        />
      </label>
      <button disabled={busy || !canMutate} onClick={() => void generate()}>
        {busy ? "Compiling auditions…" : "Compile layout auditions"}
      </button>
      {message && <p role="status">{message}</p>}
      {stale && (
        <p role="status">
          Project input changed. Compile new auditions before accepting.
        </p>
      )}
      {run?.candidates.map((candidate, index) => {
        const good =
          candidate.result?.ok &&
          !!candidate.result.pages[0] &&
          !candidate.result.diagnostics.some((d) => d.severity === "error");
        const withinCap =
          candidate.result !== undefined &&
          (candidate.result.pageCount ?? candidate.result.pages.length) <= cap;
        return (
          <section key={index} aria-label={candidate.label}>
            <h4>{candidate.label}</h4>
            <p>
              {candidate.error ??
                (candidate.result
                  ? good
                    ? `${candidate.result.pageCount ?? candidate.result.pages.length} pages; ${withinCap ? "within" : "outside or unknown"} page cap`
                    : "Compile failed"
                  : "Waiting for local compile…")}
            </p>
            {candidate.result?.diagnostics.map((d, i) => (
              <p key={i}>{d.message}</p>
            ))}
            {good && (
              <div style={{ height: 300, overflow: "auto" }}>
                {candidate.result!.pages.map((page, pageIndex) => (
                  <Preview
                    key={pageIndex}
                    svg={page.svg}
                    placeholder="Compiling candidate"
                  />
                ))}
              </div>
            )}
            <button
              disabled={!good || !withinCap || stale || busy || !canMutate}
              onClick={() => setSelected(index)}
            >
              Review {candidate.label}
            </button>
          </section>
        );
      })}
      {chosen && run && (
        <fieldset disabled={stale || busy || !canMutate}>
          <DiffReview
            base={run.base}
            next={chosen.source}
            outcome="layout audition"
            onReject={() => setSelected(null)}
            onAccept={() => {
              if (
                stale ||
                !chosen.result?.ok ||
                chosen.result.diagnostics.some((d) => d.severity === "error") ||
                (chosen.result.pageCount ?? chosen.result.pages.length) > cap
              ) {
                setMessage(
                  "Candidate no longer satisfies the current page cap. Compile or select again.",
                );
                return;
              }
              if (
                onAccept({
                  targetFileId: fileId,
                  targetPath: path,
                  expectedInputKey: run.key,
                  baseSource: run.base,
                  finalSource: chosen.source,
                  blocks: [{ search: run.base, replace: chosen.source }],
                })
              ) {
                setRun(null);
                setSelected(null);
                setMessage("Layout accepted.");
              } else setMessage("Document changed. Compile new auditions.");
            }}
          />
        </fieldset>
      )}
    </details>
  );
}
