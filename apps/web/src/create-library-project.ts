/**
 * `createLibraryProject(name, deps)` — the HEADLESS create the Agent Access
 * responder uses (road-test finding F1). It REGISTERS a brand-new, empty project
 * in the local {@link IdbProjectStore} (the same authority that answers
 * list_projects) so it shows in the library and a human can later open it — but
 * it NEVER navigates the tab or writes a pending seed.
 *
 * It is deliberately distinct from project-create.ts `createProject`, which is an
 * EDITOR-flow create: it navigates (`/p/<id>`) and stashes a consume-once pending
 * seed for the immediately-mounted ProjectApp to write. Those are editor concerns
 * the headless responder must not trigger (it would yank the user's tab). A
 * registry-only project has no CRDT db yet; seeding happens normally via the
 * editor's `seedIfPristine`/`BLANK_STARTER_FILES` the first time a human opens it.
 *
 * The `proj-<uuid>` id minter lives HERE (and project-create.ts imports it) so the
 * id format stays shared without the headless helper depending on project-create.ts
 * (which pulls in router.navigate — an editor concern this module must avoid).
 */
import { IdbProjectStore } from "./idb-project-store.js";
import { randomProjectName } from "./random-project-name.js";

/** Cap a derived project name so a pathological name can't bloat the registry. */
export const MAX_PROJECT_NAME_LENGTH = 80;

/** Mint a `proj-…` id, like the registry's default generator. */
export function mintProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `proj-${token}`;
}

/** Injectable seams for {@link createLibraryProject} (no navigate — by design). */
export interface CreateLibraryProjectDeps {
  /** The project library this registers into (the list_projects authority). */
  store: IdbProjectStore;
  /** The owner of the new project (the responder uses the local profile user). */
  ownerId: string;
  /** Injectable id minter for tests; defaults to {@link mintProjectId}. */
  newId?: () => string;
  /** Injectable fallback RNG for an empty name; defaults to Math.random. */
  rng?: () => number;
}

/**
 * Register a brand-new, empty project named `name` and return its `{projectId,
 * name}`. The display name is sanitized (control chars/whitespace collapsed) and
 * clamped to {@link MAX_PROJECT_NAME_LENGTH}; an empty/whitespace result falls back
 * to a friendly random name (same derivation as the import/blank paths). NO
 * navigation and NO CRDT seed — the project is registry-only until a human opens it.
 */
export async function createLibraryProject(
  name: string,
  deps: CreateLibraryProjectDeps,
): Promise<{ projectId: string; name: string }> {
  const sanitized = name
    // Collapse all whitespace runs (incl. control chars) to single spaces.
    .replace(/[\s\x00-\x1f]+/g, " ")
    .trim()
    .slice(0, MAX_PROJECT_NAME_LENGTH)
    .trim();
  const clean = sanitized.length === 0 ? randomProjectName(deps.rng ?? Math.random) : sanitized;
  const id = (deps.newId ?? mintProjectId)();
  await deps.store.createProject({ id, name: clean, ownerId: deps.ownerId });
  return { projectId: id, name: clean };
}
