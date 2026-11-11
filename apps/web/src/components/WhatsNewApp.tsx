import { useEffect, useRef, type ReactNode } from "react";
import { getActiveAuthUser } from "../auth-gate.js";
import { withBase } from "../base.js";
import { navigate, routeHref } from "../router.js";
import { settingsHref, type SettingsSectionId } from "../settings-sections.js";
import { AccountChip } from "./AccountChip.js";

type Update = {
  id: string;
  title: string;
  description: string;
  action?: { label: string; section: SettingsSectionId };
};

const [latestUpdate, ...earlierUpdates]: [Update, ...Update[]] = [
  {
    id: "before-you-send",
    title: "Check your document before sending",
    description:
      "Open Before you send in the writing pane to check page limits, paper size, and unfinished source markers.",
  },
  {
    id: "studio-press-and-backgrounds",
    title: "Switch between Studio and Press",
    description:
      "Choose a bright or warm paper palette and pair it with a plain or illustrated background.",
    action: { label: "Open Appearance", section: "appearance" },
  },
];

const seenUpdateKey = "galley.whatsNew.seenUpdate";
let seenInSession = false;
export const whatsNewLinkId = "settings-whats-new-link";

function hasUnreadUpdate(): boolean {
  if (seenInSession) return false;
  try {
    return localStorage.getItem(seenUpdateKey) !== latestUpdate.id;
  } catch {
    return true;
  }
}

function markUpdateSeen(): void {
  try {
    localStorage.setItem(seenUpdateKey, latestUpdate.id);
  } catch {
    // The indicator still clears for this session when storage is unavailable.
    seenInSession = true;
  }
}

function SettingsLink({
  href,
  id,
  label,
  className,
  children,
}: {
  href: string;
  id?: string;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={withBase(href)}
      id={id}
      aria-label={label}
      className={className}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function WhatsNewLink() {
  const unread = hasUnreadUpdate();
  return (
    <SettingsLink
      href={`${routeHref({ kind: "whats-new" })}${window.location.search}`}
      id={whatsNewLinkId}
      label={unread ? "What’s new, unread updates" : "What’s new"}
    >
      What’s new
      {unread && <span className="whats-new-unread" aria-hidden="true" />}
    </SettingsLink>
  );
}

export function WhatsNewApp() {
  const from =
    new URLSearchParams(window.location.search).get("from") ?? undefined;
  const authUser = getActiveAuthUser();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    markUpdateSeen();
    window.scrollTo(0, 0);
    title.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main className="settings-page" aria-labelledby="whats-new-title">
      <div className="settings-page-inner whats-new-content">
        <div className="settings-topbar">
          <button
            type="button"
            className="settings-back"
            onClick={() => navigate(settingsHref(undefined, from))}
          >
            <span aria-hidden="true">← </span>Settings
          </button>
          {authUser && <AccountChip user={authUser} />}
        </div>
        <header className="settings-header">
          <h1
            id="whats-new-title"
            className="settings-title"
            tabIndex={-1}
            ref={title}
          >
            What’s new
          </h1>
        </header>
        {[
          { id: "whats-new-latest", title: "Latest", updates: [latestUpdate] },
          {
            id: "whats-new-earlier",
            title: "Earlier",
            updates: earlierUpdates,
          },
        ].map(
          ({ id, title, updates }) =>
            updates.length > 0 && (
              <section
                key={id}
                className="whats-new-group"
                aria-labelledby={id}
              >
                <h2 id={id} className="settings-subhead">
                  {title}
                </h2>
                {updates.map(({ id, title, description, action }) => (
                  <article key={id} className="whats-new-update">
                    <h3 className="settings-card-title">{title}</h3>
                    <p className="settings-card-lead">{description}</p>
                    {action && (
                      <SettingsLink
                        href={settingsHref(action.section, from)}
                        className="whats-new-action"
                      >
                        {action.label} <span aria-hidden="true">→</span>
                      </SettingsLink>
                    )}
                  </article>
                ))}
              </section>
            ),
        )}
      </div>
    </main>
  );
}
