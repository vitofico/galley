// First-party Web Worker entry. Vite bundles this (the URL is local to the app),
// and the actual handler lives in @galley/compiler.
import { serveWorker } from "@galley/compiler";
import type { WorkerScope } from "@galley/compiler";

serveWorker(self as unknown as WorkerScope);
