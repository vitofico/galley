import { describe, it, expect } from "vitest";
import { AgentAccessSettings } from "./AgentAccessSettings.js";

/**
 * Contract test for the Agent Access settings surface (#16.3 responder-mount).
 *
 * Like the sibling `.test.tsx` files (CompilerModeToggle.test.tsx), this does NOT
 * render: the workspace gate runs in the `node` environment with NO jsdom and a
 * `*.test.ts`-only include, so this file is excluded from the gate and documents
 * the mount contract only. The real behaviour is covered by the pure offline
 * `control-responder-mount.test.ts`.
 */
describe("AgentAccessSettings contract", () => {
  it("is a React function component taking no props", () => {
    expect(typeof AgentAccessSettings).toBe("function");
    expect(AgentAccessSettings.length).toBe(0);
  });
});
