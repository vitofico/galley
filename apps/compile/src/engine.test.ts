/**
 * The Node engine the compile service runs MUST load the bundled font set, or
 * font-requiring content fails "no font could be found" (typst.ts 0.7 ships no
 * fonts in the WASM). `check` is font-free and plain-Latin render falls back, so
 * the gap only surfaces on real content — math mode needs the bundled NewCMMath
 * math font. These tests pin the render/export path with the staged font set.
 *
 * The fonts come from apps/web/public/fonts (staged at image build; gitignored, so
 * a clean checkout has none until `copy-wasm` runs). When the directory is absent
 * the font-requiring assertions skip rather than hard-fail.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeEngine } from "./engine.js";

const fontsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "public",
  "fonts",
);
const hasFonts =
  existsSync(fontsDir) &&
  readdirSync(fontsDir).some((f) => f.endsWith(".otf") || f.endsWith(".ttf"));

describe("createNodeEngine", () => {
  it.runIf(hasFonts)(
    "renders math with the bundled math font (no 'no font could be found')",
    async () => {
      const engine = await createNodeEngine();
      const res = await engine.render("Inline math $x^2 + 1$ and a heading.\n\n= Title");
      const fontError = res.diagnostics.find(
        (d) => d.severity === "error" && /font/i.test(d.message),
      );
      expect(fontError).toBeUndefined();
      expect(res.ok).toBe(true);
    },
    60_000,
  );

  it.runIf(hasFonts)("exports a PDF for a document with math", async () => {
    const engine = await createNodeEngine();
    const res = await engine.export("Prose with $alpha$ and more text.");
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(res.ok).toBe(true);
  }, 60_000);

  it("still reports diagnostics for a broken document (font-free check path)", async () => {
    const engine = await createNodeEngine();
    const res = await engine.check("#let x =");
    expect(res.diagnostics.some((d) => d.severity === "error")).toBe(true);
  }, 60_000);
});
