import { expect, test, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
async function replaceSource(page: Page, source: string) {
  await page.locator('[data-testid="editor"] .cm-content').click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(source);
}
test("before-send distinguishes fresh SVG checks from failed current source", async ({
  page,
}) => {
  await gotoEditor(page, { id: "before-send" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  const panel = page.getByTestId("before-send");
  await panel.locator("summary").click();
  await panel.getByLabel("Maximum pages").fill("1");
  await replaceSource(page, "TODO: verify 12 kg.");
  await expect(panel).toContainText("failed: Editorial markers", {
    timeout: 60_000,
  });
  await replaceSource(page, "#unknown-function(");
  await expect(panel).toContainText("unavailable: SVG page cap");
  await expect(panel).not.toContainText("passed:");
});
test("layout auditions compile previews, enforce changed cap and reject stale edits", async ({
  page,
}) => {
  await gotoEditor(page, { id: "layout-auditions" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await replaceSource(
    page,
    "#set text(size: 12pt)\nFirst page.\n#pagebreak()\nSecond page.",
  );
  const panel = page.getByTestId("layout-auditions");
  await panel.locator("summary").click();
  await panel.getByLabel("Center margin (mm)").fill("22");
  await panel
    .getByRole("button", { name: "Compile layout auditions", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Review 17 mm margins" }),
  ).toBeEnabled({ timeout: 60_000 });
  await expect(panel.locator("svg")).toHaveCount(3);
  await panel.getByRole("button", { name: "Review 17 mm margins" }).click();
  await panel.getByLabel("Candidate page cap").fill("1");
  await panel.getByTestId("accept").click();
  await expect(panel).toContainText("no longer satisfies");
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).not.toContainText("margin: 17mm");
  await panel.getByLabel("Candidate page cap").fill("10");
  await replaceSource(page, "Concurrent human wording.");
  await expect(panel).toContainText("Project input changed");
  await expect(panel.getByTestId("accept")).toBeDisabled();
});
test("layout audition acceptance uses the normal reviewed source edit", async ({
  page,
}) => {
  await gotoEditor(page, { id: "layout-accept" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await replaceSource(page, "A statement of 12 kg.");
  const panel = page.getByTestId("layout-auditions");
  await panel.locator("summary").click();
  await panel
    .getByRole("button", { name: "Compile layout auditions", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Review 15 mm margins" })
    .click({ timeout: 60_000 });
  await expect(panel.getByTestId("meaning-changes")).toBeVisible();
  await panel.getByTestId("accept").click();
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText("#set page(margin: 15mm)");
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText("A statement of 12 kg.");
});

test("failed layout scratch compiles cannot be selected or accepted", async ({
  page,
}) => {
  await gotoEditor(page, { id: "layout-failed" });
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, {
    timeout: 60_000,
  });
  await replaceSource(page, "#missing-function()");
  const panel = page.getByTestId("layout-auditions");
  await panel.locator("summary").click();
  await panel
    .getByRole("button", { name: "Compile layout auditions", exact: true })
    .click();
  await expect(panel.getByText("Compile failed", { exact: true })).toHaveCount(
    3,
    { timeout: 60_000 },
  );
  await expect(
    panel.getByRole("button", { name: "Review 15 mm margins" }),
  ).toBeDisabled();
  await expect(panel.getByTestId("accept")).toHaveCount(0);
  await expect(
    page.locator('[data-testid="editor"] .cm-content'),
  ).toContainText("#missing-function()");
});
