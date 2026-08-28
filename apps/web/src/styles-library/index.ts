/**
 * Built-in style catalog (Phase 1). Each style is an appearance-only Typst
 * module implementing the canonical ABI (`doc(...)` + the palette tokens accent
 * / ink / ink-soft / rule). Sources are imported as raw strings via Vite's
 * `?raw` suffix (typed by the ambient `*.typ?raw` declaration), mirroring the
 * templates catalog. All three compile fully offline (built-in fonts only).
 */
import type { Style, StyleManifest } from "../style-manifest.js";
import academicStyle from "./academic/style.typ?raw";
import modernStyle from "./modern/style.typ?raw";
import minimalStyle from "./minimal/style.typ?raw";
import journalStyle from "./journal/style.typ?raw";

const TOKENS = ["accent", "ink", "ink-soft", "rule"] as const;
// The built-ins are generic, appearance-only styles: they provide no semantic
// helpers beyond the base ABI, so they declare no capabilities. A doc requiring
// helpers (e.g. `fig`) can only swap to a style that lists them.
function manifest(id: string, name: string, description: string): StyleManifest {
  return { id, name, description, abiVersion: 1, entry: "doc", tokens: TOKENS, capabilities: [], builtin: true };
}

export const BUILT_IN_STYLES: Style[] = [
  {
    manifest: manifest(
      "academic",
      "Academic",
      "Serif, justified body with numbered headings and a centered title block.",
    ),
    files: [{ path: "/style.typ", text: academicStyle }],
    entryFile: "/style.typ",
  },
  {
    manifest: manifest(
      "modern",
      "Modern",
      "Airy layout with large accent-colored headings and a tinted abstract card.",
    ),
    files: [{ path: "/style.typ", text: modernStyle }],
    entryFile: "/style.typ",
  },
  {
    manifest: manifest(
      "minimal",
      "Minimal",
      "Restrained, rule-free layout with a tight neutral palette.",
    ),
    files: [{ path: "/style.typ", text: minimalStyle }],
    entryFile: "/style.typ",
  },
  {
    manifest: manifest(
      "journal",
      "Journal",
      "Two-column biomedical-journal format with a small-caps masthead and a structured abstract.",
    ),
    files: [{ path: "/style.typ", text: journalStyle }],
    entryFile: "/style.typ",
  },
];

export function findStyle(id: string): Style | undefined {
  return BUILT_IN_STYLES.find((s) => s.manifest.id === id);
}
