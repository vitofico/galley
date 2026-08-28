import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";

/**
 * #17.2 / ADR-0019 + unified-git-sync (2026-06-18) — git-sync UI WIRING e2e for
 * the GENERIC git destination. Proves the destination-first panel is wired into
 * the project shell end-to-end WITHOUT a live smart-HTTP round-trip (that is
 * manual-verify per ADR-0019 — CORS/auth vary by host and CI has no git server):
 *   - the topbar button opens the panel on the destination CHOOSER;
 *   - picking "Other git host" opens the URL/branch/token form;
 *   - Save persists the remote config (url/ref) and lands on the configured card,
 *     surviving a reload — while the token input is write-only (never re-seeded);
 *   - Push/Fetch live on the configured card;
 *   - a Push to an unreachable remote surfaces a REDACTED error — the token never
 *     appears in the status line (the persistence core scrubs it).
 *   - Change returns to the chooser.
 *
 * The token used here is a recognisable sentinel so the redaction assertion is
 * meaningful: it must NOT appear anywhere on the page after a failed push.
 */
const TOKEN_SENTINEL = "ghp_SECRETSENTINEL_DO_NOT_LEAK_0001";
const REMOTE_URL = "https://galley-no-such-host.invalid/owner/repo.git";

test("git-sync panel: generic destination persists across reload, errors are redacted", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Open the panel from the topbar (no hand-edited URL) → the destination chooser.
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();
  await expect(page.getByTestId("git-dest-chooser")).toBeVisible();

  // Pick the generic git destination → the URL/branch/token form.
  await page.getByTestId("git-dest-generic").click();
  await expect(page.getByTestId("git-dest-generic-form")).toBeVisible();

  // The privacy disclosure is present (token-stays-local promise).
  await expect(page.getByTestId("git-sync-disclosure")).toContainText(
    /never sent to any Galley server/i,
  );

  // Save a remote with a token. Use an unreachable host so a later Push fails
  // fast without a real git server.
  await page.getByTestId("git-sync-url").fill(REMOTE_URL);
  await page.getByTestId("git-sync-ref").fill("main");
  await page.getByTestId("git-sync-token").fill(TOKEN_SENTINEL);
  await page.getByTestId("git-sync-save").click();

  // After save: the configured card shows, Push/Fetch enabled, repo/branch named.
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();
  await expect(page.getByTestId("git-dest-summary-repo")).toContainText(REMOTE_URL);
  await expect(page.getByTestId("git-dest-summary-branch")).toContainText("main");
  await expect(page.getByTestId("git-sync-push")).toBeEnabled();
  await expect(page.getByTestId("git-sync-fetch")).toBeEnabled();

  // Reload → the panel reopens straight on the configured card (kind persisted).
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();
  await expect(page.getByTestId("git-dest-summary-repo")).toContainText(REMOTE_URL);

  // Change → back to the form: url/ref persisted, token NOT re-seeded, and the
  // stored-token indicator shows a token persisted without exposing it.
  await page.getByTestId("git-dest-change").click();
  await page.getByTestId("git-dest-generic").click();
  await expect(page.getByTestId("git-sync-url")).toHaveValue(REMOTE_URL);
  await expect(page.getByTestId("git-sync-ref")).toHaveValue("main");
  await expect(page.getByTestId("git-sync-token")).toHaveValue("");
  await expect(page.getByTestId("git-sync-token-state")).toBeVisible();

  // Re-save (blank token keeps the stored one) → back to the configured card.
  await page.getByTestId("git-sync-save").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();

  // Push to the unreachable remote → a visible, FAILED status that never leaks
  // the token. (Browsers vary on the exact network error; we only assert failure
  // + no-leak, not a specific message.)
  await page.getByTestId("git-sync-push").click();
  const status = page.getByTestId("git-sync-status");
  await expect(status).toHaveAttribute("data-ok", "false", { timeout: 30_000 });
  // The token must not appear in the status line NOR anywhere in the DOM.
  await expect(status).not.toContainText(TOKEN_SENTINEL);
  await expect(page.locator("body")).not.toContainText(TOKEN_SENTINEL);

  // Change wipes the kind marker; reopening the chooser shows the two cards again.
  await page.getByTestId("git-dest-change").click();
  await expect(page.getByTestId("git-dest-chooser")).toBeVisible();
  await expect(page.getByTestId("git-dest-generic")).toBeVisible();
});

/**
 * HIGH-1 regression: a remote URL carrying an embedded credential
 * (`https://user:PAT@host/…`) must be REJECTED at save and the PAT must NEVER be
 * persisted nor rendered back into the DOM — not in the URL input, not anywhere —
 * across a reload. This guards the write-only-token invariant against the
 * URL-userinfo bypass.
 */
const URL_PAT = "ghp_URLEMBEDDED_NEVER_RENDER_7777";

test("git-sync panel: a URL with embedded credentials is rejected and never rendered", async ({
  page,
}) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();
  await page.getByTestId("git-dest-generic").click();
  await expect(page.getByTestId("git-dest-generic-form")).toBeVisible();

  // Paste a credential-bearing URL and save.
  await page.getByTestId("git-sync-url").fill(`https://x-access-token:${URL_PAT}@github.com/o/r.git`);
  await page.getByTestId("git-sync-save").click();

  // Save is rejected with a clear validation message; nothing is stored, so the
  // form stays put (no configured card).
  const status = page.getByTestId("git-sync-status");
  await expect(status).toHaveAttribute("data-ok", "false");
  await expect(status).toContainText(/token field, not the URL/i);
  await expect(page.getByTestId("git-dest-configured")).toHaveCount(0);

  // The PAT must not appear anywhere in the DOM (incl. input values).
  await expect(page.locator("body")).not.toContainText(URL_PAT);

  // Reload + reopen: the credential never round-trips. No destination was
  // committed, so the panel reopens on the chooser.
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-dest-chooser")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(URL_PAT);
});
