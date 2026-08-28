import { describe, it, expect } from "vitest";
import type {
  LanguageModelClient,
  ModelStep,
  ModelTurnInput,
} from "@galley/agent";
import type {
  CheckResult,
  Diagnostic,
  ProviderCapabilities,
  ProviderConfig,
} from "@galley/shared";
import type { VerifyCompiler } from "./figure-verify.js";
import type { SvgToPngCapture } from "./preview-image-capture.js";
import {
  runSketchToFigure,
  runSuggestAltText,
  runJudgeLayout,
} from "./figure-vision-tools.js";

/**
 * `FigureVisionTools` activates the #8 sketch / #10 layout-judge / alt-text
 * multimodal cores. Per the repo's Node-env house pattern (cf. ImportPanel.test,
 * FigurePanel.test: no jsdom) we test the exact injected orchestrations the
 * component performs — sketch→figure, alt-text, judge-layout — with fake doubles
 * (model + compiler + a STUBBED capture, since Canvas is unavailable here). The
 * DOM-level surface (capability gating, the three buttons, the onInsert wiring)
 * is covered by the coordinator sweep's e2e once the shell passes the props.
 *
 * Accept-gate proof asserted here: sketch yields a CeTZ snippet for the caller's
 * onInsert; alt-text returns a STRING (never auto-written); judge returns
 * structured ADVISORY data (never applied) and is null on capture failure — the
 * model is NOT called when capture fails.
 */

const FAKE_CONFIG: ProviderConfig = {
  kind: "openai-compatible",
  label: "Fake",
  baseUrl: "http://fake.local",
  model: "fake-1",
  isLocal: true,
  transport: { mode: "direct" },
};

const CAPS_VISION: ProviderCapabilities = {
  reachable: true,
  supportsStreaming: false,
  supportsToolCalls: false,
  supportsImageInput: true,
};

/** A model that replays one scripted reply and records every turn it saw. */
class ScriptedModel implements LanguageModelClient {
  readonly config = FAKE_CONFIG;
  readonly seen: ModelTurnInput[] = [];
  calls = 0;
  constructor(private readonly reply: string) {}
  async probe(): Promise<ProviderCapabilities> {
    return CAPS_VISION;
  }
  async step(input: ModelTurnInput): Promise<ModelStep> {
    this.calls += 1;
    this.seen.push(input);
    return { text: this.reply, toolCalls: [] };
  }
}

/** A model that MUST NOT be called; any step() fails the test. */
class NeverCalledModel implements LanguageModelClient {
  readonly config = FAKE_CONFIG;
  async probe(): Promise<ProviderCapabilities> {
    return CAPS_VISION;
  }
  async step(): Promise<ModelStep> {
    throw new Error("model.step must not be called");
  }
}

function errorAt(message: string): Diagnostic {
  return {
    severity: "error",
    message,
    span: { offset: 0, endOffset: 0, start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  };
}

class FakeCompiler implements VerifyCompiler {
  calls = 0;
  constructor(private readonly diagnose: (s: string) => Diagnostic[] = () => []) {}
  async check(source: string): Promise<CheckResult> {
    this.calls += 1;
    const diagnostics = this.diagnose(source);
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, pageCount: ok ? 1 : null, durationMs: 0 };
  }
  dispose() {}
}

const CETZ_REPLY = `#import "@preview/cetz:0.2.2"\n#cetz.canvas({ circle((0, 0)) })`;

// ── 1) From sketch (#8) ─────────────────────────────────────────────────────

describe("runSketchToFigure (#8)", () => {
  it("turns a sketch into a CeTZ snippet the caller can route through onInsert", async () => {
    const model = new ScriptedModel(CETZ_REPLY);
    const compiler = new FakeCompiler();
    const { result, snippet } = await runSketchToFigure({
      image: { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      description: "two boxes joined by an arrow",
      model,
      compiler,
    });
    expect(snippet).toContain("cetz");
    expect(result.ok).toBe(true);
    // The model saw a MULTIMODAL first turn: a text part + an image part.
    const content = model.seen[0]!.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(true);
    expect(compiler.calls).toBe(1);
  });

  it("falls back to a scaffold when the model reply is not CeTZ (no junk inserted)", async () => {
    const model = new ScriptedModel("here is some unrelated chatter");
    const compiler = new FakeCompiler();
    const { snippet } = await runSketchToFigure({
      image: { data: new Uint8Array([9]) },
      description: "flow chart",
      model,
      compiler,
    });
    expect(snippet).toContain("cetz");
    expect(snippet).not.toContain("unrelated chatter");
  });
});

// ── 2) Suggest alt-text ─────────────────────────────────────────────────────

describe("runSuggestAltText (alt-text)", () => {
  it("returns a single suggestion string (never writes it anywhere)", async () => {
    const model = new ScriptedModel("Alt text: A bar chart of quarterly revenue.");
    const text = await runSuggestAltText({
      image: { data: "data:image/png;base64,AAAA", mimeType: "image/png" },
      context: "= Results\nRevenue grew each quarter.",
      model,
    });
    // The core strips the "Alt text:" label and returns the bare line.
    expect(text).toBe("A bar chart of quarterly revenue.");
    expect(model.calls).toBe(1);
  });
});

// ── 3) Judge layout (#10) ───────────────────────────────────────────────────

describe("runJudgeLayout (#10)", () => {
  const FEEDBACK_REPLY = [
    "SUMMARY: Tight margins, one overfull line.",
    "OBSERVATIONS:",
    "- Line 3 overflows the right margin.",
    "- The figure floats far from its reference.",
    "SUGGESTED EDITS: Rewrap line 3; move the figure nearer.",
  ].join("\n");

  it("captures the preview, judges it, and returns ADVISORY structured feedback", async () => {
    const model = new ScriptedModel(FEEDBACK_REPLY);
    let capturedSvg = "";
    const capture: SvgToPngCapture = async (svg) => {
      capturedSvg = svg;
      return "data:image/png;base64,STUBPNG";
    };
    const fb = await runJudgeLayout({
      source: "= Title\nbody",
      previewSvg: "<svg><rect/></svg>",
      model,
      capture,
    });
    expect(capturedSvg).toBe("<svg><rect/></svg>");
    expect(fb).not.toBeNull();
    expect(fb!.summary).toContain("overfull");
    expect(fb!.observations.length).toBe(2);
    expect(fb!.suggestedEdits).toContain("Rewrap");
    // The judged image was the STUBBED capture's PNG (a multimodal image part).
    const content = model.seen[0]!.messages[0]!.content as Array<{ type: string; image?: unknown }>;
    expect(content.some((p) => p.type === "image" && p.image === "data:image/png;base64,STUBPNG")).toBe(true);
  });

  it("FAIL-CLOSED: returns null and NEVER calls the model when capture fails", async () => {
    const model = new NeverCalledModel();
    const capture: SvgToPngCapture = async () => null; // canvas tainted / unsupported
    const fb = await runJudgeLayout({
      source: "= Title",
      previewSvg: "<svg/>",
      model,
      capture,
    });
    expect(fb).toBeNull();
    // NeverCalledModel.step would have thrown — reaching here proves no call.
  });
});
