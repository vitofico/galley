/**
 * @galley/agent — the agent loop, tools, and provider abstraction.
 *
 * Design rules (see docs/agent-loop.md, ADR-0002, ADR-0003):
 *   - Framework-agnostic: no React, no DOM, no app state. Depends only on
 *     @galley/shared and an injected compiler + model client.
 *   - The Vercel AI SDK lives BEHIND the LanguageModelClient interface so the
 *     rest of the loop never imports it directly (swappable, testable).
 *   - The loop operates on a SCRATCH copy and emits AgentEvents; it never
 *     touches live document state and never auto-applies.
 *
 * Implemented (M2 core, deterministic): applyEdits + runAgent, tested with a
 * fake model + fake compiler. The real AI-SDK-backed client lands in M1.
 */

// The model-conversation seam (the only model interface the loop knows).
export type {
  LanguageModelClient,
  ModelMessage,
  ModelRole,
  ModelStep,
  ModelTextDelta,
  ModelToolCall,
  ModelTurnInput,
  ToolSpec,
} from "./model.js";
// Multimodal message content helpers (image-capable turns).
export { messageText } from "./model.js";
export type { ContentPart } from "./model.js";

// Search/replace editing primitive (docs/editing-and-diff.md).
export { applyEdits, normalizeNewlines } from "./apply-edits.js";

// Tool specs + formatting helpers (docs/agent-loop.md).
export {
  AGENT_TOOLS,
  SYSTEM_PROMPT,
  formatCheckForModel,
  formatFailuresForModel,
  lineNumbered,
  parseEdits,
} from "./tools.js";

// The shared tool registry (roadmap #3): one typed source of truth for tool
// specs + behavior, consumed by the internal loop now and the MCP responder
// later (via the pure, unmounted adapter in apps/web). The legacy arrays
// (AGENT_TOOLS/RETRIEVAL_TOOLS) are derivations from it.
export {
  TOOL_REGISTRY,
  PROJECT_TOOL_CAPS,
  PROJECT_TOOL_SPECS,
  offeredToolSpecs,
  offeredEntry,
  escapeControlChars,
} from "./tool-registry.js";
export type {
  ProjectFileEntry,
  ProjectSearchFileLike,
  ProjectSearchMatchLike,
  ProjectSearchResultLike,
  ProjectToolsSeam,
  ToolAccess,
  ToolLoopState,
  ToolRegistryEntry,
  ToolRunResult,
  ToolSeams,
} from "./tool-registry.js";

// The iterate-until-clean loop and its injected-compiler contract.
export { runAgent } from "./run-agent.js";
export type { AgentCompiler, AgentRunResult, RunAgentOptions } from "./run-agent.js";

// `.galley/instructions` steering + deterministic constraints (roadmap 14-D).
export {
  checkConstraints,
  constraintViolationsToDiagnostics,
  countWords,
  formatConstraintViolationsForModel,
  hasConstraints,
  parseInstructions,
  stripTypstMarkup,
} from "./instructions.js";
export type {
  AgentInstructions,
  ConstraintViolation,
  DocumentConstraints,
  InstructionsWarning,
  ParsedInstructions,
} from "./instructions.js";

// Provider transport resolution + honest privacy copy.
export {
  privacyPosture,
  privacyStatement,
  redactedConfig,
  resolveTransport,
} from "./provider-transport.js";
export type { PrivacyPosture, ResolvedTransport } from "./provider-transport.js";

// The default AI-SDK-backed LanguageModelClient (the adapter; ADR-0002).
export { createModelClient, classifyProbeError } from "./model-client.js";
export { listModels } from "./list-models.js";
export type { ListModelsResult } from "./list-models.js";

// Context economics (roadmap #9): the Typst document chunker + retrieval.
export { chunkDocument } from "./chunk.js";
export type { Chunk, ChunkOptions } from "./chunk.js";
export { rankChunks, selectContext, cosineSimilarity, rankBySimilarity } from "./retrieve.js";
export type { Retrieved, SelectOptions, Embedder } from "./retrieve.js";
// Retrieval-aware read_document integration (slice 3a): the per-run context option.
export {
  DEFAULT_THRESHOLD_CHARS,
  DEFAULT_SELECT_MAX_CHARS,
  DEFAULT_CHUNK_MAX_CHARS,
} from "./context-view.js";
export type { RetrievalContextOptions, ChunkRanker } from "./context-view.js";

// Cross-reference labels (roadmap #13): the offline label/ref index.
export {
  buildLabelIndex,
  findBrokenRefs,
  findUnusedLabels,
  labelNames,
} from "./labels.js";
export type { LabelDef, LabelRef, LabelIndex } from "./labels.js";

// Citation ergonomics (roadmap #6): DOI/BibTeX → Hayagriva + cite-key tooling.
export {
  detectInputKind,
  parseBibtex,
  toHayagriva,
  makeCiteKey,
  dedupeEntries,
  crossrefToEntry,
  fetchCitation,
  CitationFetchError,
} from "./citation.js";
export type {
  CitationInputKind,
  CitationEntry,
  BibtexParseStats,
  CrossrefMessage,
  CrossrefEnvelope,
} from "./citation.js";

// Bibliography → cite-key feed (roadmap #6): a library string → ordered keys.
export { parseBibliography, citeKeysFromBibliography } from "./bibliography.js";

// Citation library deduplication (roadmap #6): detect + MERGE duplicate entries
// already present in the user's bibliography, user-initiated, preview-able, applied
// as one undoable rewrite. Pure — no React/DOM/network.
export {
  detectDuplicateGroups,
  mergeGroup,
  deduplicateEntries,
  deduplicateBibliographySource,
  toBibtex,
} from "./citation-dedup.js";
export type {
  DeduplicateResult,
  DeduplicateSourceResult,
} from "./citation-dedup.js";

// Broken-reference diagnostics (roadmap #13.3): compose the label index with
// known citation keys so `@cite` keys aren't falsely flagged as broken `@refs`.
export { refDiagnostics, unusedLabelDiagnostics } from "./ref-check.js";

// Figure/sketch → Typst (CeTZ) core (roadmap #8): describe → compilable snippet.
export { figureToTypst, cetzScaffold } from "./figure-to-typst.js";
export type { FigureRequest, FigureResult, FigureDeps } from "./figure-to-typst.js";

// Cross-file broken-reference diagnostics (roadmap #13.3): resolve `@refs` against
// the project-wide `<label>` union (+ cite keys), path-qualified — no false positive
// on a label defined in a sibling file.
export { allProjectLabelNames, crossFileRefDiagnostics } from "./cross-file-labels.js";
export type { ProjectTextFile } from "./cross-file-labels.js";

// Import wedge (roadmap #15): deterministic Markdown/LaTeX → Typst, with an honest
// report of constructs that didn't map (the agent loop repairs the rest).
export { markdownToTypst } from "./md-to-typst.js";
export type { MdConvertResult, UnmappedConstruct } from "./md-to-typst.js";
export { latexToTypst } from "./latex-to-typst.js";
export type { LatexConvertResult, UnconvertedItem } from "./latex-to-typst.js";
// Agent-assisted import repair (roadmap #15): take a lossy deterministic
// conversion and iterate convert→compile→self-correct until it compiles clean.
export { repairImportedTypst } from "./import-repair.js";
export type {
  ImportRepairRequest,
  ImportRepairResult,
  ImportRepairDeps,
} from "./import-repair.js";

// Overleaf/LaTeX multi-file project migration core (roadmap #17.3): an
// already-unpacked project tree → Typst file map (+ honest migration report).
export { importLatexProject } from "./import-latex-project.js";
export type {
  ImportLatexProjectInput,
  ImportLatexProjectResult,
  ImportedBinaryFile,
  LatexProjectInputFile,
  LatexProjectReport,
  ProjectFileAction,
  ProjectFileOutcome,
  ProjectAssetRef,
  ProjectWarning,
  UnresolvedInclude,
} from "./import-latex-project.js";

// Reference import (roadmap #6): BibTeX/RIS reference files -> CitationEntry[].
export {
  importReferences,
  importReferencesDetailed,
  parseRis,
  countRisRecords,
  detectImportFormat,
} from "./reference-import.js";
export type { ImportFormat, ImportReferencesResult } from "./reference-import.js";

// Literature search (roadmap #6): Crossref query -> candidate works.
export { searchLiterature, searchLiteratureDetailed, buildSearchUrl } from "./literature-search.js";
export type { LiteratureSearchOutcome } from "./literature-search.js";

// Literature search — arXiv source (roadmap #6): a SECOND search backend behind
// the SAME injected-fetch seam; XXE/DoS-safe hand-rolled Atom parse, with
// Crossref's discriminated failure/empty outcome.
export {
  searchArxiv,
  searchArxivDetailed,
  buildArxivSearchUrl,
} from "./arxiv-search.js";

// Literature search — OpenAlex source: a THIRD search backend (open, key-free,
// CORS) behind the SAME injected-fetch seam; JSON, with Crossref's discriminated
// failure/empty outcome.
export {
  searchOpenAlex,
  searchOpenAlexDetailed,
  buildOpenAlexSearchUrl,
} from "./openalex-search.js";

// Literature search — Semantic Scholar source: a FOURTH search backend (CORS,
// key-optional, rich CS/bio coverage) behind the SAME injected-fetch seam; JSON,
// with Crossref's discriminated failure/empty outcome.
export {
  searchSemanticScholar,
  searchSemanticScholarDetailed,
  buildSemanticScholarSearchUrl,
} from "./semantic-scholar-search.js";

// Zotero library pull (roadmap #17.1): read-only Web API v3 client core —
// injected fetch, fixed host, fail-closed (ADR-0016 posture).
export {
  fetchZoteroLibrary,
  ZOTERO_API_BASE,
  ZOTERO_PAGE_LIMIT,
  ZOTERO_MAX_PAGES,
  ZOTERO_MAX_RESPONSE_CHARS,
} from "./zotero-library.js";
export type {
  ZoteroLibraryRef,
  FetchZoteroLibraryOptions,
  FetchZoteroLibraryResult,
  ZoteroFetchDeps,
  ZoteroError,
  ZoteroErrorKind,
} from "./zotero-library.js";

// Mendeley library pull (roadmap #17.1): read-only Web API client core for the
// authenticated user's own library — injected fetch, fixed host, paste-a-token
// bearer auth (no OAuth redirect in OSS), fail-closed (ADR-0016 posture).
export {
  fetchMendeleyLibrary,
  MENDELEY_API_BASE,
  MENDELEY_PAGE_LIMIT,
  MENDELEY_MAX_PAGES,
  MENDELEY_MAX_RESPONSE_CHARS,
} from "./mendeley-library.js";
export type {
  FetchMendeleyLibraryOptions,
  FetchMendeleyLibraryResult,
  MendeleyFetchDeps,
  MendeleyError,
  MendeleyErrorKind,
} from "./mendeley-library.js";

// Visual layout feedback (roadmap #8): rendered page image -> layout critique.
export { judgeLayout } from "./visual-feedback.js";
export type {
  LayoutFeedback,
  VisualFeedbackInput,
  FeedbackImage,
} from "./visual-feedback.js";

// Figure alt-text (roadmap #8): rendered figure image -> accessible description.
export { suggestAltText } from "./figure-alt-text.js";
export type { AltTextInput, AltTextImage } from "./figure-alt-text.js";

// Figure-from-sketch (roadmap #8): hand sketch image -> compilable CeTZ figure.
export { figureFromSketch } from "./figure-from-sketch.js";
export type { SketchFigureInput, SketchImage } from "./figure-from-sketch.js";

// Contribution reconstruction (roadmap #13): PURE, read-only, deterministic
// drafter of a CRediT-style author-contribution statement from injected
// evidence (version `contributors` from #11, per-section authorship from #12).
// UI wiring (real versions/blame + Accept-gated insertion) is a later slice.
export {
  buildContributionStatement,
  renderContributionStatement,
  CREDIT_ROLES,
} from "./contribution-statement.js";
export type {
  CreditRole,
  ContributionSnapshot,
  SectionAttribution,
  ContributionInput,
  AuthorContribution,
  ContributionStatement,
  RenderContributionOptions,
} from "./contribution-statement.js";
