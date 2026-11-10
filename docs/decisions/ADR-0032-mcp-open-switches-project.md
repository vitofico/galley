# ADR-0032 — An agent's `open_project` asks first, then switches the tab

- **Status:** Accepted. **Extends** [ADR-0021](./ADR-0021-mcp-library-ops.md)
  (control room, `open_project`), [ADR-0023](./ADR-0023-mcp-auto-accept-provenance.md)
  (per-grant consent choices) and [ADR-0024](./ADR-0024-mcp-workflow-honest-liveness.md)
  (grant reuse, headless attach). Does **not** supersede them: every gate they
  define still runs. Only the answer to "the requested project is not on screen"
  changes.
- **Scope:** roadmap #16 (MCP).

## Context

`open_project` could only succeed for the project the paired tab had open. Any
other request was refused, and the person had to find the right tab, open the
project there by hand and ask the agent to retry.

In practice this was the largest source of friction in the whole flow. An agent
that had just called `create_project` could not open what it created. A link to
the project did not help: it opens a **new** tab, while Agent Access belongs to
the tab where it was enabled. And the two refusals behind it ("another project is
open", "no project is open") reached the agent as one message, so neither the
agent nor the person could tell which tab was the problem.

The refusal protected nothing the consent dialog does not already protect. The
dialog is the gate: it names the project and nothing is shared before it is
approved.

## Decision

When a paired agent asks to open a project the tab does not have open, the tab
**asks first and then switches**:

1. An app-level host, mounted above the router so it exists on every page, shows
   the **same** consent dialog over whatever is on screen. It names the requested
   project and states that approving switches the tab to it.
2. **Deny**, Escape, a backdrop click and the 90-second timeout all leave the tab
   exactly where it was and share nothing.
3. **Approve** navigates the tab to the project (in-app, no reload). When that
   project's page has mounted, its own open handler runs with the approval and
   the choices made in the dialog (Ask/Auto, background access) in hand.

The project's handler skips only the two steps the person has already completed:
the single-dialog lock and the dialog itself. Everything else runs in its
existing order: the joined-session refusal, the scope check, grant reuse, the
liveness re-check, and the share upgrade.

### What does not change

- **Nothing is shared without an explicit approval.** The dialog still precedes
  any share room, and the tab does not move before it is approved.
- **Approval is for one named project.** The scope check still runs on the
  destination page, so an approval for project A can never share project B.
- **Only the person's own library.** A project id the library does not hold is
  neither asked about nor navigated to; it keeps its refusal, so the dialog is
  not an oracle for arbitrary ids.
- **A withdrawn request does nothing.** Liveness is checked before the dialog,
  after it (before the tab moves) and again on the destination page (before the
  share).
- **One dialog at a time.** A second request while one is on screen is refused.
- **A project already on screen** is handled by its own page exactly as before.
- **Default off.** The host is inert until Agent Access is enabled and a paired
  kernel sends such a request.

### Kernel side

Refusals the kernel recognises are now reported in its own words, one per cause:
declined, timed out, another dialog pending, a tab that is a guest in someone
else's project, and the fallback `open_required`. The mapping is keyed on the
browser's exact text and every reported line is authored in the kernel, so the
MEDIUM-3 rule (no responder text reaches the MCP client) is unchanged.

## Consequences

- `create_project` followed by `open_project` works with one click and no manual
  navigation; `create_project` now returns `nextAction: "open_project"`.
- A paired agent can cause a dialog to appear over a project the person is
  working in. It cannot move the tab: only the person's approval does. The cost
  is an interruption, bounded to one dialog at a time, from a kernel the person
  paired and can revoke.
- `status: "open_required"` survives only as a fallback, for a deployment where
  the app-level host is absent or the destination page did not mount within
  `OPEN_ELSEWHERE_MOUNT_TIMEOUT_MS` (10 s).

## Alternatives considered

- **Navigate first, then show the project's own dialog.** One fewer moving part,
  but the tab would move on an agent's say-so before the person agreed to
  anything. Rejected: the person's screen should not change without consent.
- **Let any tab of the same browser answer.** Removes the "which tab" problem by
  sharing the pairing across tabs. Rejected for now: Agent Access is deliberately
  scoped to one tab, and widening that is a larger change to the session model.
- **Keep the refusal and improve its wording.** Cheaper, but leaves the manual
  step in place for the most common sequence.
