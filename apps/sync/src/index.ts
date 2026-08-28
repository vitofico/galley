/**
 * @galley/sync — the collaboration sync server (ADR-0008): a thin, doc-holding
 * y-websocket relay for `@galley/collab` peers. See `sync-server.ts`.
 */
export { startSyncServer, inspectAwarenessUpdate } from "./sync-server.js";
export type { SyncServerHandle, SyncServerOptions } from "./sync-server.js";
// B2 per-room storage caps (cloud enabler). `StorageQuota` is the seam the cloud
// consumer implements; the `messageStorageFull` frame constant + `encodeStorageFull`
// helper + `StorageFullReason` enum are the wire contract for the client-side
// decoder (a planned follow-up lane).
export { messageStorageFull, StorageFullReason, encodeStorageFull } from "./sync-server.js";
export type { StorageQuota } from "./sync-server.js";
// galley-blob-v1 relay (Phase 1 byte-transport): the blob channel shares this
// server's room namespace + upgrade auth; the subprotocol selects it.
export { createBlobRelay, BlobRelay, BLOB_SUBPROTOCOL } from "./blob-handler.js";
export type { BlobRelayHandle } from "./blob-handler.js";
