import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * 11.8c — refine the pending proposal. The agent proposes a diff the human
 * reviews (DiffReview / the Accept gate) before it lands. "Refine…" lets the
 * user iterate on that PENDING proposal ("make it shorter") WITHOUT restarting
 * from the original document: the pending proposal's final source becomes the
 * new run's base, producing a NEW proposal that replaces the pending one. The
 * conflict-aware Accept semantics (ADR-0003) stay intact.
 *
 * Driven offline by the deterministic Demo model (same harness as agent.spec /
 * revise-selection.spec). The Demo model ignores the request content (it scripts
 * a fixed read → append a section → self-correct loop on WHATEVER base it reads),
 * so this spec asserts the WIRING — a second run fires, a fresh proposal is
 * shown, and Accept still lands it (Accept-gated, never auto-applied) — not any
 * literal "shorter" output.
 */

async function reachProposal(page: import("@playwright/test").Page) {
  // Headless Chromium reports transient storage (persist denied), which surfaces
  // the M9 transient-storage banner and shrinks the agent pane enough to intercept
  // the Accept click below. Shim persisted storage so this occlusion-sensitive
  // Accept flow runs banner-free (durability.spec covers the banner itself).
  await page.addInitScript(() => {
    const nav = navigator as unknown as { storage?: Record<string, unknown> };
    if (!nav.storage) nav.storage = {};
    Object.defineProperty(nav.storage, "persist", { configurable: true, value: async () => true });
    Object.defineProperty(nav.storage, "persisted", { configurable: true, value: async () => true });
  });
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("agent-send").click();
  const diff = page.getByTestId("diff-review");
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(diff).toContainText(/compiled_clean/);
  return diff;
}

test("11.8c: refine the pending proposal → a NEW proposal replaces it; Accept still lands it", async ({
  page,
}) => {
  const diff = await reachProposal(page);

  // The Refine affordance is offered on a COMPLETED proposal (alongside Accept /
  // Reject). It is impossible mid-run: the diff only renders once the run finishes.
  const refine = page.getByTestId("refine-proposal");
  await expect(refine).toBeVisible();

  // Toggling reveals the inline instruction field; an empty instruction can't submit.
  await refine.click();
  const refineInput = page.getByTestId("refine-input");
  await expect(refineInput).toBeVisible();
  await expect(refineInput).toBeFocused();
  await expect(page.getByTestId("refine-submit")).toBeDisabled();

  // Enter an instruction and submit → the pending proposal is discarded and a NEW
  // run starts (the proposal's final source is the new base). The current diff
  // unmounts while the chained run is in flight…
  await refineInput.fill("make it shorter");
  await expect(page.getByTestId("refine-submit")).toBeEnabled();
  await page.getByTestId("refine-submit").click();

  // The chained run is in flight: the pending diff unmounts (a Stop button shows).
  await expect(page.getByTestId("agent-stop")).toBeVisible({ timeout: 30_000 });
  await expect(diff).toHaveCount(0);

  // …and a FRESH proposal appears once the chained run completes (the run re-ran).
  // (The Demo model appends another section to the already-modified base.)
  await expect(diff).toBeVisible({ timeout: 90_000 });
  await expect(diff).toContainText(/compiled_clean/);
  await expect(page.getByTestId("accept")).toBeVisible();
  await expect(page.getByTestId("reject")).toBeVisible();
  // The refine affordance is offered again on the new proposal (chain again).
  await expect(page.getByTestId("refine-proposal")).toBeVisible();

  // Accept stays UNCHANGED: it lands the LATEST proposal against the live doc and
  // clears the diff (never auto-applied — the gate is mandatory throughout).
  await page.getByTestId("accept").click();
  await expect(diff).toHaveCount(0);
  await expect(page.locator('[data-testid="editor"] .cm-content')).toContainText(
    "Inserted by the Galley demo agent.",
  );
});

test("11.8c: a refine run is cancellable like any run, and an empty instruction is a no-op", async ({
  page,
}) => {
  await reachProposal(page);

  // Empty instruction → submit is disabled (no-op): no second run starts.
  await page.getByTestId("refine-proposal").click();
  await expect(page.getByTestId("refine-submit")).toBeDisabled();
  // Whitespace-only is still a no-op.
  await page.getByTestId("refine-input").fill("   ");
  await expect(page.getByTestId("refine-submit")).toBeDisabled();

  // A real refine fires a run; the Stop button proves it is a normal, cancellable run.
  await page.getByTestId("refine-input").fill("more formal");
  await page.getByTestId("refine-submit").click();

  const stop = page.getByTestId("agent-stop");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();

  // Stopping the refine run is clean: idle, a stopped toast, no error, no diff.
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("agent-toast-stopped")).toBeVisible();
  await expect(page.getByTestId("agent-toast-error")).toHaveCount(0);
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
});
