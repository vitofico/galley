/**
 * Bridges the ADR-0014 `PackageResolver` seam to typst.ts's package-registry
 * callback, so a `@preview/…` import resolves from an in-memory, **pre-validated**
 * resolver (a `FakeRegistry` now; a sandboxed server-side fetch later, roadmap #3)
 * with NO network access. This is what flips the browser/Node compile from
 * fail-closed ("Dummy Registry") to "packages resolve" — but ONLY when a resolver
 * is explicitly supplied; the default engine stays fail-closed.
 *
 * Two facts about typst.ts 0.7 this encodes (both verified empirically):
 *   - typst only reads package files from its special `/@memory` namespace; any
 *     other path is rejected as "outside the project root". So we re-root every
 *     ADR-0014 path (`/packages/<ns>/<name>/<version>/…`) under `/@memory/galley`.
 *   - the registry must write into the SAME `MemoryAccessModel` instance the
 *     compiler is given via `withAccessModel` — that is how the compiler reads
 *     what `resolve()` inserts.
 *
 * It reuses ADR-0014's `resolvePackagePaths` validation entirely (one validation
 * path — no second, weaker copy); this bridge only adapts shapes + namespaces.
 */
import { MemoryAccessModel, initOptions } from "@myriaddreamin/typst.ts";
import type { BeforeBuildFn } from "@myriaddreamin/typst.ts";
import type { PackageResolver, PackageSpec } from "./package-resolver.js";

/** typst.ts's writable in-memory namespace; package files live under here. */
const MEM_PREFIX = "/@memory/galley";
const EPOCH = new Date(0);
const enc = new TextEncoder();

function memRoot(spec: PackageSpec): string {
  return `${MEM_PREFIX}/packages/${spec.namespace}/${spec.name}/${spec.version}`;
}

/**
 * Build the typst.ts `beforeBuild` callbacks that wire `resolver` as the compiler's
 * package registry. Pass the result to `compiler.init({ beforeBuild })`. A spec the
 * resolver doesn't have returns `undefined` → typst fails the import closed (never
 * a crash, never a network call).
 */
export function packageRegistryBeforeBuild(resolver: PackageResolver): BeforeBuildFn[] {
  const am = new MemoryAccessModel();
  // Packages are immutable (version-pinned) and the access model survives
  // `resetShadow()`, so insert each resolved package's files at most once.
  const inserted = new Set<string>();
  return [
    initOptions.withAccessModel(am),
    initOptions.withPackageRegistry({
      resolve(spec: PackageSpec): string | undefined {
        const root = memRoot(spec);
        if (inserted.has(root)) return root;
        const files = resolver.resolve({
          namespace: spec.namespace,
          name: spec.name,
          version: spec.version,
        });
        if (!files) return undefined; // fail closed
        for (const f of files) {
          // ADR-0014 paths are already `/packages/<ns>/<name>/<version>/…`,
          // validated + traversal-checked; re-root under the memory namespace.
          am.insertFile(`${MEM_PREFIX}${f.path}`, enc.encode(f.text), EPOCH);
        }
        inserted.add(root);
        return root;
      },
    }),
  ];
}
