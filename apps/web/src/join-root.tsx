/**
 * `JoinRoot` — the `/join/<room>` share-link entry (#19.4, spec §§5+7).
 *
 * Order matters: the one-time display-name prompt resolves BEFORE the project
 * session is created, so the chosen name is on this peer's `Author` when it
 * registers into the replicated authors map — presence, the Share popover and
 * per-file attribution then show the real name on every peer. The prompt is
 * skippable and asked once per browser (`namePromptSeen` in the local profile).
 *
 * The sync URL resolves exactly like the sharer's: an explicit `?sync=`
 * override (carried by the route) wins; otherwise the build-time override /
 * same-origin derivation — so a clean `/join/<room>` link works out of the box.
 */
import { useEffect, useState } from "react";
import { ProjectApp } from "./ProjectApp.js";
import type { CollabConfig } from "./collab-session.js";
import { JoinNamePrompt } from "./components/JoinNamePrompt.js";
import { loadLocalProfile, updateLocalProfile } from "./local-profile.js";
import { navigate } from "./router.js";
import { resolveSyncUrl, configuredSyncUrlOverride } from "./share.js";
import { applyTheme, resolveInitialTheme, STORAGE_KEY } from "./theme.js";
import { applySkin, resolveInitialSkin, SKIN_STORAGE_KEY } from "./skin.js";
import "./theme.css";
import "./components/join-prompt.css";

export function JoinRoot({
  room,
  sync,
  role,
}: {
  room: string;
  sync?: string;
  role?: CollabConfig["role"];
}) {
  // Ask for a name only when this browser has neither answered nor skipped yet.
  const [prompting, setPrompting] = useState<boolean>(() => {
    const profile = loadLocalProfile();
    return profile.displayName === undefined && profile.namePromptSeen !== true;
  });

  // The prompt renders before ProjectApp mounts, so this route must resolve +
  // reflect the theme itself (same pattern as LibraryRoot).
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const prefersDark =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    applyTheme(resolveInitialTheme({ stored, prefersDark }));
    let storedSkin: string | null = null;
    try { storedSkin = localStorage.getItem(SKIN_STORAGE_KEY); } catch { /* storage off */ }
    applySkin(resolveInitialSkin({ stored: storedSkin }));
  }, []);

  if (prompting) {
    return (
      <div className="join-shell">
        <JoinNamePrompt
          onDone={(name) => {
            // Persist the answer (or the skip) BEFORE the session exists, so
            // ProjectApp's session creation picks the name up at registration.
            updateLocalProfile({
              namePromptSeen: true,
              ...(name ? { displayName: name } : {}),
            });
            setPrompting(false);
          }}
        />
      </div>
    );
  }

  const syncUrl = sync ?? resolveSyncUrl(configuredSyncUrlOverride(), window.location);
  const config: CollabConfig = {
    enabled: true,
    project: true,
    syncUrl,
    room,
    ...(role ? { role } : {}),
  };
  return <ProjectApp config={config} onOpenLibrary={() => navigate("/library")} />;
}
