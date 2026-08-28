import { describe, it, expect } from "vitest";
import type { ModelStep } from "./model.js";
import { messageText } from "./model.js";
import { FAKE_CONFIG, FakeCompiler, FakeModel, errorAt } from "./testing/fakes.js";
import { repairImportedTypst } from "./import-repair.js";

/**
 * A model that replays a fixed list of assistant texts (the repair path reads
 * `step.text`, not tool calls). Reuses the shared FakeModel via the text-only
 * step shape, and records every turn input it saw (`seen`).
 */
function textModel(texts: string[]): FakeModel {
  const steps: ModelStep[] = texts.map((text) => ({ text, toolCalls: [] }));
  return new FakeModel(steps, FAKE_CONFIG);
}

/** A draft the FakeCompiler treats as clean. */
const CLEAN = `= Title\n\nSome body text that compiles.`;
/** A draft the FakeCompiler will mark broken (contains BROKEN). */
const BROKEN = `= Title\n\n#BROKEN`;

/** Marks any source containing "BROKEN" as a single error. */
const brokenDiagnose = (src: string) =>
  src.includes("BROKEN") ? [errorAt("unexpected token BROKEN", 1, 1)] : [];

describe("repairImportedTypst — already-clean draft", () => {
  it("returns immediately with ok:true, attempts:1 when the model echoes a clean draft", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: CLEAN, sourceKind: "markdown" },
      { model, compiler },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.typst).toContain("Title");
    expect(compiler.callCount).toBe(1);
  });
});

describe("repairImportedTypst — self-correcting retry", () => {
  it("converges on attempt 2 and feeds the diagnostic + offending source back", async () => {
    const model = textModel([BROKEN, CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: BROKEN, sourceKind: "latex", notes: "\\foo was not converted" },
      { model, compiler, maxAttempts: 3 },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(result.typst).toContain("Title");

    // The retry (2nd turn) must include the diagnostic feedback from attempt 1.
    expect(model.seen).toHaveLength(2);
    const retryMessages = model.seen[1]!.messages;
    const fedBack = retryMessages.some((m) => messageText(m.content).includes("unexpected token BROKEN"));
    expect(fedBack).toBe(true);
    // The retry also carries the previous (broken) source for context.
    const carriedSnippet = retryMessages.some((m) => messageText(m.content).includes("BROKEN"));
    expect(carriedSnippet).toBe(true);
  });
});

describe("repairImportedTypst — exhausts attempts without converging", () => {
  it("returns ok:false after maxAttempts with the final diagnostics surfaced", async () => {
    const model = textModel([BROKEN, BROKEN, BROKEN, BROKEN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: BROKEN },
      { model, compiler, maxAttempts: 3 },
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(compiler.callCount).toBe(3);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.message).toContain("BROKEN");
    // The last attempt is returned for inspection.
    expect(result.typst).toContain("BROKEN");
  });
});

describe("repairImportedTypst — garbage/empty model output falls back to the input draft", () => {
  it("uses the input draft unchanged when the model returns nothing usable", async () => {
    const model = textModel(["", "   "]);
    const compiler = new FakeCompiler(); // everything clean
    const result = await repairImportedTypst(
      { typst: CLEAN, sourceKind: "markdown" },
      { model, compiler },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    // Deterministic fallback: the exact input draft is returned.
    expect(result.typst).toBe(CLEAN);
  });

  it("reflects ok based on whether the input draft itself compiles", async () => {
    const model = textModel(["", "", ""]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: BROKEN },
      { model, compiler, maxAttempts: 2 },
    );
    // Model never produces anything → loop keeps falling back to the (broken) input.
    expect(result.typst).toBe(BROKEN);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("repairImportedTypst — strips a markdown fence from model output", () => {
  it("unwraps a ```typst fenced block before compiling", async () => {
    const fenced = "Here you go:\n\n```typst\n" + CLEAN + "\n```\n";
    const model = textModel([fenced]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: BROKEN },
      { model, compiler },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    // No fence markers leak into the produced source.
    expect(result.typst).not.toContain("```");
    expect(result.typst).toBe(CLEAN);
  });
});

describe("repairImportedTypst — maxAttempts clamping", () => {
  it("clamps maxAttempts to at least 1 even when 0 or negative is passed", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler(brokenDiagnose);
    const result = await repairImportedTypst(
      { typst: CLEAN },
      { model, compiler, maxAttempts: 0 },
    );
    expect(result.attempts).toBe(1);
    expect(compiler.callCount).toBe(1);
    expect(result.ok).toBe(true);
  });
});

describe("repairImportedTypst — seeds the conversation as a lossy-import repair", () => {
  it("sends a repair-focused system prompt and the draft + notes on the first turn", async () => {
    const model = textModel([CLEAN]);
    const compiler = new FakeCompiler();
    await repairImportedTypst(
      { typst: BROKEN, sourceKind: "latex", notes: "\\foo was not converted" },
      { model, compiler },
    );
    const first = model.seen[0]!;
    const sys = first.system.toLowerCase();
    expect(sys).toContain("repair");
    expect(sys).toContain("typst");
    const userMsg = first.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("BROKEN");
    // The unconverted catalog is surfaced as context for the model.
    expect(userMsg?.content).toContain("\\foo was not converted");
  });
});
