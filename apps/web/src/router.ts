/**
 * Hand-rolled History-API router (#19.4, spec §5) — real paths replace the
 * query-param dispatch:
 *
 *   `/`             → the default persistent project
 *   `/library`      → the project dashboard
 *   `/p/<id>`       → a specific project
 *   `/join/<room>`  → share-link entry (joins the sync room; `?sync=` override)
 *   `/settings`     → the unified device-scoped settings surface (#19.7)
 *
 * Deliberately tiny and framework-free: the PURE part (route parsing) is plain
 * string functions so they unit-test in the Node gate, and the browser part is a
 * ~20-line pushState/popstate wrapper.
 */

import { parseShareRole, type ShareRole } from "./share.js";

export type Route =
  | { kind: "home" }
  | { kind: "library" }
  | { kind: "project"; id: string }
  | { kind: "join"; room: string; sync?: string; role?: ShareRole }
  | { kind: "settings" };

/** Parse a location into a `Route`. Unknown paths fall back to the default project. */
export function parseRoute(pathname: string, search = ""): Route {
  const segments = pathname.split("/").filter((s) => s !== "");
  if (segments.length === 0) return { kind: "home" };
  if (segments.length === 1 && segments[0] === "library") return { kind: "library" };
  if (segments.length === 1 && segments[0] === "settings") return { kind: "settings" };
  if (segments.length === 2 && segments[0] === "p" && segments[1]) {
    return { kind: "project", id: decodeSegment(segments[1]!) };
  }
  if (segments.length === 2 && segments[0] === "join" && segments[1]) {
    const params = new URLSearchParams(search);
    const sync = params.get("sync");
    // Carry the join role into the route (and thus presence) ONLY when the link
    // supplies it — `buildShareLink` always encodes one. Decoded fail-closed
    // (unknown/forged ⇒ viewer) so a tampered link can never escalate.
    const rawRole = params.get("role");
    return {
      kind: "join",
      room: decodeSegment(segments[1]!),
      ...(sync ? { sync } : {}),
      ...(rawRole !== null ? { role: parseShareRole(rawRole) } : {}),
    };
  }
  return { kind: "home" };
}

/** The canonical href for a route (used by navigation affordances + tests). */
export function routeHref(route: Route): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "library":
      return "/library";
    case "project":
      return `/p/${encodeURIComponent(route.id)}`;
    case "join": {
      const params = new URLSearchParams();
      if (route.sync) params.set("sync", route.sync);
      if (route.role) params.set("role", route.role);
      const query = params.toString();
      return `/join/${encodeURIComponent(route.room)}${query ? `?${query}` : ""}`;
    }
    case "settings":
      return "/settings";
  }
}

/**
 * Whether bare `/` should boot the **editor** rather than the Projects page.
 *
 * Since the Projects page became the landing surface, `/` renders the project
 * library by default. The single retained editor-on-home hatch is `?seed=…`
 * (the Einstein showcase / e2e entry — its existing usages must keep booting a
 * seeded editor). Everything else on `/` — including `?serverCompile=`/`?id=` —
 * is the Projects page; deep editor entry is `/p/<id>`. Pure (Node-tested).
 */
export function homeShowsEditor(search: string): boolean {
  return new URLSearchParams(search).has("seed");
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // malformed percent-encoding — use the raw segment
  }
}


// --- The browser part: a minimal pushState/popstate wrapper -------------------

type RouteListener = () => void;
const listeners = new Set<RouteListener>();
let popstateWired = false;

function notify(): void {
  for (const l of [...listeners]) l();
}

/** The route for the CURRENT browser location. Browser-only. */
export function currentRoute(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}

/**
 * Navigate to an app path WITHOUT a full reload: push a history entry and
 * notify subscribers (the route root re-renders). Browser-only.
 */
export function navigate(href: string): void {
  window.history.pushState(null, "", href);
  notify();
}

/**
 * Subscribe to route changes (both `navigate()` calls and browser
 * back/forward via `popstate`). Returns an unsubscribe. Browser-only.
 */
export function subscribeToRoute(cb: RouteListener): () => void {
  if (!popstateWired) {
    window.addEventListener("popstate", notify);
    popstateWired = true;
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
