import { describe, it, expect } from "vitest";
import {
  planBinaryUpload,
  uniqueBinaryPath,
  uploadSkipNotice,
  pastedImageName,
  imageSnippet,
  inlineImageSnippet,
  isDisplayableRasterMime,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_UPLOAD_PATH_CHARS,
  MAX_UPLOAD_FILE_COUNT,
} from "./binary-upload.js";

const empty = new Set<string>();

describe("planBinaryUpload — path assignment", () => {
  it("accepts a clean file at the project root, canonicalized with a leading slash", () => {
    const plan = planBinaryUpload([{ name: "logo.png", size: 10 }], empty);
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toEqual([{ index: 0, name: "logo.png", path: "/logo.png" }]);
  });

  it("uploads into a folder when a folderPrefix is given", () => {
    const plan = planBinaryUpload([{ name: "plot.png", size: 10 }], empty, {
      folderPrefix: "/figures",
    });
    expect(plan.accepted[0]!.path).toBe("/figures/plot.png");
  });

  it("tolerates a folderPrefix with a trailing slash", () => {
    const plan = planBinaryUpload([{ name: "plot.png", size: 10 }], empty, {
      folderPrefix: "/figures/",
    });
    expect(plan.accepted[0]!.path).toBe("/figures/plot.png");
  });
});

describe("planBinaryUpload — sanitize", () => {
  it("strips path separators and quotes from the filename", () => {
    const plan = planBinaryUpload([{ name: 'a/b\\c".png', size: 10 }], empty);
    expect(plan.accepted[0]!.path).toBe("/abc.png");
  });

  it("strips control characters and collapses whitespace", () => {
    const plan = planBinaryUpload([{ name: "my \u0000\t photo\u007f.png", size: 10 }], empty);
    expect(plan.accepted[0]!.path).toBe("/my photo.png");
  });

  it("rejects a name that is empty after sanitizing", () => {
    const plan = planBinaryUpload([{ name: "///", size: 10 }], empty);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toMatch(/valid file name/);
  });

  it("rejects a traversal / reserved path via isSafeProjectPath", () => {
    // ".." survives sanitize (no separators) but canonicalizes to an unsafe segment.
    const dots = planBinaryUpload([{ name: "..", size: 10 }], empty);
    expect(dots.accepted).toEqual([]);
    expect(dots.rejected[0]!.reason).toMatch(/safe project path/);
    // The reserved namespace is refused too.
    const reserved = planBinaryUpload([{ name: ".galley", size: 10 }], empty);
    expect(reserved.accepted).toEqual([]);
  });
});

describe("planBinaryUpload — collision auto-suffix", () => {
  it("suffixes a name that collides with an existing (text or binary) path", () => {
    const taken = new Set<string>(["/logo.png"]);
    const plan = planBinaryUpload([{ name: "logo.png", size: 10 }], taken);
    expect(plan.accepted[0]!.path).toBe("/logo-1.png");
  });

  it("suffixes repeatedly until free, skipping already-taken suffixes", () => {
    const taken = new Set<string>(["/logo.png", "/logo-1.png"]);
    const plan = planBinaryUpload([{ name: "logo.png", size: 10 }], taken);
    expect(plan.accepted[0]!.path).toBe("/logo-2.png");
  });

  it("de-duplicates WITHIN one batch (two identical names)", () => {
    const plan = planBinaryUpload(
      [
        { name: "logo.png", size: 10 },
        { name: "logo.png", size: 10 },
      ],
      empty,
    );
    expect(plan.accepted.map((a) => a.path)).toEqual(["/logo.png", "/logo-1.png"]);
  });

  it("suffixes a dotfile (no extension) at the end", () => {
    const taken = new Set<string>(["/.gitignore"]);
    const plan = planBinaryUpload([{ name: ".gitignore", size: 10 }], taken);
    expect(plan.accepted[0]!.path).toBe("/.gitignore-1");
  });
});

describe("planBinaryUpload — size caps", () => {
  it("rejects a file larger than the per-file cap", () => {
    const plan = planBinaryUpload([{ name: "big.png", size: MAX_UPLOAD_FILE_BYTES + 1 }], empty);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toMatch(/larger than 32 MB/);
  });

  it("accepts a file exactly at the per-file cap", () => {
    const plan = planBinaryUpload([{ name: "edge.png", size: MAX_UPLOAD_FILE_BYTES }], empty);
    expect(plan.accepted).toHaveLength(1);
  });

  it("rejects the batch remainder once the total cap is exceeded", () => {
    // Each file is at the per-file cap (32 MiB); four fit the 128 MiB total
    // exactly, the fifth overflows it (proving the TOTAL gate, not the per-file).
    const cap = MAX_UPLOAD_FILE_BYTES;
    const plan = planBinaryUpload(
      [
        { name: "a.png", size: cap },
        { name: "b.png", size: cap },
        { name: "c.png", size: cap },
        { name: "d.png", size: cap },
        { name: "e.png", size: cap },
      ],
      empty,
    );
    expect(plan.accepted.map((a) => a.name)).toEqual(["a.png", "b.png", "c.png", "d.png"]);
    expect(plan.rejected.map((r) => r.name)).toEqual(["e.png"]);
    expect(plan.rejected[0]!.reason).toMatch(/upload limit/);
  });

  it("rejects an unreadable (NaN/negative) size", () => {
    const plan = planBinaryUpload([{ name: "x.png", size: Number.NaN }], empty);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toMatch(/unreadable size/);
  });
});

describe("planBinaryUpload — path length cap", () => {
  it("rejects a path longer than the cap", () => {
    const long = `${"a".repeat(MAX_UPLOAD_PATH_CHARS)}.png`;
    const plan = planBinaryUpload([{ name: long, size: 10 }], empty);
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]!.reason).toMatch(/too long/);
  });
});

describe("planBinaryUpload — file count cap", () => {
  it(`accepts at most ${MAX_UPLOAD_FILE_COUNT} files and rejects the remainder`, () => {
    const many = Array.from({ length: MAX_UPLOAD_FILE_COUNT + 5 }, (_, i) => ({
      name: `f${i}.png`,
      size: 10,
    }));
    const plan = planBinaryUpload(many, empty);
    expect(plan.accepted).toHaveLength(MAX_UPLOAD_FILE_COUNT);
    expect(plan.rejected).toHaveLength(5);
    expect(plan.rejected[0]!.reason).toMatch(/file limit/);
  });
});

describe("uniqueBinaryPath (the app-layer re-suffix helper)", () => {
  it("returns the base path when it is free", () => {
    expect(uniqueBinaryPath("/logo.png", new Set())).toBe("/logo.png");
  });
  it("suffixes past already-taken paths", () => {
    expect(uniqueBinaryPath("/logo.png", new Set(["/logo.png", "/logo-1.png"]))).toBe("/logo-2.png");
  });
});

describe("uploadSkipNotice", () => {
  it("reads as a plain sentence for one skip (no 'file(s)')", () => {
    const msg = uploadSkipNotice([{ name: "big.png", reason: "is larger than 32 MB" }]);
    expect(msg).toBe("Skipped big.png is larger than 32 MB.");
    expect(msg).not.toMatch(/file\(s\)/);
  });
  it("summarizes several skips compactly", () => {
    const msg = uploadSkipNotice([
      { name: "a.png", reason: "is larger than 32 MB" },
      { name: "b.png", reason: "isn't a valid file name" },
    ]);
    expect(msg).toBe("Skipped 2 files: a.png is larger than 32 MB; b.png isn't a valid file name.");
  });
});

describe("pastedImageName", () => {
  it("maps known image mimes to a stable pasted name", () => {
    expect(pastedImageName("image/png")).toBe("pasted-image.png");
    expect(pastedImageName("image/jpeg")).toBe("pasted-image.jpg");
    expect(pastedImageName("image/gif")).toBe("pasted-image.gif");
    expect(pastedImageName("image/webp")).toBe("pasted-image.webp");
    expect(pastedImageName("image/svg+xml")).toBe("pasted-image.svg");
  });

  it("falls back to .bin for an unknown mime", () => {
    expect(pastedImageName("application/x-weird")).toBe("pasted-image.bin");
  });
});

describe("snippet builders", () => {
  it("imageSnippet wraps the path in a #figure(image(...))", () => {
    expect(imageSnippet("/figures/plot.png")).toBe(
      '#figure(\n  image("/figures/plot.png"),\n  caption: [],\n)',
    );
  });

  it("inlineImageSnippet is a bare #image(...)", () => {
    expect(inlineImageSnippet("/logo.png")).toBe('#image("/logo.png")');
  });

  it("escapes quotes and backslashes in the path defensively", () => {
    // These characters can't survive sanitize, but the builders must be safe regardless.
    expect(inlineImageSnippet('/a"b\\c.png')).toBe('#image("/a\\"b\\\\c.png")');
  });
});

describe("isDisplayableRasterMime", () => {
  it("allows the raster formats browsers render safely", () => {
    for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
      expect(isDisplayableRasterMime(m)).toBe(true);
    }
  });

  it("does NOT allowlist svg, pdf, tiff or arbitrary types (handled separately / not inline)", () => {
    for (const m of ["image/svg+xml", "application/pdf", "image/tiff", "text/html", ""]) {
      expect(isDisplayableRasterMime(m)).toBe(false);
    }
  });
});
