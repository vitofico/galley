/**
 * The activity trail of a connected project in Auto mode (ADR-0033 §4): one
 * entry per step of a change the hosted connector applied on the server with
 * nobody reviewing it first. The connector writes it, the web app shows it to
 * the project's owner.
 *
 * A change leaves TWO entries with the same `changeId`. `started` is written
 * before anything is applied and carries the checkpoint taken just before, so
 * a crash in the middle still leaves a trace and a way back. The second entry
 * says how it ended.
 */

/** How a change ended, or `started` while it has not. */
export type ConnectorActivityState =
  | "started"
  /** Applied and confirmed on the server copy. */
  | "applied"
  /** The text had moved; nothing was applied. */
  | "conflict"
  /** Applied here, but the server copy could not be read back to confirm it. */
  | "unconfirmed"
  /** Stopped by an error; nothing more was done. */
  | "failed";

export interface ConnectorActivityEntry {
  version: 1;
  /** Ties the entries of one change together. */
  changeId: string;
  state: ConnectorActivityState;
  atMs: number;
  /** The access token that asked for the change (its public id, never the secret). */
  tokenId: string;
  /** The client's own title for the change. */
  request: string;
  /** Paths the change touches. */
  files: string[];
  /** File operations and proposed bytes, counted against the volume cap. */
  ops: number;
  bytes: number;
  /** The whole-project checkpoint taken before the change. */
  checkpointId: string;
}

export const CONNECTOR_ACTIVITY_LIMITS = {
  /** Entries kept per project; older ones are dropped. */
  maxEntries: 1000,
  maxRequestChars: 500,
  maxFiles: 64,
  maxPathChars: 1024,
} as const;

/**
 * The whole project as it was just before a change (ADR-0033 §4), so its owner
 * can go back. Text files carry their text; a binary file is recorded by its
 * content address only, because its bytes never pass through the connector.
 */
export interface ConnectorCheckpoint {
  version: 1;
  /** The materialized tree: relative paths, plus the `.galley/` manifest. */
  files: { path: string; text: string }[];
  binaryFiles: { path: string; hash: string; size: number; mime: string }[];
}

/** `<13-digit ms>-<sha256 of the stored bytes>`: sortable, and self-checking. */
export function isConnectorCheckpointId(value: unknown): value is string {
  return typeof value === "string" && /^\d{13}-[a-f0-9]{64}$/.test(value);
}

const STATES: readonly string[] = [
  "started",
  "applied",
  "conflict",
  "unconfirmed",
  "failed",
];

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A stored line is data from disk: anything malformed is not an entry. */
export function parseConnectorActivityEntry(
  value: unknown,
): ConnectorActivityEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const files = v["files"];
  if (
    v["version"] !== 1 ||
    typeof v["changeId"] !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v["changeId"]) ||
    typeof v["state"] !== "string" ||
    !STATES.includes(v["state"]) ||
    !count(v["atMs"]) ||
    typeof v["tokenId"] !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(v["tokenId"]) ||
    typeof v["request"] !== "string" ||
    v["request"].length > CONNECTOR_ACTIVITY_LIMITS.maxRequestChars ||
    !Array.isArray(files) ||
    files.length > CONNECTOR_ACTIVITY_LIMITS.maxFiles ||
    !files.every(
      (f) =>
        typeof f === "string" &&
        f.length <= CONNECTOR_ACTIVITY_LIMITS.maxPathChars,
    ) ||
    !count(v["ops"]) ||
    !count(v["bytes"]) ||
    !isConnectorCheckpointId(v["checkpointId"])
  )
    return null;
  return {
    version: 1,
    changeId: v["changeId"],
    state: v["state"] as ConnectorActivityState,
    atMs: v["atMs"],
    tokenId: v["tokenId"],
    request: v["request"],
    files: files as string[],
    ops: v["ops"],
    bytes: v["bytes"],
    checkpointId: v["checkpointId"],
  };
}

/**
 * The changes behind a trail, newest first: each change once, in the state its
 * latest entry gives it. A `started` with nothing after it is a change that was
 * cut short; it is shown as such, with its checkpoint.
 */
export function foldConnectorActivity(
  entries: readonly ConnectorActivityEntry[],
): ConnectorActivityEntry[] {
  const byChange = new Map<string, ConnectorActivityEntry>();
  for (const entry of entries) {
    const seen = byChange.get(entry.changeId);
    if (seen === undefined || seen.state === "started")
      byChange.set(entry.changeId, entry);
  }
  return [...byChange.values()].sort((a, b) => b.atMs - a.atMs);
}
