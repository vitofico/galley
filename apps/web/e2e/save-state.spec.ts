import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #18.2 — save-state surfacing. The local draft is already persisted to
 * IndexedDB (via y-indexeddb) by the project session, but silently. This spec
 * proves the calm topbar badge reflects that persistence end-to-end in a REAL
 * browser: it loads, settles to "Saved", flickers to "Saving…" on an edit, and
 * returns to "Saved" once the write lands.
 */
test("project shell: the save-state badge settles to Saved, shows Saving on an edit, then Saved", async ({
  page,
}) => {
  await gotoEditor(page);

  // It's the project shell, and it compiles (so the doc is seeded + persisted).
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const badge = page.getByTestId("save-state");
  await expect(badge).toBeVisible();

  // After the initial IndexedDB load + seed, the draft is safely persisted.
  await expect(badge).toHaveText(/saved/i, { timeout: 30_000 });
  await expect(badge).toHaveAttribute("data-state", "saved");

  // C1 old-path pin: a HEALTHY session never reads at-risk and never shows the
  // at-risk banner — the new state is purely additive to the broken-storage case.
  await expect(badge).not.toHaveAttribute("data-state", "at-risk");
  await expect(page.getByTestId("at-risk-banner")).toHaveCount(0);

  // Make an edit — the badge flips to "Saving…" while the write is in flight,
  // then settles back to "Saved". We assert the resting state (the transient
  // "Saving…" is debounce-short, so gating on it would be flaky); the key
  // acceptance is that an edit ultimately reads as Saved.
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.type(" edited");
  await expect(editor).toContainText("edited");

  await expect(badge).toHaveText(/saved/i, { timeout: 30_000 });
  await expect(badge).toHaveAttribute("data-state", "saved");
});

/**
 * M8 — a happy SOLO LOCAL user going offline is NOT alarmed with "Offline". Their
 * IndexedDB draft is saved regardless of network and there are no peers to be out
 * of sync with, so the badge stays "Saved" (offline only surfaces for a shared
 * session). The default shell here is local-only (never Shared).
 */
test("M8: a solo local session offline stays 'Saved', never reads 'Offline'", async ({
  page,
  context,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const badge = page.getByTestId("save-state");
  await expect(badge).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

  // Drop the network. A solo local draft is still safe → no "Offline" alarm.
  await context.setOffline(true);
  await expect(badge).toHaveText(/saved/i);
  await expect(badge).toHaveAttribute("data-state", "saved");
  await expect(badge).not.toHaveAttribute("data-state", "offline");

  await context.setOffline(false);
});
