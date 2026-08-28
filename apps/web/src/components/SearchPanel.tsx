import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { searchProjectFiles, type SearchInputFile } from "../project-search.js";
import {
  planReplacements,
  planSingleReplacement,
  replaceAllLabel,
  type ReplaceChange,
} from "../project-replace.js";
import "./search-panel.css";

/**
 * In-document full-text search panel (Tier E #2 — "find in files"), now with
 * replace / replace-all (feature #4).
 *
 * PRESENTATIONAL + CONTROLLED: it owns only its query/replacement drafts, the
 * one-level undo snapshot, and the conflict notice. The actual jump is a
 * CALLBACK (`onJump`) the host wires to set the active file and move the
 * editor cursor, and a replace is a CALLBACK (`onReplace`) handing the host
 * each affected file's expected base + full next text — the host applies them
 * via `applyReplaceChanges` (one author-tagged Y.Doc transaction with an
 * ALL-OR-NOTHING base check) and returns whether they landed. This panel never
 * touches file content or the editor view. The matching itself is delegated to
 * the PURE `searchProjectFiles` helper and the replace planning to the PURE
 * `planReplacements`/`planSingleReplacement` (both unit-tested separately,
 * sharing the exact same match semantics — what search shows is exactly what
 * replace changes); this component just renders.
 *
 * CONFLICT SAFETY: every change ships `beforeText` (the text the plan was
 * computed from). If the host reports the transaction aborted — a concurrent
 * local or remote edit landed between this render and the click — the panel
 * shows a "files changed — search again" notice and NOTHING was applied; a
 * stale plan can never clobber a collaborator's edit.
 *
 * UNDO (one level, honest): before a replace the panel snapshots each affected
 * file's prior text. "Undo replace" hands those prior texts back through the
 * SAME `onReplace` path, with the post-replace text as the base — so the undo
 * gets the identical transaction-time check: if any affected file changed
 * since, the whole undo aborts. The snapshot lives only in panel state — it
 * drops when the panel closes — and the button also disables (with the reason)
 * as soon as a change is detected at render time. It makes NO claim about the
 * editor's own undo history.
 *
 * The host hands it the SAME live file set the file tree shows (the reserved
 * `.galley/*` namespace is already excluded upstream), so search covers exactly
 * the visible documents. A read-only viewer (`canMutate === false`) sees the
 * replace affordances disabled with a tooltip; per-result Replace buttons are
 * not rendered at all.
 *
 * The parent can focus the input via the imperative `focus()` handle (used when
 * the dock opens), mirroring the way other docked surfaces grab focus.
 */
export interface SearchPanelProps {
  /** The live files to search: {fileId, path, text}, file-tree order. */
  files: readonly SearchInputFile[];
  /** Jump to a match: the host switches the active file then moves the cursor. */
  onJump: (target: { fileId: string; from: number }) => void;
  /** False for a read-only viewer: every replace affordance is inert. */
  canMutate: boolean;
  /**
   * Apply replacements: each change is one file's expected base + full target
   * text. The host MUST apply all of them in a single author-tagged Y.Doc
   * transaction with an all-or-nothing base check (`applyReplaceChanges`),
   * returning whether the changes landed (false = aborted on a stale base).
   */
  onReplace: (changes: readonly ReplaceChange[]) => boolean;
}

export interface SearchPanelHandle {
  focus: () => void;
}

/** The one-level undo snapshot held after a replace (panel state only). */
interface UndoSnapshot {
  /** How many individual matches the replace changed. */
  changeCount: number;
  /** Each affected file's text before and right after the replace. */
  files: { fileId: string; beforeText: string; afterText: string }[];
}

const READ_ONLY_TIP = "Read-only — a viewer can't replace";

/** Split a snippet around a [start,end) match so the match can be emphasised. */
function splitSnippet(
  snippet: string,
  start: number,
  end: number,
): { before: string; hit: string; after: string } {
  return {
    before: snippet.slice(0, start),
    hit: snippet.slice(start, end),
    after: snippet.slice(end),
  };
}

export const SearchPanel = forwardRef<SearchPanelHandle, SearchPanelProps>(function SearchPanel(
  { files, onJump, canMutate, onReplace },
  ref,
) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [undo, setUndo] = useState<UndoSnapshot | null>(null);
  // True after the host ABORTED a replace/undo (a concurrent edit beat the
  // click). Cleared on the next edit of either input or a successful apply.
  const [conflict, setConflict] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  // Recompute only when the query or the live file set changes. The helper is
  // pure and cheap (literal indexOf), so this stays snappy as you type.
  const result = useMemo(() => searchProjectFiles(files, query), [files, query]);
  const hasQuery = query.trim().length > 0;

  // The replace-all plan over the SAME files/query (and the same default caps),
  // so its count always equals the count the result list shows.
  const plan = useMemo(
    () => planReplacements(files, query, replacement),
    [files, query, replacement],
  );

  // The undo snapshot is only honest while every affected file still holds
  // exactly the post-replace text; any later edit (local or remote) makes the
  // stored inverse unsafe to apply, so the button disables with the reason.
  const undoValid = useMemo(() => {
    if (!undo) return false;
    return undo.files.every((u) => {
      const cur = files.find((f) => f.fileId === u.fileId);
      return cur !== undefined && cur.text === u.afterText;
    });
  }, [undo, files]);

  const onReplaceAll = () => {
    if (!canMutate || plan.totalReplacements === 0) return;
    const ok = onReplace(
      plan.files.map((f) => ({
        fileId: f.fileId,
        beforeText: f.prevText,
        nextText: f.nextText,
      })),
    );
    if (!ok) {
      setConflict(true); // the host aborted: nothing changed
      return;
    }
    setConflict(false);
    setUndo({
      changeCount: plan.totalReplacements,
      files: plan.files.map((f) => ({
        fileId: f.fileId,
        beforeText: f.prevText,
        afterText: f.nextText,
      })),
    });
  };

  const onReplaceOne = (fileId: string, from: number) => {
    if (!canMutate) return;
    const single = planSingleReplacement(files, fileId, from, query, replacement);
    if (!single) {
      setConflict(true); // stale row: the text changed under the panel
      return;
    }
    const ok = onReplace([
      { fileId: single.fileId, beforeText: single.prevText, nextText: single.nextText },
    ]);
    if (!ok) {
      setConflict(true);
      return;
    }
    setConflict(false);
    setUndo({
      changeCount: 1,
      files: [{ fileId: single.fileId, beforeText: single.prevText, afterText: single.nextText }],
    });
  };

  const onUndoReplace = () => {
    if (!canMutate || !undo || !undoValid) return;
    // The undo's BASE is the post-replace text: the host re-checks it inside
    // the transaction, so a concurrent edit racing this click aborts the whole
    // undo instead of being overwritten.
    const ok = onReplace(
      undo.files.map((f) => ({
        fileId: f.fileId,
        beforeText: f.afterText,
        nextText: f.beforeText,
      })),
    );
    if (!ok) {
      setConflict(true); // the render-time validity will also flip the button off
      return;
    }
    setConflict(false);
    setUndo(null);
  };

  return (
    <section className="search-panel" data-testid="search-panel" aria-label="Search in files">
      <header className="search-header">
        <span className="search-title">Find in files</span>
      </header>

      <input
        ref={inputRef}
        className="search-input"
        data-testid="search-input"
        type="search"
        value={query}
        placeholder="Search the open project…"
        aria-label="Search the open project"
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setConflict(false);
        }}
      />

      <div className="search-replace-row">
        <input
          className="search-input search-replace-input"
          data-testid="search-replace-input"
          type="text"
          value={replacement}
          placeholder="Replace with…"
          aria-label="Replace with"
          disabled={!canMutate}
          title={canMutate ? undefined : READ_ONLY_TIP}
          onChange={(e) => {
            setReplacement(e.target.value);
            setConflict(false);
          }}
        />
        <button
          type="button"
          className="search-replace-all"
          data-testid="search-replace-all"
          disabled={!canMutate || plan.totalReplacements === 0}
          title={
            !canMutate
              ? READ_ONLY_TIP
              : plan.truncated
                ? "Replaces only the matches shown (results are capped)"
                : "Replace every match shown"
          }
          onClick={onReplaceAll}
        >
          {replaceAllLabel(plan, replacement)}
        </button>
      </div>

      {plan.truncated && (
        <div className="search-replace-note" data-testid="search-replace-capped">
          Results are capped: replacing changes only the {plan.totalReplacements} shown of{" "}
          {plan.totalMatchesAll} matches.
        </div>
      )}

      {conflict && (
        <div className="search-replace-conflict" data-testid="search-replace-conflict" role="alert">
          The files changed before the replace could land — nothing was changed. Search again.
        </div>
      )}

      {undo && (
        <div className="search-replace-undo-row">
          <button
            type="button"
            className="search-replace-undo"
            data-testid="search-replace-undo"
            disabled={!canMutate || !undoValid}
            title={
              undoValid
                ? "Revert this replace"
                : "A file changed since this replace — undo no longer applies"
            }
            onClick={onUndoReplace}
          >
            Undo replace ({undo.changeCount} change{undo.changeCount === 1 ? "" : "s"} across{" "}
            {undo.files.length} file{undo.files.length === 1 ? "" : "s"})
          </button>
          <div className="search-replace-hint">
            {undoValid
              ? "Held only while this panel stays open."
              : "A file changed since this replace — undo no longer applies."}
          </div>
        </div>
      )}

      {hasQuery && (
        <div className="search-count" data-testid="search-count">
          {result.totalMatches === 0
            ? "No matches"
            : `${result.totalMatches} match${result.totalMatches === 1 ? "" : "es"} in ${
                result.files.length
              } file${result.files.length === 1 ? "" : "s"}`}
          {result.truncated && " — showing the first results"}
        </div>
      )}

      {hasQuery && result.files.length === 0 ? (
        <div className="search-empty" data-testid="search-empty">
          No matches in the open project.
        </div>
      ) : (
        <div className="search-results" data-testid="search-results">
          {result.files.map((group) => (
            <div key={group.fileId} className="search-file-group">
              <div className="search-file-path" title={group.path}>
                {group.path}
                {group.truncated && <span className="search-file-more"> (truncated)</span>}
              </div>
              <ul className="search-match-list">
                {group.matches.map((m, i) => {
                  const parts = splitSnippet(m.snippet, m.columnStart, m.columnEnd);
                  return (
                    <li key={`${m.line}:${m.columnStart}:${i}`} className="search-match-item">
                      <button
                        type="button"
                        className="search-result"
                        data-testid="search-result"
                        data-path={group.path}
                        data-line={m.line}
                        title={`${group.path}:${m.line}`}
                        onClick={() => onJump({ fileId: group.fileId, from: m.from })}
                      >
                        <span className="search-result-line">{m.line}</span>
                        <span className="search-result-snippet">
                          {parts.before}
                          <mark className="search-result-hit">{parts.hit}</mark>
                          {parts.after}
                        </span>
                      </button>
                      {canMutate && (
                        <button
                          type="button"
                          className="search-result-replace"
                          data-testid="search-replace-one"
                          data-path={group.path}
                          data-line={m.line}
                          title={`Replace this match (${group.path}:${m.line})`}
                          onClick={() => onReplaceOne(group.fileId, m.from)}
                        >
                          Replace
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
