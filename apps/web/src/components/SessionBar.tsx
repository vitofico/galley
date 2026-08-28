import { useRef, useState } from "react";
import type { AgentSession } from "./agent-sessions.js";
import type { ListModelsResult } from "@galley/agent";

export function SessionBar(props: {
  sessions: AgentSession[];
  active: AgentSession;
  onSelect(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onDelete(id: string): void;
  modelPicker?: {
    current: string;
    list(): Promise<ListModelsResult>;
    onSelect(id: string): void;
  };
  onEditInstructions?: () => void;
  instructionsActive?: boolean;
}): JSX.Element {
  const {
    sessions,
    active,
    onSelect,
    onNew,
    onRename,
    onDelete,
    modelPicker,
    onEditInstructions,
    instructionsActive = false,
  } = props;

  // Switcher dropdown open state
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Overflow menu open state
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Inline rename: which session id is being renamed + current buffer
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Model picker state (lazy-loaded list, mirrors AgentPanel verbatim)
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelList, setModelList] = useState<ListModelsResult | null>(null);
  const [modelLoading, setModelLoading] = useState(false);

  const renameInputRef = useRef<HTMLInputElement>(null);

  // ── Switcher ────────────────────────────────────────────────────────────────

  const toggleSwitcher = () => {
    setSwitcherOpen((open) => !open);
    // Close overflow when opening switcher
    if (!switcherOpen) setOverflowOpen(false);
  };

  const handleSelect = (id: string) => {
    onSelect(id);
    setSwitcherOpen(false);
    setRenamingId(null);
  };

  const startRename = (s: AgentSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(s.id);
    setRenameValue(s.title);
    // Focus the input on next paint
    requestAnimationFrame(() => renameInputRef.current?.focus());
  };

  const commitRename = (id: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) onRename(id, trimmed);
    setRenamingId(null);
  };

  const handleRenameKey = (id: string, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(id);
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(id);
    // If we deleted the active session the parent will update `active` prop;
    // close switcher defensively only when the list will be empty
    if (sessions.length <= 1) setSwitcherOpen(false);
  };

  // ── Overflow / model picker ──────────────────────────────────────────────────

  const toggleOverflow = () => {
    setOverflowOpen((open) => {
      const next = !open;
      if (!next) setModelMenuOpen(false);
      return next;
    });
    // Close switcher when opening overflow
    if (!overflowOpen) setSwitcherOpen(false);
  };

  const toggleModelMenu = () => {
    setModelMenuOpen((open) => {
      const next = !open;
      if (next && modelPicker) {
        setModelLoading(true);
        modelPicker
          .list()
          .then((r) => setModelList(r))
          .catch(() => setModelList({ ok: false, reason: "network" }))
          .finally(() => setModelLoading(false));
      }
      return next;
    });
  };

  const chooseModel = (id: string) => {
    modelPicker?.onSelect(id);
    setModelMenuOpen(false);
  };

  const hasOverflow = !!(modelPicker || onEditInstructions);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="agent-session-bar" data-testid="agent-session-bar">
      {/* LEFT: session title / switcher trigger */}
      <button
        type="button"
        className="agent-session-title"
        data-testid="agent-session-title"
        aria-haspopup="menu"
        aria-expanded={switcherOpen}
        onClick={toggleSwitcher}
      >
        {active.title}
      </button>

      {switcherOpen && (
        <ul
          className="agent-session-switcher"
          data-testid="agent-session-switcher"
          role="menu"
          aria-label="Sessions"
        >
          {sessions.map((s) => (
            <li key={s.id} role="none">
              {renamingId === s.id ? (
                <input
                  ref={renameInputRef}
                  className="agent-session-rename-input"
                  data-testid="agent-session-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(s.id)}
                  onKeyDown={(e) => handleRenameKey(s.id, e)}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="agent-session-item"
                    data-testid="agent-session-item"
                    data-active={s.id === active.id}
                    aria-current={s.id === active.id ? "true" : undefined}
                    onClick={() => handleSelect(s.id)}
                  >
                    {s.title}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="agent-session-rename"
                    data-testid="agent-session-rename"
                    title="Rename"
                    onClick={(e) => startRename(s, e)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="agent-session-delete"
                    data-testid="agent-session-delete"
                    title="Delete"
                    onClick={(e) => handleDelete(s.id, e)}
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* RIGHT: new chat + optional overflow */}
      <div className="agent-session-bar-actions">
        <button
          type="button"
          className="agent-session-new"
          data-testid="agent-session-new"
          title="New chat"
          onClick={onNew}
        >
          +
        </button>

        {hasOverflow && (
          <>
            <button
              type="button"
              className={`agent-overflow-button${instructionsActive ? " is-active" : ""}`}
              data-testid="agent-overflow-button"
              aria-haspopup="true"
              aria-expanded={overflowOpen}
              onClick={toggleOverflow}
              title={instructionsActive ? "More — project instructions active" : "More"}
            >
              ⋯
              {/* A persistent dot so "instructions active" is visible at a glance
                  without opening the menu (the indicator the old always-visible
                  header carried). The in-menu button keeps its own "· active"
                  label, but this badge owns the testid to stay unique. */}
              {instructionsActive && (
                <span
                  className="agent-overflow-active-dot"
                  data-testid="agent-instructions-active"
                  aria-label="project instructions active"
                />
              )}
            </button>

            {overflowOpen && (
              <div className="agent-overflow-menu" data-testid="agent-overflow-menu">
                {/* Instructions button — verbatim from AgentPanel */}
                {onEditInstructions && (
                  <button
                    type="button"
                    className={`agent-instructions-btn${instructionsActive ? " is-active" : ""}`}
                    data-testid="agent-edit-instructions"
                    data-active={instructionsActive ? "true" : "false"}
                    onClick={() => onEditInstructions()}
                    title="Edit the project instructions that steer the agent"
                    data-tip="Steers the agent and writing goals"
                  >
                    Instructions
                    {instructionsActive && (
                      <span className="agent-instructions-dot" aria-label="active">
                        {" "}· active
                      </span>
                    )}
                  </button>
                )}

                {/* Model picker — verbatim from AgentPanel */}
                {modelPicker && (
                  <div className="agent-model-picker">
                    <button
                      type="button"
                      className="agent-model-btn"
                      data-testid="agent-model-button"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuOpen}
                      onClick={toggleModelMenu}
                      title="Choose the model this agent run uses"
                    >
                      Model: <span className="agent-model-current">{modelPicker.current}</span> ▾
                    </button>
                    {modelMenuOpen && (
                      <ul
                        className="agent-model-list"
                        data-testid="agent-model-list"
                        role="listbox"
                      >
                        {modelLoading && (
                          <li className="agent-model-status" role="presentation">
                            Loading models…
                          </li>
                        )}
                        {!modelLoading && modelList && !modelList.ok && (
                          <li
                            className="agent-model-status"
                            data-testid="agent-model-error"
                            role="presentation"
                          >
                            {modelList.reason === "unsupported"
                              ? "Model listing isn't available through a proxy — set the model in Settings."
                              : "Couldn't list models — check your provider connection."}
                          </li>
                        )}
                        {!modelLoading && modelList?.ok && modelList.models.length === 0 && (
                          <li className="agent-model-status" role="presentation">
                            No models returned.
                          </li>
                        )}
                        {!modelLoading &&
                          modelList?.ok &&
                          modelList.models.map((m) => (
                            <li key={m} role="presentation">
                              <button
                                type="button"
                                role="option"
                                className="agent-model-option"
                                data-testid={`agent-model-option-${m}`}
                                aria-selected={m === modelPicker.current}
                                onClick={() => chooseModel(m)}
                              >
                                {m}
                                {m === modelPicker.current ? " ✓" : ""}
                              </button>
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
