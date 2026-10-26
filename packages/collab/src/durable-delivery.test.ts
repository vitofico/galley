import { expect, it } from "vitest";
import {
  encodeDurableDelivery,
  decodeDurableDelivery,
  DURABLE_DELIVERY_MAX_VECTOR_BYTES,
} from "./durable-delivery.js";
const token = "0".repeat(32);
it("binds durability messages to a bounded token and exact bounded vector", () => {
  const request = {
    kind: "request" as const,
    token,
    stateVector: new Uint8Array([0]),
  };
  expect(decodeDurableDelivery(encodeDurableDelivery(request))).toEqual(
    request,
  );
  for (const kind of ["complete", "unavailable"] as const)
    expect(
      decodeDurableDelivery(encodeDurableDelivery({ kind, token })),
    ).toEqual({ kind, token });
  expect(() => encodeDurableDelivery({ ...request, token: "x" })).toThrow();
  expect(() =>
    encodeDurableDelivery({
      ...request,
      stateVector: new Uint8Array(DURABLE_DELIVERY_MAX_VECTOR_BYTES + 1),
    }),
  ).toThrow();
  expect(() =>
    decodeDurableDelivery(encodeDurableDelivery(request).slice(0, -1)),
  ).toThrow();
  expect(() =>
    decodeDurableDelivery(
      new Uint8Array([...encodeDurableDelivery(request), 0]),
    ),
  ).toThrow();
});
