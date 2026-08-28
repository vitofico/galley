/**
 * The LOCAL in-app auto-apply audit (ADR-0025 §4) — a per-project record of every
 * run the IN-APP agent auto-applied (or tried to). It mirrors the shape of the
 * MCP tombstone audit entry (`auto-accept-audit.ts`) so the two surfaces read the
 * same way, BUT it is a DIFFERENT, simpler store:
 *
 *   - It is the IN-APP audit, NOT the MCP grant audit. The MCP audit is a
 *     replay-prevention TOMBSTONE keyed by a signed `(id, digest)` and per-grant;
 *     this one is a plain provenance/Undo trail for the user's OWN browser-
 *     generated edits (no relay, no foreign writer, no signature to replay), so
 *     it has no fail-safe/corrupt-blocking semantics — a same-origin user can
 *     overwrite their own localStorage anyway, and there is nothing to replay.
 *   - It is keyed per PROJECT (`galley.agentAccess.inAppAudit.<projectId>`), not
 *     per grant.
 *   - It is a bounded ring (newest-first, capped at {@link IN_APP_AUDIT_CAP}):
 *     unlike the tombstone audit it MAY drop the oldest entry, because dropping a
 *     provenance line is not a replay hole — it only loses an old Undo affordance.
 *
 * Pure read-modify-write over an injected {@link InAppAuditStorage} (a subset of
 * `Storage`), so the unit gate drives it offline with a fake map.
 */

/** One audited in-app auto-applied run. Mirrors the MCP `AuditEntry` shape. */
export interface InAppAuditEntry {
  /** The agent run's id (the grouping/correlation hint from the run events). */
  runId: string;
  /** The originating user request (for the audit/Undo summary). */
  request: string;
  /** How many files the run's apply touched (in-app is single-file today → 1). */
  fileCount: number;
  /** Unix-ms timestamp the entry was recorded. */
  at: number;
  /** The terminal outcome of the auto-apply attempt. */
  state: "applied" | "failed";
  /**
   * The version id of the pre-apply checkpoint — the Undo target. Present on an
   * `applied` entry; absent on a `failed` one whose checkpoint did not stick.
   */
  checkpointVersionId?: string;
}

/** The minimal storage surface this module needs (a subset of `Storage`). */
export interface InAppAuditStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The persisted storage-key prefix; one blob per project id. */
export const IN_APP_AUDIT_KEY_PREFIX = "galley.agentAccess.inAppAudit.";

/**
 * Cap on retained in-app audit entries per project. A bounded ring — when full,
 * the OLDEST entry is dropped (unlike the MCP tombstone audit, dropping a
 * provenance/Undo line here is not a replay hole). Mirrors the MCP audit's DoS
 * posture (a bounded blob) without its never-prune replay constraint.
 */
export const IN_APP_AUDIT_CAP = 200;

/** The persisted storage key for one project's in-app audit blob. */
export function inAppAuditStorageKey(projectId: string): string {
  return `${IN_APP_AUDIT_KEY_PREFIX}${projectId}`;
}

function defaultStorage(): InAppAuditStorage | null {
  const s = (globalThis as { localStorage?: InAppAuditStorage }).localStorage;
  return s ?? null;
}

/** Validate + coerce one persisted entry; returns null for anything ill-typed. */
function coerceEntry(value: unknown): InAppAuditEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["runId"] !== "string") return null;
  if (v["state"] !== "applied" && v["state"] !== "failed") return null;
  const entry: InAppAuditEntry = {
    runId: v["runId"],
    request: typeof v["request"] === "string" ? v["request"] : "",
    fileCount:
      typeof v["fileCount"] === "number" && Number.isFinite(v["fileCount"]) ? v["fileCount"] : 0,
    at: typeof v["at"] === "number" && Number.isFinite(v["at"]) ? v["at"] : 0,
    state: v["state"],
  };
  if (typeof v["checkpointVersionId"] === "string") {
    entry.checkpointVersionId = v["checkpointVersionId"];
  }
  return entry;
}

/**
 * Read the project's in-app audit entries (internal order: oldest-first). Any
 * read/parse failure → empty (best-effort; this is a provenance trail, not a
 * replay gate, so a corrupt blob simply reads as no history).
 */
function readRaw(storage: InAppAuditStorage, projectId: string): InAppAuditEntry[] {
  let raw: string | null;
  try {
    raw = storage.getItem(inAppAuditStorageKey(projectId));
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: InAppAuditEntry[] = [];
  for (const item of parsed) {
    const e = coerceEntry(item);
    if (e !== null) out.push(e);
  }
  return out;
}

/**
 * Append an in-app audit entry for a project. Read-modify-write of the whole
 * blob; the new entry becomes the newest. When the ring is full the OLDEST entry
 * is dropped. Best-effort: a missing storage or a write failure is swallowed.
 */
export function appendInAppAudit(
  projectId: string,
  entry: InAppAuditEntry,
  storage?: InAppAuditStorage | null,
): void {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return;
  const entries = readRaw(s, projectId);
  entries.push(entry); // newest-last internally
  // Bounded ring: keep the newest IN_APP_AUDIT_CAP, dropping the oldest overflow.
  const bounded =
    entries.length > IN_APP_AUDIT_CAP ? entries.slice(entries.length - IN_APP_AUDIT_CAP) : entries;
  try {
    s.setItem(inAppAuditStorageKey(projectId), JSON.stringify(bounded));
  } catch {
    /* persistence is best-effort */
  }
}

/** Every in-app audit entry for a project, NEWEST-FIRST. */
export function readInAppAudit(
  projectId: string,
  storage?: InAppAuditStorage | null,
): InAppAuditEntry[] {
  const s = storage === undefined ? defaultStorage() : storage;
  if (!s) return [];
  return readRaw(s, projectId).slice().reverse();
}
