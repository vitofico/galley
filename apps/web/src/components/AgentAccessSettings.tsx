import { useEffect, useState } from "react";
import {
  getControlResponderManager,
  type ControlResponderMountState,
} from "../control-responder-mount.js";
import {
  grantContentAccess,
  isContentGranted,
  revokeContentAccess,
  type ConsentStoreLike,
} from "../agent-content-consent.js";
import { IdbProjectStore } from "../idb-project-store.js";
import { loadLocalProfile } from "../local-profile.js";
import type { ProposalGrant } from "../proposal-grant.js";

/**
 * "Agent Access" settings (roadmap #16.3 responder-mount slice, ADR-0021; #1
 * slice 1 adds per-project file-access consent) — the pairing/consent surface
 * for the browser-side control responder. It starts OFF; NOTHING is minted,
 * joined, read, or answered until the user clicks Enable.
 *
 * Enable → the browser mints a session-scoped control room + relay URL and starts
 * the responder, then shows a copyable `galley-mcp …` pairing command the user
 * pastes into their local MCP kernel. Revoke → tears the responder down, clears
 * the session capability AND every file-access grant, and the next Enable mints
 * a FRESH room with ZERO grants.
 *
 * FILE ACCESS (#1 slice 1): pairing alone is metadata-only. Each project gets an
 * explicit per-project toggle here — "Allow file access (this session)" — and
 * only a granted project answers the read-only file tools (search_project /
 * list_files / read_file) over the control mailbox. Settings IS the deliberate
 * consent surface: granting is a human click on this page, never an agent
 * request, and grants die with the session.
 */
export function AgentAccessSettings() {
  const manager = getControlResponderManager();
  const [state, setState] = useState<ControlResponderMountState>(() => manager.getState());
  const [copied, setCopied] = useState(false);
  // The pairing command is a bearer secret → masked by default (shoulder-surf
  // resistance), but revealable so the user can read/verify/manually copy it if
  // the clipboard write is blocked.
  const [revealed, setRevealed] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  // Bumped after every grant/revoke so the rows re-read the consent store.
  const [grantsVersion, setGrantsVersion] = useState(0);
  // F13: mirror the active grant (its projectId + persistentAccess) so the
  // Background-agent toggle/indicator reflect recordGrant / setGrantPersistentAccess
  // / the async resume / Revoke.
  const [activeGrant, setActiveGrant] = useState<ProposalGrant | null>(() => manager.getActiveGrant());

  useEffect(
    () =>
      manager.subscribe(() => {
        setState(manager.getState());
        setActiveGrant(manager.getActiveGrant());
      }),
    [manager],
  );

  // Load the local project list (names + ids only) while access is enabled —
  // it feeds the per-project file-access toggles. Disabled → no store touched.
  useEffect(() => {
    if (!state.enabled) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const userId = loadLocalProfile().userId;
        const rows = await new IdbProjectStore().listProjectsForUser(userId);
        if (!cancelled) setProjects(rows.map((p) => ({ id: p.id, name: p.name })));
      } catch {
        if (!cancelled) setProjects([]); // fail-soft: no list, no toggles, no grants
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.enabled]);

  const copyPairing = async () => {
    if (state.pairingCommand === null) return;
    try {
      await navigator.clipboard.writeText(state.pairingCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the command stays selectable in the field.
    }
  };

  const store = consentStore();
  const bump = () => setGrantsVersion((v) => v + 1);
  void grantsVersion; // the state exists purely to re-render after grant/revoke

  return (
    <>
      <p className="settings-card-lead">
        Let a local AI agent (via the Galley MCP kernel) see your project library — names and
        named versions, <strong>metadata only</strong>. Reading a project&apos;s <strong>files</strong>{" "}
        requires a separate per-project grant below; opening a project for live editing requires
        your <strong>explicit per-request approval</strong>. It is <strong>off by default</strong>,
        scoped to this browser tab, and revocable. Nothing is shared until you enable it and paste
        the pairing command into your own kernel.
      </p>

      {!state.enabled ? (
        <>
          {/* #1 slice 2: an auth-on enable() registers the control room with the
              server BEFORE pairing. Surface that wait (button disabled) and any
              failure (cap hit / signed out / unreachable) right here. Auth-off
              runs never set either field, so this renders exactly as before. */}
          {state.error !== null && (
            <p className="settings-note" role="alert" data-testid="agent-access-error">
              {state.error}
            </p>
          )}
          <div className="settings-identity-row">
            <button
              type="button"
              className="settings-primary"
              data-testid="agent-access-enable"
              disabled={state.pending}
              onClick={() => manager.enable()}
            >
              {state.pending ? "Enabling…" : "Enable for this session"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div
            className="settings-saved-note"
            data-testid="agent-access-active"
            role="status"
          >
            Agent Access is live for this tab. Paste this into your local kernel — it carries a
            one-time pairing code (no secret), so the kernel can pair itself without the
            response-signing key ever touching your shell history:
          </div>
          {state.pairingCommand !== null ? (
            <>
              <div className="settings-identity-row">
                <input
                  type={revealed ? "text" : "password"}
                  autoComplete="off"
                  readOnly
                  data-testid="agent-access-pairing"
                  aria-label="Kernel pairing command"
                  value={state.pairingCommand}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  className="settings-secondary"
                  data-testid="agent-access-reveal"
                  aria-pressed={revealed}
                  onClick={() => setRevealed((v) => !v)}
                >
                  {revealed ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  className="settings-primary"
                  data-testid="agent-access-copy"
                  onClick={copyPairing}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="settings-note" data-testid="agent-access-pairing-ttl">
                The pairing code is one-time and <strong>expires in 10 minutes</strong>. Once your
                kernel pairs, it remembers the session — later runs need no re-paste.
              </p>
            </>
          ) : (
            <p className="settings-note" data-testid="agent-access-pairing-used">
              The pairing code has been used or has expired. Your kernel (if it paired) stays
              connected; to pair another, revoke below and enable again for a fresh code.
            </p>
          )}
          <div className="settings-identity-row">
            <button
              type="button"
              className="settings-back"
              data-testid="agent-access-revoke"
              onClick={() => manager.disable()}
            >
              Revoke
            </button>
          </div>

          {/* ---- Per-project file access (#1 slice 1) --------------------- */}
          <p className="settings-note">
            <strong>File access.</strong> By default the paired agent sees metadata only. Allowing
            file access for a project grants the paired agent <strong>read access to every file in
            that project</strong> for this session (it still cannot edit — edits always go through
            your review). Grants reset when you revoke Agent Access or close the tab.
          </p>
          <div data-testid="agent-content-projects">
            {projects.map((p) => {
              const granted = isContentGranted(store, p.id);
              return (
                <div className="settings-identity-row" key={p.id} data-project-id={p.id}>
                  <input type="text" readOnly aria-label="Project name" value={p.name} />
                  {granted ? (
                    <>
                      <span
                        className="settings-saved-note"
                        data-testid="agent-content-granted"
                        data-project-id={p.id}
                      >
                        File access granted
                      </span>
                      <button
                        type="button"
                        className="settings-back"
                        data-testid="agent-content-revoke"
                        data-project-id={p.id}
                        onClick={() => {
                          revokeContentAccess(store, p.id);
                          bump();
                        }}
                      >
                        Revoke file access
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="settings-primary"
                      data-testid="agent-content-grant"
                      data-project-id={p.id}
                      onClick={() => {
                        grantContentAccess(store, p.id);
                        bump();
                      }}
                    >
                      Allow file access (this session)
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* ---- Background agent access (F13, standing headless apply) ------ */}
          {activeGrant !== null && (
            <div data-testid="agent-background-section">
              <p className="settings-note">
                <strong>Background agent access.</strong> Normally the agent can only apply
                changes to the project you have <em>open</em>. Turning this on lets the paired
                agent keep applying its reviewed changes to{" "}
                <strong>{grantProjectName(projects, activeGrant.projectId)}</strong> even when you
                navigate to another project — as long as a Galley tab stays open. Every change
                still goes through the same checkpoint, audit, and single-applier safeguards, and
                it lapses automatically after 7 days of inactivity. Off by default.
              </p>
              <div className="settings-identity-row" data-project-id={activeGrant.projectId}>
                <input
                  type="text"
                  readOnly
                  aria-label="Background agent project"
                  value={grantProjectName(projects, activeGrant.projectId)}
                />
                {activeGrant.persistentAccess === true ? (
                  <>
                    <span
                      className="settings-saved-note"
                      data-testid="agent-background-active"
                      data-project-id={activeGrant.projectId}
                      role="status"
                    >
                      Background agent active on {grantProjectName(projects, activeGrant.projectId)}
                    </span>
                    <button
                      type="button"
                      className="settings-back"
                      data-testid="agent-background-revoke"
                      data-project-id={activeGrant.projectId}
                      onClick={() => {
                        // One-click Revoke of the STANDING access: clears the grant +
                        // content grant + tombstone audit + headless stamp, bumps the
                        // persist epoch, and (via the manager emit) the app-root host
                        // tears down — it leaves the room and stops applying.
                        manager.clearActiveGrant();
                        revokeContentAccess(store, activeGrant.projectId);
                        bump();
                      }}
                    >
                      Revoke background access
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="settings-primary"
                    data-testid="agent-background-enable"
                    data-project-id={activeGrant.projectId}
                    onClick={() => {
                      manager.setGrantPersistentAccess(true);
                      bump();
                    }}
                  >
                    Allow background agent access
                  </button>
                )}
              </div>
            </div>
          )}

          <p className="settings-note">
            This responder answers project/version <em>listing</em> (metadata only) plus the
            read-only file tools for the projects you granted above. Opening a project for the
            agent requires your explicit per-request approval and is limited to the project you
            have open. Revoking ends this session — including every file-access grant — and
            enabling again mints a fresh, unguessable room with zero grants.
          </p>
        </>
      )}
    </>
  );
}

/** The display name for a grant's project id, or the id itself when not in the list. */
function grantProjectName(projects: { id: string; name: string }[], projectId: string): string {
  return projects.find((p) => p.id === projectId)?.name ?? projectId;
}

/**
 * The real localStorage, or null when unavailable (privacy mode) — fail-closed.
 * localStorage (NOT sessionStorage) so a granted project's file access PERSISTS
 * across reload/restart alongside the resumed Agent Access session — the SAME
 * store the responder mount reads its grants from. Revoke clears them.
 */
function consentStore(): ConsentStoreLike | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // access can throw (privacy mode) — no store means no grants, fail-closed
  }
  return null;
}
