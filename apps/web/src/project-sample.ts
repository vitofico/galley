/**
 * The default seed for a fresh project boot — since #20.2 this is the
 * "Annus Mirabilis" Einstein demo workspace (`demo/einstein-1905.ts`, spec
 * 2026-06-09-einstein-annus-mirabilis-demo-design.md §2/§5): a fresh `/` boots
 * Einstein's desk at the Bern patent office, 1905 — eight files, real math,
 * citations, figures, and an `#include` chain.
 *
 * This module stays as the single indirection point (the spec's "re-point its
 * exports at the demo module" option): `ProjectApp` keeps importing
 * `SAMPLE_PROJECT_*`, and which content a fresh project gets is decided HERE.
 * `seedIfPristine` semantics are unchanged — only a project with no CRDT
 * history is ever seeded; existing projects are untouched.
 *
 * The old bland two-file sample ("A Multi-File Project") is retired; the demo
 * compiles offline, packages-free, with the bundled NewCM fonts (math
 * included) — see `demo/einstein-1905.compile.test.ts`, the authoritative gate.
 */
export {
  DEMO_FILES as SAMPLE_PROJECT_FILES,
  DEMO_MAIN as SAMPLE_PROJECT_MAIN,
} from "./demo/einstein-1905.js";

/** The display name for the Einstein demo (the one preexisting project + `?seed=einstein`). */
export const SAMPLE_PROJECT_NAME = "Annus Mirabilis — 1905";

import type { SeedFile } from "@galley/collab";

/**
 * The blank starter (project-model redesign §1) — the DEFAULT seed for a fresh
 * project. A single `/main.typ` with a tiny placeholder that compiles offline
 * immediately (a heading + one prompt line). The Einstein demo
 * (`SAMPLE_PROJECT_*`) is retained but is no longer the default — it is reached
 * only through the Einstein template path.
 */
export const BLANK_STARTER_MAIN = "/main.typ";

/** The blank starter's single file: a minimal, instantly-compiling placeholder. */
export const BLANK_STARTER_FILES: SeedFile[] = [
  { path: BLANK_STARTER_MAIN, text: "= Untitled\n\nStart writing…\n" },
];
