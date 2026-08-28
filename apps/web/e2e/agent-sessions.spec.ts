import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Agent sessions (redesign/agent-mode) — the session bar lets authors maintain
 * multiple independent conversations with the agent and switch between them.
 * Each session keeps its own transcript; switching sessions swaps the visible
 * transcript without losing prior messages.
 *
 * These tests use the same Demo-model path as agent.spec.ts: the editor boots
 * with a pre-filled request, the Demo model runs offline (no network stub
 * needed), and Send produces a user turn in the transcript immediately.
 *
 * Session isolation is display-only (localStorage) and does not involve running
 * the agent through to a diff — we only need the user prompt to appear in the
 * transcript to verify isolation.
 */

test("session bar: sending a prompt records it in the transcript", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The session bar is visible and shows the default session.
  await expect(page.getByTestId("agent-session-bar")).toBeVisible();
  await expect(page.getByTestId("agent-session-title")).toBeVisible();

  // Transcript is empty before any send.
  const transcript = page.getByTestId("agent-transcript");
  await expect(transcript).toBeVisible();

  // Fill and send a prompt. The Demo agent pre-fills "Add a demo section…" — we
  // use a distinct string so we can assert it reliably.
  const request = page.getByTestId("agent-request");
  await request.fill("Session-1 unique prompt");
  await page.getByTestId("agent-send").click();

  // The user turn appears in the transcript immediately after Send.
  await expect(transcript.locator(".agent-turn-user")).toContainText("Session-1 unique prompt");

  // Stop any in-flight run so it doesn't affect later tests.
  const stop = page.getByTestId("agent-stop");
  if (await stop.isVisible()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }
});

test("session isolation: new session hides the first session's prompt", async ({ page }) => {
  await gotoEditor(page, { id: "e2e-sessions" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const transcript = page.getByTestId("agent-transcript");

  // Send a prompt in session 1.
  const request = page.getByTestId("agent-request");
  await request.fill("Session-1 isolation prompt");
  await page.getByTestId("agent-send").click();
  await expect(transcript.locator(".agent-turn-user")).toContainText("Session-1 isolation prompt");

  // Stop the run so we're in a clean state.
  const stop = page.getByTestId("agent-stop");
  if (await stop.isVisible()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }

  // Create a new session via the session bar.
  await page.getByTestId("agent-session-new").click();

  // The new session's transcript is empty — session 1's prompt is NOT shown.
  await expect(transcript.locator(".agent-turn-user")).toHaveCount(0);

  // Send a different prompt in session 2.
  await request.fill("Session-2 isolation prompt");
  await page.getByTestId("agent-send").click();
  await expect(transcript.locator(".agent-turn-user")).toContainText("Session-2 isolation prompt");

  // Stop the run.
  if (await stop.isVisible()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }
});

test("session switcher: switching back to session 1 restores its transcript", async ({ page }) => {
  await gotoEditor(page, { id: "e2e-switcher" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const transcript = page.getByTestId("agent-transcript");
  const request = page.getByTestId("agent-request");
  const stop = page.getByTestId("agent-stop");

  // Session 1: send a prompt.
  await request.fill("Switcher session-1 prompt");
  await page.getByTestId("agent-send").click();
  await expect(transcript.locator(".agent-turn-user")).toContainText("Switcher session-1 prompt");
  if (await stop.isVisible()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }

  // Create session 2.
  await page.getByTestId("agent-session-new").click();
  await expect(transcript.locator(".agent-turn-user")).toHaveCount(0);

  // Session 2: send a prompt.
  await request.fill("Switcher session-2 prompt");
  await page.getByTestId("agent-send").click();
  await expect(transcript.locator(".agent-turn-user")).toContainText("Switcher session-2 prompt");
  if (await stop.isVisible()) {
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }

  // Open the session switcher and click session 1.
  await page.getByTestId("agent-session-title").click();
  await expect(page.getByTestId("agent-session-switcher")).toBeVisible();

  // a11y: the switcher is a menu whose session rows are menuitems.
  await expect(page.getByRole("menu", { name: "Sessions" })).toBeVisible();
  expect(await page.getByRole("menuitem").count()).toBeGreaterThanOrEqual(2);

  // Sessions are listed; pick the one that isn't the active one
  // (it has data-active="false" or is the item NOT labelled "Switcher session-2 prompt").
  const items = page.getByTestId("agent-session-item");
  const count = await items.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Find and click the session-1 item (the one whose title matches or isn't the active session).
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const isActive = (await item.getAttribute("data-active")) === "true";
    if (!isActive) {
      await item.click();
      break;
    }
  }
  await expect(page.getByTestId("agent-session-switcher")).toHaveCount(0);

  // Session 1's prompt is back; session 2's is not.
  await expect(transcript.locator(".agent-turn-user")).toContainText("Switcher session-1 prompt");
  await expect(transcript.locator(".agent-turn-user")).not.toContainText(
    "Switcher session-2 prompt",
  );
});

test("deleting a session always leaves at least one session in the bar", async ({ page }) => {
  await gotoEditor(page, { id: "e2e-delete" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Start from a clean state: there is at least 1 session.
  await expect(page.getByTestId("agent-session-bar")).toBeVisible();

  // Open the switcher to access delete.
  await page.getByTestId("agent-session-title").click();
  await expect(page.getByTestId("agent-session-switcher")).toBeVisible();

  // Delete the (only or active) session.
  const deleteBtn = page.getByTestId("agent-session-delete").first();
  await deleteBtn.click();

  // The session bar must still be present and the transcript must still be usable.
  await expect(page.getByTestId("agent-session-bar")).toBeVisible();
  await expect(page.getByTestId("agent-transcript")).toBeVisible();

  // Close the switcher if still open.
  const switcher = page.getByTestId("agent-session-switcher");
  if (await switcher.isVisible()) {
    await page.getByTestId("agent-session-title").click();
    await expect(switcher).toHaveCount(0);
  }

  // Can still send a new message in the surviving session.
  await page.getByTestId("agent-request").fill("Post-delete prompt");
  await expect(page.getByTestId("agent-send")).toBeEnabled();
});
