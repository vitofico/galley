/**
 * Edit authorship — the one concept that genuinely anticipates collaboration
 * (docs/server-and-collaboration.md, ADR-0005/0006). Under collaboration, every
 * edit/transaction carries an `Author` so the UI can attribute changes across
 * peers, and so the agent's edits are distinguishable from a human's.
 *
 * Graduated into `@galley/shared` when collaboration work began (ADR-0006); the
 * rest of the collab/auth contracts stay out of code until they have consumers.
 */
export type Author =
  | {
      kind: "human";
      userId: string;
      /**
       * Optional human-friendly display name (#19.4 joiner identity). Carried in
       * the replicated authors map so presence + attribution can show a real
       * name; ADDITIVE — identity (and attribution keys) stay on `userId`.
       */
      name?: string;
    }
  | { kind: "agent"; runId: string };
