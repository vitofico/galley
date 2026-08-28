/**
 * `SettingsApp` — the unified `/settings` surface (#19.7, Rail & Islands).
 *
 * One calm page for everything that is a *preference* (device/user scope);
 * mid-session mode switches (focus, ⌘J, dock toggles, zoom) stay in the shell
 * chrome, and per-project surfaces (git remote, Share) stay in their panels.
 *
 * Sections (single source of truth: `settings-sections.ts`, which also feeds
 * the ⌘K deep-link entries and the status-chip popover link):
 *   - Appearance — the existing theme mechanism (`theme.ts`), applied + persisted.
 *   - Editor     — the existing editor-prefs module; the rail-foot "Aa" dock is
 *                  retired, this is its new home. Editors read prefs at mount,
 *                  so the copy is honest about when a change lands.
 *   - Compile    — the Local/Server/Auto posture (`CompilerModeToggle`, which
 *                  persists via compiler-mode.ts) + the deploy-injected server
 *                  URL shown READ-ONLY via the existing resolution seams.
 *   - AI provider— `ProviderSettings`, previously stranded in the legacy
 *                  `?single=1` shell; persistence shared with every shell
 *                  through `provider-storage.ts`.
 *   - Identity   — `LocalProfile.displayName` (already feeds presence and
 *                  attribution; this is its first UI). Honest copy: applies on
 *                  the NEXT join/share.
 *
 * Deep links: `/settings#<section>` scrolls the named section into view on
 * mount; the in-page nav uses plain `#<id>` anchors (native scroll, no router
 * involvement).
 */
import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig } from "@galley/shared";
import { navigate } from "../router.js";
import {
  SETTINGS_SECTIONS,
  sectionFromHash,
  settingsReturnHref,
  type SettingsSectionId,
} from "../settings-sections.js";
import {
  applyTheme,
  resolveInitialTheme,
  setTheme,
  STORAGE_KEY as THEME_KEY,
  type ThemeMode,
} from "../theme.js";
import { applySkin, resolveInitialSkin, setSkin, SKIN_STORAGE_KEY, type Skin } from "../skin.js";
import { useEditorPrefs } from "../use-editor-prefs.js";
import { EditorPrefs } from "./EditorPrefs.js";
import { CompilerModeToggle } from "./CompilerModeToggle.js";
import { readServerUrlInputs } from "../compiler-assets.js";
import { resolveServerCompileUrl } from "./compiler-mode.js";
import { ProviderSettings } from "./ProviderSettings.js";
import { AgentAccessSettings } from "./AgentAccessSettings.js";
import { AccountChip } from "./AccountChip.js";
import {
  loadStoredProvider,
  saveStoredProvider,
  clearStoredProvider,
} from "../provider-storage.js";
import { loadLocalProfile, updateLocalProfile } from "../local-profile.js";
import { getActiveAuthUser } from "../auth-gate.js";
import {
  clearGithubConnection,
  loadRedactedGithubConnection,
  saveGithubConnection,
  type RedactedGithubConnection,
} from "../github-connect.js";
import { validateToken } from "../github-api.js";
import "./settings-page.css";

/**
 * Connect GitHub — DEVICE-scoped credential only (paste-a-PAT → resolved login).
 * The PUSH TARGET (which repository) is per-project and lives in each project's
 * Git panel (`github-repo-target`), so this card carries no repo selection.
 *
 * Same write-only-token discipline as the git-remote panel: the input is a
 * password field, it is cleared after every attempt, and everything rendered
 * comes from the structurally token-free `RedactedGithubConnection`.
 */
function GithubConnectSettings() {
  const [view, setView] = useState<RedactedGithubConnection | null>(() =>
    loadRedactedGithubConnection(),
  );
  const [tokenDraft, setTokenDraft] = useState("");
  const [busy, setBusy] = useState<null | "validate">(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const validate = async () => {
    if (busy) return;
    const draft = tokenDraft.trim();
    setBusy("validate");
    setNote(null);
    try {
      const { login } = await validateToken(draft);
      setTokenDraft(""); // write-only: the secret never lingers in component state
      if (!saveGithubConnection({ token: draft, login })) {
        setNote({ ok: false, text: "Could not save the connection in this browser." });
        return;
      }
      setView(loadRedactedGithubConnection());
      setNote({ ok: true, text: `Connected as ${login}.` });
    } catch (err) {
      setTokenDraft(""); // clear on failure too — no secret left in the DOM
      setNote({ ok: false, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () => {
    clearGithubConnection();
    setView(null);
    setTokenDraft("");
    setNote({ ok: true, text: "Disconnected — the token was removed from this browser." });
  };

  return (
    <>
      <p className="settings-card-lead">
        Connect a GitHub account here, then choose the target repository in each project’s
        Git panel — every project keeps its own. The token is stored in this browser only and
        is sent to <code>api.github.com</code> directly — never to any Galley server.
      </p>
      {view === null ? (
        <>
          <div className="settings-github-row">
            <input
              type="password"
              autoComplete="off"
              data-testid="github-token-input"
              aria-label="GitHub personal access token"
              placeholder="GitHub personal access token"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void validate();
              }}
            />
            <button
              type="button"
              className="settings-primary"
              data-testid="github-validate"
              disabled={busy !== null}
              onClick={() => void validate()}
            >
              {busy === "validate" ? "Validating…" : "Validate"}
            </button>
          </div>
          <p className="settings-note">
            Use a classic token with the <code>repo</code> scope, or a fine-grained token
            with <strong>Contents: read &amp; write</strong> on the target repository
            (creating a repository from a project’s Git panel needs the classic{" "}
            <code>repo</code> scope).
          </p>
        </>
      ) : (
        <>
          <p className="settings-github-connected">
            Connected as <strong data-testid="github-login">{view.login}</strong>.{" "}
            <button
              type="button"
              className="settings-secondary"
              data-testid="github-disconnect"
              onClick={disconnect}
            >
              Disconnect
            </button>
          </p>
          <p className="settings-note">
            Choose which repository each project pushes to from its Git panel — pushing replaces
            the branch contents with that project’s current files (one-way; Galley never fetches
            from GitHub in this version).
          </p>
        </>
      )}
      {note && (
        <p
          className="settings-saved-note"
          data-testid="github-status"
          data-ok={note.ok ? "true" : "false"}
          role="status"
        >
          {note.text}
        </p>
      )}
    </>
  );
}

/** Resolve the skin to show — stored choice wins, else the default ("studio"). */
function initialSkin(): Skin {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SKIN_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  return resolveInitialSkin({ stored });
}

/** Resolve the theme to show/apply — stored choice wins, else the OS hint. */
function initialTheme(): ThemeMode {
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
  return resolveInitialTheme({ stored, prefersDark });
}

export function SettingsApp() {
  // --- Appearance: the pressed state and the applied attribute resolve from
  // the SAME initial read, so they agree from the first paint.
  const [themeMode, setThemeMode] = useState<ThemeMode>(initialTheme);
  useEffect(() => {
    applyTheme(themeMode);
    // Mount-only on purpose: subsequent changes go through chooseTheme (which
    // also persists); re-running on state alone would double-apply harmlessly
    // but blur who owns the side effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseTheme = (mode: ThemeMode) => {
    setTheme(mode); // applies the data-theme attribute + persists the choice
    setThemeMode(mode);
  };

  // --- Appearance: skin (Press / Studio) — apply at mount so direct loads of
  // /settings reflect the stored skin; subsequent changes go through chooseSkin.
  const [skin, setSkinState] = useState<Skin>(initialSkin);
  useEffect(() => {
    applySkin(skin);
    // Mount-only on purpose: subsequent changes go through chooseSkin (which
    // also applies); re-running on state alone would double-apply harmlessly
    // but blur who owns the side effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseSkin = (next: Skin) => { setSkin(next); setSkinState(next); };

  // --- Editor: the persisted prefs pair (same hook the shells use).
  const [prefs, setPrefs] = useEditorPrefs();

  // --- Compile: the RESOLVED trusted server URL, read-only (#5 Slice 5 — the
  // deploy injects it via VITE_GALLEY_COMPILE_URL; it is config, not a setting).
  const serverUrl = useMemo(() => resolveServerCompileUrl(readServerUrlInputs()), []);

  // --- AI provider: shared persistence with every shell (provider-storage.ts).
  const [provider, setProvider] = useState<ProviderConfig | null>(() => loadStoredProvider());
  const [providerNote, setProviderNote] = useState<string | null>(null);

  // --- Identity: LocalProfile.displayName (feeds presence + attribution).
  // When login is on, the boot AuthGate publishes the signed-in user before any
  // shell mounts (null in every auth-off run) — read it ONCE, same pattern as
  // ProjectApp. Prefill priority: a name the user already saved locally wins
  // (an explicit override), else the auth-provided display, else empty.
  const [authUser] = useState(() => getActiveAuthUser());
  const [displayName, setDisplayName] = useState<string>(
    () => loadLocalProfile().displayName ?? authUser?.display ?? "",
  );
  const [nameSaved, setNameSaved] = useState(false);

  // Deep link (#19.7 R8): `/settings#compile` etc. scrolls the section into
  // view once the page is mounted (a pushState navigation never auto-scrolls).
  useEffect(() => {
    const section = sectionFromHash(window.location.hash);
    if (!section) return;
    document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, []);

  const saveName = () => {
    const trimmed = displayName.trim();
    updateLocalProfile({ displayName: trimmed });
    setDisplayName(trimmed);
    setNameSaved(true);
  };

  const sectionTitle = (id: SettingsSectionId) =>
    SETTINGS_SECTIONS.find((s) => s.id === id)!.label;

  return (
    <div className="settings-page" data-testid="settings-page">
      <div className="settings-page-inner">
        <div className="settings-topbar">
          <button
            type="button"
            className="settings-back"
            data-testid="settings-back"
            onClick={() => navigate(settingsReturnHref(window.location.search))}
          >
            ← Back to the editor
          </button>
          {/* Same account chip + popover as the editor / Projects header. The
              "Settings" popover entry is omitted here on purpose — you are
              already on it — so the menu shows the identity and Sign out. The
              chip renders nothing on auth-off runs (no published user). */}
          {authUser && <AccountChip user={authUser} />}
        </div>

        <header className="settings-header">
          <h1 className="settings-title">Settings</h1>
          <p className="settings-subtitle">
            Preferences for this browser — they apply everywhere you write, not to any one
            project. Project things (sharing, git remotes) live with each project.
          </p>
          <p className="settings-optional-lead" data-testid="settings-optional-lead">
            Nothing here is required. Galley writes and typesets fully offline in this
            browser — connect an AI provider or a GitHub account only when you want those
            features.
          </p>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} data-testid={`settings-nav-${s.id}`}>
                {s.label}
              </a>
            ))}
          </nav>

          <div className="settings-sections">
            {/* ---------- Identity --------------------------------------------- */}
            <section
              id="identity"
              className="settings-card"
              data-testid="settings-section-identity"
              aria-label={sectionTitle("identity")}
            >
              <h2 className="settings-card-title">Identity</h2>
              <p className="settings-card-lead">
                The name collaborators see — in presence, the share roster, and per-file
                attribution.
                {authUser && (
                  <>
                    {" "}
                    Started from your signed-in account — change it here to override what
                    collaborators see.
                  </>
                )}
              </p>
              <div className="settings-identity-row">
                <input
                  type="text"
                  data-testid="settings-display-name"
                  aria-label="Display name"
                  placeholder="Your name as collaborators see it"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setNameSaved(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName();
                  }}
                />
                <button
                  type="button"
                  className="settings-primary"
                  data-testid="settings-display-name-save"
                  onClick={saveName}
                >
                  Save
                </button>
              </div>
              {nameSaved && (
                <p
                  className="settings-saved-note"
                  data-testid="settings-display-name-saved"
                  role="status"
                >
                  Saved. It takes effect the next time you join or share a live session —
                  peers already in a room keep seeing your old name until then.
                </p>
              )}
            </section>

            {/* ---------- AI provider ------------------------------------------ */}
            <section
              id="ai"
              className="settings-card"
              data-testid="settings-section-ai"
              aria-label={sectionTitle("ai")}
            >
              <h2 className="settings-card-title">AI provider</h2>
              <p className="settings-card-lead">
                The model behind the agent panel — it drafts, edits, and explains
                right in your document. Right now it uses{" "}
                <strong data-testid="settings-provider-current">
                  {provider ? provider.label : "Demo (offline)"}
                </strong>
                . A direct-mode API key is stored in this browser only.
              </p>
              <ProviderSettings
                config={provider}
                onSave={(config) => {
                  saveStoredProvider(config);
                  setProvider(config);
                  setProviderNote(
                    `Saved — the agent panel now uses ${config.label}.`,
                  );
                }}
                onUseDemo={() => {
                  clearStoredProvider();
                  setProvider(null);
                  setProviderNote(
                    "Using the built-in demo model — offline, canned answers, nothing leaves this browser.",
                  );
                }}
              />
              {providerNote && (
                <p
                  className="settings-saved-note"
                  data-testid="settings-provider-saved"
                  role="status"
                >
                  {providerNote}
                </p>
              )}
            </section>

            {/* ---------- Appearance ---------------------------------------- */}
            <section
              id="appearance"
              className="settings-card"
              data-testid="settings-section-appearance"
              aria-label={sectionTitle("appearance")}
            >
              <h2 className="settings-card-title">Appearance</h2>
              <p className="settings-card-lead">
                The chrome theme and colour identity. The rendered page stays paper in both
                theme modes — only the desk around it changes.
              </p>
              <h3 className="settings-subhead">Style</h3>
              <div className="settings-theme-choice" role="group" aria-label="Style">
                <button
                  type="button"
                  className="settings-theme-option"
                  data-testid="settings-skin-studio"
                  aria-pressed={skin === "studio"}
                  onClick={() => chooseSkin("studio")}
                >
                  <span className="settings-theme-name">Studio</span>
                  <span className="settings-theme-desc">Tangerine on white — the Galley signature</span>
                </button>
                <button
                  type="button"
                  className="settings-theme-option"
                  data-testid="settings-skin-press"
                  aria-pressed={skin === "press"}
                  onClick={() => chooseSkin("press")}
                >
                  <span className="settings-theme-name">Press</span>
                  <span className="settings-theme-desc">Gold on warm paper — the editorial press</span>
                </button>
              </div>
              <h3 className="settings-subhead">Theme</h3>
              <div className="settings-theme-choice" role="group" aria-label="Theme">
                <button
                  type="button"
                  className="settings-theme-option"
                  data-testid="settings-theme-light"
                  aria-pressed={themeMode === "light"}
                  onClick={() => chooseTheme("light")}
                >
                  <span className="settings-theme-name">Light</span>
                  <span className="settings-theme-desc">
                    Refined Typesetter — warm paper and ink
                  </span>
                </button>
                <button
                  type="button"
                  className="settings-theme-option"
                  data-testid="settings-theme-dark"
                  aria-pressed={themeMode === "dark"}
                  onClick={() => chooseTheme("dark")}
                >
                  <span className="settings-theme-name">Dark</span>
                  <span className="settings-theme-desc">
                    Ink &amp; Glass — a low lamp over the press
                  </span>
                </button>
              </div>
              <p className="settings-note">
                Also one keystroke away anywhere: <kbd>⌘J</kbd> toggles the theme.
              </p>
            </section>

            {/* ---------- Editor --------------------------------------------- */}
            <section
              id="editor"
              className="settings-card"
              data-testid="settings-section-editor"
              aria-label={sectionTitle("editor")}
            >
              <h2 className="settings-card-title">Editor</h2>
              <p className="settings-card-lead">
                How the source editor renders, on every document on this device.
              </p>
              <EditorPrefs embedded prefs={prefs} onChange={setPrefs} open onClose={() => {}} />
              <p className="settings-note">
                Saved immediately; an editor that is already open picks the change up when you
                return to it.
              </p>
            </section>

            {/* ---------- Compile --------------------------------------------- */}
            <section
              id="compile"
              className="settings-card"
              data-testid="settings-section-compile"
              aria-label={sectionTitle("compile")}
            >
              <h2 className="settings-card-title">Compile</h2>
              <p className="settings-card-lead">
                Where the preview typesets. <strong>Local</strong> never leaves this browser;{" "}
                <strong>Server</strong> sends the document to the configured compile service;{" "}
                <strong>Auto</strong> prefers local and falls back to the server once, visibly.
              </p>
              <CompilerModeToggle />
              <dl className="settings-kv">
                <dt>Compile server</dt>
                <dd data-testid="settings-compile-url">
                  {serverUrl ?? "Not configured for this deployment."}
                </dd>
              </dl>
              <p className="settings-note">
                The server address is injected by the deployment, not editable here. Without
                one, Server and Auto stay safely on the local compiler. Live compile status
                shows in the editor’s status chip.
              </p>
              {serverUrl == null && (
                <p className="settings-note" data-testid="settings-compile-hint">
                  Self-hosting? Server compile is opt-in — the default{" "}
                  <code>docker compose up</code> ships no compile service. To enable it, run{" "}
                  <code>
                    docker compose -f docker-compose.yml -f docker-compose.compile.yml --profile
                    compile up --build
                  </code>{" "}
                  (the overlay pre-sets <code>GALLEY_COMPILE_URL</code> to{" "}
                  <code>http://127.0.0.1:3001/compile</code>), then reload. See{" "}
                  <strong>docs/self-host.md → Enabling server-side compile</strong>.
                </p>
              )}
            </section>

            {/* ---------- Connect GitHub --------------------------------------- */}
            <section
              id="github"
              className="settings-card"
              data-testid="settings-section-github"
              aria-label={sectionTitle("github")}
            >
              <h2 className="settings-card-title">Connect GitHub</h2>
              <GithubConnectSettings />
            </section>

            {/* ---------- Agent Access ----------------------------------------- */}
            <section
              id="agent-access"
              className="settings-card"
              data-testid="settings-section-agent-access"
              aria-label={sectionTitle("agent-access")}
            >
              <h2 className="settings-card-title">Agent Access</h2>
              <AgentAccessSettings />
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
