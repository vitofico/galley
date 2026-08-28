import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * Mount e2e for the 14-D authoring surface: the `.galley/instructions` editor.
 *
 * The agent-steering CORE (reading the file + threading it into the agent loop)
 * already exists; this slice adds the missing creation/edit UI plus the
 * export/version regression fix (a live `.galley/instructions` must NOT fail the
 * projection closed). This spec drives the modal end-to-end:
 *   - open it from the ⌘K command palette;
 *   - type steering + a `## Constraints` block and Save;
 *   - reopen → the text persisted (round-trips through the CRDT);
 *   - the reserved file is HIDDEN from the document file tree;
 *   - exporting the source bundle still succeeds with the file present.
 */
test("14-D: create/edit project instructions; reserved file hidden; export unbroken", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Closed by default: nothing in the DOM (additive — shipped path unchanged).
  await expect(page.getByTestId("instructions-panel")).toHaveCount(0);

  // Open via the ⌘K palette's "Project instructions…" command.
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByTestId("command-palette-input");
  await expect(input).toBeFocused();
  await input.fill("project instructions");
  await expect(page.getByTestId("command-palette-item").first()).toContainText(
    "Project instructions",
  );
  await page.keyboard.press("Enter");

  const panel = page.getByTestId("instructions-panel");
  await expect(panel).toBeVisible();
  const textarea = page.getByTestId("instructions-textarea");
  await expect(textarea).toBeFocused();

  // Replace the seed with our own steering + a valid constraint.
  const body = "Write tersely and prefer active voice.\n\n## Constraints\n\nmax-words: 500";
  await textarea.fill(body);

  // Live preview reflects the parsed constraint and reports no warnings.
  await expect(page.getByTestId("instructions-constraints-summary")).toContainText("max 500 words");
  await expect(page.getByTestId("instructions-no-warnings")).toBeVisible();

  // Save closes the modal.
  await page.getByTestId("instructions-save").click();
  await expect(page.getByTestId("instructions-panel")).toHaveCount(0);

  // The reserved file is HIDDEN from the document file tree (config, not a doc).
  await expect(
    page.locator('[data-testid="project-file"]', { hasText: ".galley" }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="project-file"][data-path="/.galley/instructions"]'),
  ).toHaveCount(0);

  // The AgentPanel surfaces that instructions are now active.
  await expect(page.getByTestId("agent-instructions-active")).toBeVisible();

  // Reopen → the text persisted (round-tripped through the CRDT).
  // The button lives inside the overflow menu — open it first.
  await page.getByTestId("agent-overflow-button").click();
  await expect(page.getByTestId("agent-overflow-menu")).toBeVisible();
  await page.getByTestId("agent-edit-instructions").click();
  await expect(page.getByTestId("instructions-panel")).toBeVisible();
  await expect(page.getByTestId("instructions-textarea")).toHaveValue(body);
  await page.getByTestId("instructions-cancel").click();
  await expect(page.getByTestId("instructions-panel")).toHaveCount(0);

  // No regression to export: the source bundle still downloads with the
  // instructions file present (Part A keeps the projection ok:true).
  await page.getByTestId("export-menu-button").click();
  await expect(page.getByTestId("export-bundle")).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-bundle").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.tar$/);

  expect(pageErrors).toEqual([]);
});
