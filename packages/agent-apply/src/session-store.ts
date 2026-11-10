/** A tiny Storage-like seam so the unit gate can pass a fake (no DOM). */
export interface SessionStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

