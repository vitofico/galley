/**
 * `ConnectedRoot` — the `/c/<project id>` entry (ADR-0034): open one of your
 * connected projects on a device that does not hold it.
 *
 * The address names the project, never its room. The room id is looked up
 * behind sign-in, handed to the project shell in memory, and the shell joins
 * it on the path a Share guest takes: a joined session, where an AI client's
 * proposal always waits for a hand. A device that does hold the project is
 * sent to `/p/<id>` instead.
 */
import { useEffect, useState } from "react";
import { ProjectApp } from "./ProjectApp.js";
import { BrandLoading } from "./components/BrandLoading.js";
import {
  resolveConnectedEntry,
  type ConnectedEntry,
} from "./hosted-connector.js";
import { IdbProjectStore } from "./idb-project-store.js";
import { navigate, routeHref } from "./router.js";
import { configuredSyncUrlOverride, resolveSyncUrl } from "./share.js";
import "./theme.css";
import "./components/join-prompt.css";

export function ConnectedRoot({ projectId }: { projectId: string }) {
  const [entry, setEntry] = useState<ConnectedEntry | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let heldHere = false;
      try {
        heldHere = (await new IdbProjectStore().getProject(projectId)) !== null;
      } catch {
        /* no local registry: this device holds nothing */
      }
      const resolved = await resolveConnectedEntry(projectId, heldHere);
      if (cancelled) return;
      if (resolved.kind === "local")
        navigate(routeHref({ kind: "project", id: projectId }), {
          replace: true,
        });
      else setEntry(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  if (entry === null || entry.kind === "local") return <BrandLoading />;

  if (entry.kind === "open") {
    return (
      <ProjectApp
        config={{
          enabled: true,
          project: true,
          syncUrl: resolveSyncUrl(configuredSyncUrlOverride(), window.location),
          room: entry.project.roomId,
          role: "editor",
          connectedProjectId: projectId,
        }}
        projectName={entry.project.name ?? "Connected project"}
        onOpenLibrary={() => navigate("/library")}
      />
    );
  }

  return (
    <div className="join-shell">
      <div className="join-prompt" data-testid="connected-unavailable">
        <h1 className="join-prompt-title">
          This project can&apos;t be opened here
        </h1>
        <p className="join-prompt-hint">{entry.message}</p>
        <div className="join-prompt-actions">
          {entry.retry && (
            <button
              type="button"
              className="join-prompt-join"
              onClick={() => {
                setEntry(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
          <button
            type="button"
            className={entry.retry ? "join-prompt-skip" : "join-prompt-join"}
            data-testid="connected-to-library"
            onClick={() => navigate("/library")}
          >
            Your projects
          </button>
        </div>
      </div>
    </div>
  );
}
