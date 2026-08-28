/**
 * Pure, offline comparison of two materialized version trees (roadmap #12.6 —
 * "compare two versions"). A version tree is the output of `materializeProject`
 * as stored by `VersionStore.getVersionTree`: a flat `VersionedFile[]` of
 * `{ path, text }`. This module is the read-only data core behind the compare UI
 * the coordinator wires to `HistoryPanel.onCompare` + a per-file diff view.
 *
 * No I/O, no React, no DOM, no deps — fully determined by its inputs (re-running
 * on identical trees yields identical output), so it can't perturb any shipped
 * path. `exactOptionalPropertyTypes` is ON: the optional text fields are attached
 * with a CONDITIONAL SPREAD, never `key: x ?? undefined`.
 */

import type { VersionedFile } from "@galley/shared";

/** Per-file classification over the union of paths in the two trees. */
export type VersionFileStatus = "added" | "removed" | "modified" | "unchanged";

/**
 * One file's comparison entry. `baseText` is present when the path exists in
 * `base` (removed/modified/unchanged); `otherText` when it exists in `other`
 * (added/modified/unchanged). Both are attached conditionally, so an entry never
 * carries a `key: undefined` slot.
 */
export interface VersionFileDiff {
  path: string;
  status: VersionFileStatus;
  baseText?: string;
  otherText?: string;
}

/** Counts per status; `added + removed + modified + unchanged === files.length`. */
export interface VersionComparisonSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
}

/** Result of comparing two version trees: sorted per-file entries + a summary. */
export interface VersionComparison {
  /** Per-file entries, sorted by `path` ascending (deterministic). */
  files: VersionFileDiff[];
  summary: VersionComparisonSummary;
}

export interface CompareOptions {
  /**
   * Include the reserved `.galley/project.json` manifest in the entries. Off by
   * default — the manifest is machine metadata (structure + path↔fileId), not
   * user content, so the user-facing diff hides it.
   */
  includeManifest?: boolean;
}

/**
 * Where the manifest can appear in a materialized tree. `materializeProject`
 * emits the relative form (`.galley/project.json`); we also accept the canonical
 * leading-slash form for defense in depth, since both are "the manifest".
 */
export const PROJECT_MANIFEST_PATHS: readonly string[] = [
  ".galley/project.json",
  "/.galley/project.json",
];

const MANIFEST_SET = new Set(PROJECT_MANIFEST_PATHS);

function isManifestPath(path: string): boolean {
  return MANIFEST_SET.has(path);
}

/** Build a `path -> text` lookup; on a duplicate path the last write wins. */
function toMap(tree: VersionedFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of tree) map.set(file.path, file.text);
  return map;
}

/**
 * Compare two materialized version trees. Pure + synchronous. Produces a
 * per-file classification over the UNION of paths, sorted by path ascending,
 * plus a summary of counts. The manifest is excluded unless `includeManifest`.
 */
export function compareVersionTrees(
  base: VersionedFile[],
  other: VersionedFile[],
  options: CompareOptions = {},
): VersionComparison {
  const includeManifest = options.includeManifest ?? false;

  const baseMap = toMap(base);
  const otherMap = toMap(other);

  const paths = new Set<string>();
  for (const path of baseMap.keys()) paths.add(path);
  for (const path of otherMap.keys()) paths.add(path);

  const files: VersionFileDiff[] = [];
  const summary: VersionComparisonSummary = { added: 0, removed: 0, modified: 0, unchanged: 0 };

  for (const path of paths) {
    if (!includeManifest && isManifestPath(path)) continue;

    const inBase = baseMap.has(path);
    const inOther = otherMap.has(path);
    const baseText = baseMap.get(path);
    const otherText = otherMap.get(path);

    let status: VersionFileStatus;
    if (inBase && !inOther) status = "removed";
    else if (!inBase && inOther) status = "added";
    else if (baseText !== otherText) status = "modified";
    else status = "unchanged";

    summary[status] += 1;

    files.push({
      path,
      status,
      ...(baseText !== undefined ? { baseText } : {}),
      ...(otherText !== undefined ? { otherText } : {}),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, summary };
}

/** One line-level operation: `del` exists only in base, `add` only in other, `ctx` in both. */
export interface LineDiffOp {
  type: "add" | "del" | "ctx";
  text: string;
}

/**
 * Minimal, pure line diff for two strings — trivializes the coordinator's
 * per-file diff rendering. Strategy: strip the common prefix and suffix of lines
 * (the common case, O(n)), then run a small LCS over the differing middle so a
 * shared line buried in the middle still shows as context. Deterministic; lines
 * are split on "\n" (a trailing newline yields a final empty line, matching
 * `String.split`).
 *
 * The result reconstructs the inputs: `ops.filter(o => o.type !== "add")` joined
 * by "\n" is `base`; `ops.filter(o => o.type !== "del")` is `other`.
 */
export function diffLines(base: string, other: string): LineDiffOp[] {
  const a = base.split("\n");
  const b = other.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: LineDiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "ctx", text: a[i] as string });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  for (const op of diffMiddle(midA, midB)) ops.push(op);

  for (let i = endA; i < a.length; i++) ops.push({ type: "ctx", text: a[i] as string });

  return ops;
}

/** LCS-based diff of two line blocks with no shared prefix/suffix. */
function diffMiddle(a: string[], b: string[]): LineDiffOp[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((text) => ({ type: "add", text }));
  if (b.length === 0) return a.map((text) => ({ type: "del", text }));

  // Classic LCS length table.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  // Backtrack into ordered ops: dels before adds within a divergent run.
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "ctx", text: a[i] as string });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i] as string });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] as string });
  while (j < m) ops.push({ type: "add", text: b[j++] as string });
  return ops;
}
