import { useState } from "react";
import type { SyncDestinationKind } from "../sync-destination.js";
import type { GitSyncPushOutcome, GitSyncFetchOutcome } from "../git-sync-types.js";

/**
 * Configured destination card — the steady state once a project has a
 * destination. Renders a read-only summary of WHERE it syncs (icon, repo/URL,
 * branch, identity) and the two transport-agnostic actions Push / Fetch, plus a
 * "Change" affordance back to the chooser. The card is purely presentational
 * over the host's injected `onPush`/`onFetch` — it knows nothing about REST vs
 * smart-HTTP; the host dispatches by kind. Fetch is Accept-gated by the host
 * (candidate only), never auto-applied.
 */
export interface ConfiguredSummary {
  kind: SyncDestinationKind;
  /** GitHub: "owner/name". Generic: the (userinfo-stripped) URL. */
  primary: string;
  /** The branch / ref. */
  branch: string;
  /** GitHub only: the connected login. */
  identity?: string;
}

export interface ConfiguredDestinationProps {
  summary: ConfiguredSummary;
  onPush: () => Promise<GitSyncPushOutcome>;
  onFetch: () => Promise<GitSyncFetchOutcome>;
  /** Return to the destination chooser (clears the kind marker; keeps credentials). */
  onChange: () => void;
  setStatus: (status: { ok: boolean; text: string } | null) => void;
}

export function ConfiguredDestination({
  summary,
  onPush,
  onFetch,
  onChange,
  setStatus,
}: ConfiguredDestinationProps) {
  const [busy, setBusy] = useState<null | "push" | "fetch">(null);

  const push = async () => {
    if (busy) return;
    setBusy("push");
    setStatus(null);
    try {
      const r = await onPush();
      setStatus(
        r.ok
          ? { ok: true, text: `Pushed. Commit ${r.oid?.slice(0, 10) ?? ""}.` }
          : { ok: false, text: r.error ?? "Push failed." },
      );
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const fetchRemote = async () => {
    if (busy) return;
    setBusy("fetch");
    setStatus(null);
    try {
      const r = await onFetch();
      if (!r.ok) {
        setStatus({ ok: false, text: r.error ?? "Fetch failed." });
      } else if (r.hasCandidate === false) {
        setStatus({ ok: true, text: "Nothing to import — the remote ref is empty." });
      } else {
        setStatus({ ok: true, text: "Fetched. Review the changes to import them." });
      }
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const isGithub = summary.kind === "github";

  return (
    <div className="git-dest-configured" data-testid="git-dest-configured" data-kind={summary.kind}>
      <div className="git-dest-summary">
        <span
          className={`git-dest-summary-icon${isGithub ? " git-dest-summary-icon--github" : ""}`}
          aria-hidden="true"
        >
          {isGithub ? <GithubMark /> : <GitMark />}
        </span>
        <div className="git-dest-summary-text">
          <span className="git-dest-summary-kind">
            {isGithub ? "GitHub" : "Git remote"}
          </span>
          <span className="git-dest-summary-repo" data-testid="git-dest-summary-repo">
            {summary.primary}
          </span>
          <span className="git-dest-summary-meta">
            <span data-testid="git-dest-summary-branch">branch {summary.branch}</span>
            {summary.identity ? (
              <>
                {" · "}
                <span data-testid="git-dest-summary-identity">{summary.identity}</span>
              </>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className="authoring-tertiary"
          data-testid="git-dest-change"
          onClick={onChange}
        >
          Change
        </button>
      </div>

      <div className="authoring-actions git-sync-sync-actions">
        <button
          type="button"
          className="authoring-primary"
          data-testid="git-sync-push"
          disabled={busy !== null}
          onClick={() => void push()}
        >
          {busy === "push" ? "Pushing…" : "Push →"}
        </button>
        <button
          type="button"
          className="authoring-secondary"
          data-testid="git-sync-fetch"
          disabled={busy !== null}
          onClick={() => void fetchRemote()}
        >
          {busy === "fetch" ? "Fetching…" : "← Fetch"}
        </button>
      </div>

      <p className="git-sync-disclosure" data-testid="git-sync-disclosure">
        {isGithub
          ? "Pushes and fetches go directly from your browser to api.github.com — never to any Galley server. Fetch brings in a reviewable copy; nothing is applied until you accept it."
          : "Pushes and fetches go directly from your browser to the git remote — never to any Galley server. Fetch brings in a reviewable copy; nothing is applied until you accept it."}
      </p>
    </div>
  );
}

/** GitHub Octocat-style glyph (inline, matching the chooser). */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" role="img">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** A generic git-branch glyph (matching the chooser). */
function GitMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 11.5c0 3-3 4.5-6 4.5" />
    </svg>
  );
}
