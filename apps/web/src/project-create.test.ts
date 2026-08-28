import { describe, it, expect, vi } from "vitest";
import {
  MAX_PROJECT_NAME_LENGTH,
  createProject,
  einsteinSeed,
  blankSeed,
  projectNameFromZipFilename,
} from "./project-create.js";
import { takePendingSeed } from "./pending-seed.js";
import { IdbProjectStore, InMemoryKeyValueBackend } from "./idb-project-store.js";
import { ADJECTIVES } from "./random-project-name.js";

describe("projectNameFromZipFilename (project-model redesign §3)", () => {
  it("strips a trailing .zip", () => {
    expect(projectNameFromZipFilename("thesis.zip")).toBe("thesis");
    expect(projectNameFromZipFilename("Report.ZIP")).toBe("Report");
  });

  it("drops a directory prefix and keeps the basename", () => {
    expect(projectNameFromZipFilename("Downloads/my paper.zip")).toBe("my paper");
    expect(projectNameFromZipFilename("C:\\docs\\paper.zip")).toBe("paper");
  });

  it("collapses whitespace runs", () => {
    expect(projectNameFromZipFilename("a   long\tname.zip")).toBe("a long name");
  });

  it("caps the length", () => {
    const long = "x".repeat(500) + ".zip";
    expect(projectNameFromZipFilename(long).length).toBeLessThanOrEqual(MAX_PROJECT_NAME_LENGTH);
  });

  it("falls back to a random adjective-noun for empty / unsafe input", () => {
    const rng = () => 0;
    const fallback = `${ADJECTIVES[0]}-`;
    expect(projectNameFromZipFilename(".zip", rng).startsWith(fallback)).toBe(true);
    expect(projectNameFromZipFilename("   .zip", rng).startsWith(fallback)).toBe(true);
    expect(projectNameFromZipFilename(undefined, rng).startsWith(fallback)).toBe(true);
  });
});

describe("createProject orchestration (project-model redesign §2)", () => {
  const newStore = () =>
    new IdbProjectStore({ backend: new InMemoryKeyValueBackend(), newId: () => "ignored" });

  it("registers the project, stashes the pending seed, and navigates", async () => {
    const store = newStore();
    const navigate = vi.fn();
    const id = await createProject(blankSeed("amber-otter"), {
      store,
      ownerId: "u1",
      newId: () => "proj-1",
      navigate,
    });
    expect(id).toBe("proj-1");

    const registered = await store.getProject("proj-1");
    expect(registered).toMatchObject({ id: "proj-1", name: "amber-otter", ownerId: "u1" });

    expect(navigate).toHaveBeenCalledWith("/p/proj-1");

    const pending = takePendingSeed("proj-1");
    expect(pending).toMatchObject({ kind: "blank", name: "amber-otter", demoHistory: false });
    expect(pending!.files).toHaveLength(1);
  });

  it("uses a random name when none is given", async () => {
    const store = newStore();
    const id = await createProject(blankSeed(), {
      store,
      ownerId: "u1",
      newId: () => "proj-2",
      navigate: () => {},
      rng: () => 0,
    });
    const registered = await store.getProject(id);
    expect(registered!.name).toMatch(/^[a-z]+-[a-z]+$/);
    takePendingSeed(id);
  });

  it("the einstein seed carries demoHistory:true and the seven-file tree", async () => {
    const store = newStore();
    const id = await createProject(einsteinSeed("relativity-river"), {
      store,
      ownerId: "u1",
      newId: () => "proj-3",
      navigate: () => {},
    });
    const pending = takePendingSeed(id);
    expect(pending).toMatchObject({ kind: "einstein", demoHistory: true });
    // Eight files: the desk plus the swappable `/style.typ` (styles Phase 1.5).
    expect(pending!.files).toHaveLength(8);
  });

  it("does NOT navigate or stash a seed when registration fails", async () => {
    const failing = {
      createProject: () => Promise.reject(new Error("registry down")),
    } as unknown as IdbProjectStore;
    const navigate = vi.fn();
    await expect(
      createProject(blankSeed("x"), { store: failing, ownerId: "u", newId: () => "proj-4", navigate }),
    ).rejects.toThrow("registry down");
    expect(navigate).not.toHaveBeenCalled();
    expect(takePendingSeed("proj-4")).toBeUndefined();
  });
});
