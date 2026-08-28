import type { Page } from "@playwright/test";

/**
 * Navigate to a blank, reload-stable EDITOR.
 *
 * Since the Projects page became the landing surface, bare `/` no longer opens
 * an editor — it renders the project library. Specs that exercise the editor
 * boot through a stable `/p/<id>` route instead: a fresh id seeds the blank
 * starter, and because the id lives in the URL a reload returns to the same
 * project (the persistence the old `/` default-project resolution provided).
 *
 * Pass a per-test `id` when two tests in one file must not share a project; pass
 * `query` for editor config params (e.g. `serverCompile=1&compileUrl=…`). The
 * `?seed=einstein` showcase hatch is a separate entry — keep using `goto` for it.
 */
export async function gotoEditor(
  page: Page,
  opts: { id?: string; query?: string } = {},
): Promise<void> {
  // Every editor-booting spec runs on a FRESH context (no localStorage), which
  // is a genuine "first run" — so the one-time M3 coach overlay would render.
  // It is pointer-through (never intercepts a click), but seeding its dismissed
  // flag keeps it out of the ~244 existing flows entirely, exactly as
  // skipDemoSeed() suppresses the one-time Einstein demo. The onboarding spec
  // boots the editor via a raw goto instead, so it still exercises a fresh run.
  await suppressCoachOverlay(page);
  const id = opts.id ?? "e2e";
  const query = opts.query ? `?${opts.query.replace(/^\?/, "")}` : "";
  await page.goto(`/p/${encodeURIComponent(id)}${query}`);
}

/**
 * Pre-set the M3 coach-overlay "already dismissed" flag so the one-time first-run
 * overlay never renders. Installs an init script (runs before each page load), so
 * call it BEFORE navigating. `gotoEditor` calls it for you; a spec navigating to
 * the editor by a raw `page.goto` can call it directly.
 */
export async function suppressCoachOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("galley.onboarding.coachOverlay.v1", "dismissed");
    } catch {
      /* storage unavailable — nothing to suppress */
    }
  });
}

/**
 * Pre-set the "Einstein demo already seeded" flag so the Projects page does NOT
 * inject the one-time demo project. Use in tests that assert a controlled or
 * empty project library — call it BEFORE navigating (it installs an init script
 * that runs before each page load). Without it, a fresh context's first visit to
 * the Projects page seeds the Einstein demo card.
 */
export async function skipDemoSeed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("galley.einstein.seeded", "1");
    } catch {
      /* storage unavailable — nothing to skip */
    }
  });
}
