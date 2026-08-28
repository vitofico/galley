/**
 * Instantiate a project TEMPLATE into a live `CollabProject` (roadmap #2) — a
 * PURE, framework-agnostic helper (yjs only; no React/DOM/network), the sibling
 * of `restoreProjectFromTree` (project-session.ts): apply-as-CRDT-transaction,
 * never a destructive wipe.
 *
 * SEMANTICS (deliberately the simplest correct thing — ADR-0018):
 *
 *  - FRESH project (the common "new from template" case): if the doc is still
 *    pristine (no CRDT history), seed it cleanly via `seedIfPristine` — one
 *    transaction, files + main set atomically, future re-seeds suppressed by the
 *    same history gate that guards normal seeding. The template's `main` becomes
 *    the project's main.
 *
 *  - NON-EMPTY project (has history, or the pristine seed didn't fire): apply the
 *    template ADDITIVELY and NON-DESTRUCTIVELY. For each template file: if a LIVE
 *    file already holds that canonical path, minimal-diff its text to the
 *    template's (a metadata-/content-merge that preserves the file's `Y.Text`
 *    history + attribution); otherwise create it. Then re-point `main` by PATH.
 *    The user's pre-existing files that the template does NOT mention are LEFT
 *    UNTOUCHED by default — a template is additive, so (unlike a version RESTORE)
 *    we never soft-delete the files it omits, and we never hard-delete anything.
 *
 *  - REPLACE (`replace: true`, opt-in): a user-initiated "switch templates" wants
 *    the full file set REPLACED, not merged. In that mode the additive pass above
 *    still creates/updates the template's files, but live files NOT in the new
 *    template are SOFT-DELETED (`project.delete()` — never a CRDT destroy, so the
 *    history survives) inside the SAME outer transaction, so the switch lands
 *    atomically. The default stays `false`, so every existing caller (and the
 *    programmatic/import paths) keep the additive, non-destructive behavior.
 *
 * The additive path runs as ONE outer `doc.transact` tagged with `author` (the
 * local human peer): Yjs collapses the nested per-op transacts of `create` /
 * `transactFile` / `setMain` into this single transaction, so the whole template
 * lands as one atomic, single-author CRDT change. Paths are canonicalized to the
 * project's leading-slash form (matches the compiler + `CollabProject`).
 */
import { CollabProject, authorOrigin } from "@galley/collab";
import type { Author } from "@galley/shared";
import { applyMinimalDiff } from "./collab-session.js";

/** A project template: a flat set of files plus which one is `main`. */
export interface ProjectTemplate {
  files: { path: string; text: string }[];
  main: string;
}

/** Canonicalize a template path to the project's leading-slash form. */
function canonicalProjectPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Instantiate `template` into `project` as an explicit, non-destructive CRDT
 * transaction. See the file header for the exact fresh-vs-non-empty semantics.
 * An empty template (no files) is a no-op additively; under `replace` it clears
 * the project (soft-deletes all live files — the "Empty project" choice, B8).
 *
 * `replace` (default `false`) opts into REPLACE semantics on a non-empty project:
 * live files NOT in the new template are soft-deleted in the same transaction, so
 * a user-initiated template SWITCH replaces the full file set instead of merging.
 */
export function instantiateTemplate(
  project: CollabProject,
  template: ProjectTemplate,
  author: Author,
  replace = false,
): void {
  if (template.files.length === 0) {
    // EMPTY template (the "start from scratch" / blank entry, B8). Additively it
    // is a no-op (nothing to create). Under REPLACE, though, it means a clean
    // slate: soft-delete every live file so the picker's "Empty project" choice
    // actually empties the project (history preserved — never a hard destroy).
    if (replace) {
      const live = project.snapshot().files.filter((f) => !f.deleted);
      if (live.length > 0) {
        project.doc.transact(() => {
          for (const f of live) project.delete(f.fileId, author);
        }, authorOrigin(author));
      }
    }
    return;
  }

  // FRESH project: seed cleanly (one transaction; suppressed once it has history).
  // `seedIfPristine` returns non-null iff it actually seeded; if it declined
  // (the doc already has history), fall through to the additive path below. A
  // pristine seed already yields exactly the template's file set, so `replace`
  // has nothing extra to remove here.
  const seeded = project.seedIfPristine(template.files, template.main, author);
  if (seeded) return;

  // NON-EMPTY project: apply additively, in one author-tagged transaction.
  const live = project.snapshot().files.filter((f) => !f.deleted);
  const idByPath = new Map<string, string>();
  for (const f of live) if (!idByPath.has(f.path)) idByPath.set(f.path, f.fileId);

  // REPLACE: the set of canonical paths the new template keeps — any live file
  // outside it is soft-deleted below (inside the same transaction).
  const keepPaths = new Set(template.files.map((f) => canonicalProjectPath(f.path)));

  project.doc.transact(() => {
    for (const file of template.files) {
      const path = canonicalProjectPath(file.path);
      const existingId = idByPath.get(path);
      if (existingId) {
        // Update an existing file by path (minimal diff preserves history).
        project.transactFile(existingId, (t) => applyMinimalDiff(t, file.text), author);
      } else {
        project.create(path, file.text, author);
      }
    }

    // REPLACE: soft-delete every live file the new template does NOT mention, so
    // a template SWITCH leaves exactly the new file set (old files become
    // `deleted: true`, history preserved — never a hard destroy).
    if (replace) {
      for (const f of live) {
        if (!keepPaths.has(f.path)) project.delete(f.fileId, author);
      }
    }

    // Re-point main by PATH (template.main is canonicalized; must resolve to a
    // live file — every template file was just created or already lives).
    const wantMain = canonicalProjectPath(template.main);
    const mainId = project
      .snapshot()
      .files.find((f) => !f.deleted && f.path === wantMain)?.fileId;
    if (mainId) project.setMain(mainId, author);
  }, authorOrigin(author));
}
