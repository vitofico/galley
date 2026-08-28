import { test, expect } from "@playwright/test";
import { gotoEditor, suppressCoachOverlay } from "./app-helpers.js";

/**
 * Onboarding M1–M4 — a calm, one-time first-run layer over the editor.
 *
 * M3 (the coach overlay) is the load-bearing gate: it renders ONLY on a
 * genuinely fresh local profile, so the whole existing suite (which boots the
 * editor through `gotoEditor`, now seeding the dismissed flag) never sees it.
 * These tests boot the editor with a RAW goto to exercise the fresh path, and
 * pin the returning-profile / suppressed cases so the byte-for-byte "existing UI
 * is unchanged" invariant is explicit.
 */

const COACH_KEY = "galley.onboarding.coachOverlay.v1";

test("M3: a fresh local boot shows the one-time coach overlay; the button dismisses it permanently", async ({
  page,
}) => {
  // RAW goto (not gotoEditor) so the fresh-profile coach is NOT suppressed.
  await page.goto("/p/onb-fresh-btn");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const coach = page.getByTestId("coach-overlay");
  await expect(coach).toBeVisible();
  // It orients the three panes by name.
  await expect(coach).toContainText(/editor/i);
  await expect(coach).toContainText(/live preview/i);
  await expect(coach).toContainText(/agent/i);

  // "Got it" dismisses and records the one-time flag.
  await page.getByTestId("coach-dismiss").click();
  await expect(coach).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), COACH_KEY))
    .not.toBeNull();

  // A reload does NOT bring it back — one-time.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("coach-overlay")).toHaveCount(0);
});

test("M3: Escape dismisses the coach overlay", async ({ page }) => {
  await page.goto("/p/onb-fresh-esc");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.getByTestId("coach-overlay")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("coach-overlay")).toHaveCount(0);
});

test("M3: a returning profile (flag pre-seeded) never sees the coach — the existing suite's normal state", async ({
  page,
}) => {
  // The exact suppression the whole existing suite inherits via gotoEditor.
  await suppressCoachOverlay(page);
  await page.goto("/p/onb-returning");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // The overlay is ABSENT and the shipped shell is otherwise untouched.
  await expect(page.getByTestId("coach-overlay")).toHaveCount(0);
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("open-library")).toBeVisible();
});

test("M2: the agent-panel greeting leads with capability, then discloses the offline demo plainly", async ({
  page,
}) => {
  await gotoEditor(page, { id: "onb-m2" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const hint = page.getByTestId("agent-provider-hint");
  // Leads with what the agent CAN do…
  await expect(hint).toContainText("drafts sections");
  // …then names the offline-demo status honestly…
  await expect(hint).toContainText("canned offline demo");
  // …with the connect action still one click from Settings.
  await expect(page.getByTestId("agent-provider-hint-link")).toHaveText("connect a model");
});

test("M4: settings opens with an 'everything is optional' reassurance above the credential forms", async ({
  page,
}) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });

  const lead = page.getByTestId("settings-optional-lead");
  await expect(lead).toBeVisible();
  await expect(lead).toContainText(/nothing here is required/i);
  await expect(lead).toContainText(/offline/i);

  // It sits ABOVE the AI-provider and GitHub credential cards.
  const leadBox = await lead.boundingBox();
  const aiBox = await page.getByTestId("settings-section-ai").boundingBox();
  expect(leadBox).not.toBeNull();
  expect(aiBox).not.toBeNull();
  expect(leadBox!.y).toBeLessThan(aiBox!.y);
});

test("M1: the library entry names templates & demos so a novice can find them", async ({
  page,
}) => {
  await gotoEditor(page, { id: "onb-m1" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const lib = page.getByTestId("open-library");
  await expect(lib).toBeVisible();
  // Quiet at rest (still the "Galley ▾" pill), but the hover/AT affordance names
  // the destination — templates and demos, not just "the library".
  await expect(lib).toHaveAttribute("aria-label", /templates/i);
  await expect(lib).toHaveAttribute("title", /templates/i);
});
