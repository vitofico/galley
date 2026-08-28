import type { SyncDestinationKind } from "../sync-destination.js";

/**
 * Destination chooser — the FIRST screen of an unconfigured project's Git-sync
 * panel. One question: *where does this project sync?* Two cards — GitHub
 * (connection-backed REST snapshot) / Other git host (self-contained
 * smart-HTTP remote) — each emitting the chosen `kind`. No persistence here;
 * the parent commits the kind once the sub-flow saves a destination.
 */
export interface DestinationChooserProps {
  /** Emit the picked destination kind; the shell routes to that sub-flow. */
  onChoose: (kind: SyncDestinationKind) => void;
}

export function DestinationChooser({ onChoose }: DestinationChooserProps) {
  return (
    <div className="git-dest-chooser" data-testid="git-dest-chooser">
      <p className="git-sync-lead" data-testid="git-dest-lead">
        Sync this project to a git destination. Push your files there, or fetch a copy back as a
        reviewable import. Pick where it lives:
      </p>
      <div className="git-dest-cards">
        <button
          type="button"
          className="git-dest-card"
          data-testid="git-dest-github"
          onClick={() => onChoose("github")}
        >
          <span className="git-dest-card-icon git-dest-card-icon--github" aria-hidden="true">
            <GithubMark />
          </span>
          <span className="git-dest-card-title">GitHub</span>
          <span className="git-dest-card-sub">
            Connect an account and pick a repository. Push and fetch over GitHub’s API.
          </span>
        </button>
        <button
          type="button"
          className="git-dest-card"
          data-testid="git-dest-generic"
          onClick={() => onChoose("git")}
        >
          <span className="git-dest-card-icon" aria-hidden="true">
            <GitMark />
          </span>
          <span className="git-dest-card-title">Other git host</span>
          <span className="git-dest-card-sub">
            Any git remote that allows browser access — a URL, branch and access token.
          </span>
        </button>
      </div>
    </div>
  );
}

/** GitHub Octocat-style glyph (inline so the panel needs no asset import). */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor" role="img">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** A generic git-branch glyph for the self-hosted destination. */
function GitMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 11.5c0 3-3 4.5-6 4.5" />
    </svg>
  );
}
