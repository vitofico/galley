import { useCallback, useState } from "react";
import {
  type CompileMode,
  COMPILE_MODES,
  loadMode,
  saveMode,
} from "./compiler-mode.js";
import "./compiler-mode-toggle.css";

/**
 * Compile-mode toggle (Enabler E2) — the reachable UI for the server-compile
 * path that previously only existed behind the `?serverCompile=1` URL flag.
 *
 * UNMOUNTED by design: this file mounts nowhere itself; the coordinator (Lane S)
 * mounts it into each shell's topbar and wires `onModeChange` to a compiler
 * remount. Conventions mirror EditorPrefs.tsx / the theme toggle: a small,
 * self-contained control that reads + persists its own state via the pure
 * `compiler-mode.ts` helpers (loadMode / saveMode), and exposes stable
 * data-testids for e2e.
 *
 * VISIBILITY: when the compiler is actually a SERVER compiler — either the chosen
 * "server" mode or an "auto" fallback that engaged — an indicator is shown. The
 * fallback case is never silent: a GENERIC reason is surfaced as a title/aria-
 * label (never raw error text or a URL — see compiler-mode.ts). When "server" is
 * chosen but no trusted compile URL is configured, a distinct "Server
 * unavailable — using local" indicator is shown so the downgrade is not silent
 * (E2 review C2).
 *
 * SCOPE (E2 review C4): this toggle governs the PREVIEW compiler ONLY. The agent
 * loop and figure generator still use the local worker in this wave. Lane S owns
 * the honest "applies to preview" labelling when mounting.
 */

const MODE_LABELS: Record<CompileMode, string> = {
  local: "Local",
  server: "Server",
  auto: "Auto",
};

const MODE_TITLES: Record<CompileMode, string> = {
  local: "Compile in this browser (the default, no network).",
  server: "Compile on the configured server (if available).",
  auto: "Local first; fall back to the server once if the local compiler fails.",
};

export interface CompilerModeToggleProps {
  /**
   * Called after the persisted mode changes (post-save). The shell uses this to
   * remount the compiler with the new mode. Optional so the control is usable in
   * isolation (e.g. in tests / storybook-style mounts).
   */
  onModeChange?: (mode: CompileMode) => void;
  /**
   * Whether the live compiler is currently a SERVER compiler (chosen server mode
   * or an engaged auto fallback). Drives the active indicator. Defaults to false.
   */
  serverActive?: boolean;
  /** Whether the one-shot auto fallback has fired. Drives the fallback badge. */
  fallbackActive?: boolean;
  /** Visible reason the fallback engaged; shown as the badge's tooltip/label. */
  fallbackReason?: string | null;
  /**
   * Whether `server` mode was selected but no trusted compile URL is configured,
   * so compilation silently stayed local. Drives the "Server unavailable"
   * indicator (E2 review C2). Defaults to false.
   */
  serverUnavailable?: boolean;
  /** Generic reason the server was unavailable; shown as the indicator's label. */
  serverUnavailableReason?: string | null;
  /**
   * Initial mode override (mainly for tests). Defaults to the persisted value via
   * {@link loadMode}.
   */
  initialMode?: CompileMode;
}

export function CompilerModeToggle({
  onModeChange,
  serverActive = false,
  fallbackActive = false,
  fallbackReason = null,
  serverUnavailable = false,
  serverUnavailableReason = null,
  initialMode,
}: CompilerModeToggleProps) {
  // Lazy initialiser: read storage once on mount (mirrors useEditorPrefs).
  const [mode, setModeState] = useState<CompileMode>(() => initialMode ?? loadMode());

  const select = useCallback(
    (next: CompileMode) => {
      setModeState((prev) => {
        if (prev === next) return prev;
        saveMode(next);
        onModeChange?.(next);
        return next;
      });
    },
    [onModeChange],
  );

  return (
    <div
      className="compiler-mode-toggle"
      data-testid="compiler-mode-toggle"
      role="group"
      aria-label="Compile mode"
    >
      {COMPILE_MODES.map((m) => (
        <button
          key={m}
          type="button"
          className="compiler-mode-option"
          data-testid={`compiler-mode-${m}`}
          aria-pressed={mode === m}
          aria-current={mode === m ? "true" : undefined}
          title={MODE_TITLES[m]}
          onClick={() => select(m)}
        >
          {MODE_LABELS[m]}
        </button>
      ))}

      {serverActive ? (
        <span
          className="compiler-mode-indicator"
          data-testid="compiler-mode-server-active"
          title={fallbackActive && fallbackReason ? fallbackReason : "Compiling on the server."}
          aria-label={
            fallbackActive && fallbackReason ? fallbackReason : "Compiling on the server"
          }
        >
          {fallbackActive ? "Server (fallback)" : "Server"}
        </span>
      ) : serverUnavailable ? (
        <span
          className="compiler-mode-indicator compiler-mode-indicator--unavailable"
          data-testid="compiler-mode-server-unavailable"
          title={serverUnavailableReason ?? "Server unavailable — using the local compiler."}
          aria-label={serverUnavailableReason ?? "Server unavailable — using the local compiler"}
        >
          Server unavailable
        </span>
      ) : null}
    </div>
  );
}
