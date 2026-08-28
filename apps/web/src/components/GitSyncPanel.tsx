import { useCallback, useEffect, useState } from "react";
import { loadRedactedConfig, type ConfigStorage } from "../git-remote-config.js";
import { loadRedactedGithubConnection } from "../github-connect.js";
import { loadRepoTarget } from "../github-repo-target.js";
import {
  loadSyncDestination,
  saveSyncDestination,
  clearSyncDestination,
  deriveSyncDestinationKind,
  type SyncDestinationKind,
} from "../sync-destination.js";
import { DestinationChooser } from "./DestinationChooser.js";
import { GithubDestination } from "./GithubDestination.js";
import { GenericGitDestination } from "./GenericGitDestination.js";
import { ConfiguredDestination, type ConfiguredSummary } from "./ConfiguredDestination.js";
import "./authoring-panels.css";
import "./git-sync-panel.css";

/**
 * Git-sync UI — unified, DESTINATION-FIRST redesign (2026-06-18 spec). One panel,
 * one question: *where does this project sync?* — then one coherent surface per
 * state. The transport split (GitHub REST snapshot vs generic smart-HTTP) is
 * invisible plumbing: Push and Fetch BOTH go through the host's injected
 * `onPush`/`onFetch`, which dispatch by the project's destination KIND.
 *
 * This shell is a thin router over four child components:
 *  - {@link DestinationChooser} — unconfigured: pick GitHub / Other git host.
 *  - {@link GithubDestination} — inline connect + repo picker (kind "github").
 *  - {@link GenericGitDestination} — URL / branch / token form (kind "git").
 *  - {@link ConfiguredDestination} — the steady-state card + Push / Fetch / Change.
 *
 * The KIND marker (`sync-destination.ts`) is the load-order authority: read it →
 * render that destination; absent → chooser. An existing project that predates
 * the marker is migrated ONCE on open (derive from the underlying stores, then
 * persist), so subsequent opens are unambiguous.
 *
 * ## Security posture (this lane gets a security review)
 *  - Every token input is WRITE-ONLY (password field, never seeded from storage,
 *    cleared after each attempt); the children render only redacted views
 *    (`hasToken` / `login`), never a secret. See the child components.
 *  - All credentials live in THIS browser only; every git / REST request goes
 *    browser → remote directly, never to a Galley server. The configured card
 *    states this.
 *  - Fetch returns a CANDIDATE only — the host routes it through the existing
 *    Accept-gated compare/restore path; this panel never auto-applies.
 *  - Switch hygiene: committing a destination clears the OTHER kind's per-project
 *    secret store (handled in the child that commits it). The device GitHub
 *    connection is account-scoped and never cleared by a per-project switch.
 *
 * PRESENTATIONAL + CONTROLLED: the shell owns only the routing state and the
 * transient status line. The actual network ops are the host's injected
 * `onPush`/`onFetch`.
 */

// The outcome types live in `git-sync-types.ts` (one canonical home shared by the
// ops layer and this panel); imported for the prop types, re-exported for back-compat.
import type { GitSyncPushOutcome, GitSyncFetchOutcome } from "../git-sync-types.js";
export type { GitSyncPushOutcome, GitSyncFetchOutcome } from "../git-sync-types.js";

export interface GitSyncPanelProps {
  open: boolean;
  onClose: () => void;
  /** The project whose destination is loaded/saved (one destination per project). */
  projectId: string;
  /**
   * Push the project's materialized tree to the configured destination. The host
   * dispatches by destination kind (GitHub REST snapshot or generic smart-HTTP)
   * and returns an already-redacted outcome.
   */
  onPush: () => Promise<GitSyncPushOutcome>;
  /**
   * Fetch the configured destination as an import CANDIDATE and route it through
   * the host's Accept-gated compare/restore path (never auto-applied). The host
   * dispatches by kind; returns an already-redacted outcome.
   */
  onFetch: () => Promise<GitSyncFetchOutcome>;
  /** Injectable storage (defaults to localStorage) — tests pass an in-memory map. */
  storage?: ConfigStorage | null;
  /**
   * Rail & Islands (#19.2): when true the panel renders as a DOCKED card (no
   * fixed backdrop, no modal dialog semantics) inside the shell's dock host.
   */
  docked?: boolean;
}

/** What the shell is rendering: a chooser, one of the two sub-flows, or the card. */
type Route = "chooser" | "configure-github" | "configure-git" | "configured";

export function GitSyncPanel({
  open,
  onClose,
  projectId,
  onPush,
  onFetch,
  storage,
  docked,
}: GitSyncPanelProps) {
  const [route, setRoute] = useState<Route>("chooser");
  const [summary, setSummary] = useState<ConfiguredSummary | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  // Build the configured-card summary for a committed kind, reading only redacted
  // views. Returns null if the underlying store is somehow empty (treat as
  // unconfigured → chooser).
  const buildSummary = useCallback(
    (kind: SyncDestinationKind): ConfiguredSummary | null => {
      if (kind === "github") {
        const target = loadRepoTarget(projectId);
        if (!target) return null;
        const conn = loadRedactedGithubConnection();
        return {
          kind: "github",
          primary: `${target.owner}/${target.name}`,
          branch: target.branch,
          ...(conn ? { identity: conn.login } : {}),
        };
      }
      const cfg = loadRedactedConfig(projectId, storage);
      if (!cfg?.url) return null;
      return { kind: "git", primary: cfg.url, branch: cfg.ref ?? "main" };
    },
    [projectId, storage],
  );

  // Resolve the route from the kind marker — the load-order authority. Migrate a
  // pre-marker project ONCE (derive from the underlying stores, persist), then
  // render. Used on open and after a child saves/changes.
  const resolveRoute = useCallback(() => {
    let kind = loadSyncDestination(projectId);
    if (kind === null) {
      const derived = deriveSyncDestinationKind({
        hasGithubRepoTarget: !!loadRepoTarget(projectId),
        hasGitRemote: !!loadRedactedConfig(projectId, storage)?.url,
      });
      if (derived) {
        saveSyncDestination(projectId, derived);
        kind = derived;
      }
    }
    if (kind === null) {
      setSummary(null);
      setRoute("chooser");
      return;
    }
    const s = buildSummary(kind);
    if (!s) {
      // Marker present but the store is empty (e.g. cleared elsewhere) — fall
      // back to the chooser rather than render a broken card.
      setSummary(null);
      setRoute("chooser");
      return;
    }
    setSummary(s);
    setRoute("configured");
  }, [projectId, storage, buildSummary]);

  // (Re)resolve whenever the panel opens or the project changes.
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    resolveRoute();
  }, [open, projectId, resolveRoute]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // A child committed a destination → re-resolve to the configured card.
  const onChildSaved = () => resolveRoute();

  // "Change" from the card → clear the kind marker (keep the credentials so the
  // user can re-pick without re-entering) and show the chooser.
  const onChange = () => {
    clearSyncDestination(projectId);
    setStatus(null);
    setSummary(null);
    setRoute("chooser");
  };

  // "← Back" from a sub-flow → return to the chooser without committing.
  const onBack = () => {
    setStatus(null);
    setRoute("chooser");
  };

  const body = (() => {
    switch (route) {
      case "configure-github":
        return (
          <GithubDestination
            projectId={projectId}
            storage={storage}
            onSaved={onChildSaved}
            onBack={onBack}
            setStatus={setStatus}
          />
        );
      case "configure-git":
        return (
          <GenericGitDestination
            projectId={projectId}
            storage={storage}
            onSaved={onChildSaved}
            onBack={onBack}
            setStatus={setStatus}
          />
        );
      case "configured":
        return summary ? (
          <ConfiguredDestination
            summary={summary}
            onPush={onPush}
            onFetch={onFetch}
            onChange={onChange}
            setStatus={setStatus}
          />
        ) : null;
      case "chooser":
      default:
        return (
          <DestinationChooser
            onChoose={(kind) =>
              setRoute(kind === "github" ? "configure-github" : "configure-git")
            }
          />
        );
    }
  })();

  const panel = (
    <div
      className={`authoring-panel${docked ? " authoring-panel--docked" : ""}`}
      data-testid="git-sync-panel"
      onClick={(e) => e.stopPropagation()}
    >
      <header className="authoring-header">
        <h2 className="authoring-title">Git sync</h2>
        <button type="button" className="authoring-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="authoring-body">
        {body}

        {status && (
          <div
            className="authoring-status git-sync-status"
            data-testid="git-sync-status"
            data-ok={status.ok ? "true" : "false"}
            role="status"
          >
            {status.text}
          </div>
        )}
      </div>
    </div>
  );

  if (docked) return panel;
  return (
    <div
      className="authoring-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Git sync"
      onClick={onClose}
    >
      {panel}
    </div>
  );
}
