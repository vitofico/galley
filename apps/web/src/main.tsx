import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { isAuthEnabled } from "./auth-gate.js";
import { AuthGate } from "./components/AuthGate.js";
import { getControlResponderManager } from "./control-responder-mount.js";
import { AgentBackgroundHosts } from "./components/AgentBackgroundHosts.js";
import { currentRoute, homeShowsEditor, subscribeToRoute, type Route } from "./router.js";
import { applySkin, resolveInitialSkin, SKIN_STORAGE_KEY } from "./skin.js";
import { applyTheme, resolveInitialTheme, STORAGE_KEY as THEME_STORAGE_KEY } from "./theme.js";
import "./styles.css";
import "./theme.css";

// Reflect the stored skin + mode onto <html> SYNCHRONOUSLY, before the first
// React render — so the top-level surfaces the router never owns (the auth
// gate's sign-in card and its checking state) paint in the right palette with
// no flash. The default skin is Studio (the Galley logo's tangerine), so a
// fresh visitor's sign-in screen already wears the brand. Each route shell
// re-applies the same values on mount (idempotent).
try {
  const readStored = (key: string): string | null => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(resolveInitialTheme({ stored: readStored(THEME_STORAGE_KEY), prefersDark }));
  applySkin(resolveInitialSkin({ stored: readStored(SKIN_STORAGE_KEY) }));
} catch {
  /* a DOM-less or storage-less context: theming is best-effort, never fatal */
}

// Route components are lazy-loaded so only the booted route's app code is in the
// first chunk (L5-P3): the library dashboard, the project/join shells, and the
// settings surface each become their own chunk behind a dynamic import.
const LibraryRoot = lazy(() => import("./library-root.js").then((m) => ({ default: m.LibraryRoot })));
const UnifiedRoot = lazy(() => import("./unified-root.js").then((m) => ({ default: m.UnifiedRoot })));
const JoinRoot = lazy(() => import("./join-root.js").then((m) => ({ default: m.JoinRoot })));
const SettingsRoot = lazy(() => import("./settings-root.js").then((m) => ({ default: m.SettingsRoot })));

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Initialize the Agent Access responder singleton at module scope — but keep it
// INERT: the manager mints no room, joins no relay, and answers nothing until the
// user explicitly enables it in /settings (#16.3, ADR-0021; DEFAULT-OFF). Touching
// it here just guarantees one shared instance per tab for the settings surface.
getControlResponderManager();

/**
 * The routed app (#19.4, spec §5): real paths replace query params, dispatched
 * by the hand-rolled History-API router. Browser back/forward re-renders here
 * (popstate → subscription), and in-app navigation (`navigate()`) pushes
 * history entries without a full reload.
 *
 *   `/`            → the Projects page (the landing surface); `?seed=…` still
 *                    boots a seeded editor on home (the showcase / e2e hatch)
 *   `/library`     → the project library/dashboard (#12.3) — alias of `/`
 *   `/p/<id>`      → a specific persistent project (opened from the library)
 *   `/join/<room>` → share-link entry: name prompt once, then the shared room
 *   `/settings`    → the unified device-scoped settings surface (#19.7)
 */
function RouterRoot() {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  useEffect(() => subscribeToRoute(() => setRoute(currentRoute())), []);
  switch (route.kind) {
    case "library":
      return <LibraryRoot />;
    case "project":
      // Keyed by id so switching projects remounts a fresh shell over that doc.
      return <UnifiedRoot key={route.id} projectId={route.id} />;
    case "join":
      return (
        <JoinRoot
          key={route.room}
          room={route.room}
          {...(route.sync ? { sync: route.sync } : {})}
          {...(route.role ? { role: route.role } : {})}
        />
      );
    case "settings":
      return <SettingsRoot />;
    case "home":
      // The Projects page is the landing surface; the only editor-on-home hatch
      // is `?seed=…` (the Einstein showcase / e2e entry). All other editor entry
      // is `/p/<id>`.
      return homeShowsEditor(window.location.search) ? (
        <UnifiedRoot key="default" />
      ) : (
        <LibraryRoot />
      );
  }
}

// Every path goes through the hand-rolled History-API router.
const view = <RouterRoot />;

// 14-E boot-time auth gate. Mounted ONLY when the server-rendered runtime
// config (`/config.js` → `window.__GALLEY_CONFIG__.auth`) says auth is on —
// the SPA NEVER probes /auth/me to find out (auth-off deployments answer that
// path with the SPA shell itself). Without the flag the gate code does not
// mount and boot is byte-for-byte the no-auth behavior.
const authEnabled = isAuthEnabled(
  (window as unknown as { __GALLEY_CONFIG__?: unknown }).__GALLEY_CONFIG__,
);

// Suspense covers the brief dynamic-import of the chosen route chunk. The
// fallback is empty (the shells render their own loading state once mounted).
createRoot(root).render(
  <StrictMode>
    {/* F13: the headless agent-apply host lives ABOVE the router so it survives the
        editor navigating off a project. It is INERT until Agent Access is enabled
        AND a persistentAccess grant exists for a non-foreground project (default-OFF).
        Mounted outside the AuthGate so it keeps applying regardless of the shown
        route; it renders nothing. */}
    <AgentBackgroundHosts />
    <Suspense fallback={null}>{authEnabled ? <AuthGate>{view}</AuthGate> : view}</Suspense>
  </StrictMode>,
);
