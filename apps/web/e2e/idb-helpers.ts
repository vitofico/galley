import type { Page } from "@playwright/test";

/**
 * The number of CRDT update records y-indexeddb has DURABLY committed to a draft/
 * project database's `updates` object store, or -1 if no matching db/store exists
 * yet (so a poll keeps waiting).
 *
 * Why this is a durable-write barrier (not just a counter): IndexedDB runs
 * transactions with overlapping store scope in creation order, and a readonly
 * read may only run after every earlier readwrite transaction on that store has
 * committed. y-indexeddb creates its append transaction synchronously inside the
 * doc 'update' handler, so once the editor shows the typed text, every keystroke's
 * write transaction already exists. A readonly `count()` created after that point
 * therefore resolves only once all those writes have committed — exactly the
 * "is it safe to reload?" signal a fixed `waitForTimeout` could only hope for.
 *
 * `dbPrefix` (not a full name) matches the dynamic per-project db
 * (`galley-local-project-v1-<projectId>`) without hardcoding the id. We resolve
 * the concrete db via `indexedDB.databases()` and only `open()` one that already
 * exists, so we never create an empty db that would shadow y-indexeddb's own
 * upgrade (which creates the `updates`/`custom` stores).
 */
export async function committedUpdateCount(page: Page, dbPrefix: string): Promise<number> {
  return page.evaluate(async (prefix) => {
    const dbs = await indexedDB.databases();
    const name = dbs.map((d) => d.name).find((n): n is string => typeof n === "string" && n.startsWith(prefix));
    if (!name) return -1;
    return await new Promise<number>((resolve) => {
      const open = indexedDB.open(name); // existing db → no version bump, no upgrade
      open.onerror = () => resolve(-1);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("updates")) {
          db.close();
          resolve(-1);
          return;
        }
        const req = db.transaction("updates", "readonly").objectStore("updates").count();
        req.onsuccess = () => {
          const n = req.result;
          db.close();
          resolve(n);
        };
        req.onerror = () => {
          db.close();
          resolve(-1);
        };
      };
    });
  }, dbPrefix);
}
