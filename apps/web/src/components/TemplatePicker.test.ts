import { describe, it, expect } from "vitest";
import { CollabProject } from "@galley/collab";
import type { Author } from "@galley/shared";
import { PROJECT_TEMPLATES, findTemplate, isBlankTemplate, BLANK_TEMPLATE_ID } from "../templates/index.js";
import type { ProjectTemplate } from "../templates/index.js";
import { DEMO_FILES, DEMO_MAIN } from "../demo/einstein-1905.js";
import { IdbVersionStore } from "../idb-version-store.js";
import { InMemoryKeyValueBackend } from "../idb-project-store.js";
import { instantiateTemplate } from "../project-template.js";
import {
  TemplatePicker,
  fileCountLabel,
  requiresPackages,
  TEMPLATE_UNIVERSE_INTRO,
  REQUIRES_PACKAGES_BADGE,
  REQUIRES_PACKAGES_HINT,
} from "./TemplatePicker.js";

/**
 * TemplatePicker (#2) tests.
 *
 * Per the repo's Node-env house pattern (cf. ImportPanel/HistoryPanel/doc-stats:
 * no jsdom, no @testing-library/react), the workspace vitest runs in `node` and
 * the gate's include is `**\/*.test.ts` only. So we DON'T render React here — we
 * test (a) the bundled catalog's invariants, (b) the exported pure helpers, and
 * (c) the exact injected interaction the component performs: "find the selected
 * template, hand it to onPick". The DOM-level surface (cards, the data-testids,
 * Escape/close) is covered by the mounting lane's real e2e once Lane F mounts it.
 */

describe("PROJECT_TEMPLATES catalog (#2)", () => {
  it("is non-empty", () => {
    expect(PROJECT_TEMPLATES.length).toBeGreaterThan(0);
  });

  it("exposes the bundled showcases with stable ids in catalog order", () => {
    // The flagship "Annus Mirabilis" encore (#20.3) leads the catalog — it is
    // the picker's default highlight — followed by the original six.
    expect(PROJECT_TEMPLATES.map((t) => t.id)).toEqual([
      "einstein-1905",
      "article",
      "letter",
      "report",
      "cv",
      "problem-set",
      "meeting-notes",
      // The blank "start from scratch" entry (B8) is always LAST so it never
      // displaces the flagship default highlight.
      "blank",
    ]);
  });

  it("has unique ids", () => {
    const ids = PROJECT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template's main exists in its files (except the blank/no-op entry)", () => {
    for (const t of PROJECT_TEMPLATES) {
      // The blank "start from scratch" entry (B8) has NO files, so its `main` is a
      // placeholder with nothing to point at — exempt by design.
      if (isBlankTemplate(t)) {
        expect(t.files.length).toBe(0);
        continue;
      }
      expect(t.files.some((f) => f.path === t.main)).toBe(true);
    }
  });

  it("every template has a name and a description; only the blank entry may have zero files", () => {
    for (const t of PROJECT_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      if (!isBlankTemplate(t)) expect(t.files.length).toBeGreaterThan(0);
    }
  });

  it("every file has an absolute path and non-empty source text", () => {
    for (const t of PROJECT_TEMPLATES) {
      for (const f of t.files) {
        expect(f.path.startsWith("/")).toBe(true);
        expect(f.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("file paths are unique within each template", () => {
    for (const t of PROJECT_TEMPLATES) {
      const paths = t.files.map((f) => f.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });

  it("is purely built-in: no template uses an @preview package or sets requiresPackages", () => {
    // The offline/fail-closed gate depends on this — a `@preview` import would
    // need the package resolver (a later slice) and would break the offline gate.
    // Match real package imports (`#import "@preview/..."`), not prose — the
    // Einstein demo's header comments legitimately *mention* the constraint
    // (same pattern as einstein-1905.compile.test.ts).
    for (const t of PROJECT_TEMPLATES) {
      expect(t.requiresPackages ?? false).toBe(false);
      for (const f of t.files) {
        expect(f.text, `${t.id}:${f.path} must not import @preview packages`).not.toMatch(
          /import\s+"@preview/,
        );
      }
    }
  });

  it("the report template is genuinely multi-file and #imports a chapter", () => {
    const report = findTemplate("report");
    expect(report).toBeDefined();
    expect(report!.files.length).toBeGreaterThan(1);
    const main = report!.files.find((f) => f.path === report!.main)!;
    expect(main.text).toContain('#import "/chapters/');
    // The imported chapter files it references must actually exist.
    expect(report!.files.some((f) => f.path.startsWith("/chapters/"))).toBe(true);
  });
});

describe("blank template (B8)", () => {
  const HUMAN: Author = { kind: "human", userId: "me" };

  it("is bundled, last, and identifiable as the no-op start-from-scratch entry", () => {
    const blank = findTemplate(BLANK_TEMPLATE_ID);
    expect(blank).toBeDefined();
    expect(blank!.files).toEqual([]);
    expect(isBlankTemplate(blank!)).toBe(true);
    // Listed last so it never displaces the flagship default highlight.
    expect(PROJECT_TEMPLATES[PROJECT_TEMPLATES.length - 1]!.id).toBe(BLANK_TEMPLATE_ID);
  });

  it("labels its meta as 'Empty project' rather than a bare '0 files'", () => {
    expect(fileCountLabel(findTemplate(BLANK_TEMPLATE_ID)!)).toBe("Empty project");
  });

  it("does not require packages (it instantiates offline as a no-op)", () => {
    expect(requiresPackages(findTemplate(BLANK_TEMPLATE_ID)!)).toBe(false);
  });

  it("instantiating it on a pristine project is a no-op (leaves it empty)", () => {
    const p = new CollabProject();
    instantiateTemplate(p, findTemplate(BLANK_TEMPLATE_ID)!, HUMAN);
    expect(p.snapshot().files.filter((f) => !f.deleted)).toEqual([]);
    expect(p.mainFileId()).toBeNull();
  });

  it("instantiating it on a NON-empty project leaves the user's files untouched", () => {
    const p = new CollabProject();
    p.seedIfPristine([{ path: "/mine.typ", text: "hi" }], "/mine.typ", HUMAN);
    instantiateTemplate(p, findTemplate(BLANK_TEMPLATE_ID)!, HUMAN);
    const live = p.snapshot().files.filter((f) => !f.deleted);
    expect(live.map((f) => f.path)).toEqual(["/mine.typ"]);
  });
});

describe("Einstein 1905 template encore (#20.3)", () => {
  const flagship = () => findTemplate("einstein-1905")!;
  const HUMAN: Author = { kind: "human", userId: "me" };

  it("references the demo module by identity — zero content duplication", () => {
    // The catalog entry IS the demo module's live tree (same array/object
    // references), so the demo compile gate (einstein-1905.compile.test.ts)
    // is authoritative for this template too — no copied sources to drift.
    expect(flagship().files).toBe(DEMO_FILES);
    expect(flagship().main).toBe(DEMO_MAIN);
  });

  it("carries the styleable desk and instantiates offline (no packages)", () => {
    // Eight files: the desk plus the swappable `/style.typ` (styles Phase 1.5).
    expect(flagship().files).toHaveLength(8);
    expect(flagship().files.map((f) => f.path)).toContain("/refs.bib");
    expect(flagship().files.map((f) => f.path)).toContain("/style.typ");
    expect(requiresPackages(flagship())).toBe(false);
  });

  it("instantiation seeds the files as a normal template transaction and NEVER touches the version store", async () => {
    // The spec pin (§5): the template encore does NOT seed history. Pre-dated
    // 1905 versions belong exclusively to the first-boot seed path (#20.2,
    // seedDemoHistory). Instantiate the flagship template into a fresh project
    // alongside a real (in-memory) version store and prove the store stays
    // empty — instantiateTemplate has no history-seeding seam at all.
    const store = new IdbVersionStore({ backend: new InMemoryKeyValueBackend() });
    const project = new CollabProject();

    instantiateTemplate(project, flagship(), HUMAN);

    const live = project.snapshot().files.filter((f) => !f.deleted);
    expect(live.map((f) => f.path).sort()).toEqual(DEMO_FILES.map((f) => f.path).sort());

    // No version rows for ANY project id this store could have been keyed by.
    expect(await store.listVersions("project")).toEqual([]);
    expect(await store.listVersions(project.doc.guid)).toEqual([]);
  });

  it("instantiating into a NON-pristine project is additive and still seeds no history", async () => {
    const store = new IdbVersionStore({ backend: new InMemoryKeyValueBackend() });
    const project = new CollabProject();
    // Make the doc non-pristine first (the additive-merge path, not the seed path).
    project.create("/notes.typ", "= My notes\n", HUMAN);

    instantiateTemplate(project, flagship(), HUMAN);

    const live = project.snapshot().files.filter((f) => !f.deleted);
    const paths = live.map((f) => f.path).sort();
    // Pre-existing file untouched; the seven demo files merged in additively.
    expect(paths).toEqual([...DEMO_FILES.map((f) => f.path), "/notes.typ"].sort());
    expect(await store.listVersions(project.doc.guid)).toEqual([]);
  });
});

describe("findTemplate (#2)", () => {
  it("resolves a known id and returns undefined for an unknown one", () => {
    expect(findTemplate("article")?.id).toBe("article");
    expect(findTemplate("nope")).toBeUndefined();
  });
});

describe("fileCountLabel (#2)", () => {
  it("singularizes a one-file template", () => {
    const t: ProjectTemplate = { id: "x", name: "X", description: "d", main: "/m.typ", files: [{ path: "/m.typ", text: "a" }] };
    expect(fileCountLabel(t)).toBe("1 file");
  });

  it("pluralizes a multi-file template", () => {
    expect(fileCountLabel(findTemplate("report")!)).toMatch(/^\d+ files$/);
  });
});

describe("requiresPackages badge logic (#2)", () => {
  it("is false for every bundled template (they all instantiate offline)", () => {
    for (const t of PROJECT_TEMPLATES) {
      expect(requiresPackages(t)).toBe(false);
    }
  });

  it("treats an unset field as false (the badge default)", () => {
    const t: ProjectTemplate = {
      id: "x",
      name: "X",
      description: "d",
      main: "/m.typ",
      files: [{ path: "/m.typ", text: "a" }],
    };
    expect(t.requiresPackages).toBeUndefined();
    expect(requiresPackages(t)).toBe(false);
  });

  it("is true only when a template explicitly opts in (future server-backed slice)", () => {
    const t: ProjectTemplate = {
      id: "pkg",
      name: "Package-backed",
      description: "d",
      main: "/m.typ",
      files: [{ path: "/m.typ", text: 'a' }],
      requiresPackages: true,
    };
    expect(requiresPackages(t)).toBe(true);
  });
});

describe("Typst Universe discoverability copy (UX-1)", () => {
  it("intro explains the bundled-vs-Universe split and where to enable a server compiler", () => {
    expect(TEMPLATE_UNIVERSE_INTRO).toMatch(/Typst Universe/);
    expect(TEMPLATE_UNIVERSE_INTRO).toMatch(/server compiler/);
    // Points the user at the place to turn it on (worded, not a route string).
    expect(TEMPLATE_UNIVERSE_INTRO).toMatch(/Settings → Compile/);
    // And is honest that the bundled/Local-only path stays offline.
    expect(TEMPLATE_UNIVERSE_INTRO).toMatch(/offline/i);
  });

  it("the package badge is short and reads as a Universe affordance, not a dead state", () => {
    expect(REQUIRES_PACKAGES_BADGE).toBe("Universe packages");
    // No defeatist 'can't' / 'yet' phrasing in the visible chip.
    expect(REQUIRES_PACKAGES_BADGE).not.toMatch(/can't|cannot|yet/i);
  });

  it("the badge tooltip/aria is actionable: enable a server compiler in Settings → Compile", () => {
    expect(REQUIRES_PACKAGES_HINT).toMatch(/@preview/);
    expect(REQUIRES_PACKAGES_HINT).toMatch(/enable a server compiler/i);
    expect(REQUIRES_PACKAGES_HINT).toMatch(/Settings → Compile/);
    // The old dead-end phrasing is gone.
    expect(REQUIRES_PACKAGES_HINT).not.toMatch(/can't be built offline yet/i);
  });
});

describe("TemplatePicker contract (#2)", () => {
  it("is a React function component taking a single props object", () => {
    expect(typeof TemplatePicker).toBe("function");
    expect(TemplatePicker.length).toBeLessThanOrEqual(1);
  });

  it("onPick fires with the chosen template (the interaction the confirm performs)", () => {
    // Mirror the component's pick: given a catalog and a highlighted id, the
    // "Use template" button hands the resolved template object to onPick.
    const catalog = PROJECT_TEMPLATES;
    const selectedId = "letter";
    const picked: ProjectTemplate[] = [];
    const onPick = (t: ProjectTemplate) => picked.push(t);

    const selected = catalog.find((t) => t.id === selectedId) ?? null;
    if (selected) onPick(selected);

    expect(picked).toHaveLength(1);
    expect(picked[0]!.id).toBe("letter");
    expect(picked[0]!.main).toBe("/main.typ");
    expect(picked[0]).toBe(findTemplate("letter"));
  });
});
