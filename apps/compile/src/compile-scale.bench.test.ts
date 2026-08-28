/**
 * Compile-speed SCALE benchmark (operator-requested 2026-06-14) — a LOCAL
 * measurement tripwire, NOT a CI gate.
 *
 * The 2026-06-15 IA review asked: how long does a realistic LONG document
 * (~200 pp: thesis/book scale — many headings, paragraphs, lists, figures,
 * references) take to compile end-to-end, cold vs. warm, and how much memory
 * does it cost? The answer informs (a) the live-preview debounce for big docs,
 * (b) whether to surface a "compiling…" affordance with elapsed time, and (c)
 * the server-compile concurrency/timeout budget.
 *
 * WHY IT IS NOT IN THE GATE: compile latency is wall-clock, and CI machine speed
 * varies wildly, so a time assertion would FLAKE (the #23.2 doc-scale tripwire
 * sidesteps this by asserting only structural properties — it can't here). So
 * this whole suite is gated behind `BENCH=1` and `console.log`s a report rather
 * than asserting budgets. Run it on demand:
 *
 *   BENCH=1 pnpm --filter @galley/compile-service exec vitest run compile-scale
 *
 * It drives the SAME real Node `TypstEngine` (real WASM + bundled fonts, no
 * network) the production worker/service uses, so the numbers reflect the actual
 * in-browser/server compile path.
 */
import { describe, it, beforeAll, expect } from "vitest";
import type { ProjectInput, RenderResult } from "@galley/shared";
import { createNodeEngine } from "./engine.js";

const RUN = process.env.BENCH === "1";

/**
 * Wrap a source string as the single-file PROJECT the production preview compiles
 * (`kind:"project"`). The project path calls `resetShadow()` each compile, so a
 * reused engine stays stale-free across renders — unlike the bare-string path,
 * which accumulates sources on the same engine.
 */
function doc(text: string): ProjectInput {
  return { kind: "project", files: [{ path: "/main.typ", text }], main: "/main.typ" };
}

/**
 * Deterministically generate a long Typst document of `sections` sections. Each
 * section carries a heading, several prose paragraphs, a bullet list, a figure
 * (a CeTZ-free framed box so no package fetch is needed) — the structural mix of
 * a real thesis/book. Text-only (no `$…$`): the Node bench engine ships the
 * DejaVu text fonts but not a math font, and prose/headings/figures already
 * exercise the layout-at-scale path this benchmark measures. Fixed text every run
 * (no RNG, no timers) so the byte size and page count are reproducible.
 */
function longDoc(sections: number): string {
  const para =
    "The quick brown fox jumps over the lazy dog while the typesetting engine " +
    "lays out justified paragraphs across the page, breaking lines and balancing " +
    "the measure so that a realistic body of prose fills the column as it would " +
    "in an actual manuscript of substantial length and density. ";
  const out: string[] = [
    "#set page(numbering: \"1\")",
    "#set heading(numbering: \"1.1\")",
    "= A Long Document at Scale",
    "",
  ];
  for (let i = 1; i <= sections; i++) {
    out.push(`== Section ${i}: Layout, Prose, and Figures`);
    out.push("");
    for (let p = 0; p < 4; p++) out.push(para.repeat(3));
    out.push("");
    out.push("- First salient point in this section");
    out.push("- Second point, with a bit more detail to wrap");
    out.push("- Third point closing the list");
    out.push("");
    out.push("#figure(");
    out.push("  rect(width: 60%, height: 3cm, stroke: 0.5pt),");
    out.push(`  caption: [A framed figure for section ${i}.],`);
    out.push(")");
    out.push("");
  }
  return out.join("\n");
}

function summarize(label: string, bytes: number, r: RenderResult): string {
  const pages = r.pageCount ?? r.pages.length;
  return `${label.padEnd(22)} ${String(pages).padStart(4)} pp  ${(bytes / 1024)
    .toFixed(0)
    .padStart(5)} KB  ${r.durationMs.toFixed(0).padStart(6)} ms  ok=${r.ok}`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

describe.skipIf(!RUN)("compile-speed scale benchmark (BENCH=1)", () => {
  let engine: Awaited<ReturnType<typeof createNodeEngine>>;

  beforeAll(async () => {
    engine = await createNodeEngine();
    // Warm the WASM/JIT once so the first measured size isn't charged the
    // one-time engine init cost (we want per-document latency, not boot).
    await engine.render(doc("= Warmup\nHello."));
  }, 120_000);

  it("sweeps document sizes, reporting cold vs warm latency, page count, and memory", async () => {
    // ~50 / ~300 / ~800 sections → roughly 13 / 75 / ~200-page (thesis/book) scale.
    const sizes = [50, 300, 800];
    const rows: string[] = [
      "",
      "── compile-speed scale benchmark ───────────────────────────────────────",
      `${"size".padEnd(22)} ${"pages".padStart(4)}      ${"source".padStart(5)}     ${"compile".padStart(6)}`,
    ];
    for (const sections of sizes) {
      const src = longDoc(sections);
      const bytes = Buffer.byteLength(src, "utf-8");
      // COLD: first render of THIS document (size-dependent allocation paid here).
      const cold = await engine.render(doc(src));
      // WARM: render the same document again — the steady-state preview recompile.
      const warm = await engine.render(doc(src));
      // INCREMENTAL: one tiny appended line — the common live-preview keystroke
      // case. If this costs ~the same as a full warm render, a big doc has no
      // cheap-edit path and the live debounce should rise + a "compiling…" cue help.
      const edited = await engine.render(doc(src + "\n// one more line\n"));
      rows.push(summarize(`cold  ${sections} sections`, bytes, cold));
      rows.push(summarize(`warm  ${sections} sections`, bytes, warm));
      rows.push(summarize(`+1ln  ${sections} sections`, bytes, edited));
    }
    const mem = process.memoryUsage();
    rows.push("────────────────────────────────────────────────────────────────────────");
    rows.push(`peak memory: rss ${mb(mem.rss)}  heapUsed ${mb(mem.heapUsed)}`);
    rows.push("");
    // eslint-disable-next-line no-console
    console.log(rows.join("\n"));
  }, 300_000);
});

// A single ALWAYS-runnable smoke (cheap: ~12 sections) so the harness itself —
// the generator + the real-WASM render path — can't silently rot between BENCH
// runs. No wall-clock assertion; only that a multi-section doc renders cleanly.
describe("compile-scale harness smoke", () => {
  it("renders a small multi-section long-doc fixture cleanly (no errors)", async () => {
    const engine = await createNodeEngine();
    const r = await engine.render(doc(longDoc(12)));
    expect(r.ok).toBe(true);
    // No ERROR-severity diagnostics (layout warnings are fine for a perf fixture).
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect((r.pageCount ?? r.pages.length) > 1).toBe(true);
  }, 120_000);
});
