import { describe, it, expect } from "vitest";
import { IdbProjectStore, InMemoryKeyValueBackend } from "../idb-project-store.js";
import {
  collectTags,
  filterProjects,
  normalizeProjectName,
  sortProjects,
  tagColor,
} from "./LibraryApp.js";
import type { Project } from "@galley/shared";

/**
 * Roadmap #12.3 — LibraryApp dashboard.
 *
 * The unit gate runs in the Node environment with NO DOM (no @testing-library/
 * react, no jsdom — see vitest.config.ts `environment: "node"` and the absence of
 * those deps). So we follow the repo's house pattern (cf. doc-stats): the
 * component is a thin shell over (a) pure exported helpers and (b) the injected
 * `ProjectStore`. We test the helpers directly, and exercise the exact store
 * interactions the component performs (create → reload, delete → reload,
 * per-user listing) against a real `IdbProjectStore` over the in-memory backend.
 */

function makeStore(): IdbProjectStore {
  return new IdbProjectStore({ backend: new InMemoryKeyValueBackend() });
}

function names(projects: readonly Project[]): string[] {
  return projects.map((p) => p.name);
}

describe("normalizeProjectName", () => {
  it("returns null for blank / whitespace-only input", () => {
    expect(normalizeProjectName("")).toBeNull();
    expect(normalizeProjectName("   ")).toBeNull();
    expect(normalizeProjectName("\t\n")).toBeNull();
  });

  it("trims surrounding whitespace from a real name", () => {
    expect(normalizeProjectName("  Thesis  ")).toBe("Thesis");
    expect(normalizeProjectName("Paper")).toBe("Paper");
  });
});

describe("sortProjects", () => {
  it("orders by name case-insensitively, then id", () => {
    const input: Project[] = [
      { id: "p3", name: "banana", ownerId: "u1" },
      { id: "p1", name: "Apple", ownerId: "u1" },
      { id: "p2", name: "apple", ownerId: "u1" },
    ];
    const sorted = sortProjects(input);
    expect(names(sorted)).toEqual(["Apple", "apple", "banana"]);
    // equal (case-insensitive) names fall back to id order
    expect(sorted[0]?.id).toBe("p1");
    expect(sorted[1]?.id).toBe("p2");
  });

  it("does not mutate its input", () => {
    const input: Project[] = [
      { id: "b", name: "b", ownerId: "u1" },
      { id: "a", name: "a", ownerId: "u1" },
    ];
    const before = [...input];
    sortProjects(input);
    expect(input).toEqual(before);
  });
});

describe("collectTags (#12.4)", () => {
  const P = (id: string, tags?: string[]): Project => ({ id, name: id, ownerId: "u", ...(tags ? { tags } : {}) });

  it("de-duplicates and sorts tags across projects, tolerating absent tags", () => {
    const projects = [P("a", ["physics", "draft"]), P("b"), P("c", ["draft", "alpha"])];
    expect(collectTags(projects)).toEqual(["alpha", "draft", "physics"]);
  });

  it("returns [] when no project has tags", () => {
    expect(collectTags([P("a"), P("b")])).toEqual([]);
  });
});

describe("tagColor (#12.4)", () => {
  it("is deterministic and returns an hsl() string", () => {
    expect(tagColor("physics")).toBe(tagColor("physics"));
    expect(tagColor("physics")).toMatch(/^hsl\(\d+ 52% 42%\)$/);
  });

  it("distinguishes different tags (different hues, overwhelmingly likely)", () => {
    expect(tagColor("physics")).not.toBe(tagColor("chemistry"));
  });
});

describe("filterProjects (#12.4)", () => {
  const P = (id: string, name: string, extra?: Partial<Project>): Project => ({
    id,
    name,
    ownerId: "u",
    ...extra,
  });
  const projects = [
    P("a", "Relativity", { tags: ["physics", "draft"] }),
    P("b", "Chemistry Notes", { tags: ["draft"] }),
    P("c", "Archived Thesis", { archived: true, tags: ["physics"] }),
    P("d", "Untagged"),
  ];

  it("hides archived projects unless showArchived", () => {
    const ids = filterProjects(projects, { query: "", tag: null, showArchived: false }).map((p) => p.id);
    expect(ids).toEqual(["a", "b", "d"]);
    const withArch = filterProjects(projects, { query: "", tag: null, showArchived: true }).map((p) => p.id);
    expect(withArch).toContain("c");
  });

  it("matches the query against name OR a tag, case-insensitively", () => {
    expect(filterProjects(projects, { query: "rela", tag: null, showArchived: false }).map((p) => p.id)).toEqual(["a"]);
    // "physics" is a TAG of 'a' (its name doesn't contain it) → still matches.
    expect(filterProjects(projects, { query: "PHYSICS", tag: null, showArchived: false }).map((p) => p.id)).toEqual(["a"]);
  });

  it("filters to an exact tag, and composes with archived visibility", () => {
    expect(filterProjects(projects, { query: "", tag: "draft", showArchived: false }).map((p) => p.id)).toEqual(["a", "b"]);
    // physics tag: 'a' (visible) and 'c' (archived) — only 'a' unless archived shown.
    expect(filterProjects(projects, { query: "", tag: "physics", showArchived: false }).map((p) => p.id)).toEqual(["a"]);
    expect(filterProjects(projects, { query: "", tag: "physics", showArchived: true }).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("tag filter + query compose (both must hold)", () => {
    expect(
      filterProjects(projects, { query: "chem", tag: "draft", showArchived: false }).map((p) => p.id),
    ).toEqual(["b"]);
    expect(filterProjects(projects, { query: "rela", tag: "draft", showArchived: false }).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("LibraryApp store interactions (load / create / delete / per-user)", () => {
  it("loads only the projects the user owns or is a member of", async () => {
    const store = makeStore();
    await store.createProject({ id: "mine-1", name: "Mine", ownerId: "alice" });
    await store.createProject({ id: "theirs-1", name: "Theirs", ownerId: "bob" });

    const forAlice = await store.listProjectsForUser("alice");
    expect(names(sortProjects(forAlice))).toEqual(["Mine"]);

    // a shared project the user is a member of also shows up
    await store.addMember("theirs-1", "alice", "editor");
    const forAliceShared = await store.listProjectsForUser("alice");
    expect(names(sortProjects(forAliceShared)).sort()).toEqual(["Mine", "Theirs"]);
  });

  it("reflects a newly created project after reload", async () => {
    const store = makeStore();
    expect(await store.listProjectsForUser("alice")).toEqual([]);

    const created = await store.createProject({ name: normalizeProjectName("  Draft ")!, ownerId: "alice" });
    expect(created.name).toBe("Draft");

    const after = await store.listProjectsForUser("alice");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(created.id);
  });

  it("removes a project (and its membership) after delete + reload", async () => {
    const store = makeStore();
    const a = await store.createProject({ name: "Keep", ownerId: "alice" });
    const b = await store.createProject({ name: "Drop", ownerId: "alice" });

    await store.deleteProject(b.id);

    const after = await store.listProjectsForUser("alice");
    expect(names(after)).toEqual(["Keep"]);
    expect(after.map((p) => p.id)).toEqual([a.id]);
  });

  it("starts empty for a user with no projects", async () => {
    const store = makeStore();
    const empty = await store.listProjectsForUser("nobody");
    expect(empty).toEqual([]);
  });

  it("archives + tags via updateProject, and filterProjects reflects it (#12.4)", async () => {
    const store = makeStore();
    const a = await store.createProject({ name: "Alpha", ownerId: "alice" });
    const b = await store.createProject({ name: "Beta", ownerId: "alice" });

    // Tag Alpha, archive Beta — exactly the store ops the component performs.
    await store.updateProject(a.id, { tags: ["physics"] });
    await store.updateProject(b.id, { archived: true });

    const list = sortProjects(await store.listProjectsForUser("alice"));
    expect(collectTags(list)).toEqual(["physics"]);
    // Default view hides the archived Beta.
    expect(filterProjects(list, { query: "", tag: null, showArchived: false }).map((p) => p.name)).toEqual(["Alpha"]);
    // Tag filter narrows to Alpha; showing archived brings Beta back.
    expect(filterProjects(list, { query: "", tag: "physics", showArchived: false }).map((p) => p.name)).toEqual(["Alpha"]);
    expect(filterProjects(list, { query: "", tag: null, showArchived: true }).map((p) => p.name).sort()).toEqual(["Alpha", "Beta"]);
  });
});
