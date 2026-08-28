/**
 * Node entry point for the sync server. Binds `PORT` (default 1234) and stays up.
 *   pnpm --filter @galley/sync start
 *
 * The authorization decision (default OFF) lives in `buildSyncOptions` in
 * `server-config.ts` so it can be unit-tested without binding a socket. That
 * function FAILS CLOSED: `GALLEY_SYNC_AUTH=required` with a missing shared
 * `GALLEY_SESSION_DIR` / `GALLEY_DATA_DIR` throws here at startup rather than
 * running an "enforcing" relay that silently enforces nothing.
 */
import { startSyncServer } from "./sync-server.js";
import { buildSyncOptions } from "./server-config.js";

const port = Number.parseInt(process.env.PORT ?? "1234", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`PORT must be an integer 0-65535; got ${JSON.stringify(process.env.PORT)}`);
}

startSyncServer(port, buildSyncOptions())
  .then((handle) => {
    // eslint-disable-next-line no-console
    console.log(`[galley/sync] collaboration relay listening on ws://0.0.0.0:${handle.port}`);

    // Graceful shutdown: on SIGTERM/SIGINT drain ws connections + destroy docs via
    // the handle's close() before exiting, so k8s / `docker stop` doesn't sever
    // in-flight collab abruptly. A short safety timeout guarantees exit even if a
    // close hangs.
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, () => {
        setTimeout(() => process.exit(0), 10_000).unref();
        handle.close().finally(() => process.exit(0));
      });
    }
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[galley/sync] failed to start:", err);
    process.exit(1);
  });
