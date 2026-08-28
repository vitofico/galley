/**
 * Canonical home for the transport-agnostic git-sync OUTCOME types.
 *
 * These were originally declared inside `components/GitSyncPanel.tsx`, which left
 * the host-side ops layer (`git-sync-ops.ts`) importing its result shapes from a
 * UI component — an inverted dependency (ops → UI). The unified-git-sync redesign
 * (2026-06-18) lifts them here so both the ops layer and the panel reference one
 * shared, presentation-free home; the panel re-exports them for back-compat.
 *
 * Both shapes are deliberately transport-agnostic: the generic smart-HTTP path
 * and the GitHub REST snapshot path return the SAME outcome types, so the panel
 * and the Accept gate never branch on transport. `error` is ALWAYS already
 * redacted by the producer (the persistence core / the REST client + ops wrapper).
 */

/** Outcome of a push, surfaced as a status line. `error` is already redacted. */
export interface GitSyncPushOutcome {
  ok: boolean;
  /** The projection commit OID on success. */
  oid?: string;
  /** A redacted, human-readable error on failure. */
  error?: string;
}

/** Outcome of a fetch. On success the host has opened the Accept-gated review. */
export interface GitSyncFetchOutcome {
  ok: boolean;
  /** True if the remote ref existed and a candidate was offered for review. */
  hasCandidate?: boolean;
  /** A redacted, human-readable error on failure. */
  error?: string;
}
