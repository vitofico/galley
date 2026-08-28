/**
 * L8 — the plain-language notice shown when a version save / restore / compare
 * FAILS. These three catch sites used to interpolate the raw `String(err)`
 * straight into the user-facing banner (e.g. "Could not save the version:
 * Error: QuotaExceededError…"), leaking an implementation string with no
 * recovery hint at the moment trust matters most. This maps the failure KIND to
 * calm, reassuring copy (the work is unchanged); the raw error stays in
 * `console.error` for debugging. Pure — unit-tested.
 */
export type VersionOpKind = "save" | "restore" | "compare";

export function versionErrorNotice(kind: VersionOpKind): string {
  switch (kind) {
    case "save":
      return "Couldn't save this version. Your work is still here and unchanged — try saving again in a moment.";
    case "restore":
      return "Couldn't restore that version. Your current document is unchanged — try again in a moment.";
    case "compare":
      return "Couldn't compare those versions. Your work is unchanged — try selecting them again.";
  }
}
