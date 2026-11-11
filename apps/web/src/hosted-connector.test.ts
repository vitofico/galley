/**
 * Browser client for the hosted connector (ADR-0033): default-off gating, the
 * exact requests it makes, and that a server answer is never trusted blindly.
 */
import { describe, it, expect, vi } from "vitest";
import type { WebSocketLike } from "@galley/collab";
import { CollabDocument } from "@galley/collab";
import type { CapabilityFetch } from "./capability-rooms-client.js";
import {
  connectProject,
  createConnectorToken,
  disconnectProject,
  listConnectorTokens,
  revokeConnectorToken,
  hostedConnectorEnabled,
  fetchConnectorCheckpoint,
  listConnectedProjects,
  listConnectorActivity,
  openConnectorReplica,
  setConnectedProjectReviewMode,
} from "./hosted-connector.js";

const ROOM = "share-0123456789abcdef0123456789abcdef";

const answering = (status: number, json: unknown) =>
  vi.fn<CapabilityFetch>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  }));

describe("hostedConnectorEnabled", () => {
  it("needs both the operator switch and sign-in; anything else is off", () => {
    expect(hostedConnectorEnabled({ auth: true, hostedConnector: true })).toBe(
      true,
    );
    expect(hostedConnectorEnabled({ hostedConnector: true })).toBe(false);
    expect(hostedConnectorEnabled({ auth: true })).toBe(false);
    expect(
      hostedConnectorEnabled({ auth: true, hostedConnector: "true" }),
    ).toBe(false);
    expect(hostedConnectorEnabled(undefined)).toBe(false);
  });
});

describe("listConnectedProjects", () => {
  it("returns well-formed rows and drops the rest", async () => {
    const good = {
      roomId: ROOM,
      projectId: "p1",
      reviewMode: "auto",
      connectedAtMs: 5,
    };
    const fetchImpl = answering(200, {
      ok: true,
      projects: [
        good,
        { ...good, roomId: "not-a-room" },
        { ...good, reviewMode: "always" },
        null,
      ],
    });
    expect(await listConnectedProjects(fetchImpl)).toEqual({
      ok: true,
      projects: [good],
      appliesChanges: false,
    });
    expect(
      await listConnectedProjects(
        answering(200, { ok: true, projects: [], appliesChanges: true }),
      ),
    ).toEqual({ ok: true, projects: [], appliesChanges: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/auth/connector/projects",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("reports a signed-out session and an unusable answer as errors", async () => {
    expect(
      (await listConnectedProjects(answering(401, { ok: false }))).ok,
    ).toBe(false);
    expect((await listConnectedProjects(answering(200, { ok: true }))).ok).toBe(
      false,
    );
    const offline = vi.fn<CapabilityFetch>(async () => {
      throw new Error("offline");
    });
    expect((await listConnectedProjects(offline)).ok).toBe(false);
  });
});

describe("connect, review mode, disconnect", () => {
  it("connect registers a fresh connector room for the project, in Ask mode", async () => {
    const fetchImpl = answering(200, { ok: true });
    const result = await connectProject("proj-1", "  My\nnovel ", fetchImpl);
    expect(result.ok).toBe(true);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/auth/capability-rooms");
    const body = JSON.parse(init!.body!) as Record<string, unknown>;
    expect(body).toEqual({
      roomId: expect.stringMatching(/^share-[A-Za-z0-9_-]{16,64}$/),
      kind: "connector",
      projectId: "proj-1",
      projectName: "My novel",
    });
    if (result.ok)
      expect(result.project).toMatchObject({
        roomId: body["roomId"],
        projectId: "proj-1",
        name: "My novel",
        reviewMode: "ask",
      });
  });

  it("names the reason a connect was refused", async () => {
    const exists = await connectProject(
      "p",
      "P",
      answering(409, { ok: false, code: "exists" }),
    );
    expect(exists).toEqual({
      ok: false,
      error: expect.stringMatching(/already connected/),
    });
    const cap = await connectProject(
      "p",
      "P",
      answering(409, { ok: false, code: "cap-exceeded" }),
    );
    expect(cap).toEqual({ ok: false, error: expect.stringMatching(/limit/) });
  });

  it("switches the review mode and disconnects by room", async () => {
    const mode = answering(200, { ok: true });
    expect(await setConnectedProjectReviewMode(ROOM, "auto", mode)).toEqual({
      ok: true,
    });
    expect(mode.mock.calls[0]![0]).toBe(
      `/auth/connector/projects/${ROOM}/review-mode`,
    );
    expect(JSON.parse(mode.mock.calls[0]![1]!.body!)).toEqual({
      reviewMode: "auto",
    });

    const revoke = answering(200, { ok: true });
    expect(await disconnectProject(ROOM, revoke)).toEqual({ ok: true });
    expect(revoke.mock.calls[0]![0]).toBe(
      `/auth/capability-rooms/${ROOM}/revoke`,
    );
    // A failed disconnect is reported: the server may still hold the copy.
    expect(
      (await disconnectProject(ROOM, answering(404, { ok: false }))).ok,
    ).toBe(false);
  });
});

describe("openConnectorReplica", () => {
  it("joins the project's connector room on the relay", () => {
    const urls: string[] = [];
    const socket = {
      readyState: 0,
      send: () => undefined,
      close: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as WebSocketLike;
    const replica = openConnectorReplica(
      new CollabDocument("= Title\n"),
      "wss://galley.test/sync/",
      ROOM,
      (url) => {
        urls.push(url);
        return socket;
      },
    );
    expect(urls).toEqual([`wss://galley.test/sync/${ROOM}`]);
    replica.destroy();
  });
});

describe("tokens", () => {
  const listed = {
    tokenId: "aaaaaaaaaaaaaaaa",
    name: "Claude chat",
    createdAtMs: 1,
    expiresAtMs: 2,
  };

  it("create returns the secret once, alongside what will be listed", async () => {
    const fetchImpl = answering(200, {
      ok: true,
      token: "gly_secret",
      ...listed,
    });
    expect(await createConnectorToken("Claude chat", 90, fetchImpl)).toEqual({
      ok: true,
      secret: "gly_secret",
      token: listed,
    });
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/auth/connector/tokens");
    expect(JSON.parse(init!.body!)).toEqual({
      name: "Claude chat",
      expiresInDays: 90,
    });
    // An answer without a secret is a failure, not an empty token.
    expect(
      (
        await createConnectorToken(
          "x",
          90,
          answering(200, { ok: true, ...listed }),
        )
      ).ok,
    ).toBe(false);
  });

  it("lists well-formed tokens and revokes by id", async () => {
    const list = answering(200, { ok: true, tokens: [listed, { tokenId: 7 }] });
    expect(await listConnectorTokens(list)).toEqual({
      ok: true,
      tokens: [listed],
    });
    const revoke = answering(200, { ok: true });
    expect(await revokeConnectorToken(listed.tokenId, revoke)).toEqual({
      ok: true,
    });
    expect(revoke.mock.calls[0]![0]).toBe(
      `/auth/connector/tokens/${listed.tokenId}/revoke`,
    );
  });
});

describe("what the connector applied", () => {
  const CHECKPOINT = `${"0".repeat(13)}-${"a".repeat(64)}`;
  const entry = {
    version: 1,
    changeId: "c1",
    state: "applied",
    atMs: 2,
    tokenId: "aaaaaaaaaaaaaaaa",
    request: "Fix a typo",
    files: ["/main.typ"],
    ops: 1,
    bytes: 3,
    checkpointId: CHECKPOINT,
  };

  it("lists well-formed changes with whether they can be undone", async () => {
    const fetchImpl = answering(200, {
      ok: true,
      changes: [
        { ...entry, restorable: true },
        { ...entry, changeId: "c2" },
        { ...entry, state: "exploded" },
      ],
    });
    expect(await listConnectorActivity(ROOM, fetchImpl)).toEqual({
      ok: true,
      changes: [
        { ...entry, restorable: true },
        { ...entry, changeId: "c2", restorable: false },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `/auth/connector/projects/${ROOM}/activity`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("reads a checkpoint only when it is what it should be", async () => {
    const good = {
      version: 1,
      files: [{ path: "main.typ", text: "x" }],
      binaryFiles: [],
    };
    expect(
      await fetchConnectorCheckpoint(ROOM, CHECKPOINT, answering(200, good)),
    ).toEqual(good);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, files: [{ path: "main.typ" }] },
      { ...good, binaryFiles: [{ path: "/a.png" }] },
      null,
    ])
      expect(
        await fetchConnectorCheckpoint(ROOM, CHECKPOINT, answering(200, bad)),
      ).toBeNull();
    expect(
      await fetchConnectorCheckpoint(ROOM, CHECKPOINT, answering(404, {})),
    ).toBeNull();
    // A malformed id never becomes part of an address.
    const never = answering(200, good);
    expect(await fetchConnectorCheckpoint(ROOM, "../x", never)).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
