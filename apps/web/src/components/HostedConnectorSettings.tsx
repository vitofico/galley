import { useEffect, useState } from "react";
import type { ConnectorReviewMode } from "@galley/shared";
import {
  connectProject,
  disconnectProject,
  listConnectedProjects,
  setConnectedProjectReviewMode,
  type ConnectedProject,
  type ConnectorResult,
} from "../hosted-connector.js";
import { IdbProjectStore } from "../idb-project-store.js";
import { loadLocalProfile } from "../local-profile.js";

/**
 * "Hosted connector" settings (ADR-0033 §1, §3) — where a person connects a
 * project, chooses how changes reach it, and disconnects it. Rendered only on
 * a deployment whose operator enabled the connector.
 *
 * This is the consent surface for the one thing local mode never does: keeping
 * a copy of a document on the server. The wording says so before the button
 * (invariant 7), and Disconnect says what happens to that copy.
 */
export function HostedConnectorSettings() {
  const [local, setLocal] = useState<{ id: string; name: string }[]>([]);
  const [connected, setConnected] = useState<ConnectedProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The project (or room) a request is in flight for: its buttons are disabled.
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const listed = await listConnectedProjects();
    if (listed.ok) setConnected(listed.projects);
    else setError(listed.error);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await new IdbProjectStore().listProjectsForUser(
          loadLocalProfile().userId,
        );
        if (!cancelled) setLocal(rows.map((p) => ({ id: p.id, name: p.name })));
      } catch {
        // No local list: connected projects still show, by id, so they can
        // always be disconnected.
      }
    })();
    void refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (key: string, action: () => Promise<ConnectorResult>) => {
    setBusy(key);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error);
    await refresh();
    setBusy(null);
  };

  const byProject = new Map((connected ?? []).map((c) => [c.projectId, c]));
  // A project connected from another browser, or deleted here since: it still
  // has a server copy, so it must stay visible and disconnectable.
  const elsewhere = (connected ?? []).filter(
    (c) => !local.some((p) => p.id === c.projectId),
  );
  const rows = [
    ...local,
    ...elsewhere.map((c) => ({
      id: c.projectId,
      name: `${c.projectId} (not on this device)`,
    })),
  ];

  return (
    <>
      <p className="settings-card-lead">
        Reach a project from an AI chat client at an address on this server,
        with <strong>no Galley tab open</strong>. Connecting a project{" "}
        <strong>keeps a copy of it on this server</strong>, readable by whoever
        runs the server, until you disconnect it. The copy is brought up to date
        whenever the project is open in Galley, so open it once after
        connecting. It is <strong>off for every project</strong> until you
        connect one here.
      </p>
      <p className="settings-note" data-testid="hosted-connector-status-note">
        This release keeps the server copy only. The address an AI client
        connects to, and its access tokens, arrive in a following release.
      </p>
      <p className="settings-note">
        <strong>Ask</strong>: a change from the connector waits for you to
        accept it in Galley. <strong>Auto</strong>: the server applies it with
        nobody watching. Each change is saved as a version first and recorded,
        so it can be undone, not prevented.
      </p>
      {error !== null && (
        <p
          className="settings-note"
          role="alert"
          data-testid="hosted-connector-error"
        >
          {error}
        </p>
      )}
      <div data-testid="hosted-connector-projects">
        {connected !== null &&
          rows.map((p) => {
            const grant = byProject.get(p.id);
            return (
              <div
                className="settings-identity-row"
                key={p.id}
                data-project-id={p.id}
              >
                <input
                  type="text"
                  readOnly
                  aria-label="Project name"
                  value={p.name}
                />
                {grant === undefined ? (
                  <button
                    type="button"
                    className="settings-primary"
                    data-testid="hosted-connector-connect"
                    data-project-id={p.id}
                    disabled={busy !== null}
                    onClick={() => void run(p.id, () => connectProject(p.id))}
                  >
                    Connect
                  </button>
                ) : (
                  <>
                    <select
                      aria-label={`How changes reach ${p.name}`}
                      data-testid="hosted-connector-mode"
                      data-project-id={p.id}
                      value={grant.reviewMode}
                      disabled={busy !== null}
                      onChange={(e) =>
                        void run(p.id, () =>
                          setConnectedProjectReviewMode(
                            grant.roomId,
                            e.currentTarget.value as ConnectorReviewMode,
                          ),
                        )
                      }
                    >
                      <option value="ask">Ask</option>
                      <option value="auto">Auto</option>
                    </select>
                    <button
                      type="button"
                      className="settings-back"
                      data-testid="hosted-connector-disconnect"
                      data-project-id={p.id}
                      disabled={busy !== null}
                      onClick={() =>
                        void run(p.id, () => disconnectProject(grant.roomId))
                      }
                    >
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            );
          })}
      </div>
      <p className="settings-note">
        Disconnecting ends the connector&apos;s access to that project and
        erases its server copy within a minute. The project on this device is
        not touched.
      </p>
    </>
  );
}
