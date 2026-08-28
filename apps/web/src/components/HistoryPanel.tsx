import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectId, Version, VersionStore } from "@galley/shared";
import "./history-panel.css";

/**
 * Version-history timeline (roadmap #12.6).
 *
 * INJECTION-ONLY: the `VersionStore` and `projectId` arrive via props, and every
 * mutation is surfaced as a CALLBACK — this panel performs NO restore/materialize
 * logic itself (Architect ruling). It only reads the version list on mount and
 * emits `onRestore` / `onCompare` / `onSaveVersion`; the coordinator wires
 * materialize-on-save and restore-as-CRDT-transaction in the integration sweep.
 * No concrete store import, no routing, no module-scope side effects — so it is
 * unit-testable with an in-memory store. The non-trivial pieces (display order,
 * compare eligibility) are factored into the pure helpers below and covered
 * directly.
 */
export interface HistoryPanelProps {
  store: VersionStore;
  projectId: ProjectId;
  /** Emit the version id to restore. (Host applies it; the panel does not.) */
  onRestore: (versionId: string) => void;
  /** When supplied, the panel offers selecting exactly two versions to compare. */
  onCompare?: (aId: string, bId: string) => void;
  /** When supplied, the panel offers a "save version" form. */
  onSaveVersion?: (input: { name: string; message?: string }) => void;
  /**
   * Current auto-snapshot (#10) opt-in state, shown by the toggle's checked box.
   * Optional — when omitted the toggle reads as off.
   */
  autoSnapshotEnabled?: boolean;
  /**
   * When supplied, the panel renders the opt-in auto-snapshot toggle (a mutating
   * affordance — the host omits this for viewers). Receives the next enabled
   * value; the host persists and drives the cadence.
   */
  onToggleAutoSnapshot?: (enabled: boolean) => void;
}

/**
 * Display order for the timeline: newest-first. `listVersions` returns insertion
 * order (oldest → newest); a history timeline reads most-recent-at-top, so we
 * reverse a copy. Pure — covered by tests.
 */
export function orderVersions(versions: readonly Version[]): Version[] {
  return [...versions].reverse();
}

/**
 * Comparison is possible only when EXACTLY two versions are selected. Pure —
 * covered by tests.
 */
export function canCompare(selected: readonly string[]): boolean {
  return selected.length === 2;
}

/**
 * Which timeline view to render. A FAILED load is distinct from an empty-but-
 * loaded list — without this an IndexedDB-blocked/quota/corrupt rejection would
 * masquerade as "No saved versions yet" and tell the user their safety-net history
 * is empty when it actually failed. Pure — covered by tests.
 */
export function historyView(
  loading: boolean,
  error: boolean,
  count: number,
): "loading" | "error" | "empty" | "list" {
  if (loading) return "loading";
  if (error) return "error";
  return count === 0 ? "empty" : "list";
}

export function HistoryPanel({
  store,
  projectId,
  onRestore,
  onCompare,
  onSaveVersion,
  autoSnapshotEnabled,
  onToggleAutoSnapshot,
}: HistoryPanelProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    void store
      .listVersions(projectId)
      .then((list) => {
        if (alive) setVersions(orderVersions(list));
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [store, projectId]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1] as string, id]; // keep the most recent two
      return [...prev, id];
    });
  }, []);

  const compareReady = useMemo(() => canCompare(selected), [selected]);

  const handleCompare = useCallback(() => {
    if (!onCompare || !canCompare(selected)) return;
    onCompare(selected[0] as string, selected[1] as string);
  }, [onCompare, selected]);

  const handleSave = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (!onSaveVersion) return;
      const cleanName = name.trim();
      if (cleanName.length === 0) return;
      const cleanMessage = message.trim();
      // exactOptionalPropertyTypes is ON: only include `message` when non-empty.
      onSaveVersion({
        name: cleanName,
        ...(cleanMessage.length > 0 ? { message: cleanMessage } : {}),
      });
      setName("");
      setMessage("");
    },
    [onSaveVersion, name, message],
  );

  return (
    <section className="history-panel" data-testid="history-panel" aria-label="Version history">
      <header className="history-header">
        <span className="history-title">History</span>
      </header>

      {onSaveVersion && (
        <form className="history-save" data-testid="save-version-form" onSubmit={handleSave}>
          <input
            className="history-save-name"
            data-testid="save-version-name"
            type="text"
            value={name}
            placeholder="Version name"
            aria-label="Version name"
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="history-save-message"
            data-testid="save-version-message"
            type="text"
            value={message}
            placeholder="Message (optional)"
            aria-label="Version message"
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            className="history-save-submit"
            data-testid="save-version"
            type="submit"
            disabled={name.trim().length === 0}
          >
            Save version
          </button>
        </form>
      )}

      {onToggleAutoSnapshot && (
        <label className="history-auto-snapshot" data-testid="auto-snapshot-row">
          <input
            type="checkbox"
            data-testid="auto-snapshot-toggle"
            checked={autoSnapshotEnabled === true}
            onChange={(e) => onToggleAutoSnapshot(e.target.checked)}
          />
          <span className="history-auto-snapshot-label">
            Auto-snapshot periodically
          </span>
        </label>
      )}

      {onCompare && (
        <div className="history-compare-bar" data-testid="history-compare-bar">
          <span className="history-compare-hint">
            {compareReady
              ? "Two versions selected"
              : `Select two versions to compare (${selected.length}/2)`}
          </span>
          <button
            className="history-compare"
            data-testid="compare-versions"
            type="button"
            disabled={!compareReady}
            onClick={handleCompare}
          >
            Compare
          </button>
        </div>
      )}

      {historyView(loading, error, versions.length) === "loading" ? (
        <div className="history-loading" data-testid="history-loading">
          Loading history…
        </div>
      ) : historyView(loading, error, versions.length) === "error" ? (
        <div className="history-error" data-testid="history-error" role="alert">
          Couldn't load version history — reopen the panel to retry.
        </div>
      ) : historyView(loading, error, versions.length) === "empty" ? (
        <div className="history-empty" data-testid="history-empty">
          No saved versions yet.
        </div>
      ) : (
        <ol className="history-list" data-testid="history-list">
          {versions.map((version) => {
            const isSelected = selected.includes(version.id);
            return (
              <li
                key={version.id}
                className="history-version"
                data-testid="history-version"
                data-version-id={version.id}
                data-selected={isSelected ? "true" : undefined}
              >
                <div className="history-version-main">
                  <span className="history-version-name">{version.name}</span>
                  {version.message != null && version.message.length > 0 && (
                    <span className="history-version-message">{version.message}</span>
                  )}
                  {/* Author-attributed versioning (#11): who contributed to this
                      snapshot. Older/empty versions lack the field → render nothing. */}
                  {version.contributors != null && version.contributors.length > 0 && (
                    <span
                      className="history-version-contributors"
                      data-testid="version-contributors"
                    >
                      by {version.contributors.join(", ")}
                    </span>
                  )}
                </div>
                <div className="history-version-actions">
                  {onCompare && (
                    <label className="history-version-select">
                      <input
                        type="checkbox"
                        data-testid="select-version"
                        checked={isSelected}
                        aria-label={`Select ${version.name} to compare`}
                        onChange={() => toggleSelected(version.id)}
                      />
                      Compare
                    </label>
                  )}
                  <button
                    className="history-version-restore"
                    data-testid="restore-version"
                    type="button"
                    aria-label={`Restore ${version.name}`}
                    onClick={() => onRestore(version.id)}
                  >
                    Restore
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
