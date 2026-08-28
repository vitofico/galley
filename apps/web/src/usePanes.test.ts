import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULTS,
  PANES_KEY,
  defaultState,
  sanitize,
  loadState,
  saveState,
  resizeAt,
  pxToFr,
  gridVars,
} from "./usePanes.js";

/** A tiny in-memory localStorage so the pure persistence helpers are testable. */
function installMemoryStorage(): Record<string, string> {
  const backing: Record<string, string> = {};
  const store = {
    getItem: (k: string) => (k in backing ? backing[k] : null),
    setItem: (k: string, v: string) => {
      backing[k] = String(v);
    },
    removeItem: (k: string) => {
      delete backing[k];
    },
    clear: () => {
      for (const k of Object.keys(backing)) delete backing[k];
    },
  };
  vi.stubGlobal("localStorage", store);
  return backing;
}

describe("defaults", () => {
  it("single-file defaults match the pre-#11.1 grid (1 / 1.12 / 0.92)", () => {
    expect(defaultState("single").sizes).toEqual({ editor: 1, center: 1.12, sidebar: 0.92 });
    expect(defaultState("single").collapsed).toEqual({});
  });

  it("project defaults match the 4-col grid (0.5 / 1 / 1.12 / 0.92)", () => {
    expect(defaultState("project").sizes).toEqual({
      files: 0.5,
      editor: 1,
      center: 1.12,
      sidebar: 0.92,
    });
  });

  it("gridVars at defaults emit fr values identical to the CSS template", () => {
    const s = defaultState("single");
    expect(gridVars("single", s.sizes, s.collapsed)).toEqual({
      "--col-editor": "1fr",
      "--col-center": "1.12fr",
      "--col-sidebar": "0.92fr",
    });
  });
});

describe("resizeAt (drag math)", () => {
  it("moves weight from the right column into the left one, conserving the joint total", () => {
    const sizes = { ...DEFAULTS.single };
    const next = resizeAt("single", sizes, 0, 0.3); // editor|center joint
    expect(next.editor).toBeCloseTo(1.3);
    expect(next.center).toBeCloseTo(0.82);
    // sidebar untouched; total of the pair preserved
    expect(next.sidebar).toBe(0.92);
    expect(next.editor! + next.center!).toBeCloseTo(2.12);
  });

  it("clamps so neither side drops below the minimum", () => {
    const sizes = { ...DEFAULTS.single };
    const next = resizeAt("single", sizes, 0, -999); // drag editor to nothing
    expect(next.editor).toBeGreaterThanOrEqual(0.18);
    expect(next.editor! + next.center!).toBeCloseTo(2.12); // total still conserved
  });

  it("is a no-op past the last joint", () => {
    const sizes = { ...DEFAULTS.single };
    expect(resizeAt("single", sizes, 2, 0.5)).toEqual(sizes); // no right neighbour
  });
});

describe("pxToFr", () => {
  it("maps a pixel delta to an fr delta against the visible fr total", () => {
    const sizes = { ...DEFAULTS.single }; // visible total = 3.04
    // Half the container width => half the fr total.
    expect(pxToFr("single", sizes, {}, 500, 1000)).toBeCloseTo(3.04 / 2);
  });

  it("ignores collapsed columns in the visible total", () => {
    const sizes = { ...DEFAULTS.single };
    const collapsed = { sidebar: true }; // visible total = 2.12
    expect(pxToFr("single", sizes, collapsed, 1000, 1000)).toBeCloseTo(2.12);
  });

  it("returns 0 for a zero-width container", () => {
    expect(pxToFr("single", DEFAULTS.single, {}, 100, 0)).toBe(0);
  });
});

describe("collapse", () => {
  it("a collapsed column emits 0fr from gridVars", () => {
    const s = defaultState("project");
    const vars = gridVars("project", s.sizes, { sidebar: true, files: true });
    expect(vars["--col-sidebar"]).toBe("0fr");
    expect(vars["--col-files"]).toBe("0fr");
    expect(vars["--col-editor"]).toBe("1fr");
  });
});

describe("sanitize", () => {
  it("drops unknown columns and clamps undersized ones", () => {
    const s = sanitize("single", {
      sizes: { editor: 0.0001, center: 2, bogus: 9 },
      collapsed: { sidebar: true, bogus: true },
    });
    expect(s.sizes.editor).toBeGreaterThanOrEqual(0.18);
    expect(s.sizes.center).toBe(2);
    expect((s.sizes as Record<string, unknown>).bogus).toBeUndefined();
    expect(s.collapsed).toEqual({ sidebar: true });
  });

  it("returns defaults for garbage", () => {
    expect(sanitize("single", null)).toEqual(defaultState("single"));
    expect(sanitize("single", 42)).toEqual(defaultState("single"));
  });

  it("only honours collapse flags for collapsible columns", () => {
    // editor is not collapsible in single layout
    const s = sanitize("single", { collapsed: { editor: true } });
    expect(s.collapsed).toEqual({});
  });
});

describe("persistence round-trip", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("loadState returns defaults when nothing is stored", () => {
    expect(loadState("single")).toEqual(defaultState("single"));
  });

  it("saveState then loadState restores sizes + collapsed", () => {
    const state = { sizes: { editor: 1.5, center: 0.8, sidebar: 0.74 }, collapsed: { sidebar: true } };
    saveState("single", state);
    expect(loadState("single")).toEqual(state);
  });

  it("keeps sibling layouts independent under the one versioned key", () => {
    saveState("single", { sizes: { editor: 2, center: 1, sidebar: 1 }, collapsed: {} });
    saveState("project", {
      sizes: { files: 0.3, editor: 1, center: 1, sidebar: 1 },
      collapsed: { files: true },
    });
    // Saving project must not clobber single.
    expect(loadState("single").sizes.editor).toBe(2);
    expect(loadState("project").collapsed.files).toBe(true);
  });

  it("survives a corrupt payload (falls back to defaults)", () => {
    localStorage.setItem(PANES_KEY, "{not json");
    expect(loadState("single")).toEqual(defaultState("single"));
  });
});

describe("rail layout (#19.2 — Rail & Islands shell)", () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it("tiles editor/center/sidebar only (files lives in the dock)", () => {
    // The preview (center) is weighted wider than the editor by default so a page
    // renders legibly out of the box (see usePanes DEFAULTS.rail). The agent
    // (sidebar) share is unchanged; the extra preview width comes from the editor.
    expect(defaultState("rail").sizes).toEqual({ editor: 0.62, center: 1.5, sidebar: 0.92 });
    const s = defaultState("rail");
    expect(Object.keys(gridVars("rail", s.sizes, s.collapsed))).toEqual([
      "--col-editor",
      "--col-center",
      "--col-sidebar",
    ]);
  });

  it("persists the files dock choice as a collapse flag without a files column", () => {
    saveState("rail", { sizes: defaultState("rail").sizes, collapsed: { files: true } });
    const restored = loadState("rail");
    expect(restored.collapsed.files).toBe(true);
    // The flag never leaks into the grid track vars.
    expect(gridVars("rail", restored.sizes, restored.collapsed)["--col-files"]).toBeUndefined();
  });
});
