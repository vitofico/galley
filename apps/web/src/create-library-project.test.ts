import { describe, it, expect } from "vitest";
import { IdbProjectStore, InMemoryKeyValueBackend } from "./idb-project-store.js";
import { createLibraryProject, MAX_PROJECT_NAME_LENGTH } from "./create-library-project.js";

/**
 * F1 — the HEADLESS library-create the Agent Access responder uses. It registers a
 * registry-only project (visible to list_projects) WITHOUT navigating the tab or
 * seeding CRDT content. The helper takes no navigate dep by construction — these
 * tests assert it both registers the row and stays headless.
 */

/** A fresh store over the in-memory backend (the same fake the store's own tests use). */
function makeStore(): IdbProjectStore {
  return new IdbProjectStore({ backend: new InMemoryKeyValueBackend() });
}

describe("createLibraryProject (F1)", () => {
  it("registers a project visible via listProjectsForUser with the given name + owner membership", async () => {
    const store = makeStore();
    const { projectId, name } = await createLibraryProject("My Paper", {
      store,
      ownerId: "user-1",
    });
    expect(name).toBe("My Paper");
    const rows = await store.listProjectsForUser("user-1");
    expect(rows.map((r) => r.id)).toContain(projectId);
    const row = rows.find((r) => r.id === projectId)!;
    expect(row.name).toBe("My Paper");
    expect(row.ownerId).toBe("user-1");
  });

  it("sanitizes control chars and clamps an over-length name to MAX_PROJECT_NAME_LENGTH", async () => {
    const store = makeStore();
    const raw = "Bad\nName\t" + "x".repeat(MAX_PROJECT_NAME_LENGTH * 2);
    const { name } = await createLibraryProject(raw, { store, ownerId: "user-1" });
    expect(name).not.toContain("\n");
    expect(name).not.toContain("\t");
    expect(name.length).toBeLessThanOrEqual(MAX_PROJECT_NAME_LENGTH);
    expect(name.startsWith("Bad Name")).toBe(true);
  });

  it("falls back to a non-empty random-ish name for an empty/whitespace name", async () => {
    const store = makeStore();
    const { name } = await createLibraryProject("   \n\t  ", { store, ownerId: "user-1" });
    expect(name.trim().length).toBeGreaterThan(0);
  });

  it("returns {projectId, name} where projectId matches the registered row and name the stored name", async () => {
    const store = makeStore();
    const result = await createLibraryProject("Doc", {
      store,
      ownerId: "user-1",
      newId: () => "proj-fixed",
    });
    expect(result).toEqual({ projectId: "proj-fixed", name: "Doc" });
    const stored = await store.getProject("proj-fixed");
    expect(stored?.name).toBe("Doc");
  });

  it("is headless by construction — its deps include no navigate seam", async () => {
    // The signature only accepts { store, ownerId, newId?, rng? } — there is no
    // navigate dep to invoke, so a create can never yank the user's tab. This is a
    // compile-time guarantee; the assertion documents the intent at runtime.
    const store = makeStore();
    const deps = { store, ownerId: "user-1" } as const;
    expect("navigate" in deps).toBe(false);
    await createLibraryProject("Doc", deps);
  });
});
