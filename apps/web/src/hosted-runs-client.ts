/** Optional same-origin hosted execution transport. No plan names or prices live here. */
export interface HostedRunsConfig {
  apiPath: string;
  accountPath?: string;
}
export type HostedRunState =
  | "queued"
  | "running"
  | "awaiting_accept"
  | "accepted"
  | "rejected"
  | "failed"
  | "canceled";
export interface HostedRun {
  id: string;
  kind: "document" | "style";
  state: HostedRunState;
  clientRef?: string;
  draftRef?: string;
  error?: string;
  reviewedAt?: number;
  reviewDecision?: "accepted" | "rejected";
  createdAt: number;
  updatedAt: number;
}
export interface HostedRunsStatus {
  runs: HostedRun[];
  access: "enabled" | "upgrade_required" | "restricted";
  keyConfigured: boolean;
  documentRuns: boolean;
}
export function sameOriginPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value)
  );
}
export function hostedRunsConfig(
  config: unknown = (globalThis as { __GALLEY_CONFIG__?: unknown })
    .__GALLEY_CONFIG__,
): HostedRunsConfig | null {
  if (!config || typeof config !== "object") return null;
  const value = (config as { hostedRuns?: unknown }).hostedRuns;
  if (!value || typeof value !== "object") return null;
  const { apiPath, accountPath } = value as Record<string, unknown>;
  if (!sameOriginPath(apiPath) || !apiPath.endsWith("/api/agent-runs"))
    return null;
  if (accountPath !== undefined && !sameOriginPath(accountPath)) return null;
  return {
    apiPath,
    ...(typeof accountPath === "string" ? { accountPath } : {}),
  };
}

const states: HostedRunState[] = [
  "queued",
  "running",
  "awaiting_accept",
  "accepted",
  "rejected",
  "failed",
  "canceled",
];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseHostedStatus(value: unknown): HostedRunsStatus {
  if (
    !record(value) ||
    !["enabled", "upgrade_required", "restricted"].includes(
      String(value.access),
    ) ||
    typeof value.keyConfigured !== "boolean" ||
    typeof value.documentRuns !== "boolean" ||
    !Array.isArray(value.runs) ||
    value.runs.length > 100
  )
    throw new Error(
      "The hosted service returned an invalid status. Refresh to reconnect.",
    );
  const runs = value.runs.map((run): HostedRun => {
    if (
      !record(run) ||
      typeof run.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(run.id) ||
      !["document", "style"].includes(String(run.kind)) ||
      !states.includes(run.state as HostedRunState) ||
      typeof run.createdAt !== "number" ||
      !Number.isFinite(run.createdAt) ||
      typeof run.updatedAt !== "number" ||
      !Number.isFinite(run.updatedAt) ||
      (run.reviewedAt !== undefined &&
        (typeof run.reviewedAt !== "number" ||
          !Number.isFinite(run.reviewedAt))) ||
      (run.reviewDecision !== undefined &&
        run.reviewDecision !== "accepted" &&
        run.reviewDecision !== "rejected") ||
      ["clientRef", "draftRef", "error"].some(
        (key) =>
          run[key] !== undefined &&
          (typeof run[key] !== "string" || (run[key] as string).length > 2048),
      )
    ) {
      throw new Error(
        "The hosted service returned an invalid run. Refresh to reconnect.",
      );
    }
    return {
      id: run.id,
      kind: run.kind as HostedRun["kind"],
      state: run.state as HostedRunState,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(typeof run.clientRef === "string"
        ? { clientRef: run.clientRef }
        : {}),
      ...(typeof run.draftRef === "string" ? { draftRef: run.draftRef } : {}),
      ...(typeof run.error === "string" ? { error: run.error } : {}),
      ...(typeof run.reviewedAt === "number"
        ? { reviewedAt: run.reviewedAt }
        : {}),
      ...(run.reviewDecision === "accepted" || run.reviewDecision === "rejected"
        ? { reviewDecision: run.reviewDecision }
        : {}),
    };
  });
  return {
    runs,
    access: value.access as HostedRunsStatus["access"],
    keyConfigured: value.keyConfigured,
    documentRuns: value.documentRuns,
  };
}
const messages: Record<string, string> = {
  monthly_agent_limit: "Your hosted run allowance is used for this month.",
  pending_draft_limit:
    "Review pending drafts before starting another hosted run.",
  agent_at_capacity:
    "A hosted run is already active for your account. Refresh its status before trying again.",
  forbidden_origin:
    "The hosted service does not allow this editor address. Check the deployment configuration.",
  pro_required: "Your account does not have access to save a model key.",
  run_not_cancelable:
    "This run has already finished. Refresh and review any pending draft.",
};
export function hostedError(status: number, code?: string): string {
  return (
    (code && messages[code]) ||
    (status === 401
      ? "Sign in to your hosted account, then refresh."
      : status === 402
        ? "Your account needs access to hosted runs."
        : status === 403
          ? "Your account cannot start hosted runs. Check account access."
          : status === 404
            ? "The hosted service is unavailable at this address. Check configuration or sign in."
            : status === 413
              ? "The prompt and file snapshot are too large. Use a smaller file or request."
              : "The hosted request failed. Refresh status before explicitly trying again.")
  );
}
export function createHostedRunsClient(
  config: HostedRunsConfig,
  fetchImpl: typeof fetch = fetch,
) {
  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new Error(
        "Connection interrupted. Refresh status and review pending drafts before starting another run.",
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(hostedError(response.status));
    }
    if (!response.ok)
      throw new Error(
        hostedError(
          response.status,
          record(body) && typeof body.error === "string"
            ? body.error
            : undefined,
        ),
      );
    return body;
  }
  return {
    status: async (keyName: string) =>
      parseHostedStatus(
        await request(
          `${config.apiPath}?keyName=${encodeURIComponent(keyName)}`,
        ),
      ),
    create: async (input: {
      prompt: string;
      keyName: string;
      clientRef: string;
      draftTarget: { syncUrl: string; room: string };
    }) => {
      const body = await request(config.apiPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", ...input }),
      });
      if (
        !record(body) ||
        typeof body.runId !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(body.runId)
      )
        throw new Error(
          "The run response was interrupted. Refresh status before trying again.",
        );
      return body.runId;
    },
    cancel: async (id: string) =>
      request(`${config.apiPath}/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
    reviewed: async (
      id: string,
      draftRef: string,
      decision: "accepted" | "rejected",
    ) =>
      request(`${config.apiPath}/${encodeURIComponent(id)}/reviewed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRef, decision }),
      }),
    saveKey: async (name: string, secret: string) =>
      request(
        `${config.apiPath.replace(/\/agent-runs$/, "/model-keys")}/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
        },
      ),
    removeKey: async (name: string) =>
      request(
        `${config.apiPath.replace(/\/agent-runs$/, "/model-keys")}/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
  };
}

export interface HostedSnapshot {
  path: string;
  text: string;
}
/** Exact immutable file content, bounded without silent truncation. */
export function hostedPrompt(
  request: string,
  snapshot: HostedSnapshot,
): string {
  if (!request.trim()) throw new Error("Write a request first.");
  const prompt = JSON.stringify({
    request: request.trim(),
    files: [{ path: snapshot.path, text: snapshot.text }],
  });
  if (new TextEncoder().encode(prompt).length > 12 * 1024)
    throw new Error(
      "This request and file exceed the hosted snapshot limit (12 KiB). Use a smaller file or request; nothing was sent.",
    );
  return prompt;
}
