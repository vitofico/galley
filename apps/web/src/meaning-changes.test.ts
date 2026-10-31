import { describe, expect, it } from "vitest";
import { meaningChanges } from "./meaning-changes.js";
describe("meaning changes", () => {
  it("surfaces numbers, dates, units, references and modal edits", () => {
    const changes = meaningChanges(
      "Must deliver 10 kg by 2026-10-31 @old.",
      "May deliver 12 kg by 2026-11-01 @new.",
    );
    expect(changes).toHaveLength(3);
    expect(changes[0]?.removed).toContain("10 kg");
  });
  it("counts duplicate removal but ignores token movement", () => {
    expect(meaningChanges("10 and 10", "10")[0]?.removed).toEqual(["10"]);
    expect(meaningChanges("10 then 20", "20 then 10")).toEqual([]);
  });
});
