import { test, expect } from "@playwright/test";

/**
 * Mount e2e for roadmap 18.7 — Writing Goals. The card surfaces LIVE progress
 * against the project's `.galley/instructions` deterministic constraints (the
 * SAME checks the agent loop runs) for the writer. It is OPT-IN: it renders only
 * once the project has constraint-bearing instructions, so the shipped path is
 * byte-for-byte unchanged for a fresh project.
 *
 * This spec:
 *   - asserts the card is ABSENT on a fresh project (no constraints);
 *   - authors a `## Constraints` block (max-words: 5, required-section) via the
 *     ⌘K → "Project instructions…" modal and Saves;
 *   - asserts the card appears showing the live word count in an UNMET state
 *     (the default doc is well over 5 words; the Introduction section is missing);
 *   - the summary chip reports "to go", not "All goals met".
 */
test("18.7: writing-goals card is opt-in and shows live unmet progress", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // Boot the Einstein demo so the active document is comfortably over the 5-word
  // goal below (the blank starter would be borderline).
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Opt-in gate: no constraints yet → the card is ABSENT (shipped path unchanged).
  await expect(page.getByTestId("writing-goals")).toHaveCount(0);

  // Author constraints via the ⌘K palette's "Project instructions…" command.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("project instructions");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Project instructions",
  );
  await page.keyboard.press("Enter");

  const textarea = page.getByTestId("instructions-textarea");
  await expect(textarea).toBeFocused();
  const body =
    "Write tersely.\n\n## Constraints\n\nmax-words: 5\nrequired-section: \"Introduction\"";
  await textarea.fill(body);
  await expect(page.getByTestId("instructions-constraints-summary")).toContainText(
    "max 5 words",
  );
  await page.getByTestId("instructions-save").click();
  await expect(page.getByTestId("instructions-panel")).toHaveCount(0);

  // The card now renders (the project has real constraints).
  const card = page.getByTestId("writing-goals");
  await expect(card).toBeVisible();

  // Word goal: the default document is well over 5 words → unmet (shows "over").
  const words = page.getByTestId("writing-goals-words");
  await expect(words).toContainText(/\/\s*5 words/);
  await expect(page.getByTestId("writing-goals-words-over")).toBeVisible();

  // Required "Introduction" section is missing (default doc has no such heading).
  const section = page.getByTestId("writing-goals-section");
  await expect(section).toContainText("Introduction");
  await expect(section).toHaveClass(/is-unmet/);

  // Summary reflects unmet goals, not "All goals met".
  const summary = page.getByTestId("writing-goals-summary");
  await expect(summary).toContainText("to go");
  await expect(summary).not.toContainText("All goals met");

  expect(pageErrors).toEqual([]);
});
