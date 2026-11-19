import { openFilesDock } from "./files-dock.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { CollabProject, restoreDoc } from "@galley/collab";
import { FsCrdtStore } from "@galley/persistence";
import type { CapabilityRoomRecord } from "@galley/shared";
import { skipDemoSeed, suppressCoachOverlay } from "./app-helpers.js";

/**
 * Server copies by default (ADR-0035), through the real doors: the real
 * web-server with OIDC sign-in (:4179, against the provider stub on :4180) and
 * the real auth-required relay (:1235) persisting to a scratch volume. Nothing
 * under `/auth` is mocked. Each test asserts what is left on that volume: the
 * room registry the web server writes and the document the relay stores.
 *
 * The anonymous test runs on the default stack (:4173), which has no sign-in.
 */

const WEB = "http://localhost:4179";
const COPY_DIR = process.env.GALLEY_E2E_COPY_DIR ?? "";
const DATA_DIR = join(COPY_DIR, "data");
const CRDT_DIR = join(COPY_DIR, "crdt");

/** Every room the web server registered, live or revoked. */
async function registeredRooms(): Promise<CapabilityRoomRecord[]> {
  const dir = join(DATA_DIR, "capability-rooms");
  const names = await readdir(dir).catch(() => [] as string[]);
  const rows = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8"))),
  );
  return rows as CapabilityRoomRecord[];
}

const liveRoomsOf = async (projectId: string) =>
  (await registeredRooms()).filter(
    (r) => r.projectId === projectId && r.revokedAtMs === undefined,
  );

/** The text the relay holds on disk for a room ("" when it holds nothing). */
async function storedText(roomId: string): Promise<string> {
  const updates = await new FsCrdtStore(CRDT_DIR).loadUpdates(roomId);
  const project = new CollabProject(restoreDoc(updates));
  return project
    .snapshot()
    .files.map((f) => f.text)
    .join("\n");
}

/** The text the relay holds across EVERY room it stored anything for. */
async function everythingStored(): Promise<string> {
  const rooms = (await registeredRooms()).map((r) => r.roomId);
  return (
    await Promise.all(rooms.map((r) => storedText(r).catch(() => "")))
  ).join("\n");
}

/** A fresh browser profile, signed in through the provider stub. */
async function signedIn(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: WEB });
  const page = await context.newPage();
  await skipDemoSeed(page);
  await suppressCoachOverlay(page);
  await page.goto("/");
  await page.getByTestId("auth-signin-button").click();
  await expect(page.getByTestId("library-controls")).toBeVisible();
  return { context, page };
}

/** Create a blank project from the library; returns its id. Does not open it. */
async function createProject(page: Page, name: string): Promise<string> {
  await page.getByTestId("new-project-tile").click();
  await page.getByTestId("new-project-name").fill(name);
  await page.getByTestId("create-project").click();
  const card = page.getByTestId("project-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  return (await card.getAttribute("data-project-id"))!;
}

const card = (page: Page, projectId: string) =>
  page.locator(`[data-testid="project-card"][data-project-id="${projectId}"]`);

async function openAndType(page: Page, projectId: string, text: string) {
  await card(page, projectId).getByTestId("open-project").click();
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`\n${text}`);
  await expect(editor).toContainText(text);
}

test("a signed-in person's project survives a wiped browser", async ({
  browser,
}) => {
  const marker = `survives-${Date.now()}`;
  const first = await signedIn(browser);
  const projectId = await createProject(first.page, "Thesis");
  await openAndType(first.page, projectId, marker);
  await expect(first.page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "server",
  );

  // Stored outcome: one live `copy` room for the project, and the relay's
  // volume holds the typed text for that room.
  const [room] = await liveRoomsOf(projectId);
  expect(room?.kind).toBe("copy");
  await expect.poll(() => storedText(room!.roomId)).toContain(marker);

  await openFilesDock(first.page);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const hash = createHash("sha256").update(bytes).digest("hex");
  await first.page.getByTestId("upload-binary-input").setInputFiles({
    name: "figure.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect
    .poll(async () =>
      (
        await readFile(
          join(CRDT_DIR, "assets", room!.roomId, hash + ".bin"),
        ).catch(() => Buffer.alloc(0))
      ).toString("hex"),
    )
    .toBe(bytes.toString("hex"));

  // The browser's data is gone: a new profile has no IndexedDB, no
  // localStorage and no cookie. Only the account is the same.
  await first.context.close();
  const second = await signedIn(browser);
  await expect(second.page.getByTestId("project-card")).toHaveCount(0);
  const kept = second.page.locator(
    `[data-testid="connected-project-card"][data-project-id="${projectId}"]`,
  );
  await expect(kept).toContainText("Thesis");
  await kept.getByTestId("open-connected-project").click();

  // It is a project of this browser again, at its own address, with the text.
  await expect(second.page).toHaveURL(new RegExp(`/p/${projectId}$`));
  await expect(
    second.page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText(marker);
  const restoredBytes = await second.page.evaluate(
    async ({ projectId, hash }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("galley.blobs." + projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number[]>((resolve, reject) => {
          const request = db
            .transaction("blobs")
            .objectStore("blobs")
            .get(hash);
          request.onsuccess = () =>
            resolve(Array.from(request.result?.bytes ?? []));
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },
    { projectId, hash },
  );
  expect(restoredBytes).toEqual([...bytes]);
  await second.page.goto("/");
  await expect(card(second.page, projectId)).toContainText("Thesis");
  await second.context.close();
});

test("a project kept only in this browser is never written to the server", async ({
  browser,
}) => {
  const marker = `local-only-${Date.now()}`;
  const witness = `witness-${Date.now()}`;
  const { context, page } = await signedIn(browser);
  const optedOut = await createProject(page, "Private notes");
  const kept = await createProject(page, "Witness");

  await card(page, optedOut).getByTestId("project-menu").click();
  await page.getByTestId("toggle-server-copy").click();
  await expect(
    card(page, optedOut).getByTestId("server-copy-state"),
  ).toHaveAttribute("data-state", "local");

  await openAndType(page, optedOut, marker);
  await expect(page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "local",
  );

  // Positive control on the same servers: a project that was NOT opted out
  // reaches the volume, so the silence below is not a dead relay.
  await page.goto("/");
  await openAndType(page, kept, witness);
  const [room] = await liveRoomsOf(kept);
  await expect.poll(() => storedText(room!.roomId)).toContain(witness);

  expect(
    (await registeredRooms()).filter((r) => r.projectId === optedOut),
  ).toEqual([
    expect.objectContaining({
      copyDisabled: true,
      revokedAtMs: expect.any(Number),
    }),
  ]);
  const second = await signedIn(browser);
  const blocked = await second.page.evaluate(async (id) => {
    const rooms = await (await fetch("/auth/project-replicas")).json();
    const response = await fetch("/auth/capability-rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: id,
        kind: "copy",
        roomId: "share-" + crypto.randomUUID(),
      }),
    });
    return { localOnly: rooms.localOnly.includes(id), status: response.status };
  }, optedOut);
  expect(blocked).toEqual({ localOnly: true, status: 403 });
  await second.context.close();
  expect(await everythingStored()).not.toContain(marker);
  await context.close();
});

test("a project that was never opened since is uploaded from the library", async ({
  browser,
}) => {
  const marker = `backlog-${Date.now()}`;
  const first = await signedIn(browser);
  const projectId = await createProject(first.page, "Old paper");

  // A project from before the server kept copies: it has text in this browser
  // and nothing on the server. The server refuses to list or register copies
  // while it is written.
  const offline = (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 503, json: { ok: false } });
  await first.context.route("**/auth/project-replicas", offline);
  await first.context.route("**/auth/capability-rooms", offline);
  await openAndType(first.page, projectId, marker);
  await expect(first.page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "local",
  );
  expect(await liveRoomsOf(projectId)).toEqual([]);
  await first.context.unroute("**/auth/project-replicas");
  await first.context.unroute("**/auth/capability-rooms");

  // Visiting the library is enough: the project is not opened again.
  await first.page.goto("/");
  await expect(
    card(first.page, projectId).getByTestId("server-copy-state"),
  ).toHaveAttribute("data-state", "server");
  const [room] = await liveRoomsOf(projectId);
  expect(room?.kind).toBe("copy");
  expect(await storedText(room!.roomId)).toContain(marker);
  await first.context.close();
});

test("a changed profile can recover a surviving project locally", async ({
  browser,
}) => {
  const { context, page } = await signedIn(browser);
  const id = await createProject(page, "Earlier profile");
  await context.route("**/auth/project-replicas", (route) =>
    route.fulfill({ status: 503 }),
  );
  const marker = "surviving-local-document";
  await openAndType(page, id, marker);
  await expect(page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "local",
  );
  await page.evaluate(() => localStorage.removeItem("galley.localProfile"));
  await context.unroute("**/auth/project-replicas");
  await page.goto("/");
  await expect(card(page, id)).toHaveCount(0);
  await page
    .getByText("Recover projects from this browser", { exact: true })
    .click();
  await page.getByRole("button", { name: "Recover Earlier profile" }).click();
  await card(page, id).getByTestId("open-project").click();
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText(marker);
  await expect(page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "local",
  );
  expect(await liveRoomsOf(id)).toEqual([]);
  await context.close();
});

test("without an account nothing reaches a server", async ({ page }) => {
  const sockets: string[] = [];
  const authCalls: string[] = [];
  page.on("websocket", (ws) => sockets.push(ws.url()));
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/auth/"))
      authCalls.push(req.url());
  });
  const before = (await registeredRooms()).length;
  const marker = `anonymous-${Date.now()}`;

  await skipDemoSeed(page);
  await suppressCoachOverlay(page);
  await page.goto("/");
  await expect(page.getByTestId("library-local-only")).toBeVisible();
  const projectId = await createProject(page, "Anonymous draft");
  await expect(
    card(page, projectId).getByTestId("server-copy-state"),
  ).toHaveCount(0);
  await openAndType(page, projectId, marker);
  await expect(page.getByTestId("server-copy-status")).toHaveAttribute(
    "data-state",
    "local",
  );
  // Back through the library, where a signed-in browser would upload.
  await page.goto("/");
  await expect(card(page, projectId)).toBeVisible();
  await page.waitForTimeout(1000);

  expect(sockets).toEqual([]);
  expect(authCalls).toEqual([]);
  expect((await registeredRooms()).length).toBe(before);
  expect(await everythingStored()).not.toContain(marker);
});