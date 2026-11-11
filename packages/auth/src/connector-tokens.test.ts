/**
 * Hosted-connector token policy (ADR-0033 §3): a token is shown once, stored
 * only as a hash, expires, can be revoked by its owner alone, and nothing but
 * a live, well-formed token ever resolves to an account.
 */
import { describe, it, expect } from "vitest";
import type { ConnectorTokenRecord, ConnectorTokenStore } from "@galley/shared";
import { isConnectorToken, isConnectorTokenHash } from "@galley/shared";
import {
  createConnectorToken,
  hashConnectorToken,
  listConnectorTokens,
  revokeConnectorToken,
  verifyConnectorToken,
  MAX_ACTIVE_CONNECTOR_TOKENS_PER_USER,
} from "./connector-tokens.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

class MemStore implements ConnectorTokenStore {
  readonly map = new Map<string, ConnectorTokenRecord>();
  async get(hash: string) {
    return this.map.get(hash) ?? null;
  }
  async put(record: ConnectorTokenRecord) {
    this.map.set(record.hash, record);
  }
  async list() {
    return [...this.map.values()];
  }
  async remove(hash: string) {
    this.map.delete(hash);
  }
}

const create = async (
  store: ConnectorTokenStore,
  body: unknown = { name: "Claude chat" },
  userId = "alice",
  nowMs = NOW,
) => createConnectorToken(store, { body, userId, nowMs });

/** Create and return the secret, failing the test if creation was refused. */
async function issue(
  store: ConnectorTokenStore,
  userId = "alice",
  nowMs = NOW,
) {
  const res = await create(store, { name: "client" }, userId, nowMs);
  if (res.status !== 200) throw new Error("expected a token");
  return res.body;
}

describe("createConnectorToken", () => {
  it("returns the token once and stores only its hash", async () => {
    const store = new MemStore();
    const res = await create(store);
    expect(res.status).toBe(200);
    if (res.status !== 200) return;
    const { token, tokenId, name, expiresAtMs } = res.body;
    expect(isConnectorToken(token)).toBe(true);
    expect(name).toBe("Claude chat");
    expect(expiresAtMs).toBe(NOW + 90 * DAY); // the default lifetime

    const [stored] = [...store.map.values()];
    expect(stored).toEqual({
      version: 1,
      tokenId,
      hash: await hashConnectorToken(token),
      createdBy: "alice",
      name: "Claude chat",
      createdAtMs: NOW,
      expiresAtMs,
    });
    expect(isConnectorTokenHash(stored!.hash)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("accepts the offered lifetimes only", async () => {
    const store = new MemStore();
    const year = await create(store, { name: "script", expiresInDays: 365 });
    expect(year.status === 200 && year.body.expiresAtMs).toBe(NOW + 365 * DAY);
    expect(
      (await create(store, { name: "x", expiresInDays: 3650 })).status,
    ).toBe(400);
    expect(
      (await create(store, { name: "x", expiresInDays: "90" })).status,
    ).toBe(400);
  });

  it.each([
    ["no body", null],
    ["no name", {}],
    ["blank name", { name: "   " }],
    ["a name with a newline", { name: "a\nb" }],
    ["an overlong name", { name: "n".repeat(65) }],
  ])("refuses %s", async (_label, body) => {
    const store = new MemStore();
    expect(await create(store, body)).toEqual({
      status: 400,
      body: { ok: false, code: "invalid" },
    });
    expect(store.map.size).toBe(0);
  });

  it("caps live tokens per account; expired ones do not count", async () => {
    const store = new MemStore();
    await issue(store, "alice", NOW - 400 * DAY); // long expired
    for (let i = 0; i < MAX_ACTIVE_CONNECTOR_TOKENS_PER_USER; i++)
      await issue(store);
    expect(await create(store)).toEqual({
      status: 409,
      body: { ok: false, code: "cap-exceeded" },
    });
    expect((await create(store, { name: "bob's" }, "bob")).status).toBe(200);
  });
});

describe("list and revoke", () => {
  it("lists the caller's live tokens without any secret", async () => {
    const store = new MemStore();
    const mine = await issue(store);
    await issue(store, "bob");
    await issue(store, "alice", NOW - 400 * DAY);
    const listed = await listConnectorTokens(store, "alice", NOW);
    expect(listed).toEqual([
      {
        tokenId: mine.tokenId,
        name: "client",
        createdAtMs: NOW,
        expiresAtMs: mine.expiresAtMs,
      },
    ]);
    // Listing swept the expired record off the volume.
    expect(
      [...store.map.values()].filter((r) => r.createdBy === "alice"),
    ).toHaveLength(1);
  });

  it("revokes for the owner only, with no ownership oracle", async () => {
    const store = new MemStore();
    const mine = await issue(store);
    const unknown = { status: 404, body: { ok: false, code: "unknown" } };
    expect(
      await revokeConnectorToken(store, {
        tokenId: mine.tokenId,
        userId: "bob",
      }),
    ).toEqual(unknown);
    expect(
      await revokeConnectorToken(store, { tokenId: "nope", userId: "alice" }),
    ).toEqual(unknown);
    expect(await verifyConnectorToken(store, mine.token, NOW)).not.toBeNull();

    expect(
      (
        await revokeConnectorToken(store, {
          tokenId: mine.tokenId,
          userId: "alice",
        })
      ).status,
    ).toBe(200);
    expect(await verifyConnectorToken(store, mine.token, NOW)).toBeNull();
    expect(store.map.size).toBe(0);
  });
});

describe("verifyConnectorToken", () => {
  it("resolves a live token to its account and public id", async () => {
    const store = new MemStore();
    const mine = await issue(store);
    expect(await verifyConnectorToken(store, mine.token, NOW)).toEqual({
      userId: "alice",
      tokenId: mine.tokenId,
    });
  });

  it("refuses an expired, unknown or malformed token", async () => {
    const store = new MemStore();
    const mine = await issue(store);
    expect(
      await verifyConnectorToken(store, mine.token, mine.expiresAtMs),
    ).toBeNull();
    const other =
      mine.token.slice(0, -1) + (mine.token.endsWith("A") ? "B" : "A");
    expect(await verifyConnectorToken(store, other, NOW)).toBeNull();
    for (const junk of [
      undefined,
      null,
      42,
      "",
      "gly_short",
      mine.token.slice(4),
      `${mine.token}x`,
    ])
      expect(await verifyConnectorToken(store, junk, NOW)).toBeNull();
  });

  it("refuses a record that does not match the hash it was filed under", async () => {
    const store = new MemStore();
    const mine = await issue(store);
    const hash = await hashConnectorToken(mine.token);
    store.map.set(hash, { ...store.map.get(hash)!, hash: "0".repeat(64) });
    expect(await verifyConnectorToken(store, mine.token, NOW)).toBeNull();
  });
});
