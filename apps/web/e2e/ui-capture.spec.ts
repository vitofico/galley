import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";
import {
  CollabDocument,
  CollabProject,
  CollabConnection,
  WebSocketTransport,
  publishControlRequest,
  getControlResponse,
  awaitControlResponse,
  publishProposal,
  publishFileProposal,
  markRunOpen,
  bytesToBase64Url,
  base64UrlToBytes,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  openPairingPayload,
  PAIRING_NONCE_BYTES,
  type DocHost,
  type WebSocketLike,
  type ControlResponse,
} from "@galley/collab";
import { randomBytes as nodeRandomBytes, randomUUID } from "node:crypto";

/**
 * Capture-only UI harness (no assertions beyond "it rendered"). Produces the
 * view × state × theme matrix under apps/web/.ui-shots/ for before/after review
 * and as the substrate the (deferred) UI-critique agent will reuse.
 *
 * Run via the `capture` docker-compose service so the shots land on the host.
 */
const SHOTS = ".ui-shots";

async function settle(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
}
async function setTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
}
/**
 * Kill CSS transitions/animations so a theme flip is INSTANT and the screenshot
 * is deterministic. Without this, a dark capture taken right after `setTheme`
 * catches the topbar's 120ms color transition mid-flight, making the whole
 * header look uniformly dimmed (a capture artifact, not a real dark-mode bug).
 */
async function freeze(page: import("@playwright/test").Page) {
  await page.addStyleTag({
    content: "*,*::before,*::after{transition:none!important;animation:none!important;}",
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`capture: editor (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/editor-${theme}.png`, fullPage: true });
  });

  // Styles: the Style Library overlay on a NON-conforming doc (blank starter) —
  // shows the bundled style cards, the intro, and the "can't switch" notice with
  // Apply disabled. Robust (no editor typing).
  test(`capture: style library blocked (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill("Change style");
    await page.getByTestId("command-palette-item").first().click();
    await expect(page.getByTestId("style-library")).toBeVisible();
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/style-library-blocked-${theme}.png`, fullPage: true });
  });

  // Styles: the SWITCHABLE state — a styleable doc (canonical `doc` import) so
  // Apply is enabled. Also functionally exercises the in-browser apply path.
  test(`capture: style library switchable + apply (${theme})`, async ({ page }) => {
    await gotoEditor(page, { id: `style-cap-${theme}` });
    await settle(page);
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await editor.pressSequentially('#import "/style.typ": doc, accent, ink, ink-soft, rule');
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await editor.pressSequentially('#show: doc.with(title: "Styled document", author: "A. Author")');
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await editor.pressSequentially("= Introduction");
    await page.keyboard.press("Enter");
    await editor.pressSequentially("A paragraph of body text to show the style.");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill("Change style");
    await page.getByTestId("command-palette-item").first().click();
    await expect(page.getByTestId("style-library")).toBeVisible();
    await expect(page.getByTestId("style-apply")).toBeEnabled();
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/style-library-switchable-${theme}.png`, fullPage: true });
    // Apply "Modern" and capture the re-rendered preview (functional check).
    await page.getByTestId("style-card").filter({ hasText: "Modern" }).click();
    await page.getByTestId("style-apply").click();
    await expect(page.getByTestId("style-library")).toHaveCount(0);
    await settle(page);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/style-applied-modern-${theme}.png`, fullPage: true });
  });

  test(`capture: editor, files collapsed (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // #19.2: the file list is the rail's docked card; its rail icon closes it.
    await page.getByTestId("rail-files").click();
    await expect(page.getByTestId("project-files")).toHaveCount(0);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/editor-files-collapsed-${theme}.png`, fullPage: true });
  });

  test(`capture: library (${theme})`, async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/library-${theme}.png`, fullPage: true });
  });

  // The "+" create tile expanded into its inline name field.
  test(`capture: library new-project tile (${theme})`, async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await page.getByTestId("new-project-tile").click();
    await expect(page.getByTestId("new-project-name")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/library-new-tile-${theme}.png`, fullPage: true });
  });

  // The inline destructive delete confirm on a card.
  test(`capture: library delete confirm (${theme})`, async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await page.getByTestId("new-project-tile").click();
    await page.getByTestId("new-project-name").fill("Doomed Draft");
    await page.getByTestId("create-project").click();
    const card = page.locator('[data-testid="project-card"]', { hasText: "Doomed Draft" });
    await expect(card).toBeVisible();
    await card.getByTestId("delete-project").click();
    await expect(card.getByTestId("delete-confirm")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/library-delete-confirm-${theme}.png`, fullPage: true });
  });
}

test("capture: narrow editor (light)", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await gotoEditor(page);
  await settle(page);
  await freeze(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/editor-narrow.png`, fullPage: true });
});

// Wave-1 closeout surfaces (#6 citation paste, E2 compile-mode, #18.5 focus mode).
const BIBTEX_SHOT = `@article{knuth1984,
  title = {Literate Programming},
  author = {Knuth, Donald E.},
  journal = {The Computer Journal},
  year = {1984},
}`;

for (const theme of ["light", "dark"] as const) {
  test(`capture: citation panel resolved (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // #19.2: the citation control is a tab of the rail's docked Insert panel.
    await page.getByTestId("insert-button").click();
    await page.getByTestId("add-citation").click();
    await expect(page.getByTestId("citation-panel")).toBeVisible();
    await page.getByTestId("citation-input").fill(BIBTEX_SHOT);
    await page.getByTestId("citation-resolve").click();
    await expect(page.getByTestId("citation-result")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/citation-panel-${theme}.png`, fullPage: true });
  });
}

// Tier E #2 — in-document full-text search (find in files).
for (const theme of ["light", "dark"] as const) {
  test(`capture: in-doc search results (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // The rail magnifier docks the Search panel; type a query the default
    // workspace matches so the populated results list (count + rows) is shown.
    await page.getByTestId("rail-search").click();
    await expect(page.getByTestId("search-panel")).toBeVisible();
    await page.getByTestId("search-input").fill("the");
    await expect(page.getByTestId("search-result").first()).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/in-doc-search-${theme}.png`, fullPage: true });
  });
}

// 11.8b — selection-scoped revise prompt ("Cmd-K on a region").
for (const theme of ["light", "dark"] as const) {
  test(`capture: revise-selection prompt (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // Put a non-empty selection in the editor, then open the revise prompt.
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect(page.getByTestId("revise-selection-prompt")).toBeVisible();
    await page.getByTestId("revise-selection-input").fill("make this more concise");
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/revise-selection-${theme}.png`, fullPage: true });
  });
}

// #13 — the explicit "Insert reference…" label picker.
for (const theme of ["light", "dark"] as const) {
  test(`capture: insert-reference picker (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // ⌘K → "Insert reference…" opens the project-wide label picker.
    await page.getByTestId("palette-button").click();
    await page.getByTestId("command-palette-input").fill("Insert reference");
    await page.getByTestId("command-palette-item").first().click();
    await expect(page.getByTestId("insert-reference-picker")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/insert-reference-${theme}.png`, fullPage: true });
  });
}

// 11.8c — the "Refine…" affordance on a pending proposal.
for (const theme of ["light", "dark"] as const) {
  test(`capture: refine pending proposal (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // Drive a run (demo model) to a pending proposal, then open the Refine input.
    await page.getByTestId("agent-send").click();
    await expect(page.getByTestId("diff-review")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("refine-proposal").click();
    await expect(page.getByTestId("refine-input")).toBeVisible();
    await page.getByTestId("refine-input").fill("make it more concise");
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/refine-proposal-${theme}.png`, fullPage: true });
  });
}

// #12 — the nested folder tree (files grouped by path prefix).
for (const theme of ["light", "dark"] as const) {
  test(`capture: folder tree (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // Create a couple of files under /chapters so the nested folder renders.
    await page.getByTestId("new-file-path").fill("/chapters/intro.typ");
    await page.getByTestId("add-file").click();
    await page.getByTestId("new-file-path").fill("/chapters/method.typ");
    await page.getByTestId("add-file").click();
    await expect(
      page.locator('[data-testid="project-folder"][data-path="/chapters"]'),
    ).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/folder-tree-${theme}.png`, fullPage: true });
  });
}

// #23.1 — the at-risk data-durability nudge (forced via a storage-pressure fake).
for (const theme of ["light", "dark"] as const) {
  test(`capture: durability nudge (${theme})`, async ({ page }) => {
    // Override the StorageManager BEFORE the bundle loads so durability resolves
    // to at-risk: transient (the browser refuses to persist) AND under real
    // storage pressure (usage ≥ the 0.9 nudge threshold — transience alone no
    // longer nudges).
    await page.addInitScript(() => {
      const nav = navigator as unknown as { storage?: Record<string, unknown> };
      if (!nav.storage) Object.defineProperty(nav, "storage", { configurable: true, value: {} });
      Object.defineProperty(nav.storage, "persist", { configurable: true, value: async () => false });
      Object.defineProperty(nav.storage, "persisted", { configurable: true, value: async () => false });
      Object.defineProperty(nav.storage, "estimate", {
        configurable: true,
        value: async () => ({ usage: 950, quota: 1_000 }),
      });
    });
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await expect(page.getByTestId("durability-notice")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/durability-nudge-${theme}.png`, fullPage: true });
  });
}

// Wave-18b new surfaces (#17.1 Zotero connect, #17.3 project-zip import).
for (const theme of ["light", "dark"] as const) {
  test(`capture: citation Zotero connect (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("insert-button").click();
    await page.getByTestId("add-citation").click();
    await expect(page.getByTestId("citation-panel")).toBeVisible();
    await page.getByTestId("citation-mode-library").click();
    await page.getByTestId("citation-library-source-zotero").click();
    await expect(page.getByTestId("citation-zotero-body")).toBeVisible();
    await page.getByTestId("citation-zotero-id").fill("475425");
    await page.getByTestId("citation-zotero-key").fill("a1b2c3d4e5f6g7h8i9j0k1l2");
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/citation-zotero-${theme}.png`, fullPage: true });
  });

  test(`capture: citation Mendeley connect (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("insert-button").click();
    await page.getByTestId("add-citation").click();
    await expect(page.getByTestId("citation-panel")).toBeVisible();
    await page.getByTestId("citation-mode-library").click();
    await page.getByTestId("citation-library-source-mendeley").click();
    await expect(page.getByTestId("citation-mendeley-body")).toBeVisible();
    await page.getByTestId("citation-mendeley-token").fill("a1b2c3d4e5f6g7h8i9j0k1l2");
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/citation-mendeley-${theme}.png`, fullPage: true });
  });

  test(`capture: import project zip (${theme})`, async ({ page }) => {
    // Project import now lives on the Projects page (the landing surface).
    await page.goto("/library");
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await page.getByTestId("library-import-project").click();
    await expect(page.getByTestId("project-import-panel")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/import-project-${theme}.png`, fullPage: true });
  });
}

test("capture: compile-mode server unavailable (light)", async ({ page }) => {
  await gotoEditor(page);
  await settle(page);
  // #19.3: the toggle lives in the status chip's popover.
  await page.getByTestId("status-chip").click();
  await page.getByTestId("compiler-mode-server").click();
  await expect(page.getByTestId("compiler-mode-server-unavailable")).toBeVisible();
  await freeze(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/compiler-mode-server-unavailable.png`, fullPage: true });
});

// #19.3 consolidation surfaces: the status-chip popover and the Export menu.
for (const theme of ["light", "dark"] as const) {
  test(`capture: status popover (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("status-chip").click();
    await expect(page.getByTestId("status-popover")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/status-popover-${theme}.png`, fullPage: true });
  });

  test(`capture: export menu (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("export-menu-button").click();
    await expect(page.getByTestId("export-menu")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/export-menu-${theme}.png`, fullPage: true });
  });

  // The per-project GitHub push target (2026-06-15 split): the Git panel now owns
  // the owner/name@branch selection. Seed a device connection so the GitHub block
  // renders, then pick a repo so the current-target + push affordance show.
  test(`capture: git GitHub repo target (${theme})`, async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "galley.githubConnect",
        JSON.stringify({ token: "ghp_capture_only", login: "octocat" }),
      ),
    );
    await gotoEditor(page);
    await settle(page);
    await page.getByTestId("git-sync-button").click();
    await expect(page.getByTestId("git-sync-panel")).toBeVisible();
    // Destination-first: pick GitHub (connection pre-seeded → straight to the repo
    // picker), choose a repo, and land on the configured destination card.
    await page.getByTestId("git-dest-github").click();
    await page.getByTestId("github-repo-name").fill("paper");
    await page.getByTestId("github-repo-save").click();
    await expect(page.getByTestId("git-dest-configured")).toBeVisible();
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/git-github-target-${theme}.png`, fullPage: true });
  });

  // The destination chooser — the unconfigured entry point of the unified panel.
  test(`capture: git destination chooser (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await page.getByTestId("git-sync-button").click();
    await expect(page.getByTestId("git-dest-chooser")).toBeVisible();
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/git-dest-chooser-${theme}.png`, fullPage: true });
  });

  // The generic "Other git host" sub-flow (URL / branch / token form).
  test(`capture: git generic destination form (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await page.getByTestId("git-sync-button").click();
    await page.getByTestId("git-dest-generic").click();
    await expect(page.getByTestId("git-sync-url")).toBeVisible();
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/git-generic-form-${theme}.png`, fullPage: true });
  });
}

// #19.4 surfaces: the /join name prompt, the ⌘K nudge (visible in the editor
// shots above on a fresh profile), and the main-deleted Notice.
for (const theme of ["light", "dark"] as const) {
  test(`capture: join name prompt (${theme})`, async ({ page }) => {
    await page.goto("/join/capture-room");
    await expect(page.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/join-prompt-${theme}.png`, fullPage: true });
  });

  test(`capture: main-deleted notice (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    // Delete the main file → the Notice (with its inline action) appears in the
    // files dock.
    await page.locator('[data-testid="delete-file"][data-path="/main.typ"]').click();
    await expect(page.getByTestId("main-deleted-notice")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/main-deleted-notice-${theme}.png`, fullPage: true });
  });
}

// L4 — the stale-render edge banner: a previously-good doc edited into a compile
// error keeps the last good page on screen; the banner surfaces that on the
// preview itself ("Showing last good render · N errors").
test("capture: stale-render banner (light)", async ({ page }) => {
  await gotoEditor(page);
  await settle(page);
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("= Title\n#let x =");
  await expect(page.getByTestId("preview-stale-notice")).toBeVisible({ timeout: 30_000 });
  await freeze(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/stale-render-banner.png`, fullPage: true });
});

// L10 — the project-name pill's hover/focus "click to rename" affordance
// (underline + pencil). Hover it so the shot shows the editable cue.
test("capture: project-name rename affordance (light)", async ({ page }) => {
  await gotoEditor(page);
  await settle(page);
  await page.getByTestId("project-name").hover();
  await freeze(page);
  await page.waitForTimeout(150);
  await page.getByTestId("project-name").hover();
  await page.screenshot({ path: `${SHOTS}/rename-affordance.png`, fullPage: true });
});

test("capture: focus mode (light)", async ({ page }) => {
  await gotoEditor(page);
  await settle(page);
  await page.getByTestId("focus-mode-toggle").click();
  await freeze(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/focus-mode.png`, fullPage: true });
});

// Wave-2 surfaces (#2 templates) — picker is now on the Projects page.
for (const theme of ["light", "dark"] as const) {
  test(`capture: template picker (${theme})`, async ({ page }) => {
    await page.goto("/library");
    await expect(page.getByTestId("library")).toBeVisible({ timeout: 30_000 });
    await setTheme(page, theme);
    await page.getByTestId("library-new-from-template").click();
    await expect(page.getByTestId("template-picker")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/template-picker-${theme}.png`, fullPage: true });
  });
}

// #19.5 restyle surfaces: the ⌘K palette, the Share popover, and the
// history / editor-prefs dock cards (the glass language in both themes).
for (const theme of ["light", "dark"] as const) {
  test(`capture: command palette (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/command-palette-${theme}.png`, fullPage: true });
  });

  test(`capture: share popover (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("share-button").click();
    await expect(page.getByTestId("share-popover")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/share-popover-${theme}.png`, fullPage: true });
  });

  test(`capture: history dock (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.getByTestId("history-button").click();
    await expect(page.getByTestId("history-panel")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/history-dock-${theme}.png`, fullPage: true });
  });

}

// #19.7: the unified /settings surface (the editor-prefs dock's successor) —
// the full page in both themes. The dark variant is chosen THROUGH the page's
// own Appearance control so the pressed state in the shot is the real one.
for (const theme of ["light", "dark"] as const) {
  test(`capture: settings page (${theme})`, async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
    if (theme === "dark") {
      await page.getByTestId("settings-theme-dark").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/settings-${theme}.png`, fullPage: true });
  });
}

// Wave-19: the #16.3 "Agent Access" settings section — the enabled (paired) state
// showing the pairing command, the new user-facing surface from the responder mount.
for (const theme of ["light", "dark"] as const) {
  test(`capture: agent access enabled (${theme})`, async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
    if (theme === "dark") {
      await page.getByTestId("settings-theme-dark").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
    await page.getByTestId("agent-access-enable").click();
    await expect(page.getByTestId("agent-access-pairing")).toBeVisible();
    await page.getByTestId("settings-section-agent-access").scrollIntoViewIfNeeded();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/agent-access-${theme}.png`, fullPage: true });
  });
}

// #16.3: the per-request `open_project` CONSENT MODAL — the blocking, high-stakes
// surface a paired agent raises before the project is opened + shared. Driven over
// the REAL control mailbox (a kernel-shaped Node ws peer publishes open_project),
// exactly like the e2e, so the shot is the genuine rendered modal, not a mock.
{
  const HERE = fileURLToPath(import.meta.url);
  const requireFromMcp = createRequire(resolve(HERE, "../../../mcp/package.json"));
  const { WebSocket: WS } = requireFromMcp("ws") as {
    WebSocket: new (url: string) => WebSocketLike;
  };
  const KERNEL_AUTHOR = { kind: "human", userId: "capture-kernel" } as const;

  for (const theme of ["light", "dark"] as const) {
    test(`capture: agent open-project consent (${theme})`, async ({ page }) => {
      // Enable Agent Access in /settings, read the pairing coordinates, then go
      // back to the editor (SPA) so the ProjectApp consent handler is mounted.
      await page.goto("/settings");
      await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
      if (theme === "dark") {
        await page.getByTestId("settings-theme-dark").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      }
      await page.getByTestId("agent-access-enable").click();
      const pairing = page.getByTestId("agent-access-pairing");
      await expect(pairing).toBeVisible({ timeout: 30_000 });
      const command = await pairing.inputValue();
      const code = command.match(/--pairing-code\s+(\S+)/)![1]!;
      const syncMatch = command.match(/--sync\s+(\S+)/)![1]!;
      const syncUrl = syncMatch.startsWith("ws")
        ? syncMatch
        : `ws://${new URL(page.url()).hostname}:1234`;
      await page.getByTestId("settings-back").click();
      await settle(page);

      // B2 (ADR-0026): run the ECDH pairing handshake to obtain the control room.
      const { pairingRoom, macKey, codeSecret } = await deriveBootstrap(code);
      const pairDoc = new CollabDocument("");
      const pairConn = new CollabConnection(
        pairDoc,
        new WebSocketTransport(
          () => new WS(`${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(pairingRoom)}`),
        ),
        { author: KERNEL_AUTHOR },
      );
      pairConn.connect();
      const pairHost: DocHost = { doc: pairDoc.doc };
      let controlRoom: string;
      try {
        const kernelEph = await generateEphemeralKeyPair();
        const ephPub = await exportEphemeralPublic(kernelEph);
        const nonce = new Uint8Array(nodeRandomBytes(PAIRING_NONCE_BYTES));
        const nonceB64 = bytesToBase64Url(nonce);
        const pid = randomUUID();
        const claimMac = await computeClaimMac(macKey, {
          direction: "kernel",
          ephPublicRaw: ephPub,
          nonce,
          requestId: pid,
        });
        publishControlRequest(
          pairHost,
          { op: "pairing_claim", params: { ephPub: bytesToBase64Url(ephPub), nonce: nonceB64, claimMac } },
          KERNEL_AUTHOR,
          pid,
        );
        const resp = await awaitControlResponse(pairHost, pid, { timeoutMs: 30_000 });
        const { bEphPub, sealed } = (resp as Extract<ControlResponse, { ok: true }>).result as {
          bEphPub: string;
          sealed: { iv: string; ct: string };
        };
        const sealKey = await deriveSealKey(
          kernelEph.privateKey,
          base64UrlToBytes(bEphPub)!,
          codeSecret,
          nonce,
        );
        const opened = await openPairingPayload(sealKey, sealed, { nonce: nonceB64, requestId: pid, pairingRoom });
        controlRoom = opened!.controlRoom;
      } finally {
        pairConn.destroy();
        pairDoc.destroy();
      }

      // Join the control room as the kernel would and drive the request.
      const doc = new CollabDocument("");
      const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(controlRoom)}`;
      const connection = new CollabConnection(
        doc,
        new WebSocketTransport(() => new WS(url)),
        { author: KERNEL_AUTHOR },
      );
      connection.connect();
      const host: DocHost = { doc: doc.doc };
      try {
        // Discover the open project's id (list_projects), then ask to open it.
        const lpId = publishControlRequest(host, { op: "list_projects", params: {} }, KERNEL_AUTHOR);
        let projectId = "";
        await expect
          .poll(
            () => {
              const resp = getControlResponse(host, lpId);
              if (resp?.ok) {
                const rows = resp.result as Array<{ projectId: string }>;
                if (rows.length > 0) projectId = rows[0]!.projectId;
              }
              return projectId;
            },
            { timeout: 30_000 },
          )
          .not.toBe("");
        publishControlRequest(host, { op: "open_project", params: { projectId } }, KERNEL_AUTHOR);
        await expect(page.getByTestId("agent-open-consent")).toBeVisible({ timeout: 30_000 });
        await freeze(page);
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${SHOTS}/agent-open-consent-${theme}.png`, fullPage: true });
      } finally {
        connection.destroy();
        doc.destroy();
      }
    });
  }
}

// 14-D: the project-instructions authoring modal (InstructionsPanel) — pre-filled
// with the parse-clean SEED, opened via the ⌘K palette. The live parsed preview
// (steering / constraints summary / warnings) is the surface this slice adds.
for (const theme of ["light", "dark"] as const) {
  test(`capture: project instructions (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("command-palette-input");
    await expect(input).toBeFocused();
    await input.fill("project instructions");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("instructions-panel")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/instructions-panel-${theme}.png`, fullPage: true });
  });
}

// 18.7: the Writing Goals card — live, opt-in progress vs the project's
// `.galley/instructions` constraints. Authored via the ⌘K instructions modal so
// the card renders (it is absent until constraints exist).
for (const theme of ["light", "dark"] as const) {
  test(`capture: writing goals (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByTestId("command-palette-input");
    await expect(input).toBeFocused();
    await input.fill("project instructions");
    await page.keyboard.press("Enter");
    await page.getByTestId("instructions-textarea").fill(
      'Write tersely.\n\n## Constraints\n\nmax-words: 120\nrequired-section: "Introduction"\nforbidden-word: "utilize"',
    );
    await page.getByTestId("instructions-save").click();
    await expect(page.getByTestId("writing-goals")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/writing-goals-${theme}.png`, fullPage: true });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// ADR-0025 §5 NEW AGENT-REVIEW SURFACES — driven over the REAL sync relay by a
// kernel-shaped Node peer (mirrors mcp-run-review / mcp-file-proposals specs), so
// each shot is the genuine rendered review pane, not a mock. Share from the UI to
// mint the capability room, publish proposals on the peer, then open the global
// pending-review pane (the badge) and screenshot.
// ──────────────────────────────────────────────────────────────────────────
{
  const HERE2 = fileURLToPath(import.meta.url);
  const requireFromMcp2 = createRequire(resolve(HERE2, "../../../mcp/package.json"));
  const { WebSocket: WS2 } = requireFromMcp2("ws") as {
    WebSocket: new (url: string) => WebSocketLike;
  };
  const MCP_AUTHOR = { kind: "agent", runId: "mcp" } as const;

  function joinAsNodePeer(syncUrl: string, room: string) {
    const project = new CollabProject();
    const url = `${syncUrl.replace(/\/+$/, "")}/${encodeURIComponent(room)}`;
    const connection = new CollabConnection(
      project,
      new WebSocketTransport(() => new WS2(url)),
      { author: MCP_AUTHOR },
    );
    connection.connect();
    return {
      project,
      destroy() {
        connection.destroy();
        project.destroy();
      },
    };
  }

  function mainFileText(project: CollabProject): { path: string; text: string } | undefined {
    const mainId = project.mainFileId();
    if (!mainId) return undefined;
    const file = project.getFile(mainId);
    return file && !file.deleted ? { path: file.path, text: file.text } : undefined;
  }

  async function shareFromUi(
    page: import("@playwright/test").Page,
  ): Promise<{ syncUrl: string; room: string }> {
    await page.goto("/?seed=einstein");
    await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await page.getByTestId("share-button").click();
    const linkInput = page.getByTestId("share-link");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    const shareUrl = new URL(await linkInput.inputValue());
    const room = decodeURIComponent(shareUrl.pathname.split("/").pop() ?? "");
    const syncUrl = shareUrl.searchParams.get("sync") ?? `ws://${shareUrl.hostname}:1234`;
    // Close the share popover so its topbar overlay doesn't sit over the review pane.
    await page.keyboard.press("Escape");
    await expect(linkInput).toHaveCount(0, { timeout: 30_000 });
    return { syncUrl, room };
  }

  // A 64-hex sha256 stand-in for a content-addressed blob pointer.
  const FAKE_HASH = "a".repeat(64);

  // 1. A MULTI-OP file proposal: a text create + edit + a `create-binary` (the new
  //    "Add image · mime · size" pointer summary). A multi-op set renders as the
  //    single inline McpFileProposals card (one atomic Accept-all).
  for (const theme of ["light", "dark"] as const) {
    test(`capture: mcp file proposal with binary (${theme})`, async ({ page }) => {
      const { syncUrl, room } = await shareFromUi(page);
      const peer = joinAsNodePeer(syncUrl, room);
      try {
        await expect
          .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
          .toContain("Annus Mirabilis");
        const main = mainFileText(peer.project)!;
        const proposedMain = `${main.text}\n#image("figures/diagram.png")\n`;
        await publishFileProposal(
          peer.project,
          {
            request: "Add a diagram and reference it",
            // The `create-binary` op is FIRST so its "Add image · mime · size"
            // pointer summary sits at the top of the (internally scrollable) pane
            // and reads in the shot; a text edit follows to show the multi-op set.
            ops: [
              {
                kind: "create-binary",
                path: "/figures/diagram.png",
                baseText: "",
                proposedText: "",
                blocks: [],
                binaryAsset: { type: "binary", hash: FAKE_HASH, size: 48_213, mime: "image/png" },
              },
              {
                kind: "edit",
                path: main.path,
                baseText: main.text,
                proposedText: proposedMain,
                blocks: [{ search: main.text, replace: proposedMain }],
              },
            ],
          },
          MCP_AUTHOR,
        );
        // The pending-review pane auto-opens on the empty→pending edge (editors).
        const binary = page.getByTestId("file-proposal-op-binary");
        await expect(binary).toBeVisible({ timeout: 30_000 });
        await binary.scrollIntoViewIfNeeded();
        await setTheme(page, theme);
        await freeze(page);
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${SHOTS}/mcp-file-proposal-binary-${theme}.png`,
          fullPage: true,
        });
      } finally {
        peer.destroy();
      }
    });
  }

  // 2. A propose-only RESTORE proposal — a `propose_files` set titled `Restore to "…"`
  //    bundling many create / edit / delete ops (what a version-restore proposes).
  for (const theme of ["light", "dark"] as const) {
    test(`capture: mcp restore-version proposal (${theme})`, async ({ page }) => {
      const { syncUrl, room } = await shareFromUi(page);
      const peer = joinAsNodePeer(syncUrl, room);
      try {
        await expect
          .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
          .toContain("Annus Mirabilis");
        const main = mainFileText(peer.project)!;
        // Seed two files the restore would touch (an edit target + a delete target).
        peer.project.create("/chapters/old.typ", "= Old draft\nStale prose.\n", MCP_AUTHOR);
        peer.project.create("/scratch.typ", "throwaway\n", MCP_AUTHOR);
        await expect
          .poll(
            () => peer.project.snapshot().files.some((f) => !f.deleted && f.path === "/scratch.typ"),
            { timeout: 30_000 },
          )
          .toBe(true);
        const restoredMain = `${main.text}\n// restored to v3\n`;
        await publishFileProposal(
          peer.project,
          {
            request: 'Restore to "Draft v3 — before the rewrite"',
            ops: [
              {
                kind: "edit",
                path: main.path,
                baseText: main.text,
                proposedText: restoredMain,
                blocks: [{ search: main.text, replace: restoredMain }],
              },
              {
                kind: "create",
                path: "/chapters/method.typ",
                baseText: "",
                proposedText: "= Method\n\nRestored chapter body.\n",
                blocks: [],
              },
              {
                kind: "edit",
                path: "/chapters/old.typ",
                baseText: "= Old draft\nStale prose.\n",
                proposedText: "= Old draft\nRestored prose.\n",
                blocks: [{ search: "Stale prose.", replace: "Restored prose." }],
              },
              {
                kind: "delete",
                path: "/scratch.typ",
                baseText: "",
                proposedText: "",
                blocks: [],
              },
            ],
          },
          MCP_AUTHOR,
        );
        // The pending-review pane auto-opens on the empty→pending edge (editors).
        await expect(page.getByTestId("mcp-file-proposal")).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("file-proposal-op")).toHaveCount(4);
        await setTheme(page, theme);
        await freeze(page);
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${SHOTS}/mcp-restore-proposal-${theme}.png`,
          fullPage: true,
        });
      } finally {
        peer.destroy();
      }
    });
  }

  // 3. The RUN REVIEW CARD — a multi-record run (Accept-all / Reject-all / expand,
  //    plus the ✓ signed / ⚠ unverified provenance chip), captured collapsed AND
  //    expanded (so the per-record diff bodies show).
  async function seedRun(
    peer: ReturnType<typeof joinAsNodePeer>,
    runId: string,
    main: { path: string; text: string },
  ): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const marker = `RUN_${runId}_${i}`;
      const proposedText = `${main.text}\n${marker}\n`;
      await publishProposal(
        peer.project,
        {
          filePath: main.path,
          baseText: main.text,
          proposedText,
          blocks: [{ search: main.text, replace: proposedText }],
          request: `Tighten section ${i + 1}`,
          runId,
        },
        MCP_AUTHOR,
      );
    }
  }

  for (const theme of ["light", "dark"] as const) {
    test(`capture: run review card collapsed (${theme})`, async ({ page }) => {
      const { syncUrl, room } = await shareFromUi(page);
      const peer = joinAsNodePeer(syncUrl, room);
      try {
        await expect
          .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
          .toContain("Annus Mirabilis");
        const main = mainFileText(peer.project)!;
        await seedRun(peer, `run-${Date.now()}`, main);
        // The pending-review pane auto-opens on the empty→pending edge (editors).
        const card = page.getByTestId("run-review-card");
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        await expect(card.getByTestId("run-review-count")).toHaveText(/3 changes/);
        await setTheme(page, theme);
        await freeze(page);
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${SHOTS}/run-review-collapsed-${theme}.png`,
          fullPage: true,
        });
      } finally {
        peer.destroy();
      }
    });

    test(`capture: run review card expanded (${theme})`, async ({ page }) => {
      const { syncUrl, room } = await shareFromUi(page);
      const peer = joinAsNodePeer(syncUrl, room);
      try {
        await expect
          .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
          .toContain("Annus Mirabilis");
        const main = mainFileText(peer.project)!;
        await seedRun(peer, `run-${Date.now()}`, main);
        // The pending-review pane auto-opens on the empty→pending edge (editors).
        const card = page.getByTestId("run-review-card");
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        await card.getByTestId("run-review-expand").click();
        await expect(card.getByTestId("run-review-detail")).toBeVisible();
        await setTheme(page, theme);
        await freeze(page);
        await page.waitForTimeout(150);
        await page.screenshot({
          path: `${SHOTS}/run-review-expanded-${theme}.png`,
          fullPage: true,
        });
      } finally {
        peer.destroy();
      }
    });
  }

  // 3b. A STILL-STREAMING run: Accept-all is DISABLED ("run in progress…") and the
  //     streaming note shows — the A2 disabled-state surface (light is enough).
  test("capture: run review card streaming (light)", async ({ page }) => {
    const { syncUrl, room } = await shareFromUi(page);
    const peer = joinAsNodePeer(syncUrl, room);
    try {
      await expect
        .poll(() => mainFileText(peer.project)?.text ?? "", { timeout: 30_000 })
        .toContain("Annus Mirabilis");
      const main = mainFileText(peer.project)!;
      const runId = `run-stream-${Date.now()}`;
      markRunOpen(peer.project, runId, Date.now());
      await seedRun(peer, runId, main);
      // The pending-review pane auto-opens on the empty→pending edge (editors).
      const card = page.getByTestId("run-review-card");
      await expect(card).toHaveCount(1, { timeout: 30_000 });
      await expect(card.getByTestId("run-accept-all")).toBeDisabled();
      await expect(card.getByTestId("run-review-streaming")).toBeVisible();
      await freeze(page);
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/run-review-streaming.png`, fullPage: true });
    } finally {
      peer.destroy();
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────
// The unified per-project ASK/AUTO Agent Access panel (ADR-0025 §1) — the in-app
// agent's accept-mode control, mounted in the agent sidebar. Captured in the AUTO
// state so the ⚡ caption + kill-switch show.
// ──────────────────────────────────────────────────────────────────────────
for (const theme of ["light", "dark"] as const) {
  test(`capture: agent access panel auto (${theme})`, async ({ page }) => {
    await gotoEditor(page);
    await settle(page);
    await setTheme(page, theme);
    const panel = page.getByTestId("agent-access-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByTestId("agent-mode-auto").click();
    await expect(panel.getByTestId("agent-auto-killswitch")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/agent-access-panel-auto-${theme}.png`, fullPage: true });
  });
}

// Comments Phase A: the source-anchored thread card (open thread with a reply +
// the Resolve toggle) and the cross-file overview popover, both captured in light
// and dark so the accent highlight + the card's glass language can be reviewed.
for (const theme of ["light", "dark"] as const) {
  test(`capture: comment thread card (${theme})`, async ({ page }) => {
    await gotoEditor(page, { id: `comment-cap-${theme}` });
    await settle(page);
    await setTheme(page, theme);
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await editor.click();
    await editor.getByText("writing", { exact: false }).first().dblclick();
    await expect(page.getByTestId("comment-add")).toBeVisible();
    // Transient-storage context pins a bottom banner that intercepts the bubble.
    const dismissT = page.getByTestId("transient-storage-dismiss");
    if (await dismissT.isVisible().catch(() => false)) await dismissT.click();
    await page.getByTestId("comment-add").click();
    await page.getByTestId("comment-create-input").fill("Is this the final title?");
    await page.getByTestId("comment-create-submit").click();
    await page.locator(".cm-comment-gutter-marker").click();
    await expect(page.getByTestId("comment-thread-card")).toBeVisible();
    await page.getByTestId("comment-reply-input").fill("Yes — locking it in.");
    await page.getByTestId("comment-reply-submit").click();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/comment-thread-card-${theme}.png`, fullPage: true });
  });

  test(`capture: comments overview (${theme})`, async ({ page }) => {
    await gotoEditor(page, { id: `comment-overview-cap-${theme}` });
    await settle(page);
    await setTheme(page, theme);
    const editor = page.locator('[data-testid="editor"] .cm-content');
    await editor.click();
    await editor.getByText("writing", { exact: false }).first().dblclick();
    await expect(page.getByTestId("comment-add")).toBeVisible();
    // Transient-storage context pins a bottom banner that intercepts the bubble.
    const dismissT = page.getByTestId("transient-storage-dismiss");
    if (await dismissT.isVisible().catch(() => false)) await dismissT.click();
    await page.getByTestId("comment-add").click();
    await page.getByTestId("comment-create-input").fill("Pick a stronger title.");
    await page.getByTestId("comment-create-submit").click();
    await page.getByTestId("comments-toggle").click();
    await expect(page.getByTestId("comments-overview")).toBeVisible();
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/comments-overview-${theme}.png`, fullPage: true });
  });
}

/**
 * The marketing money-shot (styles Phase 1.5): the SAME Einstein "Annus
 * Mirabilis" manuscript restyled three ways, one click each, content untouched.
 * Captures the preview pane (the cover is the most striking transform) for
 * Academic (the demo's bespoke default) → Modern → Minimal. Light theme only.
 */
test("capture: Einstein desk restyled (academic → modern → minimal)", async ({ page }) => {
  async function applyStyle(name: string) {
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByTestId("command-palette-input").fill("Change style");
    await page.getByTestId("command-palette-item").first().click();
    await expect(page.getByTestId("style-library")).toBeVisible();
    await page.getByTestId("style-card").filter({ hasText: name }).click();
    await page.getByTestId("style-apply").click();
    await expect(page.getByTestId("style-library")).toHaveCount(0);
    await settle(page);
  }

  await page.goto("/?seed=einstein");
  await settle(page);
  const preview = page.getByTestId("preview");
  await freeze(page);
  await page.waitForTimeout(200);
  await preview.screenshot({ path: `${SHOTS}/einstein-academic.png` });

  await applyStyle("Modern");
  await freeze(page);
  await page.waitForTimeout(200);
  await preview.screenshot({ path: `${SHOTS}/einstein-modern.png` });

  await applyStyle("Minimal");
  await freeze(page);
  await page.waitForTimeout(200);
  await preview.screenshot({ path: `${SHOTS}/einstein-minimal.png` });
});

// #7 7D binary assets: the files pane holding an uploaded image row (with its
// hover ops + the "Upload asset…" affordance), and the preview modal showing
// that image. A real 1×1 PNG so the preview renders a raster <img>.
const CAPTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
for (const theme of ["light", "dark"] as const) {
  test(`capture: files pane with an image + preview (${theme})`, async ({ page }) => {
    await gotoEditor(page, { id: `capture-binary-${theme}` });
    await settle(page);
    await openFilesDock(page);
    await page.getByTestId("upload-binary-input").setInputFiles({
      name: "diagram.png",
      mimeType: "image/png",
      buffer: CAPTURE_PNG,
    });
    await expect(
      page.locator('[data-testid="project-binary-file"][data-path="/diagram.png"]'),
    ).toBeVisible({ timeout: 30_000 });

    await setTheme(page, theme);
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/files-pane-with-image-${theme}.png`, fullPage: true });

    // Open the preview modal and capture it.
    await page.locator('[data-testid="project-binary-file"][data-path="/diagram.png"]').click();
    await expect(page.getByTestId("binary-preview")).toBeVisible({ timeout: 30_000 });
    await freeze(page);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/binary-preview-${theme}.png`, fullPage: true });
  });
}
