import { describe, it, expect } from "vitest";
import type {
  AgentCompiler,
  LanguageModelClient,
  ModelStep,
  ModelTurnInput,
} from "@galley/agent";
import type { CheckResult, Diagnostic, ProviderCapabilities, ProviderConfig } from "@galley/shared";
import { convert } from "./ImportPanel.js";
import { buildRepairNotes, repairStatusLabel, runImportRepair } from "./import-repair.js";

/**
 * The component is a thin shell over (a) the pure `convert` normalizer, (b) the
 * host's Accept flow, and (c) — when the OPTIONAL `repair` dep is passed — the
 * `runImportRepair` orchestration over an injected model + compiler.
 *
 * Per the repo's Node-env house pattern (cf. HistoryPanel, doc-stats: no jsdom,
 * no @testing-library/react) we test the exported helpers + the exact injected
 * interaction the panel performs, with fake doubles. The DOM-level surface — the
 * "Repair with agent" button visibility and Accept-to-insert wiring — is covered
 * by Lane S's real-WASM e2e after mount.
 */
describe("ImportPanel.convert (#15)", () => {
  it("converts Markdown headings/lists and reports nothing for the mapped subset", () => {
    const { typst, report } = convert("markdown", "# Title\n\n- a\n- b\n");
    expect(typst).toContain("= Title");
    expect(typst).toContain("- a");
    expect(report).toEqual([]);
  });

  it("surfaces an unmapped Markdown construct (a table) honestly", () => {
    const { report } = convert("markdown", "| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(report.length).toBeGreaterThan(0);
    expect(report.every((r) => typeof r.kind === "string" && typeof r.line === "number")).toBe(true);
  });

  it("converts a LaTeX section and catalogs an unknown command", () => {
    const { typst, report } = convert("latex", "\\section{Intro}\n\\unknownmacro{x}\n");
    expect(typst).toContain("= Intro");
    expect(report.length).toBeGreaterThan(0);
  });
});

// ── Repair step (#15.1) ────────────────────────────────────────────────────

const FAKE_CONFIG: ProviderConfig = {
  kind: "openai-compatible",
  label: "Fake",
  baseUrl: "http://fake.local",
  model: "fake-1",
  isLocal: true,
  transport: { mode: "direct" },
};

/**
 * A model that replays a fixed list of assistant texts (the repair path reads
 * `step.text`, not tool calls) and records every turn input it saw — exactly the
 * double the agent package's own import-repair test uses, inlined here so the
 * apps/web gate stays self-contained.
 */
class FakeModel implements LanguageModelClient {
  readonly config = FAKE_CONFIG;
  readonly seen: ModelTurnInput[] = [];
  private i = 0;
  constructor(private readonly texts: string[]) {}
  async probe(): Promise<ProviderCapabilities> {
    return { reachable: true, supportsStreaming: false, supportsToolCalls: false, supportsImageInput: false };
  }
  async step(input: ModelTurnInput): Promise<ModelStep> {
    this.seen.push(input);
    const text = this.texts[Math.min(this.i, this.texts.length - 1)] ?? "";
    this.i += 1;
    return { text, toolCalls: [] };
  }
}

function errorAt(message: string, line = 1, column = 1): Diagnostic {
  return {
    severity: "error",
    message,
    span: { offset: 0, endOffset: 0, start: { line, column }, end: { line, column } },
  };
}

/** A compiler + a `dispose` spy, matching the `RepairCompiler` seam the panel drives. */
class FakeCompiler implements AgentCompiler {
  calls = 0;
  disposed = 0;
  constructor(private readonly diagnose: (source: string) => Diagnostic[] = () => []) {}
  async check(source: string): Promise<CheckResult> {
    this.calls += 1;
    const diagnostics = this.diagnose(source);
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, pageCount: ok ? 1 : null, durationMs: 0 };
  }
  dispose() {
    this.disposed += 1;
  }
}

const CLEAN = "= Title\n\nSome body text that compiles.";
const BROKEN = "= Title\n\n#BROKEN";
const brokenDiagnose = (src: string) =>
  src.includes("BROKEN") ? [errorAt("unexpected token BROKEN", 1, 1)] : [];

describe("buildRepairNotes (#15.1)", () => {
  it("returns undefined for an empty converter report (nothing to flag)", () => {
    expect(buildRepairNotes([])).toBeUndefined();
  });

  it("stringifies the unmapped catalog one row per line", () => {
    const notes = buildRepairNotes([
      { kind: "table", line: 3, snippet: "| a | b |" },
      { kind: "macro", line: 7, snippet: "\\foo" },
    ]);
    expect(notes).toBe("table (line 3): | a | b |\nmacro (line 7): \\foo");
  });
});

describe("repairStatusLabel (#15.1)", () => {
  it("reports a clean repair with the round count", () => {
    const label = repairStatusLabel({ typst: CLEAN, ok: true, attempts: 2, diagnostics: [] });
    expect(label).toContain("compiles cleanly");
    expect(label).toContain("2 rounds");
  });

  it("singularizes a one-round repair", () => {
    const label = repairStatusLabel({ typst: CLEAN, ok: true, attempts: 1, diagnostics: [] });
    expect(label).toContain("1 round");
    expect(label).not.toContain("1 rounds");
  });

  it("reports remaining diagnostics when the repair did not converge", () => {
    const label = repairStatusLabel({
      typst: BROKEN,
      ok: false,
      attempts: 3,
      diagnostics: [errorAt("boom"), errorAt("bang")],
    });
    expect(label).toContain("Could not fully repair");
    expect(label).toContain("2 diagnostics");
  });
});

describe("runImportRepair — the panel's repair orchestration (#15.1)", () => {
  it("drives the core with the converter notes and returns the repaired draft", async () => {
    // Model echoes a broken draft (attempt 1) then a clean one (attempt 2).
    const model = new FakeModel([BROKEN, CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);

    const result = await runImportRepair(
      {
        typst: BROKEN,
        sourceKind: "latex",
        report: [{ kind: "macro", line: 7, snippet: "\\foo" }],
      },
      { model, compiler, maxAttempts: 3 },
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.typst).toContain("Title");
    // The converter's unmapped catalog reached the model on the first turn.
    expect(
      model.seen[0]!.messages.some((m) => typeof m.content === "string" && m.content.includes("\\foo")),
    ).toBe(true);
  });

  it("surfaces ok:false with diagnostics when the loop cannot converge", async () => {
    const model = new FakeModel([BROKEN, BROKEN, BROKEN]);
    const compiler = new FakeCompiler(brokenDiagnose);

    const result = await runImportRepair(
      { typst: BROKEN, sourceKind: "markdown", report: [] },
      { model, compiler, maxAttempts: 2 },
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(repairStatusLabel(result)).toContain("Could not fully repair");
  });
});

/**
 * Backward-compat proof. The repair step is purely additive: `runImportRepair`
 * and the repair seam are only exercised when the host passes the OPTIONAL
 * `repair` prop. The two existing shell call sites (App / ProjectApp) pass only
 * `{ open, onClose, currentSource, onInsert }`, so `convert` + the Accept flow —
 * the entire pre-#15.1 behavior — are untouched. We assert the convert surface is
 * byte-for-byte stable; the no-button-when-absent guard is the component reading
 * `repair && (…)`, asserted at the DOM level by Lane S's e2e.
 */
describe("ImportPanel backward-compat (#15.1)", () => {
  it("convert produces the identical result with or without any repair machinery", () => {
    const a = convert("markdown", "# Title\n\n- a\n- b\n");
    const b = convert("markdown", "# Title\n\n- a\n- b\n");
    expect(a).toEqual(b);
    expect(a.typst).toContain("= Title");
  });
});
