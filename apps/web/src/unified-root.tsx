/**
 * `UnifiedRoot` — the default persistent-project boot (roadmap #14, the
 * activation epic), now mounted by the router (#19.4) for both `/` (the
 * persisted default project) and `/p/<id>` (a specific project, opened from
 * the library).
 *
 * Promotes a **local-first, persistent, multi-file project** to a first-class
 * boot experience by reusing the whole `ProjectApp` shell with a STABLE
 * per-project id (so a reload restores the same project from IndexedDB) and
 * registering that project in the local `IdbProjectStore` registry (so the
 * library — #12 — can list it). Retrieval auto-engages in the agent past the
 * size threshold (ProjectApp passes a `context` to its `AgentPanel`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { SeedFile } from "@galley/collab";
import { ProjectApp } from "./ProjectApp.js";
import { readCollabConfig, type CollabConfig } from "./collab-session.js";
import { loadLocalProfile } from "./local-profile.js";
import { IdbProjectStore } from "./idb-project-store.js";
import { navigate } from "./router.js";
import { takePendingSeed } from "./pending-seed.js";
import { takeDurableSeed } from "./durable-seed.js";
import { randomProjectName } from "./random-project-name.js";
import {
  BLANK_STARTER_FILES,
  BLANK_STARTER_MAIN,
  SAMPLE_PROJECT_FILES,
  SAMPLE_PROJECT_MAIN,
  SAMPLE_PROJECT_NAME,
} from "./project-sample.js";
import { LOWRY_FILES, LOWRY_MAIN, LOWRY_NAME } from "./demo/lowry-1951.js";

// The home-route project-id resolution lives in a pure module so the F13 app-root
// background host can import `fastProjectId` without pulling this React tree into a
// chunk. Re-exported here so existing `unified-root` importers are unchanged.
export { UNIFIED_PROJECT_KEY, fastProjectId } from "./unified-project-id.js";
import { UNIFIED_PROJECT_KEY, fastProjectId } from "./unified-project-id.js";

/** A `proj-…` id, minted like the store's default generator. */
function mintProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `proj-${token}`;
}


/** Recency key for "most-recent project": last-opened, else updated, else created. */
function projectRecency(p: {
  lastOpenedAt?: number;
  updatedAt?: number;
  createdAt?: number;
}): number {
  return p.lastOpenedAt ?? p.updatedAt ?? p.createdAt ?? 0;
}

/** Persist the resolved default id (best-effort; a no-op when storage is blocked). */
function persistUnifiedId(id: string): void {
  try {
    localStorage.setItem(UNIFIED_PROJECT_KEY, id);
  } catch {
    /* best-effort */
  }
}

/** The resolved first-boot seed for this project (project-model redesign §2). */
interface ResolvedSeed {
  files: SeedFile[];
  mainPath: string;
  demoHistory: boolean;
  /** Name to register on first run (a fresh registry row). */
  name: string;
}

/**
 * Resolve the seed for THIS boot (project-model redesign §2): a pending seed
 * (from `createProject`) wins; else the `?seed=einstein` boot hatch (the demo
 * workspace + 1905 history — used by the showcase/e2e); else the blank starter
 * with a friendly random name. The session's `seedIfPristine` is the single
 * writer either way, so a reload / existing project (non-pristine doc) ignores
 * this seed.
 */
function resolveBootSeed(projectId: string): ResolvedSeed {
  const pending = takePendingSeed(projectId);
  if (pending) {
    return {
      files: pending.files,
      mainPath: pending.mainPath,
      demoHistory: pending.demoHistory,
      name: pending.name,
    };
  }
  // A DURABLE seed (the one-time Einstein demo created on the Projects page,
  // opened later / across a reload) is consumed here before the `?seed=` hatch.
  // Content is reconstructed from the persisted `kind`; `seedIfPristine` stays
  // the single writer, so a reopened (non-pristine) project ignores this.
  const durable = takeDurableSeed(projectId);
  if (durable) {
    if (durable.kind === "einstein") {
      return {
        files: SAMPLE_PROJECT_FILES,
        mainPath: SAMPLE_PROJECT_MAIN,
        demoHistory: true,
        name: durable.name,
      };
    }
    if (durable.kind === "lowry") {
      return {
        files: LOWRY_FILES,
        mainPath: LOWRY_MAIN,
        demoHistory: false,
        name: durable.name,
      };
    }
    return {
      files: BLANK_STARTER_FILES,
      mainPath: BLANK_STARTER_MAIN,
      demoHistory: false,
      name: durable.name,
    };
  }
  const seedParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("seed")
      : null;
  if (seedParam === "einstein") {
    return {
      files: SAMPLE_PROJECT_FILES,
      mainPath: SAMPLE_PROJECT_MAIN,
      demoHistory: true,
      name: SAMPLE_PROJECT_NAME,
    };
  }
  if (seedParam === "lowry") {
    return {
      files: LOWRY_FILES,
      mainPath: LOWRY_MAIN,
      demoHistory: false,
      name: LOWRY_NAME,
    };
  }
  return {
    files: BLANK_STARTER_FILES,
    mainPath: BLANK_STARTER_MAIN,
    demoHistory: false,
    name: randomProjectName(),
  };
}

/**
 * Resolve the default project id. Synchronous when an explicit id or a persisted
 * localStorage id exists (the normal path — no async, no render flash). Else
 * query the IndexedDB registry ONCE and reopen the most-recently-touched
 * project; only mint a brand-new one when the registry is genuinely empty.
 * Because the registry persists even when localStorage does not, a reload (or a
 * blocked-storage browser) returns to the same project instead of spawning a new
 * one each time. Returns `null` while the one-shot async lookup is in flight.
 */
function useResolvedProjectId(explicitId: string | undefined): string | null {
  const sync = useMemo(() => fastProjectId(explicitId), [explicitId]);
  const [resolved, setResolved] = useState<string | null>(sync);
  const startedRef = useRef(false);
  useEffect(() => {
    if (resolved !== null || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      let id: string | null = null;
      // An explicit `?seed=` (the einstein demo / e2e hatch) means "give me a
      // fresh seeded project", so skip the reopen-most-recent fallback and mint.
      let wantsFreshSeed = false;
      try {
        wantsFreshSeed = new URLSearchParams(window.location.search).has("seed");
      } catch {
        /* no window.location */
      }
      if (!wantsFreshSeed) {
        try {
          const store = new IdbProjectStore();
          const profile = loadLocalProfile();
          const projects = (await store.listProjectsForUser(profile.userId)).filter(
            (p) => p.archived !== true,
          );
          if (projects.length > 0) {
            id = [...projects].sort((a, b) => projectRecency(b) - projectRecency(a))[0]!.id;
          }
        } catch {
          /* registry unavailable → fall through to minting a fresh project */
        }
      }
      if (cancelled) return;
      const finalId = id ?? mintProjectId();
      persistUnifiedId(finalId);
      setResolved(finalId);
    })();
    return () => {
      cancelled = true;
    };
  }, [resolved]);
  return resolved;
}

export function UnifiedRoot({ projectId: explicitId }: { projectId?: string } = {}) {
  const projectId = useResolvedProjectId(explicitId);
  // Render nothing while the registry is queried — a brief, invisible step on the
  // cold / blocked-storage path only; the normal (localStorage-present) path
  // resolves synchronously, so there is no flash and boot is unchanged.
  if (projectId === null) return null;
  // Keyed by id so the registry fallback resolving to a project remounts cleanly.
  return <UnifiedProject key={projectId} projectId={projectId} />;
}

function UnifiedProject({ projectId }: { projectId: string }) {
  // Resolve+consume the boot seed ONCE, alongside the id (consume-once map, so it
  // must not run twice under StrictMode). The session reads these as defaults.
  const seedRef = useRef<ResolvedSeed | undefined>(undefined);
  if (seedRef.current === undefined) seedRef.current = resolveBootSeed(projectId);
  const seed = seedRef.current;

  const [projectName, setProjectName] = useState<string | undefined>(undefined);

  // A persistent LOCAL project: project mode on, keyed by the stable id; no sync
  // (collaboration stays an explicit Share/Connect action, never default-on).
  const config: CollabConfig = { ...readCollabConfig(), project: true, room: projectId };

  // Register the project in the local registry (idempotent) so the library can
  // list it, and surface its name in the header. Fire-and-forget; a registry
  // failure must never block the editor. A FIRST-RUN project (no registry row)
  // is registered with the resolved seed's name (a friendly random name, the
  // Einstein title, or the create path's chosen name) — never "Untitled project".
  useEffect(() => {
    const profile = loadLocalProfile();
    const store = new IdbProjectStore();
    void (async () => {
      try {
        const existing = await store.getProject(projectId);
        if (!existing) {
          await store.createProject({ id: projectId, name: seed.name, ownerId: profile.userId });
          setProjectName(seed.name);
        } else {
          setProjectName(existing.name);
        }
      } catch {
        /* registry is best-effort */
      }
    })();
  }, [projectId, seed.name]);

  // Commit a rename (project-model redesign §5): persist to the registry and
  // reflect it in the header immediately. Best-effort — a write failure leaves
  // the prior name (the optimistic state update is only applied after success).
  const onRenameProject = (name: string) => {
    const store = new IdbProjectStore();
    void (async () => {
      try {
        await store.updateProject(projectId, { name });
        setProjectName(name);
      } catch {
        /* registry is best-effort */
      }
    })();
  };

  return (
    <ProjectApp
      config={config}
      {...(projectName !== undefined ? { projectName } : {})}
      initialFiles={seed.files}
      mainPath={seed.mainPath}
      demoHistory={seed.demoHistory}
      onRenameProject={onRenameProject}
      onOpenLibrary={() => navigate("/library")}
    />
  );
}
