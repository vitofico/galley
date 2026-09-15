#!/usr/bin/env node
/**
 * The `galley-mcp` executable.
 *
 * Everything that prints a kernel command — the `--help` usage text in
 * `../src/config.ts`, the copyable pairing command in the browser's
 * Settings → Agent Access panel, and both MCP docs — says `galley-mcp …`.
 * Until this file existed that name resolved to nothing: the package carries no
 * published artifact, so a user who clicked **Copy** and pasted got
 * `command not found`. This is the file that makes the printed command true,
 * once per machine, via `pnpm --filter @galley/mcp link --global`.
 *
 * It runs the TypeScript source THROUGH tsx rather than a compiled `dist/`, for
 * one reason: a linked `dist/` goes stale the moment you `git pull`, and a
 * kernel that silently runs last week's code is worse than one that does not
 * run at all. `start` (`tsx src/main.ts`) already works this way, so the linked
 * binary and the npm script execute byte-identical code paths.
 *
 * tsx is registered in-process rather than spawned as a child, so this stays ONE
 * process: stdio is the MCP transport, and an intermediate process would put a
 * pipe between the client and the server for signals and backpressure to get
 * wrong.
 *
 * When the package is eventually published (the kernel is meant to be
 * installable without cloning), point `bin` at the built `dist/main.js` instead
 * and drop the tsx hop — a published tarball ships compiled JS and cannot go
 * stale against a checkout that is not there.
 */
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/main.ts", import.meta.url).href);
