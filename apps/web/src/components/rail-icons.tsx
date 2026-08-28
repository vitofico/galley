/**
 * `rail-icons` — the stroke-based vector icon set for the left `IconRail`.
 *
 * WHY THIS EXISTS: the rail previously rendered single Unicode glyphs (`⌕`, `⟲`,
 * `▤`, …). Those characters carry their own font metrics, so they rendered at
 * wildly different optical sizes and weights — "Search" (`⌕`) and "Version
 * history" (`⟲`) looked tiny next to the chunky `✚`/`▤`, and the whole set
 * drifted across OSes/fonts. These are hand-rolled Lucide-style line icons on a
 * single shared 24×24 frame: one viewBox, one stroke width, `currentColor`, so
 * every icon is optically equal and themed by the button's `color` alone (the
 * `.rail-btn` ink / hover-ink / active-accent cascade in rail-and-pills.css).
 *
 * Each entry below is ONLY the inner geometry; `RailIcon` owns the frame so the
 * uniformity can never drift per-icon.
 */
import type { ReactNode } from "react";

export type RailIconName =
  | "files"
  | "search"
  | "outline"
  | "history"
  | "git"
  | "insert"
  | "agent"
  | "focus"
  | "agentMode"
  | "moon"
  | "sun"
  | "command";

/** Inner SVG geometry per icon, drawn on the shared 24×24 frame `RailIcon` owns. */
const GEOMETRY: Record<RailIconName, ReactNode> = {
  // Files — a document (the project file list toggle).
  files: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h8" />
      <path d="M8 9h2" />
    </>
  ),
  // Search — magnifying glass.
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  // Outline — a bulleted list (jump to a heading).
  outline: (
    <>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <path d="M3.5 6h.01" />
      <path d="M3.5 12h.01" />
      <path d="M3.5 18h.01" />
    </>
  ),
  // Version history — a clock with a counter-clockwise restore arrow.
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  // Git sync — push / fetch (two opposing arrows).
  git: (
    <>
      <path d="m17 4 0 16" />
      <path d="m21 16-4 4-4-4" />
      <path d="M7 20 7 4" />
      <path d="m3 8 4-4 4 4" />
    </>
  ),
  // Insert — a plus (figure, citation, imported document).
  insert: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  // Agent — a sparkle.
  agent: (
    <>
      <path d="M11.5 3.2a.5.5 0 0 1 .95 0l1.6 4.55a3 3 0 0 0 1.85 1.85l4.55 1.6a.5.5 0 0 1 0 .95l-4.55 1.6a3 3 0 0 0-1.85 1.85l-1.6 4.55a.5.5 0 0 1-.95 0l-1.6-4.55a3 3 0 0 0-1.85-1.85l-4.55-1.6a.5.5 0 0 1 0-.95l4.55-1.6a3 3 0 0 0 1.85-1.85z" />
      <path d="M19 3v3.5" />
      <path d="M20.75 4.75h-3.5" />
    </>
  ),
  // Focus mode — panel frame with the divider toward the LEFT (sidebar emphasis).
  focus: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  // Agent mode — panel frame with the divider toward the RIGHT (mirror of focus).
  agentMode: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  // Theme — moon (switch to dark).
  moon: <path d="M12 3a6.5 6.5 0 1 0 9 9 9 9 0 1 1-9-9Z" />,
  // Theme — sun (switch to light).
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  // Keyboard shortcuts — the command key.
  command: (
    <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
  ),
};

/**
 * One rail icon, drawn on the shared 24×24 frame. Purely decorative
 * (`aria-hidden`): the `.rail-btn` carries the accessible name. Stroke is
 * `currentColor`, so it inherits the button's themed ink/accent.
 */
export function RailIcon({ name }: { name: RailIconName }) {
  return (
    <svg
      className="rail-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GEOMETRY[name]}
    </svg>
  );
}
