import { describe, it, expect } from "vitest";
import { setPendingSeed, takePendingSeed, type PendingSeed } from "./pending-seed.js";

const seed = (name: string): PendingSeed => ({
  kind: "blank",
  files: [{ path: "/main.typ", text: "= Hi\n" }],
  mainPath: "/main.typ",
  demoHistory: false,
  name,
});

describe("pending-seed (project-model redesign §2)", () => {
  it("set then take returns the stashed seed", () => {
    setPendingSeed("proj-a", seed("amber-otter"));
    expect(takePendingSeed("proj-a")).toMatchObject({ name: "amber-otter", mainPath: "/main.typ" });
  });

  it("is consume-once: a second take returns undefined", () => {
    setPendingSeed("proj-b", seed("azure-falcon"));
    expect(takePendingSeed("proj-b")).toBeDefined();
    expect(takePendingSeed("proj-b")).toBeUndefined();
  });

  it("returns undefined for an unknown id", () => {
    expect(takePendingSeed("proj-never-set")).toBeUndefined();
  });

  it("keeps seeds keyed independently per project id", () => {
    setPendingSeed("proj-c", seed("calm-river"));
    setPendingSeed("proj-d", seed("clever-comet"));
    expect(takePendingSeed("proj-d")?.name).toBe("clever-comet");
    expect(takePendingSeed("proj-c")?.name).toBe("calm-river");
  });
});
