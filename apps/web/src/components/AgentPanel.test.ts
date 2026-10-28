import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// A small hook driver exercises the real checkpoint continuation without a DOM
// or WASM worker. Child components remain JSX elements and are not mounted.
const harness = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[],
  agent: {
    result: null as null | {
      outcome: string;
      finalSource: string;
      blocks: { search: string; replace: string }[];
    },
    baseSource: "Original",
    events: [] as { type: string }[],
    running: false,
    stopped: false,
    error: null,
    usage: { totalTokens: 0 },
    run: vi.fn(),
    clear: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => {
    const i = harness.cursor++;
    return (harness.slots[i] ??= { current: initial });
  },
  useState: (initial: unknown) => {
    const i = harness.cursor++;
    if (!(i in harness.slots)) harness.slots[i] = initial;
    return [
      harness.slots[i],
      (next: unknown) => {
        harness.slots[i] =
          typeof next === "function" ? next(harness.slots[i]) : next;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = harness.cursor++;
    const previous = harness.slots[i] as unknown[] | undefined;
    if (!previous || deps.some((dep, n) => dep !== previous[n])) {
      harness.effects.push(effect);
      harness.slots[i] = deps;
    }
  },
}));
vi.mock("../useAgent.js", () => ({ useAgent: () => harness.agent }));
vi.mock("./useAgentSessions.js", () => ({
  useAgentSessions: () => ({
    activeId: "session",
    active: { messages: [] },
    sessions: [],
    appendMessage: vi.fn(),
  }),
}));
vi.mock("../in-app-audit.js", () => ({ appendInAppAudit: vi.fn() }));
import { AgentPanel, type InAppAutoSeam } from "./AgentPanel.js";
import { AgentComposer } from "./AgentComposer.js";

function composer(node: unknown): ReactElement<{ onSend: () => void }> | null {
  if (!node || typeof node !== "object") return null;
  const element = node as ReactElement<{ children?: unknown }>;
  if (element.type === AgentComposer)
    return element as ReactElement<{ onSend: () => void }>;
  for (const child of [element.props?.children].flat(Infinity)) {
    const found = composer(child);
    if (found) return found;
  }
  return null;
}

beforeEach(() => {
  harness.cursor = 0;
  harness.slots = [];
  harness.effects = [];
  harness.cleanups = [];
  harness.agent.result = null;
  vi.clearAllMocks();
});

describe("AgentPanel checkpoint lifetime", () => {
  it.each(["unmount", "new request", "unchanged"])(
    "guards checkpoint completion when %s",
    async (action) => {
      let resolveCheckpoint!: (id: string) => void;
      const checkpoint = new Promise<string>((resolve) => {
        resolveCheckpoint = resolve;
      });
      const commit = vi.fn(() => true);
      const seam: InAppAutoSeam = {
        projectId: "project",
        mode: () => "auto",
        canMutate: true,
        checkpoint: () => checkpoint,
        commit,
        restore: vi.fn(),
      };
      const render = () => {
        harness.cursor = 0;
        const tree = AgentPanel({
          model: {} as never,
          source: "Original",
          onAccept: () => true,
          autoAccept: seam,
        });
        for (const effect of harness.effects.splice(0)) {
          const cleanup = effect();
          if (cleanup) harness.cleanups.push(cleanup);
        }
        return tree;
      };
      composer(render())!.props.onSend();
      harness.agent.result = {
        outcome: "compiled_clean",
        finalSource: "Changed",
        blocks: [{ search: "Original", replace: "Changed" }],
      };
      const finished = render();
      if (action === "unmount") {
        for (const cleanup of harness.cleanups) cleanup();
      } else if (action === "new request") {
        composer(finished)!.props.onSend();
      }
      resolveCheckpoint("checkpoint");
      await checkpoint;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commit).toHaveBeenCalledTimes(action === "unchanged" ? 1 : 0);
      for (const cleanup of harness.cleanups) cleanup();
    },
  );
});
