import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FsCrdtStore } from "@galley/persistence";
import { startSyncServer } from "./sync-server.js";
it("drains live sockets, retires storage durably and authenticates the service-only endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "galley-retire-"));
  const key = new Uint8Array(32).fill(7);
  const server = await startSyncServer(0, {
    crdtStore: new FsCrdtStore(root),
    lifecycleKey: key,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/owned`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const url = `http://127.0.0.1:${server.port}/internal/rooms/retire`;
    expect((await fetch(url, { method: "POST", body: "garbage" })).status).toBe(
      401,
    );
    const closed = new Promise<void>((resolve) =>
      ws.once("close", () => resolve()),
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${Buffer.from(key).toString("base64url")}`,
      },
      body: JSON.stringify({ room: "owned" }),
    });
    expect(response.status).toBe(200);
    await closed;
    expect(server.roomCount()).toBe(0);
    await expect(
      new FsCrdtStore(root).appendUpdate("owned", new Uint8Array([1])),
    ).rejects.toThrow("retired");
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${Buffer.from(key).toString("base64url")}`,
          },
          body: JSON.stringify({ room: "owned" }),
        })
      ).status,
    ).toBe(200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
