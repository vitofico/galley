/**
 * `AppNotice` (corrections C3) — the typed model for the ONE shell-root status
 * banner that surfaces transient, document-level outcomes: a failed
 * export/version-restore, an apply conflict, or a calm informational hint.
 *
 * Before this, the message was a bare string rendered INSIDE the agent sidebar,
 * so a failure went invisible the moment the sidebar was collapsed (`0fr`) or
 * unmounted on a narrow viewport — the system knew something the user didn't.
 * Promoting it to the shell root needs a severity so failures interrupt
 * (`role="alert"`, via {@link ../components/Notice}) while hints stay polite.
 *
 * Pure and offline-testable; the shared vocabulary the C1 (at-risk) and H4
 * (export-failure) slices reuse so every surfaced outcome routes through one
 * banner with the right ARIA semantics.
 */
import type { NoticeSeverity } from "./components/Notice.js";

export interface AppNotice {
  readonly message: string;
  readonly severity: NoticeSeverity;
}

/** A failure the user must notice now (interrupts: `role="alert"`). */
export function errorNotice(message: string): AppNotice {
  return { message, severity: "error" };
}

/** A calm, non-failure hint or outcome (polite: `role="status"`). */
export function infoNotice(message: string): AppNotice {
  return { message, severity: "info" };
}
