/**
 * Deterministic fakes for the agent loop (manifest "Determinism" layer; the
 * core-loop acceptance test). These let `runAgent` be driven entirely offline —
 * no provider, no network, no WASM.
 *
 * Under src/ (not src/index.ts) so they are tree-shaken from the package's
 * public surface but available to tests and, later, the web app's stories/e2e.
 */

import type {
  CheckResult,
  Diagnostic,
  ProviderCapabilities,
  ProviderConfig,
} from "@galley/shared";
import type {
  LanguageModelClient,
  ModelStep,
  ModelTextDelta,
  ModelTurnInput,
} from "../model.js";
import type { AgentCompiler } from "../run-agent.js";

export const FAKE_CONFIG: ProviderConfig = {
  kind: "openai-compatible",
  label: "Fake",
  baseUrl: "http://fake.local",
  model: "fake-1",
  isLocal: true,
  transport: { mode: "direct" },
};

/**
 * A model that replays a fixed script of steps. Records every turn input it saw
 * (`seen`) so tests can assert what the loop sent (e.g. that tool results were
 * fed back).
 */
export class FakeModel implements LanguageModelClient {
  readonly config: ProviderConfig;
  private readonly steps: ModelStep[];
  private index = 0;
  readonly seen: ModelTurnInput[] = [];

  constructor(steps: ModelStep[], config: ProviderConfig = FAKE_CONFIG) {
    this.steps = steps;
    this.config = config;
  }

  async probe(): Promise<ProviderCapabilities> {
    return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
  }

  async step(input: ModelTurnInput): Promise<ModelStep> {
    this.seen.push(input);
    return this.steps[this.index++] ?? { text: "(no more scripted steps)", toolCalls: [] };
  }
}

/**
 * A streaming fake: replays the same fixed script as `FakeModel`, but exposes
 * `stepStream`, splitting each step's assistant text into per-word deltas before
 * returning the whole `ModelStep` (text + tool calls). Lets `runAgent`'s
 * streaming path be exercised offline; `chunksFor` is overridable for custom
 * splits. It also keeps `step` working, so it satisfies the same interface and
 * can stand in anywhere `FakeModel` does.
 */
export class StreamingFakeModel implements LanguageModelClient {
  readonly config: ProviderConfig;
  private readonly steps: ModelStep[];
  private index = 0;
  readonly seen: ModelTurnInput[] = [];

  constructor(
    steps: ModelStep[],
    config: ProviderConfig = FAKE_CONFIG,
    /** How to split a turn's text into streamed chunks (default: keep spaces, per word). */
    private readonly chunksFor: (text: string) => string[] = (text) =>
      text ? text.match(/\S+\s*/g) ?? [text] : [],
  ) {
    this.steps = steps;
    this.config = config;
  }

  async probe(): Promise<ProviderCapabilities> {
    return { reachable: true, supportsStreaming: true, supportsToolCalls: true, supportsImageInput: true };
  }

  private nextStep(input: ModelTurnInput): ModelStep {
    this.seen.push(input);
    return this.steps[this.index++] ?? { text: "(no more scripted steps)", toolCalls: [] };
  }

  async step(input: ModelTurnInput): Promise<ModelStep> {
    return this.nextStep(input);
  }

  async *stepStream(input: ModelTurnInput): AsyncGenerator<ModelTextDelta, ModelStep, void> {
    const step = this.nextStep(input);
    for (const chunk of this.chunksFor(step.text)) {
      yield { type: "text-delta", text: chunk };
    }
    return step;
  }
}

/** A model whose `step` rejects — exercises the loop's error path. */
export class ThrowingModel implements LanguageModelClient {
  readonly config = FAKE_CONFIG;
  constructor(private readonly message = "model transport failed") {}
  async probe(): Promise<ProviderCapabilities> {
    return { reachable: false, supportsStreaming: false, supportsToolCalls: false, supportsImageInput: false };
  }
  async step(): Promise<ModelStep> {
    throw new Error(this.message);
  }
}

let toolCallSeq = 0;

/** Build a `propose_edit` step from edit blocks (with optional assistant text). */
export function proposeEdit(
  edits: { search: string; replace: string }[],
  text = "",
): ModelStep {
  return {
    text,
    toolCalls: [{ id: `tc-${++toolCallSeq}`, name: "propose_edit", args: { edits } }],
  };
}

/** Build a `read_document` step. */
export function readDocument(text = ""): ModelStep {
  return { text, toolCalls: [{ id: `tc-${++toolCallSeq}`, name: "read_document", args: {} }] };
}

/** Build a `compile` step. */
export function compile(text = ""): ModelStep {
  return { text, toolCalls: [{ id: `tc-${++toolCallSeq}`, name: "compile", args: {} }] };
}

/** Build a final (no-tool-call) step. */
export function finalAnswer(text: string): ModelStep {
  return { text, toolCalls: [] };
}

/** A diagnostic at a 1-based line/col, with a trivial span. */
export function errorAt(message: string, line = 1, column = 1): Diagnostic {
  return {
    severity: "error",
    message,
    span: { offset: 0, endOffset: 0, start: { line, column }, end: { line, column } },
  };
}

/**
 * A compiler whose verdict is a pure function of the source. By default every
 * document compiles cleanly; pass `diagnose` to mark some sources as broken.
 */
export class FakeCompiler implements AgentCompiler {
  private calls = 0;
  constructor(private readonly diagnose: (source: string) => Diagnostic[] = () => []) {}

  get callCount(): number {
    return this.calls;
  }

  async check(source: string): Promise<CheckResult> {
    this.calls += 1;
    const diagnostics = this.diagnose(source);
    const ok = !diagnostics.some((d) => d.severity === "error");
    return { ok, diagnostics, pageCount: ok ? 1 : null, durationMs: 0 };
  }
}
