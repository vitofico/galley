import { describe, it, expect } from "vitest";
import {
  clampMenuPosition,
  menuAnchor,
  treeMenuItems,
} from "./file-tree-menu.js";

describe("treeMenuItems (the pure context-menu item core)", () => {
  it("a non-main file gets set-main, rename, delete — in that order", () => {
    const items = treeMenuItems({
      kind: "file",
      fileId: "f1",
      path: "/chapters/intro.typ",
      isMain: false,
    });
    expect(items.map((i) => i.id)).toEqual(["set-main", "rename-file", "delete-file"]);
  });

  it("the main file gets NO set-main item (mirrors the row's conditional button)", () => {
    const items = treeMenuItems({
      kind: "file",
      fileId: "f1",
      path: "/main.typ",
      isMain: true,
    });
    expect(items.map((i) => i.id)).toEqual(["rename-file", "delete-file"]);
  });

  it("a folder gets new-file-in-folder, new-subfolder and rename-folder — in that order", () => {
    const items = treeMenuItems({ kind: "folder", path: "/chapters" });
    expect(items.map((i) => i.id)).toEqual([
      "new-file-in-folder",
      "new-subfolder",
      "rename-folder",
    ]);
  });

  it("a binary asset gets preview, rename, download, delete — and NEVER set-main", () => {
    const items = treeMenuItems({ kind: "binary", fileId: "b1", path: "/logo.png" });
    expect(items.map((i) => i.id)).toEqual([
      "preview-binary",
      "rename-binary",
      "download-binary",
      "delete-binary",
    ]);
  });

  it("every item carries a non-empty label", () => {
    for (const target of [
      { kind: "file", fileId: "f", path: "/a.typ", isMain: false } as const,
      { kind: "folder", path: "/dir" } as const,
      { kind: "binary", fileId: "b", path: "/img.png" } as const,
    ]) {
      for (const item of treeMenuItems(target)) {
        expect(item.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("clampMenuPosition (keep the menu inside the viewport)", () => {
  const menu = { width: 200, height: 100 };
  const viewport = { width: 1000, height: 800 };

  it("leaves an anchor that already fits untouched", () => {
    expect(clampMenuPosition({ x: 300, y: 400 }, menu, viewport)).toEqual({ x: 300, y: 400 });
  });

  it("shifts back from the right and bottom edges (default 8px margin)", () => {
    expect(clampMenuPosition({ x: 950, y: 780 }, menu, viewport)).toEqual({
      x: 1000 - 200 - 8,
      y: 800 - 100 - 8,
    });
  });

  it("never goes above the margin floor, even off the top-left", () => {
    expect(clampMenuPosition({ x: -50, y: -50 }, menu, viewport)).toEqual({ x: 8, y: 8 });
  });

  it("a menu larger than the viewport pins to the margin (no negative coords)", () => {
    expect(
      clampMenuPosition({ x: 100, y: 100 }, { width: 2000, height: 2000 }, viewport),
    ).toEqual({ x: 8, y: 8 });
  });

  it("honors a custom margin", () => {
    expect(clampMenuPosition({ x: 999, y: 0 }, menu, viewport, 0)).toEqual({ x: 800, y: 0 });
  });
});

describe("menuAnchor (pointer point vs keyboard row anchor)", () => {
  it("uses the pointer coordinates when present", () => {
    expect(menuAnchor(120, 240, { left: 10, bottom: 30 })).toEqual({ x: 120, y: 240 });
  });

  it("a (0,0) keyboard-synthesized event anchors at the row's bottom-left", () => {
    expect(menuAnchor(0, 0, { left: 10, bottom: 30 })).toEqual({ x: 10, y: 30 });
  });

  it("a click exactly at x=0 with a real y stays a pointer anchor", () => {
    expect(menuAnchor(0, 5, { left: 10, bottom: 30 })).toEqual({ x: 0, y: 5 });
  });
});
