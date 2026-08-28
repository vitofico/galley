/**
 * "Save your own style" — a local-store of user-captured `/style.typ` modules
 * (roadmap: styles Phase 2, the save-your-own slice). A user can snapshot the
 * project's CURRENT `/style.typ` as a NAMED entry; it then appears in the Style
 * Library alongside the built-ins and can be re-applied (or deleted) later.
 *
 * Mirrors `local-profile.ts`: a `localStorage`-backed module that is PURE +
 * offline-testable via an injectable `StyleStorage { getItem, setItem }`, so the
 * Node unit gate (no `localStorage`) passes a Map-backed fake. The persisted
 * shape is a JSON array of {@link LocalStyleEntry} under {@link LOCAL_STYLES_KEY}.
 *
 * A saved entry materialises into a real {@link Style} via {@link toStyle} — a
 * non-builtin style whose `manifest` declares the same canonical ABI (entry
 * `doc`, the four palette tokens) plus DERIVED `capabilities`, so a captured
 * helper-providing style negotiates correctly via the existing `negotiate` /
 * `styleCapabilityGap` path with no special-casing in the apply pipeline.
 */
import { CANONICAL_TOKENS, type Style, type StyleManifest } from "./style-manifest.js";

/** localStorage key under which the JSON array of saved styles lives. */
export const LOCAL_STYLES_KEY = "galley.localStyles";

/** The fixed entry symbol every captured style is materialised against. */
const ENTRY = "doc";

/** A user-saved style: a captured `/style.typ` source under a chosen name. */
export interface LocalStyleEntry {
  /** Minted, stable id (e.g. `local-…`). Used as the catalog card key + manifest id. */
  id: string;
  /** Human-given name shown on the card. */
  name: string;
  /** The captured `/style.typ` source, verbatim. */
  text: string;
  /**
   * The semantic helpers this captured style provides — its top-level `#let`
   * exports MINUS the entry (`doc`) and the four palette tokens. Derived from
   * `text` at save time (see {@link deriveCapabilities}); persisted so a reload
   * negotiates without re-parsing. Sorted + deduped.
   */
  capabilities: string[];
}

/** The slice of `Storage` we use — injectable so tests pass a fake. */
export interface StyleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A reasonably-unique token: `crypto.randomUUID()` when available, else a fallback. */
function mintToken(): string {
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== "undefined"
      ? (globalThis.crypto as { randomUUID?: () => string } | undefined)
      : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const rand = () => Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}

// Top-level `#let <name> = …` / `#let <name>(...) = …` export. Anchored at line
// start (after optional indent) so a `let` nested in an expression body — which
// would not be a module-level export — is not mistaken for a provided helper.
// Names may contain hyphens (Typst identifiers), matching the import-list parser.
const LET_RE = /^[ \t]*#let\s+([A-Za-z_][\w-]*)/gm;

/**
 * Derive the capabilities a captured style PROVIDES: its top-level `#let`
 * exports minus the entry (`doc`) and the four canonical palette tokens. The
 * leftover exported symbols ARE the semantic helpers the style offers (the same
 * vocabulary `detectStyleability` records as a doc's `requiredCapabilities`).
 *
 * Conservative by construction: only line-anchored top-level `#let`s count, and
 * the entry + palette tokens are always excluded, so a vanilla appearance-only
 * style derives `[]` (it provides no helpers) and negotiates exactly like a
 * built-in. Result is sorted + deduped.
 */
export function deriveCapabilities(text: string): string[] {
  const excluded = new Set<string>([ENTRY, ...CANONICAL_TOKENS]);
  const found = new Set<string>();
  for (const m of text.matchAll(LET_RE)) {
    const name = m[1];
    if (name && !excluded.has(name)) found.add(name);
  }
  return [...found].sort();
}

/** Parse a stored value into a clean array of entries (drops anything malformed). */
function parseStored(raw: string | null): LocalStyleEntry[] {
  if (raw === null) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(v: unknown): v is LocalStyleEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.name === "string" &&
    typeof o.text === "string" &&
    Array.isArray(o.capabilities) &&
    o.capabilities.every((c) => typeof c === "string")
  );
}

/** Resolve a default storage (real `localStorage` in the browser, else null). */
function defaultStorage(): StyleStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw (e.g. privacy mode) — degrade to ephemeral.
  }
  return null;
}

function write(storage: StyleStorage | null, entries: LocalStyleEntry[]): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_STYLES_KEY, JSON.stringify(entries));
  } catch {
    // Persistence is best-effort; an unwritable store just makes it ephemeral.
  }
}

/** Load all saved styles (oldest-first, insertion order). Empty when absent/corrupt. */
export function loadLocalStyles(store?: StyleStorage): LocalStyleEntry[] {
  const storage = store ?? defaultStorage();
  return storage ? parseStored(storage.getItem(LOCAL_STYLES_KEY)) : [];
}

/**
 * Capture a `/style.typ` source under a name: mint an id, derive its
 * capabilities, append it to the store, and return the new entry. The name is
 * trimmed; the captured `text` is stored verbatim. Append-only (newest last) so
 * the picker's ordering is stable across saves.
 */
export function saveLocalStyle(
  store: StyleStorage | undefined,
  input: { name: string; text: string },
): LocalStyleEntry {
  const storage = store ?? defaultStorage();
  const entry: LocalStyleEntry = {
    id: `local-${mintToken()}`,
    name: input.name.trim(),
    text: input.text,
    capabilities: deriveCapabilities(input.text),
  };
  const next = [...loadLocalStyles(storage ?? undefined), entry];
  write(storage, next);
  return entry;
}

/** Delete a saved style by id. Returns the remaining entries. A no-op if absent. */
export function deleteLocalStyle(store: StyleStorage | undefined, id: string): LocalStyleEntry[] {
  const storage = store ?? defaultStorage();
  const next = loadLocalStyles(storage ?? undefined).filter((e) => e.id !== id);
  write(storage, next);
  return next;
}

/**
 * Materialise a saved entry into a real {@link Style}: a non-builtin module
 * declaring the canonical ABI (entry `doc`, palette tokens) plus the entry's
 * derived `capabilities`, with the captured source as its single `/style.typ`
 * file. PURE — the resulting `Style` flows through the unchanged
 * trial-compile/apply path exactly like a built-in.
 */
export function toStyle(entry: LocalStyleEntry): Style {
  const manifest: StyleManifest = {
    id: entry.id,
    name: entry.name,
    abiVersion: 1,
    entry: ENTRY,
    tokens: ["accent", "ink", "ink-soft", "rule"],
    capabilities: entry.capabilities,
    builtin: false,
  };
  return {
    manifest,
    files: [{ path: "/style.typ", text: entry.text }],
    entryFile: "/style.typ",
  };
}
