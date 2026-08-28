/**
 * `createProject(seed)` orchestration (project-model redesign §2) + the
 * supporting name derivations (§3/§4).
 *
 * A create is: mint a `projectId` → register it in the local `IdbProjectStore`
 * with the seed's name → stash the seed in the consume-once pending-seed map →
 * navigate (an in-SPA `pushState`) to `/p/<id>`. The immediately-mounted
 * `ProjectApp` boot consumes the pending seed and `seedIfPristine` writes it once
 * — the single writer. The CURRENT project is never touched.
 *
 * Every create path routes through here: blank (the library / new-project
 * actions), Einstein (the template entry), and import (its own new project).
 */
import type { SeedFile } from "@galley/collab";
import { IdbProjectStore } from "./idb-project-store.js";
import { loadLocalProfile } from "./local-profile.js";
import { setPendingSeed, type SeedKind } from "./pending-seed.js";
import { randomProjectName } from "./random-project-name.js";
import { navigate } from "./router.js";
// The `proj-<uuid>` minter + name cap live in the headless library-create helper
// (create-library-project.ts) so the id format + clamp stay shared without that
// headless helper depending on this editor-flow module (which pulls in navigate).
import { mintProjectId, MAX_PROJECT_NAME_LENGTH } from "./create-library-project.js";
import {
  BLANK_STARTER_FILES,
  BLANK_STARTER_MAIN,
  SAMPLE_PROJECT_FILES,
  SAMPLE_PROJECT_MAIN,
} from "./project-sample.js";
import { LOWRY_FILES, LOWRY_MAIN, LOWRY_NAME } from "./demo/lowry-1951.js";

/** Cap a derived project name so a pathological filename can't bloat the registry. */
export { MAX_PROJECT_NAME_LENGTH };

/**
 * Derive a project name from an imported zip's filename (§3). Strips a trailing
 * `.zip`, drops any directory prefix, collapses whitespace, and caps the length.
 * An empty/whitespace-only/unsafe result falls back to a friendly random name.
 *
 * PURE + deterministic-testable: the fallback RNG is injectable.
 */
export function projectNameFromZipFilename(
  filename: string | undefined,
  rng: () => number = Math.random,
): string {
  const base = (filename ?? "")
    // Drop any directory prefix (both separators) — keep only the basename.
    .split(/[/\\]/)
    .pop()!
    // Strip a trailing .zip (case-insensitive).
    .replace(/\.zip$/i, "")
    // Collapse all whitespace runs (incl. control chars) to single spaces.
    .replace(/[\s\x00-\x1f]+/g, " ")
    .trim()
    .slice(0, MAX_PROJECT_NAME_LENGTH)
    .trim();
  return base.length === 0 ? randomProjectName(rng) : base;
}

/** A request to create a new project. `name` defaults per kind when omitted. */
export interface CreateProjectSeed {
  kind: SeedKind;
  files: SeedFile[];
  mainPath: string;
  demoHistory: boolean;
  /** Explicit name; when omitted a friendly random name is generated. */
  name?: string;
}

/** A blank-starter create request (§1) — the default new-project seed. */
export function blankSeed(name?: string): CreateProjectSeed {
  return {
    kind: "blank",
    files: BLANK_STARTER_FILES,
    mainPath: BLANK_STARTER_MAIN,
    demoHistory: false,
    ...(name !== undefined ? { name } : {}),
  };
}

/** The Einstein-demo create request (§5 template entry) — seeds demo history. */
export function einsteinSeed(name?: string): CreateProjectSeed {
  return {
    kind: "einstein",
    files: SAMPLE_PROJECT_FILES,
    mainPath: SAMPLE_PROJECT_MAIN,
    demoHistory: true,
    ...(name !== undefined ? { name } : {}),
  };
}

/**
 * The Lowry-1951 create request — a second styleable demo SEED (not a template):
 * the most-cited paper in the journal house format of its `/style.typ`. No demo
 * history (a single article, not a year's worth of drafts). Reached through the
 * `?seed=lowry` boot hatch; this helper is the in-SPA create path for parity.
 */
export function lowrySeed(name?: string): CreateProjectSeed {
  return {
    kind: "lowry",
    files: LOWRY_FILES,
    mainPath: LOWRY_MAIN,
    demoHistory: false,
    name: name ?? LOWRY_NAME,
  };
}

/** Injectable seams for {@link createProject} (defaults wire the real browser). */
export interface CreateProjectDeps {
  store?: IdbProjectStore;
  ownerId?: string;
  newId?: () => string;
  navigate?: (href: string) => void;
  rng?: () => number;
}

/**
 * Create a brand-new project from `seed` and navigate to it. Returns the new
 * project id. The current project/doc is left completely untouched.
 *
 * On a registry failure the error propagates and NO navigation happens (callers
 * — e.g. import — surface their own error UI and stay put), so a half-created,
 * unregistered project is never opened.
 */
export async function createProject(
  seed: CreateProjectSeed,
  deps: CreateProjectDeps = {},
): Promise<string> {
  const store = deps.store ?? new IdbProjectStore();
  const ownerId = deps.ownerId ?? loadLocalProfile().userId;
  const id = (deps.newId ?? mintProjectId)();
  const name = seed.name ?? randomProjectName(deps.rng ?? Math.random);

  // Register FIRST (the only fallible step) so a failure never leaves a pending
  // seed orphaned and never navigates to an unregistered project.
  await store.createProject({ id, name, ownerId });

  setPendingSeed(id, {
    kind: seed.kind,
    files: seed.files,
    mainPath: seed.mainPath,
    demoHistory: seed.demoHistory,
    name,
  });
  (deps.navigate ?? navigate)(`/p/${encodeURIComponent(id)}`);
  return id;
}
