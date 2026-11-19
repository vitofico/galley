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
import {
  LibraryApp,
  type LibraryServerCopies,
  type ServerCopyState,
} from "./components/LibraryApp.js";
import {
  deleteLocalProjectDb,
  eraseServerCopy,
  saveCopyPreference,
  migrateCopyPreference,
  keepRecoveredProjectLocal,
  isLocalOnly,
  listServerCopies,
  restoreServerCopy,
  serverCopyEnabled,
  setLocalOnly,
  uploadServerCopy,
  type ServerCopy,
} from "./server-copy.js";
import { configuredSyncUrlOverride, resolveSyncUrl } from "./share.js";
import { IdbProjectStore } from "./idb-project-store.js";
import { loadLocalProfile } from "./local-profile.js";
import { navigate, routeHref } from "./router.js";
import {
  hostedConnectorEnabled,
  listConnectedProjects,
  type ConnectedProject,
} from "./hosted-connector.js";
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

/**
 * Server copies for the library (ADR-0035). On a deployment that keeps them:
 * lists the account's copies, and brings the copy of every project this
 * browser holds up to date in the background, one at a time, so a project
 * needs no opening to be on the server. Undefined where copies are off, and
 * then nothing here touches the network.
 */
function useServerCopies(
  store: IdbProjectStore,
  userId: string,
): LibraryServerCopies | undefined {
  const enabled = useMemo(() => serverCopyEnabled(), []);
  const [copies, setCopies] = useState<ServerCopy[] | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, ServerCopyState>>(
    new Map(),
  );
  const [accountLocalOnly, setAccountLocalOnly] = useState<string[]>([]);
  const setState = (id: string, state: ServerCopyState) =>
    setStates((prev) => new Map(prev).set(id, state));
  const syncUrl = () =>
    resolveSyncUrl(configuredSyncUrlOverride(), window.location);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const [listed, held] = await Promise.all([
        listServerCopies(),
        store.listProjectsForUser(userId),
      ]);
      if (cancelled) return;
      // No answer: nothing is known to be on the server, and the cards say so.
      const onServer = listed.ok ? listed.copies : [];
      const accountPrefs = listed.ok ? listed.localOnly : [];
      if (listed.ok) {
        for (const project of held.filter((p) => isLocalOnly(p.id))) {
          if (await migrateCopyPreference(project.id)) {
            accountPrefs.push(project.id);
            const index = onServer.findIndex((c) => c.projectId === project.id);
            if (index !== -1) onServer.splice(index, 1);
          }
          if (cancelled) return;
        }
      }
      setAccountLocalOnly(accountPrefs);
      const copyOf = (id: string) => onServer.find((c) => c.projectId === id);
      // A project kept in this browser only is skipped, unless it is connected
      // to the hosted connector: that replica exists by the person's choice.
      const pending = listed.ok
        ? held.filter(
            (p) =>
              !isLocalOnly(p.id) &&
              (!accountPrefs.includes(p.id) || copyOf(p.id) !== undefined),
          )
        : [];
      setCopies(onServer);
      setStates(
        new Map(
          held.map((p) => [p.id, pending.includes(p) ? "uploading" : "local"]),
        ),
      );
      for (const p of pending) {
        const result = await uploadServerCopy(p, copyOf(p.id), syncUrl());
        if (cancelled) return;
        setState(
          p.id,
          result === "synced"
            ? "server"
            : result === "assets"
              ? "assets"
              : "local",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, store, userId]);

  if (!enabled) return undefined;
  return {
    copies,
    states,
    isLocalOnly: (id) => accountLocalOnly.includes(id) || isLocalOnly(id),
    setLocalOnly: async (project, localOnly) => {
      const saved = await saveCopyPreference(project.id, localOnly);
      if (!saved.ok) return saved.error;
      setAccountLocalOnly((prev) =>
        localOnly
          ? [...prev, project.id]
          : prev.filter((id) => id !== project.id),
      );
      try {
        setLocalOnly(project.id, false);
      } catch {
        /* A legacy browser flag can still keep this project local. */
      }
      if (localOnly) {
        setCopies((prev) =>
          prev === null ? prev : prev.filter((c) => c.projectId !== project.id),
        );
        setState(project.id, "local");
        return null;
      }
      setState(project.id, "uploading");
      const result = await uploadServerCopy(project, undefined, syncUrl());
      setState(
        project.id,
        result === "synced"
          ? "server"
          : result === "assets"
            ? "assets"
            : "local",
      );
      return result === "failed"
        ? "The server copy could not be written. It is retried when you open the project or this page."
        : null;
    },
    restore: async (copy) => {
      const held = copies?.find((c) => c.projectId === copy.projectId);
      if (held === undefined) return "This project is no longer on the server.";
      const result = await restoreServerCopy(held, syncUrl());
      if (result === "empty")
        return "The server has no text for this project yet. Open it once in the browser that holds it.";
      if (result === "failed")
        return "The server copy could not be fetched. Nothing was changed; try again.";
      try {
        await store.createProject({
          id: copy.projectId,
          name: copy.name ?? "Restored project",
          ownerId: userId,
        });
        await store.updateProject(copy.projectId, {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch {
        // The row survived under an earlier local identity: join it instead.
        await store.addMember(copy.projectId, userId, "owner");
      }
      return null;
    },
    erase: async (projectId) => {
      const erased = await eraseServerCopy(projectId);
      return erased.ok
        ? null
        : `The project was not deleted, because the server still holds it. ${erased.error}`;
    },
  };
}

export function LibraryRoot() {
  const store = useMemo(() => new IdbProjectStore(), []);
  const userId = useMemo(() => loadLocalProfile().userId, []);
  const serverCopies = useServerCopies(store, userId);
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

  // Hosted connector without server copies (ADR-0034): the person's connected
  // projects, so those this device does not hold can be opened from their
  // server copy. No request is made where the connector is off, nor where
  // server copies are on: there the list above covers them and restores them.
  const [connected, setConnected] = useState<ConnectedProject[]>([]);
  useEffect(() => {
    if (!hostedConnectorEnabled() || serverCopyEnabled()) return;
    let cancelled = false;
    void listConnectedProjects().then((listed) => {
      if (!cancelled && listed.ok) setConnected(listed.projects);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      recovery={{
        list: () => store.recoverableProjects(userId),
        recover: async (project) => {
          keepRecoveredProjectLocal(project.id);
          await store.addMember(project.id, userId, "owner");
        },
      }}
      onOpen={onOpen}
      onOpenSettings={() => navigate("/settings")}
      connected={connected}
      onOpenConnected={(id) => navigate(routeHref({ kind: "connected", id }))}
      {...(serverCopies ? { serverCopies } : {})}
      onDeleted={(id) => {
        deleteLocalProjectDb(id);
        try {
          setLocalOnly(id, false);
        } catch {
          /* a stale opt-out for a deleted project changes nothing */
        }
      }}
      {...(authUser ? { user: authUser } : {})}
    />
  );
}
