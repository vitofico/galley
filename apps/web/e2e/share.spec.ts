import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import { openFilesDock } from "./files-dock.js";

/**
 * #14-C acceptance e2e — the last #14 exit criterion (#4): a user opens a
 * collaborative session from the project UI WITHOUT hand-editing the URL.
 *
 * Browser A boots the DEFAULT route (a local-first persistent project, NOT
 * connected), clicks "Share", and gets a join link. Browser B opens that link and
 * lands in the same room: both see presence ("2 editor(s)"), an edit in A appears
 * in B through the real `apps/sync` relay, and cross-peer attribution paints two
 * distinct authors. Collaboration is an explicit action — A starts non-connected.
 */
test("Share opens a live collaborative session from the UI (no hand-edited URL)", async ({
  browser,
}) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const a = await ctxA.newPage();

    // A boots the default route → a persistent local project. NOT collaborative yet.
    await gotoEditor(a);
    await expect(a.getByTestId("open-library")).toBeVisible();
    await expect(a.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });
    await expect(a.getByTestId("share-button")).toHaveText("Share");
    await expect(a.getByTestId("presence")).toHaveCount(0);
    await expect(a.getByTestId("collab-indicator")).toHaveCount(0);

    // Click Share → the popover opens with a join link (#19.3: the share UI
    // lives in the Share button's popover; built internally, never hand-edited).
    // #19.4: the link is the clean `/join/<room>` path (spec §5).
    await a.getByTestId("share-button").click();
    const linkInput = a.getByTestId("share-link");
    await expect(linkInput).toBeVisible({ timeout: 30_000 });
    const shareUrl = await linkInput.inputValue();
    expect(new URL(shareUrl).pathname).toMatch(/^\/join\/share-/);
    // A is now collaborative.
    await expect(a.getByTestId("collab-indicator")).toBeVisible();
    await expect(a.getByTestId("share-button")).toHaveText("Shared");

    // BUG-2 regression guard: the OWNER stays a full editor the INSTANT Share
    // connects — no read-only flash, no reload needed. Before the fix, merely
    // having a connection made the session role fall back to the fail-closed
    // `?role=` parse (the owner's `/p/<id>` URL has none) → the host wrongly
    // rendered read-only ("joined as a viewer") until a refresh dropped the
    // connection. The connection (established as `editor`) is now the source of
    // truth, so the agent pane shows NO viewer note and the editor still accepts
    // input for the host.
    await expect(a.getByTestId("agent-readonly-hint")).toHaveCount(0);
    await expect(a.getByTestId("share-peers")).not.toContainText("Viewer", {
      timeout: 30_000,
    });

    // B opens the very link A produced → is asked ONCE for a display name
    // (#19.4 spec §7; skippable), then joins the same room under that name.
    const b = await ctxB.newPage();
    await b.goto(shareUrl);
    await expect(b.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await b.getByTestId("join-name-input").fill("Bobbie");
    await b.getByTestId("join-name-submit").click();
    await expect(b.getByTestId("open-library")).toBeVisible();

    // The joiner's "Syncing…" cue (#14-C) is non-blocking and must CLEAR once the
    // room's state has landed — never get stuck. (It may flash too briefly to catch
    // reliably; asserting it ends gone is the deterministic, no-stuck contract.)
    await expect(b.getByTestId("join-syncing")).toHaveCount(0, { timeout: 30_000 });

    // Both peers see each other through the live sync server. #19.3: presence
    // lives in the Share popover — A's is already open from the click above;
    // B (a joiner) opens their own ("Shared" trigger) to see who's in the room.
    await b.getByTestId("share-button").click();
    await expect(a.getByTestId("presence")).toHaveText(/2 editor/, { timeout: 30_000 });
    await expect(b.getByTestId("presence")).toHaveText(/2 editor/, { timeout: 30_000 });

    // C2 old-path pin: a HEALTHY live link shows NO "Reconnecting…" banner — the
    // cue is purely additive to the drop/recover case (first connect stays silent).
    await expect(a.getByTestId("link-status-banner")).toHaveCount(0);
    await expect(b.getByTestId("link-status-banner")).toHaveCount(0);

    // #19.4 spec §7: the room roster lists peers BY NAME — B's chosen display
    // name shows on BOTH sides (it travels with B's presence/author identity),
    // and A (who never set a name) stays the anonymous "Editor".
    await expect(a.getByTestId("share-peers")).toContainText("Bobbie", { timeout: 30_000 });
    await expect(b.getByTestId("share-peers")).toContainText("Bobbie");
    await expect(a.getByTestId("share-peers")).toContainText("Editor");

    // L7: each side marks its OWN row "(you)" so the local client is
    // distinguishable from peers (two identical "Editor" rows would otherwise be
    // ambiguous). Exactly one row per roster is local; on B's side it is Bobbie.
    await expect(a.getByTestId("share-peer-you")).toHaveCount(1);
    await expect(b.getByTestId("share-peer-you")).toHaveCount(1);
    await expect(
      b.locator('.share-peer:has([data-testid="share-peer-you"])'),
    ).toContainText("Bobbie");

    // An edit in A's active file propagates to B's editor (CRDT over the relay).
    // Type at the document END and scroll B there: the demo main.typ (#20.2) is
    // taller than the editor viewport and CodeMirror renders only visible lines,
    // so the assert must look where the edit actually landed.
    const marker = `SHARED_FROM_A_${Date.now()}`;
    const editorA = a.locator('[data-testid="editor"] .cm-content');
    await editorA.click();
    await a.keyboard.press("ControlOrMeta+End");
    await a.keyboard.type(marker);
    const editorB = b.locator('[data-testid="editor"] .cm-content');
    await editorB.click();
    await b.keyboard.press("ControlOrMeta+End");
    await expect(editorB).toContainText(marker, { timeout: 30_000 });

    // B contributes its own text so two distinct authors exist in the doc.
    const markerB = `SHARED_FROM_B_${Date.now()}`;
    await editorB.click();
    await b.keyboard.press("ControlOrMeta+End");
    await b.keyboard.type(markerB);
    await editorA.click();
    await a.keyboard.press("ControlOrMeta+End");
    await expect(editorA).toContainText(markerB, { timeout: 30_000 });

    // Cross-peer attribution renders in the project editor: B paints ≥2 distinct
    // author ids (A's spans + B's spans, each carrying its originating clientID).
    await expect(b.locator(".cm-attribution").first()).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          new Set(
            await b
              .locator(".cm-attribution")
              .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.authorId)),
          ).size,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(2);

    // B18 — unshare: A (the owning host) stops sharing. The popover's Stop-sharing
    // button closes the live connection and reverts A to LOCAL-only editing.
    // M6: the action is now confirm-guarded — accept the dialog to proceed.
    await a.getByTestId("share-button").click();
    a.once("dialog", (d) => void d.accept());
    await a.getByTestId("unshare-button").click();
    // The trigger reverts to "Share" and the collab chip disappears: A is local again.
    await expect(a.getByTestId("share-button")).toHaveText("Share", { timeout: 30_000 });
    await expect(a.getByTestId("collab-indicator")).toHaveCount(0);

    // A's further edits no longer reach B (they have drifted apart). Type a fresh
    // marker in A and assert it NEVER lands in B within a bounded window.
    const drift = `DRIFT_AFTER_UNSHARE_${Date.now()}`;
    await editorA.click();
    await a.keyboard.press("ControlOrMeta+End");
    await a.keyboard.type(drift);
    await expect(editorA).toContainText(drift, { timeout: 30_000 });
    await b.waitForTimeout(2_000);
    await expect(editorB).not.toContainText(drift);

    // Clicking Share again mints a BRAND-NEW room (a fresh capability), never the
    // previous one — so the old link is dead and access is re-gated.
    await a.getByTestId("share-button").click();
    const linkInput2 = a.getByTestId("share-link");
    await expect(linkInput2).toBeVisible({ timeout: 30_000 });
    const shareUrl2 = await linkInput2.inputValue();
    expect(new URL(shareUrl2).pathname).toMatch(/^\/join\/share-/);
    expect(shareUrl2).not.toEqual(shareUrl);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

/**
 * B19-sharing-roles — a viewer link is read-only, an editor link is full-access.
 *
 * The host (A) builds a VIEWER link and an EDITOR link from the same room (the
 * role chooser only changes the encoded `?role=`). A viewer browser joins the
 * viewer link → its file-ops UI is gone and it cannot create files. An editor
 * browser joins the editor link → full file-ops work. Both appear in presence.
 */
test("Share roles: a viewer link is read-only, an editor link can edit", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxV = await browser.newContext();
  const ctxE = await browser.newContext();
  try {
    const a = await ctxA.newPage();
    await gotoEditor(a);
    await expect(a.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

    // Host shares; the popover exposes the role chooser. Pick "View only" → the
    // displayed link encodes ?role=viewer.
    await a.getByTestId("share-button").click();
    await expect(a.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
    await a.getByTestId("share-role-viewer").check();
    const viewerUrl = await a.getByTestId("share-link").inputValue();
    expect(new URL(viewerUrl).searchParams.get("role")).toBe("viewer");

    // Switch back to "Edit" → the same room, but the link now carries an EXPLICIT
    // `role=editor`. (SEC fix: the join parser fails closed to `viewer` on an
    // absent role, so an editor invite must say so — an implicit/no-role link
    // would be downgraded to read-only.)
    await a.getByTestId("share-role-editor").check();
    const editorUrl = await a.getByTestId("share-link").inputValue();
    expect(new URL(editorUrl).searchParams.get("role")).toBe("editor");
    // Same room — only the role differs.
    expect(new URL(viewerUrl).pathname).toEqual(new URL(editorUrl).pathname);

    // A VIEWER joins the viewer link: it sees the project but has NO file-ops.
    const v = await ctxV.newPage();
    await v.goto(viewerUrl);
    // A fresh context always gets the one-time name prompt (JoinRoot decides this
    // synchronously from the empty local profile). AWAIT it rather than snapshot
    // `isVisible()` — the snapshot races React's post-load mount, and a miss
    // would leave the modal up so `open-library` never renders (flaky timeout).
    await expect(v.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await v.getByTestId("join-name-submit").click();
    await expect(v.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });
    await openFilesDock(v);
    // Wait for the shared content to arrive so the file tree is populated.
    await expect(v.getByTestId("project-file").first()).toBeVisible({ timeout: 30_000 });
    // Read-only enforcement: the new-file form and per-file ops are gone.
    await expect(v.getByTestId("new-file-path")).toHaveCount(0);
    await expect(v.getByTestId("add-file")).toHaveCount(0);
    await expect(v.getByTestId("delete-file")).toHaveCount(0);

    // SEC (B19): the ungated programmatic write paths are now CLOSED for a viewer
    // — the affordances are gone AND the handlers fail closed. The agent panel
    // (which carries the Accept that lands an agent edit) is replaced by a
    // read-only note. Assert on COUNT (not visibility) so a collapsed sidebar
    // doesn't make this flaky: the hint is mounted, the agent panel is not.
    await expect(v.getByTestId("agent-readonly-hint")).toHaveCount(1, { timeout: 30_000 });
    await expect(v.getByTestId("agent-panel")).toHaveCount(0);
    // The editor refuses typed input (already read-only).
    const vMarker = `VIEWER_TYPED_${Date.now()}`;
    const vEditor = v.locator('[data-testid="editor"] .cm-content');
    await vEditor.click();
    await v.keyboard.type(vMarker);
    await expect(vEditor).not.toContainText(vMarker);

    // The ⌘K palette hides every MUTATING command for a viewer: applying a
    // template, importing, adding a citation, project instructions, and inserting
    // a reference are all absent (the registry won't list/run them).
    await v.keyboard.press("ControlOrMeta+k");
    await expect(v.getByTestId("command-palette")).toBeVisible({ timeout: 30_000 });
    const palette = v.getByTestId("command-palette");
    await expect(palette).not.toContainText("New from template");
    await expect(palette).not.toContainText("Add a citation");
    await expect(palette).not.toContainText("Import (Markdown / LaTeX → Typst)");
    await expect(palette).not.toContainText("Project instructions");
    // A read-only action (toggling the theme) is STILL available — viewers can
    // still navigate and read.
    await expect(palette).toContainText("Toggle dark mode");
    await v.keyboard.press("Escape");

    // An EDITOR joins the editor link: full file-ops are present.
    const e = await ctxE.newPage();
    await e.goto(editorUrl);
    // Same fresh-context name prompt — await it (see the viewer note above).
    await expect(e.getByTestId("join-name-prompt")).toBeVisible({ timeout: 30_000 });
    await e.getByTestId("join-name-submit").click();
    await expect(e.getByTestId("open-library")).toBeVisible({ timeout: 30_000 });
    await openFilesDock(e);
    await expect(e.getByTestId("new-file-path")).toBeVisible({ timeout: 30_000 });
    await expect(e.getByTestId("add-file")).toBeVisible();
  } finally {
    await ctxA.close();
    await ctxV.close();
    await ctxE.close();
  }
});

// C2 note: a live-drop e2e (Playwright `context.setOffline`) was tried but is
// unreliable — `setOffline` blocks NEW connections without severing an already
// -open WebSocket, so no `onStatus("disconnected")` fires and the "Reconnecting…"
// banner never appears within a bounded wait. The phase machine itself is proven
// deterministically in link-status.test.ts; the healthy-link old-path pin above
// (no banner on a live session) guards the wiring's silent path.

/**
 * M6 — stop-sharing is confirm-guarded. Cancelling the confirm leaves the live
 * session intact (the destructive teardown only runs on accept); the accept
 * path is covered by the unshare step of the main flow above.
 */
test("M6: cancelling the Stop-sharing confirm keeps the session live", async ({ page }) => {
  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Share, then wait for the link (past H8's Connecting… gate).
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("share-link")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("share-button")).toHaveText("Shared");

  // Attempt to stop sharing, but DISMISS the confirm → nothing happens.
  page.once("dialog", (d) => void d.dismiss());
  await page.getByTestId("unshare-button").click();

  // Still shared: the trigger stays "Shared" and the collab chip remains.
  await expect(page.getByTestId("share-button")).toHaveText("Shared");
  await expect(page.getByTestId("collab-indicator")).toBeVisible();
});
