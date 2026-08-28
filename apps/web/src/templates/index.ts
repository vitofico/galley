/**
 * Project-template catalog (roadmap #2) — a bundled, offline, pure-built-in set
 * of multi-file PROJECT templates the user can instantiate into a fresh project.
 *
 * This generalizes the single-file `examples/` registry to whole projects: each
 * entry carries a `{ path, text }[]` file list and a `main` entry path, the same
 * shape the collab seed (`SeedFile[]` + main) and the compiler's `ProjectInput`
 * use. Every `.typ` source is imported as a raw string via Vite's `?raw` suffix
 * (typed by the ambient `*.typ?raw` module declaration), so the catalog ships as
 * plain strings with no extra fetch.
 *
 * OFFLINE-FIRST: none of these templates use `@preview` packages, so they all
 * compile in the fail-closed worker with no network and under the math-font-less
 * Node/e2e gate. `requiresPackages` is reserved for a LATER slice (package-backed
 * templates that route through the resolver); the bundled catalog leaves it
 * false/unset.
 */

// Article — two files: main + shared style.
import articleMain from "./article/main.typ?raw";
import articleStyle from "./article/style.typ?raw";

// Letter — a single self-contained file.
import letterMain from "./letter/main.typ?raw";

// Report — multi-file: main + style + three chapters under /chapters/.
import reportMain from "./report/main.typ?raw";
import reportStyle from "./report/style.typ?raw";
import reportIntro from "./report/chapters/introduction.typ?raw";
import reportMethods from "./report/chapters/methods.typ?raw";
import reportResults from "./report/chapters/results.typ?raw";

// CV — a single self-contained résumé.
import cvMain from "./cv/main.typ?raw";

// Problem set — two files: main + shared style with problem/solution helpers.
import problemSetMain from "./problem-set/main.typ?raw";
import problemSetStyle from "./problem-set/style.typ?raw";

// Meeting notes — a single self-contained memo with an action-item table.
import meetingNotesMain from "./meeting-notes/main.typ?raw";

// Einstein 1905 (#20.3 encore) — the "Annus Mirabilis" demo workspace, referenced
// from the demo module (single source of truth; zero content duplication). The
// template carries ONLY the live eight-file tree: instantiating it is the normal
// additive CRDT transaction (project-template.ts) and NEVER seeds version history
// — `DEMO_HISTORY` belongs exclusively to the first-boot seed path (#20.2).
import { DEMO_FILES, DEMO_MAIN } from "../demo/einstein-1905.js";

/** One file in a template's virtual project (absolute `/`-rooted path + source). */
export interface TemplateFile {
  path: string;
  text: string;
}

/**
 * A bundled multi-file project template. `files` are the virtual project's
 * sources; `main` is the entry file (must be one of `files[].path`). When
 * `requiresPackages` is true the template depends on `@preview` packages and
 * cannot compile fully offline — reserved for a later slice; the bundled catalog
 * keeps it unset.
 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  files: TemplateFile[];
  main: string;
  requiresPackages?: boolean;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "einstein-1905",
    name: "Einstein 1905 — demo workspace",
    description:
      "The flagship \"Annus Mirabilis\" showcase: Einstein's desk at the Bern patent office — four 1905 papers, real math (E = mc²), cross-file #includes, and a cited /refs.bib bibliography.",
    main: DEMO_MAIN,
    // The demo module's live tree, by reference — instantiation seeds these
    // files additively; it does NOT recreate the pre-dated 1905 history.
    files: DEMO_FILES,
  },
  {
    id: "article",
    name: "Article",
    description:
      "A scholarly two-file article: title block, abstract, numbered sections, real math, and a results table. Styling lives in /style.typ.",
    main: "/main.typ",
    files: [
      { path: "/main.typ", text: articleMain },
      { path: "/style.typ", text: articleStyle },
    ],
  },
  {
    id: "letter",
    name: "Formal letter",
    description:
      "A single-file formal letter: sender block, inside address, dated subject line, body, and signature. Edit the fields at the top.",
    main: "/main.typ",
    files: [{ path: "/main.typ", text: letterMain }],
  },
  {
    id: "report",
    name: "Technical report",
    description:
      "A multi-file report: cover page, table of contents, and three chapters #import-ed from /chapters/, with shared styling in /style.typ.",
    main: "/main.typ",
    files: [
      { path: "/main.typ", text: reportMain },
      { path: "/style.typ", text: reportStyle },
      { path: "/chapters/introduction.typ", text: reportIntro },
      { path: "/chapters/methods.typ", text: reportMethods },
      { path: "/chapters/results.typ", text: reportResults },
    ],
  },
  {
    id: "cv",
    name: "Curriculum vitae",
    description:
      "A single-file résumé: two-column header, ruled sections, and dated experience/education entries. Edit the field block at the top to make it yours.",
    main: "/main.typ",
    files: [{ path: "/main.typ", text: cvMain }],
  },
  {
    id: "problem-set",
    name: "Problem set",
    description:
      "A two-file homework set with auto-numbered problems, tinted solution blocks, and real math ($...$). The problem/solution helpers live in /style.typ.",
    main: "/main.typ",
    files: [
      { path: "/main.typ", text: problemSetMain },
      { path: "/style.typ", text: problemSetStyle },
    ],
  },
  {
    id: "meeting-notes",
    name: "Meeting notes",
    description:
      "A single-file memo: titled header strip, attendee/metadata grid, agenda, decisions, and an action-item table. Edit the field block to set the meeting.",
    main: "/main.typ",
    files: [{ path: "/main.typ", text: meetingNotesMain }],
  },
  // Blank (B8) — start from scratch. A no-op template (empty `files`) so
  // `instantiateTemplate` returns early (no seed, no merge): picking it just
  // leaves the project as-is / empty. Listed LAST so it never displaces the
  // flagship default highlight, and `main` is a placeholder that intentionally
  // does NOT exist in `files` (the only catalog entry exempt from the
  // "main exists in files" invariant — there is nothing to point at).
  {
    id: "blank",
    name: "Empty project",
    description: "Start from scratch with a blank project — add your own files and write from a clean page.",
    main: "/main.typ",
    files: [],
  },
];

/** The id of the no-op "start from scratch" template (B8). */
export const BLANK_TEMPLATE_ID = "blank";

/**
 * The id of the Einstein 1905 demo "New project from template" entry
 * (project-model redesign §5). Picking it creates a NEW project (with the 1905
 * version history) rather than overwriting the current one.
 */
export const EINSTEIN_TEMPLATE_ID = "einstein-1905";

/** Whether a template is the empty/no-op "start from scratch" entry (B8). */
export function isBlankTemplate(template: ProjectTemplate): boolean {
  return template.files.length === 0;
}

/** Look up a template by id (stable across the picker and the instantiation path). */
export function findTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}
