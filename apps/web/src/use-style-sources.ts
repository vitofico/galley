/**
 * `useStyleSources` — a thin React shell over the pure {@link collectFromSources}
 * engine (all logic + tests live in `style-source.ts`; this file has no
 * behaviour worth unit-testing beyond its React lifecycle, which the mounting
 * lane's e2e covers).
 *
 * Lists every registered {@link StyleSource} once on mount and returns the
 * materialised remote styles, a loading flag, and any per-source errors, for a
 * host to APPEND to the style picker's catalog. Drop-in: a host calls the hook
 * and spreads `remoteStyles` after the built-ins/local styles — nothing else.
 *
 * Guarantees (see the engine for the full contract):
 * - ZERO registered sources ⇒ no async work is started; returns immediately-empty
 *   so the picker renders byte-for-byte as today and built-ins are never awaited.
 * - Remote styles only ever APPEND — the host orders built-ins/local FIRST, so a
 *   slow source can never delay or reorder them.
 * - Lifecycle-safe: a `list()` that settles after unmount, or after a newer
 *   `refresh()` superseded it, never sets state; a rejection settles to a stable
 *   error (never perpetual `loading`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Style } from "./style-manifest.js";
import { collectFromSources, listStyleSources, type RemoteStyleError } from "./style-source.js";

export interface UseStyleSourcesResult {
  remoteStyles: Style[];
  loading: boolean;
  errors: RemoteStyleError[];
  /** Re-list all registered sources (e.g. after a source is registered late). */
  refresh: () => void;
}

interface State {
  remoteStyles: Style[];
  loading: boolean;
  errors: RemoteStyleError[];
}

const EMPTY: State = { remoteStyles: [], loading: false, errors: [] };

export function useStyleSources(): UseStyleSourcesResult {
  const [state, setState] = useState<State>(EMPTY);
  // Monotonic id of the in-flight listing; a settle whose id is stale is ignored.
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);

  const run = useCallback(() => {
    const sources = listStyleSources();
    if (sources.length === 0) {
      // Byte-for-byte guarantee: with no sources, start no async work at all.
      runIdRef.current += 1; // supersede any in-flight listing
      setState(EMPTY);
      return;
    }
    const runId = ++runIdRef.current;
    setState((s) => ({ ...s, loading: true }));
    void collectFromSources(sources).then((result) => {
      // Drop a completion that lost the race (unmounted, or a newer run started).
      if (!mountedRef.current || runId !== runIdRef.current) return;
      setState({ ...result, loading: false });
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    run();
    return () => {
      mountedRef.current = false;
    };
  }, [run]);

  return { ...state, refresh: run };
}
