/**
 * Auto mode (ADR-0033 §4): the connector applies a change on the server, with
 * nobody reviewing it first. The order below is the safeguard, and the first
 * step that fails stops everything after it:
 *
 *   1. Check the token and the project's grant again. Revoking the token,
 *      disconnecting the project or switching it to Ask stops the very next
 *      change, even one already on its way.
 *   2. Stay under the volume cap.
 *   3. Save a checkpoint of the whole project. No checkpoint, no change.
 *   4. Write a `started` entry to the activity trail, naming the token and the
 *      checkpoint. No entry, no change.
 *   5. Apply with the conflict-aware code the browser's Accept uses. If the
 *      text has moved, nothing is applied.
 *   6. Leave a resolved record in the document, so the change shows in
 *      Galley's own history with its origin.
 *
 * A step that fails BEFORE anything is applied (2 to 4) does not lose the
 * client's work: the change is published for review instead, like in Ask mode.
 */
import {
  applyAcceptedFileAsAgent,
  applyAcceptedFileSetAsAgent,
  findProposalTarget,
  planFileProposalAccept,
  resolveAccept,
} from "@galley/agent-apply";
import {
  materializeProject,
  type CollabProject,
  type FileProposalOp,
  type ProposalInput,
} from "@galley/collab";
import {
  CONNECTOR_ACTIVITY_LIMITS,
  type ConnectorActivityEntry,
  type ConnectorActivityState,
  type ConnectorCheckpoint,
} from "@galley/shared";
import { randomBytes } from "node:crypto";

/** What the connector may apply per project in any one hour (ADR-0023's cap). */
export const AUTO_MAX_OPS = 500;
export const AUTO_MAX_BYTES = 16 * 1024 * 1024;
const VOLUME_WINDOW_MS = 60 * 60 * 1000;

/** What Auto mode needs from the deployment. Absent → every change is reviewed. */
export interface AutoApply {
  /** The token this request presented (its public id). */
  tokenId: string;
  /** Does that token still stand? Asked again right before applying. */
  stillAuthorized: () => Promise<boolean>;
  checkpoints: { save(room: string, bytes: Uint8Array): Promise<string> };
  activity: {
    read(room: string): Promise<ConnectorActivityEntry[]>;
    append(room: string, entry: ConnectorActivityEntry): Promise<void>;
  };
  /** One Auto change at a time per project. */
  serialize: <T>(room: string, op: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

/** A change, ready to be applied. */
export interface AutoChange {
  request: string;
  files: string[];
  ops: number;
  bytes: number;
  /** Re-match against the live text and apply, or say why not. Applies all or nothing. */
  apply: (project: CollabProject) => { ok: true } | { ok: false; why: string };
}

const utf8 = new TextEncoder();
const RUN_ID = "connector";

export function singleFileChange(input: ProposalInput): AutoChange {
  return {
    request: input.request,
    files: [input.filePath],
    ops: 1,
    bytes: utf8.encode(input.proposedText).length,
    apply: (project) => {
      const target = findProposalTarget(
        project.snapshot().files,
        input.filePath,
      );
      if (!target.ok)
        return {
          ok: false,
          why:
            target.reason === "missing"
              ? `${input.filePath} is no longer in the project.`
              : `${target.count} files share the path ${input.filePath}.`,
        };
      const outcome = resolveAccept(
        target.file.text,
        input.baseText,
        input.proposedText,
        input.blocks,
      );
      if (!outcome.applied || outcome.source === undefined)
        return {
          ok: false,
          why: `${input.filePath} changed while the edit was being prepared, and ${outcome.conflicts ?? 1} of its blocks no longer match.`,
        };
      applyAcceptedFileAsAgent(
        project,
        target.file.fileId,
        outcome.source,
        RUN_ID,
      );
      return { ok: true };
    },
  };
}

export function fileSetChange(
  request: string,
  ops: FileProposalOp[],
): AutoChange {
  return {
    request,
    files: ops.map((op) => op.path),
    ops: ops.length,
    bytes: ops.reduce((n, op) => n + utf8.encode(op.proposedText).length, 0),
    apply: (project) => {
      const planned = planFileProposalAccept(project.snapshot(), ops);
      if (!planned.ok) return { ok: false, why: planned.reason };
      applyAcceptedFileSetAsAgent(project, planned.plan, RUN_ID);
      return { ok: true };
    },
  };
}

export type AutoOutcome =
  /** Applied on this replica. `finish` records how the confirmation went. */
  | {
      kind: "applied";
      checkpointId: string;
      finish: (state: "applied" | "unconfirmed") => Promise<void>;
    }
  /** Nothing was applied and nothing should be published. */
  | { kind: "stopped"; status: string; message: string }
  /** Nothing was applied; publish for review instead, saying why. */
  | { kind: "review"; why: string };

/**
 * Steps 1 to 5. `stillAuto` re-reads the grant: true = still connected and
 * still Auto, false = now Ask, null = no longer connected.
 */
export function autoApply(
  auto: AutoApply,
  room: string,
  project: CollabProject,
  change: AutoChange,
  stillAuto: () => Promise<boolean | null>,
): Promise<AutoOutcome> {
  const now = auto.now ?? Date.now;
  return auto.serialize(room, async (): Promise<AutoOutcome> => {
    // 1. The kill switch.
    if (!(await auto.stillAuthorized()))
      return {
        kind: "stopped",
        status: "unauthorized",
        message: "Nothing was changed: this access token is no longer valid.",
      };
    const mode = await stillAuto();
    if (mode === null)
      return {
        kind: "stopped",
        status: "disconnected",
        message:
          "Nothing was changed: this project is no longer connected to the hosted connector.",
      };
    if (!mode) return { kind: "review", why: "" };

    // 2. The volume cap, counted from the trail so it survives a restart.
    let recent: ConnectorActivityEntry[];
    try {
      recent = (await auto.activity.read(room)).filter(
        (e) => e.state === "started" && e.atMs > now() - VOLUME_WINDOW_MS,
      );
    } catch {
      return { kind: "review", why: "its activity trail could not be read" };
    }
    if (
      recent.reduce((n, e) => n + e.ops, change.ops) > AUTO_MAX_OPS ||
      recent.reduce((n, e) => n + e.bytes, change.bytes) > AUTO_MAX_BYTES
    )
      return {
        kind: "review",
        why: "the connector has already applied a lot to it in the last hour",
      };

    // 3. The way back.
    const tree = materializeProject(project.snapshot());
    if (!tree.ok)
      return {
        kind: "review",
        why: "its files have a path conflict that has to be resolved in Galley first",
      };
    const checkpoint: ConnectorCheckpoint = {
      version: 1,
      files: tree.result.files.map((f) => ({ path: f.path, text: f.text })),
      binaryFiles: (project.snapshot().binaryFiles ?? [])
        .filter((f) => !f.deleted)
        .map((f) => ({ path: f.path, hash: f.hash, size: f.size, mime: f.mime })),
    };
    let checkpointId: string;
    try {
      checkpointId = await auto.checkpoints.save(
        room,
        utf8.encode(JSON.stringify(checkpoint)),
      );
    } catch {
      return { kind: "review", why: "a checkpoint could not be saved" };
    }

    // 4. The record, before the act.
    const started: ConnectorActivityEntry = {
      version: 1,
      changeId: randomBytes(12).toString("base64url"),
      state: "started",
      atMs: now(),
      tokenId: auto.tokenId,
      request: change.request.slice(0, CONNECTOR_ACTIVITY_LIMITS.maxRequestChars),
      files: change.files.slice(0, CONNECTOR_ACTIVITY_LIMITS.maxFiles),
      ops: change.ops,
      bytes: change.bytes,
      checkpointId,
    };
    try {
      await auto.activity.append(room, started);
    } catch {
      return { kind: "review", why: "its activity trail could not be written" };
    }
    // Best effort from here on: the `started` entry already tells the story.
    const finish = (state: ConnectorActivityState) =>
      auto.activity
        .append(room, { ...started, state, atMs: now() })
        .catch(() => {});

    // 5. Apply, or nothing.
    let applied: ReturnType<AutoChange["apply"]>;
    try {
      applied = change.apply(project);
    } catch {
      await finish("failed");
      return {
        kind: "stopped",
        status: "failed",
        message:
          "The change could not be applied. Read the project again before retrying.",
      };
    }
    if (!applied.ok) {
      await finish("conflict");
      return {
        kind: "stopped",
        status: "conflict",
        message: `Nothing was changed: ${applied.why} Read the project again and retry.`,
      };
    }
    return { kind: "applied", checkpointId, finish };
  });
}
