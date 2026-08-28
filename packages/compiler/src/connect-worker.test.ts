import { describe, it, expect } from "vitest";
import { connectCompilerWorker, CompileTimeoutError } from "./index.js";
import type { CompilerAssets, CompilerWorkerHandle } from "./index.js";
import type { WorkerResponse } from "./worker-protocol.js";

/**
 * A fake, in-process `CompilerWorkerHandle`. It records every `postMessage`,
 * lets the test deliver `WorkerResponse`s back to listeners, and tracks
 * `terminate()`. No real worker / WASM — this pins the production wiring that
 * `connectCompilerWorker` builds a respawn factory reachable in the browser path
 * (not just the directly-injected CompilerClient seam).
 */
interface FakeWorker extends CompilerWorkerHandle {
  posts: unknown[];
  terminated: boolean;
  deliver(message: WorkerResponse): void;
}

function makeFakeWorkerFactory() {
  const workers: FakeWorker[] = [];
  const createWorker = (): CompilerWorkerHandle => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const fake: FakeWorker = {
      posts: [],
      terminated: false,
      postMessage(message: unknown) {
        fake.posts.push(message);
      },
      addEventListener(_type: "message", handler: (event: MessageEvent) => void) {
        listeners.add(handler);
      },
      removeEventListener(_type: "message", handler: (event: MessageEvent) => void) {
        listeners.delete(handler);
      },
      terminate() {
        fake.terminated = true;
      },
      deliver(message: WorkerResponse) {
        for (const handler of listeners) handler({ data: message } as MessageEvent);
      },
    };
    workers.push(fake);
    return fake;
  };
  return { createWorker, workers };
}

const ASSETS: CompilerAssets = {
  wasmUrl: "/compiler.wasm",
  rendererUrl: "/renderer.wasm",
  fontAssetPrefix: "/fonts/",
};

describe("connectCompilerWorker — production respawn wiring", () => {
  it("respawns a wedged worker on the timeout path", async () => {
    const { createWorker, workers } = makeFakeWorkerFactory();

    const connecting = connectCompilerWorker(createWorker, ASSETS, { timeoutMs: 20 });
    // The first worker must be created and receive an `init` post.
    expect(workers).toHaveLength(1);
    expect((workers[0]!.posts[0] as { type: string }).type).toBe("init");

    // Reply ready so the connect promise resolves (callers leave their loading state).
    workers[0]!.deliver({ type: "ready" });
    const compiler = await connecting;

    // A check the worker NEVER answers → the per-job timeout fires, terminates the
    // wedged worker, and respawns a fresh one.
    await expect(compiler.check("= Hi")).rejects.toBeInstanceOf(CompileTimeoutError);

    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.terminated).toBe(false);
    // The respawned worker received the SAME init message.
    expect((workers[1]!.posts[0] as { type: string }).type).toBe("init");
  });

  it("rejects when the first worker fails to initialize", async () => {
    const { createWorker, workers } = makeFakeWorkerFactory();
    const connecting = connectCompilerWorker(createWorker, ASSETS);
    workers[0]!.deliver({ type: "init_error", message: "boom" });
    await expect(connecting).rejects.toThrow("boom");
  });
});
