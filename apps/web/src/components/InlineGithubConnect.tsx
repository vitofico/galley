import { useState } from "react";
import {
  loadRedactedGithubConnection,
  saveGithubConnection,
  type RedactedGithubConnection,
} from "../github-connect.js";
import { validateToken } from "../github-api.js";

/**
 * Inline GitHub connect — the paste-PAT step, factored out of `SettingsApp`'s
 * `GithubConnectSettings` so the unified Git-sync panel can connect a GitHub
 * account at the point of need without bouncing the user to Settings. Settings
 * keeps the SAME connection for management (Disconnect lives there); both share
 * this one validate→save flow so they can't diverge.
 *
 * ## Security posture (carried forward verbatim)
 *  - The token is WRITE-ONLY from the screen: the input is a password field that
 *    is NEVER seeded from storage, and it is cleared from component state the
 *    instant the validate call returns (success OR failure) — no secret lingers
 *    in the DOM or in React state.
 *  - On success the credential is saved via `saveGithubConnection` (this
 *    browser's localStorage only, never any Galley server) and the parent is told
 *    the resolved login so it can re-render the connected state.
 *  - Errors are surfaced as the typed `GithubApiError` message, which never
 *    carries the token.
 */
export interface InlineGithubConnectProps {
  /** Called once the connection is saved, with the redacted (token-free) view. */
  onConnected: (view: RedactedGithubConnection) => void;
  /** True while any sibling action is running — disables this control too. */
  busy?: boolean;
}

export function InlineGithubConnect({ onConnected, busy }: InlineGithubConnectProps) {
  // Write-only: the token draft starts empty and is wiped after every attempt.
  const [tokenDraft, setTokenDraft] = useState("");
  const [validating, setValidating] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const disabled = busy === true || validating;

  const validate = async () => {
    if (disabled) return;
    const draft = tokenDraft.trim();
    setValidating(true);
    setNote(null);
    try {
      const { login } = await validateToken(draft);
      setTokenDraft(""); // write-only: the secret never lingers in component state
      if (!saveGithubConnection({ token: draft, login })) {
        setNote({ ok: false, text: "Could not save the connection in this browser." });
        return;
      }
      const view = loadRedactedGithubConnection();
      if (view) onConnected(view);
    } catch (err) {
      setTokenDraft(""); // clear on failure too — no secret left in the DOM
      setNote({ ok: false, text: errorText(err) });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="git-sync-connect" data-testid="git-sync-connect">
      <p className="git-sync-disclosure" data-testid="git-sync-connect-lead">
        Connect a GitHub account to push and fetch this project as a snapshot. The token is
        stored in this browser only and is sent to <code>api.github.com</code> directly — never
        to any Galley server.
      </p>
      <div className="git-sync-connect-row">
        <input
          className="authoring-input git-sync-input"
          type="password"
          autoComplete="off"
          data-testid="github-token-input"
          aria-label="GitHub personal access token"
          placeholder="GitHub personal access token"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void validate();
          }}
        />
        <button
          type="button"
          className="authoring-primary"
          data-testid="github-validate"
          disabled={disabled}
          onClick={() => void validate()}
        >
          {validating ? "Connecting…" : "Connect"}
        </button>
      </div>
      <p className="git-sync-connect-scope">
        Use a classic token with the <code>repo</code> scope, or a fine-grained token with{" "}
        <strong>Contents: read &amp; write</strong> on the target repository (creating a new
        repository needs the classic <code>repo</code> scope).
      </p>
      {note && (
        <p
          className="authoring-status git-sync-status"
          data-testid="github-status"
          data-ok={note.ok ? "true" : "false"}
          role="status"
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
