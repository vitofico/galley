/**
 * Byte-download helpers (#19.3) — the one home for the "turn export bytes into
 * a browser download" dance the Export menu items share (PDF stays on its own
 * `exportPdf` path inside useCompiler; this serves the tar-shaped exports).
 *
 * `toPlainArrayBuffer` is PURE (unit-tested in the node gate): it copies a
 * Uint8Array into a fresh, plain ArrayBuffer so the BlobPart isn't typed over
 * the SharedArrayBuffer union (strict lib's Uint8Array<ArrayBufferLike>).
 */

/** Copy `bytes` into a fresh, plain (non-shared) ArrayBuffer. */
export function toPlainArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/** Trigger a browser download of `bytes` as `filename` (user-gesture path). */
export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  type = "application/x-tar",
): void {
  const blob = new Blob([toPlainArrayBuffer(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
