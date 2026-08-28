/**
 * Buffer bootstrap for the browser bundle (#17.2 fix; Architect-ruled wave-11).
 *
 * isomorphic-git's ESM build references the bare Node `Buffer` global (~76
 * sites: pkt-line codec, object encoding, pack building) with no
 * `import { Buffer } from "buffer"` of its own — so the in-browser push/fetch
 * path that node unit tests proved green threw `Buffer is not defined` at
 * real browser runtime (pinned by the wave-11 smart-HTTP probe,
 * apps/web/e2e/git-sync-live.spec.ts). This side-effect module installs the
 * standard feross `buffer` shim (~7 kB gzip) as the global ONLY when absent:
 * in Node the real Buffer already exists and this is a no-op, so test and
 * server behavior is untouched.
 *
 * It MUST be imported first from the `@galley/persistence/browser` barrel —
 * the single entry every browser git path goes through — so the global is in
 * place before any isomorphic-git code runs.
 */
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (g.Buffer === undefined) g.Buffer = Buffer;
