/**
 * `ProjectApp` — the minimal multi-file project shell (roadmap #2, slice 6),
 * rendered INSTEAD of `App` when `?project=1` is set (see `main.tsx`). The
 * single-file and `?collab=1` experiences are untouched.
 *
 * Minimal scope: a file list, an active-file editor (CodeMirror bound to that
 * file's `Y.Text`), a whole-project preview + PDF export, and per-file
 * diagnostics. File-ops (create/rename/delete/set-main) are slice 7; the
 * active-file agent is slice 8.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent as ReactChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { EditorView } from "@codemirror/view";
import {
  createModelClient,
  listModels,
  buildLabelIndex,
  labelNames,
  citeKeysFromBibliography,
  crossFileRefDiagnostics,
  allProjectLabelNames,
  buildContributionStatement,
  renderContributionStatement,
} from "@galley/agent";
import {
  authorOrigin,
  distinctAuthors,
  textAttributedRanges,
  materializeProject,
  bundleProject,
  getPendingProposals,
  getProposal,
  observeProposals,
  resolveProposal,
  getPendingFileProposals,
  getFileProposal,
  observeFileProposals,
  resolveFileProposal,
  getPendingRunGroups,
  publishFileProposal,
  sha256Hex,
  createThreadAnchored,
  addMessage,
  setThreadStatus,
  getThreads,
  getThread,
  observeComments,
  resolveThreadRange,
  SINGLE_FILE_ID,
  type CollabConnection,
  type Presence,
  type ProposalRecord,
  type FileProposalRecord,
  type RunGroup,
  type BinaryAsset,
  type ThreadView,
} from "@galley/collab";
import type { Awareness } from "y-protocols/awareness";
import { isReservedProjectPath, isSafeProjectPath } from "@galley/shared";
import type {
  Author,
  CompileInput,
  ProviderCapabilities,
  SourceLineCol,
} from "@galley/shared";
import { applyMinimalDiff, type CollabConfig } from "./collab-session.js";
import { authorLabel, ANON_AUTHOR_LABEL } from "./attribution-style.js";
import { applyReplaceChanges, type ReplaceChange } from "./project-replace.js";
import { omittedBinariesNotice, exportFailureNotice } from "./export-notice.js";
import { versionErrorNotice } from "./version-error-notice.js";
import { paletteAffordance } from "./palette-affordance.js";
import { errorNotice, infoNotice, type AppNotice } from "./app-notice.js";
import {
  reduceLinkStatus,
  linkStatusCue,
  createStaleTimer,
  reduceStorageCue,
  storageCue,
  type LinkStatus,
  type StorageCueState,
} from "./link-status.js";
import { isShareConnecting, buildPresenceRoster, type RosterPeer } from "./components/share-popover.js";
import { joinPhaseOnTimeout, joinSyncCue, type JoinSyncPhase } from "./join-sync.js";
import {
  applyAcceptedFileAsAgent,
  applyAcceptedFileSetAsAgent,
  connectProjectSession,
  createProjectSession,
  disconnectProjectSession,
  ensureAuthenticatedBlobChannel,
  restoreProjectFromTree,
  setSessionDisplayName,
  type ProjectSession,
} from "./project-session.js";
import {
  resolveSyncUrl,
  configuredSyncUrlOverride,
  mintShareRoom,
  mintGrantId,
  buildShareLink,
  parseShareRole,
  resolveSessionRole,
  DEFAULT_SHARE_ROLE,
  type ShareRole,
} from "./share.js";
import { shareRegistrationHandoffGate } from "./capability-rooms-client.js";
import { loadLocalProfile, updateLocalProfile } from "./local-profile.js";
import { shouldShowPaletteNudge, dismissPaletteNudge } from "./onboarding-nudge.js";
import { shouldShowFirstRunChooser, dismissFirstRunChooser } from "./first-run-chooser.js";
import { shouldShowCoachOverlay, dismissCoachOverlay } from "./coach-overlay.js";
import { Notice } from "./components/Notice.js";
import { AccountChip } from "./components/AccountChip.js";
import { getActiveAuthUser } from "./auth-gate.js";
import { resolveAccept } from "./accept.js";
import { passesInAppFinalGate } from "./in-app-auto.js";
import {
  getProjectAcceptanceMode,
  setProjectAcceptanceMode,
} from "./agent-acceptance-mode.js";
import { readInAppAudit } from "./in-app-audit.js";
import {
  effectiveAgentMode,
  agentModeWrites,
  type AgentMode,
} from "./components/agent-access-panel-mode.js";
import { HistoryPanel } from "./components/HistoryPanel.js";
import { SearchPanel, type SearchPanelHandle } from "./components/SearchPanel.js";
import { VersionCompare } from "./components/VersionCompare.js";
import { compareVersionTrees, type VersionComparison } from "./version-compare.js";
import { IdbVersionStore } from "./idb-version-store.js";
import { ImportPanel } from "./components/ImportPanel.js";
import { FigurePanel } from "./components/FigurePanel.js";
import { CitationPanel, type ResolvedCitation } from "./components/CitationPanel.js";
import { bibEntryText } from "./components/citation-library.js";
import { GitSyncPanel } from "./components/GitSyncPanel.js";
import {
  pushGitRemote,
  fetchGitRemote,
  pushGithubSnapshot,
  fetchGithubSnapshot,
} from "./git-sync-ops.js";
import { loadRemoteConfig } from "./git-remote-config.js";
import { loadGithubConnection } from "./github-connect.js";
import { loadRepoTarget } from "./github-repo-target.js";
import { loadSyncDestination, deriveSyncDestinationKind } from "./sync-destination.js";
import { createBrowserRemoteSync, exportProjectAsGitRepo } from "@galley/persistence/browser";
import { CompilerModeToggle } from "./components/CompilerModeToggle.js";
import { loadMode, type CompileMode } from "./components/compiler-mode.js";
import { initCompiler, createVerifyCompiler, serverCompileReachable } from "./compiler-assets.js";
import { loadFocusMode, saveFocusMode } from "./focus-mode.js";
import { loadAgentMode, saveAgentMode } from "./agent-mode.js";
import {
  enabledAutoSnapshotPolicy,
  loadAutoSnapshotPolicy,
  saveAutoSnapshotPolicy,
  shouldSnapshot,
  type AutoSnapshotPolicy,
  type AutoSnapshotState,
} from "./auto-snapshot.js";
import { quickFixForDiagnostic } from "./components/quick-fix.js";
import { composeReviseRequest, selectionFromEditor } from "./revise-selection.js";
import { buildProjectToolsSeam } from "./agent-project-tools.js";
import { ReviseSelectionPrompt } from "./components/ReviseSelectionPrompt.js";
import { explainForDiagnostic } from "./components/explain-error.js";
import { appendSnippet, wholeSourceBlock } from "./components/authoring-insert.js";
import { findProposalTarget } from "./components/McpProposals.js";
import { PendingReviewBadge } from "./components/PendingReviewBadge.js";
import { RunReviewCard } from "./components/RunReviewCard.js";
import { applyRunAccepts } from "./run-accept-all.js";
import "./components/pending-review-badge.css";
import {
  AgentAccessPanel,
  type AgentAccessAuditRow,
} from "./components/AgentAccessPanel.js";
import {
  decideAutoAcceptSingle,
  decideAutoAcceptFile,
  passesFinalApplyGate,
  newAutoEligibility,
  observeAutoEligibility,
  promotePendingToEligible,
  type AutoAcceptCtx,
} from "./auto-accept.js";
import {
  claimAutoApplier,
  releaseAutoApplier,
  isAutoApplierOwner,
  withAutoApplierLock,
} from "./auto-applier-ownership.js";
import {
  planFileProposalAccept,
  verifyBinaryBlobsPresent,
  blobHashIsReferenced,
} from "./file-proposal-accept.js";
import { TabBar, TAB_PANEL_ID } from "./components/TabBar.js";
import { tablistKeyTarget } from "./components/tablist-nav.js";
import { IconRail } from "./components/IconRail.js";
import { useFocusTrap } from "./components/use-focus-trap.js";
import { DockedPanel } from "./components/DockedPanel.js";
import { ExportMenu, type ExportMenuItem } from "./components/ExportMenu.js";
import { StatusChip } from "./components/StatusChip.js";
import { SharePopover } from "./components/SharePopover.js";
import {
  AgentOpenConsent,
  type AgentOpenConsentPending,
} from "./components/AgentOpenConsent.js";
import {
  getControlResponderManager,
  type RestoreVersionHandler,
} from "./control-responder-mount.js";
import { createAgentOpenHandler, type ConsentOutcome } from "./agent-open-handler.js";
import { grantMatchesReuseScope, inheritedGrantMode, mintGrantMode } from "./proposal-grant.js";
import type {
  OpenedProject,
  OpenProjectRefusal,
  ExportedCompiled,
  CompileDiagnostics,
} from "./control-responder.js";
import { downloadBytes } from "./download.js";
import { buildRasterExport, browserRasterize } from "./export-raster.js";
import {
  requestPersistentStorage,
  estimateStorage,
  durabilityStatus,
  type DurabilityStatus,
  type PersistState,
} from "./storage-durability.js";
import {
  shouldWarnTransientStorage,
  dismissTransientWarning,
} from "./transient-storage-warning.js";
import {
  DOCK_TITLES,
  INSERT_TABS,
  closeDockIf,
  initialDockState,
  openDock,
  openInsertTab,
  shouldBootFilesClosed,
  toggleDock,
  type DockId,
  type DockState,
  type InsertTab,
} from "./components/dock-state.js";
import { readFilesDockPref, writeFilesDockPref } from "./components/files-dock-pref.js";
import "./components/rail-and-pills.css";
import { useResponsive, type PaneTab } from "./use-responsive.js";
import { useSaveState, type SaveStateTarget } from "./use-save-state.js";
import "./components/save-state-badge.css";
import "./components/authoring-panels.css";
import "./components/agent-access-panel.css";
import { BLANK_STARTER_FILES, BLANK_STARTER_MAIN } from "./project-sample.js";
import type { SeedFile } from "@galley/collab";
import { createProject, einsteinSeed } from "./project-create.js";
import { ProjectEditor } from "./components/ProjectEditor.js";
import { PersistentBlobStore, IndexeddbBlobBackend, blobDbName } from "./idb-blob-store.js";
import {
  pendingHashes,
  buildBinaryFilesInput,
  takePendingBinarySeed,
  formatBytes,
  type ResolvedBinaryCache,
} from "./binary-files.js";
import {
  planBinaryUpload,
  uniqueBinaryPath,
  uploadSkipNotice,
  imageSnippet,
  inlineImageSnippet,
  pastedImageName,
  isDisplayableRasterMime,
} from "./binary-upload.js";
import { BinaryPreview, type BinaryPreviewMeta } from "./components/BinaryPreview.js";
import {
  buildFileTree,
  planFolderCreate,
  planFolderRename,
  type TreeNode,
} from "./components/file-tree-helper.js";
import {
  menuAnchor,
  type MenuPoint,
  type TreeMenuItemId,
  type TreeMenuTarget,
} from "./components/file-tree-menu.js";
import { FileTreeMenu } from "./components/FileTreeMenu.js";
import { CommentThreadCard } from "./components/CommentThreadCard.js";
import { CommentCreateComposer } from "./components/CommentCreateComposer.js";
import { CommentsOverview, type OverviewThread } from "./components/CommentsOverview.js";
import type { CommentSelection } from "./components/comment-create-tooltip.js";
import { Preview } from "./components/Preview.js";
import { AgentPanel } from "./components/AgentPanel.js";
import { WritingGoals } from "./components/WritingGoals.js";
import { readProjectInstructions } from "./instructions-vfs.js";
import { InstructionsPanel } from "./components/InstructionsPanel.js";
import { InsertReferencePicker } from "./components/InsertReferencePicker.js";
import { ContributionStatementModal } from "./components/ContributionStatementModal.js";
import { gatherContributionEvidence, type AttributedFile } from "./contribution-evidence.js";
import {
  findAllInstructionsFiles,
  readInstructionsText,
  type InstructionsEditFile,
} from "./instructions-edit.js";
import { writeProjectInstructions } from "./instructions-write.js";
import { DiagnosticsList } from "./components/DiagnosticsList.js";
import { previewPlaceholder } from "./components/preview-placeholder.js";
import { staleRenderNotice } from "./components/preview-stale-notice.js";
import { dropPackagePathRefs } from "./components/ref-lint.js";
import { DocStatusBar } from "./components/DocStatusBar.js";
import { DocOutline } from "./components/DocOutline.js";
import { useCompiler } from "./useCompiler.js";
import { createDemoModel } from "./demo-model.js";
import { usePanes } from "./usePanes.js";
import { SplitPanes } from "./components/SplitPanes.js";
import { jumpToDiagnostic, jumpToOffset } from "./components/diagnostics-extension.js";
import { labelCompletionSource } from "./components/label-complete.js";
import { citeCompletionSource } from "./components/cite-complete.js";
import { CommandSheet } from "./components/CommandSheet.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { CoachOverlay } from "./components/CoachOverlay.js";
import { StyleLibrary } from "./components/StyleLibrary.js";
import { detectStyleability, type Style } from "./style-manifest.js";
import { applyStyle, trialCompileStyle } from "./apply-style.js";
import { BUILT_IN_STYLES } from "./styles-library/index.js";
import {
  loadLocalStyles,
  saveLocalStyle,
  deleteLocalStyle,
  toStyle,
  type LocalStyleEntry,
} from "./local-styles.js";
import { useStyleSources } from "./use-style-sources.js";
import type { Compiler } from "@galley/compiler";
import type { Diagnostic } from "@galley/shared";
import {
  createCommandRegistry,
  fileOpenCommands,
  type Command,
} from "./commands/registry.js";
import { useShortcuts, type Shortcut } from "./use-shortcuts.js";
import { navigate, currentRoute, routeHref } from "./router.js";
import { settingsHref, type SettingsSectionId } from "./settings-sections.js";
import { loadStoredProvider } from "./provider-storage.js";
import {
  applyTheme,
  resolveInitialTheme,
  toggleTheme,
  STORAGE_KEY as THEME_KEY,
  type ThemeMode,
} from "./theme.js";
import { applySkin, resolveInitialSkin, SKIN_STORAGE_KEY } from "./skin.js";
import "./theme.css";

const AGENT_RUN_ID = "agent";

/** UTF-8 byte sizing for the auto-accept volume backstop. */
const utf8 = new TextEncoder();
/**
 * Per-session anomalous-burst backstop for auto-accept (ADR-0023 §2): once
 * cumulative auto-applied ops/bytes exceed these, the decision core returns
 * "manual" — a hostile kernel flooding proposals can't apply unbounded work
 * unattended. Generous so legitimate sessions never hit it; the operator re-arms.
 */
const AUTO_ACCEPT_MAX_OPS = 500;
const AUTO_ACCEPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A2/C1a: how long a kernel `expect_blob` reservation lives without a delivery
 * before it AUTO-RELEASES (`channel.unexpect`). Bounds the quota-pin a consented
 * room peer could hold by reserving capacity it never fills. Generous enough for a
 * real multi-megabyte push over a slow link, short enough that an abandoned
 * reservation frees promptly. The kernel's own push timeout is well under this.
 */
const EXPECT_BLOB_LEASE_MS = 60_000;

/** #H7: the shared `role="tabpanel"` host the Insert tabs `aria-controls`. */
const INSERT_PANEL_ID = "insert-panel";

/** File-ops are this local user's actions; tag transactions as a human author. */
const HUMAN: Author = { kind: "human", userId: "me" };

/**
 * Page-lifetime project sessions, keyed by room + sync target (#19.4). Sessions
 * have always lived for the page lifetime (see the NOTE below at the old
 * lazy-ref); with client-side routing the shell can unmount and REMOUNT
 * (library ↔ project navigation, back/forward), and a second
 * `createProjectSession` over the same IndexedDB db would attach a duplicate
 * persistence provider to a parallel doc. The cache makes a remount rejoin the
 * SAME live session instead. The peer's display name (#19.4 joiner identity)
 * comes from the local profile at creation, so it registers with the author.
 */
const SESSION_CACHE = new Map<string, ProjectSession>();

/**
 * B14 — convert a 1-based line / 0-based column (the preview source map's
 * coordinate space) into a 0-based character offset within `text`. Used for a
 * cross-file inverse-sync jump, where the target file is NOT mounted in the
 * editor yet, so we can't ask CodeMirror — we resolve against the raw text and
 * stash the offset for the post-remount jump. Newlines are split on `\n` (the
 * editor normalizes line endings); both inputs are clamped so an out-of-range
 * position lands at a valid offset rather than NaN. Pure.
 */
function lineColToOffset(text: string, line: number, column: number): number {
  const lines = text.split("\n");
  const lineIdx = Math.min(Math.max(line, 1), lines.length) - 1;
  let offset = 0;
  for (let i = 0; i < lineIdx; i++) {
    offset += lines[i]!.length + 1; // +1 for the consumed newline
  }
  const col = Math.min(Math.max(0, column), lines[lineIdx]?.length ?? 0);
  return offset + col;
}

/**
 * Comments Phase A: the on-screen rect to anchor a thread card at when it is
 * opened WITHOUT a clicked gutter marker (e.g. from the cross-file overview, after
 * a possible file switch). Resolves the thread's live range against the project,
 * jumps the editor cursor there, and reads the caret's coords; falls back to a
 * centered viewport rect when the thread is orphaned / the view isn't ready.
 */
function caretRectForThread(
  view: EditorView | null,
  host: { doc: import("yjs").Doc },
  threadId: string,
): DOMRect {
  const fallback = (): DOMRect =>
    new DOMRect(
      typeof window !== "undefined" ? window.innerWidth / 2 - 150 : 0,
      typeof window !== "undefined" ? window.innerHeight / 3 : 0,
      0,
      0,
    );
  if (!view) return fallback();
  const thread = getThread(host, threadId);
  const range = thread ? resolveThreadRange(host, thread) : null;
  if (!range) return fallback();
  const pos = Math.max(0, Math.min(range.from, view.state.doc.length));
  const coords = view.coordsAtPos(pos);
  if (!coords) return fallback();
  return new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
}

/** The resolved boot seed for a project session (project-model redesign §2). */
interface BootSeed {
  files: SeedFile[];
  mainPath: string;
  demoHistory: boolean;
}

function obtainProjectSession(
  config: CollabConfig,
  seed: BootSeed,
  blobStore: PersistentBlobStore | null,
): ProjectSession {
  const key = `${config.syncUrl ?? "local"}::${config.room ?? "default"}`;
  let session = SESSION_CACHE.get(key);
  if (!session) {
    const displayName = loadLocalProfile().displayName?.trim();
    session = createProjectSession(seed.files, seed.mainPath, config, {
      demoHistory: seed.demoHistory,
      ...(displayName ? { displayName } : {}),
      // Pass the per-project blob store so the local/solo path can run the
      // hydration-gated orphan sweep (a connected session never sweeps). Absent
      // (null, e.g. no IndexedDB) ⇒ no GC + no blob channel, as before.
      ...(blobStore ? { blobStore } : {}),
    });
    SESSION_CACHE.set(key, session);
  }
  return session;
}

export function ProjectApp({
  config,
  projectName,
  onOpenLibrary,
  onRenameProject,
  initialFiles,
  mainPath,
  demoHistory,
}: {
  config: CollabConfig;
  projectName?: string;
  onOpenLibrary?: () => void;
  /**
   * Commit a new project name (project-model redesign §5). Owned by UnifiedRoot
   * (which writes the registry + updates its header state). Absent on shells that
   * don't support rename (e.g. a joined/shared room) — the header name is then
   * static.
   */
  onRenameProject?: (name: string) => void;
  /**
   * The resolved first-boot seed (project-model redesign §2). Defaults to the
   * blank starter so a direct ProjectApp mount (or a path that doesn't resolve a
   * pending seed) gets a minimal compiling project rather than the Einstein demo.
   */
  initialFiles?: SeedFile[];
  mainPath?: string;
  /** Seed the Einstein 1905 demo version history (Einstein template path only). */
  demoHistory?: boolean;
}) {
  // Obtain the session once (lazy ref over the page-lifetime cache) so neither
  // StrictMode's double-invoke nor a route remount can make two docs over the
  // same persisted project — same discipline as App's collab session, hoisted
  // to module scope now that the router can unmount/remount this shell.
  const projectId = config.room ?? "default";

  // #7 7D: the per-project binary BlobStore (bytes for content-addressed image
  // pointers), keyed by the SAME projectId as the version store / blob DB. Built
  // once per project; null when IndexedDB is unavailable (SSR/tests) so binary
  // resolution is simply skipped — never a construction throw. Hoisted ABOVE the
  // session init so it can be threaded into createProjectSession (the local path's
  // orphan GC needs it) — a single shared instance for the session + the UI.
  const blobStore = useMemo(() => {
    try {
      if (typeof indexedDB === "undefined") return null;
      return new PersistentBlobStore(new IndexeddbBlobBackend(blobDbName(projectId)));
    } catch {
      return null;
    }
  }, [projectId]);

  const sessionRef = useRef<ProjectSession | null | undefined>(undefined);
  if (sessionRef.current === undefined) {
    sessionRef.current = obtainProjectSession(
      config,
      {
        files: initialFiles ?? BLANK_STARTER_FILES,
        mainPath: mainPath ?? BLANK_STARTER_MAIN,
        demoHistory: demoHistory ?? false,
      },
      blobStore,
    );
  }
  const session = sessionRef.current!;
  const project = session.project;

  // Save-state surfacing (#18.2): the local draft is persisted to IndexedDB by
  // the session's DraftStore, but silently. Read that existing seam — the
  // session's `whenReady` (which awaits the store's `synced` load) for the
  // initial-load gate, and the project `Y.Doc`'s `update` events to mark a write
  // in flight — and surface a calm topbar badge. Additive + read-only.
  const saveTarget = useMemo<SaveStateTarget>(
    () => ({
      whenSynced: session.whenReady,
      // C1: the raw load (rejects if IndexedDB never initialized) → the at-risk
      // save state. Local sessions only; connected joiners omit it (relay-backed).
      // Conditional spread keeps `exactOptionalPropertyTypes` happy (no explicit
      // `undefined` value) and leaves the target inert when there's no local store.
      ...(session.whenPersisted ? { whenPersisted: session.whenPersisted } : {}),
      onChange: (cb) => {
        const ydoc = session.project.doc;
        ydoc.on("update", cb);
        return () => ydoc.off("update", cb);
      },
    }),
    [session],
  );

  const [refreshTick, forceRefresh] = useState(0);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // #7 7D binary assets: the binary row being inline-renamed (a SEPARATE id from
  // `renamingId` — a text `rename` on a binary id throws; `renameValue` is shared
  // since only one inline input is ever open). Drop-highlight targets (the whole
  // pane, or one folder row). And the asset currently open in the preview modal.
  const [renamingBinaryId, setRenamingBinaryId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [binaryPreviewId, setBinaryPreviewId] = useState<string | null>(null);
  // The hidden picker driving the "Upload" affordance + the ⌘K "Insert image…"
  // command. `uploadModeRef` carries whether the pick just uploads or also
  // inserts a figure at the cursor — set synchronously in the click→change
  // gesture, so it is never stale.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadModeRef = useRef<"files" | "insert">("files");
  // Serializes overlapping upload gestures (double ⌘V, quick drops) so each plans
  // against the state the previous one already committed — no two concurrent runs
  // mint the same path (which would block compile via duplicatePaths()).
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());
  // #12 folders — folders are DERIVED from paths (ADR-0013), so collapse state is
  // purely VIEW state: an ephemeral Set of collapsed folder prefixes (default
  // expanded), never persisted, never in the CRDT. `folderRenaming` tracks the
  // inline folder-rename edit (a folder prefix → its draft new prefix).
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [folderRenaming, setFolderRenaming] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  // The per-folder "New subfolder…" inline input: the parent prefix currently
  // accepting a subfolder name (null = no input open) + its draft value. Mirrors
  // the folder-rename pattern above — purely ephemeral VIEW state, never in the
  // CRDT; one inline input open at a time.
  const [subfolderParent, setSubfolderParent] = useState<string | null>(null);
  const [subfolderValue, setSubfolderValue] = useState("");
  // Guards the Escape cancel path against the input's trailing onBlur (see
  // commitSubfolder); a ref so the blur sees the cancel synchronously.
  const cancelSubfolderRef = useRef(false);
  // The same guard for the file-rename and folder-rename inline inputs: Escape
  // clears the renaming state, but the input's trailing onBlur (as it unmounts)
  // would otherwise re-fire commit with the stale draft and APPLY the rename the
  // user just cancelled. The ref makes that blur a no-op.
  const cancelRenameRef = useRef(false);
  const cancelFolderRenameRef = useRef(false);
  // Right-click context menu over a tree row: the target + the anchor point.
  // Pure VIEW state — the menu only dispatches to the existing file-op handlers.
  const [treeMenu, setTreeMenu] = useState<{
    target: TreeMenuTarget;
    anchor: MenuPoint;
  } | null>(null);
  // C3: a typed, shell-root status banner (severity drives ARIA role) — see
  // app-notice.ts. `setNotice(null)` clears; failures use errorNotice(...).
  const [notice, setNotice] = useState<AppNotice | null>(null);
  // #23.1 data-durability guard: best-effort persistent-storage request + a
  // health read on mount, surfaced as a calm dismissible nudge ONLY when at-risk
  // (transient eviction risk OR storage nearly full). Null until resolved; an
  // "ok"/"unknown" outcome renders NOTHING (additive — healthy/unsupported envs
  // are byte-for-byte unchanged). `durabilityDismissed` gates it to once/session.
  const [durability, setDurability] = useState<DurabilityStatus | null>(null);
  const [durabilityDismissed, setDurabilityDismissed] = useState(false);
  // Tracked separately from `durability` so the save-status popover can tailor its
  // "keep a copy safe" cue: a TRANSIENT origin (browser hasn't granted persistent
  // storage — private/incognito clears IndexedDB on close) gets a stronger, more
  // specific warning than the generic local-only reminder.
  const [persistState, setPersistState] = useState<PersistState | null>(null);
  // M9: a fresh incognito/transient origin gets NO existing nudge (the #23.1
  // durability guard only fires near the storage cap), so it would silently risk
  // losing the user's work on close. A one-time dismissible top-level info banner
  // (below) warns up front; this gates the in-session hide (the dismissal also
  // persists via localStorage so it never re-nags across loads).
  const [transientWarningDismissed, setTransientWarningDismissed] = useState(false);
  // Share-join readiness (#14-C handshake): a joiner that booted CONNECTED starts
  // with an EMPTY doc — the room's content only arrives over the wire (the relay's
  // first sync step2). Until then the empty editor is "not loaded yet", not "the
  // document". We show a calm, NON-BLOCKING "Syncing…" cue (the editor stays live —
  // Yjs merges anything typed early, so we never lock the data-critical join path).
  // Starts "syncing" only for a connected boot; → "done" on first sync, or on the
  // timeout IF synced. H3: if the timeout fires UNSYNCED it goes "stalled" (a loud
  // warning) instead of silently vanishing into a blank-looking doc; a late sync
  // self-heals it back to "done". See join-sync.ts.
  const [joinSync, setJoinSync] = useState<JoinSyncPhase>(() =>
    config.syncUrl !== undefined ? "syncing" : "done",
  );
  // Share/Connect (#14-C): collaboration is an EXPLICIT action, never default-on.
  // The session boots LOCAL; clicking Share live-upgrades it to a shared room and
  // swaps the editor's awareness over to the connection's. A session that booted
  // CONNECTED (a joiner opening a share link) starts with these already set.
  const [connection, setConnection] = useState<CollabConnection | undefined>(() => session.connection);
  // M8: a live connection means a SHARED session, where `offline` is a real
  // signal (edits aren't reaching peers); solo-local sessions suppress it.
  const saveState = useSaveState(saveTarget, { shared: connection !== undefined });
  const [activeAwareness, setActiveAwareness] = useState<Awareness>(() => session.awareness);
  // ADR-0025 §8.2: the auto-apply path reads the LIVE awareness for the single-
  // auto-applier election WITHOUT re-subscribing the serialized chain on every
  // awareness swap — mirror it into a ref the (stable) chain reads fresh.
  const activeAwarenessRef = useRef(activeAwareness);
  activeAwarenessRef.current = activeAwareness;
  const [peers, setPeers] = useState<RosterPeer<Presence>[]>([]);
  // C2: the live link phase, derived from the connection's onStatus edges (see
  // link-status.ts). Drives a calm "Reconnecting…"/"Reconnected" banner and dims
  // stale presence while a drop is in flight. "initial" until the first connect.
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("initial");
  // C2: the link cue to render (null = healthy/no connection → no banner).
  const linkCue = connection ? linkStatusCue(linkStatus) : null;
  // B2: the storage-full cue — ORTHOGONAL to the link phase. The relay refused a
  // growth write (a room storage cap was hit), so this peer's edits are saved
  // locally but no longer reaching the room. Dismissible; cleared on a reconnect
  // edge or a fresh frame (see link-status.ts). Null = no episode / dismissed /
  // no connection → no banner.
  const [storageCueState, setStorageCueState] = useState<StorageCueState | null>(null);
  const storageBanner = connection ? storageCue(storageCueState) : null;
  // H3: the join-sync cue (null once resolved → no banner).
  const joinCue = joinSyncCue(joinSync);
  // MCP agent proposals (#16.1, ADR-0020): pending records from the shared
  // mailbox, observed ONLY while a connection exists (a local-only project has
  // no kernel peer by design). Default OFF — empty/disconnected renders nothing.
  const [mcpProposals, setMcpProposals] = useState<ProposalRecord[]>([]);
  // Multi-file agent proposals (`propose_files`): the sibling mailbox, same
  // connection-gated observation, default OFF.
  const [fileProposals, setFileProposals] = useState<FileProposalRecord[]>([]);
  // ADR-0025 §5/§6: the pending mailbox re-projected as RUN GROUPS — one card per
  // agent run (records sharing a `runId`; legacy records form singleton runs).
  // The badge counts these groups (pending runs), and the review pane hosts one
  // RunReviewCard per group. Mirrored from the SAME observers as the flat lists
  // above so it appears/clears without polling.
  const [runGroups, setRunGroups] = useState<RunGroup[]>([]);
  // ADR-0024 §4: the global pending-review surface. The shell-root badge (count
  // of pending proposals, always visible regardless of the sidebar's collapse
  // state) toggles an inline review pane that hosts the EXISTING proposal cards.
  // Default CLOSED — additive; with 0 pending the badge is absent entirely.
  const [reviewPaneOpen, setReviewPaneOpen] = useState(false);
  // Auto-accept (ADR-0023): the operator's armed switch (mirrors the persisted
  // grant), whether a paired-agent grant exists at all (gates the bar), and the
  // audit rows shown in the bar. All default OFF/empty.
  const [autoAccept, setAutoAccept] = useState(false);
  const [agentGrantActive, setAgentGrantActive] = useState(false);
  // ADR-0025 §1 (Task 8): the IN-APP per-project acceptance mode mirror — the
  // second authoritative store the unified Agent access panel governs (the MCP
  // grant's `mode` is `autoAccept`). Initialized from the persisted setting so a
  // reload reflects an in-app Auto choice; default "ask".
  const [inAppMode, setInAppMode] = useState<AgentMode>("ask");
  // The merged Agent-access audit (newest-first): the MCP durable tombstone audit
  // (when a grant exists) + the in-app provenance trail. Default empty.
  const [autoAcceptAudit, setAutoAcceptAudit] = useState<AgentAccessAuditRow[]>([]);
  // Per-session auto-apply bookkeeping (refs — never trigger a re-render):
  //  - ids currently mid-apply (re-entrancy guard against rapid observer fires),
  //  - the highest applied seq PER MAILBOX (the monotonic replay guard, audit is
  //    primary). Two independent kernel seq counters → two high-water marks, or one
  //    mailbox would false-reject the other (see AutoAcceptCtx.lastAppliedSeq).
  //  - cumulative applied volume (the anomalous-burst backstop).
  //  - a serial promise chain: auto-applies run ONE AT A TIME so each reads the
  //    seq/volume snapshot AFTER the prior apply commits — without it two concurrent
  //    applies share a pre-loop snapshot and jointly slip past the seq/volume gates.
  const autoApplyInFlight = useRef<Set<string>>(new Set());
  // B1: per-proposal in-flight guard for the now-ASYNC multi-file Accept — the
  // accept awaits the blob-presence gate, during which a second click / a run
  // batch / the auto path could re-enter for the SAME id. This makes the accept
  // settle EXACTLY ONCE per id (a concurrent re-entry returns false immediately),
  // so the plan is never applied twice. The id is released in a `finally`.
  const fileAcceptInFlight = useRef<Set<string>>(new Set());
  const lastAppliedSeqRef = useRef<{ mcpProposals: number | null; mcpFileProposals: number | null }>({
    mcpProposals: null,
    mcpFileProposals: null,
  });
  const appliedVolumeRef = useRef<{ ops: number; bytes: number }>({ ops: 0, bytes: 0 });
  const autoAcceptChain = useRef<Promise<void>>(Promise.resolve());
  // ADR-0025 §8.1 Ask→Auto FUTURE-records-only: a record is auto-eligible only if
  // mode was Auto at the instant its mailbox-arrival was FIRST observed by this
  // tab — so flipping Ask→Auto never retroactively auto-applies the existing
  // pending backlog. First-sight is recorded here, once per id, on each refresh.
  const autoEligibilityRef = useRef(newAutoEligibility());
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // B19-sharing-roles: the access level the NEXT-minted share link grants. The
  // host toggles this in the Share popover BEFORE minting; the chosen role is
  // encoded into the link and carried on this peer's presence. Defaults to the
  // historical `editor` (backward compatible: an unchanged Share mints an
  // editor link, byte-for-byte the pre-role behavior).
  const [shareRole, setShareRole] = useState<ShareRole>(DEFAULT_SHARE_ROLE);
  // B19-sharing-roles: THIS session's effective access level — the CONNECTION is
  // the source of truth. A LOCAL/owner boot (no live connection) is always an
  // editor (it owns the project). Once connected, the role the connection was
  // ESTABLISHED with decides: the host's live Share upgrade connects as `editor`
  // (so the owner is NOT mistaken for a viewer the instant a connection exists —
  // the previous "has a connection" ⇒ re-parse the owner's role-less URL ⇒
  // fail-closed viewer regression), while a joiner's connection carries the role
  // their link decoded. Only a connection with NO recorded role falls back to the
  // fail-closed `?role=` parse (legacy/path-based `/join/<room>?role=viewer`).
  // Keyed on the `connection` STATE so it recomputes the moment Share sets it.
  // Enforcement is client-side this slice: viewers get the file-ops UI disabled,
  // every file-op handler fails closed, AND the editor binds read-only (below).
  const sessionRole = useMemo<ShareRole>(
    () =>
      resolveSessionRole(
        connection !== undefined,
        session.role,
        config.role ??
          (typeof window !== "undefined"
            ? parseShareRole(new URLSearchParams(window.location.search).get("role"))
            : undefined),
      ),
    [connection, session, config.role],
  );
  const isViewer = sessionRole === "viewer";
  // B19-sharing-roles (SEC): the ONE central client-side write gate. A viewer
  // joined a SHARED room read-only, so EVERY path that mutates the project CRDT /
  // room — not just file create/rename/delete/set-main, but agent/MCP Accept,
  // bibliography, instructions, import/restore, insert-reference, template apply,
  // and folder rename — must fail closed (early-return / no-op) for a viewer and
  // hide/disable its affordance. A local owner/editor (`isViewer === false`) is
  // unaffected: `canMutate` is true, so every gate is a transparent pass-through
  // and the existing owner/editor tests stay green. (Full server-side enforcement
  // is a separate accepted follow-up; this slice makes the UI client write-proof.)
  const canMutate = !isViewer;
  // Share failure (#19.4, spec §8): surfaced as a `Notice` INSIDE the Share
  // popover (where the user just acted), with the actual cause — never a bare
  // string in the agent sidebar.
  const [shareError, setShareError] = useState<string | null>(null);
  // The host's display name (#19.4 host counterpart): seeded from the local
  // profile, editable from the Share popover so a host names themselves at the
  // moment of sharing rather than appearing as the generic "Editor".
  const [displayName, setDisplayName] = useState<string>(
    () => loadLocalProfile().displayName ?? "",
  );
  // #16.3: the active share room id, tracked when WE mint it (Share) or when a
  // CONNECTED boot joins one — so the agent open-project path can REUSE the
  // existing room instead of minting a second. Null until a room is live.
  const [activeShareRoom, setActiveShareRoom] = useState<string | null>(
    // A session that booted CONNECTED (a joiner / CONNECTED-mode boot) already
    // has a live room — seed it so a later agent request reuses it, never mints a
    // second. A LOCAL boot starts null; Share (or the agent path) mints the first.
    () => (session.connection ? config.room ?? null : null),
  );
  // #16.3: the pending agent open-project consent (the blocking modal). Null when
  // nothing is awaiting a decision — the modal renders absent, the shipped path
  // is unchanged. Only ONE consent may be pending at a time (single-consent lock).
  const [agentConsent, setAgentConsent] = useState<AgentOpenConsentPending | null>(null);
  // 14-D authoring surface: the project-instructions editor modal. Closed by
  // default — additive, the shipped path is byte-for-byte unchanged until opened.
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // Styles (Phase 1): the style-switcher modal + its trial-compile state. Closed
  // by default — additive, the shipped path is byte-for-byte unchanged until opened.
  const [styleLibraryOpen, setStyleLibraryOpen] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const [styleTrial, setStyleTrial] = useState<{ style: Style; errors: Diagnostic[] } | null>(null);
  // Save-your-own (styles Phase 2): the user's locally-saved styles, loaded once
  // from localStorage. Empty until the user saves one, so the picker shows only
  // the built-ins by default — the shipped catalog is unchanged.
  const [savedStyles, setSavedStyles] = useState<LocalStyleEntry[]>(() => loadLocalStyles());
  // Remote style catalogs (B4.5 seam). Zero registered sources (the OSS default)
  // ⇒ no async work at all and an empty list — the shipped catalog is unchanged.
  const { remoteStyles, loading: styleSourcesLoading, errors: styleSourceErrors } = useStyleSources();
  // A lazily-created OFFLINE worker for the pre-apply trial compile (built-in
  // styles never need server/packages); cached across applies for the session.
  const trialCompilerRef = useRef<Promise<Compiler> | null>(null);
  // #13 follow-up: the "Insert reference…" label picker modal (⌘K affordance).
  // Closed by default — additive, shipped path unchanged until opened.
  const [insertRefOpen, setInsertRefOpen] = useState(false);
  // #13 contribution reconstruction: the rendered draft contribution statement
  // under review (null ⇒ modal closed). Reviewing is read-only; inserting routes
  // through the Accept gate. Additive — shipped path unchanged until opened.
  const [contributionDraft, setContributionDraft] = useState<string | null>(null);
  // 11.8b selection-scoped revise: a snapshot of the editor selection captured
  // when "Revise selection…" is invoked, plus the prompt's open state. Closed by
  // default — additive, the shipped path is byte-for-byte unchanged until opened.
  const [revisePrompt, setRevisePrompt] = useState<{
    text: string;
    startLine: number;
    endLine: number;
  } | null>(null);
  // Rail & Islands (#19.2): the tiled grid keeps editor/center/sidebar; the file
  // list moved into the rail's dock. The "rail" layout still persists a `files`
  // collapse flag — it now records the file dock's explicit open/closed choice.
  const panes = usePanes("rail");
  // The rail dock: at most ONE docked panel (Files / History / Git / Insert).
  // Files defaults OPEN, but auto-collapses on a first laptop-width run so the
  // preview can render its A5 page near physical size (the dock is a 304px tile
  // that otherwise squeezes the page — and its text — into a cramped pane). An
  // explicit prior choice (rail toggle) wins at any width; one click reopens it
  // and is remembered. Computed once at mount from the persisted choice + the
  // current viewport width; `window` is read lazily (SSR-safe via the guard).
  const [dockState, setDockState] = useState<DockState>(() => {
    const width = typeof window === "undefined" ? Number.NaN : window.innerWidth;
    const filesClosed =
      panes.isCollapsed("files") || shouldBootFilesClosed(readFilesDockPref(), width);
    return initialDockState(filesClosed);
  });
  const dock = dockState.open;
  const insertTab = dockState.insertTab;
  // #H7: roving-focus refs for the Insert tablist (WAI-ARIA arrow-key nav).
  const insertTabRefs = useRef<Partial<Record<InsertTab, HTMLButtonElement | null>>>({});
  /** Close `id` if (and only if) it is the docked panel — panels' onClose. */
  const closePanel = useCallback((id: DockId) => setDockState((s) => closeDockIf(s, id)), []);
  /** Dock a panel (palette commands / programmatic opens). */
  const openPanel = useCallback((id: DockId) => setDockState((s) => openDock(s, id)), []);
  /** Dock the Insert panel at a tab (or switch tabs while docked). */
  const openInsert = useCallback(
    (tab: InsertTab) => setDockState((s) => openInsertTab(s, tab)),
    [],
  );
  /** Tier E #2: open the search dock and focus its input (palette / shortcut). */
  const openSearch = useCallback(() => {
    setDockState((s) => openDock(s, "search"));
    // Focus AFTER the panel commits (it mounts when the dock opens).
    requestAnimationFrame(() => searchPanelRef.current?.focus());
  }, []);
  /** Rail-icon click. An EXPLICIT files toggle also persists the choice. */
  const onRailToggle = (id: DockId) => {
    const next = toggleDock(dockState, id);
    if (id === "files") {
      const filesClosed = next.open !== "files";
      // Record the explicit choice so it wins over the width-based auto-collapse
      // on every later boot, and keep the panes collapse flag in lockstep with
      // the dock so the two layout models never disagree.
      writeFilesDockPref(filesClosed);
      if (panes.isCollapsed("files") !== filesClosed) panes.toggleCollapse("files");
    }
    setDockState(next);
  };
  // The active-file editor view, for click-a-diagnostic-to-jump.
  const editorViewRef = useRef<EditorView | null>(null);
  // Tier E #2 in-doc search: the imperative focus handle for the docked panel's
  // input, and a PENDING cross-file jump. Clicking a search result may need to
  // switch the active file first; the editor remounts on a file switch (it is
  // keyed on `activeFileId`), so we can't jump synchronously — we stash the
  // target offset and an effect fires `jumpToOffset` once the new view is live.
  const searchPanelRef = useRef<SearchPanelHandle | null>(null);
  const [pendingJumpOffset, setPendingJumpOffset] = useState<number | null>(null);
  // Comments Phase A (Layers 3-5). The live thread set is mirrored from the CRDT
  // comments map by an effect keyed on [project] (NOT gated on a connection —
  // comments persist + render locally via y-indexeddb). `activeThread` is the
  // open thread card (its id + the on-screen rect to anchor the card at);
  // `commentDraft` is the in-flight create composer (the snapshotted selection +
  // its anchor rect, before the thread exists). A pending thread-open survives a
  // cross-file jump via `pendingThreadOpen` (mirrors `pendingJumpOffset`).
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [activeThread, setActiveThread] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [commentDraft, setCommentDraft] = useState<
    { selection: CommentSelection; anchor: DOMRect } | null
  >(null);
  const [pendingThreadOpen, setPendingThreadOpen] = useState<string | null>(null);
  // L6 presence: how many OTHER peers currently have the open thread's card open,
  // read off the live awareness roster (0 = local-only or nobody else looking).
  const [threadViewers, setThreadViewers] = useState(0);
  // #11.3 forward sync: the active-file editor cursor, fed to <Preview> with the
  // source map so the preview highlights/scrolls the mapped region. Inert until
  // BOTH a sourceMap and a position are present (see Preview). Reset on file swap.
  const [cursorPos, setCursorPos] = useState<SourceLineCol | undefined>(undefined);
  // Live active-file text mirror for the lazy `@`-completion getters.
  const activeTextRef = useRef<string>("");
  // H2: live mirrors of the active file id + the role's mutate-ability, re-read by
  // the in-app Auto final-apply seam AFTER its checkpoint await (never the stale
  // run-finish closure).
  const activeFileIdRef = useRef<string | null>(null);
  const canMutateRef = useRef<boolean>(false);
  // Concatenated text of the project's `.bib` file(s) — the cite-key source for
  // `@`-completion (roadmap #6: closes the "wired but unfed" gap — a project
  // bibliography now drives real citation autocomplete).
  const bibTextRef = useRef<string>("");
  // `@`-completion (#13/#6): known `<labels>` from the active file alongside cite
  // keys parsed from the project's bibliography file(s).
  // Tier E #2: jump to a search result. If the match is in another file, switch
  // to it and STASH the offset — the editor remounts on the switch, so the
  // effect below fires `jumpToOffset` once the new view is live. Same-file jumps
  // go straight through (the existing view is already current).
  const onSearchJump = useCallback(
    ({ fileId, from }: { fileId: string; from: number }) => {
      setActiveFileId((cur) => {
        if (cur === fileId) {
          jumpToOffset(editorViewRef.current, from);
          return cur;
        }
        setPendingJumpOffset(from);
        return fileId;
      });
    },
    [],
  );
  // Feature #4 search replace: land a set of full-file target texts in ONE
  // author-tagged Y.Doc transaction — the whole replace-all (or its undo) is a
  // single atomic unit, so a peer never observes a half-replaced project.
  // `applyReplaceChanges` performs the ALL-OR-NOTHING base check INSIDE the
  // transaction: each change carries the text it was planned FROM, and if any
  // affected file's live text diverged (a concurrent local/remote edit raced
  // the click), nothing is written and the panel shows a conflict notice — a
  // stale plan can never clobber a collaborator's edit. Each file applies via
  // `applyMinimalDiff` (only the differing middle span is rewritten), the same
  // merge-friendly write the agent Accept path uses. The outer origin carries
  // `authorOrigin(HUMAN)`, identical to the folder-rename batch pattern, so
  // attribution lands on the local user. SEC: a viewer fails closed here too
  // (the panel's affordances are also disabled).
  const onSearchReplace = useCallback(
    (changes: readonly ReplaceChange[]): boolean => {
      if (!canMutate) return false;
      return applyReplaceChanges(
        {
          transact: (fn) => project.doc.transact(fn, authorOrigin(HUMAN)),
          read: (fileId) => project.fileText(fileId)?.toString(),
          write: (fileId, nextText) => {
            const text = project.fileText(fileId);
            if (text) applyMinimalDiff(text, nextText);
          },
        },
        changes,
      );
    },
    [project, canMutate],
  );
  const completionSources = useMemo(
    () => [
      labelCompletionSource(() => labelNames(buildLabelIndex(activeTextRef.current))),
      citeCompletionSource(() => citeKeysFromBibliography(bibTextRef.current)),
    ],
    [],
  );
  // Theme + command-surface state (mirrors App's chrome). Editor preferences
  // moved to the /settings route (#19.7): the editors read them at mount, and
  // returning from /settings remounts this shell, so no prefs state lives here.
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Version history (#12.6): a local IndexedDB VersionStore keyed by this
  // project's id (the room). The panel remounts on `historyEpoch` to re-list.
  const [historyEpoch, setHistoryEpoch] = useState(0);
  // Version compare (#12.6): the read-only diff of two selected versions.
  const [compareData, setCompareData] = useState<{
    comparison: VersionComparison;
    baseLabel: string;
    otherLabel: string;
    /**
     * OPTIONAL Accept action (#17.2 git fetch): when present, the compare overlay
     * shows an "Import these changes" button that applies the reviewed tree as an
     * explicit CRDT transaction. Absent for the read-only version-compare (#12.6).
     */
    onImport?: () => void;
  } | null>(null);
  const versionStore = useMemo(() => new IdbVersionStore(), []);

  // A1 export channel: the blobOpts for an AGENT share-connect — the BlobStore plus
  // the grant-scoped blob-terminal {signer, verifier} (so the browser, the SENDER of
  // the exported PDF, rejects a forged COMPLETE). Read at CALL time (the active grant
  // may change). Undefined when this project has no BlobStore — then no blob channel
  // opens (behavior unchanged). The terminal auth is null until a grant is live (the
  // share-connect paths run with a live grant, so it is present for the export flow).
  type AgentBlobOpts =
    | {
        store: import("@galley/collab").BlobStore;
        terminalSigner?: import("@galley/collab").BlobTerminalSigner;
        terminalVerifier?: import("@galley/collab").BlobTerminalVerifier;
        terminalScopeId?: string;
        onInboundStored?: (hash: string, size: number) => void;
      }
    | undefined;
  // A1 §1: a STABLE identity of the terminal-auth scope — the SAME 5 fields the
  // kernel + buildBlobTerminalAuth derive the terminal key from. A re-consent that
  // mints a new grantId yields a different id, so the channel-auth guarantee
  // recreates the channel instead of keeping a stale verifier. JSON.stringify of a
  // fixed positional array → injective (no field can masquerade as another).
  const terminalScopeId = (s: {
    grantId: string;
    controlRoom: string;
    syncUrl: string;
    projectId: string;
    shareRoom: string;
  }): string =>
    JSON.stringify(["blob-terminal-scope", s.grantId, s.controlRoom, s.syncUrl, s.projectId, s.shareRoom]);
  // A1: blobOpts built from the ACTIVE grant (used on the reuse / reload-rebind
  // paths, where a grant is already live). Undefined when no BlobStore.
  const onInboundStored = (hash: string, size: number): void => inboundStoredRef.current?.(hash, size);
  const agentBlobOpts = (): AgentBlobOpts => {
    if (!blobStore) return undefined;
    const mgr = getControlResponderManager();
    const auth = mgr.getBlobTerminalAuth();
    const grant = mgr.getActiveGrant();
    if (auth === null || grant === null) return { store: blobStore, onInboundStored };
    return {
      store: blobStore,
      onInboundStored,
      terminalSigner: auth.terminalSigner,
      terminalVerifier: auth.terminalVerifier,
      terminalScopeId: terminalScopeId({
        grantId: grant.grantId,
        controlRoom: grant.controlRoom,
        syncUrl: grant.syncUrl,
        projectId: grant.projectId,
        shareRoom: grant.shareRoom,
      }),
    };
  };
  // A1: blobOpts built from an EXPLICIT scope (used on the fresh-mint share path,
  // where the grant is recorded only AFTER this connect). The scope MUST match the
  // open_project handoff so the kernel derives the identical terminal key.
  const buildAgentBlobOpts = (grantId: string, shareRoom: string, syncUrl: string): AgentBlobOpts => {
    if (!blobStore) return undefined;
    const controlRoom = getControlResponderManager().getState().controlRoom;
    if (controlRoom === null) return { store: blobStore, onInboundStored };
    const scope = { grantId, controlRoom, syncUrl, projectId, shareRoom };
    const auth = getControlResponderManager().buildBlobTerminalAuthForScope(scope);
    return auth === null
      ? { store: blobStore, onInboundStored }
      : {
          store: blobStore,
          onInboundStored,
          terminalSigner: auth.terminalSigner,
          terminalVerifier: auth.terminalVerifier,
          terminalScopeId: terminalScopeId(scope),
        };
  };

  // The resolved-bytes cache (hash -> bytes), populated ASYNC from `blobStore` by
  // the effect below. The compile-input build reads it SYNCHRONOUSLY. A ref (not
  // state) because the bytes themselves never need to trigger a render directly —
  // a separate `binaryTick` bump does that once new bytes land.
  const binaryCacheRef = useRef<ResolvedBinaryCache>(new Map());
  const [binaryTick, setBinaryTick] = useState(0);

  // A2/C1a: a STABLE delivery hook the blob channel calls when a verified inbound
  // blob is stored. The expect_blob effect points this at its lease-clearing +
  // delivered-tracking logic; it survives channel recreation (the channel always
  // calls `inboundStoredRef.current`), so a lease is cleared on delivery and the
  // release path knows which hashes are stored.
  const inboundStoredRef = useRef<((hash: string, size: number) => void) | null>(null);

  // A11y (#23.5): the inline version-compare / git-fetch overlay is a `dialog`
  // rendered directly in this shell (no dedicated component), so its focus trap +
  // restore lives here. Inert until `compareData` is set.
  const compareDialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(compareDialogRef, compareData !== null);

  // --- #16.3 Agent Access: per-request open-project consent refs --------------
  // The registered open-project handler is kept stable while always calling the
  // LATEST ensureSharedForAgent (set below, after it is declared) — a ref breaks
  // the declaration-order cycle. The consent lock is a ref so it reads correctly
  // synchronously across the async handler's awaits (state would be stale).
  const ensureSharedRef = useRef<
    (() => Promise<OpenedProject | OpenProjectRefusal>) | null
  >(null);
  // ADR-0024 §3 reuse fast-path: the latest closure that re-attaches an already-
  // consented, MAC-verified, exactly-scope-matched grant WITHOUT re-consent (or
  // null on any miss → the handler falls through to the full consent gate). Held
  // in a ref for the same declaration-order reason as ensureSharedRef.
  const tryReuseGrantRef = useRef<
    | ((
        requestedProjectId: string,
        isRequestLive: () => boolean,
      ) => Promise<OpenedProject | null>)
    | null
  >(null);
  const consentPendingRef = useRef(false);
  // A1 export channel: the latest closure that compiles the current document and
  // pushes the PDF over the project blob channel under a kernel-minted transferId.
  // Held in a ref for the same declaration-order reason as ensureSharedRef — it
  // closes over `exportPdfBytes` (from useCompiler, declared far below), but the
  // open-handler effect registers a STABLE handler that reads this ref at call time.
  const exportCompiledRef = useRef<
    | ((
        transferId: string,
        maxBytes: number,
      ) => Promise<ExportedCompiled | OpenProjectRefusal>)
    | null
  >(null);
  // F9/F5 compile channel: the latest closure that returns the OPEN project's
  // CURRENT preview diagnostics (the live preview already compiled them — no fresh
  // build). Held in a ref for the same declaration-order reason as exportCompiledRef
  // (it closes over `diagnostics`/`pageCount`/`ready` from useCompiler, declared far
  // below); the stable compile handler reads this ref at CALL time.
  const compileBrowserRef = useRef<
    ((projectId: string) => Promise<CompileDiagnostics | OpenProjectRefusal>) | null
  >(null);

  // Authoring surfaces (import wedge #15, figure generator #8, citations #6) are
  // tabs of the ONE docked Insert panel (#19.2); git sync (#17.2) docks too. All
  // still route through the SAME conflict-aware Accept into the ACTIVE file —
  // never auto-apply. Derived flags keep the probe effects below readable.
  const showFigure = dock === "insert" && insertTab === "figure";
  // Multimodal gate (#8/#10): the transport's vision capability, probed lazily
  // on first Figure-panel open (never on mount — no unprompted network on load).
  // Demo model's probe is local/instant → supportsImageInput:false → calm hint.
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | undefined>(undefined);
  // Click-to-rename header (project-model redesign §5): `nameEditing` toggles the
  // inline text input; `nameDraft` is its draft. Enter/blur commits via
  // `onRenameProject`; Escape cancels; empty/whitespace reverts. A ref guards the
  // Escape path against the input's trailing onBlur (same pattern as folder
  // rename above) so a cancel doesn't commit on the way out.
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameRenameCancelledRef = useRef(false);
  // Preview compile-mode (E2): governs the PREVIEW compiler only; the agent/figure
  // loops stay on the local worker this wave. Lazy-read the persisted choice once.
  const [compileMode, setCompileMode] = useState<CompileMode>(() => loadMode());
  // Focus / Zen mode (#18.5): hides the agent panel AND the file pane for a
  // distraction-free editor+preview view.
  const [focusMode, setFocusMode] = useState<boolean>(() => loadFocusMode());
  // Agent mode (#14): the MIRROR of focus mode — hides the EDITOR AND the file
  // pane for an agent+preview view. Mutually exclusive with focus mode.
  const [agentMode, setAgentMode] = useState<boolean>(() => loadAgentMode());
  // Automatic versioning (#10): an opt-in, default-OFF policy that drives the
  // EXISTING snapshot path on an elapsed-time / edit-count cadence (coalesced).
  // Lazy-read the persisted choice once; default is `{enabled:false}` so nothing
  // subscribes and shipped behavior is byte-identical.
  const [autoSnapshotPolicy, setAutoSnapshotPolicy] = useState<AutoSnapshotPolicy>(() =>
    loadAutoSnapshotPolicy(),
  );
  // Quick-fix (#11.4b) / explain (#18.4): a monotonic-nonce request handed to
  // the AgentPanel. `adviceOnly` marks an explain run (text answer, no diff).
  const [pendingRun, setPendingRun] = useState<
    { request: string; nonce: number; adviceOnly?: boolean } | undefined
  >(undefined);
  // Responsive collapse (#11.9): below the breakpoint the 4-column project grid
  // becomes a tabbed files/editor/preview/agent stack. At/above it the layout is
  // byte-for-byte the wide SplitPanes (existing e2e run wide, so unaffected).
  const { narrow } = useResponsive();
  const [activeTab, setActiveTab] = useState<PaneTab>("editor");

  // The agent model: a configured provider or the offline Demo model. Read
  // through the SHARED provider-storage seam (#19.7): the /settings AI-provider
  // section and the legacy single-file shell persist to the same key, so a
  // provider configured in either place reaches this shell's agent.
  const provider = useMemo(() => loadStoredProvider(), []);
  const demoModel = useMemo(() => createDemoModel(), []);
  // #15 model picker: the model id chosen for THIS session (null = the provider's
  // configured default). Lets the agent run against a different model of the same
  // provider without re-saving settings.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const model = useMemo(
    () =>
      provider
        ? createModelClient(selectedModel ? { ...provider, model: selectedModel } : provider)
        : demoModel,
    [provider, demoModel, selectedModel],
  );
  // The picker seam handed to the agent pane: the current model, a lazy lister
  // (the provider's models via its API — direct/Ollama only), and the setter.
  // Built ONLY for a real configured provider; the Demo model has no picker.
  const modelPicker = useMemo(
    () =>
      provider
        ? {
            current: selectedModel ?? provider.model,
            // Bind the global fetch — passing the bare reference would call it as
            // a method inside listModels and throw "Illegal invocation".
            list: () => listModels(provider, globalThis.fetch.bind(globalThis)),
            onSelect: (id: string) => setSelectedModel(id),
          }
        : undefined,
    [provider, selectedModel],
  );

  // FigurePanel verify (#8): the CeTZ verify step needs a server compiler to
  // resolve `@preview/cetz`. Offer it ONLY when a trusted compile URL is
  // configured (same reachability gate as package routing, P0-b); otherwise omit
  // the prop so the panel keeps its honest "could not verify offline" status
  // (exactOptionalPropertyTypes — never pass `undefined`).
  const verifyCompilerFactoryProp = useMemo(
    () => (serverCompileReachable() ? { verifyCompilerFactory: createVerifyCompiler } : {}),
    [],
  );

  // Drop stale capabilities when the active model changes so the next panel
  // open re-probes the new transport (keeps the gate honest after a switch).
  useEffect(() => {
    setCapabilities(undefined);
  }, [model]);

  // Probe-on-open (#8/#10): when the Figure panel opens and we have no
  // capabilities for the current model yet, probe ONCE. Network-frugal: the
  // Demo model probes locally/instantly; a real provider does a single check.
  useEffect(() => {
    if (!showFigure || capabilities !== undefined) return;
    let cancelled = false;
    model
      .probe()
      .then((caps) => {
        if (!cancelled) setCapabilities(caps);
      })
      .catch(() => {
        if (!cancelled) {
          setCapabilities({
            reachable: false,
            supportsStreaming: false,
            supportsToolCalls: false,
            supportsImageInput: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showFigure, capabilities, model]);

  // Refresh on any doc change (file added/renamed/deleted, content edited, or the
  // seed landing after persistence loads). A bumped counter re-reads the snapshot.
  useEffect(() => {
    const bump = () => forceRefresh((n) => n + 1);
    const ydoc = project.doc;
    ydoc.on("update", bump);
    return () => ydoc.off("update", bump);
  }, [project]);

  // #7 7D: async binary-byte resolution for compile. The compile-input build is
  // SYNCHRONOUS, but a binary pointer's bytes load async from the BlobStore. This
  // effect watches the live binary pointers (re-runs on every doc change via
  // `refreshTick`), fetches any hashes MISSING from the cache, populates the
  // cache (a ref), then bumps `binaryTick` ONCE so the compile input rebuilds
  // with the now-resolved bytes. It never blocks render and never throws — a
  // missing/corrupt blob (get → undefined) is simply skipped (the pointer stays
  // unresolved, omitted from the compile input). Default-safe: a text-only
  // project has no pointers, so this is a no-op (no fetch, no tick).
  useEffect(() => {
    if (!blobStore) return;
    const pointers = project.snapshot().binaryFiles;
    const missing = pendingHashes(pointers, binaryCacheRef.current);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      let resolvedAny = false;
      for (const hash of missing) {
        try {
          const bytes = await blobStore.get(hash);
          if (cancelled) return;
          if (bytes) {
            binaryCacheRef.current.set(hash, bytes);
            resolvedAny = true;
          }
        } catch {
          /* a blob read failure leaves the pointer unresolved (skipped) */
        }
      }
      if (!cancelled && resolvedAny) setBinaryTick((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
    // refreshTick: re-evaluate the pending set after every doc change (a new
    // binary pointer, e.g. just-seeded import binaries, must get fetched).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobStore, project, refreshTick]);

  // #7 7D: consume this project's PENDING binary pointers (stashed by an import's
  // Accept handler, which already wrote the bytes into THIS project's BlobStore).
  // Run ONLY after `session.whenReady` so the text `seedIfPristine` has already
  // landed — creating these pointers writes CRDT history, which would otherwise
  // suppress the pristine-gated text seed. Consume-once (`takePendingBinarySeed`)
  // so a StrictMode double-invoke can't double-create. Default-safe: a project
  // with no pending pointers is a no-op.
  useEffect(() => {
    if (!canMutate) return; // a viewer never seeds binaries
    let cancelled = false;
    void session.whenReady
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        const pending = takePendingBinarySeed(projectId);
        if (!pending || pending.length === 0) return;
        project.doc.transact(() => {
          for (const p of pending) project.createBinary(p.path, p.asset, HUMAN);
        }, authorOrigin(HUMAN));
        // Servable-provenance: the reviewed import's binary pointers have now
        // COMMITTED into this project's doc (the user Accepted the import; the
        // import-create staging `put` left the bytes NEUTRAL). Grant each imported
        // hash ONLY now — after the pointers land, never at that staging `put`.
        if (blobStore) {
          for (const p of pending) {
            await blobStore.markServable(p.asset.hash).catch(() => undefined);
          }
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, project, projectId]);

  // #7 7D window-level drag guard. Two jobs, both independent of any dropzone:
  //  1. NAVIGATION guard — a Files drop that misses every registered dropzone
  //     (top bar, preview, a viewer pane) would otherwise make the browser
  //     NAVIGATE to the file, replacing the app mid-session. preventDefault on a
  //     Files dragover/drop (only when a more specific handler hasn't already
  //     claimed it) keeps the app put.
  //  2. HIGHLIGHT reset — an aborted drag (Escape) or a drop outside the pane
  //     never fires our row/pane `dragleave`, so clear the drop-highlight on any
  //     drag end/drop as a belt-and-braces reset.
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const onWinDragOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onWinDrop = (e: DragEvent) => {
      if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
      setDropActive(false);
      setDropFolder(null);
    };
    const onWinDragEnd = () => {
      setDropActive(false);
      setDropFolder(null);
    };
    window.addEventListener("dragover", onWinDragOver);
    window.addEventListener("drop", onWinDrop);
    window.addEventListener("dragend", onWinDragEnd);
    return () => {
      window.removeEventListener("dragover", onWinDragOver);
      window.removeEventListener("drop", onWinDrop);
      window.removeEventListener("dragend", onWinDragEnd);
    };
  }, []);

  // #23.1 data-durability guard. Once on mount: request persistent storage
  // (best-effort, fire-and-forget — NEVER blocks boot, NEVER throws) and read the
  // storage estimate, then derive a durability status. Stored in state so the
  // nudge can render when at-risk. The wrappers swallow all failures, so an
  // unsupported environment resolves to "unsupported" → level "unknown" → no UI.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const persistState = await requestPersistentStorage();
      const estimate = await estimateStorage();
      if (cancelled) return;
      setPersistState(persistState);
      setDurability(durabilityStatus({ persistState, estimate }));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the join "Syncing…" cue when the relay's initial state lands (first
  // step2 — `connection.onSynced`), or at a short timeout (H3: LOUD if still
  // unsynced — the editor was never blocked regardless). Only a CONNECTED-boot
  // joiner runs this; a host-upgraded session has its content already and
  // `joinSync` started "done".
  useEffect(() => {
    if (joinSync === "done") return;
    const conn = session.connection;
    if (!conn) {
      setJoinSync("done");
      return;
    }
    // Self-heal: a (possibly late) first sync always resolves to done — the
    // subscription stays live past the timeout so a stalled cue clears the moment
    // the relay's state finally lands (the transport keeps retrying — C2).
    const off = conn.onSynced(() => setJoinSync("done"));
    // H3: branch on `synced` at the timeout — synced ⇒ done (silent), else go
    // LOUD ("Couldn't reach the room — still trying") instead of clearing to a
    // blank-looking empty doc.
    const timer = setTimeout(() => setJoinSync(joinPhaseOnTimeout(conn.synced)), 5_000);
    return () => {
      off();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once-per-mount; conn is stable
  }, []);

  // Keep the active file pointing at a LIVE file, re-checked on every doc update
  // (`refreshTick`). Two cases this must handle now that the project is shareable:
  //  - a CONNECTED join (#14-C) resolves `whenReady` while the doc is still EMPTY;
  //    the main file only arrives over the wire, so we adopt it on a later update;
  //  - a REMOTE peer can delete the file this client is editing — we must switch
  //    off the tombstone rather than keep editing a hidden file.
  // A still-live user selection is preserved; otherwise fall back to the live main
  // file, else the first live file, else nothing.
  useEffect(() => {
    setActiveFileId((cur) => {
      const live = project.snapshot().files.filter((f) => !f.deleted);
      if (cur && live.some((f) => f.fileId === cur)) return cur;
      const main = project.mainFileId();
      if (main && live.some((f) => f.fileId === main)) return main;
      return live[0]?.fileId ?? null;
    });
  }, [project, refreshTick]);

  // Tier E #2: flush a pending cross-file search jump once the editor for the
  // newly-active file has mounted (it remounts on the file switch and re-sets
  // `editorViewRef` via `onView`). Keyed on `activeFileId` so it runs AFTER the
  // remount commit; `jumpToOffset` clamps the offset, so a stale target is safe.
  useEffect(() => {
    if (pendingJumpOffset == null) return;
    jumpToOffset(editorViewRef.current, pendingJumpOffset);
    setPendingJumpOffset(null);
  }, [activeFileId, pendingJumpOffset]);

  // Comments reactivity bridge (Comments Phase A, Layer 4): mirror the CRDT
  // comments map into `threads` and keep it current — a thread arriving, a reply
  // appended, a status flipped. Keyed on [project] ONLY and NOT gated on a
  // connection: comments live + persist LOCALLY via y-indexeddb, so a connection
  // gate would make them vanish offline. `observeComments` is `observeDeep`, so
  // nested message/status mutations surface without polling.
  useEffect(() => {
    const refresh = () => setThreads(getThreads(project));
    refresh();
    return observeComments(project, refresh);
  }, [project]);

  // Comments Phase A (Layer 6): a light "N viewing" presence cue. While a thread
  // card is open, advertise its id on this peer's presence (cleared on close /
  // unmount) and count how many OTHER peers have the SAME thread focused, off the
  // existing awareness "change" stream. Local-only (no connection) is a no-op:
  // `setLocalFocusedThread` short-circuits with no presence, and the count stays 0.
  useEffect(() => {
    if (!connection) return;
    const focusedId = activeThread?.id ?? null;
    connection.setLocalFocusedThread(focusedId);
    if (focusedId === null) {
      setThreadViewers(0);
      return;
    }
    const aw = connection.awareness;
    const recount = () =>
      setThreadViewers(
        connection
          .presences()
          .filter((p) => p.focusedThreadId === focusedId).length -
          // Exclude self — this peer is already advertising the same id.
          1,
      );
    recount();
    aw.on("change", recount);
    return () => {
      aw.off("change", recount);
      // Stop advertising on close / a connection swap so a stale id doesn't linger.
      connection.setLocalFocusedThread(null);
    };
  }, [connection, activeThread?.id]);

  // Comments Phase A: flush a pending cross-file thread-open once the target
  // file's editor has remounted (mirrors the search/inverse-sync jump stash). The
  // gutter marker for the thread isn't on screen yet, so anchor the card at the
  // jumped cursor's coords (or a viewport fallback). Keyed on `activeFileId` so it
  // runs AFTER the remount commit.
  useEffect(() => {
    if (pendingThreadOpen == null) return;
    const id = pendingThreadOpen;
    setPendingThreadOpen(null);
    const view = editorViewRef.current;
    // Scroll the remounted editor to the anchor BEFORE reading its caret rect —
    // mirroring the same-file jump branch + the `pendingJumpOffset` flush. Without
    // this the editor stays at the top and the card floats centered, disconnected
    // from the off-screen anchor.
    const thread = getThread(project, id);
    const range = thread ? resolveThreadRange(project, thread) : null;
    if (range) jumpToOffset(view, range.from);
    const rect = caretRectForThread(view, project, id);
    setActiveThread({ id, anchor: rect });
  }, [activeFileId, pendingThreadOpen, project]);

  // 14-D: the project's `.galley/instructions` steering + deterministic
  // constraints, read from the live snapshot and re-derived on every doc update
  // (`refreshTick`). Absent (the default for every project — there is no
  // creation UI yet) → `undefined`, so the agent run stays byte-for-byte the
  // original behavior. `readProjectInstructions` never throws.
  const agentInstructions = useMemo(
    () => readProjectInstructions(project.snapshot().files),
    [project, refreshTick],
  );

  // #11.3 forward sync: a file swap remounts the editor, so the prior file's
  // cursor no longer maps to the (new) active file's preview. Clear it so no stale
  // highlight lingers; the new editor re-emits on its first selection.
  useEffect(() => {
    setCursorPos(undefined);
  }, [activeFileId]);

  // Connected mode (#14-C): track the live set of peers (incl. self) from the
  // connection's awareness, exactly like App.tsx. Re-subscribes if a Share
  // upgrade swaps a connection in.
  useEffect(() => {
    if (!connection) return;
    const aw = connection.awareness;
    const update = () =>
      // L7: keep the awareness clientID per row and mark the local client (`aw.clientID`)
      // so the roster can label it "(you)" — two tabs are two distinct clients, otherwise
      // indistinguishable "Editor" rows.
      setPeers(
        buildPresenceRoster(
          [...aw.getStates().entries()].filter(
            (e): e is [number, Presence] =>
              typeof e[1] === "object" && e[1] !== null && "author" in e[1],
          ),
          aw.clientID,
        ),
      );
    update();
    aw.on("change", update);
    return () => aw.off("change", update);
  }, [connection]);

  // C2: surface the link status. `onStatus` emits "connected"/"disconnected" on
  // every (re)open + drop — nothing consumed it, so a dropped socket was invisible.
  // Subscribe per connection identity (a Share upgrade swaps a new one in) and feed
  // the pure phase reducer. Reset to "initial" for each connection so a fresh join
  // never inherits a stale phase; the real WebSocket fires "connected" async AFTER
  // this subscription, so the first connect is always observed (no late-subscribe
  // miss). The functional update avoids stale-closure phases.
  useEffect(() => {
    if (!connection) {
      setLinkStatus("initial");
      setStorageCueState(null);
      return;
    }
    setLinkStatus("initial");
    // B2: a fresh connection starts with no storage-full episode. (A Share upgrade
    // swaps a new connection in; don't inherit a stale cue.)
    setStorageCueState(null);
    const offStatus = connection.onStatus((status) => {
      setLinkStatus((prev) => reduceLinkStatus(prev, status));
      // B2: feed the storage cue the SAME connection edges so a reconnect
      // (connected AFTER disconnected) clears an active storage-full episode — a
      // fresh sync exchange re-offers the diff, which either heals or re-triggers
      // a new frame that re-shows the cue.
      setStorageCueState((prev) =>
        reduceStorageCue(
          prev,
          status === "connected" ? { type: "connected" } : { type: "disconnected" },
        ),
      );
    });
    // B2: the relay's storage-full control frame → (re)show the cue. A new frame
    // is a new episode and always re-shows, dismissed or not.
    const offStorageFull = connection.onStorageFull((info) =>
      setStorageCueState((prev) => reduceStorageCue(prev, { type: "storage-full", info })),
    );
    return () => {
      offStatus();
      offStorageFull();
    };
  }, [connection]);

  // C2: auto-dismiss the brief "Reconnected." confirmation ~3s after recovery.
  // Scoped to the reconnected phase; the cleanup clears the timer if the phase
  // changes first (e.g. a fresh drop), so a stale timer can't dismiss a new cue.
  useEffect(() => {
    if (linkStatus !== "reconnected") return;
    const timer = setTimeout(() => setLinkStatus((prev) => reduceLinkStatus(prev, "settle")), 3_000);
    return () => clearTimeout(timer);
  }, [linkStatus]);

  // L6: staleness degrade. `onStatus` only fires on a real (re)open/drop, so a link
  // that stays "online" while its peer quietly vanishes — the joiner whose host
  // left, the relay socket still healthy so no `disconnected` edge ever comes —
  // would sit "online" forever over a dead session. Arm a stale timer while online
  // and RE-ARM it on every inbound-liveness signal we already receive, so the cue
  // fires only after real silence, never during live collaboration:
  //   - remote-origin doc updates: the connection applies inbound peer edits to the
  //     doc with `origin === connection` (its echo-suppression contract), so that
  //     identity means "another peer just edited". Local edits use an author/null
  //     origin and do NOT reset — a solo, silent room is honestly "may have ended".
  //   - remote awareness changes: peer cursor/selection/presence updates (and a
  //     join/leave) are applied with the same `origin === connection`. Even a
  //     fully-idle present peer keeps this alive: y-protocols' Awareness renews its
  //     own state every ~15s (outdatedTimeout/2) and the connection broadcasts it,
  //     landing here as an `origin === connection` awareness update.
  // Any status edge changes `linkStatus`, tearing this effect down (which stops the
  // timer) and — for a recovering edge — rebuilding it, so the phase transition both
  // clears the cue and resets the clock; the degrade is never a dead end. Only a
  // client that is genuinely alone (no peer renewals arriving) stays quiet long
  // enough to degrade (see STALE_AFTER_MS for the 3×-outdatedTimeout derivation).
  useEffect(() => {
    if (linkStatus !== "online" || !connection) return;
    const timer = createStaleTimer(() =>
      setLinkStatus((prev) => reduceLinkStatus(prev, "stale")),
    );
    const ydoc = project.doc;
    const aw = connection.awareness;
    const onInbound = (_payload: unknown, origin: unknown) => {
      if (origin === connection) timer.bump();
    };
    ydoc.on("update", onInbound);
    aw.on("update", onInbound);
    return () => {
      timer.stop();
      ydoc.off("update", onInbound);
      aw.off("update", onInbound);
    };
  }, [linkStatus, connection, project]);

  // MCP mailbox (#16.1): while shared, mirror the pending proposals into state.
  // Mirror the active grant's audit into the bar (newest-first). A no-op shape
  // when there is no grant/store. Declared before the observers + subscription
  // effect that depend on it (ADR-0023 §5).
  const refreshAutoAcceptAudit = useCallback(() => {
    // Merge the two surfaces' audits into one newest-first list (ADR-0025 §5): the
    // MCP durable tombstone audit (present only while a grant exists) + the in-app
    // provenance trail. Both expose request/fileCount/at/state, so they read the
    // same way; `source` keeps the provenance cue.
    const mcp = getControlResponderManager().getAudit();
    const mcpRows: AgentAccessAuditRow[] =
      mcp === null
        ? []
        : mcp.list().map((e) => ({
            key: `mcp:${e.id}:${e.digest}`,
            request: e.request,
            fileCount: e.fileCount,
            at: e.at,
            state: e.state,
            source: "mcp" as const,
          }));
    const inAppRows: AgentAccessAuditRow[] = readInAppAudit(projectId).map((e) => ({
      key: `in-app:${e.runId}:${e.at}`,
      request: e.request,
      fileCount: e.fileCount,
      at: e.at,
      state: e.state,
      source: "in-app" as const,
    }));
    const merged = [...mcpRows, ...inAppRows].sort((a, b) => b.at - a.at);
    setAutoAcceptAudit(merged);
  }, [projectId]);

  // `observeProposals` is deep (a record arriving OR its status flipping), so
  // the cards appear and clear without any polling. Disconnected → cleared.
  useEffect(() => {
    if (!connection) return;
    const refresh = () => {
      const pending = getPendingProposals(project);
      setMcpProposals(pending);
      // ADR-0025 §5: re-project the whole pending mailbox into run groups for the
      // run-card surface (single- + multi-file alike, so refresh from either
      // observer keeps the grouping current).
      setRunGroups(getPendingRunGroups(project).groups);
      // ADR-0023: drive each pending record through the auto-accept gate (a no-op
      // unless armed + signed + clean). The decision core + the started-tombstone
      // make repeated fires idempotent, so fire-and-forget is safe.
      // Serialize through the chain so each apply reads a FRESH seq/volume snapshot
      // (concurrent applies sharing a pre-loop snapshot would slip the burst gates).
      // ADR-0025 §8.1: capture each record's mode-at-first-sight; only records first
      // SEEN under Auto are eligible — a flip Ask→Auto never auto-applies the backlog.
      const liveMode = getControlResponderManager().getActiveGrant()?.mode ?? null;
      for (const p of pending) {
        const eligible = observeAutoEligibility(autoEligibilityRef.current, p.id, liveMode);
        if (!eligible) continue;
        autoAcceptChain.current = autoAcceptChain.current
          .then(() => runAutoAcceptRef.current("single", p))
          .catch(() => {});
      }
    };
    refresh();
    const unobserve = observeProposals(project, refresh);
    return () => {
      unobserve();
      setMcpProposals([]);
      setRunGroups([]);
    };
  }, [connection, project]);

  // The sibling multi-file mailbox (`propose_files`): same connection-gated
  // mirror into state, observed deeply so cards appear/clear without polling.
  useEffect(() => {
    if (!connection) return;
    const refresh = () => {
      const pending = getPendingFileProposals(project);
      setFileProposals(pending);
      setRunGroups(getPendingRunGroups(project).groups);
      // ADR-0025 §8.1: same future-records-only capture as the single mailbox.
      const liveMode = getControlResponderManager().getActiveGrant()?.mode ?? null;
      for (const p of pending) {
        const eligible = observeAutoEligibility(autoEligibilityRef.current, p.id, liveMode);
        if (!eligible) continue;
        autoAcceptChain.current = autoAcceptChain.current
          .then(() => runAutoAcceptRef.current("file", p))
          .catch(() => {});
      }
    };
    refresh();
    const unobserve = observeFileProposals(project, refresh);
    return () => {
      unobserve();
      setFileProposals([]);
      setRunGroups([]);
    };
  }, [connection, project]);

  // ADR-0024 §4: keep the global review pane in step with the pending set for an
  // EDITOR — auto-open it the moment a proposal lands (so the review surface is
  // immediately reachable without hunting for the sidebar), and auto-collapse it
  // once nothing is pending so a stale empty pane never lingers. The badge stays
  // a manual toggle in between. A viewer never opens a pane (no Accept), so this
  // is gated on `canMutate`.
  // The empty→pending EDGE that auto-opens/closes the pane is driven by whether
  // ANY record is pending (unchanged from ADR-0024); the badge itself now COUNTS
  // RUNS (`runGroups.length`, ADR-0025 §6), which is zero exactly when nothing is
  // pending — so the auto-open/close behavior is preserved.
  const pendingReviewCount = mcpProposals.length + fileProposals.length;
  const pendingRunCount = runGroups.length;
  const hadPendingRef = useRef(false);
  useEffect(() => {
    if (pendingReviewCount === 0) {
      if (reviewPaneOpen) setReviewPaneOpen(false);
      hadPendingRef.current = false;
      return;
    }
    // Open once on the empty→pending edge (editors only); leave manual toggles be.
    if (canMutate && !hadPendingRef.current) setReviewPaneOpen(true);
    hadPendingRef.current = true;
  }, [pendingReviewCount, canMutate, reviewPaneOpen]);

  // Reload re-bind (ADR-0023 §4): a page reload drops the project-room connection,
  // and open_project is one-shot per kernel session — so without this the tab is
  // silently stranded (no card can ever render). If Agent Access resumed AND a
  // persisted grant matches THIS project (and this isn't a joined session), re-
  // establish the SAME already-consented share room WITHOUT re-prompting consent.
  // The grant LOADS ASYNC on resume (a WebCrypto MAC check — review Medium-1), so
  // we DON'T read it once on mount; we drive rebind from the manager subscription
  // and fire it (once) the moment an eligible grant appears.
  const rebindAttempted = useRef(false);

  // F10 (ADR-0023 §4): a fresh page's eligibility tracker is empty and the grant
  // MAC-load is async, so a mailbox observer that fires before the grant resolves
  // can fix a resumed-Auto backlog ineligible forever. This once-per-attach guard
  // drives a single re-evaluation that promotes the pending UNWATCHED paired-agent
  // records once a connection exists AND the grant has loaded Auto. Reset on every
  // disconnect/teardown (and on projectId change, via the effect remount) so a
  // genuine later reattach re-evaluates again.
  const reattachReevaluated = useRef(false);
  // Switching projects is a fresh attach surface — re-evaluate once for the new
  // project's resumed-Auto backlog.
  useEffect(() => {
    reattachReevaluated.current = false;
  }, [projectId]);

  // Mirror the Agent Access grant into the bar's state (ADR-0023 §5): whether a
  // paired-agent grant exists (gates the bar), the persisted armed switch, and the
  // audit — AND drive the reload re-bind. The manager emits on recordGrant /
  // setGrantMode / enable / disable / the async resume, so the bar appears
  // and the share re-binds once the grant is live (the grant is the source of truth).
  useEffect(() => {
    const manager = getControlResponderManager();
    const sync = () => {
      const grant = manager.getActiveGrant();
      const active = grant !== null && grant.projectId === projectId;
      setAgentGrantActive(active);
      setAutoAccept(active && grant!.mode === "auto");
      refreshAutoAcceptAudit();
      // Re-bind ONCE when an eligible, matching grant first appears and nothing is
      // connected yet (the live `session.connection`, not the React mirror, is the
      // truth here). A joined session never re-binds.
      if (
        !rebindAttempted.current &&
        active &&
        manager.isEnabled() &&
        config.syncUrl === undefined &&
        session.connection === undefined
      ) {
        rebindAttempted.current = true;
        const room = grant!.shareRoom;
        const url = grant!.syncUrl;
        void session.whenReady.then(() => {
          if (session.connection) return; // a Share/open raced us to it
          try {
            // A1: open the blob channel on the reload re-bind too, so a paired
            // agent's export_compiled keeps working after a browser reload.
            const conn = connectProjectSession(
              session,
              url,
              room,
              {},
              "editor",
              agentBlobOpts(),
            );
            setConnection(conn);
            setActiveAwareness(conn.awareness);
            setActiveShareRoom(room);
          } catch {
            setNotice(
              errorNotice(
                "The agent share could not reconnect after reload — reopen the project from the agent.",
              ),
            );
          }
        });
      }
      // F10: once per (re)attach, AFTER a connection exists AND the grant has
      // loaded Auto, promote the pending UNWATCHED paired-agent records and re-drive
      // them through the auto-apply chain. Driving this from the manager
      // subscription (which re-emits when the grant resolves Auto) closes the race
      // where the mailbox observer fired under a not-yet-loaded (null) grant and
      // fixed the backlog ineligible. The `reattachReevaluated` guard makes it fire
      // at most once per attach (the chain + started-tombstone + status gates make
      // it idempotent, but we avoid spurious churn); it resets on disconnect. Uses
      // the LIVE `session.connection` (not the React mirror) consistent with the
      // re-bind block above. Every gate + the single-applier lock still runs inside
      // runAutoAccept.
      if (
        !reattachReevaluated.current &&
        active &&
        grant!.mode === "auto" &&
        config.syncUrl === undefined &&
        canMutate &&
        session.connection !== undefined
      ) {
        reattachReevaluated.current = true;
        const singles = getPendingProposals(project);
        const files = getPendingFileProposals(project);
        promotePendingToEligible(
          autoEligibilityRef.current,
          [...singles.map((p) => p.id), ...files.map((p) => p.id)],
        );
        for (const p of singles) {
          autoAcceptChain.current = autoAcceptChain.current
            .then(() => runAutoAcceptRef.current("single", p))
            .catch(() => {});
        }
        for (const p of files) {
          autoAcceptChain.current = autoAcceptChain.current
            .then(() => runAutoAcceptRef.current("file", p))
            .catch(() => {});
        }
      }
    };
    sync();
    return manager.subscribe(sync);
  }, [projectId, project, canMutate, refreshAutoAcceptAudit]);

  // ADR-0025 §1 (Task 8): seed the IN-APP acceptance-mode mirror from the persisted
  // per-project setting whenever the project changes, so the unified panel reflects
  // an in-app Auto choice across reloads/project switches. Default "ask".
  useEffect(() => {
    setInAppMode(getProjectAcceptanceMode(projectId));
  }, [projectId]);

  // ADR-0025 §8.2 — SINGLE-AUTO-APPLIER ownership claim. Publish THIS tab's claim
  // into the live awareness whenever it could auto-apply for the active grant (an
  // editor, mode Auto, a matching grant, NOT a joined session) so the deterministic
  // lowest-clientId election can pick exactly one applier across resumed tabs;
  // retract it the instant any of those drops (mode→Ask, revoke, viewer, awareness
  // swap) so a stale claim never blocks another tab from owning. The election
  // itself is fail-closed in `isAutoApplierOwner`; this only publishes the input.
  useEffect(() => {
    const grant = getControlResponderManager().getActiveGrant();
    const eligibleToApply =
      canMutate &&
      config.syncUrl === undefined &&
      agentGrantActive &&
      autoAccept &&
      grant !== null &&
      grant.projectId === projectId;
    if (eligibleToApply) {
      claimAutoApplier(activeAwareness, grant.grantId);
      return () => releaseAutoApplier(activeAwareness);
    }
    // Not eligible: ensure no stale claim from this tab lingers in this awareness.
    releaseAutoApplier(activeAwareness);
    return undefined;
  }, [activeAwareness, canMutate, config.syncUrl, agentGrantActive, autoAccept, projectId]);


  // Share: live-upgrade this LOCAL project to a shared room WITHOUT the user
  // hand-editing the URL (#14-C, the last #14 exit criterion). We wait for
  // `whenReady` so the seed + author registration are done before the connection
  // pushes state up; mint a fresh unguessable room (sync rooms are open until
  // #14-E, so the room id is the access capability); then swap the editor's
  // awareness to the connection's so presence + remote cursors render. Idempotent:
  // a second click just re-surfaces the existing link.
  /**
   * The shared share-upgrade inner (#16.3), promise-returning so BOTH the
   * fire-and-forget Share button and the agent open-project handler use the
   * exact same path. Awaits `whenReady`, resolves + validates the sync URL,
   * REUSES an existing connection's room (idempotent — never mints a second), or
   * mints a fresh `share-<random>`, swaps awareness, and sets the share link/room
   * state. Returns the handoff coordinates or a structured `{refused}` — it never
   * throws across its boundary and never sets a user-facing share error (callers
   * decide how to surface it).
   */
  const ensureSharedForAgent = async (): Promise<
    OpenedProject | OpenProjectRefusal
  > => {
    await session.whenReady;
    const syncUrl = resolveSyncUrl(configuredSyncUrlOverride(), window.location);
    if (!/^wss?:\/\//.test(syncUrl)) {
      return { refused: "sharing is unavailable: the sync server URL is misconfigured" };
    }
    // The main file path the handoff hands back (kernel scopes its tools to it).
    const snap = project.snapshot();
    const mainId = snap.mainFileId;
    const mainPath =
      mainId != null ? snap.files.find((f) => f.fileId === mainId && !f.deleted)?.path : undefined;
    if (mainPath === undefined || mainPath.length === 0) {
      return { refused: "this project has no main file to share" };
    }

    // Mint a fresh per-grant token for this open_project handoff (ADR-0023 §1):
    // the kernel binds every proposal signature to it, so it must be CSPRNG and
    // fail closed (no guessable fallback). One id per returned OpenedProject —
    // Task 5 will persist + reuse a stable grant; here a fresh value per call is
    // fine because nothing consumes the signature yet. Both handoff branches
    // (reuse + fresh-mint) carry it.
    let grantId: string;
    try {
      grantId = mintGrantId(); // CSPRNG-backed; fails closed without a secure source
    } catch {
      return { refused: "sharing is unavailable: no secure random source" };
    }

    // Persist the consented grant (ADR-0023 §4) so the SAME grantId the kernel
    // receives is the one the browser re-derives keys + re-binds from on reload.
    // No-op without a live Agent Access session (no control room → no responseKey
    // to MAC with); harmless for the plain Share button, which also lands here.
    const recordGrant = (room: string): void => {
      const mgr = getControlResponderManager();
      const controlRoom = mgr.getState().controlRoom;
      if (controlRoom === null) return;
      // H1 (broken authority scoping): a fresh grant defaults to Ask. The prior
      // grant's `mode` (Auto) is inherited ONLY when the prior grant is for the
      // EXACT SAME full scope (controlRoom + syncUrl + projectId + shareRoom +
      // mainFile) — i.e. this is a re-share/continuation of the very same grant,
      // not a newly consented DIFFERENT project. Without this, Auto from project A
      // would become the MAC'd default of a freshly consented project B (privilege
      // carry-over). `grantMatchesReuseScope` is the canonical scope comparator.
      const inheritedMode = inheritedGrantMode(mgr.getActiveGrant(), {
        controlRoom,
        syncUrl,
        projectId,
        shareRoom: room,
        mainFile: mainPath,
      });
      // F12: a human who armed Auto for THIS project BEFORE any agent paired
      // wrote only the in-app project setting (no grant existed to stamp). Seed
      // the freshly minted grant from that explicit, just-consented choice so an
      // arm-before-pair Auto actually auto-applies the agent's signed proposals.
      // Scoped to `projectId` (the single project being consented to here), so
      // project A's Auto never seeds project B's first grant — see mintGrantMode.
      const mintMode = mintGrantMode(inheritedMode, getProjectAcceptanceMode(projectId));
      mgr.recordGrant({
        controlRoom,
        projectId,
        shareRoom: room,
        syncUrl,
        mainFile: mainPath,
        grantId,
        mode: mintMode,
        grantedAt: Date.now(),
      });
      // F13 (consent collapse): the open_project consent that just recorded this
      // grant ALSO grants read access for the project, so the human is not asked
      // to click "Allow file access" separately. isContentGranted stays the sole
      // read gate — this only satisfies it at the moment of open consent.
      mgr.grantContentForActiveGrant();
    };

    // ALREADY shared: reuse the existing room (connectProjectSession is
    // idempotent — it returns the existing connection; we need its room id).
    if (session.connection) {
      const room = activeShareRoom;
      if (room === null) {
        // Connected but the room id was never tracked — fail closed rather than
        // guess a capability we cannot reconstruct.
        return { refused: "sharing is unavailable: the active share room is unknown" };
      }
      // M2 (#1 slice 2): under auth the room is only a capability once the
      // server REGISTERED it. The gate awaits the (memoized) registration —
      // instant ok when auth is off or it already succeeded; a refusal when it
      // failed — so the kernel is never handed a room the relay will refuse.
      const registered = await shareRegistrationHandoffGate(room);
      if (!registered.ok) return { refused: registered.refused };
      recordGrant(room);
      // A1 §1: this share may have been opened by a PLAIN Share earlier, whose blob
      // channel carries no terminal auth. Guarantee an AUTHENTICATED channel for the
      // agent scope before the handoff, so the export never pushes over an advisory
      // channel (the forged-COMPLETE DoS). Recreates the channel iff it is absent or
      // advisory; a no-op when it is already authenticated.
      ensureAuthenticatedBlobChannel(session, syncUrl, room, buildAgentBlobOpts(grantId, room, syncUrl));
      return { room, syncUrl, mainFile: mainPath, grantId };
    }

    // Not yet shared: mint a fresh unguessable room and connect.
    let room: string;
    try {
      room = mintShareRoom(); // CSPRNG-backed; fails closed without a secure source
    } catch {
      return { refused: "sharing is unavailable: no secure random source" };
    }
    // The HOST is always an editor (it owns the project); the chosen `shareRole`
    // governs only the LINK others open. So the connection's own presence is an
    // editor, and the role is encoded into the join link below.
    // A1 export channel: open the galley-blob-v1 byte channel beside the sync
    // connection (when this project has a BlobStore) so the agent's export_compiled
    // can push the compiled PDF to the kernel over it. The grant is recorded only
    // AFTER this connect, so the blob-terminal auth is built from the EXPLICIT scope
    // known here (the SAME coordinates the kernel receives in the handoff) — the
    // browser, the SENDER of the PDF, then rejects a forged COMPLETE. Additive — a
    // project without a BlobStore opens no blob channel and behaves as before.
    const conn = connectProjectSession(
      session,
      syncUrl,
      room,
      {},
      "editor",
      buildAgentBlobOpts(grantId, room, syncUrl),
    );
    setConnection(conn);
    setActiveAwareness(conn.awareness);
    setActiveShareRoom(room);
    setShareLink(buildShareLink(room, undefined, shareRole));
    // M2 (#1 slice 2): connectProjectSession kicked the registration and will
    // only open the socket on success; AWAIT that same (memoized) outcome here
    // so the handoff returns the room only once it is a registered, usable
    // capability — never a room the relay will refuse or that failed to mint.
    // Auth off: resolves ok on the spot (zero registry calls), so the Share
    // button's behavior is unchanged.
    const registered = await shareRegistrationHandoffGate(room);
    if (!registered.ok) return { refused: registered.refused };
    recordGrant(room);
    return { room, syncUrl, mainFile: mainPath, grantId };
  };

  // Host names (or renames) themselves from the Share popover: persist to the
  // local profile (so future sessions/shares carry it) AND live-update presence
  // via the session helper (roster + remote cursor labels). `namePromptSeen` is
  // set so the joiner-side one-time prompt never re-fires on this browser.
  const onSetDisplayName = (name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    updateLocalProfile({ displayName: trimmed, namePromptSeen: true });
    setDisplayName(trimmed);
    setSessionDisplayName(session, trimmed);
  };

  const onShare = () => {
    if (connection) {
      setShareCopied(false);
      return;
    }
    setShareError(null);
    void ensureSharedForAgent().then((result) => {
      if ("refused" in result) {
        // Map the inner's structured refusal to the Share popover's user-facing
        // copy (the two share-blocking causes Share can hit).
        if (result.refused.includes("misconfigured")) {
          setShareError(
            "Sharing is unavailable: the sync server URL is misconfigured — it must be a ws:// or wss:// address. Fix the server's VITE_GALLEY_SYNC_URL (or its derived origin) and reload.",
          );
        } else if (result.refused.includes("secure random")) {
          setShareError(
            "Sharing is unavailable: this browser has no secure random source, so an unguessable join link can't be created. Open Galley over HTTPS (or in a modern browser) and try again.",
          );
        } else {
          setShareError(`Sharing is unavailable: ${result.refused}.`);
        }
      }
      // Success: ensureSharedForAgent already set the connection + link state.
    });
  };

  // B19-sharing-roles: change the access level the share LINK grants. If a room
  // is already live AND we minted it (the host, not a joiner), rebuild the
  // displayed link so the role chooser updates the copy-able link in place. The
  // host's OWN connection role never changes (it always edits its own project).
  const onShareRoleChange = (role: ShareRole) => {
    setShareRole(role);
    if (connection && !isViewer && activeShareRoom) {
      setShareCopied(false);
      setShareLink(buildShareLink(activeShareRoom, undefined, role));
    }
  };

  // B18 — stop sharing: gracefully close the live sync connection and revert to
  // LOCAL-only editing. Idempotent (a no-op when not connected) and a joiner
  // never reaches it (the Unshare button is hidden without this handler). The
  // local project doc + its persistence stay intact; we swap the editor back to
  // the session's local awareness (the connection's awareness is closing), clear
  // the share link/room/error state, and drop the connection so the topbar
  // reverts to "Share". A later Share mints a BRAND-NEW room (a fresh capability).
  const onUnshare = () => {
    if (!connection) return;
    disconnectProjectSession(session);
    setConnection(undefined);
    // F10: the connection is dropped — a genuine later (re)attach must re-evaluate
    // the resumed-Auto backlog once more.
    reattachReevaluated.current = false;
    setActiveAwareness(session.awareness);
    setPeers([]);
    setShareLink(null);
    setShareCopied(false);
    setShareError(null);
    setActiveShareRoom(null);
    setShareRole(DEFAULT_SHARE_ROLE);
    // SECURITY (ADR-0024 §3): ending the share must end the GRANT it authorized.
    // Without this, the persisted Agent-Access grant for THIS share room outlives
    // Stop-sharing, so a later `open_project` would silently reuse it (no modal)
    // and ADR-0023's reload re-bind would reconnect the just-closed room with no
    // open_project at all — reopening a write-capability the user explicitly
    // ended. clearActiveGrant() drops the grant/verifier-keys/auto-accept/audit
    // (the same clearing Revoke runs) while keeping the agent paired; a re-Share
    // mints a fresh room AND a fresh grant via the consent path.
    getControlResponderManager().clearActiveGrant();
  };

  // #16.3: keep the ref pointing at the LATEST ensureSharedForAgent so the
  // (stably registered) open-project handler always runs the current closure.
  ensureSharedRef.current = ensureSharedForAgent;

  // ADR-0024 §3 reuse fast-path. Re-attach an ALREADY-CONSENTED grant for a fresh
  // `open_project` WITHOUT a consent modal or a share re-mint — but ONLY when the
  // grant MAC-verifies AND its canonical scope still matches the LIVE session
  // EXACTLY; on ANY doubt return null so the handler falls through to full consent
  // (FAIL CLOSED — reuse never weakens the gate). The joined-session + scope gates
  // run BEFORE this in the core, so a joiner or a foreign project never reaches it.
  //
  //   - `getActiveGrant()` only ever returns a TRUSTED grant: one this session
  //     minted (recordGrant) or one re-parsed on resume through the MAC-verifying
  //     `parseGrant` (a tampered/forged localStorage blob never loads). So the
  //     authenticity check is already done; here we re-validate the grant's scope
  //     against coordinates the live session re-derives independently.
  //   - The live coordinates: the current responder control room, the resolved
  //     relay URL, the request's projectId, the grant's own room (re-attached,
  //     never minted), and the project's current main file. A drift in any →
  //     `grantMatchesReuseScope` is false → null → consent.
  //   - Re-attach: if a connection is already live on the grant's room, it is a
  //     no-op success returning the live binding (ADR-0024 §3 case 2). If nothing
  //     is connected, reconnect to the grant's EXACT room (never a fresh mint).
  //
  //   ORDERING (HIGH fixes): readiness is awaited FIRST, THEN the snapshot +
  //   main-file derivation + scope match + connect all run together — so a main
  //   file that changed during the await cannot leave a STALE mainFile that
  //   matched a pre-await snapshot (TOCTOU). And `isRequestLive` is re-checked
  //   immediately BEFORE the reconnect side effect, so a request the kernel
  //   withdrew during the await never reopens a share room (the core pre-checks it
  //   too, before this seam is even invoked).
  const tryReuseGrant = async (
    requestedProjectId: string,
    isRequestLive: () => boolean,
  ): Promise<OpenedProject | null> => {
    // A joined/CONNECTED-boot session never owns the project — never reuse (the
    // core refuses it first, but stay defense-in-depth / fail closed here too).
    if (config.syncUrl !== undefined) return null;
    const mgr = getControlResponderManager();
    if (!mgr.isEnabled()) return null;

    // Await readiness FIRST (HIGH #3 — TOCTOU): everything that reads live state
    // (the grant, the control room, the snapshot/main file) is read AFTER this,
    // so the scope match reflects the post-await truth, not a stale pre-await one.
    await session.whenReady;

    const grant = mgr.getActiveGrant();
    if (grant === null) return null;
    const controlRoom = mgr.getState().controlRoom;
    if (controlRoom === null) return null;

    // The live coordinates this session re-derives, independent of the grant blob.
    const syncUrl = resolveSyncUrl(configuredSyncUrlOverride(), window.location);
    const snap = project.snapshot();
    const mainId = snap.mainFileId;
    const mainPath =
      mainId != null ? snap.files.find((f) => f.fileId === mainId && !f.deleted)?.path : undefined;
    if (mainPath === undefined || mainPath.length === 0) return null;

    // EXACT scope match (ADR-0024 §3) — any drift falls through to consent.
    if (
      !grantMatchesReuseScope(grant, {
        controlRoom,
        syncUrl,
        projectId: requestedProjectId,
        shareRoom: grant.shareRoom,
        mainFile: mainPath,
      })
    ) {
      return null;
    }

    // Already attached on the SAME room → no-op success, return the live binding.
    if (session.connection) {
      if (activeShareRoom !== grant.shareRoom) {
        // Connected to a DIFFERENT room than the grant points at — the live state
        // diverged from the grant; don't claim a reuse we can't honor. Fall
        // through to consent rather than hand back a mismatched binding.
        return null;
      }
      // A1 §1: a plain Share may have connected this room with an ADVISORY blob
      // channel; guarantee an AUTHENTICATED one for the agent scope before the
      // handoff so the export never pushes over an advisory channel.
      ensureAuthenticatedBlobChannel(session, grant.syncUrl, grant.shareRoom, agentBlobOpts());
      return {
        room: grant.shareRoom,
        syncUrl: grant.syncUrl,
        mainFile: grant.mainFile,
        grantId: grant.grantId,
      };
    }

    // SEC-16.3a (HIGH #2): a RECONNECT is a capability-reopening side effect, so
    // re-check liveness immediately before it. A request the kernel withdrew while
    // we awaited readiness must NOT reopen the share room — fall through to
    // consent (which has its own withdrawn-request guard).
    if (!isRequestLive()) return null;

    // Not connected → re-attach to the grant's EXACT room (never mint a new one).
    try {
      const conn = connectProjectSession(
        session,
        grant.syncUrl,
        grant.shareRoom,
        {},
        "editor",
        agentBlobOpts(),
      );
      setConnection(conn);
      setActiveAwareness(conn.awareness);
      setActiveShareRoom(grant.shareRoom);
    } catch {
      return null; // a failed re-attach falls through to consent (fail closed)
    }
    return {
      room: grant.shareRoom,
      syncUrl: grant.syncUrl,
      mainFile: grant.mainFile,
      grantId: grant.grantId,
    };
  };
  tryReuseGrantRef.current = tryReuseGrant;

  // Register the agent open-project handler with the control-responder singleton
  // on mount; unregister on unmount (token-guarded, so a StrictMode double-invoke
  // can't clobber the live registration). The GATE ORDER lives in the pure
  // `createAgentOpenHandler` core (agent-open-handler.ts, unit-tested offline):
  // joined-session refusal (SEC-16.3b) → scope → single-consent lock → the
  // blocking modal → request-liveness re-check (SEC-16.3a: an approval after the
  // kernel withdrew must NOT mint a live share) → the share-upgrade. This effect
  // only wires the seams. DEFAULT-OFF: nothing happens until Agent Access is
  // enabled AND a paired agent calls open_project.
  useEffect(() => {
    const manager = getControlResponderManager();
    const handler = createAgentOpenHandler({
      projectId,
      // SEC-16.3b: a session that booted CONNECTED (a /join/<room> joiner or any
      // ?sync= boot) is visiting someone else's project — its "projectId" is the
      // share-room id itself. Refuse outright; only a locally-owned project can
      // be shared with the agent.
      joinedSession: config.syncUrl !== undefined,
      isConsentPending: () => consentPendingRef.current,
      setConsentPending: (pending) => {
        consentPendingRef.current = pending;
      },
      // The blocking consent modal, with a 90s auto-deny (< the kernel's 120s
      // RPC wait, so the kernel always gets a definite answer before its own
      // deadline). Outcome is approve | deny | timeout so the refusal copy can
      // distinguish.
      requestConsent: () =>
        new Promise<ConsentOutcome>((resolveOutcome) => {
          let settled = false;
          const finish = (value: ConsentOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            setAgentConsent(null);
            resolveOutcome(value);
          };
          const timer = setTimeout(() => finish("timeout"), 90_000);
          setAgentConsent({
            projectName: projectName ?? "this project",
            // The modal resolves true (Share) / false (Deny / escape / backdrop).
            resolve: (approved: boolean) => finish(approved ? "approve" : "deny"),
          });
        }),
      // The (idempotent) share-upgrade, read at CALL time via the ref.
      getEnsureShared: () => ensureSharedRef.current,
      // ADR-0024 §3 reuse fast-path, read at CALL time via the ref — fires AFTER
      // the joined-session + scope gates and BEFORE the consent modal; null on
      // any miss → full consent (fail closed). `isRequestLive` is threaded through
      // so the seam re-checks it before its reconnect side effect (SEC-16.3a).
      tryReuseGrant: (requestedProjectId, isRequestLive) =>
        tryReuseGrantRef.current?.(requestedProjectId, isRequestLive) ?? Promise.resolve(null),
    });
    const unregister = manager.registerOpenProjectHandler(handler);
    // A1 export channel: a STABLE export handler that (1) refuses a request for any
    // project other than THIS scoped one (scope safety, mirroring the open gate),
    // and (2) reads the latest compile+push closure via the ref at CALL time. A
    // joined/CONNECTED-boot session never owns the project to export — fail closed.
    const exportHandler = async (
      requestedProjectId: string,
      transferId: string,
      maxBytes: number,
    ): Promise<ExportedCompiled | OpenProjectRefusal | null> => {
      if (config.syncUrl !== undefined) {
        return { refused: "this session is viewing a shared project — it cannot export it for the agent" };
      }
      if (requestedProjectId !== projectId) {
        // The agent asked to export a DIFFERENT project than the one open here.
        return { refused: "no project is open to export for that id" };
      }
      const run = exportCompiledRef.current;
      if (run === null) return { refused: "the document is not ready to export yet" };
      return run(transferId, maxBytes);
    };
    const unregisterExport = manager.registerExportCompiledHandler(exportHandler);
    // F9/F5 compile: a handler scoped to THIS open project that returns its CURRENT
    // preview diagnostics (the live preview already compiled them — no fresh build).
    // Refuse a DIFFERENT project than the one open (scope safety, mirroring export),
    // and read the latest diagnostics closure via the ref at CALL time. A
    // joined/CONNECTED-boot session never owns the project to compile — the ref
    // closure fails closed on config.syncUrl.
    const compileHandler = async (
      requestedProjectId: string,
    ): Promise<CompileDiagnostics | OpenProjectRefusal | null> => {
      if (requestedProjectId !== projectId) {
        return { refused: "no project is open to compile for that id" };
      }
      const run = compileBrowserRef.current;
      if (run === null) return { refused: "the document is not ready to compile yet" };
      return run(requestedProjectId);
    };
    const unregisterCompile = manager.registerCompileHandler(compileHandler);
    // A2 expect_blob: a handler scoped to THIS open project that RESERVES inbound
    // capacity on the project's blob channel before the kernel pushes binary bytes
    // (the propose_files upload path). Fail closed unless the channel exists AND is
    // authenticated for the agent scope — never reserve capacity for a push we
    // could not securely verify on completion. A joined/CONNECTED-boot session
    // owns no project to receive into — refuse (null).
    // C1a: per-reservation LEASE timers, keyed by `hash:size`. A reservation that
    // is never delivered (the kernel reserved then never pushed, or the push was
    // lost) is AUTO-RELEASED after EXPECT_BLOB_LEASE_MS, bounding the quota-pin a
    // consented room peer could otherwise hold. The Map is effect-scoped: its
    // cleanup clears every timer.
    const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // C1: the set of hashes THIS session reserved (and, if delivered, stored). Only
    // a hash WE reserved may be released/deleted — a release_blob can never delete
    // an arbitrary hash, just the requesting session's own reserved/delivered ones.
    const reservedHashes = new Set<string>();
    const deliveredHashes = new Set<string>();
    const leaseKey = (hash: string, size: number): string => `${hash}:${size}`;
    const clearLease = (hash: string, size: number): void => {
      const k = leaseKey(hash, size);
      const t = leaseTimers.get(k);
      if (t !== undefined) {
        clearTimeout(t);
        leaseTimers.delete(k);
      }
    };
    // C1a: on DELIVERY, CLEAR the lease timer (no stray no-op fire later) and record
    // the hash as stored, so a subsequent release_blob can delete the orphan bytes
    // if the proposal never publishes. Pointed at by the stable inboundStoredRef.
    inboundStoredRef.current = (hash: string, size: number): void => {
      clearLease(hash, size);
      if (reservedHashes.has(hash)) deliveredHashes.add(hash);
    };
    const expectBlobHandler = async (
      requestedProjectId: string,
      hash: string,
      size: number,
    ): Promise<boolean | null> => {
      if (config.syncUrl !== undefined) return null; // a joined session owns nothing to receive into
      if (requestedProjectId !== projectId) return null; // only the open project
      const channel = session.blobChannel;
      // No channel, or an advisory (unauthenticated) one → fail closed: the bytes
      // would arrive over a channel whose COMPLETE we cannot MAC-verify. Refuse the
      // reservation so the kernel does not push.
      if (channel === undefined || !channel.authenticated) return false;
      // Reserve quota for the inbound transfer; false if the buffer can't hold it.
      const reserved = channel.expect(hash, size);
      if (reserved) {
        reservedHashes.add(hash);
        // Arm the lease: auto-unexpect if the bytes never arrive (bounds the pin).
        clearLease(hash, size);
        leaseTimers.set(
          leaseKey(hash, size),
          setTimeout(() => {
            leaseTimers.delete(leaseKey(hash, size));
            session.blobChannel?.unexpect(hash, size);
          }, EXPECT_BLOB_LEASE_MS),
        );
      }
      return reserved;
    };
    const unregisterExpectBlob = manager.registerExpectBlobHandler(expectBlobHandler);
    // C1b: the kernel asks to RELEASE earlier reservations when a multi-binary
    // upload fails partway or the publish throws. For each of THIS session's own
    // reserved hashes: drop the (still-pending) reservation + its lease so the
    // quota frees immediately; AND if the bytes were already DELIVERED+stored,
    // DELETE the orphan from the blob store — safe because the proposal did NOT
    // publish, so no live CRDT pointer references the hash. A hash we never
    // reserved is ignored (a release can't delete an arbitrary blob).
    const releaseBlobHandler = async (
      requestedProjectId: string,
      hashes: { hash: string; size: number }[],
    ): Promise<boolean | null> => {
      if (config.syncUrl !== undefined) return null;
      if (requestedProjectId !== projectId) return null;
      const channel = session.blobChannel;
      if (channel === undefined) return false;
      for (const { hash, size } of hashes) {
        if (!reservedHashes.has(hash)) continue; // only our own reservations
        clearLease(hash, size);
        channel.unexpect(hash, size);
        reservedHashes.delete(hash);
        // Delete the delivered orphan ONLY when NO CRDT pointer references the hash —
        // INCLUDING soft-DELETED (tombstoned) binary files, whose bytes are RETAINED
        // on purpose so they can be restored (CollabProject.restoreBinary). A blob is
        // safe to delete only when no binaryFiles entry — live OR tombstoned — uses
        // the hash AND the proposal never published. This is refcount-by-snapshot:
        // any referencing entry blocks the delete, so content-addressed sharing (two
        // files, same hash) and recoverable deletes are both preserved. (Versions are
        // text-only, so the binaryFiles snapshot is the complete reference set.)
        // Best-effort; never throws.
        if (deliveredHashes.has(hash)) {
          deliveredHashes.delete(hash);
          const referenced = blobHashIsReferenced(project.snapshot(), hash);
          if (!referenced && blobStore) {
            await blobStore.delete(hash).catch(() => {});
          }
        }
      }
      return true;
    };
    const unregisterReleaseBlob = manager.registerReleaseBlobHandler(releaseBlobHandler);
    // B3 request_restore_version: a STABLE handler scoped to THIS open project. It
    // exposes the live TEXT-file set (binary assets EXCLUDED, so a restore can
    // never delete one) and publishes the computed restore proposal as a NORMAL,
    // UNSIGNED file proposal into the live doc — UNSIGNED so it lands ONLY on the
    // manual Accept/compare card (the auto-accept verifier authenticates a kernel
    // signature it will never have), i.e. "explicit human Accept; never a direct
    // mutation" (ADR-0021). A joined/CONNECTED-boot session does not own the
    // project — fail closed.
    const restoreHandler: RestoreVersionHandler = {
      liveFileSet: async (requestedProjectId) => {
        if (config.syncUrl !== undefined) return null; // a joined session owns nothing to restore
        if (requestedProjectId !== projectId) return null; // only the open project
        // Live TEXT files only: drop deleted + the reserved `.galley/*` namespace
        // (the file tree doesn't show it). Binary files live in `binaryFiles`, never
        // in `files`, so they are never in this set — the binary-delete-safety invariant.
        return project
          .snapshot()
          .files.filter((f) => !f.deleted && !isReservedProjectPath(f.path))
          .map((f) => ({
            path: f.path.startsWith("/") ? f.path : `/${f.path}`,
            text: f.text,
          }));
      },
      // UNSIGNED publish into the live doc (signer omitted): manual Accept only.
      publish: async (input) => publishFileProposal(project, input, HUMAN),
    };
    const unregisterRestore = manager.registerRestoreVersionHandler(restoreHandler);
    return () => {
      unregister();
      unregisterExport();
      unregisterCompile();
      unregisterExpectBlob();
      unregisterReleaseBlob();
      unregisterRestore();
      // C1a: drop every armed lease timer so a reservation's auto-release never
      // fires against a torn-down channel (and no timer leaks across re-mounts).
      for (const t of leaseTimers.values()) clearTimeout(t);
      leaseTimers.clear();
      // Clear any in-flight consent UI + lock on unmount (the awaiting promise was
      // already resolved by a decision/timeout, or will be GC'd with the handler).
      consentPendingRef.current = false;
      setAgentConsent(null);
    };
    // Re-register if the scoped id / name / boot mode changes so the gate stays correct.
  }, [projectId, projectName, config.syncUrl]);

  // M5: report whether the copy succeeded so the popover can fall back to
  // focus+select the link input (manual ⌘C) when the clipboard rejects or is
  // unavailable (insecure context / denied permission) — previously silent.
  const copyShareLink = async (): Promise<boolean> => {
    if (!shareLink) return false;
    const absolute = new URL(shareLink, window.location.origin).toString();
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setShareCopied(false);
      return false;
    }
    try {
      await clipboard.writeText(absolute);
      setShareCopied(true);
      return true;
    } catch {
      setShareCopied(false);
      return false;
    }
  };

  // --- Exports (#17.5), hoisted out of the JSX so the Export menu AND the
  // command palette share the exact same handlers (#19.3). ---

  /**
   * Resolve the bytes for every live binary pointer from the per-project
   * BlobStore (#7 7C-4), keyed by hash so the export cores can commit binaries
   * at their path. `blobStore.get` verifies-on-read (a hash mismatch yields
   * undefined), and a pointer whose bytes can't be read is simply absent from
   * the map → the export omits it and reports it. A text-only project (or no
   * BlobStore) yields an empty map and the exports stay byte-for-byte unchanged.
   */
  const collectBlobBytes = async (): Promise<Map<string, Uint8Array>> => {
    const map = new Map<string, Uint8Array>();
    if (!blobStore) return map;
    for (const b of project.snapshot().binaryFiles ?? []) {
      if (b.deleted || map.has(b.hash)) continue;
      try {
        const bytes = await blobStore.get(b.hash);
        if (bytes) map.set(b.hash, bytes);
      } catch {
        /* unreadable blob: leave it out of the map → export omits + reports it */
      }
    }
    return map;
  };

  /** Download the whole project as a `.typ` tar bundle (binaries included). */
  const onExportBundle = () => {
    void (async () => {
      const r = bundleProject(project.snapshot(), await collectBlobBytes());
      if ("bytes" in r) {
        downloadBytes(r.bytes, r.filename);
        if (r.omitted?.length) {
          console.warn("export bundle: binary bytes unavailable, omitted:", r.omitted);
          setNotice(infoNotice(omittedBinariesNotice(r.omitted)));
        }
      } else {
        // H4: surface the failure (the C3 banner), not just console.
        console.error("export bundle failed:", r.error);
        setNotice(errorNotice(exportFailureNotice("source bundle")));
      }
    })();
  };

  /**
   * Download the project as a bare git repo tar (clone-ready:
   * `git clone project.git my-project`). The export core is pure and defaults
   * to an epoch-0 commit time for determinism; a user-gesture export stamps
   * the real wall-clock time instead.
   */
  const onExportGitRepo = () => {
    void (async () => {
      const r = await exportProjectAsGitRepo(project.snapshot(), {
        timestampSec: Math.floor(Date.now() / 1000),
        blobsByHash: await collectBlobBytes(),
      });
      if ("bytes" in r) {
        downloadBytes(r.bytes, r.filename);
        if (r.omitted?.length) {
          console.warn("export git repo: binary bytes unavailable, omitted:", r.omitted);
          setNotice(infoNotice(omittedBinariesNotice(r.omitted)));
        }
      } else {
        // H4: surface the failure (the C3 banner) in addition to the console.
        console.error("export git repo failed:", r.error);
        setNotice(errorNotice(exportFailureNotice("git repository")));
      }
    })();
  };

  // NOTE: the session deliberately lives for the page lifetime (like App's collab
  // session). We do NOT destroy it on unmount — React 18 StrictMode's
  // mount→unmount→remount would otherwise destroy the project doc (the lazy ref
  // reuses the same session on remount), leaving a dead doc that never recompiles.

  const snapshot = project.snapshot();
  const allLiveFiles = snapshot.files.filter((f) => !f.deleted);
  // 14-D / architect requirement: HIDE the reserved `.galley/*` namespace (config,
  // not document) from the file TREE and the file-open commands ONLY — so the
  // instructions file can't be renamed, set-as-main, or opened as a doc. The
  // snapshot, compile input, `agentInstructions` read, and `.bib` feed all still
  // see EVERY file (they use `snapshot`/`allLiveFiles`, never this filtered list).
  const liveFiles = allLiveFiles.filter((f) => !isReservedProjectPath(f.path));
  // The instructions editor reads from the FULL live set (it edits the hidden file).
  const instructionsText = readInstructionsText(
    allLiveFiles.map((f) => ({ fileId: f.fileId, path: f.path, text: project.getFile(f.fileId)?.text ?? "" })),
  );
  const hasInstructions = instructionsText !== undefined;

  // Styles (Phase 1): classify whether the live MAIN document can switch styles,
  // and the apply handlers. `onStyleApply` trial-compiles the candidate /style.typ
  // in an offline worker BEFORE committing; a clean trial applies straight away,
  // a failing trial routes to the Cancel / Apply-anyway confirmation (`styleTrial`).
  const styleMainText =
    snapshot.mainFileId != null ? (project.getFile(snapshot.mainFileId)?.text ?? "") : "";
  // Capability detection is PROJECT-WIDE: a chapter/intro file can import helpers
  // from /style.typ that /main.typ does not, and a swap must satisfy those too.
  const styleOtherTexts = snapshot.files
    .filter((f) => !f.deleted && f.fileId !== snapshot.mainFileId && f.path !== "/style.typ")
    .map((f) => project.getFile(f.fileId)?.text ?? "");
  const styleability = detectStyleability(styleMainText, styleOtherTexts);
  const doApplyStyle = (style: Style) => {
    applyStyle(project, style, styleability, HUMAN);
    setStyleTrial(null);
    setStyleLibraryOpen(false);
  };
  const onStyleApply = async (style: Style) => {
    if (!canMutate) return;
    setStyleBusy(true);
    try {
      trialCompilerRef.current ??= initCompiler("local");
      const compiler = await trialCompilerRef.current;
      const errors = await trialCompileStyle(project, style, styleability, (input) =>
        compiler.check(input),
      );
      if (errors.length === 0) {
        applyStyle(project, style, styleability, HUMAN);
        setStyleLibraryOpen(false);
      } else {
        setStyleTrial({ style, errors });
        setStyleLibraryOpen(false);
      }
    } finally {
      setStyleBusy(false);
    }
  };

  // Save-your-own: the picker browses the built-ins PLUS the user's saved styles
  // (materialised into real `Style`s); a saved style flows through the unchanged
  // `onStyleApply` path. `onSaveCurrent` captures the project's current
  // /style.typ under a name; `onDeleteStyle` removes a saved one. Both refresh
  // the in-memory list and are gated on `canMutate` like other editing actions.
  // Built-ins/local FIRST and never awaited — remote styles only ever APPEND, so
  // a slow source can't delay or reorder the shipped cards.
  const styleCatalog: Style[] = [...BUILT_IN_STYLES, ...savedStyles.map(toStyle), ...remoteStyles];
  const onSaveCurrentStyle = (name: string) => {
    if (!canMutate) return;
    const current = snapshot.files.find((f) => f.path === "/style.typ" && !f.deleted);
    const text = current ? (project.getFile(current.fileId)?.text ?? "") : "";
    if (text.trim() === "") return; // nothing to capture — no /style.typ yet
    saveLocalStyle(undefined, { name, text });
    setSavedStyles(loadLocalStyles());
  };
  const onDeleteStyle = (id: string) => {
    if (!canMutate) return;
    deleteLocalStyle(undefined, id);
    setSavedStyles(loadLocalStyles());
  };

  // L1-C2 / ADR-0013: deleting the main file does NOT auto-reassign main (a
  // deliberate decision — we never silently compile an arbitrary file). The core
  // then returns no compile input and the preview stops. Rather than leave a
  // silently-dead preview, surface an actionable nudge to pick a new main (the
  // per-file "main" buttons already do it). Behavior-preserving: additive notice.
  const mainFileSnapshot =
    snapshot.mainFileId != null
      ? snapshot.files.find((f) => f.fileId === snapshot.mainFileId)
      : undefined;
  const mainDeleted = mainFileSnapshot?.deleted === true && liveFiles.length > 0;
  const activeFile = activeFileId ? project.getFile(activeFileId) : undefined;
  const activeText = activeFileId ? project.fileText(activeFileId) : undefined;
  activeTextRef.current = activeFile?.text ?? "";
  // H2: live mirrors of the two React-state values the in-app Auto final gate
  // re-reads AFTER the checkpoint window — so a role drop or an active-file switch
  // during that await is seen by `commit`, never the stale run-finish closure.
  activeFileIdRef.current = activeFileId;
  canMutateRef.current = canMutate;
  // 18.7 Writing Goals — the text the live goal checks measure: the MAIN file
  // (the compiled document) when there is one, else the ACTIVE file. Read from
  // the live snapshot so it tracks every keystroke (the same refreshTick path
  // that feeds `agentInstructions`). Only consumed when constraints exist.
  const goalsText =
    (snapshot.mainFileId != null ? project.getFile(snapshot.mainFileId)?.text : undefined) ??
    activeFile?.text ??
    "";
  // The bibliography feed reads the FULL live set (a `.bib` is never reserved, so
  // this is identical in practice — but the contract pins it to all files).
  bibTextRef.current = allLiveFiles
    .filter((f) => f.path.toLowerCase().endsWith(".bib"))
    .map((f) => project.getFile(f.fileId)?.text ?? "")
    .join("\n\n");

  // --- File operations (the core enforces all the rules; this is just wiring) ---

  // B19-sharing-roles: a VIEWER (a joiner on a `?role=viewer` link) may read the
  // whole project but never mutate it. Every file-op below fails closed for a
  // viewer — a defense-in-depth guard behind the disabled UI controls, so even a
  // stale handler reference or a keyboard path can't write. The owner/editor path
  // is byte-for-byte unchanged (`isViewer` is false).
  const addFile = () => {
    if (isViewer) return;
    const path = newFilePath.trim();
    if (path === "") return;
    const id = project.create(path, "", HUMAN); // duplicate paths are allowed by the
    setNewFilePath(""); // core and surfaced via duplicatePaths() / status — never silently merged
    setActiveFileId(id);
  };

  // Create a NEW FOLDER. Folders are derived from paths (ADR-0013), so an EMPTY
  // folder is unrepresentable — there is no folder entity to create. "Create a
  // folder" therefore means: create the folder's FIRST file (a starter file
  // under the new prefix) so the folder derives and renders in one step, then
  // focus that file in rename mode so the user can immediately name it. The pure
  // `planFolderCreate` canonicalizes the typed name and dedupes the starter path
  // against existing files; a null plan (empty/blank/only-slashes) is a no-op.
  const createFolder = (rawName: string) => {
    if (isViewer) return; // B19: viewers never mutate (UI is also hidden)
    const plan = planFolderCreate(liveFiles, rawName);
    if (!plan) return; // empty / only-slashes / whitespace → no-op
    const id = project.create(plan.starterPath, "", HUMAN);
    setActiveFileId(id);
    // Drop the new starter file straight into rename mode (the same inline input
    // a file rename uses), so naming the real first file is one keystroke away.
    setRenamingId(id);
    setRenameValue(plan.starterPath);
  };

  const addFolder = () => {
    createFolder(newFolderName);
    setNewFolderName("");
  };

  // The per-folder "New subfolder…" affordance: reveal an inline text input on
  // the folder row (mirroring the inline folder-rename), prefilled empty. The
  // actual create happens in `commitSubfolder` once a name is entered.
  const newSubfolder = (parentPrefix: string) => {
    if (isViewer) return;
    cancelSubfolderRef.current = false;
    setSubfolderParent(parentPrefix);
    setSubfolderValue("");
  };

  // Submit the inline subfolder input: prepend the parent's prefix so the new
  // folder lands inside it (`<prefix>/<name>/<starter>`) and reuse the existing
  // `createFolder` materialize logic. Empty/blank → cancel (no-op). The cancel
  // ref guards the Escape path: Escape clears state, but the input's onBlur (it
  // loses focus as it unmounts) would otherwise re-fire a create with the stale
  // closure values — the ref makes that blur a no-op.
  const cancelSubfolder = () => {
    cancelSubfolderRef.current = true;
    setSubfolderParent(null);
    setSubfolderValue("");
  };
  const commitSubfolder = () => {
    if (cancelSubfolderRef.current) {
      cancelSubfolderRef.current = false;
      return; // a just-fired Escape cancellation; ignore the trailing blur
    }
    const parent = subfolderParent;
    const name = subfolderValue.trim();
    setSubfolderParent(null);
    setSubfolderValue("");
    if (isViewer || !parent || name === "") return; // cancelled / empty → no-op
    createFolder(`${parent}/${name}`);
  };

  const beginRename = (fileId: string, path: string) => {
    if (isViewer) return;
    cancelRenameRef.current = false;
    setRenamingId(fileId);
    setRenameValue(path);
  };

  // Escape cancels the rename: set the guard BEFORE clearing state so the trailing
  // onBlur (commitRename) becomes a no-op instead of applying the cancelled edit.
  const cancelRename = () => {
    cancelRenameRef.current = true;
    setRenamingId(null);
  };

  const commitRename = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return; // a just-fired Escape cancellation; ignore the trailing blur
    }
    const path = renameValue.trim();
    if (!isViewer && renamingId && path !== "") project.rename(renamingId, path, HUMAN);
    setRenamingId(null);
  };

  const deleteFile = (fileId: string) => {
    if (isViewer) return;
    project.delete(fileId, HUMAN);
    if (activeFileId === fileId) setActiveFileId(project.mainFileId());
  };

  const setMain = (fileId: string) => {
    if (isViewer) return;
    project.setMain(fileId, HUMAN);
  };

  // --- #7 7D binary assets: upload / insert / preview / rename / delete -------

  // Upload dropped/picked/pasted files as content-addressed binary assets.
  // Ordered bytes-BEFORE-pointer (the dangling-pointer invariant): every blob is
  // stored, THEN one batched transact creates the pointers as a single HUMAN
  // undo/attribution unit. Pure `planBinaryUpload` sanitizes + size-gates (on
  // File.size, pre-`arrayBuffer`) + de-duplicates paths first. Returns the
  // accepted paths (post-suffix) so the insert flows can reference them. Dual
  // viewer gate; degrades to a no-op when there is no BlobStore.
  const uploadBinaryFiles = (
    files: File[],
    folderPrefix?: string,
  ): Promise<{ path: string; mime: string }[]> => {
    const run = async (): Promise<{ path: string; mime: string }[]> => {
      if (isViewer || !blobStore || files.length === 0) return [];
      const snap = project.snapshot();
      const taken = new Set<string>();
      for (const f of snap.files) if (!f.deleted) taken.add(f.path);
      for (const f of snap.binaryFiles ?? []) if (!f.deleted) taken.add(f.path);
      const plan = planBinaryUpload(
        files.map((f) => ({ name: f.name, size: f.size })),
        taken,
        folderPrefix ? { folderPrefix } : undefined,
      );
      // Store every blob first (bytes-before-pointer). mime is ALWAYS derived from
      // the magic bytes inside `put` (inferMime) — never the OS-supplied File.type.
      const stored: { path: string; asset: BinaryAsset; bytes: Uint8Array }[] = [];
      for (const a of plan.accepted) {
        try {
          const bytes = new Uint8Array(await files[a.index]!.arrayBuffer());
          const asset = await blobStore.put(bytes, { filename: a.path });
          stored.push({ path: a.path, asset, bytes });
        } catch {
          plan.rejected.push({ name: a.name, reason: "could not be read" });
        }
      }
      // A role can flip during the async put window: bytes already stored are
      // fine (content-addressed, GC-safe), but skip the pointer writes.
      if (stored.length > 0 && !canMutateRef.current) {
        setNotice(infoNotice("Your access changed while uploading, so nothing was added."));
        return [];
      }
      if (stored.length > 0) {
        // RE-check uniqueness against a FRESH snapshot: during the put window a
        // remote peer, an agent apply, or a serialized-sibling gesture may have
        // taken a path. Re-suffix any collision so the batch never mints a
        // duplicate (which would block compile via duplicatePaths()).
        const fresh = project.snapshot();
        const live = new Set<string>();
        for (const f of fresh.files) if (!f.deleted) live.add(f.path);
        for (const f of fresh.binaryFiles ?? []) if (!f.deleted) live.add(f.path);
        for (const s of stored) {
          s.path = uniqueBinaryPath(s.path, live);
          live.add(s.path);
        }
        project.doc.transact(() => {
          for (const s of stored) project.createBinary(s.path, s.asset, HUMAN);
        }, authorOrigin(HUMAN));
        // Servable-provenance (Contract A): the binary POINTER tx has just LANDED
        // via a trusted local action (upload / paste / drag-drop / editor-insert).
        // ONLY NOW — strictly AFTER createBinary, never at the NEUTRAL `put` above —
        // may these bytes be served to peers. Idempotent + best-effort: a mark
        // failure only leaves the asset temporarily non-servable (fail-closed), it
        // never fails the already-committed upload.
        for (const s of stored) {
          await blobStore.markServable(s.asset.hash).catch(() => undefined);
        }
        // Pre-warm the resolve cache so the compile input picks the bytes up THIS
        // tick instead of awaiting the async resolution effect's IDB round-trip.
        for (const s of stored) binaryCacheRef.current.set(s.asset.hash, s.bytes);
        setBinaryTick((n) => n + 1);
        // Quota nudge (#23.1): a large upload can push storage toward eviction —
        // re-read the estimate and re-surface the durability banner if now at risk.
        // Advisory only (the upload already succeeded); never blocks or throws.
        void estimateStorage()
          .then((estimate) => {
            if (persistState === null) return; // not resolved yet — mount effect owns it
            const next = durabilityStatus({ persistState, estimate });
            if (next.level === "at-risk") {
              setDurability(next);
              setDurabilityDismissed(false);
            }
          })
          .catch(() => undefined);
      }
      if (plan.rejected.length > 0) setNotice(infoNotice(uploadSkipNotice(plan.rejected)));
      return stored.map((s) => ({ path: s.path, mime: s.asset.mime }));
    };
    // Serialize: each gesture runs only after the previous one's pointers are
    // committed, so its snapshot is never stale. Runs even if a prior run threw.
    const result = uploadChainRef.current.then(run, run);
    uploadChainRef.current = result.catch(() => undefined);
    return result;
  };

  // Insert a `#figure(image(...))` at the editor cursor for each uploaded asset
  // that is actually renderable as an image — via a DIRECT view.dispatch (a human
  // edit, like typing: no Accept gate, correct local attribution). NON-image
  // uploads (a picked PDF/zip) still store, but inserting `image("/x.pdf")` would
  // break the compile, so they are surfaced as a notice instead.
  const insertImageFiguresAtCursor = (uploaded: { path: string; mime: string }[]) => {
    if (!canMutate || uploaded.length === 0) return;
    const insertable = (m: string) => isDisplayableRasterMime(m) || m === "image/svg+xml";
    const figures = uploaded.filter((u) => insertable(u.mime));
    const view = editorViewRef.current;
    if (view && figures.length > 0) {
      const snippet = figures.map((u) => imageSnippet(u.path)).join("\n\n");
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: snippet } });
      view.focus();
    }
    const skipped = uploaded.filter((u) => !insertable(u.mime));
    if (skipped.length > 0) {
      const names = skipped.map((u) => u.path.slice(u.path.lastIndexOf("/") + 1)).join(", ");
      setNotice(infoNotice(`Uploaded ${names} — not insertable as an image.`));
    }
  };

  // The hidden picker: "files" just uploads; "insert" uploads then inserts a
  // figure at the cursor (the ⌘K "Insert image…" command). The accept hint is
  // narrowed to images in insert mode so the OS dialog doesn't invite a PDF.
  const openUploadPicker = (mode: "files" | "insert") => {
    if (isViewer || !blobStore) return;
    const input = uploadInputRef.current;
    if (!input) return;
    uploadModeRef.current = mode;
    input.accept = mode === "insert" ? "image/*" : "image/*,.pdf";
    input.click();
  };
  const onUploadInputChange = async (e: ReactChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // reset so re-picking the SAME file fires change again
    if (files.length === 0) return;
    const mode = uploadModeRef.current;
    const uploaded = await uploadBinaryFiles(files);
    if (mode === "insert") insertImageFiguresAtCursor(uploaded);
  };

  // Shared upload-then-insert-INLINE path for editor paste + editor drop: upload
  // the image files, then insert a bare `#image(...)` at `at` (the drop position)
  // or the cursor. Direct human view.dispatch (correct attribution + undoable).
  const uploadAndInsertInline = (files: File[], at: number | null): void => {
    if (isViewer || !blobStore) return;
    void (async () => {
      const uploaded = await uploadBinaryFiles(files);
      if (uploaded.length === 0) return;
      const view = editorViewRef.current;
      if (!view || !canMutate) return;
      const snippet = uploaded.map((u) => inlineImageSnippet(u.path)).join("\n");
      const pos = at ?? view.state.selection.main.from;
      view.dispatch({ changes: { from: pos, to: pos, insert: snippet } });
      view.focus();
    })();
  };

  // Editor image PASTE: the clipboard carried image FILES. Rename each to a stable
  // pasted-image name (mime→ext, since the clipboard rarely carries one), then
  // upload + insert inline at the cursor. File.type is trusted ONLY for the name.
  const onPasteImage = (files: File[]): void => {
    const named = files.map((f) => {
      const type = f.type || "application/octet-stream";
      return new File([f], pastedImageName(type), { type });
    });
    uploadAndInsertInline(named, null);
  };
  // Editor image DROP: upload the dropped image files (real filenames) + insert
  // inline at the DROP position.
  const onDropImage = (files: File[], pos: number | null): void => {
    uploadAndInsertInline(files, pos);
  };
  // A non-image file dropped on the editor: swallowed by the editor extension
  // (so CodeMirror never inserts its text / the tab never navigates) — tell the
  // user why nothing happened.
  const onDropNonImage = (): void => {
    setNotice(infoNotice("Only image files can be dropped into the editor."));
  };

  // Drag-and-drop upload onto the file tree. Reacts ONLY to a drag carrying
  // FILES; a drop stores them into the current project's BlobStore (root, or a
  // folder's prefix when dropped on a folder row). Dual viewer gate; degrades
  // when no BlobStore. `dragleave` fires on the element being LEFT, so the
  // highlight clears only when the pointer has actually EXITED the element
  // (relatedTarget outside it) — not when crossing onto a child row.
  const isFileDrag = (e: ReactDragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const draggedOut = (e: ReactDragEvent): boolean => {
    const to = e.relatedTarget as Node | null;
    return !to || !(e.currentTarget as HTMLElement).contains(to);
  };
  const onFilesDragOver = (e: ReactDragEvent) => {
    if (isViewer || !blobStore || !isFileDrag(e)) return;
    e.preventDefault();
    setDropActive(true);
  };
  const onFilesDragLeave = (e: ReactDragEvent) => {
    if (draggedOut(e)) setDropActive(false);
  };
  const onFilesDrop = (e: ReactDragEvent) => {
    setDropActive(false);
    setDropFolder(null);
    if (isViewer || !blobStore || !isFileDrag(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadBinaryFiles(files);
  };
  const onFolderDragOver = (e: ReactDragEvent, folderPath: string) => {
    if (isViewer || !blobStore || !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation(); // highlight the folder only, not the whole pane
    setDropActive(false);
    setDropFolder(folderPath);
  };
  const onFolderDragLeave = (e: ReactDragEvent, folderPath: string) => {
    if (draggedOut(e)) setDropFolder((f) => (f === folderPath ? null : f));
  };
  const onFolderDrop = (e: ReactDragEvent, folderPath: string) => {
    e.stopPropagation();
    setDropFolder(null);
    setDropActive(false);
    if (isViewer || !blobStore || !isFileDrag(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadBinaryFiles(files, folderPath);
  };

  // Inline rename for a binary row — a SEPARATE state/handler from the text
  // rename because `project.rename` throws on a binary id (`renameBinary` is the
  // pointer-only path). Same Escape/blur cancel-ref discipline as the text row.
  const beginRenameBinary = (fileId: string, path: string) => {
    if (isViewer) return;
    cancelRenameRef.current = false;
    setRenamingBinaryId(fileId);
    setRenameValue(path);
  };
  const cancelRenameBinary = () => {
    cancelRenameRef.current = true;
    setRenamingBinaryId(null);
  };
  const commitRenameBinary = () => {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      return; // a just-fired Escape cancellation; ignore the trailing blur
    }
    const raw = renameValue.trim();
    setRenamingBinaryId(null);
    if (isViewer || !renamingBinaryId || raw === "") return;
    // Safety-gate the target the SAME way the upload path does (createBinary /
    // renameBinary don't gate): reject a traversal / reserved / control-char
    // path with a Notice rather than minting an unsafe VFS pointer.
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    if (!isSafeProjectPath(path)) {
      setNotice(infoNotice("That isn't a valid asset path."));
      return;
    }
    project.renameBinary(renamingBinaryId, path, HUMAN);
  };
  const deleteBinary = (fileId: string) => {
    if (isViewer) return;
    // Tombstone only — the blob bytes are RETAINED (restore + orphan-audit
    // invariants); a UI delete NEVER purges blob bytes.
    project.deleteBinary(fileId, HUMAN);
    if (binaryPreviewId === fileId) setBinaryPreviewId(null);
  };
  // Cache-first byte resolver for download + preview (the store verifies on read).
  const loadBinaryBytes = useCallback(
    async (hash: string): Promise<Uint8Array | undefined> => {
      const cached = binaryCacheRef.current.get(hash);
      if (cached) return cached;
      if (!blobStore) return undefined;
      try {
        return await blobStore.get(hash);
      } catch {
        return undefined;
      }
    },
    [blobStore],
  );
  const downloadBinary = async (fileId: string) => {
    const meta = project.getBinary(fileId);
    if (!meta) return;
    const bytes = await loadBinaryBytes(meta.hash);
    if (!bytes) {
      setNotice(infoNotice("Those bytes aren’t on this device yet."));
      return;
    }
    const basename = meta.path.slice(meta.path.lastIndexOf("/") + 1) || "download";
    // A download forces a save (never navigates), so the pointer mime is safe here.
    downloadBytes(bytes, basename, meta.mime || "application/octet-stream");
  };
  const openBinaryPreview = (fileId: string) => setBinaryPreviewId(fileId);
  // The asset currently open in the preview modal, resolved from the live doc —
  // null when nothing is open OR the pointer was tombstoned while open (so the
  // modal closes gracefully rather than previewing a deleted asset).
  const binaryPreviewSnap = binaryPreviewId ? project.getBinary(binaryPreviewId) : undefined;
  const binaryPreviewMeta: BinaryPreviewMeta | null =
    binaryPreviewSnap && !binaryPreviewSnap.deleted
      ? {
          fileId: binaryPreviewSnap.fileId,
          path: binaryPreviewSnap.path,
          size: binaryPreviewSnap.size,
          mime: binaryPreviewSnap.mime,
          hash: binaryPreviewSnap.hash,
        }
      : null;

  // --- Folder operations (#12) — folders are derived from paths, so every op is
  // expressed through the SAME `project.rename` primitive on the underlying
  // files; there is no folder entity to create or delete. ---

  // Collapse/expand is ephemeral view state (never persisted).
  const toggleFolder = (folderPath: string) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });

  const beginFolderRename = (folderPath: string) => {
    cancelFolderRenameRef.current = false;
    setFolderRenaming(folderPath);
    setFolderRenameValue(folderPath);
  };

  // Escape cancels the folder rename — guard before clearing state so the input's
  // trailing onBlur (commitFolderRename) doesn't re-path every file under the
  // prefix with the cancelled draft.
  const cancelFolderRename = () => {
    cancelFolderRenameRef.current = true;
    setFolderRenaming(null);
  };

  // Re-path EVERY live file under the old prefix to the new prefix, as ONE
  // transaction so the batch is a single undo unit and the observer settles once
  // (the same atomic-batch pattern project-template.ts uses for seeding). Each
  // `project.rename` opens its own transaction, but Yjs FLATTENS nested
  // transactions into the outermost one, so wrapping with `project.doc.transact`
  // coalesces them — and we stamp the outer origin with `authorOrigin(HUMAN)`,
  // identical to what each rename would have used, so authorship is never
  // double-stamped or lost. fileId/history/attribution and the mainFileId
  // pointer all survive (paths are metadata; nothing is deleted+recreated).
  const commitFolderRename = () => {
    if (cancelFolderRenameRef.current) {
      cancelFolderRenameRef.current = false;
      return; // a just-fired Escape cancellation; ignore the trailing blur
    }
    const oldPrefix = folderRenaming;
    const newPrefix = folderRenameValue.trim();
    setFolderRenaming(null);
    if (!canMutate || !oldPrefix || newPrefix === "") return;
    const steps = planFolderRename(liveFiles, oldPrefix, newPrefix);
    if (steps.length === 0) return;
    project.doc.transact(() => {
      for (const step of steps) project.rename(step.fileId, step.newPath, HUMAN);
    }, authorOrigin(HUMAN));
    // Keep the (renamed) folder's collapse state attached to its new canonical
    // prefix (mirror the helper's leading-slash canonicalization).
    const canonicalNew = newPrefix.startsWith("/") ? newPrefix : `/${newPrefix}`;
    setCollapsedFolders((prev) => {
      if (!prev.has(oldPrefix)) return prev;
      const next = new Set(prev);
      next.delete(oldPrefix);
      next.add(canonicalNew);
      return next;
    });
  };

  // The "+" on a folder row: prefill the new-file input with that folder's
  // prefix so the next created file lands inside it (a path with a prefix already
  // works; this is just an affordance).
  const newFileInFolder = (folderPath: string) => setNewFilePath(`${folderPath}/`);

  // --- Tree context menu — a right-click (or Shift+F10 / the ContextMenu key)
  // on a row opens a small menu over the SAME operations the row's buttons
  // expose; the dispatcher below maps each item id onto the EXISTING handler.

  const openTreeMenu = (e: ReactMouseEvent, target: TreeMenuTarget) => {
    // Keep the browser's native text-edit menu on the inline rename input.
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTreeMenu({ target, anchor: menuAnchor(e.clientX, e.clientY, rect) });
  };

  // Keyboard invocation, anchored at the focused element's bottom-left (the
  // explicit handler guarantees support even where the browser does not
  // synthesize a `contextmenu` event for Shift+F10).
  const treeMenuKeyDown = (e: ReactKeyboardEvent, target: TreeMenuTarget) => {
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target instanceof HTMLElement ? e.target : e.currentTarget;
      const rect = el.getBoundingClientRect();
      setTreeMenu({ target, anchor: { x: rect.left, y: rect.bottom } });
    }
  };

  const runTreeMenuAction = (id: TreeMenuItemId, target: TreeMenuTarget) => {
    if (target.kind === "binary") {
      // Preview + download are READ ops (allowed even for a viewer); rename +
      // delete mutate and are gated. Bytes may be absent → the ops degrade.
      if (id === "preview-binary") openBinaryPreview(target.fileId);
      else if (id === "download-binary") void downloadBinary(target.fileId);
      else if (!canMutate) return;
      else if (id === "rename-binary") beginRenameBinary(target.fileId, target.path);
      else if (id === "delete-binary") deleteBinary(target.fileId);
      return;
    }
    if (!canMutate) return; // viewers can't reach a mutating tree action
    if (target.kind === "file") {
      if (id === "set-main") setMain(target.fileId);
      else if (id === "rename-file") beginRename(target.fileId, target.path);
      else if (id === "delete-file") deleteFile(target.fileId);
    } else {
      if (id === "new-file-in-folder") newFileInFolder(target.path);
      else if (id === "new-subfolder") newSubfolder(target.path);
      else if (id === "rename-folder") beginFolderRename(target.path);
    }
  };

  // The main-deleted notice's inline recovery (#19.4, spec §8): an EXPLICIT
  // user action that re-points main at the file currently being edited (the
  // visible one), else the first live file. Never runs silently — only from
  // the notice's button (ADR-0013's no-auto-reassign stance is preserved).
  const pickNewMain = () => {
    if (!canMutate) return; // re-pointing main is a mutation
    const live = project.snapshot().files.filter((f) => !f.deleted);
    const target =
      activeFileId && live.some((f) => f.fileId === activeFileId)
        ? activeFileId
        : live[0]?.fileId;
    if (target) setMain(target);
  };

  // --- Version history (#12.6) ---

  // Who a commit is BY, for every path that writes one — the local version store
  // AND the GitHub snapshot push. Factored out so the two cannot drift: an
  // attribution that only half the paths stamp is exactly the bug #12 fixes.
  //
  //  - contributors (#11): WHO has contributed to the current project state — the
  //    distinct registered authors at snapshot time, via the same `authorLabel`
  //    used everywhere. A passive, derived read (never mutates the doc). Sorted
  //    for a stable, deterministic record.
  //  - author (#12): the saver's real identity. The LOCAL version store stamps it
  //    as the git commit author — isomorphic-git has no authenticated identity, so
  //    without it those commits fall back to a hardcoded `galley@localhost`. The
  //    GitHub push does NOT send it (GitHub's authenticated default is a better,
  //    LINKED identity) and uses it only to avoid self-co-authoring the pusher.
  //    There is no real email locally, so synthesize a stable per-userId noreply
  //    address (groups a user's commits); under OIDC later a real email flows in
  //    through this same seam.
  const commitAttribution = () => ({
    contributors: Array.from(
      new Set(distinctAuthors(project).map((a) => authorLabel(a))),
    ).sort(),
    author: (() => {
      const profile = loadLocalProfile();
      return {
        // Same label authorLabel() gives an anonymous author, so a solo unnamed
        // saver's author name matches their contributor entry and the equality-based
        // self-co-author suppression fires (no self Co-authored-by line).
        name: profile.displayName?.trim() || ANON_AUTHOR_LABEL,
        email: `${profile.userId}@users.galley.local`,
      };
    })(),
  });

  // Save: project the live CRDT snapshot to a git-shaped tree (materializeProject)
  // and store it as a named version. Fails closed on a duplicate/unsafe path.
  const onSaveVersion = (input: { name: string; message?: string }) => {
    const outcome = materializeProject(project.snapshot());
    if (!outcome.ok) {
      setNotice(errorNotice(`Cannot save a version: ${outcome.reason} (${outcome.detail}).`));
      return;
    }
    // Applies to BOTH manual saves and #10 auto-snapshots (this is the one path).
    const { contributors, author } = commitAttribution();
    void versionStore
      .createVersion(
        projectId,
        { ...input, author, ...(contributors.length > 0 ? { contributors } : {}) },
        outcome.result.files,
      )
      .then(() => setHistoryEpoch((n) => n + 1))
      .catch((err) => {
        // L8: keep the raw error in the console; show the user plain, reassuring copy.
        console.error("version save failed:", err);
        setNotice(errorNotice(versionErrorNotice("save")));
      });
  };

  // Automatic versioning (#10). DEFAULT-OFF: when the policy is disabled NOTHING
  // subscribes (zero overhead, byte-identical behavior) — the effect bails before
  // touching the doc. When enabled it counts doc updates and, on a DEBOUNCED
  // check (coalescing edit bursts), drives the EXISTING `onSaveVersion` path — it
  // never materializes or writes directly, never mutates the doc, never bypasses
  // the store. Viewers never auto-snapshot (`canMutate` gate). The subscription
  // and timer are torn down on unmount, on disable, and on role change.
  //
  // `onSaveVersion` is recreated each render; ref it so the doc listener is
  // subscribed ONCE per policy/role/project — not re-bound on every keystroke.
  const onSaveVersionRef = useRef(onSaveVersion);
  onSaveVersionRef.current = onSaveVersion;
  useEffect(() => {
    if (!autoSnapshotPolicy.enabled || !canMutate) return; // default-OFF: no-op
    const ydoc = project.doc;
    // Per-subscription state (not React state — avoids a render per keystroke).
    const state: AutoSnapshotState = { lastSnapshotTime: Date.now(), editsSinceLast: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const AUTO_SNAPSHOT_DEBOUNCE_MS = 1_000;

    const check = () => {
      timer = undefined;
      const now = Date.now();
      if (!shouldSnapshot(state, now, autoSnapshotPolicy)) return;
      const stamp = new Date(now).toLocaleTimeString();
      onSaveVersionRef.current({ name: `Auto-snapshot ${stamp}` });
      state.lastSnapshotTime = now;
      state.editsSinceLast = 0;
    };

    const onUpdate = () => {
      state.editsSinceLast += 1;
      // Coalesce a burst into one check ~1s after edits settle. The interval
      // cadence is also re-evaluated here, so a quiet doc that crosses the time
      // threshold snapshots on its next edit (no idle wakeup timer needed).
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(check, AUTO_SNAPSHOT_DEBOUNCE_MS);
    };

    ydoc.on("update", onUpdate);
    return () => {
      ydoc.off("update", onUpdate);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [project, autoSnapshotPolicy, canMutate]);

  // Toggle handler for the HistoryPanel opt-in control: flip enabled, applying
  // the sensible enabled defaults on turn-on, and persist. Viewer-gated.
  const onToggleAutoSnapshot = (next: boolean) => {
    if (!canMutate) return; // viewers can't enable a mutating cadence
    const policy: AutoSnapshotPolicy = next ? enabledAutoSnapshotPolicy() : { enabled: false };
    setAutoSnapshotPolicy(policy);
    saveAutoSnapshotPolicy(policy);
  };

  // Restore: load the version's tree and apply it as an explicit CRDT transaction
  // (minimal-diff / create / soft-delete — never a destructive wipe; ADR-0018).
  const onRestoreVersion = (versionId: string) => {
    if (!canMutate) return; // restore rewrites the live CRDT — viewers can't
    setNotice(null);
    void versionStore
      .getVersionTree(versionId)
      .then((tree) => {
        if (!tree) return;
        restoreProjectFromTree(project, tree, HUMAN);
        setActiveFileId(project.mainFileId());
        closePanel("history");
      })
      .catch((err) => {
        console.error("version restore failed:", err);
        setNotice(errorNotice(versionErrorNotice("restore")));
      });
  };

  // Compare two saved versions (#12.6): load both already-materialized trees and
  // diff them with the pure helper. Read-only inspection — no restore, no Accept,
  // no CRDT transaction. The panel passes the two selected ids in checkbox-click
  // order (and lists newest-first), so we re-order the pair by the store's
  // insertion order (oldest first) so the OLDER version is always the base —
  // otherwise added/removed would invert depending on selection order.
  const onCompareVersions = (aId: string, bId: string) => {
    setNotice(null);
    void versionStore
      .listVersions(projectId)
      .then((list) => {
        const order = (id: string) => {
          const i = list.findIndex((v) => v.id === id);
          return i === -1 ? Number.MAX_SAFE_INTEGER : i;
        };
        const [olderId, newerId] = order(aId) <= order(bId) ? [aId, bId] : [bId, aId];
        const label = (id: string) => list.find((v) => v.id === id)?.name ?? id;
        return Promise.all([
          versionStore.getVersionTree(olderId),
          versionStore.getVersionTree(newerId),
        ]).then(([olderTree, newerTree]) => {
          if (!olderTree || !newerTree) {
            setNotice(errorNotice("Could not load one of the selected versions to compare."));
            return;
          }
          setCompareData({
            comparison: compareVersionTrees(olderTree, newerTree),
            baseLabel: label(olderId),
            otherLabel: label(newerId),
          });
          closePanel("history");
        });
      })
      .catch((err) => {
        console.error("version compare failed:", err);
        setNotice(errorNotice(versionErrorNotice("compare")));
      });
  };

  // --- Git sync (#17.2 / ADR-0019) ---

  // Resolve THIS project's sync destination KIND — the load-order authority
  // (sync-destination.ts). For a project that predates the marker, derive it once
  // from which per-project store is populated (github repo target wins, else a
  // generic git remote, else unconfigured → the panel shows the chooser).
  const resolveSyncKind = (): "github" | "git" | null => {
    return (
      loadSyncDestination(projectId) ??
      deriveSyncDestinationKind({
        hasGithubRepoTarget: !!loadRepoTarget(projectId),
        hasGitRemote: !!loadRemoteConfig(projectId)?.url,
      })
    );
  };

  // The live CRDT projected to a git-shaped tree — shared by both push transports.
  // Carries `.galley/instructions` (14-D round-trip) so a later fetch restores it.
  const materializeLiveTree = () => {
    const outcome = materializeProject(project.snapshot(), { includeInstructions: true });
    return outcome.ok
      ? { ok: true as const, files: outcome.result.files }
      : { ok: false as const, reason: `${outcome.reason} (${outcome.detail})` };
  };

  // Push: project the live CRDT onto this project's destination — a connected
  // GitHub repo (REST snapshot via api.github.com) or a generic git remote (the
  // BROWSER RemoteSync, smart-HTTP). The token stays in this browser; the ops
  // layer redacts every error.
  const onGitPush = async () => {
    if (resolveSyncKind() === "github") {
      // Record the SAME contributors the local version store does (#11/#12), as
      // commit-message trailers. `author` is passed for ONE reason: so the pusher
      // isn't co-authored to a commit they already author. It is NOT sent to
      // GitHub — the remote author stays the authenticated PAT owner, which is
      // this same person but as a real, LINKED identity (see git-sync-ops).
      const { contributors, author } = commitAttribution();
      return pushGithubSnapshot(async () => materializeLiveTree(), {
        connection: loadGithubConnection(),
        repo: loadRepoTarget(projectId),
        author,
        ...(contributors.length > 0 ? { contributors } : {}),
      });
    }
    const cfg = loadRemoteConfig(projectId);
    if (!cfg) return { ok: false, error: "No remote configured — save a URL first." };
    return pushGitRemote(createBrowserRemoteSync(), cfg, materializeLiveTree);
  };

  // Fetch: pull the destination ref as an import CANDIDATE and route it through
  // the SAME Accept-gated compare/restore overlay as version-compare (ADR-0018 —
  // never a silent restore), for BOTH transports. The compare is current-project
  // → remote; Accept applies the remote tree via restoreProjectFromTree.
  const onGitFetch = async () => {
    const kind = resolveSyncKind();
    let result;
    if (kind === "github") {
      result = await fetchGithubSnapshot({
        connection: loadGithubConnection(),
        repo: loadRepoTarget(projectId),
      });
    } else {
      const cfg = loadRemoteConfig(projectId);
      if (!cfg) return { ok: false, error: "No remote configured — save a URL first." };
      result = await fetchGitRemote(createBrowserRemoteSync(), cfg);
    }
    if (result.ok && result.candidate) {
      // Include instructions in the BASE too, so the compare overlay is honest:
      // an identical remote `.galley/instructions` shows unchanged, not "added".
      const current = materializeProject(project.snapshot(), { includeInstructions: true });
      const base = current.ok ? current.result.files : [];
      const candidate = result.candidate;
      setCompareData({
        comparison: compareVersionTrees(base, candidate),
        baseLabel: "This project",
        otherLabel: kind === "github" ? "GitHub" : "Remote",
        onImport: () => {
          if (!canMutate) return; // importing a remote tree mutates the CRDT
          restoreProjectFromTree(project, candidate, HUMAN);
          setActiveFileId(project.mainFileId());
          setCompareData(null);
        },
      });
      closePanel("git");
    }
    return result;
  };

  // --- Active-file agent ---

  // The agent edits the ACTIVE file but self-corrects against the WHOLE project,
  // so its `check` sees cross-file imports + project-wide diagnostics. We
  // substitute the agent's scratch for the active file in the project input.
  const buildCheckInput = (scratch: string): CompileInput => {
    const input = project.toProjectInput();
    if (!input || !activeFile) return scratch;
    return {
      kind: "project",
      main: input.main,
      files: input.files.map((f) => (f.path === activeFile.path ? { path: f.path, text: scratch } : f)),
    };
  };

  // #3: the agent's read-only project tools (search_project / list_files /
  // read_file) read the LIVE project AT CALL TIME — a closure over the CRDT,
  // never a render-time copy — over the SAME visible set as the file tree and
  // the Search panel (reserved `.galley/*` config excluded), so the agent can
  // read exactly what the human can see and nothing more. Memoized on the
  // stable session so the seam identity never churns a run.
  const projectTools = useMemo(
    () =>
      buildProjectToolsSeam(() =>
        project
          .snapshot()
          .files.filter((f) => !f.deleted && !isReservedProjectPath(f.path))
          .map((f) => ({
            fileId: f.fileId,
            path: f.path,
            text: project.getFile(f.fileId)?.text ?? "",
          })),
      ),
    [project],
  );

  // #15 @-mention seam: the live, non-reserved files (path + text) the agent
  // composer can reference with `@<path>`. A lazy getter so the suggestion list
  // and the per-run attachment always read the current snapshot.
  const mentionFiles = useMemo(
    () => () =>
      project
        .snapshot()
        .files.filter((f) => !f.deleted && !isReservedProjectPath(f.path))
        .map((f) => ({ path: f.path, text: project.getFile(f.fileId)?.text ?? "" })),
    [project],
  );

  // Accept the agent's run into the ACTIVE file, conflict-aware, attributing the
  // change to the agent (a distinct peer). The AgentPanel is keyed by
  // activeFileId, so a run always belongs to the file shown when it started.
  const onAcceptActive = (run: {
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  }): boolean => {
    setNotice(null);
    // SEC: accepting an agent edit writes the agent's span into the shared doc.
    if (!canMutate) return false;
    if (!activeFileId || !activeFile) return false;
    const outcome = resolveAccept(activeFile.text, run.baseSource, run.finalSource, run.blocks);
    if (outcome.applied) {
      applyAcceptedFileAsAgent(project, activeFileId, outcome.source!, AGENT_RUN_ID);
      return true;
    }
    setNotice(
      errorNotice(
        `Could not apply cleanly — the file changed during the run (${outcome.conflicts} block(s) no longer match). Re-run the agent.`,
      ),
    );
    return false;
  };

  // H2 — the HARDENED in-app Auto final apply. Called by the AgentPanel seam AFTER
  // its checkpoint await; everything it gates on is RE-READ LIVE here (never the
  // stale run-finish closure): the project's in-app acceptance mode, `canMutate`,
  // and the ACTIVE file id + its CURRENT text (via the refs + the live CRDT). It
  // then runs the conflict-aware `resolveAccept` against that fresh text and only
  // applies behind `passesInAppFinalGate`. Any miss (flip to Ask, role dropped to
  // viewer, file switched away, or a concurrent edit ⇒ conflict) returns false, so
  // the panel falls back to the mandatory Ask `DiffReview` gate. This is the in-app
  // analogue of the MCP `passesFinalApplyGate`.
  const commitInAppAuto = (run: {
    baseSource: string;
    finalSource: string;
    blocks: { search: string; replace: string }[];
  }): boolean => {
    // LIVE re-reads (post-checkpoint): never the captured render values.
    const liveMode = getProjectAcceptanceMode(projectId);
    const liveCanMutate = canMutateRef.current;
    const liveFileId = activeFileIdRef.current;
    if (liveFileId === null) return false;
    const liveFileRec = project.getFile(liveFileId);
    if (liveFileRec === undefined) return false;
    const liveText = liveFileRec.text;
    // The conflict-aware re-plan against the LIVE text (a concurrent edit during
    // the checkpoint window surfaces here as a conflict, never a clobber).
    const outcome = resolveAccept(liveText, run.baseSource, run.finalSource, run.blocks);
    // The single final gate: still Auto, still able to mutate, and no conflict.
    if (!passesInAppFinalGate({ mode: liveMode, canMutate: liveCanMutate, conflict: !outcome.applied })) {
      return false;
    }
    applyAcceptedFileAsAgent(project, liveFileId, outcome.source!, AGENT_RUN_ID);
    return true;
  };

  // Accept an MCP agent proposal (#16.1) into its TARGET file through the SAME
  // conflict-aware gate as the in-app agent: `resolveAccept` re-applies the
  // proposal's edit blocks when the live text moved past its baseText (a stale
  // proposal surfaces as a conflict, never a clobber), then the accepted source
  // lands as the agent peer. The verdict is recorded in the shared mailbox so
  // the kernel sees it. NEVER auto-applies — this handler only runs from the
  // proposal card's Accept button.
  const onAcceptProposal = (p: ProposalRecord): boolean => {
    setNotice(null);
    // SEC: accepting an MCP proposal lands the agent's edit AND records a verdict
    // in the shared mailbox — both shared-doc writes a viewer must not make.
    if (!canMutate) return false;
    // STRICT target resolution (finding 3): paths can duplicate during a CRDT
    // conflict; Accept must know exactly which file it would mutate. Zero or
    // multiple live matches block the apply — never guess a winner.
    const target = findProposalTarget(project.snapshot().files, p.filePath);
    if (!target.ok) {
      setNotice(
        errorNotice(
          target.reason === "missing"
            ? `Could not apply the proposal — ${p.filePath} is no longer in the project.`
            : `Could not apply the proposal — ${target.count} files share the path ${p.filePath}. Resolve the duplicate-path conflict first.`,
        ),
      );
      return false;
    }
    const file = target.file;
    const outcome = resolveAccept(file.text, p.baseText, p.proposedText, p.blocks);
    if (!outcome.applied) {
      setNotice(
        errorNotice(
          `Could not apply cleanly — the file changed since the proposal (${outcome.conflicts} block(s) no longer match). Ask the agent to re-propose.`,
        ),
      );
      return false;
    }
    applyAcceptedFileAsAgent(project, file.fileId, outcome.source!, "mcp");
    resolveProposal(project, p.id, "accepted", HUMAN);
    return true;
  };

  const onRejectProposal = (p: ProposalRecord) => {
    setNotice(null);
    // SEC: recording a reject verdict writes to the shared proposal mailbox.
    if (!canMutate) return;
    resolveProposal(project, p.id, "rejected", HUMAN);
  };

  // Accept a MULTI-FILE proposal (`propose_files`) ATOMICALLY through the SAME
  // conflict-aware gate. `planFileProposalAccept` validates EVERY op against the
  // live snapshot first (create paths free; edit targets unique + cleanly
  // re-appliable); on ANY failure nothing is applied (never a partial landing).
  // Only with a fully-resolved plan do we mutate: create each new file then fill
  // its body as the agent peer, rewrite each edit as the agent peer, and record
  // the verdict. Returns true when applied. NEVER auto-applies on its own — the
  // card's "Accept all" button drives it.
  const onAcceptFileProposal = async (p: FileProposalRecord): Promise<boolean> => {
    setNotice(null);
    // SEC: applies agent edits AND records a verdict in the shared mailbox —
    // both shared-doc writes a viewer must not make.
    if (!canMutate) return false;
    // B1: settle EXACTLY ONCE per id — a concurrent re-entry (double-click, the run
    // batcher, the auto path) for the same proposal returns false immediately while
    // the first accept's async blob gate is still pending, so the plan can't apply
    // twice. Released in `finally`.
    if (fileAcceptInFlight.current.has(p.id)) return false;
    fileAcceptInFlight.current.add(p.id);
    try {
      // A2 — the ACCEPT-TIME blob-presence gate (the dangling-pointer guard): every
      // create-binary op's bytes MUST be present + uncorrupt in the blob store
      // (verify-on-read), else leave the WHOLE proposal pending and apply NOTHING.
      // We plan ONCE to discover the binary creates, run the async gate, then —
      // because the gate awaited and the world may have moved (B1) — RE-CHECK the
      // proposal is still pending and RE-PLAN against a FRESH snapshot, applying
      // ONLY the fresh plan. This is the SAME gate the auto path drives (under the
      // applier lock), so a signed create-binary proposal can never auto-create a
      // CRDT pointer to absent bytes either.
      const probe = planFileProposalAccept(project.snapshot(), p.ops);
      if (!probe.ok) {
        setNotice(errorNotice(`Could not apply the proposal — ${probe.reason}`));
        return false;
      }
      if (probe.plan.binaryCreates.length > 0) {
        if (!blobStore) {
          setNotice(
            errorNotice(
              "Could not apply the proposal — the binary store is unavailable, so its image bytes can't be verified.",
            ),
          );
          return false;
        }
        const present = await verifyBinaryBlobsPresent(probe.plan.binaryCreates, blobStore);
        if (!present.ok) {
          setNotice(
            errorNotice(
              `Could not apply the proposal — the bytes for ${present.missingPath} have not arrived yet. Nothing was applied; try Accept again once the upload finishes.`,
            ),
          );
          return false;
        }
      }
      // B1 — TOCTOU guard after the await: the proposal must STILL be pending (a
      // peer/tab may have resolved it during the gate), and the plan must be
      // RE-COMPUTED against the LIVE snapshot (paths may have changed → a stale
      // plan could create a duplicate). Apply only this fresh plan.
      if (getFileProposal(project, p.id)?.status !== "pending") return false;
      const planned = planFileProposalAccept(project.snapshot(), p.ops);
      if (!planned.ok) {
        setNotice(errorNotice(`Could not apply the proposal — ${planned.reason}`));
        return false;
      }
      try {
        // ATOMIC: the whole validated plan is staged on a transient agent clone and
        // merged back as ONE update — no partial landing, no empty-file
        // intermediate, and a throw leaves the live project untouched.
        applyAcceptedFileSetAsAgent(project, planned.plan, "mcp");
        resolveFileProposal(project, p.id, "accepted", HUMAN);
        // Servable-provenance: the Accept has LANDED the create-binary pointer(s)
        // through the normal conflict-gated Accept seam (manual OR foreground
        // auto-accept — both drive this handler). Grant each accepted binary hash
        // ONLY now — strictly AFTER the pointer applied, NEVER at the pre-Accept
        // `verifyBinaryBlobsPresent` presence gate above. Best-effort: a mark
        // failure only leaves the asset temporarily non-servable (fail-closed).
        if (blobStore) {
          for (const b of planned.plan.binaryCreates) {
            await blobStore.markServable(b.asset.hash).catch(() => undefined);
          }
        }
        return true;
      } catch (err) {
        // An unexpected failure: surface it and leave the proposal PENDING (never
        // silently half-resolved). The validated plan makes this near-impossible,
        // but we never claim success we didn't achieve.
        setNotice(errorNotice(`Could not finish applying the proposal — ${String(err)}`));
        return false;
      }
    } finally {
      fileAcceptInFlight.current.delete(p.id);
    }
  };

  const onRejectFileProposal = (p: FileProposalRecord) => {
    setNotice(null);
    if (!canMutate) return;
    resolveFileProposal(project, p.id, "rejected", HUMAN);
  };

  // Accept EVERY record of a run in publish-`seq` order (ADR-0025 §5), each
  // through the SAME per-record conflict-aware gate above. The `applyRunAccepts`
  // helper STOPS on the first failure/conflict, leaving the remainder pending —
  // a partial apply is allowed and reported, never a silent skip. `runId` only
  // groups the card; this just sequences the per-record accepts the user could
  // click one by one, so it can never bypass a conflict check.
  const onAcceptRunGroup = async (group: RunGroup): Promise<void> => {
    setNotice(null);
    if (!canMutate) return;
    const outcome = await applyRunAccepts(group.records, (record) =>
      "ops" in record
        ? onAcceptFileProposal(record as FileProposalRecord)
        : onAcceptProposal(record as ProposalRecord),
    );
    // On a partial apply, surface what landed and what is still pending. The
    // per-record handler already set a specific conflict notice for the record it
    // stopped at, so only ADD a summary when more than one record was involved.
    if (outcome.stoppedAt !== null && outcome.applied.length > 0) {
      setNotice(
        infoNotice(
          `Applied ${outcome.applied.length} of ${group.records.length} change(s); ${outcome.remaining.length} still pending after a conflict — review the rest individually.`,
        ),
      );
    }
  };

  // Reject every CURRENTLY-received record of a run (ADR-0025 §5). While a run is
  // still streaming this rejects only the records already in the group; it does
  // not block on future records (those arrive individually reviewable).
  const onRejectRunGroup = (group: RunGroup): void => {
    setNotice(null);
    if (!canMutate) return;
    for (const record of group.records) {
      if ("ops" in record) resolveFileProposal(project, record.id, "rejected", HUMAN);
      else resolveProposal(project, record.id, "rejected", HUMAN);
    }
  };

  // --- Auto-accept (ADR-0023) -------------------------------------------------

  // Disarm (the internal pause path) — flips the PERSISTED grant back to Ask (the
  // single source of truth the apply path reads) and the UI mirror, surfacing a
  // reason. Used by the auto-apply machinery's fail-closed paths (a corrupt/full
  // audit, a missing checkpoint). The USER-facing kill-switch is the panel's
  // `onSelectAgentMode("ask")`; arming likewise goes through the panel now.
  const disarmAutoAccept = useCallback((reason?: string) => {
    getControlResponderManager().setGrantMode("ask");
    setAutoAccept(false);
    if (reason !== undefined) setNotice(errorNotice(reason));
  }, []);

  // ADR-0025 §1 (Task 8): the unified Agent-access mode selector — the SINGLE
  // entry point the panel's Ask/Auto control + kill-switch call. It writes the two
  // authoritative stores per the pure `agentModeWrites` policy:
  //   - the IN-APP project store is ALWAYS written (`setProjectAcceptanceMode`);
  //   - the MCP GRANT store is written ONLY when a grant is active — a plain
  //     project setting must NEVER authorize MCP auto-apply (ADR-0025 §1). The
  //     guard is `writes.grant` (true only when `getActiveGrant() !== null`).
  // A viewer can never flip it (the panel is hidden too; fail closed here as well).
  const onSelectAgentMode = useCallback(
    (mode: AgentMode) => {
      if (!canMutate) return;
      setNotice(null);
      // H1: a grant is "active" for THIS panel only when it is THIS project's
      // grant — never project A's grant while project B's UI is mounted. Routing
      // the write-eligibility through the scoped read means a project-B selection
      // can never call setGrantMode and flip project-A's MAC'd disposition.
      const grantActive =
        getControlResponderManager().getActiveGrantForProject(projectId) !== null;
      const writes = agentModeWrites(mode, grantActive);
      // In-app authority: always.
      setProjectAcceptanceMode(projectId, writes.mode);
      setInAppMode(writes.mode);
      // MCP authority: only with a live grant. `setGrantMode` is itself a no-op
      // without one, but the explicit guard documents the invariant.
      if (writes.grant) {
        getControlResponderManager().setGrantMode(writes.mode);
        setAutoAccept(writes.mode === "auto");
        // F7 (ADR-0025 §8.1 explicit-arm carve-out): an EXPLICIT user click on Auto
        // for a paired agent is deliberate intent — distinct from the passive
        // backlog the future-records-only rule suppresses. Promote the CURRENTLY-
        // pending paired-agent records (read LIVE, not from React state, so the set
        // is fresh) to eligible, then re-drive them through the SAME runAutoAccept
        // chain the mailbox observers use. Every authorization gate (signature /
        // replay / seq / volume / viewer) + the live final-apply gate + single-
        // applier lock still runs inside runAutoAccept — promotion only lifts the
        // first-sight suppression, never widens trust. Guarded by writes.grant, so a
        // no-grant in-app setting can never trigger an MCP apply.
        if (writes.mode === "auto") {
          const singles = getPendingProposals(project);
          const files = getPendingFileProposals(project);
          promotePendingToEligible(
            autoEligibilityRef.current,
            [...singles.map((p) => p.id), ...files.map((p) => p.id)],
          );
          for (const p of singles) {
            autoAcceptChain.current = autoAcceptChain.current
              .then(() => runAutoAcceptRef.current("single", p))
              .catch(() => {});
          }
          for (const p of files) {
            autoAcceptChain.current = autoAcceptChain.current
              .then(() => runAutoAcceptRef.current("file", p))
              .catch(() => {});
          }
        }
      }
      refreshAutoAcceptAudit();
    },
    [canMutate, projectId, project, refreshAutoAcceptAudit],
  );

  // The EFFECTIVE mode the panel DISPLAYS: Auto when either authoritative store is
  // on Auto (the MCP grant `mode` when a grant exists, OR the in-app setting).
  const effectiveMode = effectiveAgentMode(autoAccept ? "auto" : agentGrantActive ? "ask" : null, inAppMode);

  // Write a labeled, restorable pre-image version BEFORE an auto-apply (ADR-0023
  // §3). Returns the version id, or null on ANY failure (a bad materialization, a
  // store/quota error) — the caller PAUSES auto-accept rather than apply without
  // a restore point. Manual Accept is deliberately NOT checkpointed.
  const checkpointBeforeApply = useCallback(
    async (request: string): Promise<string | null> => {
      const outcome = materializeProject(project.snapshot());
      if (!outcome.ok) return null;
      try {
        const version = await versionStore.createVersion(
          projectId,
          {
            name: `Auto-accept: ${request}`.slice(0, 200),
            message: "Before a signed MCP proposal (auto-accepted)",
            author: { name: "Galley agent", email: "agent@users.galley.local" },
          },
          outcome.result.files,
        );
        return version.id;
      } catch {
        return null;
      }
    },
    [project, versionStore, projectId],
  );

  // The IN-APP agent's pre-apply checkpoint (ADR-0025 §4) — the Undo target for an
  // in-app Auto apply. Mirrors `checkpointBeforeApply` (materialize → createVersion
  // → id, null on ANY failure so the caller falls back to the Ask gate) with an
  // in-app-flavored label. Kept distinct from the MCP one so the two surfaces'
  // version history reads honestly.
  const checkpointBeforeInAppApply = useCallback(
    async (request: string): Promise<string | null> => {
      const outcome = materializeProject(project.snapshot());
      if (!outcome.ok) return null;
      try {
        const version = await versionStore.createVersion(
          projectId,
          {
            name: `Agent (auto): ${request}`.slice(0, 200),
            message: "Before an in-app agent run (auto-applied)",
            author: { name: "Galley agent", email: "agent@users.galley.local" },
          },
          outcome.result.files,
        );
        return version.id;
      } catch {
        return null;
      }
    },
    [project, versionStore, projectId],
  );

  // Decide + (if eligible) auto-apply ONE pending proposal. Reads the armed state
  // and verifier/audit FRESH from the grant (the single source of truth), so a
  // stale observer closure can never re-arm a disarmed session. Drives the
  // EXISTING accept handler, which re-validates the conflict gate against the live
  // snapshot (the verify→apply TOCTOU guard) and is the sole apply chokepoint.
  const runAutoAccept = useCallback(
    async (kind: "single" | "file", record: ProposalRecord | FileProposalRecord): Promise<void> => {
      // A cheap synchronous re-entrancy backstop. NOTE: auto-applies are now
      // serialized through `autoAcceptChain`, so a concurrent double-fire for the
      // same record can't happen (the prior task's `finally` releases this id
      // before the next chain link runs). Double-apply is actually prevented by
      // the CRDT `status !== "pending"` gate and the `started` audit tombstone
      // (replay gate) in gateCommon. This set stays as a harmless backstop that
      // keeps the apply body re-entrancy-safe if the serialization ever changes.
      if (autoApplyInFlight.current.has(record.id)) return;
      autoApplyInFlight.current.add(record.id);
      try {
        const manager = getControlResponderManager();
        // H1: read the grant SCOPED to this project — a grant for a different
        // project never authorizes an auto-apply under this ProjectApp.
        const grant = manager.getActiveGrantForProject(projectId);
        // FAIL CLOSED: unarmed, viewer, joined session, no verifier/audit → manual.
        if (!canMutate || grant === null || grant.mode !== "auto") return;
        if (config.syncUrl !== undefined) return; // a joined session never auto-applies
        const verifier = manager.getProposalVerifier();
        const audit = manager.getAudit();
        if (verifier === null || audit === null) return;

        const vol = appliedVolumeRef.current;
        const ctx: AutoAcceptCtx = {
          armed: true,
          canMutate,
          joinedSession: config.syncUrl !== undefined,
          verify: verifier.verifyFor,
          scopeFor: verifier.scopeFor,
          audit,
          snapshot: project.snapshot(),
          lastAppliedSeq: lastAppliedSeqRef.current,
          // (per-mailbox: the decision core reads the slot for THIS mailbox)
          volume: {
            opsThisWindow: vol.ops,
            bytesThisWindow: vol.bytes,
            maxOps: AUTO_ACCEPT_MAX_OPS,
            maxBytes: AUTO_ACCEPT_MAX_BYTES,
          },
          // A2/B3: verify create-binary bytes BEFORE any tombstone is written, so a
          // not-yet-arrived blob never replay-blocks the proposal (it stays cleanly
          // auto-eligible for the next wake). Absent store ⇒ undefined ⇒ the decision
          // fails closed (a binary proposal won't auto-apply without a store).
          ...(blobStore
            ? {
                binaryPresent: (binaryCreates: { path: string; asset: { hash: string } }[]) =>
                  verifyBinaryBlobsPresent(
                    binaryCreates as { path: string; asset: BinaryAsset }[],
                    blobStore,
                  ),
              }
            : {}),
        };
        const decision =
          kind === "single"
            ? await decideAutoAcceptSingle(record as ProposalRecord, ctx)
            : await decideAutoAcceptFile(record as FileProposalRecord, ctx);
        if ("manual" in decision) return; // not eligible → leave it for the human card
        const digest = decision.apply.digest;
        const fileCount = kind === "single" ? 1 : (record as FileProposalRecord).ops.length;
        // A2: charge the applied-volume window with proposed-TEXT bytes PLUS every
        // create-binary op's blob `size`, so a binary auto-apply consumes the byte
        // burst-budget (mirrors `proposedBytes` in the decision gate — without the
        // binary term a large signed image would cost 0 bytes and slip the limiter).
        const proposedBytes =
          kind === "single"
            ? utf8.encode((record as ProposalRecord).proposedText).length
            : (record as FileProposalRecord).ops.reduce(
                (n, o) =>
                  n +
                  utf8.encode(o.proposedText).length +
                  (o.kind === "create-binary" && o.binaryAsset !== undefined
                    ? o.binaryAsset.size
                    : 0),
                0,
              );

        // `started` BEFORE the checkpoint/apply: a crash mid-apply still leaves a
        // tombstone that blocks any replay of this digest on the next load.
        audit.mark(record.id, digest, "started", { request: record.request, fileCount });
        if (audit.corrupt() || audit.overflowed()) {
          disarmAutoAccept(
            "Auto-accept paused: its audit log is full or unreadable. Review what landed, then re-arm.",
          );
          refreshAutoAcceptAudit();
          return;
        }
        // DURABILITY (review High-2): only proceed if the `started` tombstone was
        // actually persisted — `mark` swallows write failures (quota/privacy), so
        // re-read it. If it didn't stick, applying would have no replay barrier on
        // reload: pause instead.
        if (audit.state(record.id, digest) !== "started") {
          disarmAutoAccept(
            "Auto-accept paused: the audit log could not be written, so the replay guard is not durable.",
          );
          return;
        }
        const checkpointId = await checkpointBeforeApply(record.request);
        if (checkpointId === null) {
          disarmAutoAccept("Auto-accept paused: a pre-apply checkpoint could not be written.");
          return;
        }
        // THE FINAL PRE-APPLY GATE (ADR-0025 §8.1) — the LAST thing before apply,
        // AFTER the async checkpoint and the TOCTOU pending re-check. Every input is
        // RE-READ LIVE here, per record, so a flip to Ask / kill-switch / role drop
        // / lost ownership election wins IMMEDIATELY and this record stays pending:
        //   - mode: re-read from the grant store (not the decision-time value);
        //   - canMutate: the live role;
        //   - stillPending: the TOCTOU status re-check against the live doc;
        //   - ownsAutoApplier: this tab won the single-auto-applier election for
        //     the grant (ADR-0025 §8.2) — FAIL CLOSED to Ask when ambiguous, so two
        //     resumed tabs never race the same signed record.
        // (The accept handler additionally re-plans against the live snapshot — the
        // conflict-aware TOCTOU guard — as a further backstop after this gate.)
        const liveMode =
          getControlResponderManager().getActiveGrantForProject(projectId)?.mode ?? null;
        const stillPending =
          (kind === "single"
            ? getProposal(project, record.id)
            : getFileProposal(project, record.id))?.status === "pending";
        const ownsAutoApplier = isAutoApplierOwner(activeAwarenessRef.current, grant.grantId);
        if (
          !passesFinalApplyGate({
            mode: liveMode,
            canMutate,
            stillPending,
            ownsAutoApplier,
          })
        ) {
          audit.mark(record.id, digest, "failed", { request: record.request, fileCount });
          refreshAutoAcceptAudit();
          return;
        }
        // H3 — the HARD single-applier guarantee: run the ACTUAL apply under a
        // same-origin Web Lock keyed by the grant id. The awareness election above
        // is only a coarse hint (awareness is peer-writable, and two tabs can each
        // see only their own claim and both "win"); the lock is the real mutual
        // exclusion among same-origin tabs. FAIL CLOSED: when the lock is already
        // held (another tab is applying) OR the Web Locks API is unavailable
        // (jsdom/old runtime), `ranWithLock` is false and we DO NOT apply — the
        // record stays for manual review.
        const lockOutcome = await withAutoApplierLock(grant.grantId, async () =>
          kind === "single"
            ? onAcceptProposal(record as ProposalRecord)
            : onAcceptFileProposal(record as FileProposalRecord),
        );
        if (!lockOutcome.ranWithLock) {
          audit.mark(record.id, digest, "failed", { request: record.request, fileCount });
          refreshAutoAcceptAudit();
          return;
        }
        const applied = lockOutcome.result === true;
        if (applied) {
          audit.mark(record.id, digest, "applied", {
            request: record.request,
            fileCount,
            checkpointVersionId: checkpointId,
          });
          lastAppliedSeqRef.current[kind === "single" ? "mcpProposals" : "mcpFileProposals"] =
            record.seq;
          vol.ops += fileCount;
          vol.bytes += proposedBytes;
        } else {
          // The handler re-validated against the live snapshot and declined (a
          // TOCTOU conflict): mark it and leave the human card to take over.
          audit.mark(record.id, digest, "failed", { request: record.request, fileCount });
        }
        refreshAutoAcceptAudit();
      } finally {
        autoApplyInFlight.current.delete(record.id);
      }
    },
    [
      canMutate,
      config.syncUrl,
      project,
      checkpointBeforeApply,
      disarmAutoAccept,
      refreshAutoAcceptAudit,
      onAcceptProposal,
      onAcceptFileProposal,
    ],
  );
  // The observers fire synchronously; keep the latest closure in a ref so they
  // call the current `runAutoAccept` without re-subscribing each render.
  const runAutoAcceptRef = useRef(runAutoAccept);
  runAutoAcceptRef.current = runAutoAccept;

  // Insert a generated snippet (#8 figure / #15 import) into the ACTIVE file as a
  // reviewable change through the SAME conflict-aware Accept flow: append it to
  // the active file's text and route the whole-source block through
  // `onAcceptActive` (fast path when unchanged; conflicts, never clobbers, if the
  // file moved meanwhile). Accept stays mandatory — never auto-apply.
  const onInsertSnippet = (snippet: string): boolean => {
    if (!activeFile) return false;
    const baseSource = activeFile.text;
    const finalSource = appendSnippet(baseSource, snippet);
    return onAcceptActive({
      baseSource,
      finalSource,
      blocks: wholeSourceBlock(baseSource, finalSource),
    });
  };

  // #13 — draft a CRediT-style author-contribution statement from this project's
  // REAL attributed history and open it for REVIEW (never auto-applied). Evidence:
  //   - the version history (#11 `contributors`) via the live version store, and
  //   - per-file authorship, resolving each visible file's `Y.Text` to author-
  //     labelled spans with `textAttributedRanges` + `authorLabel`.
  // The pure `gatherContributionEvidence` adapter + `buildContributionStatement`
  // core do the inference; we only render and SURFACE the draft here. The actual
  // insertion happens later, through `onInsertContribution` → the Accept gate.
  const openContributionStatement = useCallback(() => {
    if (!canMutate) return; // SEC: only an editor can land the resulting doc edit
    void versionStore
      .listVersions(projectId)
      .then((versions) => {
        const files: AttributedFile[] = liveFiles.map((f) => {
          const ytext = project.fileText(f.fileId);
          const ranges = ytext
            ? textAttributedRanges(project, ytext).map((r) => ({
                author: r.author ? authorLabel(r.author) : undefined,
                length: r.to - r.from,
              }))
            : [];
          return { path: f.path, ranges };
        });
        const input = gatherContributionEvidence(versions, files);
        const text = renderContributionStatement(buildContributionStatement(input), {
          heading: true,
        });
        setContributionDraft(text);
      })
      .catch(() => {
        setNotice(errorNotice("Could not read the project history to draft a contribution statement."));
      });
  }, [canMutate, versionStore, projectId, liveFiles, project]);

  // Insert the reviewed contribution draft into the active file through the SAME
  // conflict-aware Accept flow as every other generated snippet (`onInsertSnippet`
  // → `onAcceptActive`). The human has already reviewed the draft in the modal and
  // explicitly clicked "Insert"; Accept stays mandatory (a moved file conflicts,
  // never clobbers). Close the modal afterwards.
  const onInsertContribution = useCallback(() => {
    const draft = contributionDraft;
    if (draft === null) return;
    if (!canMutate) return; // SEC: redundant with the modal gate, fail closed anyway
    onInsertSnippet(draft);
    setContributionDraft(null);
  }, [contributionDraft, canMutate, onInsertSnippet]);

  // Focus / Zen mode (#18.5): persist + apply the boolean. Toggling collapses the
  // agent panel and the file pane via a `data-focus` attribute on the shell root.
  const toggleFocusMode = useCallback(() => {
    setFocusMode((on) => {
      const next = !on;
      saveFocusMode(next);
      // Mutually exclusive with agent mode (#14): turning focus ON clears agent
      // mode, otherwise BOTH the editor and the agent could hide, leaving only
      // the preview. Turning focus OFF leaves agent mode as-is (already off).
      if (next) {
        setAgentMode(false);
        saveAgentMode(false);
      }
      return next;
    });
  }, []);

  // Agent mode (#14): persist + apply the boolean. The MIRROR of focus mode —
  // collapses the EDITOR and the file pane via a `data-agent` attribute on the
  // shell root, leaving an agent+preview view. Mutually exclusive with focus
  // mode: turning agent ON clears focus mode (else both panes could hide).
  const toggleAgentMode = useCallback(() => {
    setAgentMode((on) => {
      const next = !on;
      saveAgentMode(next);
      if (next) {
        setFocusMode(false);
        saveFocusMode(false);
      }
      return next;
    });
  }, []);

  // Citation → bibliography (#6): route the resolved citation into the project's
  // bibliography library as BibTeX (a `.bib` is compiled AS BibTeX and read back by
  // `parseBibtex` — see `bibEntryText`). Append it to the first `.bib` file via the
  // existing CRDT file-write path (transactFile), creating `/refs.bib` if the
  // project has none yet. The in-text `@cite` is inserted separately by the panel
  // through `onInsertSnippet`; both reference the same deterministic key.
  const onAddToBibliography = useCallback(
    (resolved: ResolvedCitation) => {
      if (!canMutate) return; // SEC: writing a .bib entry mutates the shared doc
      // A `.bib` is compiled AS BibTeX and parsed by every Galley reader with
      // `parseBibtex` — emit BibTeX (via `bibEntryText`/`toBibtex`), NOT the
      // review-only Hayagriva YAML, so the entry is visible + compiles.
      const entry = bibEntryText(resolved).trimEnd();
      const bibFile = project.snapshot().files.find(
        (f) => !f.deleted && f.path.toLowerCase().endsWith(".bib"),
      );
      if (bibFile) {
        project.transactFile(
          bibFile.fileId,
          (t) => {
            const sep = t.length > 0 && !t.toString().endsWith("\n") ? "\n\n" : t.length > 0 ? "\n" : "";
            t.insert(t.length, `${sep}${entry}\n`);
          },
          HUMAN,
        );
      } else {
        project.create("/refs.bib", `${entry}\n`, HUMAN);
      }
    },
    [project, canMutate],
  );

  // Citation library deduplication (#6): replace the first `.bib` file's text with
  // the de-duplicated library in ONE CRDT transaction (so a single Undo reverts the
  // whole merge). A DIRECT user edit — no Accept gate. The transaction is run with
  // a NULL origin (not author-tagged) ON PURPOSE: the active editor's Yjs
  // UndoManager tracks only the null origin, so a null-origin write lands in the
  // editor's undo stack and a single ⌘Z reverts the merge (an author-tagged write
  // would not be undoable). Like every mutating bib affordance, it fails closed for
  // a viewer.
  const onRewriteBibliography = useCallback(
    (text: string) => {
      if (!canMutate) return; // SEC: rewriting the .bib mutates the shared doc
      const bibFile = project.snapshot().files.find(
        (f) => !f.deleted && f.path.toLowerCase().endsWith(".bib"),
      );
      if (!bibFile) return;
      const ytext = project.fileText(bibFile.fileId);
      if (!ytext) return;
      project.doc.transact(() => {
        if (ytext.length > 0) ytext.delete(0, ytext.length);
        ytext.insert(0, text);
      });
    },
    [project, canMutate],
  );

  // 14-D authoring: persist the project-instructions editor. A deliberate HUMAN
  // config edit (NOT an agent document edit) — it writes straight to the CRDT and
  // does NOT go through the Accept/diff gate (that gate is for agent proposals).
  // The `ydoc.on("update")` handler bumps `refreshTick`, so `agentInstructions`
  // re-derives automatically after the write. The create-or-replace + duplicate
  // coalescing lives in the shared `writeProjectInstructions` seam (also used by
  // the export → import round-trip in `restoreProjectFromTree`).
  const onSaveInstructions = useCallback(
    (text: string) => {
      if (!canMutate) return; // SEC: instructions are a shared CRDT config write
      writeProjectInstructions(project, text, HUMAN);
      setInstructionsOpen(false);
    },
    [project, canMutate],
  );

  // 14-D: remove ALL live instructions files (tombstone) — back to default-OFF.
  const onRemoveInstructions = useCallback(() => {
    if (!canMutate) return; // SEC: tombstoning instructions mutates the shared doc
    const live = project
      .snapshot()
      .files.filter((f) => !f.deleted)
      .map((f) => ({ fileId: f.fileId, path: f.path, text: "" })) as InstructionsEditFile[];
    for (const f of findAllInstructionsFiles(live)) project.delete(f.fileId, HUMAN);
    setInstructionsOpen(false);
  }, [project, canMutate]);

  // Click-to-rename header (project-model redesign §5). Begin seeds the draft
  // with the current name; commit trims and, if non-empty AND changed, calls
  // `onRenameProject`; an empty/whitespace or unchanged draft simply reverts.
  const beginNameEdit = useCallback(() => {
    if (!onRenameProject) return;
    nameRenameCancelledRef.current = false;
    setNameDraft(projectName ?? "");
    setNameEditing(true);
  }, [onRenameProject, projectName]);

  const commitNameEdit = useCallback(() => {
    if (nameRenameCancelledRef.current) {
      nameRenameCancelledRef.current = false;
      setNameEditing(false);
      return;
    }
    const trimmed = nameDraft.trim();
    if (trimmed.length > 0 && trimmed !== projectName) onRenameProject?.(trimmed);
    setNameEditing(false);
  }, [nameDraft, projectName, onRenameProject]);

  const cancelNameEdit = useCallback(() => {
    nameRenameCancelledRef.current = true;
    setNameEditing(false);
  }, []);

  // Quick-fix (#11.4b): build the scoped agent request from a diagnostic on the
  // active file and hand it to the AgentPanel to run. Accept stays mandatory (the
  // run yields a reviewable diff). Mirrors App.tsx's onQuickFix.
  const onQuickFix = (diagnostic: Parameters<typeof quickFixForDiagnostic>[0]) => {
    if (!canMutate || !activeFile) return; // SEC: a quick-fix run yields an Accept-gated doc edit
    const qf = quickFixForDiagnostic(diagnostic, activeFile.text);
    if (panes.isCollapsed("sidebar")) panes.toggleCollapse("sidebar");
    setPendingRun((p) => ({ request: qf.request, nonce: (p?.nonce ?? 0) + 1 }));
  };

  // Explain (#18.4): build the scoped advice-only request from a diagnostic on
  // the active file and hand it to the AgentPanel. The answer is a plain-text
  // explanation — the run is flagged adviceOnly, so no diff/Accept gate and the
  // document never changes. Mirrors App.tsx's onExplain.
  const onExplain = (diagnostic: Parameters<typeof explainForDiagnostic>[0]) => {
    if (!activeFile) return;
    const ex = explainForDiagnostic(diagnostic, activeFile.text);
    if (panes.isCollapsed("sidebar")) panes.toggleCollapse("sidebar");
    setPendingRun((p) => ({ request: ex.request, nonce: (p?.nonce ?? 0) + 1, adviceOnly: true }));
  };

  // #13 follow-up: insert `@<label>` at the live editor cursor (replacing any
  // selection), then refocus the editor. A direct editor edit — like typing —
  // NOT an agent run, so the Accept/diff gate doesn't apply (the user explicitly
  // picked the label). Closes the picker after inserting.
  const onInsertReference = useCallback(
    (label: string) => {
      if (!canMutate) {
        // SEC: a view.dispatch insert writes into the shared editor doc.
        setInsertRefOpen(false);
        return;
      }
      const view = editorViewRef.current;
      if (view) {
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: `@${label}` } });
        view.focus();
      }
      setInsertRefOpen(false);
    },
    [canMutate],
  );

  // Revise selection (11.8b): read the LIVE editor selection synchronously from
  // the `EditorView`, or null when there's no view / the selection is empty.
  // Pure line/text math lives in `selectionFromEditor`; this just adapts the live
  // state to its CodeMirror-like shape (which the real `EditorState` satisfies).
  const readEditorSelection = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return null;
    return selectionFromEditor(view.state);
  }, []);

  // Whether a non-empty selection exists right now (gates the command/shortcut).
  const hasSelection = useCallback(() => readEditorSelection() !== null, [readEditorSelection]);

  // Open the revise prompt for the CURRENT selection. Snapshots the region so a
  // later selection change can't silently retarget the run; no-ops (with a
  // notice) when the selection is empty/stale. Mirrors onQuickFix's shape.
  const openReviseSelection = useCallback(() => {
    if (!canMutate) return; // SEC: revise yields an Accept-gated doc edit (raw shortcut too)
    const sel = readEditorSelection();
    if (!sel) {
      setNotice(infoNotice("Select some text in the editor first, then choose Revise selection."));
      return;
    }
    setRevisePrompt({ text: sel.text, startLine: sel.startLine, endLine: sel.endLine });
  }, [readEditorSelection, canMutate]);

  // Submit the revise prompt: compose the scoped request from the snapshot + the
  // typed instruction and hand it to the AgentPanel via `pendingRun` (mirrors
  // onQuickFix EXACTLY — bumped nonce, sidebar revealed). Accept stays mandatory:
  // the run yields a reviewable diff the human still Accepts; never auto-applied.
  const onReviseSelectionSubmit = (instruction: string) => {
    const snap = revisePrompt;
    setRevisePrompt(null);
    if (!snap) return;
    if (instruction.trim() === "") return;
    const request = composeReviseRequest({
      selectedText: snap.text,
      startLine: snap.startLine,
      endLine: snap.endLine,
      instruction,
    });
    if (panes.isCollapsed("sidebar")) panes.toggleCollapse("sidebar");
    setPendingRun((p) => ({ request, nonce: (p?.nonce ?? 0) + 1 }));
  };

  // -- Comments Phase A: create / open / reply / resolve / reopen / jump --------

  // L3 create: the "Comment" bubble was clicked over a live selection. Snapshot
  // the range (like `openReviseSelection`) and open the composer, anchored at the
  // selection's on-screen head. Gated on `canMutate` — a viewer can't author.
  const onComment = useCallback(
    (selection: CommentSelection) => {
      if (!canMutate) return;
      const view = editorViewRef.current;
      const coords = view?.coordsAtPos(selection.to);
      const anchor = coords
        ? new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
        : new DOMRect(window.innerWidth / 2 - 150, window.innerHeight / 3, 0, 0);
      // Opening a fresh thread closes any open card (one floating surface at a time).
      setActiveThread(null);
      setCommentDraft({ selection, anchor });
    },
    [canMutate],
  );

  // L3 submit: open the thread through `createThread` (an author-tagged CRDT
  // transaction) anchored to the snapshotted range in the active file's text.
  const onCommentSubmit = useCallback(
    (body: string) => {
      const draft = commentDraft;
      setCommentDraft(null);
      if (!draft || !canMutate) return;
      // Anchors were encoded at SELECTION time (carried on the draft), not now — so
      // a concurrent remote edit before the range during the compose window can't
      // mis-anchor the thread. `createThreadAnchored` stores those bytes verbatim.
      createThreadAnchored(
        project,
        {
          fileId: activeFileId ?? SINGLE_FILE_ID,
          anchorStart: draft.selection.anchorStart,
          anchorEnd: draft.selection.anchorEnd,
          anchorText: draft.selection.text,
          body,
        },
        session.author,
      );
      // Restore keyboard focus to the editor (the composer host unmounts on submit).
      editorViewRef.current?.focus();
    },
    [commentDraft, canMutate, activeFileId, project, session],
  );

  // L4 open: a gutter marker (or overview row) was clicked — open its card at the
  // clicked rect. Closes any in-flight create composer.
  const onOpenThread = useCallback((threadId: string, anchor: DOMRect) => {
    setCommentDraft(null);
    setActiveThread({ id: threadId, anchor });
  }, []);

  const onThreadReply = useCallback(
    (body: string) => {
      if (!activeThread || !canMutate) return;
      addMessage(project, activeThread.id, body, session.author);
    },
    [activeThread, canMutate, project, session],
  );

  const onThreadResolve = useCallback(() => {
    if (!activeThread || !canMutate) return;
    setThreadStatus(project, activeThread.id, "resolved", session.author);
  }, [activeThread, canMutate, project, session]);

  const onThreadReopen = useCallback(() => {
    if (!activeThread || !canMutate) return;
    setThreadStatus(project, activeThread.id, "open", session.author);
  }, [activeThread, canMutate, project, session]);

  // L5 focus-jump from the overview: switch to the thread's file if needed, jump
  // the cursor to its anchor, then open the card. Same-file jumps go straight
  // through; cross-file stashes the thread id for the post-remount effect (the
  // editor remounts on a file switch, so we can't jump/anchor synchronously).
  const onJumpToThread = useCallback(
    (threadId: string) => {
      const thread = getThread(project, threadId);
      if (!thread) return;
      const range = resolveThreadRange(project, thread);
      // An ORPHANED thread (range null) has nothing to scroll to — switching files
      // would land on a file with nothing to see. Open its card over the CURRENT
      // view at a centered rect instead (caretRectForThread falls back to that).
      const targetFileId = thread.fileId === SINGLE_FILE_ID ? activeFileId : thread.fileId;
      if (range && targetFileId && targetFileId !== activeFileId) {
        setPendingThreadOpen(threadId);
        setActiveFileId(targetFileId);
        return;
      }
      if (range) jumpToOffset(editorViewRef.current, range.from);
      setActiveThread({ id: threadId, anchor: caretRectForThread(editorViewRef.current, project, threadId) });
    },
    [project, activeFileId],
  );

  // The live view of the open thread (re-derived from `threads` so a remote reply
  // / status flip refreshes the card), and whether its anchor is orphaned.
  const activeThreadView = activeThread
    ? threads.find((t) => t.id === activeThread.id)
    : undefined;
  const activeThreadOrphaned =
    activeThreadView !== undefined && resolveThreadRange(project, activeThreadView) === null;

  // L5: project every thread into an overview row — file path + document-order key
  // (file index in the tree order, then resolved offset) + orphan flag.
  const overviewThreads = useMemo<OverviewThread[]>(() => {
    const fileIndex = new Map<string, number>();
    liveFiles.forEach((f, i) => fileIndex.set(f.fileId, i));
    return threads.map((t) => {
      const range = resolveThreadRange(project, t);
      const idx = fileIndex.get(t.fileId) ?? Number.MAX_SAFE_INTEGER;
      const path =
        liveFiles.find((f) => f.fileId === t.fileId)?.path ??
        (t.fileId === SINGLE_FILE_ID ? "source" : t.fileId);
      return {
        id: t.id,
        fileId: t.fileId,
        filePath: path,
        order: [idx, range ? range.from : Number.MAX_SAFE_INTEGER] as [number, number],
        anchorText: t.anchorText,
        status: t.status,
        messageCount: t.messages.length,
        orphaned: range === null,
      };
    });
  }, [threads, liveFiles, project]);

  // The whole-project compile input (or "" until the project is seeded/valid).
  // #7 7D: merge in the RESOLVED binary bytes so `image("/path")` renders. Built
  // synchronously from the resolved-bytes cache (`binaryTick` triggers a rebuild
  // as bytes land); unresolved pointers are simply omitted until their fetch
  // completes. Default-safe: a project with no resolved binaries adds NO
  // `binaryFiles` key, leaving a text-only compile input byte-for-byte unchanged.
  // M13: materializing every file's text (`toProjectInput`) ran on EVERY render —
  // including a plain cursor move, which changes no content. Memoize it on the
  // project's content `revision()` (the doc state vector — a superset of compile
  // inputs, so it advances on any real edit but NOT on cursor/awareness moves),
  // so a cursor move reuses the prior materialization instead of re-reading and
  // re-serializing the whole project. The revision read itself is O(collaborators).
  const projectRevision = project.revision();
  const baseProjectInput = useMemo(
    () => project.toProjectInput(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projectRevision is the content key for `project`
    [project, projectRevision],
  );
  // `binaryTick` participates so the build re-runs when new bytes resolve.
  void binaryTick;
  const resolvedBinaryFiles = baseProjectInput
    ? buildBinaryFilesInput(snapshot.binaryFiles, binaryCacheRef.current)
    : [];
  const projectInput =
    baseProjectInput && resolvedBinaryFiles.length > 0
      ? { ...baseProjectInput, binaryFiles: resolvedBinaryFiles }
      : baseProjectInput;
  const {
    ready,
    busy,
    svg,
    diagnostics,
    pageCount,
    sourceMap,
    exportPdf,
    exportPdfBytes,
    serverActive,
    fallbackActive,
    fallbackReason,
    serverUnavailable,
    serverUnavailableReason,
    packagesOnServer,
    packagesOnServerReason,
    packagesUnavailable,
    packagesUnavailableReason,
  } = useCompiler(projectInput ?? "", { mode: compileMode });

  /**
   * Export the rendered document as PNG(s) (#17.5 raster off-ramp). One page →
   * a single `document.png`; multi-page → a `document-pages.tar` of
   * `page-1.png …`. Rasterizes the SAME combined SVG the preview shows (the
   * compiler exposes no PNG target on this typst.ts version) via the browser
   * canvas seam; pure splitting/packing lives in export-raster.ts. Read-only —
   * nothing is written back to the document. No-op until a render exists.
   */
  const onExportPng = () => {
    if (!svg) return;
    void (async () => {
      try {
        const out = await buildRasterExport(svg, { rasterize: browserRasterize });
        downloadBytes(out.bytes, out.filename, out.type);
      } catch (err) {
        // H4: surface the failure (the C3 banner) in addition to the console.
        console.error("export png failed:", err);
        setNotice(errorNotice(exportFailureNotice("PNG")));
      }
    })();
  };

  /**
   * H4: the ONE entry point for "Export PDF" / "Back up a copy". `exportPdf` used
   * to be fired as `void exportPdf()`, so a rejection (or a no-PDF compile) failed
   * SILENTLY — worst at the at-risk "Back up a copy" moment. This wrapper gates on
   * `ready`, then surfaces any failure via the shell-root error banner (the raw
   * error stays in the console). A blocked-package export is NOT a failure here —
   * `exportPdf` returns after showing its own blocked-compile notice.
   */
  const runPdfExport = () => {
    if (!ready) return;
    void exportPdf().catch((err) => {
      console.error("export pdf failed:", err);
      setNotice(errorNotice(exportFailureNotice("PDF")));
    });
  };

  // A1 export channel: compile the current document + PUSH the PDF bytes over the
  // project blob channel under the kernel-MINTED `transferId`, resolving the
  // descriptor {hash,size} ONLY after the receiver's verified COMPLETE. Held in a
  // ref the stable open-handler effect reads at CALL time (this closure depends on
  // `exportPdfBytes` + the live `session.blobChannel`). The mount has already
  // consent-gated the request by projectId before this runs; here we additionally
  // FAIL CLOSED on every concrete prerequisite (compiler not ready, no blob
  // channel, blocked/empty export, oversize, push rejected) — never a partial or
  // forged success.
  exportCompiledRef.current = async (
    transferId: string,
    maxBytes: number,
  ): Promise<ExportedCompiled | OpenProjectRefusal> => {
    if (!ready) return { refused: "the document is not ready to export yet" };
    const channel = session.blobChannel;
    if (channel === undefined) {
      // The blob channel opens with the agent share upgrade; if it is absent the
      // project is not shared with the agent — nothing to push over.
      return { refused: "the project's byte channel is not connected" };
    }
    // A1 §1 FAIL CLOSED: never push an agent export over an ADVISORY (unauthenticated)
    // channel — the browser, the SENDER of the PDF, would then accept a forged
    // COMPLETE from a 3rd peer and believe a non-delivery succeeded. The share-connect
    // paths guarantee an authenticated channel for the agent scope; if for any reason
    // this one is not, refuse rather than push.
    if (!channel.authenticated) {
      return { refused: "the project's byte channel is not securely authenticated for the agent" };
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await exportPdfBytes();
    } catch {
      return { refused: "the document could not be compiled for export" };
    }
    if (bytes === null) {
      // null ⇒ not ready / blocked (packages with no trusted server). Honest refusal.
      return { refused: "no compiled PDF is available to export right now" };
    }
    if (bytes.length > maxBytes) {
      return {
        refused: `the compiled PDF is too large to export (${bytes.length} bytes; limit ${maxBytes})`,
      };
    }
    let hash: string;
    try {
      hash = await sha256Hex(bytes);
    } catch {
      return { refused: "the compiled PDF could not be hashed for export" };
    }
    // PUSH under the kernel-minted transferId. `done` resolves ONLY on the
    // receiver's verified COMPLETE — so a resolved push means the kernel genuinely
    // holds the verified bytes that match the descriptor we return.
    try {
      const handle = channel.send(bytes, hash, "application/pdf", { transferId });
      await handle.done;
    } catch {
      return { refused: "the compiled PDF could not be delivered to the agent" };
    }
    return { hash, size: bytes.length };
  };

  // Per-file diagnostics: those tagged with the active file's path, plus any
  // untagged (project-level) ones.
  const activeDiagnostics = useMemo(
    () => diagnostics.filter((d) => d.path === undefined || d.path === activeFile?.path),
    [diagnostics, activeFile?.path],
  );

  // Cross-file broken-ref lint (#13.3): resolve every `@ref` against the
  // project-wide `<label>` union + bibliography cite keys (path-qualified), so a
  // `@ref` to a label defined in a SIBLING file isn't falsely flagged. Additive
  // warnings, merged into the active file's diagnostics. Cheap over small projects.
  const projectFiles = liveFiles.map((f) => ({
    path: f.path,
    text: project.getFile(f.fileId)?.text ?? "",
  }));
  // Tier E #2: the {fileId, path, text} rows the in-doc search scans — the SAME
  // file-tree set (`liveFiles`, reserved `.galley/*` already excluded), so search
  // covers exactly the visible documents and never the hidden config files.
  const searchFiles = liveFiles.map((f) => ({
    fileId: f.fileId,
    path: f.path,
    text: project.getFile(f.fileId)?.text ?? "",
  }));
  const refLint = dropPackagePathRefs(
    activeFile?.text ?? "",
    crossFileRefDiagnostics(
      projectFiles,
      citeKeysFromBibliography(bibTextRef.current),
    ).filter((d) => d.path === activeFile?.path),
  );
  const shownDiagnostics = [...activeDiagnostics, ...refLint];

  // #13 follow-up: the project-wide `<label>` union driving the "Insert
  // reference…" picker, so the author can reference a label defined in ANY file
  // (not just the active doc). Sorted + de-duped; the same union the lint uses.
  const projectLabelNames = [...allProjectLabelNames(projectFiles)].sort();

  const errors = diagnostics.filter((d) => d.severity === "error");

  // F9/F5 compile channel: return the OPEN project's CURRENT preview diagnostics +
  // page count to a paired MCP agent (when its kernel has no loopback --compile-url).
  // The live preview already compiled them — this triggers NO fresh build (scope
  // tight). Held in a ref the stable compile handler reads at CALL time. The mount
  // has already consent-gated the request by projectId before this runs; here we
  // FAIL CLOSED on the prerequisites: a shared/joined session is VIEWING someone
  // else's project (it cannot offer it for compile), and an unready compiler has no
  // diagnostics yet.
  compileBrowserRef.current = async (): Promise<CompileDiagnostics | OpenProjectRefusal> => {
    if (config.syncUrl !== undefined) {
      return { refused: "this session is viewing a shared project — it cannot compile it for the agent" };
    }
    if (!ready) return { refused: "the document is not ready to compile yet" };
    return {
      ok: errors.length === 0,
      pageCount,
      diagnostics: diagnostics.map((d) => ({
        severity: d.severity,
        message: d.message,
        ...(d.path !== undefined ? { path: d.path } : {}),
      })),
    };
  };

  const status = !ready
    ? "Loading compiler…"
    : projectInput === null
      ? snapshot.duplicatePaths.length > 0
        ? `duplicate path: ${snapshot.duplicatePaths.join(", ")}`
        : "no main file"
      : errors.length > 0
        ? `${errors.length} error(s)`
        : pageCount != null
          ? `${pageCount} page(s)`
          : "ready";

  // Dark "press" mode (#11.6): resolve + apply the initial theme once on mount.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      /* storage unavailable */
    }
    const prefersDark =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    const initial = resolveInitialTheme({ stored, prefersDark });
    applyTheme(initial);
    setThemeMode(initial);
    let storedSkin: string | null = null;
    try { storedSkin = localStorage.getItem(SKIN_STORAGE_KEY); } catch { /* storage off */ }
    applySkin(resolveInitialSkin({ stored: storedSkin }));
  }, []);

  // Toggle the theme off the LIVE DOM (source of truth) so the side effect runs
  // once per invocation, never inside a setState updater. Stable for the keymap.
  const toggleThemeNow = useCallback(() => {
    const current: ThemeMode =
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    setThemeMode(toggleTheme(current));
  }, []);

  // Unified settings (#19.7): every preference lives on the /settings route.
  // When this shell was mounted BY the router (UnifiedRoot/JoinRoot pass
  // `onOpenLibrary`), `navigate()` swaps the route root in place; the legacy
  // `?project=1` hatch mounts ProjectApp directly with no route subscription,
  // so it takes a full navigation instead (the hatch is dev/e2e-only).
  const gotoSettings = useCallback(
    (section?: SettingsSectionId) => {
      // Thread the route we're leaving so the settings page's "Back" returns
      // here instead of always landing on home (#H6). A home origin is the
      // default, so don't bother carrying it.
      const origin = onOpenLibrary ? routeHref(currentRoute()) : undefined;
      const href = settingsHref(section, origin && origin !== "/" ? origin : undefined);
      if (onOpenLibrary) navigate(href);
      else window.location.assign(href);
    },
    [onOpenLibrary],
  );

  // Command surface (#11.7): Mod-chord bindings + the discoverable cheat-sheet.
  const shortcuts = useMemo<Shortcut[]>(
    () => [
      { id: "export", keys: "Mod-e", label: "Export PDF", group: "File", global: true, run: runPdfExport },
      { id: "theme", keys: "Mod-j", label: "Toggle dark mode", group: "View", global: true, run: toggleThemeNow },
      { id: "settings", keys: "Mod-,", label: "Open settings", group: "View", global: true, run: () => gotoSettings() },
      // Tier E #2 — find in files (project-wide). Mod-F is the editor's own
      // single-file find (searchKeymap); Mod-Shift-F is the across-files search,
      // the VS Code convention. `global` so it fires while typing in the editor.
      { id: "search-in-files", keys: "Mod-Shift-f", label: "Find in files", group: "View", global: true, run: openSearch },
      // 11.8b — revise the current selection via the agent. Mod-Shift-e is free
      // in this shell (used keys: Mod-e/j/,/Shift-f///k) AND unbound by
      // CodeMirror's basicSetup (defaultKeymap + searchKeymap); searchKeymap owns
      // Mod-f/Mod-Shift-f/Mod-g/Mod-d, not Mod-Shift-e. `global` so it fires
      // while typing in the editor (where the selection lives); a no-op when the
      // selection is empty so it never hijacks an empty-cursor keystroke.
      { id: "revise-selection", keys: "Mod-Shift-e", label: "Revise selection", group: "Edit", global: true, run: openReviseSelection },
      { id: "help", keys: "Mod-/", label: "Keyboard shortcuts", group: "Help", global: true, run: () => setShowShortcuts((s) => !s) },
    ],
    [ready, exportPdf, toggleThemeNow, gotoSettings, openSearch, openReviseSelection],
  );
  useShortcuts(shortcuts);

  // Command palette (#19.1, Rail & Islands stage 1) — a NEW, parallel surface
  // over the actions this shell already has at hand. ADDITIVE ONLY: the
  // existing `shortcuts` array (and thus the CommandSheet's rows) is untouched;
  // Mod-K gets its own binding via a second `useShortcuts` call. Closed →
  // renders nothing, so the shipped DOM is unchanged.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // One-time ⌘K nudge (#19.4, spec §6): a small pill near the actions cluster,
  // dismissed PERMANENTLY the first time the palette opens (any trigger).
  const [showNudge, setShowNudge] = useState<boolean>(() => shouldShowPaletteNudge());
  // H5: a one-time, NON-BLOCKING first-run chooser banner (mirrors the ⌘K nudge).
  // Only on a fresh LOCAL boot (not a joiner, not the explicit `?seed=einstein`
  // demo) so a novice landing on the near-blank starter sees the templates + the
  // 1905 demo instead of an empty page. Dismissed permanently on any action.
  const [showFirstRun, setShowFirstRun] = useState<boolean>(
    () =>
      config.syncUrl === undefined &&
      (typeof window === "undefined" ||
        new URLSearchParams(window.location.search).get("seed") !== "einstein") &&
      shouldShowFirstRunChooser(),
  );
  // 14-E: the signed-in user (published by the boot AuthGate before any shell
  // mounts; null in every auth-off run). Read once — stable for this mount.
  const [authUser] = useState(() => getActiveAuthUser());
  useEffect(() => {
    if (paletteOpen && showNudge) {
      dismissPaletteNudge();
      setShowNudge(false);
    }
  }, [paletteOpen, showNudge]);
  // H5: dismiss the first-run chooser permanently on any action (or the ✕).
  const dismissFirstRun = () => {
    dismissFirstRunChooser();
    setShowFirstRun(false);
  };
  // M3: a one-time, NON-BLOCKING coach overlay that names the three panes on a
  // genuinely fresh local boot. Gated on the SAME first-run signal as the H5
  // chooser (fresh LOCAL boot, not a joiner, not the `?seed=einstein` demo) with
  // its OWN localStorage key so it dismisses independently. Never on the narrow
  // morph (its layout has no three-pane split to orient). Pointer-through by
  // construction, so it can't intercept an edit and it never blocks a spec.
  const [showCoach, setShowCoach] = useState<boolean>(
    () =>
      config.syncUrl === undefined &&
      (typeof window === "undefined" ||
        new URLSearchParams(window.location.search).get("seed") !== "einstein") &&
      shouldShowCoachOverlay(),
  );
  const dismissCoach = () => {
    dismissCoachOverlay();
    setShowCoach(false);
  };
  // Open the 1905 demo as a NEW project (same path as the picker's Einstein entry).
  const onFirstRunDemo = () => {
    dismissFirstRun();
    void createProject(einsteinSeed());
  };
  const paletteShortcuts = useMemo<Shortcut[]>(
    () => [
      {
        id: "palette",
        keys: "Mod-k",
        label: "Command palette",
        group: "Help",
        global: true, // reachable while typing in the editor
        run: () => setPaletteOpen((o) => !o),
      },
    ],
    [],
  );
  useShortcuts(paletteShortcuts);

  // The registry entries reference EXISTING handlers/setters only (no new
  // behavior, no auto-apply — panels opened here still gate every change
  // through the same Accept flow). Rebuilt per render so the closures are
  // never stale; this is a tiny array, so no memo gymnastics.
  const paletteRegistry = createCommandRegistry([
    {
      id: "export-pdf",
      title: "Export PDF",
      keywords: ["pdf", "download", "save"],
      shortcut: "Mod-e",
      group: "File",
      available: () => ready,
      run: runPdfExport,
    },
    {
      id: "export-bundle",
      title: "Export source bundle (.tar)",
      keywords: ["tar", "archive", "download", "source"],
      group: "File",
      run: onExportBundle,
    },
    {
      id: "export-git-repo",
      title: "Export git repository (.git.tar)",
      keywords: ["git", "repo", "clone", "download"],
      group: "File",
      run: onExportGitRepo,
    },
    {
      id: "export-png",
      title: "Export PNG image",
      keywords: ["png", "image", "picture", "raster", "share", "screenshot"],
      group: "File",
      available: () => ready && svg !== null,
      run: onExportPng,
    },
    {
      id: "new-file",
      title: "New file…",
      keywords: ["create", "add", "file", "new", "page", "chapter"],
      group: "File",
      // B19-sharing-roles: a mutating action — hidden/un-runnable for a viewer.
      available: () => canMutate,
      // Reveal the Files pane and focus its new-file input — the create
      // affordance was previously reachable ONLY via that footer field (not the
      // palette). In the narrow morph the Files pane is a bottom TAB (not the
      // dock), so switch the tab there; otherwise open the dock.
      run: () => {
        if (narrow) setActiveTab("files");
        else openPanel("files");
        requestAnimationFrame(() =>
          (
            document.querySelector('[data-testid="new-file-path"]') as HTMLInputElement | null
          )?.focus(),
        );
      },
    },
    {
      id: "share",
      title: "Share for live collaboration",
      keywords: ["collaborate", "link", "room"],
      group: "Project",
      run: onShare,
    },
    {
      id: "open-library",
      title: "Open the project library",
      keywords: ["projects", "switch"],
      group: "Project",
      // Mirrors the topbar "Projects ▾" button's action exactly.
      run: () => (onOpenLibrary ? onOpenLibrary() : (navigate("/library"))),
    },
    {
      id: "rename-project",
      title: "Rename project…",
      keywords: ["rename", "title", "name", "project"],
      group: "Project",
      // The only other rename affordance is the (hover-title-only) header name
      // span; surface it in the palette too. Needs a rename callback + write access.
      available: () => canMutate && Boolean(onRenameProject),
      run: beginNameEdit,
    },
    {
      id: "project-instructions",
      title: "Project instructions…",
      keywords: ["agent", "steering", "constraints", "rules", "ai", "galley"],
      group: "Project",
      // B19-sharing-roles: editing instructions is a shared-doc write.
      available: () => canMutate,
      run: () => setInstructionsOpen(true),
    },
    {
      id: "change-style",
      title: "Change style…",
      keywords: ["style", "theme", "appearance", "look", "design", "format"],
      group: "Project",
      // Switching a style replaces /style.typ — a shared-doc write.
      available: () => canMutate,
      run: () => setStyleLibraryOpen(true),
    },
    {
      id: "find-in-files",
      title: "Find in files",
      keywords: ["search", "find", "grep", "text", "in-document"],
      shortcut: "Mod-Shift-f",
      group: "Project",
      run: openSearch,
    },
    {
      // C4 — the rail's Outline button has no palette twin, so below 820px (rail
      // hidden) Outline was reachable by NO route a touch user has. Mirrors the
      // rail's Search→Outline order; opens the outline dock (the narrow overlay).
      id: "outline",
      title: "Outline",
      keywords: ["outline", "headings", "sections", "navigate", "jump", "toc", "contents"],
      group: "View",
      run: () => openPanel("outline"),
    },
    {
      // #13 follow-up — an explicit cross-reference affordance beyond
      // `@`-completion: opens a picker of the project-wide `<label>` union and
      // inserts `@<label>` at the cursor (a direct edit, no Accept gate).
      id: "insert-reference",
      title: "Insert reference…",
      keywords: ["ref", "label", "cross-reference", "@", "link", "cite"],
      group: "Edit",
      // B19-sharing-roles: inserting `@label` writes the editor doc.
      available: () => canMutate,
      run: () => setInsertRefOpen(true),
    },
    {
      // #13 — draft a CRediT-style author-contribution statement from the
      // project's attributed history, surfaced for review before an Accept-gated
      // insert. Mutating (the insert lands a doc edit), so hidden for a viewer.
      id: "draft-contribution-statement",
      title: "Draft contribution statement",
      keywords: ["credit", "author", "contribution", "attribution", "roles", "statement"],
      group: "Edit",
      available: () => canMutate,
      run: openContributionStatement,
    },
    {
      // 11.8b — revise the selected region with the agent (Accept-gated diff).
      // Only listed/runnable when a non-empty selection exists.
      id: "revise-selection",
      title: "Revise selection…",
      keywords: ["edit", "rewrite", "revise", "shorten", "agent", "ai", "region"],
      shortcut: "Mod-Shift-e",
      group: "Edit",
      // B19-sharing-roles: a viewer can't Accept the resulting diff, so the
      // mutating affordance is hidden (it also needs a non-empty selection).
      available: () => canMutate && hasSelection(),
      run: openReviseSelection,
    },
    {
      id: "version-history",
      title: "Version history",
      keywords: ["versions", "snapshot", "restore", "compare"],
      group: "Project",
      run: () => openPanel("history"),
    },
    {
      id: "git-sync",
      title: "Git sync",
      keywords: ["push", "fetch", "remote", "github"],
      group: "Project",
      run: () => openPanel("git"),
    },
    {
      id: "import-document",
      title: "Import (Markdown / LaTeX → Typst)",
      keywords: ["markdown", "latex", "convert"],
      group: "Project",
      // B19-sharing-roles: import writes converted files into the shared doc.
      available: () => canMutate,
      run: () => openInsert("import"),
    },
    {
      id: "generate-figure",
      title: "Generate a figure",
      keywords: ["figure", "cetz", "diagram", "chart"],
      group: "Project",
      // B19-sharing-roles: inserting a figure is an Accept-gated doc write.
      available: () => canMutate,
      run: () => openInsert("figure"),
    },
    {
      id: "insert-image",
      title: "Insert image…",
      keywords: ["image", "figure", "picture", "photo", "upload", "png", "jpg"],
      group: "Project",
      // B19: an image insert is a direct doc write + a BlobStore put; needs both
      // an editor role and a BlobStore (absent in SSR/tests).
      available: () => canMutate && blobStore !== null,
      run: () => openUploadPicker("insert"),
    },
    {
      id: "add-citation",
      title: "Add a citation",
      keywords: ["cite", "doi", "bibtex", "bibliography"],
      group: "Project",
      // B19-sharing-roles: a citation writes the bibliography / editor doc.
      available: () => canMutate,
      run: () => openInsert("citation"),
    },
    {
      id: "toggle-theme",
      title: "Toggle dark mode",
      keywords: ["theme", "light", "appearance"],
      shortcut: "Mod-j",
      group: "View",
      run: toggleThemeNow,
    },
    {
      id: "focus-mode",
      title: "Toggle focus mode",
      keywords: ["zen", "distraction", "panes"],
      group: "View",
      run: toggleFocusMode,
    },
    {
      id: "agent-mode",
      title: "Toggle agent mode",
      keywords: ["agent", "preview"],
      group: "View",
      run: toggleAgentMode,
    },
    {
      id: "toggle-files",
      title: "Toggle the file list",
      keywords: ["files", "tree", "rail", "dock"],
      group: "View",
      run: () => onRailToggle("files"),
    },
    {
      id: "toggle-agent",
      title: "Toggle the agent panel",
      keywords: ["ai", "sidebar", "assistant"],
      group: "View",
      run: () => panes.toggleCollapse("sidebar"),
    },
    {
      id: "keyboard-shortcuts",
      title: "Keyboard shortcuts",
      keywords: ["help", "keys", "cheatsheet"],
      shortcut: "Mod-/",
      group: "Help",
      run: () => setShowShortcuts(true),
    },
    // Unified settings (#19.7, R8): "Open settings…" plus one deep link per
    // section, so every relocated preference stays ≤2 interactions away
    // (⌘K → entry). The section ids come from the shared settings-sections
    // model — the same contract the page renders.
    {
      id: "open-settings",
      title: "Open settings…",
      keywords: ["preferences", "options", "configure"],
      shortcut: "Mod-,",
      group: "Settings",
      run: () => gotoSettings(),
    },
    {
      id: "settings-appearance",
      title: "Appearance settings…",
      keywords: ["theme", "light", "dark", "appearance"],
      group: "Settings",
      run: () => gotoSettings("appearance"),
    },
    {
      id: "settings-editor",
      title: "Editor settings…",
      keywords: ["font", "size", "wrap", "preferences"],
      group: "Settings",
      run: () => gotoSettings("editor"),
    },
    {
      id: "settings-compile",
      title: "Compile settings…",
      keywords: ["compiler", "server", "local", "auto", "preview"],
      group: "Settings",
      run: () => gotoSettings("compile"),
    },
    {
      id: "settings-ai",
      title: "AI provider settings…",
      keywords: ["model", "api key", "agent", "provider", "ollama", "anthropic"],
      group: "Settings",
      run: () => gotoSettings("ai"),
    },
    {
      id: "settings-identity",
      title: "Display name settings…",
      keywords: ["identity", "name", "presence", "attribution"],
      group: "Settings",
      run: () => gotoSettings("identity"),
    },
    ...fileOpenCommands(liveFiles, setActiveFileId),
  ] satisfies Command[]);

  // The panes, hoisted so the wide SplitPanes grid, the rail dock and the
  // narrow tabbed stack all render the SAME nodes (#11.9 / #19.2). The file
  // list keeps its `.project-files-pane` markup in both homes (the Files dock
  // card and the narrow Files tab).
  // #12 folders: derive the nested folder/file tree from the live file PATHS.
  // A project with no folders (all root files) yields a flat one-level list —
  // byte-for-byte the old behavior. Reserved `.galley/*` is already filtered out
  // of `liveFiles`, so the tree never shows it.
  // #7 7D: binary files (image/PDF pointers) join the SAME tree as READ-ONLY
  // leaves tagged `kind:"binary"` (`renderFileRow` renders them distinctly and
  // never opens the editor). A project with no binaries adds nothing — the input
  // and resulting tree are byte-for-byte unchanged.
  const liveBinaryFiles = (snapshot.binaryFiles ?? []).filter((f) => !f.deleted);
  const fileTree = buildFileTree([
    ...liveFiles.map((f) => ({ fileId: f.fileId, path: f.path })),
    ...liveBinaryFiles.map((f) => ({ fileId: f.fileId, path: f.path, isBinary: true })),
  ]);

  // One file row — its testids, data-path, the ★ main marker, the inline rename
  // input and the set-main/rename/delete ops are PRESERVED byte-for-byte so the
  // existing selectors resolve at any nesting depth. `depth` only drives the CSS
  // indent (left padding), never the markup.
  // #7 7D: a binary file's pointer meta (size/mime), looked up for its read-only
  // row's hint. Empty for a text-only project.
  const binaryMetaByPath = new Map(liveBinaryFiles.map((f) => [f.path, f]));

  const renderFileRow = (node: Extract<TreeNode, { type: "file" }>, depth: number) => {
    // #7 7D: a binary asset row — an icon, the name, a size/mime hint. Its label
    // OPENS THE PREVIEW (never the editor: an image isn't editable text). It keeps
    // the distinct `project-binary-file` testid + className so it never collides
    // with the editable `project-file` selector, and mirrors the text row's
    // inline-rename input + hover ops + context menu — routed to the *Binary
    // handlers (a text rename/delete on a binary id throws).
    if (node.kind === "binary") {
      const meta = binaryMetaByPath.get(node.path);
      const menuTarget: TreeMenuTarget = { kind: "binary", fileId: node.fileId, path: node.path };
      return (
        <li
          key={node.fileId}
          className="project-file-row project-binary-row"
          style={{ "--tree-depth": depth } as CSSProperties}
          onContextMenu={(e) => openTreeMenu(e, menuTarget)}
          onKeyDown={(e) => treeMenuKeyDown(e, menuTarget)}
        >
          {renamingBinaryId === node.fileId ? (
            <input
              className="project-file-rename"
              data-testid="rename-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRenameBinary();
                if (e.key === "Escape") cancelRenameBinary();
              }}
              onBlur={commitRenameBinary}
            />
          ) : (
            <button
              type="button"
              className="project-file project-binary-file"
              data-testid="project-binary-file"
              data-path={node.path}
              title={`${node.path}${meta ? ` — ${formatBytes(meta.size)}` : ""} (preview)`}
              onClick={() => openBinaryPreview(node.fileId)}
            >
              <span className="project-binary-icon" aria-hidden="true">
                {"🖼 "}
              </span>
              {node.name}
              {meta && (
                <span className="project-binary-hint">
                  {` · ${formatBytes(meta.size)}${meta.mime ? ` · ${meta.mime}` : ""}`}
                </span>
              )}
            </button>
          )}
          {/* B19-sharing-roles: viewers get NO asset ops (handlers also fail closed). */}
          {!isViewer && (
            <span className="project-file-ops">
              <button
                type="button"
                title="rename asset"
                data-testid="rename-binary"
                data-path={node.path}
                onClick={() => beginRenameBinary(node.fileId, node.path)}
              >
                ✎
              </button>
              <button
                type="button"
                title="download asset"
                data-testid="download-binary"
                data-path={node.path}
                onClick={() => void downloadBinary(node.fileId)}
              >
                ⤓
              </button>
              <button
                type="button"
                title="delete asset"
                data-testid="delete-binary"
                data-path={node.path}
                onClick={() => deleteBinary(node.fileId)}
              >
                ✕
              </button>
            </span>
          )}
        </li>
      );
    }
    const menuTarget: TreeMenuTarget = {
      kind: "file",
      fileId: node.fileId,
      path: node.path,
      isMain: node.fileId === snapshot.mainFileId,
    };
    return (
    <li
      key={node.fileId}
      className="project-file-row"
      style={{ "--tree-depth": depth } as CSSProperties}
      onContextMenu={(e) => openTreeMenu(e, menuTarget)}
      onKeyDown={(e) => treeMenuKeyDown(e, menuTarget)}
    >
      {renamingId === node.fileId ? (
        <input
          className="project-file-rename"
          data-testid="rename-input"
          value={renameValue}
          autoFocus
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") cancelRename();
          }}
          onBlur={commitRename}
        />
      ) : (
        <button
          type="button"
          className={`project-file${node.fileId === activeFileId ? " is-active" : ""}`}
          data-testid="project-file"
          data-path={node.path}
          aria-current={node.fileId === activeFileId}
          onClick={() => setActiveFileId(node.fileId)}
          onDoubleClick={() => beginRename(node.fileId, node.path)}
        >
          {node.name}
          {node.fileId === snapshot.mainFileId && (
            <span className="project-file-main" title="main file">
              {" ★"}
            </span>
          )}
        </button>
      )}
      {/* B19-sharing-roles: viewers get NO file-ops (handlers also fail closed). */}
      {!isViewer && (
        <span className="project-file-ops">
          {node.fileId !== snapshot.mainFileId && (
            <button
              type="button"
              title="set as main file"
              data-testid="set-main"
              data-path={node.path}
              onClick={() => setMain(node.fileId)}
            >
              main
            </button>
          )}
          <button
            type="button"
            title="rename file"
            data-testid="rename-file"
            data-path={node.path}
            onClick={() => beginRename(node.fileId, node.path)}
          >
            ✎
          </button>
          <button
            type="button"
            title="delete file"
            data-testid="delete-file"
            data-path={node.path}
            onClick={() => deleteFile(node.fileId)}
          >
            ✕
          </button>
        </span>
      )}
    </li>
    );
  };

  // One folder row + (when expanded) its subtree. The folder is a derived prefix,
  // never a CRDT entity: the toggle is ephemeral view state, the inline rename
  // re-paths every file under the prefix, and "+" prefills a new file there.
  const renderFolderRow = (node: Extract<TreeNode, { type: "folder" }>, depth: number) => {
    const collapsed = collapsedFolders.has(node.path);
    const menuTarget: TreeMenuTarget = { kind: "folder", path: node.path };
    return (
      <li key={`folder:${node.path}`} className="project-tree-group">
        <div
          className={`project-file-row project-folder-row${
            dropFolder === node.path ? " is-drop-target" : ""
          }`}
          data-testid="project-folder"
          data-path={node.path}
          style={{ "--tree-depth": depth } as CSSProperties}
          onContextMenu={(e) => openTreeMenu(e, menuTarget)}
          onKeyDown={(e) => treeMenuKeyDown(e, menuTarget)}
          onDragOver={(e) => onFolderDragOver(e, node.path)}
          onDragLeave={(e) => onFolderDragLeave(e, node.path)}
          onDrop={(e) => onFolderDrop(e, node.path)}
        >
          {folderRenaming === node.path ? (
            <input
              className="project-file-rename"
              data-testid="rename-folder-input"
              value={folderRenameValue}
              autoFocus
              onChange={(e) => setFolderRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFolderRename();
                if (e.key === "Escape") cancelFolderRename();
              }}
              onBlur={commitFolderRename}
            />
          ) : (
            <button
              type="button"
              className="project-file project-folder"
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? "Expand" : "Collapse"} folder ${node.name}`}
              onClick={() => toggleFolder(node.path)}
              onDoubleClick={() => beginFolderRename(node.path)}
            >
              <span className="project-folder-caret" aria-hidden="true">
                {collapsed ? "▸" : "▾"}
              </span>
              {node.name}
            </button>
          )}
          {/* B19-sharing-roles: viewers get NO folder-ops either. */}
          {!isViewer && (
            <span className="project-file-ops">
              <button
                type="button"
                title="new file in this folder"
                data-testid="new-file-in-folder"
                data-path={node.path}
                onClick={() => newFileInFolder(node.path)}
              >
                +
              </button>
              <button
                type="button"
                title="new subfolder"
                data-testid="new-subfolder"
                data-path={node.path}
                onClick={() => newSubfolder(node.path)}
              >
                +/
              </button>
              <button
                type="button"
                title="rename folder"
                data-testid="rename-folder"
                data-path={node.path}
                onClick={() => beginFolderRename(node.path)}
              >
                ✎
              </button>
            </span>
          )}
        </div>
        {/* Inline "New subfolder…" input — mirrors the folder-rename input,
            indented one level deeper so it reads as living inside this folder.
            Viewer-gated like the affordance that opens it. */}
        {!isViewer && subfolderParent === node.path && (
          <div
            className="project-file-row project-subfolder-input-row"
            style={{ "--tree-depth": depth + 1 } as CSSProperties}
          >
            <input
              className="project-file-rename"
              data-testid="new-subfolder-input"
              placeholder="subfolder name"
              value={subfolderValue}
              autoFocus
              onChange={(e) => setSubfolderValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitSubfolder();
                if (e.key === "Escape") cancelSubfolder();
              }}
              onBlur={commitSubfolder}
            />
          </div>
        )}
        {!collapsed && (
          <ul className="project-tree-children">{renderTreeNodes(node.children, depth + 1)}</ul>
        )}
      </li>
    );
  };

  const renderTreeNodes = (nodes: TreeNode[], depth: number): ReactNode =>
    nodes.map((node) =>
      node.type === "folder" ? renderFolderRow(node, depth) : renderFileRow(node, depth),
    );

  const filesNode = (
    <div
      className={`project-files-pane${dropActive ? " is-drop-target" : ""}`}
      key="files"
      onDragOver={onFilesDragOver}
      onDragLeave={onFilesDragLeave}
      onDrop={onFilesDrop}
    >
      {mainDeleted && (
        <Notice
          severity="warning"
          testId="main-deleted-notice"
          message="The main file was deleted, so the preview stopped."
          action={{
            label: "Pick new main",
            onClick: pickNewMain,
            testId: "pick-new-main",
            title: "Make the file you're editing the main file",
          }}
        />
      )}
      <ul className="project-files" data-testid="project-files" aria-label="Project files">
        {renderTreeNodes(fileTree, 0)}
      </ul>
      {/* B19-sharing-roles: a VIEWER sees the project structure but cannot create
          files — hide the new-file form (the handlers also fail closed). */}
      {!isViewer && (
        <form
          className="project-new-file"
          onSubmit={(e) => {
            e.preventDefault();
            addFile();
          }}
        >
          <input
            type="text"
            placeholder="/new-file.typ"
            data-testid="new-file-path"
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
          />
          <button type="submit" data-testid="add-file">
            Add
          </button>
        </form>
      )}
      {/* New folder: folders are derived from paths (ADR-0013), so an empty folder
          can't exist — creating one materializes a starter file under the new
          prefix (then drops it into rename mode). Viewer-gated like the file form. */}
      {!isViewer && (
        <form
          className="project-new-folder"
          onSubmit={(e) => {
            e.preventDefault();
            addFolder();
          }}
        >
          <input
            type="text"
            placeholder="New folder name"
            data-testid="new-folder-path"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
          />
          <button type="submit" data-testid="add-folder">
            New folder
          </button>
        </form>
      )}
      {/* #7 7D: upload binary assets (images, PDFs). Drag onto the pane / a folder
          row, or use this button. The hidden <input> it drives is mounted at the
          app root (not here) so the ⌘K "Insert image…" command still works when
          the Files dock is closed. Viewer-gated + hidden when no BlobStore. */}
      {!isViewer && blobStore && (
        <div className="project-upload">
          <button
            type="button"
            className="project-upload-button"
            data-testid="upload-binary"
            title="Upload images or other assets (or drag them onto the file list)"
            onClick={() => openUploadPicker("files")}
          >
            Upload asset…
          </button>
        </div>
      )}
    </div>
  );
  const editorNode = activeText ? (
    <ProjectEditor
      key={activeFileId}
      ytext={activeText}
      {...(activeFileId ? { fileId: activeFileId } : {})}
      awareness={activeAwareness}
      project={project}
      diagnostics={shownDiagnostics}
      onView={(v) => (editorViewRef.current = v)}
      onOpenThread={onOpenThread}
      onComment={onComment}
      onCursorChange={setCursorPos}
      onPasteImage={onPasteImage}
      onDropImage={onDropImage}
      onDropNonImage={onDropNonImage}
      completionSources={completionSources}
      placeholder={`Blank page. Try "= A heading", plain text, or $x^2$ math — the preview typesets as you type.`}
      readOnly={isViewer}
    />
  ) : (
    <div className="editor" data-testid="editor" key="editor" />
  );
  const centerNode = (
    <div className="center" key="center" role="region" aria-label="Preview">
      <Preview
        svg={svg}
        placeholder={previewPlaceholder({ ready, errorCount: errors.length, busy, pageCount })}
        staleNotice={staleRenderNotice({ hasRender: svg !== null, errorCount: errors.length })}
        {...(sourceMap ? { sourceMap } : {})}
        {...(cursorPos ? { activeSourcePos: cursorPos } : {})}
        {...(activeFile ? { activeFilePath: activeFile.path } : {})}
        {...(sourceMap
          ? {
              // #11.3 inverse sync: click the preview → move the editor cursor.
              // Gated on `sourceMap` so it only activates when the forward index exists.
              //
              // B14: the clicked source position may carry a `filePath` (multi-file
              // source map) pointing at an `#import`ed file that ISN'T the active
              // one. When it does and differs from the active file, switch to that
              // file first and STASH the target offset — the editor remounts on a
              // file switch (it is keyed on `activeFileId`), so the pending-jump
              // effect flushes `jumpToOffset` once the new view is live (the SAME
              // mechanism the cross-file search jump uses). Same-file clicks (or a
              // map without `filePath`) jump straight through, byte-for-byte as
              // before.
              onSourceClick: (pos) => {
                const target =
                  pos.filePath != null
                    ? liveFiles.find((f) => f.path === pos.filePath)
                    : undefined;
                if (target && target.fileId !== activeFileId) {
                  // Cross-file: compute the offset against the TARGET file's text
                  // (the active editor's doc is the wrong file) and switch + stash.
                  const targetText = project.getFile(target.fileId)?.text ?? "";
                  setPendingJumpOffset(lineColToOffset(targetText, pos.line, pos.column));
                  setActiveFileId(target.fileId);
                  return;
                }
                // Same file (or no file context): jump within the active editor.
                const v = editorViewRef.current;
                if (!v) return;
                const lineNo = Math.min(Math.max(pos.line, 1), v.state.doc.lines);
                const lineInfo = v.state.doc.line(lineNo);
                jumpToOffset(v, lineInfo.from + Math.max(0, pos.column));
              },
            }
          : {})}
      />
      <DiagnosticsList
        diagnostics={shownDiagnostics}
        onJump={(d) => jumpToDiagnostic(editorViewRef.current, d)}
        onQuickFix={onQuickFix}
        onExplain={onExplain}
      />
      {/* B15 — the outline is opened from the IconRail (testId="rail-outline") in
          this multi-file shell. Omit onShowOutline/outlineOpen so DocStatusBar
          hides its redundant outline toggle (the props are optional; absent →
          no button). App.tsx (the single-file shell, no rail) still passes them,
          keeping its one outline control. */}
      <DocStatusBar
        source={activeFile?.text ?? ""}
        {...(pageCount != null ? { pageCount } : {})}
      />
    </div>
  );
  // M16: when the agent sidebar is collapsed to `0fr` on a WIDE layout it stays
  // in the DOM holding focusable controls — `aria-hidden` hides it from AT but
  // does NOT block focus, so a keyboard user could Tab into the invisible pane.
  // `inert` removes it from the a11y tree AND blocks focus/pointer. Toggled via a
  // ref+effect because React 18 doesn't pass the `inert` JSX prop through reliably.
  const sidebarCollapsed = !narrow && panes.isCollapsed("sidebar");
  const sidebarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;
    if (sidebarCollapsed) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [sidebarCollapsed]);
  const sidebarNode = (
    <aside
      ref={sidebarRef}
      className="sidebar"
      key="sidebar"
      aria-label="AI agent"
      aria-hidden={sidebarCollapsed}
    >
      <div className="model-bar">
        <span data-testid="model-indicator">
          Model: <strong>{provider ? provider.label : "Demo (offline)"}</strong>
        </span>
        <button
          className="pane-collapse"
          title="Collapse the agent panel"
          aria-label="Collapse the agent panel"
          data-testid="collapse-sidebar"
          onClick={() => panes.toggleCollapse("sidebar")}
        >
          ⇥
        </button>
      </div>
      {!provider && (
        <p className="agent-provider-hint" data-testid="agent-provider-hint">
          The agent drafts sections, edits the current file, and explains compile
          errors — right here in your document. It’s currently answering from a
          canned offline demo;{" "}
          <button
            type="button"
            className="agent-provider-hint-link"
            data-testid="agent-provider-hint-link"
            onClick={() => gotoSettings("ai")}
          >
            connect a model
          </button>{" "}
          to put a real one in the loop.
        </p>
      )}
      {/* C3: `notice` no longer renders here — it is promoted to a shell-root
          banner near the durability bar, so a failure (export/version/apply)
          stays visible even when this sidebar is collapsed (`0fr`) or unmounted
          on a narrow viewport. */}
      {/* B19-sharing-roles: the agent-acceptance control is a shared write, so a
          VIEWER never sees it (the handlers also fail closed). The proposal
          REVIEW cards moved OUT of this collapsible/`inert` sidebar to the
          shell-root pending-review surface (ADR-0024 §4) so they stay reachable
          regardless of panel state.

          ADR-0025 §1 (Task 8): the unified Agent access panel governs the ONE
          per-project Ask/Auto choice for BOTH surfaces (the in-app agent + a
          paired MCP agent) and folds in the kill-switch + merged audit. It is
          gated on `canMutate` ALONE (not on a grant) so the in-app Auto control
          is reachable even with no MCP pairing — discoverable right above the
          in-app AgentPanel below. `grantActive` only adjusts the copy and which
          stores `onSelectMode` writes (the MCP grant store needs a live grant). */}
      {canMutate && (
        <AgentAccessPanel
          mode={effectiveMode}
          canMutate={canMutate}
          grantActive={agentGrantActive}
          grantAuto={autoAccept}
          onSelectMode={onSelectAgentMode}
          audit={autoAcceptAudit}
        />
      )}
      {activeFile && (
        <p className="agent-target" data-testid="agent-target">
          {canMutate ? (
            <>
              Editing <strong>{activeFile.path}</strong>
            </>
          ) : (
            <>
              Viewing <strong>{activeFile.path}</strong>
            </>
          )}
        </p>
      )}
      {agentInstructions?.constraints && (
        <WritingGoals constraints={agentInstructions.constraints} source={goalsText} />
      )}
      {/* B19-sharing-roles: the agent panel runs edits the viewer can't Accept
          (the write is gated), so a VIEWER sees a read-only note instead of the
          agent — mirroring how the file-ops affordances are hidden. */}
      {canMutate ? (
        <AgentPanel
          key={activeFileId}
          model={model}
          source={activeFile?.text ?? ""}
          buildCheckInput={buildCheckInput}
          onAccept={onAcceptActive}
          showCostMeter
          // #15: isolate the agent run-history per project (was a single shared
          // "default" thread). `projectId` (= the room id) keys each project's —
          // and each shared room's — history separately; the single-file App shell
          // passes no threadId and keeps the default key.
          threadId={projectId}
          projectTools={projectTools}
          mentionFiles={mentionFiles}
          {...(modelPicker ? { modelPicker } : {})}
          context={{ mode: "retrieval" }}
          onEditInstructions={() => setInstructionsOpen(true)}
          instructionsActive={agentInstructions !== undefined}
          {...(pendingRun ? { pendingRun } : {})}
          {...(agentInstructions ? { instructions: agentInstructions } : {})}
          // ADR-0025 §4 — in-app Auto seam: when this project's in-app acceptance
          // mode is Auto and the role can mutate, a finished run auto-applies via
          // the manual-Accept-equivalent path (checkpoint → conflict re-check
          // through onAccept → local audit → applied summary + Undo). The mode is
          // read FRESH at run-finish so a flip to Ask takes effect immediately.
          autoAccept={{
            projectId,
            mode: () => getProjectAcceptanceMode(projectId),
            canMutate,
            checkpoint: checkpointBeforeInAppApply,
            // H2: the hardened final apply re-reads mode / canMutate / live file
            // text AFTER the checkpoint, then applies behind passesInAppFinalGate.
            commit: commitInAppAuto,
            restore: onRestoreVersion,
            // Refresh the unified Agent access panel's merged audit when an in-app
            // run auto-applies/fails (ADR-0025 §5).
            onAudited: refreshAutoAcceptAudit,
          }}
        />
      ) : (
        <p className="agent-provider-hint" data-testid="agent-readonly-hint">
          You joined this project as a viewer, so it&rsquo;s read-only — the AI
          agent and editing tools are disabled. Ask the owner for an edit link to
          make changes.
        </p>
      )}
    </aside>
  );
  const tabs: { id: PaneTab; label: string }[] = [
    { id: "files", label: "Files" },
    { id: "editor", label: "Editor" },
    { id: "preview", label: "Preview" },
    { id: "agent", label: "Agent" },
  ];

  // The rail dock (#19.2): ONE floating card beside the rail hosts the active
  // panel. The tool panels render with their additive `docked` variant (their
  // modal presentation elsewhere is untouched); they stay mounted with
  // `open=false` so in-progress drafts survive a dock switch, exactly as the
  // modal era kept them mounted behind a closed backdrop.
  const onInsertTabKey = (
    e: ReactKeyboardEvent<HTMLButtonElement>,
    focused: InsertTab,
  ) => {
    // `focused` is the tab receiving the keydown — move focus relative to IT,
    // not the selected tab, so manual activation (focus ≠ selection) is correct.
    const target = tablistKeyTarget(e.key, INSERT_TABS.indexOf(focused), INSERT_TABS.length);
    if (target === null) return;
    e.preventDefault();
    insertTabRefs.current[INSERT_TABS[target]!]?.focus();
  };
  const insertTabButton = (
    tab: InsertTab,
    glyph: string,
    text: string,
    label: string,
    title: string,
    testId: string,
  ) => (
    <button
      ref={(el) => {
        insertTabRefs.current[tab] = el;
      }}
      type="button"
      id={`insert-tab-${tab}`}
      role="tab"
      className="insert-tab"
      data-testid={testId}
      aria-selected={insertTab === tab}
      aria-controls={INSERT_PANEL_ID}
      // Roving tabIndex + arrow-key focus movement (#H7, WAI-ARIA tablist):
      // only the active tab is in the tab order; Left/Right/Home/End walk the
      // rest (manual activation — Enter/Space still open via onClick).
      tabIndex={insertTab === tab ? 0 : -1}
      aria-label={label}
      title={title}
      onClick={() => openInsert(tab)}
      onKeyDown={(e) => onInsertTabKey(e, tab)}
    >
      <span className="insert-tab-glyph" aria-hidden="true">
        {glyph}
      </span>
      {text}
    </button>
  );
  const dockNode = (
    <aside
      className="shell-dock"
      {...(dock ? { "data-dock": dock, "aria-label": DOCK_TITLES[dock] } : { hidden: true })}
    >
      {dock === "files" && (
        <DockedPanel title="Files" onClose={() => onRailToggle("files")}>
          {filesNode}
        </DockedPanel>
      )}
      {dock === "search" && (
        <DockedPanel title="Search" testId="search-overlay" onClose={() => closePanel("search")}>
          <SearchPanel
            ref={searchPanelRef}
            files={searchFiles}
            onJump={onSearchJump}
            canMutate={canMutate}
            onReplace={onSearchReplace}
          />
        </DockedPanel>
      )}
      {dock === "history" && (
        <DockedPanel
          title="Version history"
          testId="history-overlay"
          onClose={() => closePanel("history")}
        >
          <HistoryPanel
            key={historyEpoch}
            store={versionStore}
            projectId={projectId}
            onRestore={onRestoreVersion}
            onCompare={onCompareVersions}
            onSaveVersion={onSaveVersion}
            autoSnapshotEnabled={autoSnapshotPolicy.enabled}
            {...(canMutate ? { onToggleAutoSnapshot } : {})}
          />
        </DockedPanel>
      )}
      {dock === "outline" && (
        <DockedPanel title="Outline" onClose={() => closePanel("outline")}>
          <DocOutline
            source={activeFile?.text ?? ""}
            onJump={(offset) => jumpToOffset(editorViewRef.current, offset)}
          />
        </DockedPanel>
      )}
      <GitSyncPanel
        docked
        open={dock === "git"}
        onClose={() => closePanel("git")}
        projectId={projectId}
        onPush={onGitPush}
        onFetch={onGitFetch}
      />
      {/* B19-sharing-roles: every Insert tool (figure / citation / import) writes
          the shared doc, so a VIEWER gets a read-only note instead of the tools.
          (The rail's insert icon lives outside this file, so it can still open
          the dock — but the panels + their handlers are gated.) */}
      <div className="insert-dock" data-testid="insert-dock" hidden={dock !== "insert"}>
        {canMutate ? (
          <>
            <div className="insert-tabs" role="tablist" aria-label="Insert">
              {insertTabButton(
                "figure",
                "◇",
                "Figure",
                "Generate a figure",
                "Figure → Typst (CeTZ)",
                "figure-button",
              )}
              {insertTabButton(
                "citation",
                "❝",
                "Citation",
                "Add a citation",
                "Add citation (DOI / BibTeX → @cite)",
                "add-citation",
              )}
              {insertTabButton(
                "import",
                "⤓",
                "Import",
                "Import a Markdown or LaTeX document",
                "Import (Markdown / LaTeX → Typst)",
                "import-button",
              )}
            </div>
            {/* #H7: the three tabs share one tabpanel host — only the open
                panel renders content, so the label tracks the active tab. */}
            <div
              className="insert-panel-host"
              id={INSERT_PANEL_ID}
              role="tabpanel"
              aria-labelledby={`insert-tab-${insertTab}`}
            >
            <FigurePanel
              docked
              open={dock === "insert" && insertTab === "figure"}
              onClose={() => closePanel("insert")}
              model={model}
              currentSource={activeFile?.text ?? ""}
              onInsert={onInsertSnippet}
              {...(svg !== null ? { previewSvg: svg } : {})}
              {...(capabilities !== undefined ? { capabilities } : {})}
              {...verifyCompilerFactoryProp}
            />
            <CitationPanel
              docked
              open={dock === "insert" && insertTab === "citation"}
              onClose={() => closePanel("insert")}
              currentSource={activeFile?.text ?? ""}
              onInsert={onInsertSnippet}
              onAddToBibliography={onAddToBibliography}
              bibliographySource={bibTextRef.current}
              onRewriteBibliography={onRewriteBibliography}
              existingKeys={citeKeysFromBibliography(bibTextRef.current)}
            />
            {/* Paste-text → Typst stays here (document-scoped); the zip/project
                import moved to the Projects page (a zip is usually a project). */}
            <ImportPanel
              docked
              open={dock === "insert" && insertTab === "import"}
              onClose={() => closePanel("insert")}
              currentSource={activeFile?.text ?? ""}
              onInsert={onInsertSnippet}
              repair={{ model, compilerFactory: () => initCompiler() }}
            />
            </div>
          </>
        ) : (
          <p className="agent-provider-hint" data-testid="insert-readonly-hint">
            You joined as a viewer, so inserting figures, citations, or imported
            documents is disabled. Ask the owner for an edit link.
          </p>
        )}
      </div>
    </aside>
  );

  return (
    <div
      className="app shell-rail"
      {...(focusMode ? { "data-focus": "true" } : {})}
      {...(agentMode ? { "data-agent": "true" } : {})}
    >
      {/* #16.3: the blocking agent open-project consent modal. Renders absent
          until a paired agent asks (and Agent Access is on) — shipped path
          unchanged. */}
      <AgentOpenConsent pending={agentConsent} />
      <InstructionsPanel
        open={instructionsOpen}
        {...(instructionsText !== undefined ? { initialText: instructionsText } : {})}
        hasExisting={hasInstructions}
        onSave={onSaveInstructions}
        onRemove={onRemoveInstructions}
        onClose={() => setInstructionsOpen(false)}
      />
      {/* Styles (Phase 1): the style-switcher overlay + its trial-compile
          confirmation. Both render absent until opened — shipped path unchanged. */}
      <StyleLibrary
        open={styleLibraryOpen}
        onClose={() => setStyleLibraryOpen(false)}
        styles={styleCatalog}
        listing={{ loading: styleSourcesLoading, errors: styleSourceErrors }}
        styleability={styleability}
        busy={styleBusy}
        onApply={onStyleApply}
        {...(canMutate ? { onSaveCurrent: onSaveCurrentStyle, onDeleteStyle } : {})}
      />
      {styleTrial !== null && (
        <div
          className="style-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Style compile warning"
          onClick={() => setStyleTrial(null)}
        >
          <div className="style-panel" onClick={(e) => e.stopPropagation()}>
            <header className="style-header">
              <h2 className="style-title">This style didn’t compile cleanly</h2>
            </header>
            <p className="style-intro">
              Applying “{styleTrial.style.manifest.name}” produced {styleTrial.errors.length}{" "}
              compile {styleTrial.errors.length === 1 ? "error" : "errors"}. You can apply it
              anyway and fix the document, or cancel and keep the current style.
            </p>
            <div className="style-notice" role="alert">
              {styleTrial.errors
                .slice(0, 3)
                .map((d) => d.message)
                .join(" • ")}
            </div>
            <footer className="style-footer">
              <button
                type="button"
                className="style-secondary"
                onClick={() => setStyleTrial(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="style-primary"
                onClick={() => doApplyStyle(styleTrial.style)}
              >
                Apply anyway
              </button>
            </footer>
          </div>
        </div>
      )}
      {/* #13 follow-up — the "Insert reference…" label picker. Renders absent
          until opened via ⌘K — shipped path unchanged. */}
      <InsertReferencePicker
        open={insertRefOpen}
        labels={projectLabelNames}
        onPick={onInsertReference}
        onClose={() => setInsertRefOpen(false)}
      />
      {/* #13 — the drafted contribution statement under review. Renders absent
          until "Draft contribution statement" opens it; Insert routes through the
          Accept gate, Cancel/Escape close without mutating. */}
      <ContributionStatementModal
        open={contributionDraft !== null}
        statement={contributionDraft ?? ""}
        onInsert={onInsertContribution}
        onClose={() => setContributionDraft(null)}
      />
      {/* 11.8b — the selection-scoped revise prompt. Renders absent until
          "Revise selection…" snapshots a region — shipped path unchanged. */}
      <ReviseSelectionPrompt
        open={revisePrompt !== null}
        summary={revisePrompt ? reviseSummary(revisePrompt) : ""}
        onSubmit={onReviseSelectionSubmit}
        onCancel={() => setRevisePrompt(null)}
      />
      {/* #7 7D — the hidden binary-upload picker. Mounted at the app root (NOT in
          the Files pane) so the ⌘K "Insert image…" command works even when the
          Files dock is closed. Viewer-gated + absent without a BlobStore. */}
      {!isViewer && blobStore && (
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          accept="image/*,.pdf"
          data-testid="upload-binary-input"
          style={{ display: "none" }}
          onChange={onUploadInputChange}
        />
      )}
      {/* #7 7D — the binary-asset preview modal. Renders absent until a row/menu
          opens it; re-sniffs the bytes' mime (never trusts the peer-writable
          pointer mime) and renders only an allowlisted raster / SVG via <img>.
          Keyed by fileId so each open is a fresh instance (no stale/revoked-URL
          flash on reopen). */}
      <BinaryPreview
        key={binaryPreviewId ?? "closed"}
        open={binaryPreviewMeta !== null}
        meta={binaryPreviewMeta}
        loadBytes={loadBinaryBytes}
        onClose={() => setBinaryPreviewId(null)}
        onDownload={() => {
          if (binaryPreviewMeta) void downloadBinary(binaryPreviewMeta.fileId);
        }}
      />
      <button
        type="button"
        className="skip-link"
        data-testid="skip-link"
        onClick={() => editorViewRef.current?.focus()}
      >
        Skip to editor
      </button>
      <header className="shell-top">
        <div className="pill brand-pill">
          <button
            type="button"
            className="brand"
            data-testid="open-library"
            title="Your projects, templates & demos"
            aria-label="Your projects, templates and demos"
            onClick={() =>
              onOpenLibrary ? onOpenLibrary() : (navigate("/library"))
            }
          >
            <span className="brand-word">Galley</span>
            <span className="brand-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          {projectName &&
            (nameEditing ? (
              <input
                className="pill-project-name pill-project-name--edit"
                data-testid="project-name-input"
                aria-label="Project name"
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitNameEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitNameEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNameEdit();
                  }
                }}
              />
            ) : onRenameProject ? (
              // R8 budget: NOT a <button> element (the top-bar budget counts
              // buttons) — a role="button" span, mirroring the library card's
              // click-to-rename, so the always-visible chrome stays at budget.
              <span
                className="pill-project-name pill-project-name--btn"
                data-testid="project-name"
                role="button"
                tabIndex={0}
                title={`${projectName} — click to rename`}
                onClick={beginNameEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    beginNameEdit();
                  }
                }}
              >
                {projectName}
              </span>
            ) : (
              <span className="pill-project-name" data-testid="project-name" title={projectName}>
                {projectName}
              </span>
            ))}
          <span className="pill-sep" aria-hidden="true" />
          <StatusChip
            status={status}
            saveState={saveState}
            onBackup={onExportBundle}
            transient={persistState === "transient"}
            glyphInputs={{
              ready,
              busy,
              hasInput: projectInput !== null,
              errorCount: errors.length,
              packagesUnavailable,
              packagesOnServer,
              serverActive,
            }}
          >
            {packagesUnavailable && (
              <span
                className="compile-notice compile-notice--blocked"
                data-testid="packages-unavailable"
                role="status"
                title={packagesUnavailableReason ?? undefined}
              >
                ⚠ {packagesUnavailableReason ?? "This document imports @preview packages, which can't be compiled here."}
              </span>
            )}
            {packagesOnServer && (
              <span
                className="compile-notice compile-notice--egress"
                data-testid="packages-on-server"
                role="status"
                title={`${packagesOnServerReason ?? "Uses @preview packages — compiling on the server."} The document is sent to the configured compile service.`}
              >
                ↗ Compiled on the server — this document is sent to the configured compile service.
              </span>
            )}
            <div className="status-popover-compiler">
              <span className="status-popover-compiler-label" id="preview-compiler-label">
                Preview compiler
              </span>
              <CompilerModeToggle
                onModeChange={setCompileMode}
                serverActive={serverActive}
                fallbackActive={fallbackActive}
                fallbackReason={fallbackReason}
                serverUnavailable={serverUnavailable}
                serverUnavailableReason={serverUnavailableReason}
              />
              <button
                type="button"
                className="status-popover-link"
                data-testid="settings-compile-link"
                onClick={() => gotoSettings("compile")}
              >
                All compile settings…
              </button>
            </div>
          </StatusChip>
          {connection && (
            <span className="collab-chip" data-testid="collab-indicator">
              Collaborative
            </span>
          )}
        </div>
        <div className="actions-cluster">
          <div className="pill actions-pill">
            <SharePopover
              connected={connection !== undefined}
              shareLink={shareLink}
              error={shareError}
              peers={peers}
              stalePresence={linkStatus === "reconnecting"}
              copied={shareCopied}
              onCopy={copyShareLink}
              onShare={onShare}
              // B18: only the OWNING host can stop sharing — a joiner that booted
              // CONNECTED (config.syncUrl set) is visiting someone else's room, so
              // it never gets the Unshare affordance. B19: likewise the role
              // chooser is the host's link-minting control (joiners don't mint).
              {...(config.syncUrl === undefined
                ? {
                    // H8: gate the copyable link on the first "connected" status
                    // — host-only (a joiner boots into an already-served room).
                    connecting: isShareConnecting(connection !== undefined, linkStatus),
                    onUnshare,
                    role: shareRole,
                    onRoleChange: onShareRoleChange,
                    displayName,
                    onSetDisplayName,
                  }
                : {})}
            />
            <span className="pill-sep" aria-hidden="true" />
            <ExportMenu
              items={
                [
                  {
                    testId: "export-pdf",
                    label: "Export PDF",
                    hint: "Typeset document",
                    shortcut: "⌘E",
                    disabled: !ready,
                    run: runPdfExport,
                  },
                  {
                    testId: "export-bundle",
                    label: "Source bundle",
                    hint: ".typ project tar",
                    run: onExportBundle,
                  },
                  {
                    testId: "export-git-repo",
                    label: "Git repository",
                    hint: "Clone-ready bare repo tar",
                    run: onExportGitRepo,
                  },
                  {
                    testId: "export-png",
                    label: "PNG image",
                    hint: "Page image (.png / .tar)",
                    disabled: !ready || svg === null,
                    run: onExportPng,
                  },
                ] satisfies ExportMenuItem[]
              }
            />
            <span className="pill-sep" aria-hidden="true" />
            {/* CX-1: on narrow (touch) the "⌘K" keycap reads as keyboard jargon
                a tap-only user won't recognize as "the menu" — and the palette is
                their ONLY path to the rail commands. Narrow gets a universal ☰
                "Menu" affordance; wide keeps the keycap. Same button + testid. */}
            {(() => {
              const palette = paletteAffordance(narrow);
              return (
                <button
                  type="button"
                  className={`pill-icon-btn ${palette.variantClass}`}
                  data-testid="palette-button"
                  aria-label={palette.label}
                  title={palette.title}
                  onClick={() => setPaletteOpen(true)}
                >
                  {palette.content}
                </button>
              );
            })()}
            {/* Comments Phase A (L5): the cross-file comments overview toggle —
                a quiet icon button with an open-thread count pip (null at 0). Its
                dropdown lists every thread; clicking one focus-jumps + opens it. */}
            <span className="pill-sep" aria-hidden="true" />
            <CommentsOverview threads={overviewThreads} onJump={onJumpToThread} />
            {/* 14-E: the signed-in account affordance. `getActiveAuthUser()` is
                non-null ONLY when the boot AuthGate verified a session (auth-on
                deployments), so auth-off runs render this pill byte-for-byte
                as before. Stable for the shell's lifetime (set before mount). */}
            {authUser !== null && (
              <>
                <span className="pill-sep" aria-hidden="true" />
                <AccountChip user={authUser} onOpenSettings={() => gotoSettings()} />
              </>
            )}
          </div>
          {/* H5: the one-time first-run cue. Rendered in the SAME header slot as
              the ⌘K nudge (and INSTEAD of it while showing) — `.actions-cluster`
              is a column, so an extra stacked pill would grow the topbar and
              shrink the editor/agent panes. A single pill keeps the cluster at its
              tolerated height. Surfaces the templates + 1905 demo a novice would
              miss behind the unlabeled ⊞ glyph; ✕ ("just start writing") keeps the
              starter. Local fresh boots only; dismissed permanently on any action.
              Once dismissed, the ⌘K nudge takes the slot. */}
          {showFirstRun && !narrow ? (
            <div className="nudge-pill first-run-pill" data-testid="first-run-chooser" role="status">
              <span>New here?</span>
              <button
                type="button"
                className="first-run-action"
                data-testid="first-run-demo"
                onClick={onFirstRunDemo}
              >
                1905 demo
              </button>
              <button
                type="button"
                className="first-run-dismiss"
                data-testid="first-run-dismiss"
                aria-label="Dismiss — just start writing"
                title="Dismiss — just start writing"
                onClick={dismissFirstRun}
              >
                ✕
              </button>
            </div>
          ) : (
            showNudge && (
              <button
                type="button"
                className="nudge-pill"
                data-testid="palette-nudge"
                title="Open the command palette"
                onClick={() => setPaletteOpen(true)}
              >
                Press <kbd>⌘K</kbd> — every action, one search away
              </button>
            )
          )}
        </div>
      </header>
      {/* Share-join readiness cue (#14-C): a CONNECTED joiner sees a calm,
          NON-BLOCKING "Syncing…" line until the room's content lands (or a short
          timeout). The editor stays live throughout — Yjs merges early edits — so
          this only sets expectations, it never gates the data-critical join. */}
      {/* C1: persistence is broken (IndexedDB blocked/unavailable) — the doc is
          in-memory only, so closing the tab loses everything. The MOST severe
          state, so it leads the top-of-shell bars. role="alert"; NOT dismissable
          (it's an ongoing condition, not a transient nudge); the backup CTA reuses
          the SAME exportPdf the durability nudge / Export menu use. The save chip
          independently reads "Not saved", so the signal is doubly honest. */}
      {saveState === "at-risk" && (
        <div className="durability-bar">
          <Notice
            severity="error"
            testId="at-risk-banner"
            message="Your work isn't being saved to this device — storage is unavailable, so closing this tab will lose it."
            action={{
              label: "Back up a copy",
              onClick: () => {
                runPdfExport();
              },
              testId: "at-risk-backup",
              title: "Export the project as a PDF so you have an off-browser copy",
            }}
          />
        </div>
      )}
      {joinCue && (
        <div className="durability-bar" data-testid={joinCue.testId}>
          <Notice severity={joinCue.severity} message={joinCue.message} />
        </div>
      )}
      {/* C2: the link-status cue. A dropped relay socket used to be invisible
          (the topbar still implied "Collaborative" while edits buffered into a
          dead outbox). Now a drop shows a calm "Reconnecting…" and recovery a
          brief "Reconnected." Gated on a live connection so teardown's explicit
          disconnect() can't flash it; not dismissable (it's an ongoing
          condition that self-heals). Distinct from the initial-join cue above. */}
      {linkCue && (
        <div className="durability-bar">
          <Notice
            severity={linkCue.severity}
            testId="link-status-banner"
            message={linkCue.message}
            {...(linkStatus === "reconnecting" && connection
              ? {
                  // L6: while reconnecting, let the user force an immediate
                  // attempt (resets the backoff) instead of waiting out the cap.
                  action: {
                    label: "Retry now",
                    onClick: () => connection.retryNow(),
                    testId: "link-retry-now",
                    title: "Reconnect to the room now instead of waiting for the next attempt",
                  },
                }
              : {})}
          />
        </div>
      )}
      {/* B2: the storage-full cue. The relay refused a growth write (a room storage
          cap was hit), so this peer's edits are saved on this device but no longer
          reaching the room — y-sync has no per-update ack, so without this banner
          sync LOOKS fine while the doc silently diverges. Distinct from the link
          cues above (the socket is healthy). Dismissible (there is no "storage ok
          again" frame, so the user can hide it); it also clears on a reconnect
          edge and re-shows on any new frame (see link-status.ts). */}
      {storageBanner && (
        <div className="durability-bar">
          <Notice
            severity={storageBanner.severity}
            testId="storage-full-banner"
            message={storageBanner.message}
          />
          <button
            type="button"
            className="durability-dismiss"
            data-testid="storage-full-dismiss"
            aria-label="Dismiss storage warning"
            title="Dismiss"
            onClick={() => setStorageCueState((prev) => reduceStorageCue(prev, { type: "dismiss" }))}
          >
            ✕
          </button>
        </div>
      )}
      {/* C3: the ONE shell-root status banner. Promoted out of the agent sidebar
          so a failed export/version-restore/apply stays visible regardless of the
          sidebar's collapse/narrow state. Severity drives the ARIA role (failures
          interrupt via role="alert"); dismissable like the durability nudge. */}
      {notice && (
        <div className="durability-bar">
          <Notice severity={notice.severity} testId="accept-notice" message={notice.message} />
          <button
            type="button"
            className="durability-dismiss"
            data-testid="notice-dismiss"
            aria-label="Dismiss notice"
            title="Dismiss"
            onClick={() => setNotice(null)}
          >
            ✕
          </button>
        </div>
      )}
      {/* ADR-0024 §4: the global, always-visible pending-review surface. The
          proposal cards used to live ONLY in the collapsible agent sidebar
          (marked `inert` when collapsed), so a pending agent change vanished the
          moment the panel was tucked away — and a VIEWER saw nothing at all.
          This shell-root badge shows the count regardless of panel state; an
          editor clicks it to reveal the EXISTING Accept/Reject cards (reused
          verbatim), a viewer sees the count plus an "ask an editor" cue. Absent
          when there is no connection or nothing pending (default-safe). */}
      {connection && (
        <PendingReviewBadge
          count={pendingRunCount}
          canMutate={canMutate}
          open={reviewPaneOpen}
          onToggle={() => setReviewPaneOpen((o) => !o)}
        >
          {/* ADR-0025 §5/§6: one RunReviewCard per agent run (grouped by runId;
              legacy records form singleton runs). Each card carries Accept-all /
              Reject-all + an expandable per-record detail reusing the existing
              McpProposals / McpFileProposals diff bodies. */}
          {runGroups.map((group) => (
            <RunReviewCard
              key={group.runId}
              group={group}
              onAcceptAll={() => onAcceptRunGroup(group)}
              onRejectAll={() => onRejectRunGroup(group)}
              onAcceptRecord={(record) =>
                "ops" in record
                  ? onAcceptFileProposal(record as FileProposalRecord)
                  : onAcceptProposal(record as ProposalRecord)
              }
              onRejectRecord={(record) =>
                "ops" in record
                  ? onRejectFileProposal(record as FileProposalRecord)
                  : onRejectProposal(record as ProposalRecord)
              }
              onError={(message) => setNotice(errorNotice(message))}
            />
          ))}
        </PendingReviewBadge>
      )}
      {/* #23.1 data-durability guard: a calm, dismissible nudge shown ONLY when
          the local-first promise is at risk (browser may evict, or storage is
          nearly full). The "Back up a copy" CTA reuses the EXISTING Export PDF
          handler (same one the Export menu / ⌘K use). Once dismissed it stays
          hidden for the session. "ok"/"unknown" renders nothing — healthy and
          unsupported environments are byte-for-byte unchanged. */}
      {durability?.level === "at-risk" && !durabilityDismissed && (
        <div className="durability-bar">
          <Notice
            severity="warning"
            testId="durability-notice"
            message={`${durability.reason} Back up a copy of your work.`}
            action={{
              label: "Back up a copy",
              onClick: () => {
                runPdfExport();
              },
              testId: "durability-backup",
              title: "Export the project as a PDF so you have an off-browser copy",
            }}
          />
          <button
            type="button"
            className="durability-dismiss"
            data-testid="durability-dismiss"
            aria-label="Dismiss storage warning"
            title="Dismiss"
            onClick={() => setDurabilityDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}
      {/* M9: a fresh incognito/transient origin — the #23.1 nudge above fires only
          near the storage cap, so a new private-window user would otherwise get NO
          warning that their work may vanish on close. A calm, one-time dismissible
          INFO banner fills that gap (suppressed when the stronger at-risk nudge is
          already showing). Persisted/unsupported origins render nothing. */}
      {durability?.level !== "at-risk" &&
        !transientWarningDismissed &&
        shouldWarnTransientStorage(persistState) && (
          <div className="durability-bar">
            <Notice
              severity="info"
              testId="transient-storage-banner"
              message="This browser may not keep your work after you close it — in a private/incognito window it's cleared on close."
              action={{
                label: "Back up a copy",
                onClick: () => {
                  runPdfExport();
                },
                testId: "transient-storage-backup",
                title: "Export the project as a PDF so you have an off-browser copy",
              }}
            />
            <button
              type="button"
              className="durability-dismiss"
              data-testid="transient-storage-dismiss"
              aria-label="Dismiss storage warning"
              title="Dismiss"
              onClick={() => {
                setTransientWarningDismissed(true);
                dismissTransientWarning();
              }}
            >
              ✕
            </button>
          </div>
        )}
      <IconRail
        dock={dock}
        agentOpen={!panes.isCollapsed("sidebar")}
        themeMode={themeMode}
        focusMode={focusMode}
        agentMode={agentMode}
        onToggleDock={onRailToggle}
        onToggleAgent={() => panes.toggleCollapse("sidebar")}
        onToggleTheme={toggleThemeNow}
        onToggleFocus={toggleFocusMode}
        onToggleAgentMode={toggleAgentMode}
        onShowShortcuts={() => setShowShortcuts(true)}
      />
      <div className="shell-main" role="main" aria-label="Editor and preview">
        {/* In the narrow morph the Files pane lives in the bottom tabs, so the
            files dock must not render a second copy; transient panels (palette-
            opened history/git/insert) still dock as an overlay sheet. */}
        {!(narrow && dock === "files") && dockNode}
        {narrow ? (
          <div className="tabbed" data-testid="tabbed-layout">
            <TabBar tabs={tabs} active={activeTab} onSelect={setActiveTab} />
            <div
              className="tab-panel"
              data-testid="tab-panel"
              data-active-tab={activeTab}
              id={TAB_PANEL_ID}
              role="tabpanel"
              aria-labelledby={`tab-${activeTab}`}
            >
              {activeTab === "files"
                ? filesNode
                : activeTab === "editor"
                  ? editorNode
                  : activeTab === "agent"
                    ? sidebarNode
                    : centerNode}
            </div>
          </div>
        ) : (
          <SplitPanes
            className={`panes panes-rail${panes.isCollapsed("sidebar") ? " is-sidebar-collapsed" : ""}`}
            controller={panes}
            panes={[
              { col: "editor", node: editorNode },
              { col: "center", node: centerNode },
              { col: "sidebar", node: sidebarNode },
            ]}
          />
        )}
      </div>
      {treeMenu && (
        <FileTreeMenu
          target={treeMenu.target}
          anchor={treeMenu.anchor}
          onAction={runTreeMenuAction}
          onClose={() => setTreeMenu(null)}
        />
      )}
      {/* Comments Phase A: the create composer (L3) and the thread card (L4) —
          root-level floating siblings of the file-tree menu (a positioned/clipped
          ancestor would re-anchor their `position: fixed`). One at a time. */}
      {commentDraft && (
        <CommentCreateComposer
          anchorText={commentDraft.selection.text}
          anchor={commentDraft.anchor}
          onSubmit={onCommentSubmit}
          onClose={() => setCommentDraft(null)}
        />
      )}
      {activeThread && activeThreadView && (
        <CommentThreadCard
          thread={activeThreadView}
          anchor={activeThread.anchor}
          orphaned={activeThreadOrphaned}
          viewers={threadViewers}
          onReply={onThreadReply}
          onResolve={onThreadResolve}
          onReopen={onThreadReopen}
          onClose={() => setActiveThread(null)}
        />
      )}
      <CommandSheet shortcuts={shortcuts} open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <CommandPalette
        commands={paletteRegistry.list()}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      {/* M3: the one-time first-run coach overlay. Root-level floating sibling so
          its `position: fixed` isn't re-anchored by a clipped ancestor. Wide
          layout only (`!narrow` — the tabbed morph has no three-pane split to
          orient) and pointer-through, so it never blocks the shell. */}
      {showCoach && !narrow && <CoachOverlay onDismiss={dismissCoach} />}
      {compareData && (
        <div
          className="authoring-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Compare versions"
          onClick={() => setCompareData(null)}
        >
          <div
            ref={compareDialogRef}
            className="authoring-panel"
            data-testid="compare-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="authoring-close"
              aria-label="Close"
              autoFocus
              onClick={() => setCompareData(null)}
            >
              ✕
            </button>
            <VersionCompare
              comparison={compareData.comparison}
              baseLabel={compareData.baseLabel}
              otherLabel={compareData.otherLabel}
            />
            {compareData.onImport && (
              <div className="authoring-actions">
                <button
                  type="button"
                  className="authoring-primary"
                  data-testid="git-fetch-import"
                  onClick={compareData.onImport}
                >
                  Import these changes
                </button>
                <button
                  type="button"
                  className="authoring-secondary"
                  data-testid="git-fetch-discard"
                  onClick={() => setCompareData(null)}
                >
                  Discard
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One-line human summary of a snapshotted selection for the revise prompt, e.g.
 * "Revise the selected line 5" or "Revise the selected 3 lines (12-14)". PURE.
 */
function reviseSummary(snap: { startLine: number; endLine: number }): string {
  if (snap.startLine === snap.endLine) {
    return `Revise the selected line ${snap.startLine}.`;
  }
  const count = snap.endLine - snap.startLine + 1;
  return `Revise the selected ${count} lines (${snap.startLine}-${snap.endLine}).`;
}
