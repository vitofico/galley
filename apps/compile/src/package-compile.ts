/**
 * Package-enabled server compile (roadmap #3 slice 6) — composes slices 1/5 into
 * the request flow: scan a compile input's `@preview/…` imports → `prewarmRegistry`
 * them → compile with that resolver.
 *
 * The engine is created ONCE (WASM init is expensive) around a **mutable resolver
 * holder**, because typst.ts's package callback is synchronous and per-compile. A
 * request prewarms, points the holder at the resulting resolver, compiles, then
 * clears it. This is safe because the service serializes compiles on the single
 * engine (no concurrent access to the holder). Packages stay OFF unless a registry
 * is configured; with none, `holder.current` is null → fail closed as before.
 */
import {
  packageSpecString,
  parsePackageImports,
  type PackageResolver,
  type PackageSpec,
} from "@galley/compiler";
import { isProjectInput, type CompileInput } from "@galley/shared";
import type { CompileBackend } from "./index.js";
import { prewarmRegistry, type PrewarmOptions } from "./registry-resolver.js";

/**
 * A `PackageResolver` whose target is swapped per request. The engine is wired to
 * this once; the request sets `current` just before compiling and clears it after.
 */
export class MutablePackageResolver implements PackageResolver {
  current: PackageResolver | null = null;
  resolve(spec: PackageSpec): ReturnType<PackageResolver["resolve"]> {
    return this.current ? this.current.resolve(spec) : null;
  }
}

/** Distinct `@preview/…` specs imported anywhere in a compile input (deduped). */
export function scanCompileInputImports(input: CompileInput): PackageSpec[] {
  const sources = isProjectInput(input) ? input.files.map((f) => f.text) : [input];
  const seen = new Set<string>();
  const out: PackageSpec[] = [];
  for (const src of sources) {
    for (const spec of parsePackageImports(src)) {
      const key = packageSpecString(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
  }
  return out;
}

export interface PackageAwareBackendOptions {
  /** The underlying compiler (the Node `TypstEngine`, created around `holder`). */
  engine: CompileBackend;
  /** The SAME holder instance the engine's package resolver was created from. */
  holder: MutablePackageResolver;
  /** Fetch+validate the imported packages into a synchronous resolver, or null. */
  prewarm: (specs: PackageSpec[]) => Promise<PackageResolver | null>;
}

/**
 * Wrap an engine so each compile first resolves its imported packages. Returns a
 * `CompileBackend` (so the Hono app is unchanged). The holder is always cleared
 * after a compile, even on throw — no resolver leaks into the next request.
 */
export function createPackageAwareBackend(options: PackageAwareBackendOptions): CompileBackend {
  const { engine, holder, prewarm } = options;

  async function withPackages<T>(input: CompileInput, run: () => Promise<T>): Promise<T> {
    const specs = scanCompileInputImports(input);
    holder.current = specs.length > 0 ? await prewarm(specs) : null;
    try {
      return await run();
    } finally {
      holder.current = null;
    }
  }

  return {
    check: (input) => withPackages(input, () => engine.check(input)),
    render: (input) => withPackages(input, () => engine.render(input)),
    export: (input) => withPackages(input, () => engine.export(input)),
  };
}

/** Bind a prewarm function to fixed registry options (server wiring helper). */
export function prewarmFromRegistry(
  options: PrewarmOptions,
): (specs: PackageSpec[]) => Promise<PackageResolver> {
  return (specs) => prewarmRegistry(specs, options);
}
