import { describe, expect, it, vi } from "vitest";
import {
  createHostedRunsClient,
  hostedPrompt,
  hostedRunsConfig,
  parseHostedStatus,
} from "./hosted-runs-client.js";

describe("optional hosted execution client", () => {
  it("is absent by default and refuses external, protocol-relative and encoded paths", () => {
    expect(hostedRunsConfig({})).toBeNull();
    for (const apiPath of [
      "https://elsewhere/api/agent-runs",
      "//elsewhere/api/agent-runs",
      "/cloud/%2f/api/agent-runs",
      "/cloud/../api/agent-runs",
      "/cloud/api/agent-runs?next=x",
      "/cloud\\api/agent-runs",
    ]) {
      expect(hostedRunsConfig({ hostedRuns: { apiPath } })).toBeNull();
    }
    expect(
      hostedRunsConfig({
        hostedRuns: {
          apiPath: "/cloud/api/agent-runs",
          accountPath: "/cloud/dashboard",
        },
      }),
    ).toEqual({
      apiPath: "/cloud/api/agent-runs",
      accountPath: "/cloud/dashboard",
    });
  });
  it("captures exact source without truncation and rejects oversized UTF-8 snapshots", () => {
    const file = { path: "/main.typ", text: '= Original\n"quoted" 🌱' };
    const prompt = hostedPrompt("  Revise it  ", file);
    file.text = "later typing";
    expect(JSON.parse(prompt)).toEqual({
      request: "Revise it",
      files: [{ path: "/main.typ", text: '= Original\n"quoted" 🌱' }],
    });
    expect(() =>
      hostedPrompt("x", { path: "/main.typ", text: "🌱".repeat(4000) }),
    ).toThrow(/12 KiB/);
    expect(() => hostedPrompt(" ", file)).toThrow(/request/);
  });
  it("never automatically repeats a failed create and never surfaces raw provider error text", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ error: "unknown", reason: "sk-SECRET" }),
          { status: 500 },
        ),
    );
    const client = createHostedRunsClient(
      { apiPath: "/cloud/api/agent-runs" },
      fetcher,
    );
    await expect(
      client.create({
        prompt: "p",
        keyName: "default",
        clientRef: "project",
        draftTarget: { syncUrl: "wss://relay", room: "CAP" },
      }),
    ).rejects.toThrow(/Refresh status/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      method: "POST",
    });
  });
  it("validates status and uses write-only key endpoints without persisting secrets", async () => {
    const status = {
      runs: [],
      access: "enabled",
      keyConfigured: true,
      documentRuns: true,
    };
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(status)),
    );
    const client = createHostedRunsClient(
      { apiPath: "/cloud/api/agent-runs" },
      fetcher,
    );
    expect(await client.status("default")).toEqual(status);
    await client.saveKey("default", "test-only");
    await client.removeKey("default");
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/cloud/api/agent-runs?keyName=default",
      "/cloud/api/model-keys/default",
      "/cloud/api/model-keys/default",
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(() =>
      parseHostedStatus({
        ...status,
        runs: [{ id: "<bad>", state: "running" }],
      }),
    ).toThrow(/invalid run/);
  });
});
