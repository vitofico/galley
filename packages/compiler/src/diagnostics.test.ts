import { describe, it, expect } from "vitest";
import { enrichImageHint, normalizeDiagnostics, normalizeProjectDiagnostics } from "./diagnostics.js";

/**
 * `normalizeProjectDiagnostics` is the multi-file sibling of
 * `normalizeDiagnostics`: typst.ts reports each diagnostic with the `path` of
 * the file it occurred in, so we must map each `range` against THAT file's
 * source (offsets differ per file), and tag the resulting `Diagnostic` with its
 * `path` so the UI can route it to the right editor.
 *
 * These are pure unit tests over synthetic raw typst.ts diagnostics (shape:
 * `{ package, path, severity, range, message }`); the real cross-file compile is
 * exercised against typst.ts in `typst-engine.test.ts`.
 */
describe("normalizeProjectDiagnostics", () => {
  it("returns [] for non-array / empty input", () => {
    expect(normalizeProjectDiagnostics(undefined, new Map())).toEqual([]);
    expect(normalizeProjectDiagnostics([], new Map())).toEqual([]);
  });

  it("maps each diagnostic's range against its own file's source", () => {
    const main = "#import \"/lib.typ\": foo\n#foo()\n";
    const lib = "#let foo = (\n"; // broken on line 1
    const files = new Map([
      ["/main.typ", main],
      ["/lib.typ", lib],
    ]);
    const raw = [
      { package: "", path: "/lib.typ", severity: "error", message: "unclosed", range: "0:9-0:10" },
      { package: "", path: "/main.typ", severity: "warning", message: "unused", range: "1:0-1:6" },
    ];
    const out = normalizeProjectDiagnostics(raw, files);
    expect(out).toHaveLength(2);

    const libDiag = out.find((d) => d.path === "/lib.typ")!;
    expect(libDiag.severity).toBe("error");
    // range 0:9 is on line 1 of lib.typ -> offset 9.
    expect(libDiag.span?.offset).toBe(9);
    expect(libDiag.span?.start.line).toBe(1);

    const mainDiag = out.find((d) => d.path === "/main.typ")!;
    expect(mainDiag.severity).toBe("warning");
    // range 1:0 is the start of line 2 of main.typ -> offset 23 (after the import line).
    expect(mainDiag.span?.start.line).toBe(2);
    expect(mainDiag.span?.offset).toBe(main.indexOf("#foo()"));
  });

  it("matches paths whether or not typst reports a leading slash", () => {
    const files = new Map([["/main.typ", "= Title\n#broken\n"]]);
    const raw = [{ package: "", path: "main.typ", severity: "error", message: "x", range: "1:0-1:7" }];
    const out = normalizeProjectDiagnostics(raw, files);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("/main.typ");
    expect(out[0]!.span?.start.line).toBe(2);
  });

  it("preserves a diagnostic with no resolvable source (no span, message kept)", () => {
    const files = new Map([["/main.typ", "= Title\n"]]);
    const raw = [{ package: "", path: "/ghost.typ", severity: "error", message: "missing file", range: "0:0-0:1" }];
    const out = normalizeProjectDiagnostics(raw, files);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe("missing file");
    expect(out[0]!.span).toBeUndefined();
    expect(out[0]!.path).toBe("/ghost.typ");
  });

  it("keeps a package diagnostic's message but does not span it against a local file", () => {
    const files = new Map([["/main.typ", "#import \"@preview/x:1.0.0\": y\n"]]);
    const raw = [{ package: "@preview/x:1.0.0", path: "/lib.typ", severity: "error", message: "in package", range: "0:0-0:1" }];
    const out = normalizeProjectDiagnostics(raw, files);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toBe("in package");
    expect(out[0]!.span).toBeUndefined();
  });

  it("carries hints through", () => {
    const files = new Map([["/main.typ", "= Title\n#broken\n"]]);
    const raw = [
      { package: "", path: "/main.typ", severity: "error", message: "x", range: "1:0-1:7", hints: ["try this"] },
    ];
    const out = normalizeProjectDiagnostics(raw, files);
    expect(out[0]!.hints).toEqual(["try this"]);
  });
});

/**
 * typst's image() decode failures are terse and never name the accepted
 * formats; `enrichImageHint` appends a clarifying hint (PNG/JPEG/GIF/SVG) and is
 * wired through both normalizers. The matcher is conservative and the hint is
 * purely additive — the original message is preserved.
 */
describe("enrichImageHint / unsupported image format", () => {
  const GUIDANCE = "PNG, JPEG, GIF, and SVG";

  it("adds the format guidance hint to an image-decode message (single-file)", () => {
    const out = normalizeDiagnostics(
      [{ severity: "error", message: "failed to parse image (unknown format)" }],
      "src",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.hints?.some((h) => h.includes(GUIDANCE))).toBe(true);
  });

  it("leaves a benign message untouched (no hints added)", () => {
    const out = normalizeDiagnostics([{ severity: "error", message: "unknown variable: x" }], "src");
    expect(out).toHaveLength(1);
    expect(out[0]!.hints).toBeUndefined();
  });

  it("preserves a pre-existing compiler hint and appends ours after it", () => {
    const got = enrichImageHint({ severity: "error", message: "failed to decode image", hints: ["existing"] });
    expect(got.hints).toHaveLength(2);
    expect(got.hints![0]).toBe("existing");
    expect(got.hints![1]).toContain(GUIDANCE);
  });

  it("is idempotent — does not duplicate the hint if already present", () => {
    const once = enrichImageHint({ severity: "error", message: "failed to decode image" });
    const twice = enrichImageHint(once);
    expect(twice.hints).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it("returns a NEW object and does not mutate its argument", () => {
    const input: Parameters<typeof enrichImageHint>[0] = {
      severity: "error",
      message: "failed to load image",
      hints: ["existing"],
    };
    const out = enrichImageHint(input);
    expect(out).not.toBe(input);
    expect(input.hints).toEqual(["existing"]);
  });

  it("carries both the span/path AND the image hint through the multi-file path", () => {
    const out = normalizeProjectDiagnostics(
      [{ package: "", path: "/main.typ", severity: "error", message: "failed to decode image", range: "1:0-1:6" }],
      new Map([["/main.typ", '#image("/x.pdf")\n#image("/x.pdf")']]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("/main.typ");
    expect(out[0]!.span?.start.line).toBe(2);
    expect(out[0]!.hints?.some((h) => h.includes(GUIDANCE))).toBe(true);
  });
});

/** The single-file normalizer is unchanged; pin its behavior alongside. */
describe("normalizeDiagnostics (single-file, unchanged)", () => {
  it("maps a range against the one source and sets no path", () => {
    const out = normalizeDiagnostics(
      [{ severity: "error", message: "boom", range: "1:0-1:5" }],
      "line one\nline two\n",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBeUndefined();
    expect(out[0]!.span?.start.line).toBe(2);
  });
});
