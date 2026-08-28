/**
 * Presentation helpers for author attribution — a stable key, a human label, and
 * a deterministic cursor color per author identity. Shared by presence (awareness
 * `user` field) and the editor's attribution decorations so the agent's teal and
 * each editor's color are consistent everywhere.
 */
import type { Author } from "@galley/shared";

/** The proofreader's palette (matches the presence cursor colors). */
export const ATTRIBUTION_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
];

/** A stable identity key, e.g. `human:alice` / `agent:run-7`. */
export function authorKey(author: Author): string {
  return author.kind === "agent" ? `agent:${author.runId}` : `human:${author.userId}`;
}

/**
 * The generic label an anonymous human author shows (no #19.4 joiner name). The
 * single source of truth for that string: the commit save-path's author fallback
 * must adopt THIS constant so an anonymous saver's author name equals the
 * contributor label {@link authorLabel} produces — otherwise the equality-based
 * self-co-author suppression in version-message misses and the lone editor
 * co-authors their own commit.
 */
export const ANON_AUTHOR_LABEL = "Editor";

/**
 * A short human-readable label. A human author carrying a display name (#19.4
 * joiner identity) shows that name; anonymous humans stay the generic
 * {@link ANON_AUTHOR_LABEL}.
 */
export function authorLabel(author: Author): string {
  if (author.kind === "agent") return "Agent";
  const name = author.name?.trim();
  return name ? name : ANON_AUTHOR_LABEL;
}

/** A deterministic color for an author identity, hashed into the palette. */
export function authorColor(author: Author): string {
  const seed = authorKey(author);
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ATTRIBUTION_COLORS[hash % ATTRIBUTION_COLORS.length]!;
}
