/**
 * Skin controller — the palette-identity axis, orthogonal to theme.ts's mode.
 * Same discipline as theme.ts: ZERO import-time side effects; DOM root and
 * storage are injectable; "studio" is the default (the Galley logo's tangerine)
 * and is the ABSENCE of the data-skin attribute (so the bare :root in styles.css
 * is the default skin). "press" (the parchment editorial palette) is opt-in via
 * data-skin="press".
 */
export type Skin = "press" | "studio";

export const SKIN_STORAGE_KEY = "galley.skin";

export interface SkinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SkinRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const DATA_ATTR = "data-skin";
const DEFAULT_SKIN: Skin = "studio";

function isSkin(value: unknown): value is Skin {
  return value === "press" || value === "studio";
}

export function resolveInitialSkin(opts: { stored: string | null }): Skin {
  return isSkin(opts.stored) ? opts.stored : DEFAULT_SKIN;
}

function defaultRoot(): SkinRoot {
  const doc = (globalThis as { document?: { documentElement?: SkinRoot } }).document;
  if (!doc || !doc.documentElement) {
    throw new Error("applySkin: no document available; pass an explicit root");
  }
  return doc.documentElement;
}

export function applySkin(skin: Skin, root?: HTMLElement): void {
  const target: SkinRoot = root ?? defaultRoot();
  if (skin === "press") {
    target.setAttribute(DATA_ATTR, "press");
  } else {
    target.removeAttribute(DATA_ATTR); // studio = absence of the attribute (default)
  }
}

export interface SetSkinOptions {
  root?: HTMLElement;
  storage?: SkinStorage;
}

function defaultStorage(): SkinStorage | null {
  const s = (globalThis as { localStorage?: SkinStorage }).localStorage;
  return s ?? null;
}

export function setSkin(skin: Skin, opts: SetSkinOptions = {}): void {
  applySkin(skin, opts.root);
  const storage = opts.storage ?? defaultStorage();
  if (storage) {
    try {
      storage.setItem(SKIN_STORAGE_KEY, skin);
    } catch {
      /* persistence is best-effort */
    }
  }
}
