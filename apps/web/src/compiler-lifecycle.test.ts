/** Deferred worker ownership tests against the real hook/component, without WASM or a DOM. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "@galley/shared";
import type { Compiler } from "@galley/compiler";
import type {
  AgentRunResult,
  FigureResult,
  LanguageModelClient,
} from "@galley/agent";
import type { FigurePanelProps } from "./components/FigurePanel.js";
import type { VerifyCompiler } from "./components/figure-verify.js";

// A small hook runner preserves refs/state across renders and executes effect
// cleanup on dependency changes/unmount. No production lifecycle is duplicated.
const hooks = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: {
    deps: readonly unknown[] | undefined;
    cleanup: (() => void) | undefined;
  }[] = [];
  let slot = 0,
    effect = 0;
  let pending: (() => void)[] = [];
  return {
    useRef<T>(value: T): { current: T } {
      const index = slot++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index] as { current: T };
    },
    useState<T>(
      initial: T | (() => T),
    ): [T, (value: T | ((prior: T) => T)) => void] {
      const index = slot++;
      if (!(index in slots))
        slots[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        slots[index] as T,
        (value) => {
          slots[index] =
            typeof value === "function"
              ? (value as (prior: T) => T)(slots[index] as T)
              : value;
        },
      ];
    },
    useEffect(setup: () => void | (() => void), deps?: readonly unknown[]) {
      const index = effect++,
        previous = effects[index];
      if (
        !previous ||
        !deps ||
        deps.some((value, i) => !Object.is(previous.deps?.[i], value))
      ) {
        pending.push(() => {
          previous?.cleanup?.();
          effects[index] = { deps, cleanup: setup() || undefined };
        });
      }
    },
    render<T>(component: () => T): T {
      slot = 0;
      effect = 0;
      const output = component();
      const commit = pending;
      pending = [];
      for (const run of commit) run();
      return output;
    },
    unmount() {
      for (const entry of effects) entry?.cleanup?.();
      effects.length = 0;
    },
    reset() {
      slots.length = 0;
      effects.length = 0;
      pending = [];
      slot = 0;
      effect = 0;
    },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: hooks.useRef,
  useState: hooks.useState,
  useEffect: hooks.useEffect,
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("./compiler-assets.js", () => ({ initCompiler: vi.fn() }));
vi.mock("@galley/agent", () => ({
  runAgent: vi.fn(),
  figureToTypst: vi.fn(),
  cetzScaffold: () => "cetz scaffold",
}));
vi.mock("./components/DiffReview.js", () => ({ DiffReview: "diff-review" }));
vi.mock("./components/figure-vision-tools.js", () => ({
  FigureVisionTools: "vision-tools",
}));
import { initCompiler } from "./compiler-assets.js";
import { runAgent, figureToTypst } from "@galley/agent";
import { useAgent } from "./useAgent.js";
import { FigurePanel } from "./components/FigurePanel.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function worker() {
  return {
    dispose: vi.fn(),
    check: vi.fn(
      async (): Promise<CheckResult> => ({
        ok: true,
        diagnostics: [],
        pageCount: 1,
        durationMs: 0,
      }),
    ),
  };
}
const model = {} as LanguageModelClient;
const agentResult: AgentRunResult = {
  outcome: "compiled_clean",
  finalSource: "new",
  blocks: [],
  check: null,
};
const figureResult: FigureResult = {
  typst: "cetz new",
  ok: true,
  attempts: 1,
  diagnostics: [],
};
const init = vi.mocked(initCompiler);
const agent = vi.mocked(runAgent);
const figure = vi.mocked(figureToTypst);
async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  vi.resetAllMocks();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  agent.mockImplementation(async function* () {
    return agentResult;
  });
  figure.mockResolvedValue(figureResult);
});
afterEach(() => {
  hooks.unmount();
  vi.unstubAllGlobals();
});

describe("agent scratch compiler ownership", () => {
  it("disposes initialization that finishes after unmount and never starts the agent", async () => {
    const pending = deferred<Compiler>(),
      compiler = worker();
    init.mockReturnValue(pending.promise);
    const hook = hooks.render(useAgent);
    const running = hook.run("request", "source", model);
    hooks.unmount();
    pending.resolve(compiler as unknown as Compiler);
    await running;
    expect(compiler.dispose).toHaveBeenCalledOnce();
    expect(agent).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "Stop/rerun disposes both workers exactly once (stale init resolves first: %s)",
    async (staleFirst) => {
      const first = deferred<Compiler>(),
        second = deferred<Compiler>();
      const stale = worker(),
        current = worker();
      init
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const hook = hooks.render(useAgent);
      const oldRun = hook.run("old", "source", model);
      hook.cancel();
      const newRun = hook.run("new", "source", model);
      if (staleFirst) {
        first.resolve(stale as unknown as Compiler);
        await oldRun;
        second.resolve(current as unknown as Compiler);
      } else {
        second.resolve(current as unknown as Compiler);
        await newRun;
        first.resolve(stale as unknown as Compiler);
      }
      await Promise.all([oldRun, newRun]);
      expect(agent).toHaveBeenCalledOnce();
      expect(agent.mock.calls[0]![0].userRequest).toBe("new");
      expect(agent.mock.calls[0]![0].compiler).toBe(current);
      expect(hooks.render(useAgent).result).toBe(agentResult);
      expect(stale.dispose).toHaveBeenCalledOnce();
      expect(current.dispose).not.toHaveBeenCalled();
      hooks.unmount();
      expect(current.dispose).toHaveBeenCalledOnce();
    },
  );

  it("retries failed initialization, then reuses the owned scratch compiler", async () => {
    const compiler = worker();
    init
      .mockRejectedValueOnce(new Error("init failed"))
      .mockResolvedValue(compiler as unknown as Compiler);
    const hook = hooks.render(useAgent);
    await hook.run("first", "source", model);
    expect(hooks.render(useAgent).error).toBe("init failed");
    await hook.run("retry", "source", model);
    await hook.run("reuse", "source", model);
    expect(init).toHaveBeenCalledTimes(2);
    expect(agent).toHaveBeenCalledTimes(2);
    hooks.unmount();
    expect(compiler.dispose).toHaveBeenCalledOnce();
  });
});

interface ElementLike {
  props: {
    children?: unknown;
    "data-testid"?: string;
    onClick?: () => void;
    onChange?: (event: { target: { value: string } }) => void;
  };
}
function find(node: unknown, id: string): ElementLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, id);
      if (hit) return hit;
    }
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as ElementLike;
    if (element.props["data-testid"] === id) return element;
    return find(element.props.children, id);
  }
  return undefined;
}
function panel(overrides: Partial<FigurePanelProps> = {}) {
  let props: FigurePanelProps = {
    open: true,
    onClose: vi.fn(),
    model,
    currentSource: "",
    onInsert: () => true,
    ...overrides,
  };
  let tree: unknown;
  const render = (changes: Partial<FigurePanelProps> = {}) => {
    props = { ...props, ...changes };
    tree = hooks.render(() => FigurePanel(props));
  };
  render();
  find(tree, "figure-description")!.props.onChange!({
    target: { value: "diagram" },
  });
  render();
  return {
    render,
    click(id: string) {
      find(tree, id)!.props.onClick!();
    },
    get(id: string) {
      return find(tree, id);
    },
  };
}

describe("figure compiler ownership", () => {
  it.each(["close", "unmount"])(
    "disposes a late generate compiler after %s without calling the provider",
    async (action) => {
      const pending = deferred<Compiler>(),
        compiler = worker();
      init.mockReturnValue(pending.promise);
      const view = panel();
      view.click("figure-generate");
      if (action === "close") view.render({ open: false });
      else hooks.unmount();
      pending.resolve(compiler as unknown as Compiler);
      await settle();
      expect(compiler.dispose).toHaveBeenCalledOnce();
      expect(figure).not.toHaveBeenCalled();
    },
  );

  it("a late initialization cannot overwrite the reopened panel's compiler or pending state", async () => {
    const first = deferred<Compiler>(),
      second = deferred<Compiler>();
    const stale = worker(),
      current = worker();
    init.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = panel();
    view.click("figure-generate");
    view.render({ open: false });
    view.render({ open: true });
    view.render(); // commit the open-effect's idle state
    view.click("figure-generate");
    first.resolve(stale as unknown as Compiler);
    await settle();
    view.render();
    expect(view.get("figure-generate")!.props.children).toBe("Generating…");
    second.resolve(current as unknown as Compiler);
    await settle();
    expect(figure).toHaveBeenCalledOnce();
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(current.dispose).not.toHaveBeenCalled();
    hooks.unmount();
    expect(current.dispose).toHaveBeenCalledOnce();
  });

  it("ignores an old provider result after close/reopen", async () => {
    const oldResult = deferred<FigureResult>();
    init.mockResolvedValue(worker() as unknown as Compiler);
    figure
      .mockReturnValueOnce(oldResult.promise)
      .mockResolvedValueOnce(figureResult);
    const view = panel();
    view.click("figure-generate");
    await settle();
    view.render({ open: false });
    view.render({ open: true });
    view.render();
    view.click("figure-generate");
    await settle();
    oldResult.resolve({
      ...figureResult,
      typst: "old response without cetz",
      ok: false,
    });
    await settle();
    view.render();
    expect(view.get("figure-status")!.props.children).toBe(
      "Compiles cleanly (in 1 round).",
    );
  });

  it.each(["close", "unmount"])(
    "disposes a late verify factory after %s without compiling",
    async (action) => {
      const pending = deferred<VerifyCompiler>(),
        verify = worker(),
        generate = worker();
      init.mockResolvedValue(generate as unknown as Compiler);
      const factory = vi.fn(() => pending.promise);
      const view = panel({ verifyCompilerFactory: factory });
      view.click("figure-generate");
      await settle();
      view.render();
      view.click("figure-verify-run");
      if (action === "close") view.render({ open: false });
      else hooks.unmount();
      pending.resolve(verify);
      await settle();
      expect(verify.dispose).toHaveBeenCalledOnce();
      expect(verify.check).not.toHaveBeenCalled();
      expect(generate.dispose).toHaveBeenCalledOnce();
    },
  );

  it("keeps a reopened verification result when the previous compile completes late", async () => {
    const oldCheck = deferred<Awaited<ReturnType<VerifyCompiler["check"]>>>();
    const stale = worker(),
      current = worker();
    stale.check.mockReturnValueOnce(oldCheck.promise);
    init.mockResolvedValue(worker() as unknown as Compiler);
    const factory = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current);
    const view = panel({ verifyCompilerFactory: factory });
    view.click("figure-generate");
    await settle();
    view.render();
    view.click("figure-verify-run");
    await settle();
    view.render({ open: false });
    view.render({ open: true });
    view.render();
    view.click("figure-verify-run");
    await settle();
    oldCheck.resolve({
      ok: false,
      diagnostics: [],
      pageCount: null,
      durationMs: 0,
    });
    await settle();
    view.render();
    expect(view.get("figure-verify-result")!.props.children).toContain(
      "Verified",
    );
    expect(stale.dispose).toHaveBeenCalledOnce();
    hooks.unmount();
    expect(current.dispose).toHaveBeenCalledOnce();
  });
});
