import { useEffect, useState } from "react";
import type { ConnectorReviewMode } from "@galley/shared";
import {
  connectProject,
  createConnectorToken,
  disconnectProject,
  listConnectedProjects,
  listConnectorActivity,
  listConnectorTokens,
  revokeConnectorToken,
  setConnectedProjectReviewMode,
  type ConnectedProject,
  type ConnectorChange,
  type ConnectorResult,
  type ConnectorToken,
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
  // Whether this server applies an Auto project's changes itself.
  const [applies, setApplies] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The project (or room) a request is in flight for: its buttons are disabled.
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    const listed = await listConnectedProjects();
    if (listed.ok) {
      setConnected(listed.projects);
      setApplies(listed.appliesChanges);
    } else setError(listed.error);
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
      name: `${c.name ?? c.projectId} (not on this device)`,
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
      <p className="settings-note">
        An AI client can <strong>read</strong> a connected project and{" "}
        <strong>change</strong> it. How a change lands is set per project.{" "}
        <strong>Ask</strong>: it waits for you to accept or reject it, the next
        time you open the project in Galley. <strong>Auto</strong>: the server
        applies it with nobody watching.
      </p>
      <p className="settings-note" data-testid="hosted-connector-status-note">
        {applies ? (
          <>
            Before each Auto change the server saves a checkpoint of the whole
            project and records the change, so it can be{" "}
            <strong>undone, not prevented</strong>: the checkpoint appears in
            that project&apos;s History, and the record under the project
            below.
          </>
        ) : (
          <>
            <strong>This server is not set up to apply changes itself</strong>,
            so a project set to Auto is treated like one set to Ask: every
            change waits for you.
          </>
        )}
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
                    onClick={() =>
                      void run(p.id, () => connectProject(p.id, p.name))
                    }
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
                {grant !== undefined && applies && (
                  <ConnectorActivity roomId={grant.roomId} name={p.name} />
                )}
              </div>
            );
          })}
      </div>
      <p className="settings-note">
        Disconnecting ends the connector&apos;s access to that project and
        erases its server copy, with any checkpoints and the record of
        changes, within a minute. The project on this device is not touched.
      </p>
      <ConnectorTokens />
    </>
  );
}

const CHANGE_STATES: Record<ConnectorChange["state"], string> = {
  applied: "applied",
  unconfirmed: "applied, but not confirmed",
  started: "interrupted",
  conflict: "not applied: the text had changed",
  failed: "failed",
};

/** What the connector applied to one project on its own, loaded when opened. */
function ConnectorActivity({ roomId, name }: { roomId: string; name: string }) {
  const [changes, setChanges] = useState<ConnectorChange[] | null>(null);
  const [tokenNames, setTokenNames] = useState(new Map<string, string>());
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [activity, tokens] = await Promise.all([
      listConnectorActivity(roomId),
      listConnectorTokens(),
    ]);
    if (!activity.ok) return setError(activity.error);
    setError(null);
    setChanges(activity.changes);
    if (tokens.ok)
      setTokenNames(new Map(tokens.tokens.map((t) => [t.tokenId, t.name])));
  };

  return (
    <details
      className="settings-note"
      data-testid="hosted-connector-activity"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary>Changes the connector applied to {name}</summary>
      {error !== null && <p role="alert">{error}</p>}
      {changes !== null && changes.length === 0 && (
        <p>Nothing yet. A change applied in Auto mode is listed here.</p>
      )}
      {changes !== null && changes.length > 0 && (
        <ul>
          {changes.map((c) => (
            <li key={c.changeId} data-state={c.state}>
              {new Date(c.atMs).toLocaleString()}: “{c.request}” (
              {c.files.length === 1 ? c.files[0] : `${c.files.length} files`},{" "}
              {CHANGE_STATES[c.state]}), asked by{" "}
              {tokenNames.get(c.tokenId) ?? "a token that no longer exists"}.{" "}
              {c.state === "conflict"
                ? ""
                : c.restorable
                  ? "To undo it, open the project and restore its checkpoint from History."
                  : "Its checkpoint is no longer kept."}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** The lifetimes the server accepts, default first. */
const LIFETIMES = [
  { days: 90, label: "90 days" },
  { days: 30, label: "30 days" },
  { days: 365, label: "1 year" },
];

/**
 * Access tokens (ADR-0033 §3): one per client. A token reaches every project
 * connected above, so the wording treats it as what it is, a password. It is
 * shown once, here, and never again: the server keeps only its fingerprint.
 */
function ConnectorTokens() {
  const [tokens, setTokens] = useState<ConnectorToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState(LIFETIMES[0]!.days);
  // The secret of the token just created. Lives only in this component.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "address" | null>(null);
  // The connector answers on this site, at /mcp.
  const endpoint = `${window.location.origin}/mcp`;

  const refresh = async () => {
    const listed = await listConnectorTokens();
    if (listed.ok) setTokens(listed.tokens);
    else setError(listed.error);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const run = async (action: () => Promise<ConnectorResult>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.error);
    await refresh();
    setBusy(false);
  };

  const create = async () => {
    setSecret(null);
    setCopied(null);
    setBusy(true);
    setError(null);
    const result = await createConnectorToken(name.trim(), days);
    if (result.ok) {
      setSecret(result.secret);
      setName("");
    } else setError(result.error);
    await refresh();
    setBusy(false);
  };

  const copy = async (what: "token" | "address") => {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(
        what === "token" ? secret : `${endpoint}/${secret}`,
      );
      setCopied(what);
    } catch {
      // Clipboard can be blocked; the token stays selectable in the field.
    }
  };

  return (
    <>
      <p className="settings-note">
        <strong>Access tokens.</strong> A token lets one AI client act as you on{" "}
        <strong>every project connected above</strong>, and on nothing else.
        Create one per client, so each can be revoked on its own. Treat it like
        a password: anyone holding it can read those projects, and change them
        where a project is set to Auto.
      </p>
      <p className="settings-note" data-testid="connector-endpoint">
        The connector's address is <code>{endpoint}</code>. A client that can
        send a header uses that address with <code>Authorization: Bearer</code>{" "}
        and the token. A chat app that only takes an address gets the token
        inside it; that form is offered once, when you create a token.
      </p>
      {error !== null && (
        <p
          className="settings-note"
          role="alert"
          data-testid="connector-token-error"
        >
          {error}
        </p>
      )}
      <div data-testid="connector-tokens">
        {(tokens ?? []).map((t) => (
          <div
            className="settings-identity-row"
            key={t.tokenId}
            data-token-id={t.tokenId}
          >
            <input
              type="text"
              readOnly
              aria-label="Token name"
              value={`${t.name} (expires ${new Date(t.expiresAtMs).toLocaleDateString()})`}
            />
            <button
              type="button"
              className="settings-back"
              data-testid="connector-token-revoke"
              disabled={busy}
              onClick={() => void run(() => revokeConnectorToken(t.tokenId))}
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
      <div className="settings-identity-row">
        <input
          type="text"
          aria-label="New token name"
          data-testid="connector-token-name"
          placeholder="Which client is it for? (e.g. Claude chat)"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <select
          aria-label="Token lifetime"
          data-testid="connector-token-lifetime"
          value={days}
          onChange={(e) => setDays(Number(e.currentTarget.value))}
        >
          {LIFETIMES.map((l) => (
            <option key={l.days} value={l.days}>
              {l.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-primary"
          data-testid="connector-token-create"
          disabled={busy || name.trim().length === 0}
          onClick={() => void create()}
        >
          Create token
        </button>
      </div>
      {secret !== null && (
        <>
          <div
            className="settings-saved-note"
            role="status"
            data-testid="connector-token-created"
          >
            Copy this token now. It is shown only this once: Galley keeps a
            fingerprint of it, not the token, and cannot show it again.
          </div>
          <div className="settings-identity-row">
            <input
              type="text"
              readOnly
              autoComplete="off"
              aria-label="New access token"
              data-testid="connector-token-secret"
              value={secret}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="settings-primary"
              data-testid="connector-token-copy"
              onClick={() => void copy("token")}
            >
              {copied === "token" ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="settings-note">
            For a chat app that only takes an address, paste this one instead.
            It contains the token, so treat the whole address as the password.
          </p>
          <div className="settings-identity-row">
            <input
              type="text"
              readOnly
              autoComplete="off"
              aria-label="Connector address with the token"
              data-testid="connector-token-address"
              value={`${endpoint}/${secret}`}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="settings-primary"
              data-testid="connector-token-address-copy"
              onClick={() => void copy("address")}
            >
              {copied === "address" ? "Copied" : "Copy"}
            </button>
          </div>
        </>
      )}
    </>
  );
}
