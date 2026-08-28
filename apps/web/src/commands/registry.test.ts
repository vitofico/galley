import { describe, it, expect } from "vitest";
import {
  createCommandRegistry,
  fuzzyScore,
  commandScore,
  filterCommands,
  groupCommands,
  fileOpenCommands,
  type Command,
} from "./registry.js";

/**
 * CommandRegistry (#19.1) tests — the single source of action truth behind the
 * ⌘K palette. Pure node-env tests per the house pattern (no jsdom): the
 * registry, the hand-rolled fuzzy matcher, the filter/group helpers, and the
 * "Open <path>" file-entry builder.
 */

const cmd = (over: Partial<Command> & { id: string }): Command => ({
  title: over.id,
  group: "Test",
  run: () => {},
  ...over,
});

describe("createCommandRegistry (#19.1)", () => {
  it("lists registered commands in registration order", () => {
    const reg = createCommandRegistry([cmd({ id: "a" }), cmd({ id: "b" })]);
    reg.register(cmd({ id: "c" }));
    expect(reg.list().map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("looks up a command by id and returns undefined for unknown ids", () => {
    const reg = createCommandRegistry([cmd({ id: "a", title: "Alpha" })]);
    expect(reg.get("a")?.title).toBe("Alpha");
    expect(reg.get("nope")).toBeUndefined();
  });

  it("re-registering an id replaces the command in place (stable position)", () => {
    const reg = createCommandRegistry([cmd({ id: "a" }), cmd({ id: "b" })]);
    reg.register(cmd({ id: "a", title: "Alpha v2" }));
    expect(reg.list().map((c) => c.id)).toEqual(["a", "b"]);
    expect(reg.get("a")?.title).toBe("Alpha v2");
  });

  it("list() excludes commands whose available() is false; listAll() keeps them", () => {
    const reg = createCommandRegistry([
      cmd({ id: "on", available: () => true }),
      cmd({ id: "off", available: () => false }),
      cmd({ id: "default" }), // no available() → always listed
    ]);
    expect(reg.list().map((c) => c.id)).toEqual(["on", "default"]);
    expect(reg.listAll().map((c) => c.id)).toEqual(["on", "off", "default"]);
  });

  it("availability is re-evaluated on every list() (live gating)", () => {
    let ok = false;
    const reg = createCommandRegistry([cmd({ id: "a", available: () => ok })]);
    expect(reg.list()).toHaveLength(0);
    ok = true;
    expect(reg.list()).toHaveLength(1);
  });

  it("run() executes an available command and reports true", () => {
    const ran: string[] = [];
    const reg = createCommandRegistry([cmd({ id: "a", run: () => ran.push("a") })]);
    expect(reg.run("a")).toBe(true);
    expect(ran).toEqual(["a"]);
  });

  it("run() refuses an unavailable command (conduct rule: never run when available() is false)", () => {
    const ran: string[] = [];
    const reg = createCommandRegistry([
      cmd({ id: "off", available: () => false, run: () => ran.push("off") }),
    ]);
    expect(reg.run("off")).toBe(false);
    expect(reg.run("missing")).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("fuzzyScore (#19.1) — hand-rolled subsequence matcher, no deps", () => {
  it("matches a case-insensitive substring", () => {
    expect(fuzzyScore("dark", "Toggle dark mode")).not.toBeNull();
    expect(fuzzyScore("DARK", "toggle dark mode")).not.toBeNull();
  });

  it("matches a scattered subsequence", () => {
    expect(fuzzyScore("tdm", "Toggle dark mode")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "Toggle dark mode")).toBeNull();
    expect(fuzzyScore("darkk", "dark")).toBeNull();
  });

  it("an empty query matches everything with a zero score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("scores a word-start + consecutive run above a scattered match", () => {
    const tight = fuzzyScore("dark", "Toggle dark mode")!;
    const scattered = fuzzyScore("dark", "Standard worksheet")!; // d-a-r-k scattered
    expect(tight).toBeGreaterThan(scattered);
  });

  it("scores a path segment start (after '/') as a word start", () => {
    const seg = fuzzyScore("intro", "Open /intro.typ")!;
    const mid = fuzzyScore("ntro", "Open /intro.typ")!;
    expect(seg).toBeGreaterThan(mid);
  });
});

describe("commandScore + filterCommands (#19.1)", () => {
  it("matches against the title and the keywords", () => {
    const c = cmd({ id: "theme", title: "Toggle dark mode", keywords: ["theme", "appearance"] });
    expect(commandScore("dark", c)).not.toBeNull();
    expect(commandScore("appear", c)).not.toBeNull();
    expect(commandScore("zzz", c)).toBeNull();
  });

  it("an empty query returns every command in the given order", () => {
    const cmds = [cmd({ id: "a" }), cmd({ id: "b" })];
    expect(filterCommands(cmds, "  ").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("filters non-matches out and ranks the better match first", () => {
    const cmds = [
      cmd({ id: "ws", title: "Standard worksheet" }),
      cmd({ id: "theme", title: "Toggle dark mode" }),
      cmd({ id: "git", title: "Git sync" }),
    ];
    const hits = filterCommands(cmds, "dark");
    expect(hits.map((c) => c.id)).toEqual(["theme", "ws"]); // word-start beats scattered; "git" drops
  });

  it("ties keep the original (registration) order — stable sort", () => {
    const cmds = [cmd({ id: "a", title: "Open /a.typ" }), cmd({ id: "b", title: "Open /b.typ" })];
    expect(filterCommands(cmds, "open").map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("groupCommands (#19.1)", () => {
  it("buckets by group preserving first-seen group order and item order", () => {
    const cmds = [
      cmd({ id: "a", group: "File" }),
      cmd({ id: "b", group: "View" }),
      cmd({ id: "c", group: "File" }),
    ];
    const groups = groupCommands(cmds);
    expect(groups.map((g) => g.group)).toEqual(["File", "View"]);
    expect(groups[0]!.items.map((c) => c.id)).toEqual(["a", "c"]);
    expect(groups[1]!.items.map((c) => c.id)).toEqual(["b"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupCommands([])).toEqual([]);
  });
});

describe("fileOpenCommands (#19.1) — 'Open <path>' palette entries", () => {
  const files = [
    { fileId: "f1", path: "/main.typ" },
    { fileId: "f2", path: "/intro.typ" },
  ];

  it("builds one 'Open <path>' command per file under the Files group", () => {
    const cmds = fileOpenCommands(files, () => {});
    expect(cmds.map((c) => c.title)).toEqual(["Open /main.typ", "Open /intro.typ"]);
    expect(cmds.every((c) => c.group === "Files")).toBe(true);
    expect(new Set(cmds.map((c) => c.id)).size).toBe(2); // stable unique ids
  });

  it("running an entry hands the file id to the callback (switches the active file)", () => {
    const opened: string[] = [];
    const cmds = fileOpenCommands(files, (id) => opened.push(id));
    cmds[1]!.run();
    expect(opened).toEqual(["f2"]);
  });

  it("entries are findable by their path via the fuzzy filter", () => {
    const cmds = fileOpenCommands(files, () => {});
    expect(filterCommands(cmds, "intro").map((c) => c.title)).toEqual(["Open /intro.typ"]);
  });
});
