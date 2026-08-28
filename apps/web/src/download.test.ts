import { describe, it, expect } from "vitest";
import { toPlainArrayBuffer } from "./download.js";

describe("toPlainArrayBuffer", () => {
  it("copies the bytes into a fresh plain ArrayBuffer", () => {
    const src = new Uint8Array([1, 2, 3, 250]);
    const buf = toPlainArrayBuffer(src);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(4);
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 250]);
  });

  it("is a COPY — mutating the source afterwards does not change the buffer", () => {
    const src = new Uint8Array([9, 9]);
    const buf = toPlainArrayBuffer(src);
    src[0] = 0;
    expect([...new Uint8Array(buf)]).toEqual([9, 9]);
  });

  it("respects a subarray's offset/length view", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    const view = backing.subarray(1, 4);
    expect([...new Uint8Array(toPlainArrayBuffer(view))]).toEqual([2, 3, 4]);
  });
});
