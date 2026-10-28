import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

test("project import chooser works by keyboard and restores dialog focus", async ({
  page,
}) => {
  await page.goto("/library");
  const trigger = page.getByTestId("library-import-project");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const chooser = page.getByTestId("import-project-pick");
  const close = page
    .getByTestId("project-import-panel")
    .getByRole("button", { name: "Close", exact: true });
  await expect(chooser).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(chooser).toBeFocused();
  const picking = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await picking).setFiles([]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("project-import-panel")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("mention and slash suggestions activate by keyboard without sending", async ({
  page,
}) => {
  await gotoEditor(page);
  const request = page.getByTestId("agent-request");
  await request.fill("summarize @");
  await page.getByTestId("agent-mention-option-/main.typ").focus();
  await page.keyboard.press("Enter");
  await expect(request).toHaveValue("summarize @/main.typ ");
  await request.fill("/proofread");
  await page.getByTestId("agent-slash-option-proofread").focus();
  await page.keyboard.press("Space");
  await expect(request).toHaveValue(/^Proofread/);
  await expect(page.getByTestId("agent-stop")).toHaveCount(0);
  await expect(page.getByTestId("diff-review")).toHaveCount(0);
});
