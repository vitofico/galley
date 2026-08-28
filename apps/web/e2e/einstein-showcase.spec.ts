import { test, expect } from "@playwright/test";
import { openFilesDock } from "./files-dock.js";

/**
 * "Annus Mirabilis" showcase (#20.3) — the demo workspace's story end-to-end:
 * a FRESH boot seeds Einstein's 1905 desk (#20.2), the History rail lists the
 * four pre-dated 1905 versions, and comparing June ↔ September renders the
 * mass–energy addendum appearing in /relativity.typ — first in Einstein's
 * original notation (m = L/V²), then restated as E = mc². Reuses the existing
 * HistoryPanel → Compare flow (VersionCompare) verbatim; no shell changes.
 */
test("einstein showcase: fresh boot → four 1905 versions → June ↔ September compare shows E = mc² appearing", async ({
  page,
}) => {
  // Fresh boot of the persistent project shell: the eight-file demo workspace
  // seeds and compiles (the seed + history writes are async via IndexedDB).
  await page.goto("/?seed=einstein");
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await openFilesDock(page);
  await expect(page.getByTestId("project-file")).toHaveCount(8);

  // Open History from the rail — the four pre-seeded 1905 entries are listed
  // (newest-first timeline; no other versions exist on a fresh boot).
  await page.getByTestId("history-button").click();
  await expect(page.getByTestId("history-overlay")).toBeVisible();
  await expect(page.getByTestId("history-version")).toHaveCount(4, { timeout: 30_000 });
  const versions = page.getByTestId("history-version");
  await expect(versions.filter({ hasText: "17 March 1905" })).toHaveCount(1);
  await expect(versions.filter({ hasText: "11 May 1905" })).toHaveCount(1);
  await expect(versions.filter({ hasText: "30 June 1905" })).toHaveCount(1);
  await expect(versions.filter({ hasText: "27 September 1905" })).toHaveCount(1);

  // Select June ↔ September by NAME (robust to timeline order) and compare.
  await versions.filter({ hasText: "30 June 1905" }).getByTestId("select-version").check();
  await versions.filter({ hasText: "27 September 1905" }).getByTestId("select-version").check();
  await page.getByTestId("compare-versions").click();

  // The read-only compare renders older → newer (June is the base, September
  // the other) regardless of selection order.
  await expect(page.getByTestId("compare-overlay")).toBeVisible();
  const compare = page.getByTestId("version-compare");
  await expect(compare).toContainText("30 June 1905");
  await expect(compare).toContainText("27 September 1905");

  // Exactly one file changed between June and September: /relativity.typ
  // gained the addendum; everything else on the desk is untouched.
  await expect(page.getByTestId("vcompare-summary")).toContainText(
    "0 added · 0 removed · 1 modified",
  );
  const relativity = page.locator('[data-testid="vcompare-file"][data-path="/relativity.typ"]');
  await expect(relativity).toBeVisible();
  await expect(relativity.getByTestId("vcompare-file-head")).toContainText("modified");

  // The diff highlights the added mass–energy content as ADDITIONS: the
  // addendum heading, Einstein's original m = L/V², and the E = mc² restatement.
  const added = relativity.locator(".vcompare-line-add");
  await expect(
    added.filter({ hasText: "Does the Inertia of a Body Depend upon its Energy-Content?" }),
  ).toBeVisible();
  await expect(added.filter({ hasText: "m = L / V^2" })).toBeVisible();
  await expect(added.filter({ hasText: "E = m c^2" })).toBeVisible();
});
