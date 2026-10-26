import { describe, expect, it } from "vitest";
import {
  forgetHostedRunTarget,
  readHostedRunTarget,
  rememberHostedRunTarget,
} from "./hosted-run-target.js";
describe("consented hosted mailbox recovery", () => {
  it("scopes the saved target to project, hosted mount and currently configured relay", () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const target = {
      syncUrl: "wss://relay.example/sync",
      room: "share-private-capability",
    };
    expect(
      rememberHostedRunTarget("p", "/cloud/api/agent-runs", target, store),
    ).toBe(true);
    expect(
      readHostedRunTarget("p", "/cloud/api/agent-runs", target.syncUrl, store),
    ).toEqual(target);
    expect(
      readHostedRunTarget(
        "other",
        "/cloud/api/agent-runs",
        target.syncUrl,
        store,
      ),
    ).toBeNull();
    expect(
      readHostedRunTarget("p", "/other/api/agent-runs", target.syncUrl, store),
    ).toBeNull();
    expect(
      readHostedRunTarget(
        "p",
        "/cloud/api/agent-runs",
        "wss://different",
        store,
      ),
    ).toBeNull();
    forgetHostedRunTarget("p", "/cloud/api/agent-runs", store);
    expect(
      readHostedRunTarget("p", "/cloud/api/agent-runs", target.syncUrl, store),
    ).toBeNull();
  });
});
