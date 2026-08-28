import { describe, it, expect } from "vitest";
import type { CompileInput } from "@galley/shared";
import { compileInputKey } from "./useCompiler.js";

const proj = (
  text: string,
  binaryFiles?: { path: string; bytes: Uint8Array }[],
): CompileInput => ({
  kind: "project",
  main: "/m.typ",
  files: [{ path: "/m.typ", text }],
  ...(binaryFiles ? { binaryFiles } : {}),
});

describe("compileInputKey", () => {
  it("returns a bare string input unchanged", () => {
    expect(compileInputKey("= Hi")).toBe("= Hi");
  });

  it("changes when text content changes", () => {
    expect(compileInputKey(proj("a"))).not.toBe(compileInputKey(proj("b")));
  });

  it("is stable across renders for the same binary (fresh Uint8Array, same length)", () => {
    const a = proj("x", [{ path: "/img.png", bytes: new Uint8Array(1024) }]);
    const b = proj("x", [{ path: "/img.png", bytes: new Uint8Array(1024) }]);
    expect(compileInputKey(a)).toBe(compileInputKey(b));
  });

  it("does NOT serialize binary bytes into the key (cheap fingerprint only)", () => {
    const key = compileInputKey(
      proj("x", [{ path: "/img.png", bytes: new Uint8Array(50_000).fill(7) }]),
    );
    // Stringifying the bytes would make this ~150k+ chars; the fingerprint is tiny.
    expect(key.length).toBeLessThan(200);
    expect(key).toContain("/img.png:50000");
  });

  it("changes when a binary is replaced with content of a different length", () => {
    const small = proj("x", [{ path: "/i.png", bytes: new Uint8Array(10) }]);
    const large = proj("x", [{ path: "/i.png", bytes: new Uint8Array(20) }]);
    expect(compileInputKey(small)).not.toBe(compileInputKey(large));
  });
});
