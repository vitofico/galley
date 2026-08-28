/**
 * Per-project FILE-CONTENT consent for Agent Access (feature #1 slice 1) — the
 * grant set behind the read-only tool mount (search_project / list_files /
 * read_file over the control mailbox).
 *
 * The metadata-only capability (pairing = list_projects/list_versions) is NOT
 * enough to read file contents: every tool request must additionally name a
 * projectId the user has EXPLICITLY granted file access to, in this browser
 * session, via Settings → Agent Access. This module is that grant set.
 *
 * SECURITY POSTURE:
 *   - PERSISTENT (operator decision): grants live in the same localStorage-backed
 *     store as the Agent Access capability, so a granted project stays readable
 *     across reload/restart alongside the resumed session. (This reverses the
 *     original session-scoped, dies-with-the-tab posture — the store is now
 *     sensitive and shared across same-origin tabs.)
 *   - BROWSER-UI-ONLY MINTING: the ONLY caller of {@link grantContentAccess}
 *     is the Agent Access settings surface (AgentAccessSettings.tsx). Nothing
 *     reachable from the control mailbox — no op, no params shape — can mint a
 *     grant: the responder mount only ever READS ({@link isContentGranted})
 *     and REVOKES ({@link revokeAllContentGrants}). A hostile/curious peer on
 *     the wire can ask, and the answer is a refusal until the human clicks.
 *   - FAIL-CLOSED ON MALFORMED STATE: any unreadable/unparsable/ill-typed
 *     stored value reads as ZERO grants — garbage can only ever mean LESS
 *     access, never more. Writes are best-effort; a failed write likewise
 *     yields fewer grants.
 *   - BOUNDED: project ids are length-capped and the grant set is count-capped
 *     (mirroring the kernel's project-entry caps), so the stored blob cannot
 *     grow without bound.
 *   - DEFAULT ZERO: there is no implicit grant anywhere. The responder mount
 *     clears the whole set on Revoke, and at construction WHEN THERE IS NO
 *     RESUMABLE SESSION (an orphan grant without a capability must not linger);
 *     when a session DOES resume, its grants are kept.
 *
 * Pure helpers over an injected sessionStorage-like store (null tolerated for
 * privacy mode / Node) — fully unit-testable offline.
 */

/** The storage key holding the JSON string[] of granted project ids. */
export const AGENT_CONTENT_GRANTS_KEY = "galley.agentAccess.contentGrants";

/** Max characters of one granted projectId (mirrors the kernel's maxProjectIdChars). */
export const MAX_GRANT_PROJECT_ID_CHARS = 256;

/** Max simultaneous grants (mirrors the kernel's maxProjectEntries — one per listable project). */
export const MAX_CONTENT_GRANTS = 200;

/** The minimal sessionStorage-like seam (structurally compatible with the mount's). */
export interface ConsentStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** A grantable project id: non-empty, bounded string. Anything else is refused. */
function isValidProjectId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_GRANT_PROJECT_ID_CHARS
  );
}

/**
 * The CURRENT grant set, deduplicated, in grant order. FAIL-CLOSED: a missing,
 * unreadable, unparsable, or ill-shaped stored value — and every ill-typed or
 * over-cap entry inside an otherwise valid array — reads as no grant.
 */
export function readContentGrants(store: ConsentStoreLike | null): string[] {
  if (store === null) return [];
  let raw: string | null;
  try {
    raw = store.getItem(AGENT_CONTENT_GRANTS_KEY);
  } catch {
    return []; // storage access can throw (privacy mode) — zero grants
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // malformed blob — zero grants, never a throw
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (!isValidProjectId(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
    if (out.length >= MAX_CONTENT_GRANTS) break;
  }
  return out;
}

/** Best-effort write of the grant set; an empty set removes the key entirely. */
function writeContentGrants(store: ConsentStoreLike, grants: string[]): void {
  try {
    if (grants.length === 0) store.removeItem(AGENT_CONTENT_GRANTS_KEY);
    else store.setItem(AGENT_CONTENT_GRANTS_KEY, JSON.stringify(grants));
  } catch {
    // Best-effort (quota / privacy mode): a failed write means the grant is
    // simply absent — fail-closed, the next isContentGranted reads false.
  }
}

/**
 * Grant file access for one project, THIS SESSION. Returns true when the grant
 * is now present. Refuses (false) an invalid id, a null store, or a full set.
 * ONLY the settings UI calls this — see the module posture above.
 */
export function grantContentAccess(store: ConsentStoreLike | null, projectId: string): boolean {
  if (store === null || !isValidProjectId(projectId)) return false;
  const grants = readContentGrants(store);
  if (grants.includes(projectId)) return true;
  if (grants.length >= MAX_CONTENT_GRANTS) return false;
  writeContentGrants(store, [...grants, projectId]);
  return readContentGrants(store).includes(projectId);
}

/** Revoke file access for one project. Idempotent; unknown ids are a no-op. */
export function revokeContentAccess(store: ConsentStoreLike | null, projectId: string): void {
  if (store === null) return;
  const grants = readContentGrants(store);
  if (!grants.includes(projectId)) return;
  writeContentGrants(
    store,
    grants.filter((id) => id !== projectId),
  );
}

/**
 * Revoke EVERY grant (the Revoke-Agent-Access path, and the responder mount's
 * constructor sweep). Idempotent, best-effort, never throws.
 */
export function revokeAllContentGrants(store: ConsentStoreLike | null): void {
  if (store === null) return;
  try {
    store.removeItem(AGENT_CONTENT_GRANTS_KEY);
  } catch {
    // best-effort — an unremovable blob still fails closed at read time only
    // if it parses to valid grants the user actually wrote; nothing to add.
  }
}

/** Is file access granted for `projectId` in this session? The mount's hard gate. */
export function isContentGranted(store: ConsentStoreLike | null, projectId: string): boolean {
  if (!isValidProjectId(projectId)) return false;
  return readContentGrants(store).includes(projectId);
}
