import { describe, it, expect } from "vitest";
import type { Version } from "@galley/shared";
import {
  versionsToSnapshots,
  fileRangesToAttributions,
  gatherContributionEvidence,
  type AttributedFile,
} from "./contribution-evidence.js";

const PID = "proj-1" as Version["projectId"];

function ver(name: string, contributors?: string[]): Version {
  return {
    id: `v-${name}`,
    projectId: PID,
    name,
    ...(contributors !== undefined ? { contributors } : {}),
  };
}

describe("versionsToSnapshots", () => {
  it("maps each version to a snapshot carrying its name as label and contributors", () => {
    const snaps = versionsToSnapshots([
      ver("draft", ["Alice"]),
      ver("revised", ["Alice", "Bob"]),
    ]);
    expect(snaps).toEqual([
      { label: "draft", contributors: ["Alice"] },
      { label: "revised", contributors: ["Alice", "Bob"] },
    ]);
  });

  it("defaults missing contributors to an empty list (pre-#11 versions)", () => {
    const snaps = versionsToSnapshots([ver("old")]);
    expect(snaps).toEqual([{ label: "old", contributors: [] }]);
  });

  it("preserves input order (oldest → newest) so review-vs-draft inference is correct", () => {
    const snaps = versionsToSnapshots([ver("a", ["X"]), ver("b", ["Y"])]);
    expect(snaps.map((s) => s.label)).toEqual(["a", "b"]);
  });

  it("returns an empty array for no versions", () => {
    expect(versionsToSnapshots([])).toEqual([]);
  });
});

describe("fileRangesToAttributions", () => {
  it("sums range lengths per author into one SectionAttribution per (file, author)", () => {
    const files: AttributedFile[] = [
      {
        path: "main.typ",
        ranges: [
          { author: "Alice", length: 10 },
          { author: "Bob", length: 4 },
          { author: "Alice", length: 6 }, // coalesces with the first Alice span
        ],
      },
    ];
    const attrs = fileRangesToAttributions(files);
    expect(attrs).toContainEqual({ section: "main.typ", author: "Alice", weight: 16 });
    expect(attrs).toContainEqual({ section: "main.typ", author: "Bob", weight: 4 });
    expect(attrs).toHaveLength(2);
  });

  it("keeps each file as its own section", () => {
    const files: AttributedFile[] = [
      { path: "intro.typ", ranges: [{ author: "Alice", length: 5 }] },
      { path: "methods.typ", ranges: [{ author: "Bob", length: 7 }] },
    ];
    const attrs = fileRangesToAttributions(files);
    expect(attrs).toContainEqual({ section: "intro.typ", author: "Alice", weight: 5 });
    expect(attrs).toContainEqual({ section: "methods.typ", author: "Bob", weight: 7 });
  });

  it("drops ranges with no resolved author (unregistered clientID)", () => {
    const files: AttributedFile[] = [
      {
        path: "main.typ",
        ranges: [
          { author: undefined, length: 100 },
          { author: "Alice", length: 3 },
        ],
      },
    ];
    const attrs = fileRangesToAttributions(files);
    expect(attrs).toEqual([{ section: "main.typ", author: "Alice", weight: 3 }]);
  });

  it("drops zero/negative-length ranges and yields nothing for an empty project", () => {
    expect(fileRangesToAttributions([])).toEqual([]);
    expect(
      fileRangesToAttributions([{ path: "main.typ", ranges: [{ author: "A", length: 0 }] }]),
    ).toEqual([]);
  });
});

describe("gatherContributionEvidence", () => {
  it("bundles snapshots and attributions into a ContributionInput", () => {
    const input = gatherContributionEvidence(
      [ver("draft", ["Alice"])],
      [{ path: "main.typ", ranges: [{ author: "Alice", length: 8 }] }],
    );
    expect(input.snapshots).toEqual([{ label: "draft", contributors: ["Alice"] }]);
    expect(input.attributions).toEqual([
      { section: "main.typ", author: "Alice", weight: 8 },
    ]);
  });

  it("yields empty evidence for a degenerate/empty project", () => {
    expect(gatherContributionEvidence([], [])).toEqual({ snapshots: [], attributions: [] });
  });
});
