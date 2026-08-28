/**
 * Roadmap #3 — the MCP-side adapter for the shared tool registry. PURE.
 *
 * Maps the registry's READ-ONLY entries (read_document / compile /
 * search_project / list_files / read_file) onto control-responder-style op
 * handlers: the SAME request/response envelope `answerControlRequest` in
 * control-responder.ts speaks — one validated {@link ControlRequest} in, one
 * {@link ControlResponseInput} out — and the same injected-seams discipline
 * ({@link ToolSeams}, the registry's own seam type). That makes the registry
 * the single tool surface BOTH agent fronts consume: the internal loop
 * (run-agent.ts) and the MCP control mailbox, with byte-identical tool
 * behavior because both dispatch into the very same `run` functions.
 *
 * MOUNTED (#1 slice 1) BEHIND PER-PROJECT CONTENT CONSENT: the responder mount
 * (control-responder-mount.ts) routes these ops through here ONLY after the
 * request's projectId passed the session-scoped content-consent gate
 * (agent-content-consent.ts) — file contents NEVER ride on the metadata-only
 * pairing capability alone. This module stays pure and gate-free on purpose:
 * the consent wall lives in the mount, IN FRONT of this dispatch, and the
 * seams handed in are already scoped to the one granted project.
 *
 * Fail-closed by the same rules as the responder core:
 *   - MUTATING entries are NEVER exposed: propose_edit is refused even though
 *     it sits in the same registry — the mailbox gets no write path, full stop.
 *     (The registry invariant test pins propose_edit as the only mutating
 *     entry; this adapter additionally filters by `access`, so a future
 *     mutating entry is excluded automatically.)
 *   - A tool-run throw becomes `ok:false` with a GENERIC error string (an
 *     underlying message could leak store internals), never an unhandled
 *     rejection that could wedge a drain loop.
 *   - Tool runs may yield AgentEvents (compile yields diagnostics); the
 *     mailbox envelope has no event channel, so events are drained and
 *     DISCARDED — the model-facing `resultText` already embeds what matters.
 *   - Output size is bounded upstream by the registry's PROJECT_TOOL_CAPS.
 */

import type { ControlRequest, ControlResponseInput } from "@galley/collab";
import { TOOL_REGISTRY } from "@galley/agent";
import type { ToolRegistryEntry, ToolSeams } from "@galley/agent";

/** An ok:false response carrying the request's correlation id. */
function refuse(id: string, error: string): ControlResponseInput {
  return { id, ok: false, error };
}

/** The registry's read-only entries — the ONLY ops this adapter will answer. */
function readonlyEntry(op: string): ToolRegistryEntry | undefined {
  return TOOL_REGISTRY.find((e) => e.spec.name === op && e.access === "readonly");
}

/** The op names this adapter can answer (exported for the future mount's advertise step). */
export function readonlyToolOps(): string[] {
  return TOOL_REGISTRY.filter((e) => e.access === "readonly").map((e) => e.spec.name);
}

/**
 * Answer one control request by running the matching READ-ONLY registry entry
 * with the request's params as the tool arguments. Mirrors the shape of
 * `answerControlRequest` (control-responder.ts) so a future mount can compose
 * the two dispatchers; never throws.
 */
export async function answerReadonlyToolRequest(
  request: ControlRequest,
  seams: ToolSeams,
): Promise<ControlResponseInput> {
  const { id, op, params } = request;
  const entry = readonlyEntry(op);
  if (!entry) {
    // Covers unknown names AND the mutating propose_edit alike: to the mailbox
    // they are equally unsupported. The error names neither the registry nor
    // the mutating tool — no surface enumeration for a probing peer.
    return refuse(id, `unsupported tool op: ${op}`);
  }
  // A seam-gated project tool without the seam is refused up front (same gate
  // the loop applies), rather than relying on the run's internal fallback text.
  if (entry.requiresProjectSeam === true && seams.projectTools === undefined) {
    return refuse(id, `tool unavailable: ${op}`);
  }
  try {
    // Drain the run: events (e.g. compile diagnostics) have no mailbox channel
    // and are discarded — resultText already carries the model-facing rendering.
    const gen = entry.run(seams, params);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const { resultText, summary } = next.value;
    return { id, ok: true, result: { text: resultText, summary } };
  } catch {
    // Fail-closed: a seam/tool failure is refused with a generic string, never
    // surfaced (an underlying message could leak internals) and never thrown.
    return refuse(id, "the tool could not complete this request");
  }
}

/**
 * Bind the seams once and return a per-request answerer — the same shape as
 * `createControlResponder`, so the (deferred, security-gated) mount can treat
 * both dispatchers uniformly.
 */
export function createReadonlyToolResponder(
  seams: ToolSeams,
): (request: ControlRequest) => Promise<ControlResponseInput> {
  return (request) => answerReadonlyToolRequest(request, seams);
}
