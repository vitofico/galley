import { expect, test, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";
async function replaceSource(page: Page, text: string) {
  await page.locator('[data-testid="editor"] .cm-content').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}
async function boot(page: Page, id: string) {
  await gotoEditor(page, { id });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await replaceSource(page, "Revenue was 12 million.");
  const panel = page.getByTestId("document-workbench");
  await panel.locator(":scope > summary").click();
  return panel;
}
test("living numbers imports, flags stale dependencies and accepts a compiled reviewed refresh", async ({
  page,
}) => {
  const panel = await boot(page, "workbench-numbers");
  const numbers = panel.getByRole("group", {
    name: "Living numbers",
    exact: true,
  });
  await numbers.getByLabel("Import project CSV or JSON").setInputFiles({
    name: "data.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"revenue":12}'),
  });
  const form = numbers.getByRole("form", {
    name: "Bind a living number",
    exact: true,
  });
  await form.getByLabel("Value name").fill("Revenue");
  await form
    .getByRole("combobox", { name: "Source project file", exact: true })
    .selectOption("/data.json");
  await form.getByLabel("JSON dot path").fill("revenue");
  await form.getByLabel("Exact linked passage").fill("Revenue was 12 million.");
  await form.getByRole("button", { name: "Bind current value" }).click();
  await expect(numbers).toContainText("Source version retained");
  await openFilesDock(page);
  await page
    .locator('[data-testid="project-file"][data-path="/data.json"]')
    .click();
  await replaceSource(page, '{"revenue":24}');
  await page
    .locator('[data-testid="project-file"][data-path="/main.typ"]')
    .click();
  await panel.locator(":scope > summary").click();
  await expect(numbers).toContainText("Source changed");
  await numbers
    .getByRole("button", { name: "Preview reviewed refresh" })
    .click();
  await expect(panel).toContainText("Scratch compiled", { timeout: 60_000 });
  await panel.getByTestId("accept").click();
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText("Revenue was 24 million.");
  await expect(numbers).toContainText("Source version retained");
  await page.reload();
  await page
    .getByTestId("document-workbench")
    .locator(":scope > summary")
    .click();
  await expect(page.getByTestId("document-workbench")).toContainText(
    "Revenue: 24",
  );
});
test("evidence states, reviewer response export and failed scratch acceptance remain honest", async ({
  page,
}) => {
  const panel = await boot(page, "workbench-reviewer");
  const lens = panel.getByRole("group", { name: "Evidence lens", exact: true });
  const attach = lens.getByRole("form", {
    name: "Attach evidence to a claim",
    exact: true,
  });
  await attach
    .getByLabel("Exact linked passage")
    .fill("Revenue was 12 million.");
  await attach
    .getByRole("combobox", { name: "Source project file", exact: true })
    .selectOption("/main.typ");
  await attach.getByLabel("Exact source excerpt").fill("12 million");
  await attach.getByRole("button", { name: "Attach source version" }).click();
  await expect(lens).toContainText("Passage selected");
  await lens.getByRole("button", { name: "Mark reviewed by me" }).click();
  await expect(lens).toContainText("Reviewed by you");
  const desk = panel.getByRole("group", {
    name: "Reviewer response desk",
    exact: true,
  });
  const form = desk.getByRole("form", {
    name: "Add a reviewer comment",
    exact: true,
  });
  await form
    .getByLabel("Pasted reviewer comment")
    .fill("Please clarify the estimate.");
  await form.getByLabel("Exact linked passage").fill("Revenue was 12 million.");
  await form.getByLabel("Proposed replacement passage").fill("#let broken =");
  await form.getByLabel("Draft response").fill("We clarified the estimate.");
  await form.getByRole("button", { name: "Add reviewer comment" }).click();
  await expect(
    panel.getByLabel("Response letter (copy or download)"),
  ).toHaveValue(/We clarified the estimate/);
  await expect(
    panel.getByRole("link", { name: "Download response letter" }),
  ).toHaveAttribute("download", "reviewer-response.md");
  await desk.getByRole("button", { name: "Review proposed revision" }).click();
  await expect(panel).toContainText("Scratch compile failed", {
    timeout: 60_000,
  });
  await expect(panel.getByTestId("accept")).toBeDisabled();
  await panel
    .getByRole("button", { name: "Reject uncompiled proposal" })
    .click();
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText("Revenue was 12 million.");
});

test("native source export and reviewed import preserve reviewer records", async ({
  page,
}) => {
  const panel = await boot(page, "workbench-native-roundtrip");
  const desk = panel.locator("fieldset").filter({
    has: page.locator("legend", { hasText: "Reviewer response desk" }),
  });
  const form = desk.getByRole("form", {
    name: "Add a reviewer comment",
    exact: true,
  });
  await form
    .getByLabel("Pasted reviewer comment")
    .fill("Explain retained estimate");
  await form.getByLabel("Exact linked passage").fill("Revenue was 12 million.");
  await form
    .getByLabel("Draft response")
    .fill("Retained response with literal $& and $$.");
  await form.getByRole("button", { name: "Add reviewer comment" }).click();
  await expect(desk).toContainText("Explain retained estimate");
  const originalUrl = page.url();
  await page.getByTestId("export-menu-button").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-bundle").click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("Source bundle download unavailable");
  await page.getByTestId("open-library").click();
  await page.getByTestId("library-import-project").click();
  await page.getByTestId("import-project-file").setInputFiles({
    name: "reviewed-project.tar",
    mimeType: "application/x-tar",
    buffer: await (await import("node:fs/promises")).readFile(path),
  });
  await expect(page.getByTestId("import-project-accept")).toBeEnabled({
    timeout: 30_000,
  });
  // Review is still pending; no new project has opened until the explicit Accept.
  await expect(page.getByTestId("import-project-report")).toContainText(
    "workbench.json",
  );
  await page.getByTestId("import-project-accept").click();
  await expect(page).not.toHaveURL(originalUrl);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await page
    .getByTestId("document-workbench")
    .locator(":scope > summary")
    .click();
  await expect(page.getByTestId("document-workbench")).toContainText(
    "Explain retained estimate",
  );
  await expect(
    page
      .getByTestId("document-workbench")
      .getByLabel("Response letter (copy or download)"),
  ).toHaveValue(/Retained response with literal \$& and \$\$\./);
});
