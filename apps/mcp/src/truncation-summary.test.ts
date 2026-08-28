import { describe, expect, it } from "vitest";
import { READ_LIMITS } from "./surface.js";
import {
  summarizeListTruncation,
  summarizeContextTruncation,
} from "./truncation-summary.js";

describe("summarizeListTruncation (D1)", () => {
  it("returns null when nothing was truncated", () => {
    expect(summarizeListTruncation({ truncated: false, omitted: 0 })).toBeNull();
    expect(
      summarizeListTruncation({ truncated: false, omitted: 0, inexactSizes: 0 }),
    ).toBeNull();
  });

  it("reports the entry cap", () => {
    const line = summarizeListTruncation({ truncated: true, omitted: 0 });
    expect(line).toContain(`${READ_LIMITS.maxListEntries}-entry list cap`);
    expect(line).toMatch(/^Results truncated: .+\.$/);
  });

  it("reports omitted forged-path files with correct pluralization", () => {
    expect(summarizeListTruncation({ truncated: false, omitted: 1 })).toContain("1 file omitted");
    expect(summarizeListTruncation({ truncated: false, omitted: 3 })).toContain("3 files omitted");
  });

  it("reports inexact sizes when the sizing budget was spent", () => {
    expect(summarizeListTruncation({ truncated: false, omitted: 0, inexactSizes: 12 })).toContain(
      "12 sizes are lower bounds",
    );
  });

  it("joins multiple causes into one sentence", () => {
    const line = summarizeListTruncation({ truncated: true, omitted: 2, inexactSizes: 4 });
    expect(line).toMatch(/^Results truncated: .+; .+; .+\.$/);
    expect(line).toContain("list cap");
    expect(line).toContain("2 files omitted");
    expect(line).toContain("4 sizes");
  });
});

describe("summarizeContextTruncation (D1)", () => {
  const none = {
    omitted: 0,
    filesTruncated: false,
    scanTruncated: false,
    chunksTruncated: false,
    selectionTruncated: false,
  };

  it("returns null when nothing was truncated", () => {
    expect(summarizeContextTruncation(none)).toBeNull();
    expect(summarizeContextTruncation({ ...none, skippedReasons: [] })).toBeNull();
  });

  it("reports the file cap", () => {
    expect(summarizeContextTruncation({ ...none, filesTruncated: true })).toContain(
      `${READ_LIMITS.maxListEntries}-entry file cap`,
    );
  });

  it("reports the selection budget", () => {
    expect(summarizeContextTruncation({ ...none, selectionTruncated: true })).toContain(
      "did not fit the response budget",
    );
  });

  it("aggregates skip reasons by count, in stable order", () => {
    const line = summarizeContextTruncation({
      ...none,
      skippedReasons: ["over-cap", "scan-budget", "over-cap", "duplicate-path"],
    });
    expect(line).toContain("1 file skipped for a duplicate-path conflict");
    expect(line).toContain("2 files skipped (over the per-file read cap)");
    expect(line).toContain("1 file skipped (scan budget spent)");
    // duplicate-path precedes over-cap precedes scan-budget in the sentence.
    expect(line!.indexOf("duplicate-path")).toBeLessThan(line!.indexOf("read cap"));
    expect(line!.indexOf("read cap")).toBeLessThan(line!.indexOf("scan budget"));
  });

  it("never returns null when chunksTruncated is set without a skipped reason", () => {
    // surface.ts can flag chunksTruncated when a file's chunks were cut to a
    // prefix mid-collection, WITHOUT pushing a skipped entry. The summary must
    // still report it (a silent null would hide real truncation).
    const line = summarizeContextTruncation({ ...none, chunksTruncated: true });
    expect(line).not.toBeNull();
    expect(line).toMatch(/^Results truncated: .+\.$/);
    expect(line!.toLowerCase()).toContain("chunk");
  });

  it("never returns null when scanTruncated is set without a skipped reason", () => {
    const line = summarizeContextTruncation({ ...none, scanTruncated: true });
    expect(line).not.toBeNull();
    expect(line!.toLowerCase()).toContain("scan");
  });

  it("combines caps and skips into one sentence", () => {
    const line = summarizeContextTruncation({
      omitted: 1,
      filesTruncated: true,
      scanTruncated: true,
      chunksTruncated: false,
      selectionTruncated: true,
      skippedReasons: ["scan-budget"],
    });
    expect(line).toMatch(/^Results truncated: .+\.$/);
    expect(line).toContain("file cap");
    expect(line).toContain("1 file omitted");
    expect(line).toContain("scan budget");
    expect(line).toContain("response budget");
  });
});
