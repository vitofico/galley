import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Unit tests for the dark "press" theme controller (#11.6).
 *
 * The Vitest environment is `node` (no DOM), so the DOM-edge functions are
 * exercised against minimal injected roots / storage / document doubles. The
 * critical invariant — importing the module performs ZERO DOM mutation and does
 * NOT read prefers-color-scheme — is asserted directly.
 */

// A minimal stand-in for an element's attribute surface.
function makeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: vi.fn((name: string, value: string) => {
      attrs.set(name, value);
    }),
    removeAttribute: vi.fn((name: string) => {
      attrs.delete(name);
    }),
    getAttribute: (name: string) => (attrs.has(name) ? attrs.get(name)! : null),
  };
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => (map.has(k) ? map.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
    _map: map,
  };
}

describe("resolveInitialTheme (pure)", () => {
  it("a valid stored 'light' wins over prefersDark", async () => {
    const { resolveInitialTheme } = await import("./theme.js");
    expect(resolveInitialTheme({ stored: "light", prefersDark: true })).toBe("light");
  });

  it("a valid stored 'dark' wins over a light OS preference", async () => {
    const { resolveInitialTheme } = await import("./theme.js");
    expect(resolveInitialTheme({ stored: "dark", prefersDark: false })).toBe("dark");
  });

  it("falls back to dark when nothing stored and OS prefers dark", async () => {
    const { resolveInitialTheme } = await import("./theme.js");
    expect(resolveInitialTheme({ stored: null, prefersDark: true })).toBe("dark");
  });

  it("falls back to light when nothing stored and OS does not prefer dark", async () => {
    const { resolveInitialTheme } = await import("./theme.js");
    expect(resolveInitialTheme({ stored: null, prefersDark: false })).toBe("light");
  });

  it("ignores an invalid stored value and falls through to the OS preference", async () => {
    const { resolveInitialTheme } = await import("./theme.js");
    expect(resolveInitialTheme({ stored: "press", prefersDark: true })).toBe("dark");
    expect(resolveInitialTheme({ stored: "", prefersDark: false })).toBe("light");
  });
});

describe("applyTheme (DOM edge)", () => {
  it("dark → sets data-theme='dark' on the given root", async () => {
    const { applyTheme } = await import("./theme.js");
    const root = makeRoot();
    applyTheme("dark", root as unknown as HTMLElement);
    expect(root.setAttribute).toHaveBeenCalledWith("data-theme", "dark");
    expect(root.removeAttribute).not.toHaveBeenCalled();
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("light → removes data-theme (light is the absence-of-attribute default)", async () => {
    const { applyTheme } = await import("./theme.js");
    const root = makeRoot();
    applyTheme("dark", root as unknown as HTMLElement);
    applyTheme("light", root as unknown as HTMLElement);
    expect(root.removeAttribute).toHaveBeenCalledWith("data-theme");
    expect(root.getAttribute("data-theme")).toBeNull();
  });
});

describe("setTheme / toggleTheme (persistence + DOM)", () => {
  it("setTheme persists under STORAGE_KEY and applies to the root", async () => {
    const { setTheme, STORAGE_KEY } = await import("./theme.js");
    const root = makeRoot();
    const storage = makeStorage();
    setTheme("dark", { root: root as unknown as HTMLElement, storage });
    expect(storage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  it("setTheme('light') persists 'light' and clears the attribute", async () => {
    const { setTheme } = await import("./theme.js");
    const root = makeRoot();
    const storage = makeStorage();
    setTheme("dark", { root: root as unknown as HTMLElement, storage });
    setTheme("light", { root: root as unknown as HTMLElement, storage });
    expect(storage._map.get("galley.theme")).toBe("light");
    expect(root.getAttribute("data-theme")).toBeNull();
  });

  it("toggleTheme flips the current mode and returns the new mode", async () => {
    const { toggleTheme } = await import("./theme.js");
    const root = makeRoot();
    const storage = makeStorage();
    const next = toggleTheme("light", { root: root as unknown as HTMLElement, storage });
    expect(next).toBe("dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
    const back = toggleTheme("dark", { root: root as unknown as HTMLElement, storage });
    expect(back).toBe("light");
    expect(root.getAttribute("data-theme")).toBeNull();
  });

  it("STORAGE_KEY is the namespaced galley key", async () => {
    const { STORAGE_KEY } = await import("./theme.js");
    expect(STORAGE_KEY).toBe("galley.theme");
  });
});

describe("import side effects (Architect invariant)", () => {
  it("importing the module mutates no DOM and reads no prefers-color-scheme", async () => {
    const setAttribute = vi.fn();
    const removeAttribute = vi.fn();
    const matchMedia = vi.fn();
    const getItem = vi.fn();

    const g = globalThis as unknown as {
      document?: unknown;
      window?: unknown;
      localStorage?: unknown;
    };
    const hadDocument = "document" in g;
    const hadWindow = "window" in g;
    const hadLocalStorage = "localStorage" in g;
    const prevDocument = g.document;
    const prevWindow = g.window;
    const prevLocalStorage = g.localStorage;

    g.document = { documentElement: { setAttribute, removeAttribute } };
    g.window = { matchMedia };
    g.localStorage = { getItem };

    try {
      vi.resetModules();
      await import("./theme.js");
    } finally {
      if (hadDocument) g.document = prevDocument;
      else delete g.document;
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
      if (hadLocalStorage) g.localStorage = prevLocalStorage;
      else delete g.localStorage;
    }

    expect(setAttribute).not.toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalled();
    expect(matchMedia).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- *
 * #19.5 — WCAG AA contrast guard for the floating-chrome surfaces (R6).
 *
 * The chrome tokens live in CSS only (no TS mirror), so this guard parses the
 * REAL stylesheets — styles.css (`:root` light + the @supports translucency
 * override) and theme.css (the dark override block + its @supports override) —
 * and asserts, for BOTH themes:
 *
 *   1. Ink text on the OPAQUE chrome fallback (`--chrome-opaque`) — what every
 *      browser without backdrop-filter renders — clears AA (4.5:1).
 *   2. Ink text on the TRANSLUCENT `--chrome`, composited (alpha-blended, NO
 *      blur) over the worst-case backdrops it can float over — the press bed
 *      (`--paper`) and the white rendered page (`--doc-paper`, worst case in
 *      dark: the zoom pill / popovers over the page) — still clears AA for
 *      `--ink` (body) and `--ink-soft` (ghost buttons, pill/status-chip text).
 *      The blur is atmosphere only; it must NEVER carry legibility.
 *   3. `--ink-faint` (tertiary hints/carets inside menus) clears AA on the
 *      opaque fallback and ≥ 3:1 on the translucent composite — documented
 *      exception: it labels nothing primary (hint lines, carets), every
 *      adjacent primary label is `--ink`/`--ink-soft`, and non-glass renderers
 *      get the full 4.5:1.
 *   4. Accent-filled chrome (the on-accent label) and the active accent-soft
 *      chip text clear AA.
 * ------------------------------------------------------------------------- */

type RGBA = { r: number; g: number; b: number; a: number };

function parseColor(value: string): RGBA {
  const v = value.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hexMatch) {
    let h = hexMatch[1]!;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fnMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (fnMatch) {
    return {
      r: Number(fnMatch[1]),
      g: Number(fnMatch[2]),
      b: Number(fnMatch[3]),
      a: fnMatch[4] === undefined ? 1 : Number(fnMatch[4]),
    };
  }
  throw new Error(`unparseable color: ${value}`);
}

/** Alpha-composite `top` over an opaque `bottom` (the no-blur worst case). */
function composite(top: RGBA, bottom: RGBA): RGBA {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function relativeLuminance({ r, g, b }: RGBA): number {
  const chan = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Extract `--name: value;` pairs from a CSS block body. */
function tokensIn(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.replace(/\/\*[\s\S]*?\*\//g, "").trim());
  }
  return out;
}

/** Split a stylesheet into its base text and the @supports override body. */
function splitSupports(css: string): { base: string; supports: string } {
  // Anchored to a line START so prose mentions of "@supports" inside token
  // comments can't split the sheet in the wrong place.
  const m = /^@supports[^{]+\{([\s\S]*)\}\s*$/m.exec(css);
  return { base: m ? css.slice(0, m.index) : css, supports: m ? m[1]! : "" };
}

/**
 * Extract `--name: value;` pairs from the FIRST selector block in `text` that
 * matches `selector` exactly. Returns an empty map if the selector is absent.
 *
 * Strategy: scan for `<selector> {`, then collect everything up to the
 * matching closing `}` using a brace counter. This handles the case where a
 * single stylesheet holds multiple selector blocks (e.g. theme.css after the
 * skin blocks are added).
 */
function tokensForSelector(text: string, selector: string): Map<string, string> {
  // Build a pattern that matches the selector at the start of a token boundary
  // (preceded by start-of-line, whitespace, or nothing) followed by whitespace
  // and an opening brace. We escape special CSS attribute-selector chars.
  const escaped = selector.replace(/[[\]"=]/g, "\\$&");
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*\\{`, "m");
  const match = re.exec(text);
  if (!match) return new Map();

  // Walk from the opening `{` to find its matching `}`.
  const start = match.index + match[0].length; // right after `{`
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    i++;
  }
  const body = text.slice(start, i - 1); // content between the braces
  return tokensIn(body);
}

/**
 * Load and compose the four skin×mode palettes.
 *
 * Each palette is built by cascading, exactly as the browser does:
 *   1. Start from the :root block in styles.css (Press-light defaults, all
 *      shared tokens + 22 skin-varying tokens).
 *   2. Layer the matching skin / mode block's declared tokens on top.
 *   3. For --chrome glass: repeat the same merge over the @supports bodies.
 *
 * The returned object has the SAME shape as the old `loadThemeTokens()` for
 * the existing two palettes (light / dark), extended with two new ones.
 * "base" is the composed opaque token map; "glass" is the composed glass map
 * (only --chrome is expected to differ; everything else is inherited).
 */
function loadThemeTokens() {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  const stylesCss = splitSupports(read("./styles.css"));
  const themeCss  = splitSupports(read("./theme.css"));

  /** Compose: start from `base`, layer `overrides` on top. */
  const merge = (...maps: Map<string, string>[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of maps) m.forEach((v, k) => out.set(k, v));
    return out;
  };

  // ── base blocks (selector → token map) ──
  // Default skin is Studio: the bare :root in styles.css is Studio-light, and
  // the bare [data-theme="dark"] in theme.css is Studio-dark (it also carries
  // the shared dark --syn-*/--agent*/--ok/--warn/--err lifts). Press is opt-in
  // under [data-skin="press"].
  const rootBase         = tokensForSelector(stylesCss.base, ":root");
  const studioDarkBase   = tokensForSelector(themeCss.base,  ":root[data-theme=\"dark\"]");
  const pressLightBase   = tokensForSelector(themeCss.base,  ":root[data-skin=\"press\"]");
  const pressDarkBase    = tokensForSelector(themeCss.base,  ":root[data-skin=\"press\"][data-theme=\"dark\"]");

  // ── @supports glass blocks (selector → token map) ──
  const rootGlass        = tokensForSelector(stylesCss.supports, ":root");
  const pressLightGlass  = tokensForSelector(stylesCss.supports, ":root[data-skin=\"press\"]");
  const studioDarkGlass  = tokensForSelector(themeCss.supports,  ":root[data-theme=\"dark\"]");
  const pressDarkGlass   = tokensForSelector(themeCss.supports,  ":root[data-skin=\"press\"][data-theme=\"dark\"]");

  return {
    // Studio-light: :root is the sole authority.
    studioLight: {
      base:  rootBase,
      glass: merge(rootBase, rootGlass),
    },
    // Studio-dark: :root layered with the default [data-theme="dark"] block.
    studioDark: {
      base:  merge(rootBase, studioDarkBase),
      glass: merge(rootBase, studioDarkBase, rootGlass, studioDarkGlass),
    },
    // Press-light: :root → [data-skin="press"].
    pressLight: {
      base:  merge(rootBase, pressLightBase),
      glass: merge(rootBase, pressLightBase, rootGlass, pressLightGlass),
    },
    // Press-dark: :root → [data-theme="dark"] (shared dark lifts) →
    // [data-skin="press"] → [data-skin="press"][data-theme="dark"], exactly as
    // the browser cascade resolves it.
    pressDark: {
      base:  merge(rootBase, studioDarkBase, pressLightBase, pressDarkBase),
      glass: merge(rootBase, studioDarkBase, pressLightBase, pressDarkBase, rootGlass, studioDarkGlass, pressDarkGlass),
    },
    // Convenience aliases used by pre-existing describe blocks.
    get light() { return this.studioLight; },
    get dark()  { return this.studioDark;  },
  };
}

describe("chrome-surface contrast — WCAG AA in all four skin×mode palettes (#19.5 / R6)", () => {
  const themes = loadThemeTokens();
  const AA = 4.5;
  /** Documented floor for --ink-faint on the glass composite (see header). */
  const FAINT_ON_GLASS = 3.0;
  /**
   * The primary CTA fills with the VIVID brand accent and carries a bold
   * label (--on-accent). Bold/large UI text qualifies for WCAG's 3:1 floor
   * (SC 1.4.3 large-scale text / SC 1.4.11 components), not the 4.5:1
   * normal-text bar — a deliberate brand exception so the fill stays vivid
   * rather than a brick-dark fill. Small accent TEXT instead uses the
   * deep --accent-deep, which is held to full AA below.
   */
  const BRAND_CTA_LABEL_MIN = 3.0;

  const cases = [
    { name: "press-light",  tokens: themes.pressLight  },
    { name: "press-dark",   tokens: themes.pressDark   },
    { name: "studio-light", tokens: themes.studioLight },
    { name: "studio-dark",  tokens: themes.studioDark  },
  ] as const;

  it("parses the chrome tokens out of all four palettes", () => {
    for (const { name, tokens } of cases) {
      expect(tokens.base.get("chrome"),        `${name} --chrome`).toBeTruthy();
      expect(tokens.base.get("chrome-opaque"), `${name} --chrome-opaque`).toBeTruthy();
      expect(tokens.base.get("chrome-border"), `${name} --chrome-border`).toBeTruthy();
      expect(tokens.glass.get("chrome"),       `${name} @supports --chrome`).toBeTruthy();
      // The glass value must actually be translucent, else the @supports
      // block is pointless; the opaque token must actually be opaque.
      expect(parseColor(tokens.glass.get("chrome")!).a).toBeLessThan(1);
      expect(parseColor(tokens.base.get("chrome-opaque")!).a).toBe(1);
      // And the default --chrome IS the opaque fallback (no-@supports path).
      expect(tokens.base.get("chrome")).toBe(tokens.base.get("chrome-opaque"));
    }
  });

  it("--doc-paper resolves to #fdfcf9 in all four palettes (R1 invariant)", () => {
    for (const { name, tokens } of cases) {
      expect(tokens.base.get("doc-paper"), `${name} --doc-paper`).toBe("#fdfcf9");
    }
  });

  for (const { name, tokens } of cases) {
    // Each palette is a fully composed map; no cross-palette fallback needed.
    const tok = (key: string) => parseColor(tokens.base.get(key)!);

    const opaque = () => tok("chrome-opaque");
    const glassOver = (backdropKey: string) =>
      composite(parseColor(tokens.glass.get("chrome")!), tok(backdropKey));

    it(`${name}: --ink / --ink-soft / --ink-faint clear AA on the opaque chrome fallback`, () => {
      expect(contrast(tok("ink"), opaque())).toBeGreaterThanOrEqual(AA);
      expect(contrast(tok("ink-soft"), opaque())).toBeGreaterThanOrEqual(AA);
      expect(contrast(tok("ink-faint"), opaque())).toBeGreaterThanOrEqual(AA);
    });

    it(`${name}: ghost-button / pill / status-chip text clears AA on the UNblurred glass composite (worst backdrops)`, () => {
      for (const backdrop of ["paper", "doc-paper"]) {
        const surface = glassOver(backdrop);
        // --ink: primary labels (pill buttons, menu items, readouts).
        expect(
          contrast(tok("ink"), surface),
          `${name} --ink on glass over --${backdrop}`,
        ).toBeGreaterThanOrEqual(AA);
        // --ink-soft: status chip, zoom buttons, rail icons, secondary text.
        expect(
          contrast(tok("ink-soft"), surface),
          `${name} --ink-soft on glass over --${backdrop}`,
        ).toBeGreaterThanOrEqual(AA);
        // --ink-faint: tertiary hints only (documented 3:1 floor on glass).
        expect(
          contrast(tok("ink-faint"), surface),
          `${name} --ink-faint on glass over --${backdrop}`,
        ).toBeGreaterThanOrEqual(FAINT_ON_GLASS);
      }
    });

    it(`${name}: the bold CTA label clears the brand floor on the vivid fill; accent-deep text clears AA on the soft wash`, () => {
      // Primary pill buttons fill with the vivid brand accent; the bold label
      // clears the 3:1 brand floor.
      expect(contrast(tok("on-accent"), tok("accent"))).toBeGreaterThanOrEqual(
        BRAND_CTA_LABEL_MIN,
      );
      // Active rail icon / insert tab / compiler segment: accent-deep text on
      // the accent-soft wash — small text, held to full AA.
      expect(contrast(tok("accent-deep"), tok("accent-soft"))).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe("vivid-accent brand rule (fill label vs small accent text)", () => {
  const themes = loadThemeTokens();
  const AA = 4.5;
  /** Bold/large CTA-label floor — see the chrome-contrast describe above. */
  const BRAND_CTA_LABEL_MIN = 3.0;
  const cases = [
    { name: "press-light",  tokens: themes.pressLight  },
    { name: "press-dark",   tokens: themes.pressDark   },
    { name: "studio-light", tokens: themes.studioLight },
    { name: "studio-dark",  tokens: themes.studioDark  },
  ] as const;

  for (const { name, tokens } of cases) {
    const raw = (k: string) => tokens.base.get(k);
    const tok = (k: string) => parseColor(raw(k)!);

    it(`${name}: defines the vivid --brand signature token`, () => {
      expect(raw("brand"), `${name} --brand`).toBeTruthy();
    });

    it(`${name}: the CTA label (--on-accent) is not the bright fill hue itself`, () => {
      // The label is a high-contrast tone (white / near-black), never the fill.
      expect(raw("on-accent")).not.toBe(raw("accent"));
    });

    it(`${name}: the bold CTA label clears the brand floor on the vivid accent fill`, () => {
      expect(
        contrast(tok("on-accent"), tok("accent")),
        `${name} on-accent / accent`,
      ).toBeGreaterThanOrEqual(BRAND_CTA_LABEL_MIN);
    });

    it(`${name}: small accent TEXT (--accent-deep) clears full AA on the theme's paper`, () => {
      // The vivid hue fails as small text, so accent text/icons use the deep
      // shade — which must clear the normal-text bar on the bed.
      expect(
        contrast(tok("accent-deep"), tok("paper")),
        `${name} accent-deep / paper`,
      ).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe("light syntax palette clears AA on the editor ground (R6)", () => {
  // The dark --syn-* are pinned by typst-highlight.contrast.test.ts; the light
  // palette was previously unguarded. The editor paints on --paper-raised
  // (.cm-editor { background: var(--paper-raised) }), and the active-line wash is
  // a NEUTRAL faint grey (styles.css), so the white ground is the worst case for
  // these warm tokens. Every COLORED token must clear the 4.5:1 normal-text bar;
  // --syn-comment is intentionally muted (a quiet grey) and is exempt by design.
  // The default Studio-light ground (#ffffff) is used; the light --syn-* are the
  // same in both skins, so Press-light's slightly warmer #fbf8f2 ground only
  // widens the margins — this white ground is the worst case for the warm tokens.
  const themes = loadThemeTokens();
  const AA = 4.5;
  const ground = parseColor(themes.light.base.get("paper-raised")!);
  const tokens = [
    "syn-heading",
    "syn-keyword",
    "syn-list",
    "syn-function",
    "syn-variable",
    "syn-string",
    "syn-math",
    "syn-raw",
    "syn-number",
    "syn-escape",
    "syn-label",
  ];
  for (const key of tokens) {
    it(`--${key} clears AA on --paper-raised`, () => {
      const value = themes.light.base.get(key);
      expect(value, `--${key} present`).toBeTruthy();
      expect(
        contrast(parseColor(value!), ground),
        `--${key} on --paper-raised`,
      ).toBeGreaterThanOrEqual(AA);
    });
  }
});
