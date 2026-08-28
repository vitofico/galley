/**
 * `JoinNamePrompt` (#19.4, spec §7) — the one-time display-name card shown when
 * opening a `/join/<room>` share link. Small, inline, and SKIPPABLE: joining is
 * never blocked on giving a name (the skip is remembered in the local profile,
 * so the question is asked exactly once per browser).
 *
 * Presentational only: the host (`JoinRoot`) persists the answer to the local
 * profile and creates the session AFTERWARDS, so the name is on the `Author` at
 * registration time and travels to every peer (presence + attribution).
 */
import { useState } from "react";
import "./join-prompt.css";

export function JoinNamePrompt({
  onDone,
}: {
  /** Called once with the chosen name, or `null` when skipped. */
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const name = value.trim();
    onDone(name === "" ? null : name);
  };
  return (
    <form
      className="join-prompt"
      data-testid="join-name-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="join-prompt-title">Joining a shared project</h1>
      <p className="join-prompt-hint">
        How should other editors see you? Your name appears next to your cursor and your
        edits.
      </p>
      <input
        className="join-prompt-input"
        data-testid="join-name-input"
        type="text"
        value={value}
        autoFocus
        maxLength={64}
        placeholder="Your name"
        aria-label="Your display name"
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="join-prompt-actions">
        <button type="submit" className="join-prompt-join" data-testid="join-name-submit">
          Join
        </button>
        <button
          type="button"
          className="join-prompt-skip"
          data-testid="join-name-skip"
          onClick={() => onDone(null)}
        >
          Continue without a name
        </button>
      </div>
    </form>
  );
}
