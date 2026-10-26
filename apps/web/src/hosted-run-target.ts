/** The previously consented mailbox capability is private browser state, never a URL parameter. */
export interface HostedRunTarget {
  syncUrl: string;
  room: string;
}
const key = (projectId: string, apiPath: string) =>
  `galley.hostedMailbox.${apiPath}.${projectId}`;
export function readHostedRunTarget(
  projectId: string,
  apiPath: string,
  expectedSyncUrl: string,
  store: Pick<Storage, "getItem"> = localStorage,
): HostedRunTarget | null {
  try {
    const value: unknown = JSON.parse(
      store.getItem(key(projectId, apiPath)) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const { syncUrl, room } = value as Record<string, unknown>;
    // Stored state cannot widen relay egress; only the currently configured relay
    // can be rejoined. Changing hosts requires a fresh explicit data consent.
    return syncUrl === expectedSyncUrl &&
      typeof room === "string" &&
      /^share-[A-Za-z0-9_-]{1,128}$/.test(room)
      ? { syncUrl, room }
      : null;
  } catch {
    return null;
  }
}
export function rememberHostedRunTarget(
  projectId: string,
  apiPath: string,
  target: HostedRunTarget,
  store: Pick<Storage, "setItem"> = localStorage,
): boolean {
  try {
    store.setItem(
      key(projectId, apiPath),
      JSON.stringify({ syncUrl: target.syncUrl, room: target.room }),
    );
    return true;
  } catch {
    return false;
  }
}
export function forgetHostedRunTarget(
  projectId: string,
  apiPath: string,
  store: Pick<Storage, "removeItem"> = localStorage,
): void {
  try {
    store.removeItem(key(projectId, apiPath));
  } catch {
    /* fail closed on unreadable state */
  }
}
