import { describe, it, expect } from "vitest";
import type { Command } from "../commands/registry.js";
import {
  CommandPalette,
  paletteResults,
  flattenResults,
  moveSelection,
  executePaletteCommand,
} from "./CommandPalette.js";

/**
 * CommandPalette (#19.1) tests.
 *
 * Per the repo's Node-env house pattern (cf. TemplatePicker/ImportPanel: no
 * jsdom, no @testing-library/react), we don't render React here — we test the
 * exported PURE pieces the component is built from: the availability-respecting
 * fuzzy result pipeline, the flattened keyboard-selection model (wrap-around
 * ↑/↓), and the run gate (never executes an unavailable command; closes after a
 * successful run). The DOM surface (Mod-K open, typing, Enter/Escape) is covered
 * by the real e2e in apps/web/e2e/palette.spec.ts.
 */

const cmd = (over: Partial<Command> & { id: string }): Command => ({
  title: over.id,
  group: "Test",
  run: () => {},
  ...over,
});

describe("CommandPalette contract (#19.1)", () => {
  it("is a React function component taking a single props object", () => {
    expect(typeof CommandPalette).toBe("function");
    expect(CommandPalette.length).toBeLessThanOrEqual(1);
  });
});

describe("paletteResults (#19.1) — availability + fuzzy + grouping pipeline", () => {
  const commands = [
    cmd({ id: "export", title: "Export PDF", group: "File" }),
    cmd({ id: "theme", title: "Toggle dark mode", group: "View" }),
    cmd({ id: "hidden", title: "Hidden dark action", group: "View", available: () => false }),
    cmd({ id: "open-main", title: "Open /main.typ", group: "Files" }),
  ];

  it("an empty query lists every available command grouped in order", () => {
    const groups = paletteResults(commands, "");
    expect(groups.map((g) => g.group)).toEqual(["File", "View", "Files"]);
    expect(flattenResults(groups).map((c) => c.id)).toEqual(["export", "theme", "open-main"]);
  });

  it("never lists a command whose available() is false, even on a query hit", () => {
    const groups = paletteResults(commands, "dark");
    const ids = flattenResults(groups).map((c) => c.id);
    expect(ids).toContain("theme");
    expect(ids).not.toContain("hidden");
  });

  it("a query filters and returns no groups when nothing matches", () => {
    expect(paletteResults(commands, "zzzz")).toEqual([]);
  });

  it("file entries are findable by path", () => {
    const groups = paletteResults(commands, "main.typ");
    expect(flattenResults(groups).map((c) => c.id)).toEqual(["open-main"]);
  });
});

describe("moveSelection (#19.1) — wrap-around ↑/↓ over the flattened results", () => {
  it("moves down and wraps to the top", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
  });

  it("moves up and wraps to the bottom", () => {
    expect(moveSelection(1, -1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  it("stays at 0 for an empty result list", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(0, -1, 0)).toBe(0);
  });

  it("clamps an out-of-range index (results shrank under the cursor)", () => {
    expect(moveSelection(5, 1, 3)).toBe(0); // 5 clamps to last (2), +1 wraps to 0
    expect(moveSelection(5, 0, 3)).toBe(2);
  });
});

describe("executePaletteCommand (#19.1) — the run gate", () => {
  it("runs an available command, closes the palette, and reports true", () => {
    const events: string[] = [];
    const ok = executePaletteCommand(
      cmd({ id: "a", run: () => events.push("run") }),
      () => events.push("close"),
    );
    expect(ok).toBe(true);
    expect(events).toEqual(["run", "close"]);
  });

  it("refuses a command whose available() is false: no run, no close", () => {
    const events: string[] = [];
    const ok = executePaletteCommand(
      cmd({ id: "off", available: () => false, run: () => events.push("run") }),
      () => events.push("close"),
    );
    expect(ok).toBe(false);
    expect(events).toEqual([]);
  });

  it("refuses undefined (Enter with no results): no close", () => {
    const events: string[] = [];
    expect(executePaletteCommand(undefined, () => events.push("close"))).toBe(false);
    expect(events).toEqual([]);
  });
});
