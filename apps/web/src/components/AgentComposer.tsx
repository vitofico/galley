import { formatUsage, checkBudget, type UsageEstimate } from "../cost-estimate.js";
import {
  activeMentionQuery,
  suggestMentions,
  type MentionableFile,
} from "./agent-mentions.js";
import { activeSlashQuery, suggestSlash, expandSlash, SLASH_ACTIONS } from "./agent-slash.js";

export function AgentComposer(props: {
  request: string;
  onRequestChange(v: string): void;
  onFocus?(): void;
  onSend(): void;
  onStop(): void;
  running: boolean;
  mentionFiles?: () => MentionableFile[];
  usage: UsageEstimate;
  showCost: boolean;
  tokenBudget?: number;
}): JSX.Element {
  const { request, onRequestChange, onFocus, onSend, onStop, running, mentionFiles, usage, showCost, tokenBudget } =
    props;

  // Only compute mention state when a mentionFiles seam is wired AND the textarea
  // tail is an open `@…` token.
  const mentionQuery = mentionFiles ? activeMentionQuery(request) : null;
  const mentionOptions =
    mentionQuery !== null && mentionFiles ? suggestMentions(mentionQuery, mentionFiles()) : [];

  // Slash quick-actions: a static catalog, so no host seam. Never competes with
  // the mention list — a slash query needs the buffer to START with `/` and hold
  // no space, and an `@` token needs a start-or-space before it, so the two can
  // never both be open.
  const slashQuery = activeSlashQuery(request);
  const slashOptions = slashQuery !== null ? suggestSlash(slashQuery, SLASH_ACTIONS) : [];

  const budget = checkBudget(usage, tokenBudget);

  // The mention-insert handler: replace the trailing `@<query>` with `@<path> `
  // (same slice logic as the monolith's `insertMention`). Presentational — calls
  // the parent's `onRequestChange` with the updated string.
  const insertMention = (path: string) => {
    const q = activeMentionQuery(request);
    if (q === null) return;
    const next = `${request.slice(0, request.length - (q.length + 1))}@${path} `;
    onRequestChange(next);
  };

  // Choosing a quick-action EXPANDS its prompt into the composer and stops there:
  // the author reviews/edits and sends it themselves. Never auto-sends — the
  // expansion is an ordinary prompt, so the run path stays untouched.
  const chooseSlash = (action: (typeof SLASH_ACTIONS)[number]) => {
    onRequestChange(expandSlash(request, action));
  };

  return (
    <>
      {/* Slim cost line — sits ABOVE the textarea so it never reflows the
          textarea/Send when it first appears (mirrors B13(3) in AgentPanel).
          Kept as a thin `.agent-cost-line` rather than the boxed meter. */}
      {showCost && usage.totalTokens > 0 && (
        <div
          className={`agent-cost-line${budget.overSoftLimit ? " agent-cost-line-over" : ""}`}
          data-testid="cost-meter"
          data-over-budget={budget.overSoftLimit ? "true" : "false"}
        >
          <span>{formatUsage(usage)}</span>
          {budget.overSoftLimit && (
            <span data-testid="cost-meter-warning">
              over budget ({tokenBudget} tok)
            </span>
          )}
        </div>
      )}

      <div className="agent-input">
        <textarea
          value={request}
          onChange={(e) => onRequestChange(e.target.value)}
          onFocus={onFocus}
          // Enter sends; Shift+Enter inserts a newline. Skip while an IME
          // composition is active so confirming a candidate never fires a send.
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!running && request.trim()) onSend();
            }
          }}
          placeholder="Ask the agent to edit the document…"
          data-testid="agent-request"
          rows={2}
        />
        {mentionOptions.length > 0 && (
          <ul className="agent-mention-list" data-testid="agent-mention-suggestions">
            {mentionOptions.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  className="agent-mention-option"
                  data-testid={`agent-mention-option-${f.path}`}
                  onMouseDown={(e) => {
                    // mousedown (not click) so the textarea doesn't blur first.
                    e.preventDefault();
                    insertMention(f.path);
                  }}
                >
                  {f.path}
                </button>
              </li>
            ))}
          </ul>
        )}
        {slashOptions.length > 0 && (
          <ul className="agent-slash-list" data-testid="agent-slash-suggestions">
            {slashOptions.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="agent-slash-option"
                  data-testid={`agent-slash-option-${a.id}`}
                  onMouseDown={(e) => {
                    // mousedown (not click) so the textarea doesn't blur first.
                    e.preventDefault();
                    chooseSlash(a);
                  }}
                >
                  <span className="agent-slash-token">/{a.id}</span>
                  <span className="agent-slash-label">{a.label}</span>
                  <span className="agent-slash-hint">{a.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={onSend}
          disabled={running || !request.trim()}
          data-testid="agent-send"
          // B13(2): name WHY the disabled button is inert (empty request /
          // in-flight run) so it isn't a dead, unexplained control.
          title={
            running
              ? "A run is in progress"
              : !request.trim()
                ? "Enter a request first"
                : "Send this request to the agent"
          }
        >
          {running ? "Running…" : "Send"}
        </button>
        {running && (
          <button
            type="button"
            className="galley-stop"
            onClick={onStop}
            data-testid="agent-stop"
          >
            Stop
          </button>
        )}
      </div>
    </>
  );
}
