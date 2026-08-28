/**
 * The `/settings` section model (#19.7) — PURE, shared by the settings page,
 * the command-palette deep-link entries, and the status-chip popover link.
 *
 * One list is the single source of truth for section ids, their human labels,
 * and the `#<id>` deep-link contract (`/settings#compile` etc.), so a palette
 * entry can never point at a section the page doesn't render.
 */

import { parseRoute, routeHref } from "./router.js";

export const SETTINGS_SECTIONS = [
  // Ordered most-reached-first for a collaboration-first, agent-forward tool:
  // who you are and the model behind the agent lead; the everyday cosmetic
  // preferences follow; the credential / capability-granting sections
  // (GitHub token, agent pairing) sit last, where a skimmer is least likely to
  // fat-finger them. Order is presentation-only — every consumer keys off `id`
  // (deep links, the palette entries), never the array index.
  { id: "identity", label: "Identity" },
  { id: "ai", label: "AI provider" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "compile", label: "Compile" },
  { id: "github", label: "Connect GitHub" },
  { id: "agent-access", label: "Agent Access" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** True when `value` names a real settings section. */
export function isSettingsSection(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

/**
 * Parse a location hash (`"#compile"`, with or without the leading `#`) into a
 * section id, or null when it names no section (empty, unknown, garbage).
 */
export function sectionFromHash(hash: string): SettingsSectionId | null {
  const candidate = hash.startsWith("#") ? hash.slice(1) : hash;
  return isSettingsSection(candidate) ? candidate : null;
}

/**
 * The canonical href for the settings page, optionally deep-linked to a section
 * and optionally carrying the origin route (`from`) so the page's "Back" button
 * can return there instead of always landing on home (#H6). The query precedes
 * the hash, the canonical URL order.
 */
export function settingsHref(section?: SettingsSectionId, from?: string): string {
  const query = from ? `?from=${encodeURIComponent(from)}` : "";
  const hash = section ? `#${section}` : "";
  return `/settings${query}${hash}`;
}

/**
 * Resolve where the settings "Back to the editor" button should return (#H6):
 * the threaded `from` route when it names a SAFE internal route, else `/`.
 *
 * Safety: the value is canonicalized through the router (`parseRoute`→
 * `routeHref`), so only known internal paths (`/`, `/library`, `/p/<id>`,
 * `/join/<room>`, `/settings`) ever survive — an external or protocol-relative
 * `from` (`https://…`, `//evil.com`, `javascript:…`) is rejected to home,
 * closing the open-redirect shape even though in-SPA `navigate()` can't cross
 * origins anyway.
 */
export function settingsReturnHref(search: string): string {
  let from: string | null;
  try {
    from = new URLSearchParams(search).get("from");
  } catch {
    return "/";
  }
  // Must be a single-slash-rooted app path; reject protocol-relative `//host`.
  if (!from || !from.startsWith("/") || from.startsWith("//")) return "/";
  const q = from.indexOf("?");
  const pathname = q === -1 ? from : from.slice(0, q);
  const innerSearch = q === -1 ? "" : from.slice(q + 1);
  return routeHref(parseRoute(pathname, innerSearch));
}
