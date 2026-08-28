/**
 * Async, pluggable style-catalog seam (styles Phase 2 — cloud enabler). PURE, no
 * React, no DOM, no worker.
 *
 * Galley's style library is normally two catalogs: the bundled {@link
 * BUILT_IN_STYLES} and the user's {@link ../local-styles.js | saved styles}. This
 * module adds a THIRD, ASYNC lane: an external/hosted catalog can register a
 * {@link StyleSource} and have its styles APPEND to the picker — without Galley
 * ever referencing that source. Dependency inversion: the source implements a
 * tiny transport contract ({@link StyleDescriptor} in, `Promise` out); a hosted
 * consumer mirrors the SAME shapes as plain data, so the two repos share a
 * contract, not a dependency.
 *
 * This is the async analog of `local-styles.ts`: where a local entry
 * materialises via `toStyle`, a remote {@link StyleDescriptor} materialises via
 * {@link descriptorToStyle}. Because descriptors are UNTRUSTED remote data, every
 * field is validated/sanitised before it becomes a `Style` (see {@link
 * checkDescriptor}); an invalid descriptor is DROPPED with a recorded reason,
 * never thrown.
 *
 * Additive by construction: with NO source registered the registry is empty,
 * {@link collectFromSources} does zero async work, and the picker renders
 * byte-for-byte as today.
 */
import type { Style, StyleManifest } from "./style-manifest.js";
import { deriveCapabilities } from "./local-styles.js";

/**
 * The transport shape a style source emits (mirrored, as data, by any external
 * catalog — e.g. a hosted styles repo). `source` is the full `/style.typ` text.
 * Everything but `id`/`name`/`source` is optional; `capabilities` absent ⇒ they
 * are DERIVED from `source` at materialisation (like a saved local style).
 *
 * THIS TYPE IS THE CROSS-REPO HANDSHAKE — an external producer mirrors it
 * verbatim as plain data. Do not add required fields without versioning the seam.
 */
export interface StyleDescriptor {
  id: string;
  name: string;
  source: string;
  capabilities?: readonly string[];
  tags?: readonly string[];
  description?: string;
}

/**
 * A pluggable, async style catalog. `id` namespaces every style it produces (so
 * two sources never collide) and keys it in the registry (re-registering the
 * same id replaces). `list()` returns the FULL descriptors — catalogs are small,
 * so there is no separate fetch-by-id in this version.
 */
export interface StyleSource {
  id: string;
  label: string;
  list(): Promise<readonly StyleDescriptor[]>;
}

/** A per-source problem surfaced to the UI: a rejected `list()` or a dropped descriptor. */
export interface RemoteStyleError {
  sourceId: string;
  message: string;
}

// ── Validation caps (untrusted remote data) ────────────────────────────────
// Generous but bounded: a hostile source can neither exhaust memory nor smuggle
// control chars into the picker. All are exported so tests pin the exact bounds.

/** Max chars kept from a descriptor id (it becomes a namespaced manifest id + card key). */
export const MAX_ID_LEN = 128;
/** Max chars kept from a style name (the card title). */
export const MAX_NAME_LEN = 200;
/** Max chars kept from a style description (the card subtitle). */
export const MAX_DESCRIPTION_LEN = 500;
/** Max chars kept from a single tag. */
export const MAX_TAG_LEN = 64;
/** Max tags kept per descriptor (extras dropped). */
export const MAX_TAGS = 32;
/** Max declared capabilities kept per descriptor (extras dropped). */
export const MAX_CAPABILITIES = 128;
/** Max UTF-8 byte size of a `/style.typ` source; a larger descriptor is dropped. */
export const MAX_SOURCE_BYTES = 256 * 1024; // 256 KiB
/** Max descriptors processed from one source's `list()` (the remainder is dropped). */
export const MAX_DESCRIPTORS_PER_SOURCE = 500;

/** ASCII control chars (0x00–0x1f) + DEL (0x7f) — stripped from every text field. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * The capability-id charset: a Typst symbol name, the SAME vocabulary the
 * import-list parser (`style-manifest.ts`) and `deriveCapabilities`
 * (`local-styles.ts`) already use — `[A-Za-z_]` then word chars / hyphens. A
 * capability id that does not match cannot be a real exported helper, so it is
 * dropped (which only ever NARROWS what a style claims — the safe direction).
 */
const CAPABILITY_ID_RE = /^[A-Za-z_][\w-]*$/;

/** The namespace prefix for every remote style's manifest id: `source:<sourceId>:<id>`. */
export const SOURCE_ID_PREFIX = "source";

/** Strip control chars, collapse whitespace runs, trim, and cap length. */
function cleanText(v: unknown, cap: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().slice(0, cap);
}

/**
 * True iff the UTF-8 byte size exceeds {@link MAX_SOURCE_BYTES}. Fast-rejects a
 * pathologically long string on code-unit count (UTF-8 bytes ≥ UTF-16 code
 * units always) before ever encoding it.
 */
function overSourceCap(source: string): boolean {
  if (source.length > MAX_SOURCE_BYTES) return true;
  return new TextEncoder().encode(source).length > MAX_SOURCE_BYTES;
}

/** Sanitise a capabilities field: keep only valid Typst symbol ids, dedupe, sort, cap. */
function sanitizeCapabilities(v: unknown): readonly string[] | undefined {
  if (v === undefined) return undefined; // absent ⇒ derive from source later
  if (!Array.isArray(v)) return []; // present-but-malformed ⇒ claims nothing (safe)
  const valid = v.filter((c): c is string => typeof c === "string" && CAPABILITY_ID_RE.test(c));
  return [...new Set(valid)].sort().slice(0, MAX_CAPABILITIES);
}

/** Sanitise a tags field: clean each tag, drop empties, dedupe, cap count. */
function sanitizeTags(v: unknown): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const clean = v
    .map((t) => cleanText(t, MAX_TAG_LEN))
    .filter((t) => t.length > 0);
  const deduped = [...new Set(clean)].slice(0, MAX_TAGS);
  return deduped.length > 0 ? deduped : undefined;
}

/** The outcome of validating one untrusted descriptor. */
export type DescriptorCheck =
  | { ok: true; descriptor: StyleDescriptor }
  | { ok: false; reason: string };

/**
 * Validate + sanitise an untrusted descriptor. Structural failures (not an
 * object, empty id/name, non-string or oversized source) DROP the descriptor
 * with a reason. Cosmetic fields (id/name/description/tags) are sanitised in
 * place; `capabilities` are filtered to valid ids. Never throws.
 */
export function checkDescriptor(raw: unknown): DescriptorCheck {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "descriptor is not an object" };
  }
  const o = raw as Record<string, unknown>;
  const id = cleanText(o.id, MAX_ID_LEN);
  if (id.length === 0) return { ok: false, reason: "descriptor has no usable id" };
  const name = cleanText(o.name, MAX_NAME_LEN);
  if (name.length === 0) return { ok: false, reason: `descriptor ${id} has no usable name` };
  if (typeof o.source !== "string") {
    return { ok: false, reason: `descriptor ${id} has no source text` };
  }
  if (overSourceCap(o.source)) {
    return { ok: false, reason: `descriptor ${id} source exceeds ${MAX_SOURCE_BYTES} bytes` };
  }
  const descriptor: StyleDescriptor = { id, name, source: o.source };
  const capabilities = sanitizeCapabilities(o.capabilities);
  if (capabilities !== undefined) descriptor.capabilities = capabilities;
  const tags = sanitizeTags(o.tags);
  if (tags !== undefined) descriptor.tags = tags;
  const description = cleanText(o.description, MAX_DESCRIPTION_LEN);
  if (description.length > 0) descriptor.description = description;
  return { ok: true, descriptor };
}

/**
 * The namespaced manifest id for a remote style: `source:<sourceId>:<id>`. The
 * colon-delimited prefix cannot collide with a bundled id (bare slug) or a saved
 * local id (`local-…`), so remote styles never shadow either.
 */
export function namespacedId(sourceId: string, descriptorId: string): string {
  return `${SOURCE_ID_PREFIX}:${sourceId}:${descriptorId}`;
}

/**
 * Materialise a validated descriptor into a real {@link Style}, the async analog
 * of `local-styles.toStyle`: a non-builtin module declaring the canonical ABI
 * (entry `doc`, the four palette tokens) plus capabilities — the descriptor's
 * own when provided, else DERIVED from its source. The manifest id is namespaced
 * by `sourceId`. PURE — the result flows through the unchanged trial-compile /
 * apply path exactly like a built-in or saved style.
 */
export function descriptorToStyle(d: StyleDescriptor, sourceId: string): Style {
  const capabilities = d.capabilities ?? deriveCapabilities(d.source);
  const manifest: StyleManifest = {
    id: namespacedId(sourceId, d.id),
    name: d.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    abiVersion: 1,
    entry: "doc",
    tokens: ["accent", "ink", "ink-soft", "rule"],
    capabilities,
    builtin: false,
  };
  return {
    manifest,
    files: [{ path: "/style.typ", text: d.source }],
    entryFile: "/style.typ",
  };
}

/**
 * Validate + materialise a source's raw `list()` payload into styles, recording
 * a per-source drop for every rejected/duplicate/over-cap descriptor. A
 * non-array payload yields zero styles + one drop. Deduplicates by materialised
 * id (first wins). Never throws.
 */
export function materializeDescriptors(
  sourceId: string,
  raw: unknown,
): { styles: Style[]; drops: RemoteStyleError[] } {
  const styles: Style[] = [];
  const drops: RemoteStyleError[] = [];
  if (!Array.isArray(raw)) {
    return { styles, drops: [{ sourceId, message: "source did not return a list" }] };
  }
  const seen = new Set<string>();
  const list = raw.slice(0, MAX_DESCRIPTORS_PER_SOURCE);
  if (raw.length > MAX_DESCRIPTORS_PER_SOURCE) {
    drops.push({ sourceId, message: `catalog truncated to ${MAX_DESCRIPTORS_PER_SOURCE} styles` });
  }
  for (const item of list) {
    const check = checkDescriptor(item);
    if (!check.ok) {
      drops.push({ sourceId, message: check.reason });
      continue;
    }
    const style = descriptorToStyle(check.descriptor, sourceId);
    if (seen.has(style.manifest.id)) {
      drops.push({ sourceId, message: `duplicate style id ${check.descriptor.id} skipped` });
      continue;
    }
    seen.add(style.manifest.id);
    styles.push(style);
  }
  return { styles, drops };
}

// ── Module-scope registry (mirrors control-responder-mount's singleton) ──────
// Default EMPTY. Keyed by source id, so re-registering an id replaces it and the
// insertion order is preserved.

const registry = new Map<string, StyleSource>();

/** Register (or replace, by id) a style source. */
export function registerStyleSource(src: StyleSource): void {
  registry.set(src.id, src);
}

/** Unregister a style source by id. A no-op if absent. */
export function unregisterStyleSource(id: string): void {
  registry.delete(id);
}

/** All registered sources, in registration order. Empty by default. */
export function listStyleSources(): StyleSource[] {
  return [...registry.values()];
}

/** Test-only: drop every registered source so a test starts from a clean module state. */
export function __resetStyleSourcesForTests(): void {
  registry.clear();
}

/** Turn an unknown thrown value into a stable, readable message. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return "style source failed to load";
}

/**
 * List every given source concurrently and fold the results into one deduped
 * catalog + a flat error list. The async ENGINE behind {@link
 * useStyleSources} — extracted here so it is unit-testable in the Node gate
 * without a DOM.
 *
 * Isolation: `Promise.allSettled` means one rejecting/throwing source never
 * hides another. A rejection settles to a STABLE {@link RemoteStyleError}
 * (never a perpetual pending). ZERO sources ⇒ resolves immediately-empty having
 * awaited nothing (the byte-for-byte guarantee). Cross-source dedup by
 * materialised id (first wins) is belt-and-suspenders — namespacing already
 * prevents collisions between distinct sources.
 */
export async function collectFromSources(
  sources: readonly StyleSource[],
): Promise<{ remoteStyles: Style[]; errors: RemoteStyleError[] }> {
  if (sources.length === 0) return { remoteStyles: [], errors: [] };
  const settled = await Promise.allSettled(
    sources.map(async (src) => {
      const raw = await src.list();
      return materializeDescriptors(src.id, raw);
    }),
  );
  const remoteStyles: Style[] = [];
  const errors: RemoteStyleError[] = [];
  const seen = new Set<string>();
  sources.forEach((src, i) => {
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      for (const style of result.value.styles) {
        if (seen.has(style.manifest.id)) continue;
        seen.add(style.manifest.id);
        remoteStyles.push(style);
      }
      errors.push(...result.value.drops);
    } else {
      errors.push({ sourceId: src.id, message: errorMessage(result.reason) });
    }
  });
  return { remoteStyles, errors };
}
