import { describe, it, expect } from "vitest";
import { IdbVersionStore, InMemoryKeyValueBackend } from "../idb-version-store.js";
import { orderVersions, canCompare, historyView } from "./HistoryPanel.js";
import type { Version } from "@galley/shared";

/**
 * Roadmap #12.6 — HistoryPanel (version-history timeline).
 *
 * The unit gate runs in the Node environment with NO DOM (no @testing-library/
 * react, no jsdom — see vitest.config.ts `environment: "node"`). So we follow the
 * repo's house pattern (cf. doc-stats, LibraryApp): the component is a thin shell
 * over (a) pure exported helpers and (b) the injected `VersionStore`. We test the
 * helpers directly, and exercise the exact store interactions the panel performs
 * (mount → `listVersions`) against a real `IdbVersionStore` over the in-memory
 * backend.
 */

function makeStore(): IdbVersionStore {
  return new IdbVersionStore({ backend: new InMemoryKeyValueBackend() });
}

function v(id: string, name = id): Version {
  return { id, projectId: "p1", name };
}

describe("orderVersions", () => {
  it("returns newest-first (reverse insertion order)", () => {
    // `listVersions` yields insertion order (oldest → newest); the panel shows a
    // timeline with the most recent at the top.
    const input = [v("a"), v("b"), v("c")];
    expect(orderVersions(input).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate its input", () => {
    const input = [v("a"), v("b")];
    const before = [...input];
    orderVersions(input);
    expect(input).toEqual(before);
  });

  it("handles empty input", () => {
    expect(orderVersions([])).toEqual([]);
  });

  it("handles a single version", () => {
    expect(orderVersions([v("only")]).map((x) => x.id)).toEqual(["only"]);
  });
});

describe("historyView", () => {
  it("shows the loading view while loading, regardless of error/count", () => {
    expect(historyView(true, false, 0)).toBe("loading");
    expect(historyView(true, true, 5)).toBe("loading");
  });
  it("distinguishes a failed load from an empty-but-loaded list", () => {
    expect(historyView(false, true, 0)).toBe("error");
    expect(historyView(false, false, 0)).toBe("empty");
  });
  it("shows the list once versions are loaded", () => {
    expect(historyView(false, false, 3)).toBe("list");
  });
});

describe("canCompare", () => {
  it("is false with 0 selected", () => {
    expect(canCompare([])).toBe(false);
  });

  it("is false with 1 selected", () => {
    expect(canCompare(["a"])).toBe(false);
  });

  it("is true with exactly 2 selected", () => {
    expect(canCompare(["a", "b"])).toBe(true);
  });

  it("is false with 3 selected", () => {
    expect(canCompare(["a", "b", "c"])).toBe(false);
  });
});

describe("HistoryPanel store interactions (createVersion → listVersions)", () => {
  it("starts empty for a project with no versions", async () => {
    const store = makeStore();
    expect(await store.listVersions("p1")).toEqual([]);
  });

  it("lists created versions in insertion order, which the panel reverses for display", async () => {
    const store = makeStore();
    await store.createVersion("p1", { name: "first" }, []);
    await store.createVersion("p1", { name: "second", message: "tweaks" }, []);
    await store.createVersion("p1", { name: "third" }, []);

    const listed = await store.listVersions("p1");
    expect(listed.map((x) => x.name)).toEqual(["first", "second", "third"]);

    // the second version carried a message
    expect(listed[1]?.message).toBe("tweaks");

    // display order (what the panel renders) is newest-first
    expect(orderVersions(listed).map((x) => x.name)).toEqual(["third", "second", "first"]);
  });

  it("scopes listVersions to the requested project", async () => {
    const store = makeStore();
    await store.createVersion("p1", { name: "mine" }, []);
    await store.createVersion("p2", { name: "theirs" }, []);

    expect((await store.listVersions("p1")).map((x) => x.name)).toEqual(["mine"]);
    expect((await store.listVersions("p2")).map((x) => x.name)).toEqual(["theirs"]);
  });

  it("omits message when none is given (exactOptionalPropertyTypes)", async () => {
    const store = makeStore();
    const created = await store.createVersion("p1", { name: "nomsg" }, []);
    expect("message" in created).toBe(false);

    const listed = await store.listVersions("p1");
    expect("message" in (listed[0] ?? {})).toBe(false);
  });
});
