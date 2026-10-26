import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, ProjectId, ProjectStore, UserId } from "@galley/shared";
import { ProjectImportPanel } from "./ProjectImportPanel.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { EINSTEIN_TEMPLATE_ID, BLANK_TEMPLATE_ID } from "../templates/index.js";
import { createProject, einsteinSeed, blankSeed } from "../project-create.js";
import type { ProjectTemplate } from "../templates/index.js";
import { AccountChip } from "./AccountChip.js";
import type { AuthUser } from "../auth-gate.js";
import "./library.css";

/**
 * Project library / dashboard shell (roadmap #12.3 + #12.4) — the "home" that
 * lists many projects, creates new ones, opens, deletes, and now **organizes**:
 * free-form colored tags, a title/tag search box, a tag filter, and archive /
 * trash (soft-delete via the `archived` metadata flag — NEVER a CRDT destroy).
 *
 * INJECTION-ONLY: the `ProjectStore` and the local `userId` arrive via props, and
 * `onOpen` is supplied by the host (main.tsx routes `?library=1` → this and mounts
 * the project shell on open). The component never imports a concrete store, never
 * touches routing, and has no module-scope side effects — so it is unit-testable
 * with an in-memory store. The non-trivial pieces (load ordering, name validation,
 * tag collection, filtering, tag color) are factored into the pure helpers below
 * and covered directly (the unit gate is Node-env, no DOM).
 *
 * The Projects page is the app's landing surface, so the device-generic actions
 * that are NOT document-scoped live here: **Import project** (a zip is usually a
 * whole project) and **Settings** (device/account preferences).
 */
export interface LibraryAppProps {
  store: ProjectStore;
  userId: UserId;
  onOpen: (projectId: ProjectId) => void;
  /** Open the device-scoped settings surface (`/settings`). Optional for tests. */
  onOpenSettings?: () => void;
  /**
   * The signed-in auth user (auth-on deployments only). When present, an
   * AccountChip is rendered in the header alongside the settings button.
   * Omit (or pass `undefined`) for auth-off/local-first runs; the header is
   * byte-for-byte the same as before (no chip).
   */
  user?: AuthUser;
}

/**
 * Sort projects for stable display: by name (case-insensitive), then id as a
 * tiebreaker so equal names render deterministically. Pure — covered by tests.
 */
export function sortProjects(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const an = a.name.toLocaleLowerCase();
    const bn = b.name.toLocaleLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Normalize a raw name-input value into a creatable project name, or `null` when
 * it is blank (so the form can't create unnamed projects). Pure — covered by
 * tests. Reused to normalize a raw tag (same blank-rejecting rule).
 */
export function normalizeProjectName(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The full set of tags across projects, de-duplicated and sorted (locale-aware).
 * Drives the tag-filter row. Pure — covered by tests.
 */
export function collectTags(projects: readonly Project[]): string[] {
  const set = new Set<string>();
  for (const p of projects) for (const t of p.tags ?? []) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * A stable, deterministic display color for a tag, derived purely from its text
 * (so the SAME tag is always the same color, with no persisted color map — an
 * Architect ruling: don't widen the store contract for cosmetics). FNV-ish hash
 * → an HSL hue; saturation/lightness fixed for legible chips on paper. Pure.
 */
export function tagColor(tag: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hsl(${h % 360} 52% 42%)`;
}

/** Relative metadata uses the stored edit time; covers never invent compiled page counts. */
export function formatProjectUpdatedLabel(
  timestamp: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, (now - timestamp) / 1000);
  if (seconds < 60) return "Edited just now";
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (seconds < 3600)
    return `Edited ${relative.format(-Math.floor(seconds / 60), "minute")}`;
  if (seconds < 86400)
    return `Edited ${relative.format(-Math.floor(seconds / 3600), "hour")}`;
  if (seconds < 2592000)
    return `Edited ${relative.format(-Math.floor(seconds / 86400), "day")}`;
  return `Edited ${new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Filter inputs for the visible project list. */
export interface LibraryFilter {
  /** Substring matched (case-insensitive) against the name OR any tag. */
  query: string;
  /** When non-null, only projects carrying this exact tag. */
  tag: string | null;
  /** When false, archived projects are hidden (soft-deleted). */
  showArchived: boolean;
}

/**
 * Apply the search box + tag filter + archived toggle to a project list. Pure —
 * covered by tests. Order-preserving (callers pre-sort).
 */
export function filterProjects(
  projects: readonly Project[],
  filter: LibraryFilter,
): Project[] {
  const q = filter.query.trim().toLocaleLowerCase();
  return projects.filter((p) => {
    if (!filter.showArchived && p.archived === true) return false;
    if (filter.tag !== null && !(p.tags ?? []).includes(filter.tag))
      return false;
    if (q.length > 0) {
      const inName = p.name.toLocaleLowerCase().includes(q);
      const inTags = (p.tags ?? []).some((t) =>
        t.toLocaleLowerCase().includes(q),
      );
      if (!inName && !inTags) return false;
    }
    return true;
  });
}

export function LibraryApp({
  store,
  userId,
  onOpen,
  onOpenSettings,
  user,
}: LibraryAppProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The secondary blank-project action owns the create flow: expanded
  // it's an inline name field. `creating` is which of the two it shows.
  const [creating, setCreating] = useState(false);
  // Import-project modal (relocated from the document Insert menu).
  const [importing, setImporting] = useState(false);
  // Focused when blank-project creation expands so the field is ready to type into.
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // #12.4 organize controls.
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Template picker — opens the TemplatePicker overlay; on pick, creates a new
  // project from the chosen template and navigates to it (never replaces anything;
  // there is no "current project" on the Projects page).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [menuProjectId, setMenuProjectId] = useState<ProjectId | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (menuProjectId === null) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node))
        setMenuProjectId(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      menuRef.current
        ?.querySelector<HTMLButtonElement>("[data-testid='project-menu']")
        ?.focus();
      setMenuProjectId(null);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuProjectId]);

  const handleTemplatePick = useCallback(async (template: ProjectTemplate) => {
    setTemplatesOpen(false);
    if (template.id === EINSTEIN_TEMPLATE_ID) {
      // Einstein: creates a NEW project with the 1905 demo history, then navigates.
      void createProject(einsteinSeed());
      return;
    }
    if (template.id === BLANK_TEMPLATE_ID) {
      // Blank "Empty project": the catalog card carries no files (its main has
      // nothing to point at), so seed the canonical blank starter (a single
      // `/main.typ`) instead — otherwise the new project's main would dangle
      // and the editor would never settle.
      void createProject(blankSeed());
      return;
    }
    // The remaining (real, multi-file) templates: create a new project seeded
    // with the template's files, then navigate. `createProject` stashes a
    // pending seed consumed on first boot by the mounted ProjectApp.
    void createProject({
      kind: "blank",
      files: template.files,
      mainPath: template.main,
      demoHistory: false,
      name: template.name,
    });
  }, []);

  // B11 rename — click-to-edit the project name on its card. `renamingId` is the
  // project currently in edit mode (null = none); `renameValue` is its draft.
  const [renamingId, setRenamingId] = useState<ProjectId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Escape cancels — but unmounting the input also fires its `onBlur`, which would
  // otherwise commit. This ref lets the blur handler know a cancel is in flight
  // and skip the write.
  const renameCancelledRef = useRef(false);

  const reload = useCallback(async () => {
    const list = await store.listProjectsForUser(userId);
    setProjects(sortProjects(list));
  }, [store, userId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void store
      .listProjectsForUser(userId)
      .then((list) => {
        if (alive) setProjects(sortProjects(list));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [store, userId]);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const clean = normalizeProjectName(name);
      if (clean === null || busy) return;
      setBusy(true);
      try {
        const created = await store.createProject({
          name: clean,
          ownerId: userId,
        });
        // Stamp creation time so future "recent" sorts have data (additive metadata).
        await store.updateProject(created.id, {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setName("");
        setCreating(false);
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [name, busy, store, userId, reload],
  );

  // Close blank-project creation from its inline name field (Cancel / Escape).
  const cancelCreate = useCallback(() => {
    setCreating(false);
    setName("");
  }, []);

  // Focus the name field when blank-project creation expands.
  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  // Inline delete confirm — clicking "Delete" first enters a per-project confirm
  // state (no `window.confirm`). Confirming calls the store; Cancel/Escape aborts.
  const [confirmingDeleteId, setConfirmingDeleteId] =
    useState<ProjectId | null>(null);

  const handleDelete = useCallback(
    async (id: ProjectId) => {
      setConfirmingDeleteId(null);
      await store.deleteProject(id);
      await reload();
    },
    [store, reload],
  );

  const cancelDelete = useCallback(() => {
    const projectId = confirmingDeleteId;
    setConfirmingDeleteId(null);
    requestAnimationFrame(() => {
      const card = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-testid='project-card']",
        ),
      ].find((element) => element.dataset.projectId === projectId);
      card
        ?.querySelector<HTMLButtonElement>("[data-testid='project-menu']")
        ?.focus();
    });
  }, [confirmingDeleteId]);

  const handleSetArchived = useCallback(
    async (id: ProjectId, archived: boolean) => {
      await store.updateProject(id, { archived, updatedAt: Date.now() });
      await reload();
    },
    [store, reload],
  );

  // B11 — begin / commit / cancel an inline project rename. Commit trims (reusing
  // the blank-rejecting `normalizeProjectName`); a blank or unchanged name simply
  // closes the editor without a write. Persists via the same `updateProject`
  // metadata seam the tag/archive handlers use, then reloads.
  const beginRename = useCallback((project: Project) => {
    renameCancelledRef.current = false;
    setRenamingId(project.id);
    setRenameValue(project.name);
  }, []);

  const cancelRename = useCallback(() => {
    renameCancelledRef.current = true;
    setRenamingId(null);
    setRenameValue("");
  }, []);

  const commitRename = useCallback(
    async (project: Project) => {
      // A cancel (Escape) unmounts the input and fires its blur — skip the write.
      if (renameCancelledRef.current) {
        renameCancelledRef.current = false;
        return;
      }
      const clean = normalizeProjectName(renameValue);
      setRenamingId(null);
      setRenameValue("");
      if (clean === null || clean === project.name) return;
      await store.updateProject(project.id, {
        name: clean,
        updatedAt: Date.now(),
      });
      await reload();
    },
    [renameValue, store, reload],
  );

  const handleAddTag = useCallback(
    async (project: Project, raw: string) => {
      const tag = normalizeProjectName(raw);
      if (tag === null) return;
      const tags = project.tags ?? [];
      if (tags.includes(tag)) return;
      await store.updateProject(project.id, {
        tags: [...tags, tag],
        updatedAt: Date.now(),
      });
      await reload();
    },
    [store, reload],
  );

  const handleRemoveTag = useCallback(
    async (project: Project, tag: string) => {
      await store.updateProject(project.id, {
        tags: (project.tags ?? []).filter((t) => t !== tag),
        updatedAt: Date.now(),
      });
      await reload();
    },
    [store, reload],
  );

  const allTags = useMemo(() => collectTags(projects), [projects]);
  const visible = useMemo(
    () => filterProjects(projects, { query, tag: activeTag, showArchived }),
    [projects, query, activeTag, showArchived],
  );
  const filtering = query.trim().length > 0 || activeTag !== null;

  return (
    <section
      className="library"
      data-testid="library"
      aria-label="Project library"
    >
      <div className="library-topbar">
        <div className="brand library-brand">Galley</div>
        <div className="library-topbar-actions">
          <button
            type="button"
            className="library-back"
            data-testid="library-back"
            aria-label="Back"
            title="Back"
            onClick={() => window.history.back()}
          >
            ←
          </button>
          {onOpenSettings && (
            <button
              type="button"
              className="library-action library-settings"
              data-testid="library-settings"
              title="Settings"
              aria-label="Settings"
              onClick={onOpenSettings}
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="m9.4 3-.6 2.1-1.7 1L5 5.6 3 9l1.5 1.6v2.8L3 15l2 3.4 2.1-.5 1.7 1 .6 2.1h4.2l.6-2.1 1.7-1 2.1.5 2-3.4-1.5-1.6v-2.8L20 9l-2-3.4-2.1.5-1.7-1-.6-2.1Z" />
                <circle cx="11.5" cy="12" r="3" />
              </svg>
            </button>
          )}
          {user && (
            <AccountChip
              user={user}
              {...(onOpenSettings ? { onOpenSettings } : {})}
            />
          )}
        </div>
      </div>
      <header className="library-header">
        <div className="library-header-text">
          <h1 className="library-title">Projects</h1>
          <p className="library-subtitle">Open a project or start a new one.</p>
        </div>
      </header>
      <div className="library-controls" data-testid="library-controls">
        <button
          type="button"
          className="library-action library-action-primary"
          data-testid="library-new-from-template"
          onClick={() => setTemplatesOpen(true)}
        >
          <span aria-hidden="true">＋</span> New from template
        </button>
        <button
          type="button"
          className="library-action"
          data-testid="library-import-project"
          onClick={() => setImporting(true)}
        >
          <svg
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            <path d="M5 2h7l3 3v13H5Z M11 2v4h4 M8 9h4 M8 12h4" />
          </svg>{" "}
          Import project
        </button>
        <label className="library-search-wrap">
          <svg
            viewBox="0 0 20 20"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            className="library-search"
            data-testid="library-search"
            type="search"
            value={query}
            placeholder="Search projects"
            aria-label="Search projects"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="library-secondary-controls">
        <div className="library-newcard" data-testid="new-project-cell">
          {creating ? (
            <form
              className="library-newcard-form"
              data-testid="create-project-form"
              onSubmit={handleCreate}
            >
              <input
                ref={nameInputRef}
                className="library-newcard-input"
                data-testid="new-project-name"
                type="text"
                value={name}
                placeholder="Project name"
                aria-label="New project name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelCreate();
                  }
                }}
              />
              <button
                className="library-newcard-create"
                data-testid="create-project"
                type="submit"
                disabled={busy || normalizeProjectName(name) === null}
              >
                Create
              </button>
              <button
                className="library-newcard-cancel"
                data-testid="create-project-cancel"
                type="button"
                onClick={cancelCreate}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              className="library-newcard-trigger"
              data-testid="new-project-tile"
              type="button"
              onClick={() => setCreating(true)}
            >
              New blank project
            </button>
          )}
        </div>
        <label className="library-archived-toggle">
          <input
            type="checkbox"
            data-testid="show-archived"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          Show archived
        </label>
      </div>
      {allTags.length > 0 && (
        <div
          className="library-tag-filter"
          data-testid="tag-filter"
          role="group"
          aria-label="Filter by tag"
        >
          {allTags.map((tag) => (
            <button
              key={tag}
              className="library-tag-chip"
              data-testid="tag-filter-chip"
              data-tag={tag}
              data-active={activeTag === tag ? "true" : undefined}
              type="button"
              aria-pressed={activeTag === tag}
              style={{ "--tag-color": tagColor(tag) } as React.CSSProperties}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {loading ? (
        <div className="library-loading" data-testid="library-loading">
          Loading projects…
        </div>
      ) : (
        <>
          {projects.length === 0 ? (
            <p className="library-empty" data-testid="library-empty">
              Your next document starts here. Choose a template or create a
              blank project.
            </p>
          ) : visible.length === 0 ? (
            <p className="library-empty" data-testid="library-no-matches">
              {filtering
                ? "No projects match your search."
                : "No projects to show."}
            </p>
          ) : null}
          <div className="library-grid" data-testid="library-grid">
            {visible.map((project) => (
              <article
                key={project.id}
                className={`library-card${project.archived === true ? " library-card-archived" : ""}`}
                data-testid="project-card"
                data-project-id={project.id}
                data-archived={project.archived === true ? "true" : undefined}
              >
                <div className="library-card-body">
                  <span className="library-cover" aria-hidden="true">
                    <span className="library-cover-title">{project.name}</span>
                    <span className="library-cover-rule" />
                    <span className="library-cover-lines" />
                  </span>
                  <div className="library-card-copy">
                    {renamingId === project.id ? (
                      <input
                        className="library-card-name-input"
                        data-testid="rename-project-input"
                        type="text"
                        autoFocus
                        value={renameValue}
                        aria-label={`Rename ${project.name}`}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(project)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitRename(project);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                      />
                    ) : (
                      <h2 className="library-card-name">{project.name}</h2>
                    )}
                    <p className="library-card-meta">
                      {project.updatedAt !== undefined &&
                      Number.isFinite(new Date(project.updatedAt).getTime()) ? (
                        <time
                          dateTime={new Date(project.updatedAt).toISOString()}
                          title={new Date(project.updatedAt).toLocaleString()}
                        >
                          {formatProjectUpdatedLabel(project.updatedAt)}
                        </time>
                      ) : (
                        "Typst project"
                      )}
                      {project.archived === true ? " · Archived" : ""}
                    </p>
                    {(project.tags ?? []).length > 0 && (
                      <div
                        className="library-card-tags"
                        data-testid="project-tags"
                      >
                        {project.tags!.map((tag) => (
                          <span
                            key={tag}
                            className="library-card-tag"
                            data-testid="project-tag"
                            data-tag={tag}
                            style={
                              {
                                "--tag-color": tagColor(tag),
                              } as React.CSSProperties
                            }
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {renamingId !== project.id &&
                  confirmingDeleteId !== project.id && (
                    <button
                      className="library-card-open"
                      data-testid="open-project"
                      type="button"
                      aria-label={`Open ${project.name}`}
                      onClick={() => onOpen(project.id)}
                    />
                  )}
                <div
                  className="library-card-menu-wrap"
                  ref={menuProjectId === project.id ? menuRef : undefined}
                >
                  <button
                    type="button"
                    className="library-card-menu-trigger"
                    data-testid="project-menu"
                    disabled={confirmingDeleteId === project.id}
                    aria-label={`Actions for ${project.name}`}
                    aria-expanded={menuProjectId === project.id}
                    aria-controls={`project-actions-${project.id}`}
                    onClick={() =>
                      setMenuProjectId(
                        menuProjectId === project.id ? null : project.id,
                      )
                    }
                  >
                    ⋮
                  </button>
                  {menuProjectId === project.id && (
                    <div
                      className="library-card-menu"
                      id={`project-actions-${project.id}`}
                      role="group"
                      aria-label={`Actions for ${project.name}`}
                    >
                      <button
                        type="button"
                        data-testid="rename-project"
                        onClick={() => {
                          setMenuProjectId(null);
                          beginRename(project);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-testid="archive-project"
                        aria-label={`${project.archived === true ? "Unarchive" : "Archive"} ${project.name}`}
                        onClick={() => {
                          setMenuProjectId(null);
                          void handleSetArchived(
                            project.id,
                            project.archived !== true,
                          );
                        }}
                      >
                        {project.archived === true ? "Unarchive" : "Archive"}
                      </button>
                      <button
                        type="button"
                        className="library-card-delete"
                        data-testid="delete-project"
                        aria-label={`Delete ${project.name}`}
                        onClick={() => {
                          setMenuProjectId(null);
                          setConfirmingDeleteId(project.id);
                        }}
                      >
                        Delete
                      </button>
                      <div className="library-tag-editor">
                        <span className="library-menu-label">Tags</span>
                        {(project.tags ?? []).map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            data-testid="remove-tag"
                            aria-label={`Remove tag ${tag} from ${project.name}`}
                            onClick={() => void handleRemoveTag(project, tag)}
                          >
                            {tag} <span aria-hidden="true">×</span>
                          </button>
                        ))}
                        <AddTagForm project={project} onAdd={handleAddTag} />
                      </div>
                    </div>
                  )}
                </div>
                {confirmingDeleteId === project.id && (
                  <div
                    className="library-card-confirm"
                    data-testid="delete-confirm"
                    role="group"
                    aria-label={`Delete ${project.name}?`}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        cancelDelete();
                      }
                    }}
                  >
                    <span className="library-card-confirm-text">
                      Delete this project? This can’t be undone.
                    </span>
                    <div className="library-card-confirm-buttons">
                      <button
                        className="library-card-delete-confirm"
                        data-testid="delete-project-confirm"
                        type="button"
                        autoFocus
                        aria-label={`Confirm delete ${project.name}`}
                        onClick={() => void handleDelete(project.id)}
                      >
                        Delete
                      </button>
                      <button
                        className="library-card-delete-cancel"
                        data-testid="delete-project-cancel"
                        type="button"
                        aria-label="Cancel delete"
                        onClick={cancelDelete}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      <ProjectImportPanel
        open={importing}
        onClose={() => setImporting(false)}
      />
      <TemplatePicker
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onPick={(template) => void handleTemplatePick(template)}
      />
    </section>
  );
}

/**
 * A tiny per-card form to add a tag (own input state so it doesn't re-render the
 * whole grid on each keystroke). Presentational; covered by the library e2e.
 */
function AddTagForm({
  project,
  onAdd,
}: {
  project: Project;
  onAdd: (project: Project, raw: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="library-card-addtag"
      data-testid="add-tag-form"
      onSubmit={(e) => {
        e.preventDefault();
        void Promise.resolve(onAdd(project, value)).then(() => setValue(""));
      }}
    >
      <input
        className="library-card-addtag-input"
        data-testid="add-tag-input"
        type="text"
        value={value}
        placeholder="+ tag"
        aria-label={`Add a tag to ${project.name}`}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
