/**
 * Open Graph / Twitter Card tags for the public demo.
 *
 * Why this is a seam rather than four lines in index.html: OG `image` and `url`
 * MUST be absolute (crawlers do not resolve relative ones reliably), and the
 * only absolute URL that is correct for a deployment is that deployment's own
 * origin. Hardcoding the Pages URL would hand every self-hosted instance
 * metadata pointing at someone else's site.
 *
 * So the origin arrives as build config (`VITE_GALLEY_PUBLIC_URL`) and this is
 * the **identity when it is unset**: no env, no tags, byte-identical HTML to
 * before. Only the demo build sets it. Same contract as `base.ts` — the shared
 * deployment never pays for the public one.
 */

/** The canonical copy. Kept here so the tags and their test cannot drift. */
export const SOCIAL_TITLE = "Galley — write Typst in your browser, with an AI agent as a peer";
export const SOCIAL_DESCRIPTION =
  "Open-source, local-first document workspace. The Typst compiler runs in your browser; " +
  "bring your own model, or drive it from Claude Code or Codex over MCP. No signup, no API key.";
export const SOCIAL_IMAGE_ALT =
  "The Galley editor: Typst source on the left, a typeset manuscript in the middle, the agent panel on the right.";
/** Matches the committed public/og-image.png. Crawlers use these to reserve layout. */
export const SOCIAL_IMAGE_WIDTH = 1280;
export const SOCIAL_IMAGE_HEIGHT = 720;

/**
 * PURE: an absolute `https?://host[/path]` origin with no trailing slash, or
 * `null` for anything unusable (unset, blank, or not an absolute http(s) URL).
 *
 * Fails CLOSED on a bad value: a malformed origin yields no tags at all rather
 * than tags pointing somewhere wrong. A broken preview is recoverable; a preview
 * advertising the wrong host is not.
 */
export function normalizePublicUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const joined = `${parsed.origin}${parsed.pathname}`;
  return joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

/** Minimal attribute-safe escape. Every value below is ours, but these strings
 *  are interpolated into raw HTML, so escape rather than trust. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * PURE: the `<meta>` block to inject into `<head>`, or `""` when no public URL
 * is configured (the identity case — see the module docstring).
 */
export function buildSocialMetaTags(publicUrl: string | undefined | null): string {
  const origin = normalizePublicUrl(publicUrl);
  if (origin === null) return "";
  const image = `${origin}/og-image.png`;
  return [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Galley" />`,
    `<meta property="og:title" content="${attr(SOCIAL_TITLE)}" />`,
    `<meta property="og:description" content="${attr(SOCIAL_DESCRIPTION)}" />`,
    `<meta property="og:url" content="${attr(`${origin}/`)}" />`,
    `<meta property="og:image" content="${attr(image)}" />`,
    `<meta property="og:image:width" content="${SOCIAL_IMAGE_WIDTH}" />`,
    `<meta property="og:image:height" content="${SOCIAL_IMAGE_HEIGHT}" />`,
    `<meta property="og:image:alt" content="${attr(SOCIAL_IMAGE_ALT)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${attr(SOCIAL_TITLE)}" />`,
    `<meta name="twitter:description" content="${attr(SOCIAL_DESCRIPTION)}" />`,
    `<meta name="twitter:image" content="${attr(image)}" />`,
    `<meta name="twitter:image:alt" content="${attr(SOCIAL_IMAGE_ALT)}" />`,
  ].join("\n    ");
}
