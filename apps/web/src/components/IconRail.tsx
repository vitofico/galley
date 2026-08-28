import type { DockId } from "./dock-state.js";
import type { ThemeMode } from "../theme.js";
import { RailIcon, type RailIconName } from "./rail-icons.js";
import "./rail-and-pills.css";

/**
 * `IconRail` — the floating left-edge icon rail of the "Rail & Islands" shell
 * (#19.2, spec §1). A pill-shaped, vertically centred card split into three
 * affinity runs: the dockable PANELS (Navigate: Files / Search / Outline →
 * Versioning: History / Git → Author/Assist: Insert / Agent), then the layout
 * VIEW-MODES (Focus / Agent mode — one mutually-exclusive axis), then the app
 * CHROME (theme, shortcuts, and the Settings gear) at its foot. The Outline icon
 * docks the document heading navigator (relocated out of the center stats block).
 *
 * PRESENTATIONAL + CONTROLLED: the host owns the dock state and every handler;
 * this renders buttons. The moved topbar controls KEEP their data-testids and
 * accessible names (history-button, git-sync-button, theme-toggle,
 * shortcuts-button, focus-mode-toggle) so the existing e2e suite drives the
 * same affordances in their new home. #19.7 retired the rail-foot "Aa" prefs
 * dock (editor-prefs-button); a small gear in its slot opens the unified
 * `/settings` surface, preferences' new home.
 */
export interface IconRailProps {
  /** The currently docked panel (drives the active icon), or null. */
  dock: DockId | null;
  /** Whether the agent sidebar tile is expanded (drives the Agent icon). */
  agentOpen: boolean;
  themeMode: ThemeMode;
  focusMode: boolean;
  /** Agent mode (#14): the mirror of focus mode (hide editor → agent+preview). */
  agentMode: boolean;
  onToggleDock: (id: DockId) => void;
  onToggleAgent: () => void;
  onToggleTheme: () => void;
  onToggleFocus: () => void;
  onToggleAgentMode: () => void;
  onShowShortcuts: () => void;
}

/**
 * One rail icon button; `active` paints the docked/pressed state.
 *
 * B10 — rail navigation clarity: the compact icon stays, but a CSS-revealed
 * label flyout (`.rail-tip`) surfaces the accessible name on hover/focus — a
 * real affordance that also shows on keyboard focus and (unlike a native
 * `title`) reads on touch. The native `title` is kept as a belt-and-braces
 * fallback for assistive tech / non-CSS contexts; the visible tip mirrors the
 * button's `aria-label` so the two never drift. The glyph itself is a shared
 * stroke-frame `RailIcon` (see rail-icons.tsx) so every icon is optically equal.
 */
function RailButton({
  icon,
  label,
  title,
  testId,
  active,
  onClick,
}: {
  icon: RailIconName;
  label: string;
  title: string;
  testId: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rail-btn${active ? " is-active" : ""}`}
      data-testid={testId}
      aria-label={label}
      aria-pressed={active ?? false}
      title={title}
      onClick={onClick}
    >
      <RailIcon name={icon} />
      {/* Visible-on-hover/focus label flyout. aria-hidden: the button already
          carries the accessible name via aria-label, so this is purely visual
          and must not be announced twice. */}
      <span className="rail-tip" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

export function IconRail({
  dock,
  agentOpen,
  themeMode,
  focusMode,
  agentMode,
  onToggleDock,
  onToggleAgent,
  onToggleTheme,
  onToggleFocus,
  onToggleAgentMode,
  onShowShortcuts,
}: IconRailProps) {
  return (
    <nav className="icon-rail" data-testid="icon-rail" aria-label="Workspace panels">
      {/* Panels, ordered by affinity: NAVIGATE (move through the project + the
          document) → VERSIONING (snapshots + remote sync) → AUTHOR + ASSIST.
          Outline sits with its navigation siblings (Files / Search), not after
          the versioning controls. */}
      <div className="rail-group">
        <RailButton
          icon="files"
          label="Files"
          title="Files — the project file list"
          testId="rail-files"
          active={dock === "files"}
          onClick={() => onToggleDock("files")}
        />
        <RailButton
          icon="search"
          label="Search in files"
          title="Search — find text across the open project (⌘⇧F)"
          testId="rail-search"
          active={dock === "search"}
          onClick={() => onToggleDock("search")}
        />
        <RailButton
          icon="outline"
          label="Outline"
          title="Outline — jump to a heading"
          testId="rail-outline"
          active={dock === "outline"}
          onClick={() => onToggleDock("outline")}
        />
        <RailButton
          icon="history"
          label="Version history"
          title="Version history — save and restore snapshots"
          testId="history-button"
          active={dock === "history"}
          onClick={() => onToggleDock("history")}
        />
        <RailButton
          icon="git"
          label="Git sync"
          title="Git sync (push / fetch to a git remote)"
          testId="git-sync-button"
          active={dock === "git"}
          onClick={() => onToggleDock("git")}
        />
        <RailButton
          icon="insert"
          label="Insert"
          title="Insert — figure, citation, or imported document"
          testId="insert-button"
          active={dock === "insert"}
          onClick={() => onToggleDock("insert")}
        />
        <RailButton
          icon="agent"
          label="Agent panel"
          title="AI agent panel"
          testId="rail-agent"
          active={agentOpen}
          onClick={onToggleAgent}
        />
      </div>
      <div className="rail-divider" aria-hidden="true" />
      {/* View-modes: mutually-exclusive ways to reshape the workspace (one layout
          axis, not chrome). Kept together and apart from the chrome below. */}
      <div className="rail-group">
        <RailButton
          icon="focus"
          label="Focus mode"
          title="Focus mode (hide the file list and agent panel)"
          testId="focus-mode-toggle"
          active={focusMode}
          onClick={onToggleFocus}
        />
        <RailButton
          icon="agentMode"
          label="Agent mode"
          title="Agent mode (hide the editor — agent + preview)"
          testId="agent-mode-toggle"
          active={agentMode}
          onClick={onToggleAgentMode}
        />
      </div>
      <div className="rail-divider" aria-hidden="true" />
      {/* App chrome: theme, shortcuts, and the Settings page (the gear sits last,
          the conventional bottom-of-rail home for settings). */}
      <div className="rail-group rail-foot">
        <RailButton
          icon={themeMode === "dark" ? "sun" : "moon"}
          label="Toggle dark mode"
          title="Toggle dark mode (⌘J)"
          testId="theme-toggle"
          onClick={onToggleTheme}
        />
        <RailButton
          icon="command"
          label="Keyboard shortcuts"
          title="Keyboard shortcuts (⌘/)"
          testId="shortcuts-button"
          onClick={onShowShortcuts}
        />
        {/* Settings is NOT document-scoped — it lives on the Projects page and
            the account menu (and `⌘,`). No gear in the editor's rail. */}
      </div>
    </nav>
  );
}
