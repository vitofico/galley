import { test, expect } from "@playwright/test";
import { gotoEditor } from "./app-helpers.js";
import {
  installGitSmartHttpFixture,
  FAKE_GIT_REPO_URL,
} from "./helpers/git-smart-http-fixture";

/**
 * #17.2 / ADR-0019 — LIVE in-browser git push + fetch RUNTIME CONTRACT PROBE.
 *
 * The wiring e2e (git-sync.spec.ts) only proves the panel surface; this spec
 * exercises the REAL transport end-to-end at browser runtime — ProjectApp →
 * push/fetchGitRemote → `@galley/persistence/browser` HttpRemoteSync
 * (in-memory git fs + isomorphic-git) — against a route-intercepted fake
 * smart-HTTP remote (helpers/git-smart-http-fixture.ts). Deterministic and
 * fully offline: every request to the fake origin is intercepted; nothing
 * egresses.
 *
 * ## History: the Buffer gap (wave-11, FIXED in the same wave)
 * As first landed, this probe PINNED a real runtime gap: isomorphic-git@1.38.4's
 * ESM build references the bare Node `Buffer` global (~76 sites — StreamReader's
 * advertisement parser guard, `_writeObject`'s `Buffer.from(...)`, the pack
 * builder) and the Vite bundle provided no polyfill, so push/fetch died at
 * browser runtime (`Buffer is not defined`) before any receive-pack traffic,
 * while every node unit test stayed green. The fix (Architect-ruled):
 * `packages/persistence/src/browser-buffer.ts` installs the standard feross
 * `buffer` shim as the global iff absent, imported FIRST from the
 * `@galley/persistence/browser` barrel. This spec now asserts the TARGET
 * contract — a working push (real pack on the receive-pack wire) and a working
 * fetch — and any regression of the bootstrap fails it loudly.
 */

const TOKEN_SENTINEL = "ghp_LIVEPROBE_SENTINEL_NEVER_ON_WIRE_0001";

test("#17.2 live probe: in-browser push reaches the receive-pack wire with a real pack", async ({
  page,
}) => {
  // Capture page/console errors from the very start (wave-10 pattern): any
  // runtime failure must surface as a CAUGHT, panel-reported error — and with
  // the Buffer bootstrap in place there must be none at all.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  // The fake remote must be routed BEFORE any git traffic can fire.
  const remote = await installGitSmartHttpFixture(page, { branch: "main" });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  // Configure the intercepted remote through the real panel (no hand-poked
  // storage): destination chooser → "Other git host" → URL/branch/token form.
  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();
  await page.getByTestId("git-dest-generic").click();
  await page.getByTestId("git-sync-url").fill(FAKE_GIT_REPO_URL);
  await page.getByTestId("git-sync-ref").fill("main");
  await page.getByTestId("git-sync-token").fill(TOKEN_SENTINEL);
  await page.getByTestId("git-sync-save").click();
  // Saved → the configured card with the live Push / Fetch actions.
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();

  // Push — the REAL runtime path: materialize → HttpRemoteSync.pushTree over the
  // in-memory git fs + isomorphic-git, egressing only to the intercepted remote.
  await page.getByTestId("git-sync-push").click();
  const status = page.getByTestId("git-sync-status");
  await expect(status).toHaveAttribute("data-ok", /true|false/, { timeout: 30_000 });

  // Diagnostics for the report/trace — visible in the runner output on failure.
  const statusText = await status.textContent();
  console.log(`[git-probe] panel status: ok=${await status.getAttribute("data-ok")} text=${JSON.stringify(statusText)}`);
  console.log(`[git-probe] remote trace: ${JSON.stringify(remote.shortLines())}`);
  console.log(`[git-probe] pageErrors: ${JSON.stringify(pageErrors)}`);

  // --- TARGET CONTRACT (the Buffer bootstrap makes the real push work) -------
  await expect(status).toHaveAttribute("data-ok", "true");
  await expect(status).toHaveText(/Pushed\. Commit [0-9a-f]{10}\./);
  // The transport discovered the receive-pack service…
  expect(remote.shortLines()).toContain(
    "GET /galley/probe.git/info/refs?service=git-receive-pack",
  );
  // …and exactly one POST carried pkt-lines + a real PACK (non-trivial bytes).
  expect(remote.receivePackBodies.length).toBe(1);
  const pack = remote.receivePackBodies[0]!;
  expect(pack.byteLength).toBeGreaterThan(100);
  expect(new TextDecoder().decode(pack)).toContain("PACK");
  // ---------------------------------------------------------------------------

  // Fail-closed, both ways: nothing un-modelled reached the fake host, and the
  // page saw no runtime errors (a Buffer regression would land here loudly).
  expect(remote.unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);

  // The LITERAL token never appears on the wire or in the DOM. (HTTP Basic
  // credentials to the configured remote are base64 — expected and correct;
  // the raw sentinel must never leak as-is anywhere.)
  const decoder = new TextDecoder();
  for (const r of remote.requests) {
    expect(r.url).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(r.headers)).not.toContain(TOKEN_SENTINEL);
    if (r.body) expect(decoder.decode(r.body)).not.toContain(TOKEN_SENTINEL);
  }
  await expect(page.locator("body")).not.toContainText(TOKEN_SENTINEL);
});

test("#17.2 live probe: in-browser fetch parses the advertisement (empty remote → calm nothing-to-import)", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  const remote = await installGitSmartHttpFixture(page, { branch: "main" });

  await gotoEditor(page);
  await expect(page.getByTestId("status")).toHaveText(/page\(s\)/, { timeout: 60_000 });

  await page.getByTestId("git-sync-button").click();
  await expect(page.getByTestId("git-sync-panel")).toBeVisible();
  await page.getByTestId("git-dest-generic").click();
  await page.getByTestId("git-sync-url").fill(FAKE_GIT_REPO_URL);
  await page.getByTestId("git-sync-ref").fill("main");
  await page.getByTestId("git-sync-save").click();
  await expect(page.getByTestId("git-dest-configured")).toBeVisible();

  // Fetch against the (empty) intercepted remote: the upload-pack advertisement
  // must PARSE (StreamReader's Buffer guard was the first casualty of the gap)
  // and the absent ref must surface as the calm, Accept-gated-import "nothing
  // to import" status — ok, not an error.
  await page.getByTestId("git-sync-fetch").click();
  const status = page.getByTestId("git-sync-status");
  await expect(status).toHaveAttribute("data-ok", /true|false/, { timeout: 30_000 });

  console.log(`[git-probe] fetch status: ok=${await status.getAttribute("data-ok")} text=${JSON.stringify(await status.textContent())}`);
  console.log(`[git-probe] remote trace: ${JSON.stringify(remote.shortLines())}`);

  await expect(status).toHaveAttribute("data-ok", "true");
  await expect(status).toHaveText(/Nothing to import — the remote ref is empty\./);
  expect(remote.shortLines()).toContain(
    "GET /galley/probe.git/info/refs?service=git-upload-pack",
  );
  expect(remote.unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
});
