/**
 * Roadmap #14 (Unification) — seed slice: the "single-file draft IS a one-file
 * project" primitive.
 *
 * The #14 epic promotes a local-first, persistent, multi-file PROJECT to the
 * default experience while keeping the single-file MVP path alive — its framing
 * is that the single-file draft becomes "a project with one untitled file," via a
 * one-way import. This module is that import, expressed as a PURE function over a
 * source string: no CRDT, no IO, no default-boot change. It produces a
 * {@link ProjectSnapshot} — the exact shape `materializeProject` (#4, the CRDT→git
 * projection) and the `VersionStore` already consume — so the seed composes with
 * the persistence substrate that's already built rather than inventing a new one.
 *
 * DEFAULT-OFF: nothing in the shipped default boot calls this. It is the
 * foundational primitive the activation epic builds on; wiring it into the default
 * experience (criterion 1: "a fresh visit opens a persistent project by default")
 * is the body of #14, deliberately NOT done here.
 */
import type { ProjectSnapshot } from "./collab-project.js";

/** The canonical path a single-file draft lands at when imported as a project. */
export const DEFAULT_DRAFT_PATH = "/main.typ";
/** The stable file id for the lone file of an imported single-file draft. */
export const DEFAULT_DRAFT_FILE_ID = "draft-main";

export interface DraftImportOptions {
  /** Canonical path for the imported file (default {@link DEFAULT_DRAFT_PATH}). */
  path?: string;
  /** Stable file id for the imported file (default {@link DEFAULT_DRAFT_FILE_ID}). */
  fileId?: string;
}

/**
 * Wrap a single-file draft into a one-file {@link ProjectSnapshot} whose only file
 * is the project's main. Deterministic and pure: the same source + options always
 * yields the same snapshot. The result is a valid input to `materializeProject`
 * (it projects to a one-file working tree + a `.galley/project.json` manifest) and
 * to the `VersionStore`, so a single-file draft can enter the project/version
 * substrate without a rewrite — the preservation guarantee #14 promises.
 */
export function draftToProjectSnapshot(
  source: string,
  opts: DraftImportOptions = {},
): ProjectSnapshot {
  const path = opts.path ?? DEFAULT_DRAFT_PATH;
  const fileId = opts.fileId ?? DEFAULT_DRAFT_FILE_ID;
  return {
    files: [{ fileId, path, text: source, deleted: false }],
    mainFileId: fileId,
    duplicatePaths: [],
  };
}
