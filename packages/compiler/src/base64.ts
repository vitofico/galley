/**
 * Cross-environment base64 for PDF bytes on the compile-service wire (ADR-0015).
 * Uses the global `atob`/`btoa` (present in Node ≥16 and every browser), chunked
 * so a multi-megabyte PDF never blows the argument-spread stack limit.
 */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
