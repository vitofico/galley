/**
 * `SplitPanes` — a hand-rolled, dependency-free resizable/collapsible grid shell
 * (roadmap #11.1). Panes are laid out in a CSS grid whose flexible tracks are
 * driven by `--col-*` custom properties from `usePanes`; thin fixed-width
 * splitter tracks sit between adjacent panes.
 *
 * Dragging a splitter resizes the two panes it joins (live). Double-clicking a
 * splitter resets the whole layout to defaults. Collapse toggles live inside the
 * relevant panes (the consumer renders them); a collapsed column is driven to
 * `0fr` and its splitter hidden.
 *
 * No external resize library: pointer events + a window-level move/up listener.
 */
import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { type ColName, type UsePanes, MIN_FR } from "../usePanes.js";
import { splitKeyStepPx, splitterAria } from "./split-keyboard.js";

const SPLITTER_PX = 6;

/**
 * The grid `grid-template-columns` track list for the rendered panes: one track
 * per pane, interleaved with a splitter track ONLY where a splitter is actually
 * rendered. A hidden splitter (either adjacent pane collapsed) contributes NO
 * track — emitting a 0px ghost track would desync tracks from DOM children and
 * shove a visible pane into the dead slot (the files-collapse → editor-vanishes bug).
 */
export function buildTrackList(
  cols: ColName[],
  isCollapsed: (c: ColName) => boolean,
  splitterPx: number = SPLITTER_PX,
): string[] {
  const tracks: string[] = [];
  cols.forEach((col, i) => {
    tracks.push(`var(--col-${col})`);
    const next = cols[i + 1];
    if (next && !(isCollapsed(col) || isCollapsed(next))) {
      tracks.push(`${splitterPx}px`);
    }
  });
  return tracks;
}

export type Pane = {
  col: ColName;
  /** The pane's rendered content. */
  node: ReactNode;
};

/** A single draggable splitter sitting at the joint after pane `index`. */
function Splitter({
  index,
  panes,
  leftFr,
  rightFr,
  onBegin,
  onNudge,
  onReset,
}: {
  index: number;
  panes: Pane[];
  /** `fr` weights of the two panes this splitter joins (for the ARIA range). */
  leftFr: number;
  rightFr: number;
  onBegin: (index: number, clientX: number) => void;
  /** L9: keyboard nudge — a signed pixel delta through the same resize pipeline. */
  onNudge: (index: number, deltaPx: number) => void;
  onReset: () => void;
}) {
  const left = panes[index]?.col;
  const right = panes[index + 1]?.col;
  // L9: a focusable separator that announces its position + responds to arrows
  // (ARIA "window splitter" pattern). A vertical separator resizes horizontally,
  // so Left/Right move it; the value is the LEFT pane's share of this joint.
  const aria = splitterAria(leftFr, rightFr, MIN_FR);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={left && right ? `Resize ${left} and ${right} panes` : "Resize panes"}
      aria-valuenow={aria.now}
      aria-valuemin={aria.min}
      aria-valuemax={aria.max}
      tabIndex={0}
      className="pane-splitter"
      data-testid="splitter"
      data-left={left}
      data-right={right}
      onPointerDown={(e) => {
        // Only the primary button drags; capture so we keep events if the pointer
        // leaves the thin handle.
        if (e.button !== 0) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onBegin(index, e.clientX);
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        const deltaPx = splitKeyStepPx(e.key);
        if (deltaPx === 0) return;
        e.preventDefault();
        onNudge(index, deltaPx);
      }}
      onDoubleClick={onReset}
    >
      <span className="pane-splitter-grip" aria-hidden="true" />
    </div>
  );
}

export function SplitPanes({
  panes,
  controller,
  className,
}: {
  panes: Pane[];
  controller: UsePanes;
  className?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const dragging = useRef(false);
  const { vars, isCollapsed, beginResize, dragTo, endResize, reset } = controller;

  const containerWidth = () => ref.current?.clientWidth ?? 0;

  const onBegin = useCallback(
    (index: number, clientX: number) => {
      dragging.current = true;
      document.body.classList.add("panes-dragging");
      beginResize(index, { clientX }, containerWidth());
    },
    [beginResize],
  );

  // L9: a keyboard nudge is a discrete, immediately-settled drag through the SAME
  // pipeline (so it shares `resizeAt`'s MIN_FR clamp + persistence). The drag delta
  // is `clientX - startX`, so a start of 0 + a move of `deltaPx` applies exactly
  // `deltaPx` — no need for the splitter's real screen position.
  const onNudge = useCallback(
    (index: number, deltaPx: number) => {
      const w = containerWidth();
      beginResize(index, { clientX: 0 }, w);
      dragTo(deltaPx, w);
      endResize();
    },
    [beginResize, dragTo, endResize],
  );

  // Window-level move/up so a fast drag that outruns the 6px handle still tracks.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      dragTo(e.clientX, containerWidth());
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove("panes-dragging");
      endResize();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragTo, endResize]);

  // Build the grid track list. A collapsed pane's column is 0fr (from `vars`); the
  // splitter that would join it is dropped from BOTH the DOM and the track list so
  // tracks and children stay aligned (see buildTrackList).
  const tracks = buildTrackList(
    panes.map((p) => p.col),
    isCollapsed,
  );

  const style = {
    ...vars,
    gridTemplateColumns: tracks.join(" "),
  } as React.CSSProperties;

  return (
    <main ref={ref} className={className} style={style}>
      {panes.map((p, i) => {
        const next = panes[i + 1];
        return (
          <Fragmented key={p.col}>
            {p.node}
            {next && !(isCollapsed(p.col) || isCollapsed(next.col)) && (
              <Splitter
                index={i}
                panes={panes}
                leftFr={controller.state.sizes[p.col] ?? 0}
                rightFr={controller.state.sizes[next.col] ?? 0}
                onBegin={onBegin}
                onNudge={onNudge}
                onReset={reset}
              />
            )}
          </Fragmented>
        );
      })}
    </main>
  );
}

/** Splitters must be direct grid children, so we can't wrap pairs in a div. */
function Fragmented({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
