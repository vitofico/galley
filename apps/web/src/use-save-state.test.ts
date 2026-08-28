import { describe, it, expect } from "vitest";
import { computeSaveState, saveStateLabel, type SaveStateInputs } from "./use-save-state.js";

/**
 * #18.2 — save-state surfacing. apps/web vitest runs under Node (no jsdom), so
 * only the PURE inputs→state reducer is exercised here. The React hook
 * (`useSaveState`) is kept thin over this reducer (it just wires up the
 * y-indexeddb `synced` promise, `Y.Doc` `update` events, and online/offline
 * listeners into these three booleans) and is verified by the Docker gate's
 * typecheck + the e2e spec.
 */

const base: SaveStateInputs = { online: true, synced: true, writing: false };

describe("computeSaveState", () => {
  it("is 'saved' once persistence has loaded and nothing is in flight (synced→saved)", () => {
    expect(computeSaveState(base)).toBe("saved");
  });

  it("is 'saving' before the first IndexedDB load resolves (pre-sync→saving)", () => {
    // Before `whenSynced` resolves the draft hasn't been read/persisted yet, so we
    // honestly say we're still working rather than claiming "Saved".
    expect(computeSaveState({ ...base, synced: false })).toBe("saving");
  });

  it("is 'saving' while a write is in flight after an edit", () => {
    expect(computeSaveState({ ...base, writing: true })).toBe("saving");
  });

  it("is 'offline' when a SHARED session has no network (edits aren't reaching peers)", () => {
    expect(computeSaveState({ ...base, online: false, shared: true })).toBe("offline");
  });

  it("prefers 'offline' over an in-flight write on a shared session (offline is more salient)", () => {
    expect(computeSaveState({ online: false, synced: true, writing: true, shared: true })).toBe("offline");
    expect(computeSaveState({ online: false, synced: false, writing: true, shared: true })).toBe("offline");
  });

  // M8 — a happy SOLO LOCAL user offline is NOT alarmed: their IndexedDB draft is
  // saved regardless of network, and there are no peers to be out of sync with, so
  // "offline" is irrelevant. Offline only surfaces for a shared session.
  it("is 'saved' (not 'offline') when a NON-shared session is offline (M8)", () => {
    expect(computeSaveState({ ...base, online: false })).toBe("saved");
    expect(computeSaveState({ ...base, online: false, shared: false })).toBe("saved");
  });

  it("still honestly reads 'saving' for a non-shared offline session mid-load/write (M8)", () => {
    // Offline doesn't mask a genuinely in-flight local persistence state.
    expect(computeSaveState({ online: false, synced: false, writing: false })).toBe("saving");
    expect(computeSaveState({ online: false, synced: true, writing: true })).toBe("saving");
  });

  it("returns to 'saved' after a write settles", () => {
    // The hook flips `writing` true on a doc update, then back to false once the
    // debounce elapses — proving the saving→saved transition through the reducer.
    expect(computeSaveState({ ...base, writing: true })).toBe("saving");
    expect(computeSaveState({ ...base, writing: false })).toBe("saved");
  });

  // C1 — broken IndexedDB must NOT read green "Saved". When the local draft store
  // fails to initialize the doc is in-memory only; closing the tab loses
  // everything, so this is the most severe + actionable state and wins outright.
  it("is 'at-risk' when local persistence failed to initialize (in-memory only)", () => {
    expect(computeSaveState({ ...base, persistenceFailed: true })).toBe("at-risk");
  });

  it("prefers 'at-risk' over offline AND over a pending write — losing the tab loses everything", () => {
    expect(computeSaveState({ online: false, synced: true, writing: false, persistenceFailed: true })).toBe(
      "at-risk",
    );
    expect(computeSaveState({ online: true, synced: false, writing: true, persistenceFailed: true })).toBe(
      "at-risk",
    );
  });

  it("a healthy session never reads at-risk (persistenceFailed defaults false / unset)", () => {
    expect(computeSaveState(base)).toBe("saved");
    expect(computeSaveState({ ...base, persistenceFailed: false })).toBe("saved");
  });
});

describe("saveStateLabel", () => {
  it("labels at-risk plainly as 'Not saved'", () => {
    expect(saveStateLabel("at-risk")).toBe("Not saved");
  });
});
