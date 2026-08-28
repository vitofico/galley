/**
 * Apply a style to a project (Phase 1, the commit half of the styles feature).
 *
 * A style lives as a single `/style.typ` module: the chosen style's entry-file
 * source plus, when the document doesn't speak the canonical ABI verbatim, a
 * generated compatibility shim (entry alias + token aliases) appended to the
 * tail. Swapping a style is therefore a single-file replace — `/main.typ` and
 * every other file stay byte-for-byte untouched, so attribution + history on
 * them survive the swap.
 *
 * Two seams keep the commit safe and atomic:
 *   - {@link trialCompileStyle} dry-runs the candidate `/style.typ` against an
 *     injected `check` BEFORE anything is written, so a style that wouldn't
 *     compile is caught while the doc is still pristine.
 *   - {@link applyStyle} writes the new `/style.typ` (replace via a minimal diff,
 *     or create) inside ONE author-tagged transaction.
 *
 * PURE of DOM/worker — the compiler is passed in as a `check` function, and the
 * Yjs writes go through `CollabProject`'s existing author-tagged seams.
 */
import { authorOrigin } from "@galley/collab";
import type { CollabProject } from "@galley/collab";
import type { Author, ProjectInput, CheckResult, Diagnostic } from "@galley/shared";
import { generateShim, type Style, type Styleability } from "./style-manifest.js";
import { applyMinimalDiff } from "./collab-session.js";

/** The /style.typ text to write: the style's entry-file source + the shim tail. */
export function buildStyleSource(style: Style, styleability: Styleability): string {
  const base = style.files.find((f) => f.path === style.entryFile)?.text ?? "";
  const shim = generateShim(styleability);
  return shim ? `${base.trimEnd()}\n\n${shim}\n` : base;
}

/** Candidate ProjectInput with /style.typ swapped — for the pre-commit trial. */
function candidateInput(project: CollabProject, styleSource: string): ProjectInput | null {
  const snap = project.snapshot();
  if (snap.mainFileId === null) return null;
  const mainFile = snap.files.find((f) => f.fileId === snap.mainFileId);
  if (!mainFile || mainFile.deleted) return null;
  const files = snap.files
    .filter((f) => !f.deleted)
    .map((f) => (f.path === "/style.typ" ? { path: f.path, text: styleSource } : { path: f.path, text: f.text }));
  if (!files.some((f) => f.path === "/style.typ")) files.push({ path: "/style.typ", text: styleSource });
  return { kind: "project", files, main: mainFile.path };
}

/** Trial-compile the candidate; return ERROR diagnostics only ([] = safe to apply). */
export async function trialCompileStyle(
  project: CollabProject,
  style: Style,
  styleability: Styleability,
  check: (input: ProjectInput) => Promise<CheckResult>,
): Promise<Diagnostic[]> {
  const input = candidateInput(project, buildStyleSource(style, styleability));
  if (!input) return [{ severity: "error", message: "Project has no compilable main file." } as Diagnostic];
  const res = await check(input);
  return res.diagnostics.filter((d) => d.severity === "error");
}

/** Commit the style: replace (or create) /style.typ in ONE author transaction. */
export function applyStyle(project: CollabProject, style: Style, styleability: Styleability, author: Author): void {
  const target = buildStyleSource(style, styleability);
  const existing = project.snapshot().files.find((f) => f.path === "/style.typ" && !f.deleted);
  project.doc.transact(() => {
    if (existing) {
      project.transactFile(existing.fileId, (text) => applyMinimalDiff(text, target), author);
    } else {
      project.create("/style.typ", target, author);
    }
  }, authorOrigin(author));
}
