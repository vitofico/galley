import { useEffect, useState } from "react";
import {
  loadRedactedConfig,
  saveRemoteConfig,
  type RedactedRemoteConfig,
  type ConfigStorage,
} from "../git-remote-config.js";
import { saveSyncDestination } from "../sync-destination.js";
import { clearRepoTarget } from "../github-repo-target.js";

/**
 * Generic git destination — the self-contained URL / branch / token form for any
 * git host reachable from a browser (smart-HTTP via isomorphic-git). Writes
 * `git-remote-config` (the only secret store on this path), then COMMITS the
 * destination: marks the project's kind `"git"` and clears any stale GitHub repo
 * target (switch hygiene — a prior GitHub pick must not survive). The device
 * GitHub connection is account-scoped and left untouched.
 *
 * ## Security posture (carried forward verbatim from the old panel)
 *  - The token input is WRITE-ONLY: a password field that ALWAYS renders empty,
 *    NEVER seeded from storage. An empty submit keeps any already-stored token
 *    (`saveRemoteConfig` REC-4); the field is cleared after every save attempt.
 *  - The panel renders only the redacted view (`hasToken`), never the value.
 *  - A URL carrying `user[:pass]@` userinfo is rejected at save (HIGH-1) and the
 *    rejected value is never re-seeded into the visible input.
 */
export interface GenericGitDestinationProps {
  projectId: string;
  /** Injectable storage (defaults to localStorage). */
  storage?: ConfigStorage | null | undefined;
  /** Called once a remote is saved and the destination is committed to "git". */
  onSaved: () => void;
  /** Return to the destination chooser without saving. */
  onBack: () => void;
  /** Surface a transient status line through the shell. */
  setStatus: (status: { ok: boolean; text: string } | null) => void;
}

export function GenericGitDestination({
  projectId,
  storage,
  onSaved,
  onBack,
  setStatus,
}: GenericGitDestinationProps) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  // Write-only: never seeded from storage.
  const [token, setToken] = useState("");
  const [view, setView] = useState<RedactedRemoteConfig | null>(null);

  // Seed url/ref from any existing config so re-picking "git" pre-fills what was
  // entered before. The token is NEVER seeded.
  useEffect(() => {
    const v = loadRedactedConfig(projectId, storage);
    setView(v);
    setUrl(v?.url ?? "");
    setRef(v?.ref ?? "");
    setToken("");
  }, [projectId, storage]);

  const canSave = url.trim().length > 0;

  const save = () => {
    const result = saveRemoteConfig(
      projectId,
      { url, ...(ref.trim() ? { ref } : {}), ...(token.trim() ? { token } : {}) },
      storage,
    );
    if (!result.ok) {
      // Validation failure (e.g. credentials in the URL) — keep inputs, show why.
      // Still clear the token field so a secret never lingers in the DOM.
      setToken("");
      setStatus({ ok: false, text: result.error ?? "Could not save." });
      return;
    }
    setToken(""); // clear the secret from component state after persisting
    // Commit the destination: mark the kind and clear the OTHER kind's per-project
    // store (a stale GitHub target must not survive a switch to git).
    saveSyncDestination(projectId, "git");
    clearRepoTarget(projectId);
    setStatus({ ok: true, text: "Remote saved in this browser." });
    onSaved();
  };

  return (
    <div className="git-dest-form" data-testid="git-dest-generic-form">
      <label className="git-sync-field">
        <span className="git-sync-label">Remote URL</span>
        <input
          className="authoring-input git-sync-input"
          data-testid="git-sync-url"
          type="url"
          inputMode="url"
          placeholder="https://git.example.com/owner/repo.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <label className="git-sync-field">
        <span className="git-sync-label">Branch (ref)</span>
        <input
          className="authoring-input git-sync-input"
          data-testid="git-sync-ref"
          type="text"
          placeholder="main"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        />
      </label>

      <label className="git-sync-field">
        <span className="git-sync-label">
          Access token{" "}
          {view?.hasToken ? (
            <em className="git-sync-token-state" data-testid="git-sync-token-state">
              (a token is stored — leave blank to keep it)
            </em>
          ) : null}
        </span>
        <input
          className="authoring-input git-sync-input"
          data-testid="git-sync-token"
          type="password"
          autoComplete="off"
          placeholder={view?.hasToken ? "••••••••" : "Personal access token"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <p className="git-sync-disclosure" data-testid="git-sync-disclosure">
        Your token is stored in this browser only and is never sent to any Galley server —
        pushes and fetches go directly from your browser to the git remote.
      </p>

      <div className="authoring-actions">
        <button
          type="button"
          className="authoring-secondary"
          data-testid="git-dest-back"
          onClick={onBack}
        >
          ← Back
        </button>
        <button
          type="button"
          className="authoring-primary"
          data-testid="git-sync-save"
          disabled={!canSave}
          onClick={save}
        >
          Save remote
        </button>
      </div>
    </div>
  );
}
