/** Optional token-bound durability barrier on the existing authenticated sync socket. */
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
export const DURABLE_DELIVERY_MESSAGE = 5;
export const DURABLE_DELIVERY_MAX_VECTOR_BYTES = 64 * 1024;
export const DURABLE_DELIVERY_MAX_CLIENTS = 4096;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
export type DurableDeliveryFrame =
  | { kind: "request"; token: string; stateVector: Uint8Array }
  | { kind: "complete" | "unavailable"; token: string };
export function encodeDurableDelivery(frame: DurableDeliveryFrame): Uint8Array {
  if (!TOKEN.test(frame.token)) throw new Error("Invalid durability token");
  if (
    frame.kind === "request" &&
    frame.stateVector.byteLength > DURABLE_DELIVERY_MAX_VECTOR_BYTES
  )
    throw new Error("Durability state vector too large");
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, DURABLE_DELIVERY_MESSAGE);
  encoding.writeVarUint(
    enc,
    frame.kind === "request" ? 0 : frame.kind === "complete" ? 1 : 2,
  );
  encoding.writeVarUint8Array(enc, new TextEncoder().encode(frame.token));
  if (frame.kind === "request")
    encoding.writeVarUint8Array(enc, frame.stateVector);
  return encoding.toUint8Array(enc);
}
function bounded(dec: decoding.Decoder, limit: number): Uint8Array {
  const n = decoding.readVarUint(dec);
  if (n > limit || n > dec.arr.byteLength - dec.pos)
    throw new Error("Invalid durability field");
  return decoding.readUint8Array(dec, n);
}
export function readDurableDeliveryBody(
  dec: decoding.Decoder,
): DurableDeliveryFrame {
  const kind = decoding.readVarUint(dec),
    token = new TextDecoder().decode(bounded(dec, 64));
  if (!TOKEN.test(token) || kind > 2)
    throw new Error("Invalid durability frame");
  return kind === 0
    ? {
        kind: "request",
        token,
        stateVector: bounded(dec, DURABLE_DELIVERY_MAX_VECTOR_BYTES),
      }
    : { kind: kind === 1 ? "complete" : "unavailable", token };
}
export function decodeDurableDelivery(bytes: Uint8Array): DurableDeliveryFrame {
  const dec = decoding.createDecoder(bytes);
  if (decoding.readVarUint(dec) !== DURABLE_DELIVERY_MESSAGE)
    throw new Error("Invalid durability message");
  const frame = readDurableDeliveryBody(dec);
  if (decoding.hasContent(dec)) throw new Error("Trailing durability payload");
  return frame;
}
