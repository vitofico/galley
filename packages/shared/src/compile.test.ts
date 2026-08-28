import { describe, expect, it } from "vitest";
import { computeCompileArtifact, TYPST_VECTOR_MIME } from "./compile.js";

describe("computeCompileArtifact — compiled-output descriptor (D3)", () => {
  it("reports byte length, lowercase-hex sha256, and the given mime", async () => {
    const bytes = new TextEncoder().encode("hello");
    const artifact = await computeCompileArtifact(bytes, TYPST_VECTOR_MIME);
    expect(artifact.bytes).toBe(5);
    // sha256("hello") — the canonical fixed vector.
    expect(artifact.hash).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(artifact.mime).toBe(TYPST_VECTOR_MIME);
    // Lowercase hex only.
    expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits mime when none is given", async () => {
    const artifact = await computeCompileArtifact(new Uint8Array([1, 2, 3]));
    expect(artifact.bytes).toBe(3);
    expect("mime" in artifact).toBe(false);
  });

  it("is deterministic: identical bytes hash identically", async () => {
    const a = await computeCompileArtifact(new Uint8Array([9, 9, 9]));
    const b = await computeCompileArtifact(new Uint8Array([9, 9, 9]));
    expect(a).toEqual(b);
  });

  it("hashes only the view's bytes, not the backing buffer", async () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = backing.subarray(1, 4); // [2,3,4]
    const fromView = await computeCompileArtifact(view);
    const fromCopy = await computeCompileArtifact(new Uint8Array([2, 3, 4]));
    expect(fromView).toEqual(fromCopy);
  });
});
