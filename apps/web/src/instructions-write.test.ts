/**
 * 14-D — the shared `.galley/instructions` write seam. One function persists
 * instructions for BOTH the InstructionsPanel Save and the export → import
 * round-trip (`restoreProjectFromTree`), so the wave-23 invariants (duplicate
 * coalescing, minimal-diff, idempotency) are pinned here once. Offline: a real
 * in-memory CollabProject, no DOM, no network.
 */
import { describe, it, expect } from "vitest";
import { CollabProject } from "@galley/collab";
import type { Author } from "@galley/shared";
import { writeProjectInstructions } from "./instructions-write.js";

const HUMAN: Author = { kind: "human", userId: "me" };

function liveInstructions(p: CollabProject) {
  return p
    .snapshot()
    .files.filter(
      (f) => !f.deleted && (f.path === "/.galley/instructions" || f.path === ".galley/instructions"),
    );
}

describe("writeProjectInstructions (14-D write seam)", () => {
  it("creates the file at the canonical path when none exists", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);

    writeProjectInstructions(p, "Write tersely.", HUMAN);

    const live = liveInstructions(p);
    expect(live).toHaveLength(1);
    expect(live[0]!.path).toBe("/.galley/instructions");
    expect(live[0]!.text).toBe("Write tersely.");
  });

  it("replaces an existing file's content via minimal diff (same fileId survives)", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    const id = p.create("/.galley/instructions", "Old steering.", HUMAN);

    writeProjectInstructions(p, "New steering.", HUMAN);

    const live = liveInstructions(p);
    expect(live).toHaveLength(1);
    expect(live[0]!.fileId).toBe(id); // edited in place, not delete+recreate
    expect(live[0]!.text).toBe("New steering.");
  });

  it("coalesces duplicates: keeps the first by preference order, tombstones the rest", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    const canonical = p.create("/.galley/instructions", "A", HUMAN);
    p.create("/.galley/instructions", "B", HUMAN); // concurrent-create stray

    writeProjectInstructions(p, "Merged.", HUMAN);

    const live = liveInstructions(p);
    expect(live).toHaveLength(1);
    expect(live[0]!.fileId).toBe(canonical);
    expect(live[0]!.text).toBe("Merged.");
  });

  it("recovers from malformed state (metadata without a text body) instead of silently dropping the save", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    const broken = p.create("/.galley/instructions", "orphan-me", HUMAN);
    // Simulate corruption: the file's metadata survives but its Y.Text is gone
    // (the exact state the seam's fallback guards — `fileText` → undefined).
    p.doc.getMap("fileTexts").delete(broken);
    expect(p.fileText(broken)).toBeUndefined();

    writeProjectInstructions(p, "Recovered.", HUMAN);

    const live = liveInstructions(p);
    expect(live).toHaveLength(1);
    expect(live[0]!.path).toBe("/.galley/instructions");
    expect(live[0]!.text).toBe("Recovered.");
    expect(live[0]!.fileId).not.toBe(broken); // the broken entry was retired
  });

  it("is idempotent: re-writing the identical text changes nothing", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/main.typ", text: "= Doc" }], "/main.typ", HUMAN);
    writeProjectInstructions(p, "Stable.", HUMAN);
    const before = p.snapshot();

    writeProjectInstructions(p, "Stable.", HUMAN);

    const after = p.snapshot();
    expect(after.files).toEqual(before.files); // same files, same text, no dupes
    expect(liveInstructions(p)).toHaveLength(1);
  });
});
