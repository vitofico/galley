/**
 * The main ⇄ worker message protocol (docs/compiler.md). Kept separate from the
 * browser Worker entry so the dispatcher is pure and node-testable against a
 * real `TypstEngine` — no `Worker`, no DOM.
 */

import type { CheckResult, CompileInput, ExportResult, RenderResult } from "@galley/shared";
import type { TypstEngine } from "./typst-engine.js";

/**
 * Init: load the compiler + renderer WASM and the text fonts behind a loading
 * state. typst.ts bundles no fonts, so `fontAssetPrefix` (where the app serves
 * the default font set) is required for text to render with real glyphs.
 */
export interface InitRequest {
  type: "init";
  wasmUrl: string;
  rendererUrl: string;
  fontAssetPrefix?: string;
}

// `input` is `string | ProjectInput` — single-file callers pass a string
// (unchanged); project callers pass a `ProjectInput`. Both are structured-clone
// safe (plain objects/strings/arrays), so they cross the worker boundary as-is.
//
// The render request carries an OPTIONAL `sourceMap` flag (#11.3): when true the
// engine ALSO builds the best-effort forward source→preview index and returns it
// on the result. It is OMITTED (never `undefined`) by callers that don't want it,
// so the historical `{ type:"render", jobId, input }` message shape is byte-for-
// byte unchanged and the engine's default (map-less) render path is preserved.
export type CompileRequest =
  | { type: "check"; jobId: number; input: CompileInput }
  | { type: "render"; jobId: number; input: CompileInput; sourceMap?: boolean }
  | { type: "export"; jobId: number; input: CompileInput };

export type CancelRequest = { type: "cancel"; jobId: number };

export type WorkerRequest = InitRequest | CompileRequest | CancelRequest;

export type WorkerResponse =
  | { type: "ready" }
  | { type: "init_error"; message: string }
  | { type: "check_result"; jobId: number; result: CheckResult }
  | { type: "render_result"; jobId: number; result: RenderResult }
  | { type: "export_result"; jobId: number; result: ExportResult }
  | { type: "error"; jobId: number; message: string };

/** Run one compile request against the engine and shape its response. */
export async function handleCompile(
  engine: TypstEngine,
  req: CompileRequest,
): Promise<WorkerResponse> {
  try {
    switch (req.type) {
      case "check":
        return { type: "check_result", jobId: req.jobId, result: await engine.check(req.input) };
      case "render":
        // Forward the optional #11.3 flag. `engine.render` already accepts
        // `{ sourceMap?: boolean }` (Lane D) and attaches `result.sourceMap` only
        // when asked + buildable; `render_result` carries it through automatically.
        // When the flag is absent this is `{ sourceMap: false }` → the engine's
        // default map-less path, byte-for-byte the historical render.
        return {
          type: "render_result",
          jobId: req.jobId,
          result: await engine.render(req.input, { sourceMap: req.sourceMap === true }),
        };
      case "export":
        return { type: "export_result", jobId: req.jobId, result: await engine.export(req.input) };
    }
  } catch (err) {
    return { type: "error", jobId: req.jobId, message: err instanceof Error ? err.message : String(err) };
  }
}
