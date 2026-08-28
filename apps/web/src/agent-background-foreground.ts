/**
 * The pure "which project is foregrounded" resolver for the F13 background host
 * ({@link foregroundProjectId}) — extracted from the React mount so it is unit-
 * testable in `node` (no React, no DOM). The background host SKIPS the foregrounded
 * project (the editor owns it) so two appliers never run for one project.
 *
 * M1 fix (security review): the home/`?seed=` editor route does NOT use a literal
 * "default" room — UnifiedRoot renders it under `fastProjectId(undefined)` (the
 * `?id=` param, else `localStorage[UNIFIED_PROJECT_KEY]`, else a registry/minted
 * id). Hard-coding "default" here let the host compute `grant.projectId !== "default"`
 * → attach a SECOND applier/connection to the very doc the editor was showing (only
 * the grant-keyed Web-Lock saved it from a double-write). So the home branch now
 * resolves the SAME id UnifiedRoot uses, via the injected `resolveHomeProjectId`
 * (production passes `() => fastProjectId(undefined)`). It is injected (not imported)
 * so this module stays pure + node-testable and never pulls in the React root.
 */
import { homeShowsEditor, type Route } from "./router.js";

/**
 * The project id the EDITOR currently has foregrounded, or null when no editor
 * project is open (library / settings / join) OR the home id cannot be resolved
 * synchronously (a cold first boot before UnifiedRoot persists its minted id — a
 * narrow window the grant-keyed Web-Lock still covers).
 *
 *   - `project` (`/p/<id>`) → its explicit id (sound: UnifiedRoot gets it directly).
 *   - `home` with the `?seed=` editor hatch → `resolveHomeProjectId()` (the SAME
 *     `fastProjectId(undefined)` UnifiedRoot resolves the home doc room from).
 *   - library / settings / join → null. (A `join` route is a SHARED room being
 *     visited, never one of the user's owned local projects, so it never collides
 *     with a persistentAccess grant's projectId.)
 */
export function foregroundProjectId(
  route: Route,
  search: string,
  resolveHomeProjectId: () => string | null,
): string | null {
  if (route.kind === "project") return route.id;
  if (route.kind === "home" && homeShowsEditor(search)) return resolveHomeProjectId();
  return null;
}
