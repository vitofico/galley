/**
 * Style model + styleability detection (Phase 1 + Phase 2 capability contract).
 * PURE — no DOM, no worker, no yjs. The canonical ABI: a style exports `doc(...)`
 * (all params optional except `body`, with a trailing `..extra` sink so a doc
 * passing extra named args never hard-breaks a leaner style) plus the fixed
 * palette tokens.
 *
 * Phase 2 — NEGOTIATED CAPABILITY CONTRACT. A document that imports semantic
 * helpers (e.g. `fig`, `affil`, `theorem`) from `/style.typ` is no longer hard-
 * blocked. Detection RECORDS those helpers as `requiredCapabilities`; a style
 * DECLARES the helpers it provides (`StyleManifest.capabilities`); a swap is
 * allowed iff the style's capabilities ⊇ the doc's required (see {@link negotiate}).
 * Capability ids are plain exported Typst symbol names — no arity/signature layer
 * (the pre-commit trial-compile is the authority for signature/semantic
 * mismatch) and no comment pragma (requirements are inferred from imports).
 * Detection is PROJECT-WIDE: every file importing `/style.typ` contributes its
 * required helpers, since a chapter/intro file can pull helpers `/main.typ` does
 * not. It still fails CLOSED on a wildcard import (`*`) — Galley can't enumerate
 * what such a doc needs, so it is `incompatible` rather than silently swapped.
 *
 * Token naming note: the divider/hairline token is `rule`, NOT `line` — a
 * `#let line = …` binding would shadow Typst's built-in `line()` element inside
 * the style module. The legacy template token names `line-strong`/`line-soft`
 * alias onto `rule` via the shim.
 */
export interface StyleManifest {
  id: string;
  name: string;
  description?: string;
  abiVersion: 1;
  entry: "doc";
  tokens: readonly ["accent", "ink", "ink-soft", "rule"];
  /**
   * The semantic helpers this style provides beyond the base ABI (exported Typst
   * symbol names, e.g. `fig`, `affil`, `theorem`). `[]` for a generic style. A
   * swap is allowed iff these ⊇ the document's `requiredCapabilities`. Additive
   * to `abiVersion: 1`; absent ⇒ treat as `[]`.
   */
  capabilities: readonly string[];
  builtin: boolean;
}
export interface StyleFile {
  path: string;
  text: string;
}
export interface Style {
  manifest: StyleManifest;
  files: StyleFile[];
  entryFile: string;
}

export const CANONICAL_TOKENS: readonly string[] = ["accent", "ink", "ink-soft", "rule"];
export const TOKEN_ALIASES: Record<string, string> = { "line-strong": "rule", "line-soft": "rule" };

export type StyleabilityState = "clean" | "shimmed" | "incompatible" | "non-conforming";

export interface Styleability {
  stylePath: string;
  entrySymbol: string | null;
  importedSymbols: string[];
  tokenAliases: Record<string, string>;
  /**
   * The semantic helpers this document needs from its style — every symbol it
   * imports from `/style.typ` (across ALL project files) that isn't the entry or
   * a palette token/alias. Sorted + deduped. Negotiated against a candidate
   * style's `capabilities` at swap time (see {@link negotiate}).
   */
  requiredCapabilities: string[];
  state: StyleabilityState;
  reason?: string;
}

/** The result of negotiating a document's required capabilities against a style. */
export type Negotiation = { ok: true } | { ok: false; missing: string[] };

/**
 * A swap is allowed iff the style provides every capability the document
 * requires. On refusal, `missing` lists the unmet capabilities (sorted), for a
 * clear, helper-naming reason in the UI.
 */
export function negotiate(required: readonly string[], provided: readonly string[]): Negotiation {
  const have = new Set(provided);
  const missing = [...new Set(required)].filter((c) => !have.has(c)).sort();
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

const STYLE_PATH = "/style.typ";
// `#import "/style.typ": a, b, c` — capture the import list (single line).
const IMPORT_RE = /#import\s+"\/style\.typ"\s*:\s*([^\n]+)/;
// `#show: X.with(` or `#show: X(` — capture the entry symbol.
const SHOW_RE = /#show\s*:\s*([A-Za-z_][\w-]*)\s*(?:\.with)?\s*\(/;

/** Parsed `/style.typ` import list for one file: the symbols + a wildcard flag. */
interface ParsedImport {
  symbols: string[];
  wildcard: boolean;
}
function parseStyleImport(text: string): ParsedImport | null {
  const imp = IMPORT_RE.exec(text);
  if (!imp) return null;
  const raw = (imp[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return { symbols: raw.filter((s) => s !== "*"), wildcard: raw.includes("*") };
}

/**
 * Classify whether a project's document can switch styles, and what helpers it
 * needs. `mainText` anchors the entry/`#show` ABI; `otherTexts` are every OTHER
 * project file — their `/style.typ` imports contribute to `requiredCapabilities`
 * so a swap is never approved against a helper a secondary file relies on.
 */
export function detectStyleability(mainText: string, otherTexts: readonly string[] = []): Styleability {
  const mainImp = parseStyleImport(mainText);
  if (!mainImp) {
    return {
      stylePath: STYLE_PATH,
      entrySymbol: null,
      importedSymbols: [],
      tokenAliases: {},
      requiredCapabilities: [],
      state: "non-conforming",
      reason: "This document doesn't import a /style.typ module, so there's no style to switch.",
    };
  }
  const importedSymbols = mainImp.symbols;
  const show = SHOW_RE.exec(mainText);
  const entrySymbol: string | null = show?.[1] ?? null;

  // Fail CLOSED on a wildcard import anywhere: we can't enumerate what such a
  // file pulls from the style, so we can't guarantee a swap is safe.
  const otherImps = otherTexts.map(parseStyleImport).filter((p): p is ParsedImport => p !== null);
  if (mainImp.wildcard || otherImps.some((p) => p.wildcard)) {
    return {
      stylePath: STYLE_PATH,
      entrySymbol,
      importedSymbols,
      tokenAliases: {},
      requiredCapabilities: [],
      state: "incompatible",
      reason:
        "This document imports everything (*) from its style, so Galley can't tell which helpers it needs to switch safely.",
    };
  }

  const tokenAliases: Record<string, string> = {};
  const required = new Set<string>();
  // Required helpers come from EVERY file importing the style; only main carries
  // the entry symbol, so the entry is excluded only there.
  const contributions: { symbols: string[]; entry: string | null }[] = [
    { symbols: importedSymbols, entry: entrySymbol },
    ...otherImps.map((p) => ({ symbols: p.symbols, entry: null })),
  ];
  for (const { symbols, entry } of contributions) {
    for (const sym of symbols) {
      if (sym === entry) continue;
      if (CANONICAL_TOKENS.includes(sym)) continue;
      const aliasTarget = TOKEN_ALIASES[sym];
      if (aliasTarget !== undefined) {
        tokenAliases[sym] = aliasTarget;
        continue;
      }
      required.add(sym);
    }
  }
  const requiredCapabilities = [...required].sort();

  const needsShim = entrySymbol !== "doc" || Object.keys(tokenAliases).length > 0;
  return {
    stylePath: STYLE_PATH,
    entrySymbol,
    importedSymbols,
    tokenAliases,
    requiredCapabilities,
    state: needsShim ? "shimmed" : "clean",
  };
}

export function generateShim(s: Styleability): string {
  if (s.state !== "shimmed" && s.state !== "clean") return "";
  const lines: string[] = [];
  if (s.entrySymbol && s.entrySymbol !== "doc") lines.push(`#let ${s.entrySymbol} = doc`);
  for (const [alias, target] of Object.entries(s.tokenAliases)) lines.push(`#let ${alias} = ${target}`);
  if (lines.length === 0) return "";
  return ["// ── generated compatibility shim (Galley) ──", ...lines].join("\n");
}
