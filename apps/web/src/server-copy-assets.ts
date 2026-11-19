import {
  BlobTransport,
  type BinaryFileSnapshot,
  type CollabProject,
  type WebSocketLike,
} from "@galley/collab";
import {
  hostedStorageEnabled,
  HOSTED_BLOB_SUBPROTOCOL,
} from "./blob-session.js";
import {
  blobDbName,
  IndexeddbBlobBackend,
  PersistentBlobStore,
} from "./idb-blob-store.js";

/** Transfer a single referenced asset through the hosted, quota-enforced channel.
 * Received bytes stay ungranted for peer sharing. Only locally granted bytes
 * may be pushed based on a pointer in a collaboratively editable document. */
async function transferAsset(
  url: string,
  file: BinaryFileSnapshot,
  store: PersistentBlobStore,
  restore: boolean,
  signal: AbortSignal,
) {
  const bytes = await store.get(file.hash);
  if (restore && bytes?.length === file.size) return;
  const upload =
    !restore &&
    bytes?.length === file.size &&
    (await store.isServable(file.hash));
  signal.throwIfAborted();
  let received!: () => void;
  const stored = new Promise<void>((resolve) => {
    received = resolve;
  });
  const transport = new BlobTransport(
    () =>
      new WebSocket(url, HOSTED_BLOB_SUBPROTOCOL) as unknown as WebSocketLike,
    {
      reconnect: false,
      requestRetryMs: 500,
      onBlob: async (blob) => {
        await store.put(blob.bytes, { mime: file.mime });
        received();
      },
    },
  );
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error("Server copy asset transfer interrupted"));
  });
  const timer = setTimeout(cancel, 30_000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    transport.connect();
    if (!upload && !transport.request(file.hash, file.size))
      throw new Error("Invalid server copy asset");
    await Promise.race([
      cancelled,
      upload ? transport.send(bytes!, file.hash, file.mime).done : stored,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    transport.disconnect();
  }
}

export async function syncCopyAssets(
  project: CollabProject,
  projectId: string,
  syncUrl: string,
  roomId: string,
  restore = false,
  signal = new AbortController().signal,
  completed = new Set<string>(),
) {
  if (!hostedStorageEnabled()) return;
  const files = project
    .allBinaryFiles()
    .filter((f) => !f.deleted && !completed.has(f.hash));
  if (!files.length) return;
  const backend = new IndexeddbBlobBackend(blobDbName(projectId));
  const store = new PersistentBlobStore(backend);
  const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(roomId)}`;
  let incomplete = false;
  try {
    for (const file of files) {
      if (completed.has(file.hash)) continue;
      signal.throwIfAborted();
      try {
        await transferAsset(url, file, store, restore, signal);
        completed.add(file.hash);
      } catch {
        incomplete = true;
      }
    }
  } finally {
    await backend.close();
  }
  if (incomplete) throw new Error("Some referenced assets could not be copied");
}

/** A single sequential pass owns the transport; edits during it schedule the next pass. */
export function watchCopyAssets(
  project: CollabProject,
  projectId: string,
  syncUrl: string,
  roomId: string,
  status: (state: "server" | "assets") => void,
) {
  const controller = new AbortController();
  const completed = new Set<string>();
  let running = false;
  let pending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const update = async () => {
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending && !controller.signal.aborted) {
        pending = false;
        if (
          hostedStorageEnabled() &&
          project
            .allBinaryFiles()
            .some((f) => !f.deleted && !completed.has(f.hash))
        )
          status("assets");
        await syncCopyAssets(
          project,
          projectId,
          syncUrl,
          roomId,
          false,
          controller.signal,
          completed,
        );
      }
      if (!controller.signal.aborted) status("server");
    } catch {
      if (!controller.signal.aborted) {
        status("assets");
        clearTimeout(retry);
        retry = setTimeout(() => void update(), 30_000);
      }
    } finally {
      running = false;
    }
  };
  const unsubscribe = project.onBinaryFilesChanged(update);
  void update();
  return () => {
    clearTimeout(retry);
    unsubscribe();
    controller.abort();
  };
}
