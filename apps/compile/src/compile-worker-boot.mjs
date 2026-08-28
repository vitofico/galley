/**
 * The production `worker_thread` entry when the compile service runs from TS
 * SOURCE (how the runtime image and the k8s deploy start it: `tsx src/server.ts`).
 *
 * WHY THIS FILE EXISTS: a worker thread does NOT inherit tsx's ESM loader hooks
 * from the parent, and `--import` in a worker's `execArgv` is ignored by Node — so
 * a thread spawned under tsx has no TypeScript support and cannot load
 * `compile-worker.ts`. A thread CAN, however, register the hooks ITSELF. This
 * bootstrap does exactly that, then hands off to the real entry.
 *
 * It is plain `.mjs` on purpose: it must be loadable by a bare Node worker with no
 * loader installed yet — that is the whole point. Keep it dependency-free beyond
 * `tsx`, which is already a production dependency of this package (see
 * package.json), so this adds NO new dependency.
 *
 * Selection is DETERMINISTIC, not a fallback: `realWorkerFactory` picks this file
 * only when it is itself running from `.ts`, and picks the sibling
 * `compile-worker.js` when running from a compiled `.js` build. See the entry-mode
 * note in isolated-backend.ts. A compiled build never loads this file, which is
 * why `tsc` not emitting it is fine.
 */
import { register } from "tsx/esm/api";

register();

await import("./compile-worker.ts");
