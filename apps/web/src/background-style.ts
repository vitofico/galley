/** Artwork is independent of the colour skin and light/dark mode. */
export type BackgroundStyle = "plain" | "artwork";
export const BACKGROUND_STORAGE_KEY = "galley.backgroundStyle";

export function resolveBackgroundStyle(stored: string | null): BackgroundStyle {
  return stored === "plain" ? "plain" : "artwork";
}

export function readBackgroundStyle(): BackgroundStyle {
  try {
    return resolveBackgroundStyle(localStorage.getItem(BACKGROUND_STORAGE_KEY));
  } catch {
    return "artwork";
  }
}

export function applyBackgroundStyle(style: BackgroundStyle): void {
  document.documentElement.dataset.backgroundStyle = style;
}

export function setBackgroundStyle(style: BackgroundStyle): void {
  applyBackgroundStyle(style);
  try {
    localStorage.setItem(BACKGROUND_STORAGE_KEY, style);
  } catch {
    // The preference still works for this session when storage is unavailable.
  }
}
