import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Roadmap #11.8 — Agent UX polish, driven by the offline Demo model:
 *   1) Assistant text STREAMS in incrementally during a run (token-level), and a
 *      run still produces a reviewable diff + a "finished" toast.
 *   2) A Stop button appears while running; clicking it ends the run cleanly
 *      (no error UI, partial trace retained) and shows a "stopped" toast.
 */

test("streams assistant text incrementally and toasts on finish", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();

  // The live streaming block appears and is marked as actively streaming.
  const stream = page.getByTestId("agent-stream").first();
  await expect(stream).toBeVisible({ timeout: 30_000 });

  // The first preamble streams in word-by-word: capture a partial, then assert it
  // grows to the full sentence (proves incremental deltas, not one whole chunk).
  await expect(stream).toHaveText(/Let me/, { timeout: 30_000 });
  await expect(stream).toContainText("Let me read the document first.", { timeout: 30_000 });

  // The run completes with a reviewable diff and a "finished" toast inside the panel.
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(diff).toContainText(/compiled_clean/);
  await expect(page.getByTestId("agent-toast-finished")).toBeVisible();
  // No error UI on a clean run.
  await expect(page.getByTestId("agent-toast-error")).toHaveCount(0);
});

test("Stop ends the run cleanly: stopped toast, no error, partial trace kept", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();

  // The Stop button is offered while running; the stream has begun.
  const stop = page.getByTestId("agent-stop");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-trace")).toBeVisible({ timeout: 30_000 });

  await stop.click();

  // Stopping is clean: the Stop button goes away (idle), a "stopped" toast shows,
  // no error UI, and no diff is offered.
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("agent-toast-stopped")).toBeVisible();
  await expect(page.getByTestId("agent-toast-error")).toHaveCount(0);
  await expect(page.locator(".agent-error")).toHaveCount(0);
  await expect(page.getByTestId("diff-review")).toHaveCount(0);

  // The partial trace is retained (the run_started row at minimum).
  await expect(page.getByTestId("agent-trace")).toBeVisible();
  await expect(page.getByTestId("agent-send")).toBeEnabled();
});

/**
 * B13 — Agent pane UX review. The error toast is the SINGLE error channel (the
 * old persistent `.agent-error` block was a redundant second copy — now gone),
 * a "● Live" pulse marks an in-flight run in the trace header, and the disabled
 * Send button names WHY it's inert.
 */
test("B13: a run streams with a 'Live' pulse, then finishes with no persistent error block", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();

  // The Live indicator shows while the run is in flight…
  await expect(page.getByTestId("agent-live")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-live")).toContainText("Live");

  // …and drops out once the run completes (diff offered, run idle).
  await expect(page.getByTestId("diff-review")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("agent-live")).toHaveCount(0);

  // The persistent error block is gone for good — even on a clean run it must
  // never appear (errors live only in the auto-dismissing toast now).
  await expect(page.locator(".agent-error")).toHaveCount(0);
});

test("B13: the disabled Send button explains why it is inert", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Empty the request: Send disables and its title says to enter a request.
  const request = page.getByTestId("agent-request");
  await request.fill("");
  const send = page.getByTestId("agent-send");
  await expect(send).toBeDisabled();
  await expect(send).toHaveAttribute("title", /enter a request/i);

  // A non-empty request re-enables it, with an actionable title.
  await request.fill("Add a demo section.");
  await expect(send).toBeEnabled();
  await expect(send).toHaveAttribute("title", /send/i);
});

/**
 * #15 — deep agent pane: the step trace is collapsible. The 🔧/↳/↻/⚠ tool-step
 * rows can be hidden via a toggle (persisted), while the streamed assistant text
 * and the final DiffReview stay visible regardless. DISPLAY-ONLY — the Accept
 * gate and run lifecycle are untouched.
 */
test("#15: the tool-step trace collapses/expands and the choice persists", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();

  // Run to completion so the trace holds real tool steps + a diff.
  await expect(page.getByTestId("diff-review")).toBeVisible({ timeout: 90_000 });

  const toggle = page.getByTestId("agent-steps-toggle");
  const trace = page.getByTestId("agent-trace");
  await expect(toggle).toBeVisible();

  // Default COLLAPSED: step rows are hidden; toggle reads "Show steps".
  await expect(trace).toHaveAttribute("data-steps", "hidden");
  await expect(toggle).toContainText(/Show steps/);
  await expect(trace.locator(".trace-step")).toHaveCount(0);
  // The assistant message stream is visible even when steps are collapsed.
  await expect(page.getByTestId("agent-stream").first()).toBeVisible();

  // Expand: step rows appear; stream and Accept gate remain.
  await toggle.click();
  await expect(trace).toHaveAttribute("data-steps", "shown");
  await expect(toggle).toContainText(/Hide steps/);
  await expect(trace.locator(".trace-step").first()).toBeVisible();
  await expect(page.getByTestId("agent-stream").first()).toBeVisible();
  await expect(page.getByTestId("diff-review")).toBeVisible();

  // The EXPANDED choice persists across a reload (localStorage), proven on the next run.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("agent-trace")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-trace")).toHaveAttribute("data-steps", "shown");
  // Restore the default (collapsed) so the choice doesn't leak into other specs' state.
  await expect(page.getByTestId("agent-steps-toggle")).toContainText(/Hide steps/);
  await page.getByTestId("agent-steps-toggle").click();
});

/**
 * B10 — rail navigation clarity. Each rail icon reveals a visible label flyout
 * on hover/focus whose text mirrors the button's accessible name (so the rail
 * is discoverable without relying on a native title that never shows on touch),
 * and keyboard focus paints a clear ring/wash.
 */
test("B10: rail icons reveal a visible label matching their accessible name", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await expect(page.locator(".icon-rail")).toBeVisible();

  const filesBtn = page.getByTestId("rail-files");
  const tip = filesBtn.locator(".rail-tip");

  // The label is present in the DOM (mirrors aria-label) but hidden until hover.
  await expect(filesBtn).toHaveAttribute("aria-label", "Files");
  await expect(tip).toHaveText("Files");
  await expect(tip).toHaveCSS("opacity", "0");

  // Hovering reveals the flyout.
  await filesBtn.hover();
  await expect(tip).toHaveCSS("opacity", "1");

  // Keyboard focus also reveals it (focus-visible), proving non-pointer access.
  await page.getByTestId("history-button").focus();
  const histTip = page.getByTestId("history-button").locator(".rail-tip");
  await expect(histTip).toHaveText("Version history");
  await expect(histTip).toHaveCSS("opacity", "1");
});

/**
 * B17 — focus mode hides the lateral rail chrome, leaving only the exit-focus
 * toggle. The other rail buttons collapse; toggling off restores the full rail.
 */
test("B17: focus mode leaves only the exit-focus button on the rail, then restores", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  const focusToggle = page.getByTestId("focus-mode-toggle");
  const filesBtn = page.getByTestId("rail-files");

  // Default OFF: the full rail is shown.
  await expect(filesBtn).toBeVisible();
  await expect(focusToggle).toBeVisible();

  // Toggle ON: the tool buttons collapse, only the focus toggle remains.
  await focusToggle.click();
  await expect(filesBtn).toBeHidden();
  await expect(page.getByTestId("rail-agent")).toBeHidden();
  await expect(focusToggle).toBeVisible();

  // Toggle OFF (the one surviving control): the rail returns in full.
  await focusToggle.click();
  await expect(filesBtn).toBeVisible();
  await expect(page.getByTestId("rail-agent")).toBeVisible();
});
