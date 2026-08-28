/**
 * The user-facing notice shown when an export (.tar bundle or git repo) had to
 * DROP binaries whose bytes weren't resolvable on this device — e.g. a synced
 * pointer whose blob lives only on the peer that uploaded it. The export is then
 * lossy, and the user should know which assets are missing BEFORE they ship it,
 * rather than discovering blank images later (the omission was previously only
 * console.warn'd — see the 2026-06-15 audit). Pure — unit-tested.
 */
export function omittedBinariesNotice(omitted: readonly string[]): string {
  const label = omitted.length === 1 ? "1 image" : `${omitted.length} images`;
  return `Exported without ${label} whose data isn't available on this device: ${omitted.join(", ")}.`;
}

/** The export format, for the failure copy. */
export type ExportKind = "PDF" | "source bundle" | "git repository" | "PNG";

/**
 * H4 — the plain-language notice shown when an export FAILS. Every export path
 * (PDF/bundle/git/PNG) used to fail silently (no try/catch, or console.error
 * only), so a click on "Export" — or the at-risk "Back up a copy" banner, the
 * moment trust matters most — could do nothing with no explanation. Surfaced via
 * the shell-root error banner (C3 `errorNotice`); the raw error stays in the
 * console. Reassures the work is untouched. Pure — unit-tested.
 */
export function exportFailureNotice(kind: ExportKind): string {
  return `Couldn't export the ${kind}. Your work is safe and unchanged — try again, or choose another format.`;
}
