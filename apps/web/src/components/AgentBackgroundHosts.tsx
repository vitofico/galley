/**
 * `<AgentBackgroundHosts/>` (F13.3) — the never-unmounting app-root mount that runs
 * the headless agent-apply host for a standing `persistentAccess` grant whose
 * project is NOT the foregrounded editor document. Mounted ABOVE the router (in
 * main.tsx), so navigating between projects / to the library never unmounts it and
 * the host SURVIVES the editor moving off the project — the whole point of F13.
 *
 * v1 SINGLE-GRANT (operator-confirmed): the manager holds one active grant. This
 * runs at most one background host, for that grant, ONLY when:
 *   - it carries `persistentAccess` and is exact-scope + not idle-expired past the
 *     7-day TTL ({@link grantAuthorizesHeadlessAttach}); AND
 *   - its project is NOT the currently-foregrounded one (the editor owns that — the
 *     host SKIPS it so two appliers never run for one project; the Web-Lock is the
 *     hard backstop regardless).
 * A multi-project keyed grant store is a later follow-up.
 *
 * It renders nothing visible. It subscribes to the manager (grant changes) and the
 * router (foreground changes) and re-evaluates `active` on every change.
 */
import { useEffect, useState } from "react";
import { grantAuthorizesHeadlessAttach } from "../proposal-grant.js";
import { getControlResponderManager } from "../control-responder-mount.js";
import { readHeadlessStamp } from "../headless-access-stamp.js";
import { resolveSyncUrl, configuredSyncUrlOverride } from "../share.js";
import { currentRoute, subscribeToRoute } from "../router.js";
import { foregroundProjectId } from "../agent-background-foreground.js";
import { fastProjectId } from "../unified-project-id.js";
import { useAgentApplyHost, type HeadlessHostGrant } from "../use-agent-apply-host.js";

/** The localStorage-like store the manager + the TTL stamp read from (privacy-mode → null). */
function hostStore(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // access can throw (privacy mode) — no store, no host
  }
  return null;
}

export function AgentBackgroundHosts(): null {
  const manager = getControlResponderManager();
  // Re-render on grant changes (recordGrant / setGrantMode / enable / disable / the
  // async resume) and on route changes (foreground project switches).
  const [, setTick] = useState(0);
  const bump = (): void => setTick((n) => n + 1);
  useEffect(() => manager.subscribe(bump), [manager]);
  useEffect(() => subscribeToRoute(bump), []);

  const store = hostStore();
  const route = currentRoute();
  // M1 fix: resolve the home route's foreground id the SAME way UnifiedRoot does
  // (fastProjectId(undefined)) — NOT a literal "default" — so a persistentAccess
  // grant for the project the editor is showing on the home route is correctly
  // treated as foreground and the host SKIPS it (no second applier on the live doc).
  const fg = foregroundProjectId(route, window.location.search, () => fastProjectId(undefined));

  // Resolve the candidate background grant: the manager's active grant when it is a
  // standing, non-idle-expired persistentAccess grant for a NON-foreground project.
  const grant = manager.getActiveGrant();
  let hostGrant: HeadlessHostGrant | null = null;
  let active = false;
  if (
    grant !== null &&
    grant.persistentAccess === true &&
    grant.projectId !== fg &&
    manager.isEnabled() &&
    store !== null
  ) {
    // Build the LIVE scope the same way open_project/reuse derives it, so the exact-
    // scope check in grantAuthorizesHeadlessAttach is meaningful. The control room +
    // relay are the manager's live ones; the project/share/main come from the grant.
    const controlRoom = manager.getState().controlRoom;
    if (controlRoom !== null) {
      const syncUrl = resolveSyncUrl(configuredSyncUrlOverride(), window.location);
      const liveScope = {
        controlRoom,
        syncUrl,
        projectId: grant.projectId,
        shareRoom: grant.shareRoom,
        mainFile: grant.mainFile,
      };
      const lastActiveAt = readHeadlessStamp(store, grant.grantId) ?? grant.grantedAt;
      if (grantAuthorizesHeadlessAttach(grant, liveScope, lastActiveAt, Date.now())) {
        hostGrant = {
          grantId: grant.grantId,
          controlRoom: grant.controlRoom,
          projectId: grant.projectId,
          shareRoom: grant.shareRoom,
          syncUrl: grant.syncUrl,
          mainFile: grant.mainFile,
        };
        active = true;
      }
    }
  }

  useAgentApplyHost({ grant: hostGrant, active, store });
  return null;
}
