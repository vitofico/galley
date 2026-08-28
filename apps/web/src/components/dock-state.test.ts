import { describe, it, expect } from "vitest";
import {
  DOCK_IDS,
  DOCK_TITLES,
  FILES_AUTO_COLLAPSE_MORPH_WIDTH,
  FILES_AUTO_COLLAPSE_WIDE_WIDTH,
  initialDockState,
  shouldBootFilesClosed,
  toggleDock,
  openDock,
  closeDock,
  closeDockIf,
  openInsertTab,
  type DockState,
} from "./dock-state.js";

describe("initialDockState", () => {
  it("boots with the Files panel docked by default", () => {
    expect(initialDockState(false)).toEqual({ open: "files", insertTab: "figure" });
  });

  it("respects an explicit prior files-closed choice", () => {
    expect(initialDockState(true).open).toBeNull();
  });
});

describe("shouldBootFilesClosed", () => {
  const mid = (FILES_AUTO_COLLAPSE_MORPH_WIDTH + FILES_AUTO_COLLAPSE_WIDE_WIDTH) / 2;

  it("auto-collapses in the laptop band when no explicit choice exists", () => {
    expect(shouldBootFilesClosed(null, 1280)).toBe(true);
    expect(shouldBootFilesClosed(undefined, 1440)).toBe(true);
    expect(shouldBootFilesClosed(null, mid)).toBe(true);
  });

  it("keeps Files open below the morph width and at/above the wide width", () => {
    // Below the morph breakpoint the shell is a tabbed stack (dock isn't a tile).
    expect(shouldBootFilesClosed(null, FILES_AUTO_COLLAPSE_MORPH_WIDTH - 1)).toBe(false);
    // The band is half-open [morph, wide): the wide bound itself stays open.
    expect(shouldBootFilesClosed(null, FILES_AUTO_COLLAPSE_WIDE_WIDTH)).toBe(false);
    expect(shouldBootFilesClosed(null, 1920)).toBe(false);
  });

  it("honors an explicit choice at any width, overriding the auto-collapse", () => {
    // Explicit OPEN beats the laptop auto-collapse…
    expect(shouldBootFilesClosed(false, 1280)).toBe(false);
    // …and explicit CLOSED sticks even on a wide screen.
    expect(shouldBootFilesClosed(true, 1920)).toBe(true);
  });

  it("never auto-collapses on a non-finite (pre-measure / SSR) width", () => {
    expect(shouldBootFilesClosed(null, Number.NaN)).toBe(false);
    expect(shouldBootFilesClosed(undefined, Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("toggleDock", () => {
  const base: DockState = { open: null, insertTab: "figure" };

  it("opens a closed panel", () => {
    expect(toggleDock(base, "history").open).toBe("history");
  });

  it("closes the panel that is already docked", () => {
    expect(toggleDock({ ...base, open: "git" }, "git").open).toBeNull();
  });

  it("is exclusive: docking one panel replaces another", () => {
    expect(toggleDock({ ...base, open: "files" }, "history").open).toBe("history");
  });

  it("does not disturb the remembered insert tab", () => {
    const s: DockState = { open: "insert", insertTab: "citation" };
    expect(toggleDock(s, "insert")).toEqual({ open: null, insertTab: "citation" });
  });
});

describe("openDock / closeDock / closeDockIf", () => {
  it("openDock is idempotent and exclusive", () => {
    const s = openDock({ open: "files", insertTab: "figure" }, "history");
    expect(s.open).toBe("history");
    expect(openDock(s, "history")).toEqual(s);
  });

  it("closeDock empties the dock", () => {
    expect(closeDock({ open: "insert", insertTab: "import" }).open).toBeNull();
  });

  it("closeDockIf only closes the panel it was issued for", () => {
    const history: DockState = { open: "history", insertTab: "figure" };
    expect(closeDockIf(history, "git")).toEqual(history); // stale close → no-op
    expect(closeDockIf(history, "history").open).toBeNull();
  });
});

describe("openInsertTab", () => {
  it("docks the insert panel at the requested tab", () => {
    const s = openInsertTab({ open: null, insertTab: "figure" }, "import");
    expect(s).toEqual({ open: "insert", insertTab: "import" });
  });

  it("switches tabs in place when the insert panel is already docked", () => {
    const s = openInsertTab({ open: "insert", insertTab: "import" }, "citation");
    expect(s).toEqual({ open: "insert", insertTab: "citation" });
  });

  it("replaces another docked panel", () => {
    expect(openInsertTab({ open: "files", insertTab: "figure" }, "figure").open).toBe("insert");
  });
});

describe("dock metadata", () => {
  it("every dockable panel has a card title", () => {
    for (const id of DOCK_IDS) expect(DOCK_TITLES[id]).toBeTruthy();
  });

  it("the editor-prefs dock is retired (#19.7 — prefs live on /settings)", () => {
    expect(DOCK_IDS).not.toContain("prefs");
    expect(DOCK_IDS).toEqual(["files", "search", "history", "git", "insert", "outline"]);
  });

  it("the document outline docks here (relocated from the center stats block)", () => {
    expect(DOCK_IDS).toContain("outline");
    expect(DOCK_TITLES.outline).toBe("Outline");
  });

  it("the in-document search panel docks here (Tier E #2)", () => {
    expect(DOCK_IDS).toContain("search");
    expect(DOCK_TITLES.search).toBe("Search");
  });
});
