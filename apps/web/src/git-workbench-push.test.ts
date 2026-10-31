import { describe, expect, it } from "vitest";
import { CollabProject } from "@galley/collab";
import type { RemoteSync } from "@galley/persistence/browser";
import {
  materializeProjectForPush,
  pushGitRemote,
  pushGithubSnapshot,
} from "./git-sync-ops.js";
import { emptyWorkbench, WORKBENCH_PATH } from "./document-workbench.js";
import type { GithubFetch } from "./github-api.js";
const author = { kind: "human" as const, userId: "push-test" };
function projectWithMetadata(metadata = JSON.stringify(emptyWorkbench())) {
  const project = new CollabProject();
  project.seedIfPristine(
    [
      { path: "/main.typ", text: "Main" },
      { path: WORKBENCH_PATH, text: metadata },
      { path: "/.galley/device.json", text: "private-device-value" },
      { path: "/.galley/api-key", text: "private-key-value" },
    ],
    "/main.typ",
    author,
  );
  return project;
}
const cfg = { url: "https://example.test/paper.git", ref: "main" };
describe("the UI push materialization callback preserves workbench", () => {
  it("sends exact validated records to the generic Git transport with no device metadata", async () => {
    const project = projectWithMetadata();
    let paths: string[] = [],
      serialized = "";
    const sync: RemoteSync = {
      fetchTree: async () => null,
      pushTree: async (_cfg, _ref, files) => {
        paths = files.map((f) => f.path);
        serialized = JSON.stringify(files);
        return { oid: "a".repeat(40), ref: "refs/heads/main" };
      },
    };
    // ProjectApp supplies exactly this callback for both normal push transports.
    const outcome = await pushGitRemote(sync, cfg, () =>
      materializeProjectForPush(project),
    );
    expect(outcome.ok).toBe(true);
    expect(paths).toContain(".galley/workbench.json");
    expect(
      JSON.parse(serialized).find(
        (file: { path: string; text: string }) =>
          file.path === ".galley/workbench.json",
      ).text,
    ).toBe(JSON.stringify(emptyWorkbench()));
    expect(paths).not.toContain(".galley/device.json");
    expect(serialized).not.toContain("private-device-value");
    expect(serialized).not.toContain("private-key-value");
    project.destroy();
  });
  it("includes metadata in actual GitHub blob and replacement-tree request bodies", async () => {
    const project = projectWithMetadata();
    const bodies: unknown[] = [],
      blobs: string[] = [];
    const fetchImpl: GithubFetch = async (url, init) => {
      const path = new URL(url).pathname;
      const response = (body: unknown) => ({
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      });
      if (init.method === "GET") return response({ object: { sha: "base" } });
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (path.endsWith("/git/blobs")) {
        blobs.push(body.content);
        return response({ sha: `blob-${blobs.length}` });
      }
      if (path.endsWith("/git/trees")) return response({ sha: "tree" });
      if (path.endsWith("/git/commits"))
        return response({ sha: "c".repeat(40) });
      return response({ object: { sha: "c".repeat(40) } });
    };
    const result = await pushGithubSnapshot(
      async () => materializeProjectForPush(project),
      {
        connection: { login: "author", token: "test" },
        repo: { owner: "author", name: "paper", branch: "main" },
        fetchImpl,
      },
    );
    expect(result.ok).toBe(true);
    expect(blobs).toContain(JSON.stringify(emptyWorkbench()));
    const treeBody = bodies.find(
      (body) =>
        !!body &&
        typeof body === "object" &&
        "tree" in body &&
        Array.isArray(body.tree),
    ) as { tree: { path: string }[] };
    expect(treeBody.tree.map((entry) => entry.path)).toContain(
      ".galley/workbench.json",
    );
    expect(JSON.stringify(bodies)).not.toContain("private-device-value");
    expect(JSON.stringify(bodies)).not.toContain("private-key-value");
    project.destroy();
  });
  it("rejects malformed metadata before either transport sends requests", async () => {
    const project = projectWithMetadata("malformed");
    let requests = 0;
    const sync: RemoteSync = {
      fetchTree: async () => null,
      pushTree: async () => {
        requests++;
        throw new Error("Must not push");
      },
    };
    expect(
      (await pushGitRemote(sync, cfg, () => materializeProjectForPush(project)))
        .ok,
    ).toBe(false);
    expect(
      (
        await pushGithubSnapshot(
          async () => materializeProjectForPush(project),
          {
            connection: { login: "author", token: "test" },
            repo: { owner: "author", name: "paper", branch: "main" },
            fetchImpl: async () => {
              requests++;
              throw new Error("Must not push");
            },
          },
        )
      ).ok,
    ).toBe(false);
    expect(requests).toBe(0);
    project.destroy();
  });
});
