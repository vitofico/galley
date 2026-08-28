/**
 * Overleaf / LaTeX multi-file project migration core (roadmap #17.3) — PURE,
 * offline, deterministic.
 *
 * Input is an ALREADY-UNPACKED project tree (tar/zip extraction is explicitly
 * out of scope — Architect ruling): an array of `{ path, text?, binary? }`
 * entries. Binary assets either carry `binary: true` or simply omit `text`;
 * either way they are never converted, only listed in the asset manifest so a
 * wiring layer can copy the bytes itself.
 *
 * The core:
 *   1. classifies the tree (main .tex detection, the \input/\include/\subfile
 *      graph — cycle-safe, comment/verbatim-aware — .bib files, .cls/.sty
 *      skips, assets, orphaned .tex),
 *   2. converts every .tex with the EXISTING `latexToTypst` (#15.2), preserving
 *      relative paths (`chapters/intro.tex` → `/chapters/intro.typ`),
 *   3. rewrites cross-file structure to Typst (`\input`/`\include`/`\subfile` →
 *      `#include "/….typ"`; `\bibliography`/biblatex `\addbibresource` +
 *      `\printbibliography` → `#bibliography("…")` with the .bib passed through
 *      verbatim), and
 *   4. emits the honest migration report: per-file outcomes, the aggregated
 *      lossy-construct catalog from latexToTypst, unresolved includes, asset
 *      references, and structural warnings (ambiguous main, cycles, traversal).
 *
 * HONEST SCOPE: lossy by design. Image conversion, macro expansion, .cls/.sty
 * translation, and compile-parity are NOT promised — the report plus the
 * `repairImportedTypst` agent loop close the gap downstream. The function never
 * throws on garbage: malformed input yields a structured failure result.
 *
 * Path convention: all output paths are project-root absolute with a leading
 * slash and forward separators (`/chapters/intro.typ`) — the Galley VFS shape.
 * `..` segments are normalized; anything escaping the project root is REJECTED
 * with a report note, never silently resolved.
 */

import { latexToTypst, escapeTypstString, type UnconvertedItem } from "./latex-to-typst.js";
import type { ProjectTextFile } from "./cross-file-labels.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** One entry of the already-unpacked project tree. */
export interface LatexProjectInputFile {
  /** Project-relative path; leading slash optional ("main.tex" ≡ "/main.tex"). */
  path: string;
  /** Text content. Omit for binary assets (or set `binary: true`). */
  text?: string;
  /** Mark an entry as binary; it is listed in the asset manifest, never read. */
  binary?: boolean;
  /**
   * Raw bytes for a binary asset (#7). When present, the importer surfaces it in
   * `binaryFiles` so the bytes survive import (Overleaf bundles used to drop
   * images — import-G1). Text entries ignore this.
   */
  bytes?: Uint8Array;
}

/** A preserved binary asset from the import: its normalized path + raw bytes (#7). */
export interface ImportedBinaryFile {
  path: string;
  bytes: Uint8Array;
}

export interface ImportLatexProjectInput {
  files: LatexProjectInputFile[];
}

export type ProjectFileAction = "converted" | "passthrough" | "skipped" | "asset";

/** Per-file migration outcome (one per input entry, sorted by sourcePath). */
export interface ProjectFileOutcome {
  /** Normalized root-absolute source path, e.g. "/chapters/intro.tex". */
  sourcePath: string;
  /** The emitted output path, or null when nothing is emitted (skip/asset). */
  outputPath: string | null;
  action: ProjectFileAction;
  /** True for a converted .tex never reached from the main file's include graph. */
  orphaned: boolean;
  /** Human-readable note (skip reason, preamble-include caveat, …). */
  note?: string;
}

/** An \input/\include/\subfile whose target could not be resolved. */
export interface UnresolvedInclude {
  /** The including file (normalized source path). */
  from: string;
  /** The include target exactly as written in the source. */
  target: string;
  /** 1-based line in the including file. */
  line: number;
  reason: "missing" | "outside-root";
}

/** A referenced (or shipped) asset — manifest only; bytes are NOT handled here. */
export interface ProjectAssetRef {
  /** Normalized best-effort root-absolute path. */
  path: string;
  /** The .tex files that reference it (sorted, deduped); empty if just shipped. */
  referencedBy: string[];
}

export interface ProjectWarning {
  kind:
    | "no-main"
    | "ambiguous-main"
    | "include-cycle"
    | "path-traversal"
    | "duplicate-path"
    | "invalid-entry"
    | "preamble-include"
    | "bib-appended";
  message: string;
  /** The file the warning concerns, when there is one. */
  path?: string;
}

/** The honest migration report. */
export interface LatexProjectReport {
  outcomes: ProjectFileOutcome[];
  /** Aggregated lossy-construct notes from latexToTypst, path-qualified. */
  unconverted: Array<{ path: string } & UnconvertedItem>;
  unresolvedIncludes: UnresolvedInclude[];
  assets: ProjectAssetRef[];
  warnings: ProjectWarning[];
}

export interface ImportLatexProjectResult {
  /** Converted .typ files + verbatim .bib/other text passthroughs, path-sorted. */
  files: ProjectTextFile[];
  /** Output path of the converted main file ("/main.typ"), or null when unknown. */
  mainPath: string | null;
  /**
   * Preserved binary assets (#7): every binary input entry that carried `bytes`,
   * normalized + deduped + path-sorted. The caller stores these in a BlobStore and
   * creates binary files so images survive import (G1) and `image()` resolves.
   */
  binaryFiles: ImportedBinaryFile[];
  report: LatexProjectReport;
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

type EntryKind = "tex" | "bib" | "style" | "asset" | "other-text";

interface Entry {
  path: string; // normalized root-absolute
  text: string | null;
  kind: EntryKind;
}

interface Directive {
  kind:
    | "input"
    | "bibliography"
    | "addbibresource"
    | "printbibliography"
    | "includegraphics";
  /** Raw brace argument as written (trimmed). */
  arg: string;
  /** 1-based source line. */
  line: number;
  /** True when the directive sits before \begin{document} in its file. */
  inPreamble: boolean;
  /**
   * Placeholder token substituted into the source. Set on rewritten directives
   * and on bare (float-depth-0) \includegraphics; absent on figure/table-embedded
   * graphics, which latex-to-typst converts in place via renderFloat.
   */
  token?: string;
}

interface ScannedTex {
  entry: Entry;
  /** The source with rewritten directives replaced by placeholder tokens. */
  rewrittenText: string;
  directives: Directive[];
  /** Whether the file looks like a standalone document. */
  hasDocumentClass: boolean;
  hasBeginDocument: boolean;
  /** The \documentclass{...} class name, if any. */
  documentClass: string | null;
  graphicsPaths: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Migrate an unpacked LaTeX/Overleaf project tree to a Typst file map plus an
 * honest report. Pure and deterministic; NEVER throws — garbage input yields a
 * structured failure (`mainPath: null` + warnings).
 */
export function importLatexProject(
  input: ImportLatexProjectInput,
): ImportLatexProjectResult {
  const warnings: ProjectWarning[] = [];

  const rawFiles = isRecord(input) && Array.isArray(input.files) ? input.files : null;
  if (rawFiles === null) {
    warnings.push({
      kind: "invalid-entry",
      message: "input is not an object with a files array",
    });
    return emptyResult(warnings);
  }

  // -- Normalize + dedupe the tree --------------------------------------------
  const entries = new Map<string, Entry>();
  // #7: preserved binary bytes, keyed by normalized path (first one wins, like text).
  const binaryBytes = new Map<string, Uint8Array>();
  for (const raw of rawFiles) {
    if (!isRecord(raw) || typeof raw.path !== "string") {
      warnings.push({
        kind: "invalid-entry",
        message: `entry without a string path was ignored: ${safeStringify(raw)}`,
      });
      continue;
    }
    const norm = normalizePath("/", raw.path);
    if (norm === null) {
      warnings.push({
        kind: raw.path.includes("..") ? "path-traversal" : "invalid-entry",
        message: `entry path escapes the project root and was ignored: ${raw.path}`,
        path: raw.path,
      });
      continue;
    }
    if (entries.has(norm)) {
      warnings.push({
        kind: "duplicate-path",
        message: `duplicate entry for ${norm}; the first one wins`,
        path: norm,
      });
      continue;
    }
    const text = raw.binary === true || typeof raw.text !== "string" ? null : raw.text;
    entries.set(norm, { path: norm, text, kind: classify(norm, text) });
    // #7: keep the raw bytes of a binary entry so they survive the import (G1).
    if (text === null && raw.bytes instanceof Uint8Array && !binaryBytes.has(norm)) {
      binaryBytes.set(norm, raw.bytes);
    }
  }

  const sortedEntries = [...entries.values()].sort((a, b) => cmp(a.path, b.path));
  const texEntries = sortedEntries.filter((e) => e.kind === "tex");

  // -- Scan every .tex (comment/verbatim-aware) -------------------------------
  const tokens = new TokenFactory();
  const scanned = new Map<string, ScannedTex>();
  for (const entry of texEntries) {
    scanned.set(entry.path, scanTexFile(entry, tokens));
  }

  // -- Pick the main file ------------------------------------------------------
  const mainSourcePath = detectMain(texEntries, scanned, entries, warnings);

  // -- Reachability from main (cycle-safe BFS) ---------------------------------
  const reachable = new Set<string>();
  if (mainSourcePath !== null) {
    walkIncludes(mainSourcePath, scanned, entries, reachable, warnings);
  }

  // -- Global bibliography resources (biblatex \addbibresource) ----------------
  const bibResources: string[] = [];
  for (const entry of texEntries) {
    const scan = scanned.get(entry.path)!;
    for (const d of scan.directives) {
      if (d.kind !== "addbibresource") continue;
      for (const part of splitArgList(d.arg)) {
        const resolved = resolveBibTarget(entry.path, part, entries);
        const path = resolved ?? normalizeOrRaw(entry.path, withDefaultExt(part, ".bib"));
        if (!bibResources.includes(path)) bibResources.push(path);
      }
    }
  }

  // -- Global \graphicspath dirs ------------------------------------------------
  const graphicsDirs: string[] = [];
  for (const entry of texEntries) {
    for (const dir of scanned.get(entry.path)!.graphicsPaths) {
      if (!graphicsDirs.includes(dir)) graphicsDirs.push(dir);
    }
  }

  // -- Convert + rewrite --------------------------------------------------------
  const outFiles: ProjectTextFile[] = [];
  const outcomes: ProjectFileOutcome[] = [];
  const unconverted: Array<{ path: string } & UnconvertedItem> = [];
  const unresolvedIncludes: UnresolvedInclude[] = [];
  const assetRefs = new Map<string, Set<string>>(); // asset path -> referencing tex files

  // Does ANY body emit a #bibliography call (\bibliography, or \printbibliography
  // with declared resources)? If not, biblatex resources are appended to main.
  const anyBibliographyCall = texEntries.some((e) =>
    scanned
      .get(e.path)!
      .directives.some(
        (d) =>
          !d.inPreamble &&
          (d.kind === "bibliography" ||
            (d.kind === "printbibliography" && bibResources.length > 0)),
      ),
  );

  for (const entry of sortedEntries) {
    if (entry.kind === "asset") {
      if (!assetRefs.has(entry.path)) assetRefs.set(entry.path, new Set());
      outcomes.push({
        sourcePath: entry.path,
        outputPath: null,
        action: "asset",
        orphaned: false,
        note: "binary asset — bytes are not handled by the core; copy alongside",
      });
      continue;
    }
    if (entry.kind === "style") {
      outcomes.push({
        sourcePath: entry.path,
        outputPath: null,
        action: "skipped",
        orphaned: false,
        note: "LaTeX class/style files have no Typst equivalent; styling must be redone in Typst",
      });
      continue;
    }
    if (entry.kind === "bib" || entry.kind === "other-text") {
      outFiles.push({ path: entry.path, text: entry.text ?? "" });
      outcomes.push({
        sourcePath: entry.path,
        outputPath: entry.path,
        action: "passthrough",
        orphaned: false,
        ...(entry.kind === "bib"
          ? { note: "BibTeX passes through verbatim; referenced via #bibliography" }
          : {}),
      });
      continue;
    }

    // entry.kind === "tex"
    const scan = scanned.get(entry.path)!;
    const result = latexToTypst(scan.rewrittenText);
    let typst = result.typst;

    // Substitute placeholder tokens with their Typst renderings. Each token is
    // unique and appears exactly once in the rewritten text, so we build a
    // token→rendering Map and do ONE linear pass over the output (#22.2): a
    // per-directive `split().join()` was O(directives × output_size), which a
    // hostile .tex with thousands of \input/\bibliography directives could push
    // quadratic and hang the tab. The single-regex callback is O(output_size)
    // regardless of directive count.
    let preambleIncludes = 0;
    const renderings = new Map<string, string>();
    for (const d of scan.directives) {
      if (d.token === undefined) continue;
      const rendering = renderDirective(
        d,
        entry.path,
        entries,
        bibResources,
        unresolvedIncludes,
        warnings,
        graphicsDirs,
      );
      if (d.inPreamble && d.kind === "input") preambleIncludes++;
      renderings.set(d.token, rendering);
    }
    if (renderings.size > 0) {
      typst = typst.replace(TOKEN_RE, (m) => renderings.get(m) ?? m);
    }

    // Record the lossy-construct catalog AFTER the renderings exist, replacing any
    // placeholder token left in an unconverted snippet (e.g. a bare \includegraphics
    // inside an unconverted env like `center`) with its rendering so the report
    // never surfaces a raw GALLEYIMPORTDIRECTIVE token to a human reviewer.
    for (const item of result.unconverted) {
      const snippet =
        renderings.size > 0
          ? item.snippet.replace(TOKEN_RE, (m) => renderings.get(m) ?? m)
          : item.snippet;
      unconverted.push({ path: entry.path, ...item, snippet });
    }
    if (preambleIncludes > 0) {
      warnings.push({
        kind: "preamble-include",
        message:
          `${entry.path} has ${preambleIncludes} \\input/\\include in its preamble; ` +
          "the target was converted but the preamble is stripped, so no #include was emitted — review",
        path: entry.path,
      });
    }

    // Asset references from \includegraphics, resolved best-effort.
    for (const d of scan.directives) {
      if (d.kind !== "includegraphics") continue;
      const assetPath = resolveAssetTarget(entry.path, d.arg, graphicsDirs, entries);
      let set = assetRefs.get(assetPath);
      if (!set) assetRefs.set(assetPath, (set = new Set()));
      set.add(entry.path);
    }

    const outputPath = texToTypPath(entry.path);
    const isMain = entry.path === mainSourcePath;
    const orphaned = mainSourcePath !== null && !reachable.has(entry.path);

    // biblatex projects without \printbibliography: append the bibliography to
    // the main file so the references survive, and say so.
    if (isMain && bibResources.length > 0 && !anyBibliographyCall) {
      typst = `${typst}\n${bibliographyCall(bibResources)}\n`;
      warnings.push({
        kind: "bib-appended",
        message:
          "\\addbibresource found but no \\printbibliography/\\bibliography in the body; " +
          `#bibliography was appended to ${outputPath} — review its placement`,
        path: outputPath,
      });
    }

    outFiles.push({ path: outputPath, text: typst });
    outcomes.push({
      sourcePath: entry.path,
      outputPath,
      action: "converted",
      orphaned,
      ...(orphaned
        ? { note: "never reached from the main file's include graph; converted anyway" }
        : {}),
    });
  }

  // -- Assemble deterministically ------------------------------------------------
  outFiles.sort((a, b) => cmp(a.path, b.path));
  outcomes.sort((a, b) => cmp(a.sourcePath, b.sourcePath));
  unresolvedIncludes.sort((a, b) => cmp(a.from, b.from) || a.line - b.line);
  const assets: ProjectAssetRef[] = [...assetRefs.entries()]
    .map(([path, refs]) => ({ path, referencedBy: [...refs].sort(cmp) }))
    .sort((a, b) => cmp(a.path, b.path));

  const binaryFiles: ImportedBinaryFile[] = [...binaryBytes.entries()]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => cmp(a.path, b.path));

  return {
    files: outFiles,
    mainPath: mainSourcePath === null ? null : texToTypPath(mainSourcePath),
    binaryFiles,
    report: { outcomes, unconverted, unresolvedIncludes, assets, warnings },
  };
}

// ---------------------------------------------------------------------------
// Tree classification
// ---------------------------------------------------------------------------

function classify(path: string, text: string | null): EntryKind {
  if (text === null) return "asset";
  const lower = path.toLowerCase();
  if (lower.endsWith(".tex")) return "tex";
  if (lower.endsWith(".bib")) return "bib";
  if (lower.endsWith(".cls") || lower.endsWith(".sty")) return "style";
  return "other-text";
}

/**
 * Pick the main .tex, in heuristic order:
 *   1. files with \documentclass + \begin{document} (excluding the `subfiles`
 *      class, whose documents are chapters, not mains);
 *   2. if none: a lone \begin{document} file, else a lone .tex file (warned);
 *   3. if several: prefer common names (main/master/thesis/paper), then the one
 *      whose include graph reaches the most .tex files, then the lexicographically
 *      first — with an honest ambiguous-main warning when names didn't decide.
 */
function detectMain(
  texEntries: Entry[],
  scanned: Map<string, ScannedTex>,
  entries: Map<string, Entry>,
  warnings: ProjectWarning[],
): string | null {
  if (texEntries.length === 0) {
    warnings.push({ kind: "no-main", message: "no .tex files in the project" });
    return null;
  }

  let candidates = texEntries.filter((e) => {
    const s = scanned.get(e.path)!;
    return s.hasDocumentClass && s.hasBeginDocument && s.documentClass !== "subfiles";
  });

  if (candidates.length === 0) {
    candidates = texEntries.filter((e) => scanned.get(e.path)!.hasBeginDocument);
    if (candidates.length === 0 && texEntries.length === 1) {
      candidates = texEntries;
    }
    if (candidates.length === 1) {
      warnings.push({
        kind: "no-main",
        message: `no file with \\documentclass + \\begin{document}; using ${candidates[0]!.path} as main`,
        path: candidates[0]!.path,
      });
      return candidates[0]!.path;
    }
    warnings.push({
      kind: "no-main",
      message:
        "could not identify a main file (no \\documentclass + \\begin{document}); " +
        "all .tex files were converted without a main",
    });
    return null;
  }

  if (candidates.length === 1) return candidates[0]!.path;

  // Several candidates: prefer conventional names, most-preferred first.
  for (const preferred of ["main", "master", "thesis", "paper"]) {
    const named = candidates.filter((e) => baseNameNoExt(e.path) === preferred);
    if (named.length === 1) return named[0]!.path;
    if (named.length > 1) {
      candidates = named;
      break;
    }
  }

  // Names didn't decide: rank by include-graph reach, then path.
  const reachCount = (path: string): number => {
    const seen = new Set<string>();
    walkIncludes(path, scanned, entries, seen, null);
    return seen.size;
  };
  const ranked = [...candidates].sort(
    (a, b) => reachCount(b.path) - reachCount(a.path) || cmp(a.path, b.path),
  );
  const chosen = ranked[0]!;
  warnings.push({
    kind: "ambiguous-main",
    message:
      `several standalone documents found (${ranked.map((e) => e.path).join(", ")}); ` +
      `picked ${chosen.path} (largest include graph) — verify`,
    path: chosen.path,
  });
  return chosen.path;
}

/**
 * Cycle-safe include-graph walk from `from`, adding every reachable .tex source
 * path (including `from`) to `seen`. Reports true cycles (an include back into
 * the CURRENT walk stack — a diamond is fine) when `warnings` is given.
 */
function walkIncludes(
  from: string,
  scanned: Map<string, ScannedTex>,
  entries: Map<string, Entry>,
  seen: Set<string>,
  warnings: ProjectWarning[] | null,
  stack: Set<string> = new Set(),
): void {
  if (seen.has(from)) return;
  seen.add(from);
  stack.add(from);
  const scan = scanned.get(from);
  if (scan) {
    for (const d of scan.directives) {
      if (d.kind !== "input") continue;
      const resolved = resolveIncludeTarget(from, d.arg, entries);
      if (resolved.path === null) continue;
      if (stack.has(resolved.path)) {
        if (
          warnings &&
          !warnings.some((w) => w.kind === "include-cycle" && w.path === resolved.path)
        ) {
          warnings.push({
            kind: "include-cycle",
            message: `include cycle: ${from} includes ${resolved.path}, which is already on the include path`,
            path: resolved.path,
          });
        }
        continue;
      }
      walkIncludes(resolved.path, scanned, entries, seen, warnings, stack);
    }
  }
  stack.delete(from);
}

// ---------------------------------------------------------------------------
// .tex scanning (comment/verbatim-aware, the latexToTypst lexing idiom)
// ---------------------------------------------------------------------------

/** Environments whose content must NOT be scanned for directives. */
const VERBATIM_ENVS = ["verbatim", "verbatim*", "lstlisting", "minted", "comment"];

class TokenFactory {
  private n = 0;
  /** Alphanumeric-only so the token survives latexToTypst untouched. */
  next(): string {
    return `GALLEYIMPORTDIRECTIVE${this.n++}X`;
  }
}

/**
 * Matches every placeholder `TokenFactory` mints (`GALLEYIMPORTDIRECTIVE<n>X`).
 * Used for the single-pass token→rendering substitution that keeps directive
 * replacement linear in the output size (see the substitution loop above).
 */
const TOKEN_RE = /GALLEYIMPORTDIRECTIVE\d+X/g;

const INPUT_RE = /\\(input|include|subfile)\s*\{([^{}]*)\}/g;
const BIB_RE = /\\bibliography\s*\{([^{}]*)\}/g;
const ADDBIB_RE = /\\addbibresource\s*\{([^{}]*)\}/g;
const PRINTBIB_RE = /\\printbibliography(?:\s*\[[^\]]*\])?/g;
// Float-env markers interleaved with \includegraphics, walked together so a
// graphic is tokenized (→ #image) only at float depth 0; figure/table-embedded
// graphics carry no token and stay in the text for latex-to-typst's renderFloat.
// Group 1 = begin|end (float marker only), group 2 = env, group 3 = graphics arg.
const FLOAT_GRAPHICS_RE =
  /\\(begin|end)\{(figure\*?|table\*?)\}|\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g;
const GRAPHICSPATH_RE = /\\graphicspath\s*\{((?:\{[^{}]*\}|[^{}])*)\}/g;
const DOCCLASS_RE = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}/;

/**
 * Scan one .tex file: strip comments line-by-line (the `%`-cut idiom of
 * `latexToTypst`, honoring `\%`), blank verbatim-environment bodies, extract
 * the cross-file directives, and substitute placeholder tokens for the ones
 * that get rewritten to Typst after conversion.
 */
function scanTexFile(entry: Entry, tokens: TokenFactory): ScannedTex {
  const rawLines = (entry.text ?? "").split(/\r?\n/);
  const directives: Directive[] = [];
  const graphicsPaths: string[] = [];
  const outLines: string[] = [];

  let inVerbatim: string | null = null;
  let hasDocumentClass = false;
  let hasBeginDocument = false;
  let documentClass: string | null = null;
  let sawBeginDocument = false;
  let floatDepth = 0; // persists across lines for multi-line figure/table floats

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const lineNo = i + 1;

    if (inVerbatim !== null) {
      outLines.push(raw); // keep verbatim content for the converter, scan nothing
      if (raw.includes(`\\end{${inVerbatim}}`)) inVerbatim = null;
      continue;
    }

    const stripped = cutComment(raw);

    const verbOpen = VERBATIM_ENVS.find((env) => stripped.includes(`\\begin{${env}}`));
    if (verbOpen !== undefined && !stripped.includes(`\\end{${verbOpen}}`)) {
      inVerbatim = verbOpen;
      outLines.push(raw);
      continue;
    }

    const classMatch = stripped.match(DOCCLASS_RE);
    if (classMatch) {
      hasDocumentClass = true;
      documentClass = classMatch[1]!.trim();
    }
    if (stripped.includes("\\begin{document}")) {
      hasBeginDocument = true;
      sawBeginDocument = true;
    }
    const inPreamble = hasDocumentClass && !sawBeginDocument;

    let line = stripped;

    // Rewritten directives → placeholder tokens (replaced after conversion).
    line = line.replace(INPUT_RE, (_m, _cmd: string, arg: string) => {
      const token = tokens.next();
      directives.push({ kind: "input", arg: arg.trim(), line: lineNo, inPreamble, token });
      return token;
    });
    line = line.replace(BIB_RE, (_m, arg: string) => {
      const token = tokens.next();
      directives.push({ kind: "bibliography", arg: arg.trim(), line: lineNo, inPreamble, token });
      return token;
    });
    line = line.replace(ADDBIB_RE, (_m, arg: string) => {
      const token = tokens.next();
      directives.push({ kind: "addbibresource", arg: arg.trim(), line: lineNo, inPreamble, token });
      return token;
    });
    line = line.replace(PRINTBIB_RE, () => {
      const token = tokens.next();
      directives.push({ kind: "printbibliography", arg: "", line: lineNo, inPreamble, token });
      return token;
    });

    // \includegraphics: one left-to-right walk interleaving the float markers
    // with the graphics matches, so a bare graphic tokenizes to #image while a
    // figure/table-embedded one is left for renderFloat. A \begin marker opens a
    // float ONLY when it starts the trimmed line, mirroring latex-to-typst's
    // dispatcher (which treats a mid-line \begin as body text); counting a
    // mid-line \begin would suppress the graphic here yet it would never be
    // converted there, losing the image. \end matches anywhere, and floatDepth
    // carries across lines for multi-line floats.
    line = line.replace(
      FLOAT_GRAPHICS_RE,
      (
        match: string,
        marker: string | undefined,
        _env: string,
        arg: string | undefined,
        offset: number,
        source: string,
      ) => {
        if (marker !== undefined) {
          if (marker === "begin") {
            if (source.slice(0, offset).trim() === "") floatDepth++;
          } else {
            floatDepth = Math.max(0, floatDepth - 1);
          }
          return match;
        }
        const graphicArg = (arg ?? "").trim();
        if (floatDepth > 0) {
          directives.push({ kind: "includegraphics", arg: graphicArg, line: lineNo, inPreamble });
          return match;
        }
        const token = tokens.next();
        directives.push({
          kind: "includegraphics",
          arg: graphicArg,
          line: lineNo,
          inPreamble,
          token,
        });
        return token;
      },
    );

    // \graphicspath dirs — recorded only, resolved against later.
    for (const m of stripped.matchAll(GRAPHICSPATH_RE)) {
      for (const dirMatch of m[1]!.matchAll(/\{([^{}]*)\}/g)) {
        const dir = dirMatch[1]!.trim();
        if (dir.length > 0) graphicsPaths.push(dir);
      }
    }

    outLines.push(line);
  }

  return {
    entry,
    rewrittenText: outLines.join("\n"),
    directives,
    hasDocumentClass,
    hasBeginDocument,
    documentClass,
    graphicsPaths,
  };
}

/**
 * Cut an unescaped `%` comment off a line (`\%` is a literal percent; `\\%`
 * is a line break followed by a comment) — the same comment discipline as
 * `latexToTypst.convertInline`, applied before the include-graph scan.
 */
function cutComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (ch === "%") return line.slice(0, i);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Directive rendering (after latexToTypst conversion)
// ---------------------------------------------------------------------------

function renderDirective(
  d: Directive,
  fromPath: string,
  entries: Map<string, Entry>,
  bibResources: string[],
  unresolvedIncludes: UnresolvedInclude[],
  warnings: ProjectWarning[],
  graphicsDirs: string[],
): string {
  switch (d.kind) {
    case "input": {
      const resolved = resolveIncludeTarget(fromPath, d.arg, entries);
      if (resolved.path !== null) {
        // #22.2 SEC-22.2-8: escape the path before interpolating into the Typst
        // string literal so a `"`/`\` in the path can't break out of the literal.
        return `#include "${escapeTypstString(texToTypPath(resolved.path))}"`;
      }
      unresolvedIncludes.push({
        from: fromPath,
        target: d.arg,
        line: d.line,
        reason: resolved.reason,
      });
      if (resolved.reason === "outside-root") {
        warnings.push({
          kind: "path-traversal",
          message: `${fromPath} line ${d.line}: include target escapes the project root: ${d.arg}`,
          path: fromPath,
        });
      }
      return `// galley-import: unresolved include (${resolved.reason}): ${d.arg}`;
    }
    case "bibliography": {
      const paths = splitArgList(d.arg).map((part) => {
        const resolved = resolveBibTarget(fromPath, part, entries);
        if (resolved !== null) return resolved;
        const guess = normalizeOrRaw(fromPath, withDefaultExt(part, ".bib"));
        unresolvedIncludes.push({ from: fromPath, target: part, line: d.line, reason: "missing" });
        return guess;
      });
      return bibliographyCall(paths);
    }
    case "printbibliography": {
      if (bibResources.length > 0) return bibliographyCall(bibResources);
      return "// galley-import: \\printbibliography without any \\addbibresource";
    }
    case "addbibresource":
      // Declarations are collected globally; the call site emits nothing.
      return "";
    case "includegraphics":
      // #7 7C-3b: a bare (float-depth-0) graphic. resolveAssetTarget is total
      // (falls back to a normalized guess) so we always emit a root-absolute
      // #image, mirroring renderFloat's emit-regardless posture; the reference
      // is still listed in the asset manifest. SEC-22.2-8: escape the path so a
      // `"`/`\` can't break out of the Typst string literal.
      return `#image("${escapeTypstString(resolveAssetTarget(fromPath, d.arg, graphicsDirs, entries))}")`;
  }
}

function bibliographyCall(paths: string[]): string {
  // #22.2 SEC-22.2-8: escape each path before interpolating into the Typst
  // string literal(s) so a `"`/`\` in a bib path can't break out of the call.
  if (paths.length === 1) return `#bibliography("${escapeTypstString(paths[0]!)}")`;
  return `#bibliography((${paths.map((p) => `"${escapeTypstString(p)}"`).join(", ")}))`;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Normalize a path against a base directory to the root-absolute VFS form
 * ("/a/b.tex"). Returns null when `..` escapes the project root.
 */
function normalizePath(baseDir: string, raw: string): string | null {
  const joined = raw.startsWith("/") ? raw : `${baseDir}/${raw}`;
  const segments: string[] = [];
  for (const part of joined.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null; // escapes the root: REJECT
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return `/${segments.join("/")}`;
}

/** Normalize relative to `fromPath`'s dir; fall back to a root-anchored guess. */
function normalizeOrRaw(fromPath: string, raw: string): string {
  return normalizePath(dirName(fromPath), raw) ?? normalizePath("/", raw) ?? `/${raw}`;
}

/**
 * Resolve an \input/\include/\subfile target: with/without the .tex extension,
 * relative to the including file first, then to the project root (LaTeX's
 * compile-root convention). Only .tex entries qualify.
 */
function resolveIncludeTarget(
  fromPath: string,
  raw: string,
  entries: Map<string, Entry>,
): { path: string | null; reason: "missing" | "outside-root" } {
  const target = raw.trim();
  if (target.length === 0) return { path: null, reason: "missing" };
  const candidates = target.toLowerCase().endsWith(".tex") ? [target] : [`${target}.tex`, target];
  let sawTraversal = false;
  let sawValidPath = false;
  for (const base of [dirName(fromPath), "/"]) {
    for (const cand of candidates) {
      const norm = normalizePath(base, cand);
      if (norm === null) {
        if (cand.includes("..")) sawTraversal = true;
        continue;
      }
      sawValidPath = true;
      const entry = entries.get(norm);
      if (entry !== undefined && entry.kind === "tex") return { path: norm, reason: "missing" };
    }
  }
  return { path: null, reason: sawTraversal && !sawValidPath ? "outside-root" : "missing" };
}

/** Resolve a bibliography resource (default extension .bib), or null if absent. */
function resolveBibTarget(
  fromPath: string,
  raw: string,
  entries: Map<string, Entry>,
): string | null {
  const target = raw.trim();
  if (target.length === 0) return null;
  const candidates = target.toLowerCase().endsWith(".bib") ? [target] : [`${target}.bib`, target];
  for (const base of [dirName(fromPath), "/"]) {
    for (const cand of candidates) {
      const norm = normalizePath(base, cand);
      if (norm === null) continue;
      const entry = entries.get(norm);
      if (entry !== undefined && entry.kind === "bib") return norm;
    }
  }
  return null;
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".pdf", ".svg", ".eps", ".gif"];

/**
 * Best-effort \includegraphics target resolution against the including dir, the
 * root, and every \graphicspath dir, trying common image extensions when the
 * reference is extensionless. Falls back to a normalized guess (manifest only).
 */
function resolveAssetTarget(
  fromPath: string,
  raw: string,
  graphicsDirs: string[],
  entries: Map<string, Entry>,
): string {
  const target = raw.trim();
  const hasExt = /\.[A-Za-z0-9]+$/.test(target);
  const names = hasExt ? [target] : [target, ...IMAGE_EXTS.map((ext) => `${target}${ext}`)];
  // \graphicspath dirs are relative and searched against the including file's
  // dir AND the compile root — a subdir main (/paper/main.tex + {figs/}) resolves
  // /paper/figs, not just /figs. Root-relative stays second so the existing
  // corpus resolutions (root main → /figures) are unchanged.
  const fromDir = dirName(fromPath);
  const bases = [
    fromDir,
    "/",
    ...graphicsDirs.flatMap((d) => [normalizePath(fromDir, d), normalizePath("/", d)]),
  ].filter((b): b is string => b !== null);
  for (const base of bases) {
    for (const name of names) {
      const norm = normalizePath(base, name);
      if (norm !== null && entries.has(norm)) return norm;
    }
  }
  return normalizeOrRaw(fromPath, target);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function texToTypPath(path: string): string {
  return path.replace(/\.tex$/i, ".typ");
}

function dirName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function baseNameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return (dot === -1 ? base : base.slice(0, dot)).toLowerCase();
}

function withDefaultExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

/** Split a comma-separated brace argument ("a, b") into trimmed parts. */
function splitArgList(arg: string): string[] {
  return arg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyResult(warnings: ProjectWarning[]): ImportLatexProjectResult {
  return {
    files: [],
    mainPath: null,
    binaryFiles: [],
    report: {
      outcomes: [],
      unconverted: [],
      unresolvedIncludes: [],
      assets: [],
      warnings,
    },
  };
}
