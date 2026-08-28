import { repairImportedTypst } from "@galley/agent";
import type {
  AgentCompiler,
  ImportRepairResult,
  LanguageModelClient,
} from "@galley/agent";

/**
 * The injected-seam types + pure helpers for ImportPanel's optional "Repair with
 * agent" step (roadmap #15.1). Kept OUT of the component module so they unit-test
 * in the Node gate without dragging in React or WASM.
 *
 * The repair step wraps the already-tested `repairImportedTypst` core (a
 * convert→compile→self-correct loop). The component never imports a concrete
 * compiler: the host injects a `compilerFactory` that builds — and the component
 * disposes — a real compiler, so the panel stays testable with fakes and the Node
 * gate never pulls in the typst.ts worker.
 */

/**
 * A compiler instance the repair loop can drive, plus an optional `dispose` the
 * panel calls when it is finished (or unmounts). Structurally a superset of the
 * agent core's `AgentCompiler`, so the same `@galley/compiler` `Compiler` the
 * Figure flow uses satisfies it directly.
 */
export interface RepairCompiler extends AgentCompiler {
  dispose?: () => void;
}

/**
 * The optional repair dependencies. When the host passes this prop, ImportPanel
 * renders the "Repair with agent" affordance on a converted result; when it is
 * omitted (today's shell call sites), the panel behaves byte-for-byte as before.
 */
export interface ImportRepairDepsProp {
  /** The injected model client (same one the agent / figure flows use). */
  model: LanguageModelClient;
  /**
   * Builds a fresh compiler for the repair loop. Created lazily on first repair
   * and disposed by the panel — the host never owns its lifecycle. Mirrors the
   * Figure flow's `initCompiler()` injection, but as a prop so the Node gate and
   * unit tests can pass a fake.
   */
  compilerFactory: () => Promise<RepairCompiler>;
  /** Cap on self-correction rounds, forwarded to the core. Defaults to its 3. */
  maxAttempts?: number;
}

/** A converter report item — the `{ kind, line, snippet }` rows ImportPanel holds. */
export interface RepairNoteItem {
  kind: string;
  line: number;
  snippet: string;
}

/**
 * Stringify the converter's unmapped/unconverted catalog into the free-form
 * `notes` the repair core threads into its prompt. Pure + exported so the exact
 * wording the panel sends is asserted in the Node gate. Returns `undefined` for
 * an empty report (the core treats absent notes as "nothing to flag").
 */
export function buildRepairNotes(report: readonly RepairNoteItem[]): string | undefined {
  if (report.length === 0) return undefined;
  return report.map((item) => `${item.kind} (line ${item.line}): ${item.snippet}`).join("\n");
}

/**
 * The exact repair orchestration ImportPanel performs: build the notes from the
 * converter report, then drive the `repairImportedTypst` core with the injected
 * model + compiler. Extracted as a pure async helper (no React) so the Node gate
 * exercises the real interaction with fake doubles — the repo's house pattern.
 */
export function runImportRepair(
  args: { typst: string; sourceKind: "markdown" | "latex"; report: readonly RepairNoteItem[] },
  deps: { model: LanguageModelClient; compiler: AgentCompiler; maxAttempts?: number },
): Promise<ImportRepairResult> {
  // Omit optionals when absent (exactOptionalPropertyTypes: targets are `?`, not `| undefined`).
  const notes = buildRepairNotes(args.report);
  return repairImportedTypst(
    { typst: args.typst, sourceKind: args.sourceKind, ...(notes !== undefined ? { notes } : {}) },
    {
      model: deps.model,
      compiler: deps.compiler,
      ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
    },
  );
}

/**
 * Human-readable status for a finished repair, mirroring FigurePanel's status
 * line. Pure + exported so the Node gate asserts the wording without a DOM.
 */
export function repairStatusLabel(result: ImportRepairResult): string {
  if (result.ok) {
    const rounds = `${result.attempts} round${result.attempts === 1 ? "" : "s"}`;
    return `Repaired — compiles cleanly (in ${rounds}).`;
  }
  const n = result.diagnostics.length;
  return `Could not fully repair — ${n} diagnostic${n === 1 ? "" : "s"} remain; review before inserting.`;
}
