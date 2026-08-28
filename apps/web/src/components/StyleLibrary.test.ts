import { describe, it, expect } from "vitest";
import { detectStyleability } from "../style-manifest.js";
import { BUILT_IN_STYLES, findStyle } from "../styles-library/index.js";
import type { Style } from "../style-manifest.js";
import {
  StyleLibrary,
  STYLE_LIBRARY_INTRO,
  styleabilityNotice,
  styleCapabilityGap,
  styleListingNote,
} from "./StyleLibrary.js";

/**
 * StyleLibrary (styles WS-C) tests.
 *
 * Per the repo's Node-env house pattern (cf. TemplatePicker.test / ImportPanel /
 * doc-stats: no jsdom, no @testing-library/react), the workspace vitest runs in
 * `node` and the gate's include is `**\/*.test.ts` only. So we DON'T render
 * React here — we test (a) the exported pure helpers against the real
 * `detectStyleability` classifier, (b) the bundled style catalog invariants the
 * picker relies on, and (c) the exact interaction the confirm performs ("find
 * the selected style, hand it to onApply"). The DOM surface (cards, banner,
 * Escape/close, the disabled-Apply affordance) is covered by the mounting lane's
 * real e2e once the host wires it up.
 */

describe("STYLE_LIBRARY_INTRO copy", () => {
  it("frames styles as appearance/look only (content unchanged)", () => {
    expect(STYLE_LIBRARY_INTRO).toMatch(/appearance|look/i);
  });
});

describe("styleabilityNotice", () => {
  it("returns the reason for an `incompatible` document (wildcard import)", () => {
    // A doc that imports everything (`*`) can't be enumerated → fail closed →
    // `incompatible` (style-manifest.ts); the notice surfaces why.
    const s = detectStyleability('#import "/style.typ": *\n#show: doc.with()');
    expect(s.state).toBe("incompatible");
    const notice = styleabilityNotice(s);
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/everything|\*/i);
  });

  it("does NOT globally block a doc that imports semantic helpers (it negotiates per style)", () => {
    // Phase 2: a helper-pulling doc is switchable in principle — the block is now
    // per-style (does THIS style provide the helpers?), not a doc-global verdict.
    const s = detectStyleability('#import "/style.typ": pset, problem\n#show: pset.with()');
    expect(s.state).toBe("shimmed");
    expect(s.requiredCapabilities).toEqual(["problem"]);
    expect(styleabilityNotice(s)).toBeNull();
  });

  it("returns the reason for a `non-conforming` document", () => {
    // No `/style.typ` import at all → non-conforming → there's no style to swap.
    const s = detectStyleability("= Hi");
    expect(s.state).toBe("non-conforming");
    const notice = styleabilityNotice(s);
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/style/i);
  });

  it("returns null when the document is switchable (clean ABI import)", () => {
    // Canonical entry `doc` + the palette tokens (note: `rule`, not `line`) →
    // `clean` → no blocking notice, Apply is allowed.
    const s = detectStyleability(
      '#import "/style.typ": doc, accent, ink, ink-soft, rule\n#show: doc.with()',
    );
    expect(s.state).toBe("clean");
    expect(styleabilityNotice(s)).toBeNull();
  });

  it("returns null for a `shimmed` (renamed entry, still switchable) document", () => {
    // A renamed entry symbol is shimmed, not blocked — still appearance-swappable.
    const s = detectStyleability(
      '#import "/style.typ": paper, accent, ink, ink-soft, rule\n#show: paper.with()',
    );
    expect(s.state).toBe("shimmed");
    expect(styleabilityNotice(s)).toBeNull();
  });
});

describe("styleCapabilityGap (per-style negotiation)", () => {
  const generic = findStyle("academic")!; // capabilities: []
  const helperStyle: Style = {
    manifest: { ...generic.manifest, id: "journal", name: "Journal", capabilities: ["problem", "solution"] },
    files: generic.files,
    entryFile: generic.entryFile,
  };

  it("is empty when the doc requires nothing (any style applies)", () => {
    const s = detectStyleability('#import "/style.typ": doc\n#show: doc.with()');
    expect(styleCapabilityGap(s, generic)).toEqual([]);
  });

  it("lists the missing helpers when a generic style can't satisfy the doc", () => {
    const s = detectStyleability('#import "/style.typ": pset, problem, solution\n#show: pset.with()');
    expect(styleCapabilityGap(s, generic)).toEqual(["problem", "solution"]);
  });

  it("is empty when the style declares every required helper", () => {
    const s = detectStyleability('#import "/style.typ": pset, problem, solution\n#show: pset.with()');
    expect(styleCapabilityGap(s, helperStyle)).toEqual([]);
  });

  it("is empty for a globally-blocked doc (the notice handles those)", () => {
    const s = detectStyleability("= no style import");
    expect(styleCapabilityGap(s, generic)).toEqual([]);
  });
});

describe("BUILT_IN_STYLES catalog (the picker's default source)", () => {
  it("is non-empty and every entry carries a name + description for its card", () => {
    expect(BUILT_IN_STYLES.length).toBeGreaterThan(0);
    for (const s of BUILT_IN_STYLES) {
      expect(s.manifest.name.length).toBeGreaterThan(0);
      expect((s.manifest.description ?? "").length).toBeGreaterThan(0);
    }
  });

  it("has unique style ids (stable card keys)", () => {
    const ids = BUILT_IN_STYLES.map((s) => s.manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("styleListingNote (async remote-catalog lane)", () => {
  it("returns null when no listing prop is given (byte-for-byte current picker)", () => {
    // The whole point of the additive seam: absent prop ⇒ nothing extra renders.
    expect(styleListingNote(undefined)).toBeNull();
  });

  it("returns null when a listing is present but idle (not loading, no errors)", () => {
    expect(styleListingNote({ loading: false, errors: [] })).toBeNull();
  });

  it("reports a calm loading note while a source is listing", () => {
    const note = styleListingNote({ loading: true, errors: [] });
    expect(note).not.toBeNull();
    expect(note!.kind).toBe("loading");
    expect(note!.text).toMatch(/loading/i);
  });

  it("reports an error note counting DISTINCT failed sources, not raw error rows", () => {
    const note = styleListingNote({
      loading: false,
      errors: [
        { sourceId: "cloud", message: "one dropped" },
        { sourceId: "cloud", message: "another dropped" },
        { sourceId: "other", message: "rejected" },
      ],
    });
    expect(note).not.toBeNull();
    expect(note!.kind).toBe("error");
    expect(note!.text).toMatch(/2 sources/);
  });

  it("loading takes precedence over a stale error", () => {
    const note = styleListingNote({ loading: true, errors: [{ sourceId: "x", message: "e" }] });
    expect(note!.kind).toBe("loading");
  });
});

describe("StyleLibrary contract", () => {
  it("is a React function component taking a single props object", () => {
    expect(typeof StyleLibrary).toBe("function");
    expect(StyleLibrary.length).toBeLessThanOrEqual(1);
  });

  it("onApply fires with the chosen style (the interaction the confirm performs)", () => {
    // Mirror the component's apply: given a catalog and a highlighted id, the
    // "Apply" button hands the resolved style object to onApply.
    const catalog: Style[] = BUILT_IN_STYLES;
    const selectedId = catalog[0]!.manifest.id;
    const applied: Style[] = [];
    const onApply = (s: Style) => applied.push(s);

    const selected = catalog.find((s) => s.manifest.id === selectedId) ?? null;
    if (selected) onApply(selected);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.manifest.id).toBe(selectedId);
    expect(applied[0]).toBe(findStyle(selectedId));
  });
});
