import { test, expect, type Page } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * Comments Phase A end-to-end: the full source-anchored thread lifecycle through
 * the REAL project shell. Select text → a floating "Comment" bubble → a new thread
 * → an accent highlight + an interactive gutter marker appear in the editor → reply
 * → resolve (the highlight clears) → reopen from the cross-file overview. Then a
 * second test proves a comment authored in a NON-open file surfaces in the overview
 * and focus-jumps to it.
 *
 * Anchors decode through the CRDT (`resolveThreadRange`) so the assertions read the
 * EDITOR DOM (`.cm-comment-highlight` / `.cm-comment-gutter-marker`), never the
 * preview SVG. Risk #7: a keyboard sub-range select is finicky under Playwright in
 * CodeMirror, so the selection is made with a double-click word-select (stable) and
 * verified non-empty (the bubble exists) before the create flow is driven.
 */

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
  // Playwright's context is transient storage, so the one-time "may not keep your
  // work" info banner pins itself to the bottom of the shell — it intercepts the
  // floating "Comment" bubble's pointer. Dismiss it if present (idempotent).
  const dismiss = page.getByTestId("transient-storage-dismiss");
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

/** Select the word `word` in the editor by double-clicking it (a stable sub-range
 *  selection — keyboard Shift+Arrow is flaky in CM under Playwright). Returns once
 *  the create bubble has floated, proving the selection registered. */
async function selectWord(page: Page, word: string): Promise<void> {
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  // Scope the word match to the EDITOR content (the same text also renders in the
  // preview SVG; we must double-click the editable copy).
  await editor.getByText(word, { exact: false }).first().dblclick();
  // The bubble only floats for a NON-EMPTY selection — its presence is the proof
  // the sub-range actually registered (risk #7).
  await expect(page.getByTestId("comment-add")).toBeVisible();
}

/** Drive the create flow from a live selection to a committed thread. */
async function createThread(page: Page, body: string): Promise<void> {
  await page.getByTestId("comment-add").click();
  const input = page.getByTestId("comment-create-input");
  await expect(input).toBeFocused();
  await input.fill(body);
  await page.getByTestId("comment-create-submit").click();
  await expect(page.getByTestId("comment-create")).toHaveCount(0);
}

test("source-anchored comment: create → highlight+gutter → reply → resolve → reopen", async ({
  page,
}) => {
  await gotoEditor(page, { id: "comments-lifecycle" });
  await waitReady(page);

  // Create a thread on the word "writing" in the starter body. (A body line, not
  // the line-1 heading, so the bubble floats clear of the topbar header.)
  await selectWord(page, "writing");
  await createThread(page, "Is this the final title?");

  // The thread paints an accent highlight AND an interactive gutter marker in the
  // editor (decoded from the CRDT anchor — NOT the preview).
  const highlight = page.locator(".cm-comment-highlight");
  const marker = page.locator(".cm-comment-gutter-marker");
  await expect(highlight).toHaveCount(1);
  await expect(marker).toHaveCount(1);

  // Clicking the gutter marker opens the thread card with the first message.
  await marker.click();
  const card = page.getByTestId("comment-thread-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Is this the final title?");

  // Reply appends a second message into the same thread.
  await page.getByTestId("comment-reply-input").fill("Yes — locking it.");
  await page.getByTestId("comment-reply-submit").click();
  await expect(card).toContainText("Yes — locking it.");

  // Resolve clears the in-editor highlight + gutter marker (resolved threads drop
  // out of the painted decorations).
  await page.getByTestId("comment-resolve").click();
  await expect(highlight).toHaveCount(0);
  await expect(marker).toHaveCount(0);

  // The thread isn't gone — it moves to the overview's Resolved filter, where it
  // can be reopened.
  await page.getByTestId("comments-toggle").click();
  await expect(page.getByTestId("comments-overview")).toBeVisible();
  await page.getByTestId("comments-filter-resolved").click();
  await page.getByTestId("comment-overview-item").first().click();

  // The card reopens (jumped from the overview); Reopen flips it back to open and
  // the highlight + gutter marker return.
  await expect(page.getByTestId("comment-thread-card")).toBeVisible();
  await page.getByTestId("comment-reopen").click();
  await expect(highlight).toHaveCount(1);
  await expect(marker).toHaveCount(1);
});

test("cross-file: a comment in a non-open file appears in the overview and focus-jumps", async ({
  page,
}) => {
  await gotoEditor(page, { id: "comments-xfile" });
  await waitReady(page);
  await openFilesDock(page);

  // Add a sibling file with its own prose, then comment a word in it.
  await page.getByTestId("new-file-path").fill("/notes.typ");
  await page.getByTestId("add-file").click();
  const editor = page.locator('[data-testid="editor"] .cm-content');
  await editor.click();
  // Lead with blank lines so the prose sits below line 1 — the create bubble floats
  // above the selection, and a line-1 anchor would collide with the topbar header.
  await page.keyboard.type("= Notes\n\nA sibling paragraph worth annotating.");

  await selectWord(page, "sibling");
  await createThread(page, "Define this term?");

  // Switch back to main — the sibling's comment is no longer painted here…
  await page.locator('[data-testid="project-file"][data-path="/main.typ"]').click();
  await expect(page.locator(".cm-comment-highlight")).toHaveCount(0);

  // …but it surfaces in the cross-file overview, attributed to its file. (The
  // anchored word is whatever the double-click landed on — the deterministic facts
  // are the file path and that exactly one comment exists.)
  await page.getByTestId("comments-toggle").click();
  await expect(page.getByTestId("comment-overview-item")).toHaveCount(1);
  const item = page.getByTestId("comment-overview-item").first();
  await expect(item).toContainText("/notes.typ");

  // Clicking it focus-jumps across the file switch: notes.typ reopens and the
  // thread card anchors there with its message.
  await item.click();
  await expect(page.getByTestId("comment-thread-card")).toContainText("Define this term?");
  await expect(page.locator(".cm-comment-highlight")).toHaveCount(1);
});
