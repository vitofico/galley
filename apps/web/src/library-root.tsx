/**
 * `LibraryRoot` — the `/library` route (roadmap #12.3, routed in #19.4): the
 * project library / dashboard wired to the browser substrate. Supplies the
 * presentational `LibraryApp` with a real local `IdbProjectStore`, the
 * persisted local-profile `userId`, and an `onOpen` that launches a project in
 * the unified shell.
 *
 * Local-first: the registry lives in IndexedDB; opening a project navigates to
 * the persistent `/p/<id>` route via the router — a History-API push, no full
 * reload (the project shell keys its CRDT doc by that id).
 */
import { useEffect, useMemo, useState } from "react";
import { LibraryApp } from "./components/LibraryApp.js";
import { IdbProjectStore } from "./idb-project-store.js";
import { loadLocalProfile } from "./local-profile.js";
import { navigate } from "./router.js";
import {
  markEinsteinDemoSeeded,
  setDurableSeed,
  shouldSeedEinsteinDemo,
} from "./durable-seed.js";
import { SAMPLE_PROJECT_NAME } from "./project-sample.js";
import { applyTheme, resolveInitialTheme, STORAGE_KEY } from "./theme.js";
import { applySkin, resolveInitialSkin, SKIN_STORAGE_KEY } from "./skin.js";
import { getActiveAuthUser } from "./auth-gate.js";
// The dark "press" overrides (`:root[data-theme="dark"]`). App/ProjectApp import
// this for their shells; the library route is a separate boot, so without this
// import the `data-theme` attribute would be set but its override block absent,
// leaving the Projects view on the light tokens (R5).
import "./theme.css";

/** A `proj-…` id, minted like the project store's default generator. */
function mintProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `proj-${token}`;
}

/**
 * Create the one preexisting Einstein demo project — ONCE per device. Registers
 * a registry row (so the card appears) + a DURABLE seed (so opening it boots the
 * demo content + history via `resolveBootSeed`), then sets the seed-once flag so
 * deleting the demo never resurrects it. Create is the only fallible step and
 * runs first, so a failure simply retries on the next load (flag stays unset).
 * Best-effort: any failure leaves the Projects page working, just demo-less.
 */
async function seedEinsteinDemoOnce(store: IdbProjectStore, ownerId: string): Promise<boolean> {
  if (!shouldSeedEinsteinDemo()) return false;
  const id = mintProjectId();
  await store.createProject({ id, name: SAMPLE_PROJECT_NAME, ownerId });
  await store.updateProject(id, { createdAt: Date.now(), updatedAt: Date.now() });
  setDurableSeed(id, { kind: "einstein", name: SAMPLE_PROJECT_NAME });
  markEinsteinDemoSeeded();
  return true;
}

export function LibraryRoot() {
  const store = useMemo(() => new IdbProjectStore(), []);
  const userId = useMemo(() => loadLocalProfile().userId, []);
  // 14-E: the signed-in user, published by the boot AuthGate before any shell
  // mounts. Read once (stable for this mount); null in auth-off runs.
  const authUser = useMemo(() => getActiveAuthUser(), []);

  // Seed the one-time Einstein demo before listing. The common (already-seeded)
  // case resolves synchronously — `shouldSeedEinsteinDemo()` is a localStorage
  // read — so there is no flash; only a genuinely-first run waits one async tick
  // for the registry write before the list renders (and thus includes the demo).
  const [seedReady, setSeedReady] = useState(() => !shouldSeedEinsteinDemo());

  // Dark "press" mode (#11.6 / R5): the library/Projects route is its own boot,
  // so it must resolve + reflect the chosen theme on mount the same way the
  // editor shells (App/ProjectApp) do. Without this the Projects view rendered
  // byte-identical in light and dark (the `data-theme` attribute was never set),
  // and its token-driven CSS (--paper/--line/--ink) stayed on the light values.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const prefersDark =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    applyTheme(resolveInitialTheme({ stored, prefersDark }));
    let storedSkin: string | null = null;
    try { storedSkin = localStorage.getItem(SKIN_STORAGE_KEY); } catch { /* storage off */ }
    applySkin(resolveInitialSkin({ stored: storedSkin }));
  }, []);

  useEffect(() => {
    if (seedReady) return;
    let cancelled = false;
    void (async () => {
      try {
        await seedEinsteinDemoOnce(store, userId);
      } catch {
        /* best-effort — the Projects page still works without the demo */
      } finally {
        if (!cancelled) setSeedReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seedReady, store, userId]);

  const onOpen = (projectId: string) => {
    navigate(`/p/${encodeURIComponent(projectId)}`);
  };
  // First-run only: render nothing for the one async tick the demo seed takes,
  // so the list's initial load already includes the Einstein card.
  if (!seedReady) return null;
  return (
    <LibraryApp
      store={store}
      userId={userId}
      onOpen={onOpen}
      onOpenSettings={() => navigate("/settings")}
      {...(authUser ? { user: authUser } : {})}
    />
  );
}
