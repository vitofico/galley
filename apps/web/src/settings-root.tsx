/**
 * `SettingsRoot` — the `/settings` route (#19.7), lazy-loaded by `main.tsx` so
 * the settings surface (and the provider/model client code it pulls in) stays
 * out of the main route chunks.
 *
 * A thin boot wrapper in the LibraryRoot/JoinRoot mold: it imports the dark
 * theme override block (this route is its own boot, so without the import the
 * `data-theme` attribute would have no CSS to key off) and renders the page.
 * Theme RESOLUTION lives in `SettingsApp` itself — the Appearance section's
 * pressed state must agree with the applied theme from the very first paint.
 */
import { useEffect, useRef } from "react";
import { SettingsApp } from "./components/SettingsApp.js";
import { WhatsNewApp, whatsNewLinkId } from "./components/WhatsNewApp.js";
import { sectionFromHash } from "./settings-sections.js";
import "./theme.css";

export function SettingsRoot({ whatsNew = false }: { whatsNew?: boolean }) {
  const wasWhatsNew = useRef(false);
  useEffect(() => {
    if (!whatsNew && wasWhatsNew.current) {
      const section = sectionFromHash(window.location.hash);
      if (section) {
        const target = document.getElementById(section);
        if (target) {
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
      } else {
        document.getElementById(whatsNewLinkId)?.focus();
      }
    }
    wasWhatsNew.current = whatsNew;
  }, [whatsNew]);

  return whatsNew ? <WhatsNewApp /> : <SettingsApp />;
}
