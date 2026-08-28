import { describe, it, expect } from "vitest";
import { buildTrackList } from "./SplitPanes.js";
import { PROJECT_COLS, SINGLE_COLS, type ColName } from "../usePanes.js";

const collapsedIn = (set: ColName[]) => (c: ColName) => set.includes(c);

describe("buildTrackList", () => {
  it("nothing collapsed: 4 pane tracks interleaved with 3 splitter tracks", () => {
    const tracks = buildTrackList([...PROJECT_COLS], collapsedIn([]));
    expect(tracks).toEqual([
      "var(--col-files)", "6px",
      "var(--col-editor)", "6px",
      "var(--col-center)", "6px",
      "var(--col-sidebar)",
    ]);
  });

  it("files collapsed: the files|editor joint is dropped entirely — no 0px ghost track", () => {
    const tracks = buildTrackList([...PROJECT_COLS], collapsedIn(["files"]));
    expect(tracks).toEqual([
      "var(--col-files)",
      "var(--col-editor)", "6px",
      "var(--col-center)", "6px",
      "var(--col-sidebar)",
    ]);
    // The regression guard: no dead splitter track, and the editor track follows files directly.
    expect(tracks).not.toContain("0px");
    expect(tracks[1]).toBe("var(--col-editor)");
  });

  it("sidebar collapsed: the center|sidebar joint is dropped", () => {
    const tracks = buildTrackList([...PROJECT_COLS], collapsedIn(["sidebar"]));
    expect(tracks).toEqual([
      "var(--col-files)", "6px",
      "var(--col-editor)", "6px",
      "var(--col-center)",
      "var(--col-sidebar)",
    ]);
    expect(tracks).not.toContain("0px");
  });

  it("files + sidebar both collapsed: both joints dropped, only editor|center splitter remains", () => {
    const tracks = buildTrackList([...PROJECT_COLS], collapsedIn(["files", "sidebar"]));
    expect(tracks).toEqual([
      "var(--col-files)",
      "var(--col-editor)", "6px",
      "var(--col-center)",
      "var(--col-sidebar)",
    ]);
    expect(tracks).not.toContain("0px");
    expect(tracks.filter((t) => t === "6px").length).toBe(1);
  });

  it("honors a custom splitterPx (the param is real)", () => {
    const tracks = buildTrackList([...PROJECT_COLS], collapsedIn([]), 8);
    expect(tracks.filter((t) => t === "8px").length).toBe(3);
    expect(tracks).not.toContain("6px");
  });

  it("single-file layout (3 panes), sidebar collapsed: the center|sidebar joint is dropped", () => {
    const tracks = buildTrackList([...SINGLE_COLS], collapsedIn(["sidebar"]));
    expect(tracks).toEqual([
      "var(--col-editor)", "6px",
      "var(--col-center)",
      "var(--col-sidebar)",
    ]);
    expect(tracks).not.toContain("0px");
  });
});
