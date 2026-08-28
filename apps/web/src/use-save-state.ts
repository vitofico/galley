/**
 * `useSaveState` — surfaces the (otherwise SILENT) local-draft persistence as a
 * tiny, calm status: `"saving" | "saved" | "offline"` (#18.2).
 *
 * Galley already persists the live CRDT doc to IndexedDB via `y-indexeddb`
 * (the {@link DraftStore} seam in `collab-session.ts` / `project-session.ts`),
 * but the user gets NO signal that their work is safe. This hook reads that
 * existing seam and a couple of ambient facts — it adds NO new persistence
 * behavior, only a read-only status:
 *
 *   - `whenSynced`  — the `IndexeddbPersistence` `synced` promise: resolves once
 *     the stored draft has been loaded into the doc (and so the doc is now being
 *     persisted). Before it resolves we honestly say "saving".
 *   - the doc's `update` events — every edit triggers an async IDB write; we flip
 *     to "saving" on an update and settle back to "saved" after a short debounce.
 *   - `navigator.onLine` + the `online`/`offline` events — when the browser has
 *     no network we surface "offline" (the most salient state).
 *
 * The pure inputs→state decision ({@link computeSaveState}) is unit-tested with
 * no DOM (apps/web vitest runs under Node); the React hook is a thin,
 * dependency-injected wrapper over it, exercised by the e2e spec + typecheck.
 *
 * SSR / Node SAFETY: `navigator`/`window` are never touched at module-eval or
 * initial render; every access is inside `useEffect` and guarded by
 * `typeof … !== "undefined"`. The hook is inert (returns "saved") when given no
 * persistence target, so the non-persisted single-file path is unaffected.
 */
import { useEffect, useState } from "react";

/**
 * The calm save status surfaced in the topbar badge. `at-risk` (C1) is the
 * honest state when local persistence is broken — the doc lives in memory only,
 * so closing the tab loses everything.
 */
export type SaveState = "saving" | "saved" | "offline" | "at-risk";

/** The ambient facts the status is derived from. */
export interface SaveStateInputs {
  /** `navigator.onLine` — false when the browser reports no network. */
  online: boolean;
  /** Has the IndexedDB draft finished its initial load (`synced` event)? */
  synced: boolean;
  /** Is an IndexedDB write in flight (an edit landed within the debounce)? */
  writing: boolean;
  /**
   * Did the local draft store FAIL to initialize (e.g. IndexedDB blocked)? The
   * session degrades to an in-memory doc so the editor isn't blank — but then the
   * work is not persisted, so we must NOT keep claiming "Saved". Optional; absent
   * ⇒ healthy. C1.
   */
  persistenceFailed?: boolean;
  /**
   * Is this session live-shared with peers (a collab connection is open)? M8:
   * `offline` only matters when there ARE peers to be out of sync with — a solo
   * local user's IndexedDB draft is saved regardless of network, so "Offline"
   * would needlessly alarm them. Optional; absent/false ⇒ solo (offline benign).
   */
  shared?: boolean;
}

/**
 * PURE: map the ambient facts to a single calm status.
 *
 * Priority: `at-risk` wins outright (C1) — if persistence is broken the work is
 * in-memory only and the tab-close loses it, the most severe + actionable state;
 * "Saving…"/"Saved"/"Offline" would all be lies. Then `offline`, but ONLY for a
 * SHARED session (M8) — it tells the user why their edits aren't reaching peers;
 * for a solo local user the local draft is safe regardless of network, so we
 * don't alarm them. Then a not-yet-loaded draft or an in-flight write reads as
 * `saving`. Otherwise the work is safely persisted: `saved`.
 */
export function computeSaveState(inputs: SaveStateInputs): SaveState {
  if (inputs.persistenceFailed) return "at-risk";
  if (!inputs.online && inputs.shared) return "offline";
  if (!inputs.synced || inputs.writing) return "saving";
  return "saved";
}

/**
 * The persistence target the hook observes. Mirrors the existing `DraftStore`
 * seam plus the doc whose `update`s mark a pending write. Injectable end-to-end
 * so the (Node) unit gate and the e2e harness can drive it without a real
 * IndexedDB or `window`.
 */
export interface SaveStateTarget {
  /**
   * Resolves once the stored draft has loaded (the `y-indexeddb` `synced`
   * event). `DraftStore.whenSynced` is exactly this. When omitted the draft is
   * treated as already-synced (e.g. a connected session with no local store).
   */
  whenSynced?: Promise<unknown>;
  /**
   * Subscribe to "the doc changed" (a write is now in flight). Returns an
   * unsubscribe. `(doc.on('update', cb)) => () => doc.off('update', cb)` for a
   * `Y.Doc`. Optional: with no doc the status never enters the write-debounce.
   */
  onChange?: (cb: () => void) => () => void;
  /**
   * The raw local-persistence load promise — REJECTS if the draft store failed to
   * initialize (the session swallows this for seeding via its own `whenReady`, so
   * we observe the failure here instead). A rejection flips the status to
   * `at-risk`; resolve/absent leaves it healthy. Distinct from `whenSynced` (which
   * only gates `synced`) so the existing timing is byte-for-byte unchanged. C1.
   */
  whenPersisted?: Promise<unknown>;
}

export interface UseSaveStateOptions {
  /** How long (ms) after an edit to keep showing "Saving…" before "Saved". */
  debounceMs?: number;
  /**
   * M8: whether this session is live-shared (a collab connection is open). When
   * false/absent the session is solo-local and `offline` is suppressed in favor
   * of the honest "Saved" — a solo user's draft is safe regardless of network.
   */
  shared?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 600;

/** Read `navigator.onLine`, defaulting to online when there is no navigator. */
function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/**
 * Track the local-draft save status. Pass `null`/`undefined` when there is no
 * local persistence target (the default single-file path) and the hook stays
 * inert at "saved" — it never claims to be saving work it isn't persisting.
 */
export function useSaveState(
  target: SaveStateTarget | null | undefined,
  options: UseSaveStateOptions = {},
): SaveState {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // No persistence target → nothing to surface; report the safe resting state.
  const [synced, setSynced] = useState<boolean>(() => target?.whenSynced === undefined);
  const [writing, setWriting] = useState(false);
  const [online, setOnline] = useState<boolean>(true);
  const [persistenceFailed, setPersistenceFailed] = useState(false);

  // Resolve the initial-load gate off the injected promise. Always settle synced
  // (even if it rejects) so a persistence failure degrades to "saved" rather than
  // pinning "Saving…" forever — matching the session's degrade-to-in-memory stance.
  useEffect(() => {
    const p = target?.whenSynced;
    if (p === undefined) {
      setSynced(true);
      return;
    }
    let cancelled = false;
    setSynced(false);
    void Promise.resolve(p)
      .then(() => {
        if (!cancelled) setSynced(true);
      })
      .catch(() => {
        if (!cancelled) setSynced(true);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  // C1: observe the raw persistence load. A rejection means the local draft store
  // never initialized (IndexedDB blocked/unavailable) — the doc is in-memory only,
  // so we surface "at-risk" instead of a false "Saved". Resolve/absent ⇒ healthy.
  // Reset on a target swap so a fresh, healthy session never inherits the flag.
  useEffect(() => {
    const p = target?.whenPersisted;
    setPersistenceFailed(false);
    if (p === undefined) return;
    let cancelled = false;
    void Promise.resolve(p)
      .then(() => {
        // resolved: persistence is healthy — leave the flag false.
      })
      .catch(() => {
        if (!cancelled) setPersistenceFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Flip to "saving" on each doc change, then settle to "saved" after the
  // debounce (the IDB write completes well within it). Subsequent edits reset the
  // timer, so a burst of keystrokes reads as one continuous "Saving…".
  useEffect(() => {
    const subscribe = target?.onChange;
    if (subscribe === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(() => {
      setWriting(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setWriting(false), debounceMs);
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, [target, debounceMs]);

  // Track online/offline. Guarded for SSR/Node; re-syncs immediately in case the
  // value changed between initial render and the effect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOnline(readOnline());
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return computeSaveState({ online, synced, writing, persistenceFailed, shared: options.shared ?? false });
}

/** The calm label shown in the badge for each state. */
export function saveStateLabel(state: SaveState): string {
  switch (state) {
    case "saving":
      return "Saving…";
    case "offline":
      return "Offline";
    case "saved":
      return "Saved";
    case "at-risk":
      return "Not saved";
  }
}
