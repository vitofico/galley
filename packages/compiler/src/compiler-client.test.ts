import { describe, it, expect, beforeAll, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TypstEngine } from "./typst-engine.js";
import { handleCompile } from "./worker-protocol.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";
import { CompileCancelledError, CompileTimeoutError, CompilerClient } from "./compiler-client.js";
import type { WorkerTransport } from "./compiler-client.js";

const require = createRequire(import.meta.url);
function wasmFor(pkg: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(dirname(require.resolve(pkg)), file)));
}

let engine: TypstEngine;
beforeAll(async () => {
  engine = await TypstEngine.create({
    compilerModule: wasmFor("@myriaddreamin/typst-ts-web-compiler", "typst_ts_web_compiler_bg.wasm"),
    rendererModule: wasmFor("@myriaddreamin/typst-ts-renderer", "typst_ts_renderer_bg.wasm"),
  });
}, 60_000);

/**
 * A simulated worker: routes compile requests to the real engine via the
 * dispatcher and delivers responses. `manual` mode defers delivery so we can
 * test cancellation of in-flight jobs.
 */
function makeTransport(manual = false) {
  let handler: ((m: WorkerResponse) => void) | null = null;
  const queue: WorkerResponse[] = [];
  const transport: WorkerTransport = {
    post(msg: WorkerRequest) {
      if (msg.type === "cancel" || msg.type === "init") return;
      void handleCompile(engine, msg).then((res) => {
        if (manual) queue.push(res);
        else handler?.(res);
      });
    },
    onMessage(cb) {
      handler = cb;
    },
    terminate() {},
  };
  return { transport, flush: () => queue.splice(0).forEach((m) => handler?.(m)) };
}

describe("CompilerClient round-trip (real engine via simulated worker)", () => {
  it("checks a good document", async () => {
    const client = new CompilerClient(makeTransport().transport);
    const res = await client.check("= Hi\nbody");
    expect(res.ok).toBe(true);
    expect(res.pageCount).toBeGreaterThanOrEqual(1);
  });

  it("renders an SVG and exports a PDF through the protocol", async () => {
    const client = new CompilerClient(makeTransport().transport);
    const render = await client.render("= Hi");
    expect(render.pages[0]!.svg).toContain("<svg");
    const exported = await client.export("= Hi");
    expect(new TextDecoder().decode(exported.pdf!.slice(0, 5))).toBe("%PDF-");
  });

  it("checks a multi-file ProjectInput through the protocol (virtual #import resolves)", async () => {
    const client = new CompilerClient(makeTransport().transport);
    const res = await client.check({
      kind: "project",
      main: "/main.typ",
      files: [
        { path: "/main.typ", text: '#import "/lib.typ": x\n#x' },
        { path: "/lib.typ", text: "#let x = [ok]" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("surfaces diagnostics for a broken document", async () => {
    const client = new CompilerClient(makeTransport().transport);
    const res = await client.check("#let x =");
    expect(res.ok).toBe(false);
    expect(res.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("rejects in-flight jobs on cancel and ignores their late results", async () => {
    const { transport, flush } = makeTransport(true);
    const client = new CompilerClient(transport);
    const pending = client.check("= Hi");
    client.cancel(); // reject before the deferred result is delivered
    await expect(pending).rejects.toBeInstanceOf(CompileCancelledError);
    // The late result now arrives; it must be ignored (no unhandled rejection).
    flush();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("rejects a job that never responds with CompileTimeoutError", async () => {
    const { transport, flush } = makeTransport(true); // deferred; never flushed
    const client = new CompilerClient(transport, { timeoutMs: 30 });
    await expect(client.check("= Hi")).rejects.toBeInstanceOf(CompileTimeoutError);
    // A late result after the timeout is ignored (no unhandled rejection).
    flush();
    await new Promise((r) => setTimeout(r, 0));
  });
});

/**
 * A scripted transport whose lifecycle is observable. Compiles never resolve on
 * their own (so the client's timeout always fires); `terminate()` is recorded.
 * A `createTransport` factory hands out a fresh one each call, letting us prove
 * the client terminates a wedged worker and respawns a clean one.
 */
function makeRespawnFactory() {
  const transports: Array<{
    terminated: boolean;
    posts: WorkerRequest[];
    deliver: (m: WorkerResponse) => void;
  }> = [];
  const createTransport = (): WorkerTransport => {
    let handler: ((m: WorkerResponse) => void) | null = null;
    const rec = {
      terminated: false,
      posts: [] as WorkerRequest[],
      deliver: (m: WorkerResponse) => handler?.(m),
    };
    transports.push(rec);
    return {
      post(msg) {
        rec.posts.push(msg);
      },
      onMessage(cb) {
        handler = cb;
      },
      terminate() {
        rec.terminated = true;
      },
    };
  };
  return { createTransport, transports };
}

describe("CompilerClient worker respawn on timeout (worker-factory seam)", () => {
  it("terminates the wedged worker and respawns a fresh one on timeout", async () => {
    const { createTransport, transports } = makeRespawnFactory();
    const client = new CompilerClient(createTransport(), { timeoutMs: 20, createTransport });
    expect(transports).toHaveLength(1);

    await expect(client.check("= Hi")).rejects.toBeInstanceOf(CompileTimeoutError);

    // The stuck worker was terminated and a fresh one spun up.
    expect(transports[0]!.terminated).toBe(true);
    expect(transports).toHaveLength(2);
    expect(transports[1]!.terminated).toBe(false);
  });

  it("runs a subsequent compile on the fresh worker after a timeout", async () => {
    const { createTransport, transports } = makeRespawnFactory();
    const client = new CompilerClient(createTransport(), { timeoutMs: 20, createTransport });

    await expect(client.check("= Hi")).rejects.toBeInstanceOf(CompileTimeoutError);
    expect(transports).toHaveLength(2);

    // The next compile is posted to the fresh transport (index 1), not the dead one.
    const next = client.check("= Again");
    const fresh = transports[1]!;
    const posted = fresh.posts.find((p) => p.type === "check");
    expect(posted).toBeDefined();
    fresh.deliver({
      type: "check_result",
      jobId: (posted as { jobId: number }).jobId,
      result: { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 },
    });
    const res = await next;
    expect(res.ok).toBe(true);
    // The dead worker received nothing after termination.
    expect(transports[0]!.posts.some((p) => p.type === "check" && p.input === "= Again")).toBe(false);
  });

  it("respawns the worker when an in-flight job is abandoned via cancel", async () => {
    const { createTransport, transports } = makeRespawnFactory();
    const client = new CompilerClient(createTransport(), {
      timeoutMs: 0,
      createTransport,
      respawnOnCancel: true,
    });

    const pending = client.check("= Hi"); // never resolves
    client.cancel();
    await expect(pending).rejects.toBeInstanceOf(CompileCancelledError);

    expect(transports[0]!.terminated).toBe(true);
    expect(transports).toHaveLength(2);
  });

  it("does not respawn on a clean (non-timeout, non-cancel) compile", async () => {
    const { transport, flush } = makeTransport(); // real engine, auto-delivers
    let factoryCalls = 0;
    const client = new CompilerClient(transport, {
      createTransport: () => {
        factoryCalls++;
        return transport;
      },
    });
    const res = await client.check("= Hi");
    expect(res.ok).toBe(true);
    // No timeout, no cancel → the worker is never torn down or respawned.
    expect(factoryCalls).toBe(0);
  });

  it("a stale sibling timer cannot terminate the freshly respawned worker", async () => {
    // Regression: with two concurrent jobs on worker A, job1's timeout terminates
    // A and respawns B. job2 must be drained (rejected, timer cleared) by that
    // teardown so its later-firing timer can NEVER terminate B and kill a job3
    // that is now running on B.
    vi.useFakeTimers();
    try {
      const { createTransport, transports } = makeRespawnFactory();
      const client = new CompilerClient(createTransport(), { timeoutMs: 20, createTransport });

      // Capture outcomes eagerly so neither promise can become an unhandled
      // rejection when its timer fires synchronously under fake timers.
      const job1 = client.check("= One").then(
        () => "resolved",
        (e: unknown) => (e instanceof CompileTimeoutError ? "timeout" : `other:${String(e)}`),
      );
      // Stagger job2 so its timer (t≈25) fires strictly AFTER job1's (t=20).
      await vi.advanceTimersByTimeAsync(5);
      const job2 = client.check("= Two").then(
        () => "resolved",
        (e: unknown) => (e instanceof CompileCancelledError ? "cancelled" : `other:${String(e)}`),
      );

      // Fire job1's timer (t=20): terminate A, respawn B, drain job2.
      await vi.advanceTimersByTimeAsync(15);
      expect(await job1).toBe("timeout");
      expect(await job2).toBe("cancelled"); // drained by the teardown, not left pending
      expect(transports).toHaveLength(2);
      expect(transports[0]!.terminated).toBe(true); // worker A
      expect(transports[1]!.terminated).toBe(false); // fresh worker B

      // A third job now runs on the fresh worker B and completes promptly (so its
      // own timer is cleared and only job2's stale timer remains a concern).
      const job3 = client.check("= Three");
      const fresh = transports[1]!;
      const posted = fresh.posts.find((p) => p.type === "check" && p.input === "= Three");
      expect(posted).toBeDefined();
      fresh.deliver({
        type: "check_result",
        jobId: (posted as { jobId: number }).jobId,
        result: { ok: true, diagnostics: [], pageCount: 1, durationMs: 0 },
      });
      await expect(job3).resolves.toMatchObject({ ok: true });

      // Advance well past job2's original deadline (t≈25): its timer was cleared
      // on drain, so it must NOT fire — the fresh worker B is never terminated and
      // no spurious respawn occurs. (job3 already settled, so no live timers left.)
      await vi.advanceTimersByTimeAsync(50);
      expect(transports[1]!.terminated).toBe(false);
      expect(transports).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
