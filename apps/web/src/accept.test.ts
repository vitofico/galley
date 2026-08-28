import { describe, it, expect } from "vitest";
import { resolveAccept } from "./accept.js";

const BASE = "hello world\nsecond line\n";
const FINAL = "hello galley\nsecond line\n";
const BLOCKS = [{ search: "hello world", replace: "hello galley" }];

describe("resolveAccept — conflict-aware Accept", () => {
  it("fast path: applies the final scratch when the document hasn't moved", () => {
    expect(resolveAccept(BASE, BASE, FINAL, BLOCKS)).toEqual({ applied: true, source: FINAL });
  });

  it("re-applies blocks to the current source when the user edited elsewhere", () => {
    // The user changed the SECOND line during the run; the edit block still
    // matches uniquely, so it re-applies cleanly to current source.
    const current = "hello world\nedited second line\n";
    const out = resolveAccept(current, BASE, FINAL, BLOCKS);
    expect(out.applied).toBe(true);
    expect(out.source).toBe("hello galley\nedited second line\n");
  });

  it("reports a conflict (never clobbers) when a block no longer matches", () => {
    // The user edited the very text the block targeted; re-match fails.
    const current = "hello THERE\nsecond line\n";
    const out = resolveAccept(current, BASE, FINAL, BLOCKS);
    expect(out.applied).toBe(false);
    expect(out.conflicts).toBe(1);
    expect(out.source).toBeUndefined();
  });

  // --- Empty-blocks FULL-FILE REPLACEMENT (B3 restore, C1) -----------------
  // A restore `edit` op carries NO blocks (it is a wholesale "make this file equal
  // the version's text" intent). For that case `resolveAccept` must NOT fall into
  // applyEdits (which "succeeds" on an empty block list and returns the CURRENT
  // text — a silent no-op). Instead: replace the whole file IFF it is unchanged
  // since the proposal (current === base); otherwise surface a CONFLICT.
  describe("empty blocks = full-file replacement (restore)", () => {
    it("fast path: restores the version's text when the file is unchanged (current === base)", () => {
      const out = resolveAccept("live text", "live text", "restored text", []);
      expect(out).toEqual({ applied: true, source: "restored text" });
    });

    it("CONFLICT (never a silent no-op) when the file changed since the proposal", () => {
      // The live text moved past base. With empty blocks there is nothing to
      // re-apply, so a wholesale replacement would clobber the user's edit — refuse.
      const out = resolveAccept("user edited this", "live text", "restored text", []);
      expect(out.applied).toBe(false);
      expect(out.conflicts).toBe(1);
      expect(out.source).toBeUndefined();
    });

    it("restores even when the target text equals the live (idempotent full replace)", () => {
      const out = resolveAccept("same", "same", "same", []);
      expect(out).toEqual({ applied: true, source: "same" });
    });
  });
});
