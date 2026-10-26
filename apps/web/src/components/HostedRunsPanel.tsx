import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createHostedRunsClient,
  hostedPrompt,
  type HostedRunsConfig,
  type HostedRunsStatus,
  type HostedSnapshot,
} from "../hosted-runs-client.js";
import { useFocusTrap } from "./use-focus-trap.js";
import "./hosted-runs.css";

export function HostedRunsPanel({
  config,
  projectId,
  projectName,
  snapshot,
  share,
  onReview,
  proposalStatus,
}: {
  config: HostedRunsConfig;
  projectId: string;
  projectName: string;
  snapshot: () => HostedSnapshot | null;
  share: () => Promise<{ syncUrl: string; room: string } | { refused: string }>;
  onReview: () => void;
  proposalStatus: (draftRef: string) => string | undefined;
}) {
  const client = useMemo(
    () => createHostedRunsClient(config),
    [config.apiPath],
  );
  const [status, setStatus] = useState<HostedRunsStatus | null>(null);
  const [keyName, setKeyName] = useState("default");
  const [secret, setSecret] = useState("");
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<{
    snapshot: HostedSnapshot;
    request: string;
    prompt: string;
  } | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const acknowledgments = useRef(new Set<string>());
  useFocusTrap(dialog, consent !== null);
  const validName = /^[A-Za-z0-9_-]{1,64}$/.test(keyName);
  const refresh = useCallback(async () => {
    const stamp = ++generation.current;
    try {
      const value = await client.status(keyName);
      if (mounted.current && stamp === generation.current) {
        setStatus(value);
        setConnectionError(null);
      }
    } catch (e) {
      if (mounted.current && stamp === generation.current) {
        setStatus(null);
        setConnectionError((e as Error).message);
      }
    }
  }, [client, keyName]);
  useEffect(() => {
    mounted.current = true;
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (validName) await refresh();
      if (!done) timer = setTimeout(() => void poll(), 3000);
    };
    setStatus(null);
    void poll();
    return () => {
      done = true;
      mounted.current = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [refresh, validName]);
  useEffect(() => {
    if (!consent) return;
    deny.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setConsent(null);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [consent]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const runs =
    status?.runs.filter(
      (run) =>
        run.kind === "document" &&
        (run.clientRef === projectId ||
          run.state === "queued" ||
          run.state === "running"),
    ) ?? [];
  const active =
    status?.runs.some(
      (run) => run.state === "queued" || run.state === "running",
    ) ?? false;
  const ready =
    status?.access === "enabled" && status.documentRuns && status.keyConfigured;
  useEffect(() => {
    for (const run of status?.runs ?? []) {
      if (
        run.kind !== "document" ||
        run.clientRef !== projectId ||
        run.reviewedAt !== undefined ||
        !run.draftRef ||
        acknowledgments.current.has(run.id)
      )
        continue;
      const decision = proposalStatus(run.draftRef);
      if (decision !== "accepted" && decision !== "rejected") continue;
      acknowledgments.current.add(run.id);
      // Bookkeeping after a real mailbox verdict. This endpoint cannot apply or
      // accept a document; it releases the host's pending-draft accounting slot.
      void client
        .reviewed(run.id, run.draftRef, decision)
        .then(() => refresh())
        .catch(() => {
          if (mounted.current)
            setError(
              "Your editor review succeeded, but hosted review status could not be updated. Use Update hosted review status to retry.",
            );
        });
    }
  }, [status, projectId, proposalStatus, client, refresh]);
  const prepare = () => {
    try {
      const file = snapshot();
      if (!file) throw new Error("Open an editable text file first.");
      const prompt = hostedPrompt(request, file);
      setError(null);
      setConsent({ snapshot: file, request: request.trim(), prompt });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = async () => {
    const approved = consent;
    if (!approved) return;
    setConsent(null);
    await act(async () => {
      const target = await share();
      if ("refused" in target) throw new Error(target.refused);
      await client.create({
        prompt: approved.prompt,
        keyName,
        clientRef: projectId,
        draftTarget: target,
      });
      if (!mounted.current) return;
      setRequest("");
      setNotice(
        "Hosted run started. You can keep editing. Any draft needs your explicit Accept.",
      );
      await refresh();
    });
  };
  return (
    <section
      className="hosted-runs"
      aria-label="Hosted agent"
      data-testid="hosted-runs"
    >
      <div className="hosted-runs-heading">
        <strong>Hosted agent</strong>
        <button
          type="button"
          disabled={busy || !validName}
          onClick={() => {
            setError(null);
            void refresh();
          }}
        >
          Refresh status
        </button>
      </div>
      <p>
        Run with a model key stored by your host. Provider usage is billed by
        your model provider. Drafts always need your Accept.
      </p>
      {config.accountPath && (
        <a href={config.accountPath} target="_blank" rel="noopener noreferrer">
          Account and billing
        </a>
      )}
      <p role="status" data-testid="hosted-access">
        {!status
          ? "Connecting to hosted account…"
          : status.access === "upgrade_required"
            ? "Account access is required for hosted runs."
            : status.access === "restricted"
              ? "Hosted runs are restricted for this account."
              : !status.documentRuns
                ? "Hosted document runs are not configured."
                : "Hosted document runs available."}
      </p>
      <label>
        Stored key name
        <input
          value={keyName}
          maxLength={64}
          onChange={(e) => {
            setStatus(null);
            setKeyName(e.target.value);
            setSecret("");
          }}
          disabled={busy}
          autoComplete="off"
        />
      </label>
      {!validName && (
        <p role="alert">
          Use 1–64 letters, digits, underscores or hyphens for a key name.
        </p>
      )}
      {status && (
        <p data-testid="hosted-key-status">
          {status.keyConfigured
            ? "A key is stored under this name. It is never returned to the editor."
            : "No key is stored under this name."}
        </p>
      )}
      <details>
        <summary>Manage model key</summary>
        <label>
          Provider API key
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        <button
          type="button"
          disabled={
            busy || !validName || !secret || status?.access !== "enabled"
          }
          onClick={() => {
            const value = secret;
            setSecret("");
            void act(async () => {
              await client.saveKey(keyName, value);
              setNotice("Encrypted key saved.");
              await refresh();
            });
          }}
        >
          Save encrypted key
        </button>
        <button
          type="button"
          disabled={busy || !validName || !status?.keyConfigured}
          onClick={() =>
            void act(async () => {
              await client.removeKey(keyName);
              setNotice("Stored key removed.");
              await refresh();
            })
          }
        >
          Remove stored key
        </button>
      </details>
      <label htmlFor="hosted-request">Hosted request</label>
      <textarea
        id="hosted-request"
        ref={composer}
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        disabled={busy}
        placeholder="Describe a change to the active file…"
        rows={3}
      />
      <button
        type="button"
        data-testid="hosted-prepare"
        disabled={busy || !ready || active || !request.trim()}
        onClick={prepare}
      >
        Review data and start…
      </button>
      {active && (
        <p>
          An account run is queued or running. It continues if this tab closes.
          Refresh to recover its status; requests are never automatically
          repeated.
        </p>
      )}
      {busy && <p role="status">Contacting hosted service…</p>}
      {error && (
        <p role="alert" className="hosted-runs-error">
          {error}
        </p>
      )}
      {connectionError && (
        <p role="alert" className="hosted-runs-error">
          {connectionError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {runs.length > 0 && (
        <ul className="hosted-run-list" aria-label="Hosted runs">
          {runs.map((run) => {
            const local =
              run.clientRef === projectId && run.draftRef
                ? proposalStatus(run.draftRef)
                : undefined;
            return (
              <li key={run.id} data-testid="hosted-run" data-run-id={run.id}>
                {run.clientRef !== projectId && (
                  <p>
                    Active in another project
                    {run.clientRef ? (
                      <>
                        {" "}
                        ·{" "}
                        <a href={`/p/${encodeURIComponent(run.clientRef)}`}>
                          Open project
                        </a>
                      </>
                    ) : (
                      "."
                    )}
                  </p>
                )}
                <strong>
                  {local === "accepted"
                    ? "Accepted in editor"
                    : local === "rejected"
                      ? "Rejected in editor"
                      : run.reviewedAt !== undefined
                        ? `Reported ${run.reviewDecision ?? "reviewed"} in editor`
                        : run.state === "awaiting_accept"
                          ? "Draft ready for review"
                          : run.state === "canceled"
                            ? "Canceled"
                            : run.state === "failed"
                              ? "Run failed"
                              : run.state === "running"
                                ? "Running"
                                : run.state === "queued"
                                  ? "Queued"
                                  : run.state}
                </strong>
                <small>{new Date(run.createdAt).toLocaleString()}</small>
                {run.state === "awaiting_accept" &&
                  run.reviewedAt === undefined &&
                  local !== "accepted" &&
                  local !== "rejected" && (
                    <>
                      <p>
                        {local === "pending"
                          ? "Review the draft in the editor. Concurrent changes are checked when you Accept."
                          : "Waiting for the draft mailbox to sync. Keep this project open; review pending proposals before starting another run."}
                      </p>
                      <button type="button" onClick={onReview}>
                        Review pending drafts
                      </button>
                    </>
                  )}
                {run.reviewedAt === undefined &&
                  run.draftRef &&
                  (local === "accepted" || local === "rejected") && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await client.reviewed(run.id, run.draftRef!, local);
                          await refresh();
                        })
                      }
                    >
                      Update hosted review status
                    </button>
                  )}
                {run.state === "failed" && (
                  <>
                    <p>{run.error || "The hosted run stopped."}</p>
                    <p>
                      A draft may have been delivered before confirmation
                      failed. Review pending drafts before starting another
                      request.
                    </p>
                    <button type="button" onClick={onReview}>
                      Review pending drafts
                    </button>
                  </>
                )}
                {run.state === "canceled" && (
                  <p>
                    Provider work was asked to stop. A draft already delivered
                    may still need review.
                  </p>
                )}
                {run.clientRef === projectId &&
                  ["failed", "canceled"].includes(run.state) && (
                    <button
                      type="button"
                      disabled={busy || active || !ready}
                      onClick={() => {
                        setNotice(
                          "Review pending drafts, then write a new request. Starting it will require a fresh snapshot consent.",
                        );
                        composer.current?.focus();
                      }}
                    >
                      Start another request
                    </button>
                  )}
                {["queued", "running"].includes(run.state) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await client.cancel(run.id);
                        setNotice(
                          "Cancellation requested. Review any draft already delivered.",
                        );
                        await refresh();
                      })
                    }
                  >
                    Cancel hosted run
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {consent &&
        createPortal(
          <div
            className="agent-consent-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setConsent(null);
            }}
          >
            <div
              ref={dialog}
              className="agent-consent hosted-consent"
              role="dialog"
              aria-modal="true"
              aria-labelledby="hosted-consent-title"
              data-testid="hosted-consent"
            >
              <h2 id="hosted-consent-title">
                Send this snapshot to the hosted agent?
              </h2>
              <p>
                This shares <strong>{projectName}</strong> with the configured
                sync service so the hosted agent can deliver a draft. The
                service receives the project’s full synced content and room
                capability. This browser remembers the mailbox and reconnects
                after reload. Sharing continues until you stop sharing.
              </p>
              <p>
                Your host and its configured model provider receive this request
                and the captured text of{" "}
                <strong>{consent.snapshot.path}</strong>. Later edits are
                checked when you Accept. Your provider may charge for this run.
              </p>
              <details>
                <summary>Review exact request and file snapshot</summary>
                <pre>{consent.request}</pre>
                <pre>{consent.snapshot.text}</pre>
              </details>
              <p>
                The hosted agent proposes changes without compiling them. You
                must review and explicitly Accept them in the editor, even when
                local Auto mode is enabled. The editor compiles after
                acceptance.
              </p>
              <div className="agent-consent-actions">
                <button
                  ref={deny}
                  type="button"
                  onClick={() => setConsent(null)}
                >
                  Cancel
                </button>
                <button type="button" onClick={() => void start()}>
                  Send snapshot and start run
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
