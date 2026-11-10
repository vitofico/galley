import { useEffect, useState } from "react";
import { getProjectAcceptanceMode } from "../agent-acceptance-mode.js";
import type { ConsentOutcome } from "../agent-open-handler.js";
import { getControlResponderManager } from "../control-responder-mount.js";
import { navigate, routeHref } from "../router.js";
import { AgentOpenConsent, type AgentOpenConsentPending } from "./AgentOpenConsent.js";

/** Auto-deny after 90s: under the kernel's 120s wait, so it always gets a definite answer. */
const CONSENT_TIMEOUT_MS = 90_000;

/**
 * The app-level half of `open_project` (ADR-0032). A paired agent may ask for a
 * project that is not the one on screen, or ask while the Projects page or
 * Settings is showing. This host sits above the router, so on any page it can
 * raise the same blocking consent dialog a project page raises, naming the
 * requested project; approving switches the tab to it. It renders nothing until
 * a request arrives, and the responder only answers at all while Agent Access is
 * enabled.
 */
export function AgentOpenElsewhereHost() {
  const [pending, setPending] = useState<AgentOpenConsentPending | null>(null);

  useEffect(
    () =>
      getControlResponderManager().registerOpenElsewhereHost({
        requestConsent: (project) =>
          new Promise<ConsentOutcome>((resolveOutcome) => {
            let settled = false;
            const finish = (value: ConsentOutcome) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              setPending(null);
              resolveOutcome(value);
            };
            const timer = setTimeout(() => finish("timeout"), CONSENT_TIMEOUT_MS);
            const initialMode = getProjectAcceptanceMode(project.projectId);
            setPending({
              projectName: project.name,
              initialMode,
              switchesProject: true,
              resolve: (approved, options) =>
                finish(
                  approved
                    ? {
                        approved: true,
                        options: options ?? { mode: initialMode, backgroundAccess: false },
                      }
                    : "deny",
                ),
            });
          }),
        navigate: (projectId) => navigate(routeHref({ kind: "project", id: projectId })),
      }),
    [],
  );

  return <AgentOpenConsent pending={pending} />;
}
