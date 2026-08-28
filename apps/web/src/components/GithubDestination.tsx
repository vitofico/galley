import { useEffect, useState } from "react";
import {
  loadGithubConnection,
  loadRedactedGithubConnection,
  type RedactedGithubConnection,
} from "../github-connect.js";
import {
  loadRepoTarget,
  saveRepoTarget,
  type GithubRepoSelection,
} from "../github-repo-target.js";
import { createRepo } from "../github-api.js";
import { saveSyncDestination } from "../sync-destination.js";
import { clearRemoteConfig, type ConfigStorage } from "../git-remote-config.js";
import { InlineGithubConnect } from "./InlineGithubConnect.js";

/**
 * GitHub destination configuration — inline connect (if the device has no GitHub
 * connection yet) followed by the repo picker (owner / name @ branch, with
 * "Use this repository" and "Create new private repo"). On saving a repo target
 * it COMMITS the destination: marks the project's kind `"github"` and clears the
 * generic git-remote store (switch hygiene). The device connection is
 * account-scoped and never cleared here.
 *
 * No SECRET is rendered: the inline-connect token is write-only (handled in
 * `InlineGithubConnect`); this component only ever shows the redacted login and
 * the non-sensitive repo coordinates.
 */
export interface GithubDestinationProps {
  projectId: string;
  /** Injectable storage for the generic-remote clear-on-switch (defaults to localStorage). */
  storage?: ConfigStorage | null | undefined;
  /** Called once a repo target is saved and the destination is committed to "github". */
  onSaved: () => void;
  /** Return to the destination chooser. */
  onBack: () => void;
  /** Surface a transient status line through the shell. */
  setStatus: (status: { ok: boolean; text: string } | null) => void;
}

export function GithubDestination({
  projectId,
  storage,
  onSaved,
  onBack,
  setStatus,
}: GithubDestinationProps) {
  const [github, setGithub] = useState<RedactedGithubConnection | null>(null);
  const [ghOwner, setGhOwner] = useState("");
  const [ghName, setGhName] = useState("");
  const [ghBranch, setGhBranch] = useState("main");
  const [busy, setBusy] = useState<null | "create">(null);

  // Seed the connection + repo draft once on mount / project change. Owner
  // defaults to the connected login on a first, untargeted project.
  useEffect(() => {
    const gh = loadRedactedGithubConnection();
    setGithub(gh);
    const target = loadRepoTarget(projectId);
    setGhOwner(target?.owner ?? gh?.login ?? "");
    setGhName(target?.name ?? "");
    setGhBranch(target?.branch ?? "main");
  }, [projectId]);

  // Persist this project's repo target and commit the destination.
  const commit = (sel: GithubRepoSelection) => {
    saveSyncDestination(projectId, "github");
    clearRemoteConfig(projectId, storage); // switch hygiene: drop a stale generic remote
    setStatus({
      ok: true,
      text: `This project syncs with ${sel.owner}/${sel.name}@${sel.branch}.`,
    });
    onSaved();
  };

  const saveGithubRepo = () => {
    const result = saveRepoTarget(projectId, { owner: ghOwner, name: ghName, branch: ghBranch });
    if (!result.ok) {
      setStatus({ ok: false, text: result.error ?? "Could not save the repository." });
      return;
    }
    const target = loadRepoTarget(projectId);
    if (target) commit(target);
  };

  // Create a NEW private repo (device token), then point THIS project at it.
  const createGithubRepo = async () => {
    if (busy) return;
    const conn = loadGithubConnection();
    if (!conn) {
      setStatus({ ok: false, text: "Connect GitHub first." });
      return;
    }
    if (!ghName.trim()) {
      setStatus({ ok: false, text: "Enter a name for the new repository." });
      return;
    }
    setBusy("create");
    setStatus(null);
    try {
      const created = await createRepo(conn.token, { name: ghName.trim(), private: true });
      const result = saveRepoTarget(projectId, {
        owner: created.owner,
        name: created.name,
        branch: ghBranch,
      });
      if (result.ok) {
        const target = loadRepoTarget(projectId);
        if (target) {
          setGhOwner(target.owner);
          setGhName(target.name);
          setGhBranch(target.branch);
          commit(target);
        }
      }
    } catch (err) {
      // createRepo's typed error never carries the token; scrub the literal once
      // more, defense in depth, in case a seam bubbled it out.
      const raw = err instanceof Error ? err.message : String(err);
      setStatus({ ok: false, text: raw.split(conn.token).join("[redacted]") });
    } finally {
      setBusy(null);
    }
  };

  // Not connected yet → inline connect, then re-render the repo picker.
  if (!github) {
    return (
      <div className="git-dest-form" data-testid="git-dest-github-form">
        <InlineGithubConnect
          onConnected={(v) => {
            setGithub(v);
            // Seed the owner from the just-resolved login (the mount-time effect
            // ran when there was no connection, so it left owner empty) — without
            // clobbering anything the user already typed.
            setGhOwner((cur) => (cur.trim() ? cur : v.login));
          }}
          busy={busy !== null}
        />
        <div className="authoring-actions">
          <button
            type="button"
            className="authoring-secondary"
            data-testid="git-dest-back"
            onClick={onBack}
          >
            ← Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="git-dest-form" data-testid="git-dest-github-form">
      <p className="git-sync-label git-dest-identity" data-testid="git-sync-github-identity">
        Connected as <strong>{github.login}</strong>
      </p>
      <div className="git-sync-github-repo" data-testid="git-sync-github">
        <input
          className="authoring-input git-sync-input"
          type="text"
          data-testid="github-repo-owner"
          aria-label="Repository owner"
          placeholder="owner"
          value={ghOwner}
          onChange={(e) => setGhOwner(e.target.value)}
        />
        <span className="git-sync-github-sep">/</span>
        <input
          className="authoring-input git-sync-input"
          type="text"
          data-testid="github-repo-name"
          aria-label="Repository name"
          placeholder="repository"
          value={ghName}
          onChange={(e) => setGhName(e.target.value)}
        />
        <span className="git-sync-github-sep">@</span>
        <input
          className="authoring-input git-sync-input"
          type="text"
          data-testid="github-repo-branch"
          aria-label="Branch"
          placeholder="main"
          value={ghBranch}
          onChange={(e) => setGhBranch(e.target.value)}
        />
      </div>
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
          className="authoring-secondary"
          data-testid="github-repo-create"
          disabled={busy !== null}
          onClick={() => void createGithubRepo()}
        >
          {busy === "create" ? "Creating…" : "Create new private repo"}
        </button>
        <button
          type="button"
          className="authoring-primary"
          data-testid="github-repo-save"
          disabled={busy !== null || !ghOwner.trim() || !ghName.trim()}
          onClick={saveGithubRepo}
        >
          Use this repository
        </button>
      </div>
      <p className="git-sync-disclosure" data-testid="git-sync-github-disclosure">
        Your GitHub token is stored in this browser only and is sent to{" "}
        <code>api.github.com</code> directly — never to any Galley server.
      </p>
    </div>
  );
}
