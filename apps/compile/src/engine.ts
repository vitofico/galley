/**
 * Node engine factory for the compile service. Reads the typst.ts WASM straight
 * from the installed packages (the service IS the "app" that provides WASM to the
 * framework-agnostic `TypstEngine`, the same role apps/web plays in the browser).
 *
 * An optional `packageResolver` (ADR-0014/0015) is threaded through — unset here
 * (packages stay fail-closed) until the sandboxed `RegistryResolver` lands
 * (slices 5–6).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TypstEngine } from "@galley/compiler";
import type { PackageResolver } from "@galley/compiler";

const require = createRequire(import.meta.url);

function wasmFor(pkg: string, file: string): Uint8Array {
  const entry = require.resolve(pkg);
  return new Uint8Array(readFileSync(join(dirname(entry), file)));
}

/**
 * Where the bundled typst font set lives — the SAME files apps/web serves from
 * `/fonts/` (Libertinus / NewCM / DejaVuMono + the NewCMMath math font), staged
 * into apps/web/public/fonts at image build (see Dockerfile). Override with
 * `GALLEY_FONTS_DIR` for a non-standard runtime layout.
 */
function fontsDir(): string {
  const override = process.env.GALLEY_FONTS_DIR?.trim();
  if (override) return override;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public", "fonts");
}

let cachedFonts: Uint8Array[] | null = null;
/**
 * Read the bundled font bytes once (cached for the process). typst.ts 0.7 ships
 * NO fonts in the WASM, so without these every render/export fails "no font could
 * be found" — `check` is font-free and would still pass, which is exactly how the
 * gap hid. Returns `[]` when the directory is absent/empty so a font-less host
 * still boots (text just won't render); the standard image always stages them.
 */
function loadBundledFonts(): Uint8Array[] {
  if (cachedFonts) return cachedFonts;
  const dir = fontsDir();
  cachedFonts = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".otf") || f.endsWith(".ttf"))
        .map((f) => new Uint8Array(readFileSync(join(dir, f))))
    : [];
  return cachedFonts;
}

export async function createNodeEngine(packageResolver?: PackageResolver): Promise<TypstEngine> {
  const compilerModule = wasmFor(
    "@myriaddreamin/typst-ts-web-compiler",
    "typst_ts_web_compiler_bg.wasm",
  );
  const rendererModule = wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm");
  const fontBlobs = loadBundledFonts();
  // exactOptionalPropertyTypes: only set optional props when actually provided.
  return TypstEngine.create({
    compilerModule,
    rendererModule,
    ...(fontBlobs.length > 0 ? { fontBlobs } : {}),
    ...(packageResolver ? { packageResolver } : {}),
  });
}
