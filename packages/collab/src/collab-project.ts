/**
 * `CollabProject` — a Yjs-backed MULTI-FILE Typst project (roadmap #2, ADR-0013).
 *
 * One `Y.Doc` holds every file, so create/rename/delete/setMain stay atomic and a
 * single sync connection + IndexedDB store carry the whole project (reusing the
 * Phase 2/3 machinery unchanged). Three top-level maps:
 *
 *   - `fileMeta`:  fileId → nested `Y.Map { path, deleted }`. NESTED so a
 *     concurrent rename and delete merge field-by-field instead of one clobbering
 *     the other (a plain-object value would be last-writer-wins on the whole thing).
 *   - `fileTexts`: fileId → `Y.Text` (the file's source). A deleted file's text is
 *     RETAINED (only `meta.deleted` flips), so edit history + per-author
 *     attribution survive delete and un-delete.
 *   - `projectMeta`: `{ mainFileId }`.
 *
 * Files are keyed by a STABLE `fileId`; the path is just metadata, so a rename is a
 * metadata write that preserves the file's `Y.Text` (and its attribution). This is
 * the single-file `CollabDocument` design generalized to N files; it stays
 * framework-agnostic (yjs only — no React, DOM, or network).
 *
 * Design validated by the Architect (GPT) review recorded in ADR-0013. Same-field
 * concurrent writes (rename-vs-rename, setMain-vs-setMain, delete-vs-undelete)
 * remain last-writer-wins by Yjs map semantics — acceptable and tested.
 */
import * as Y from "yjs";
import type { Author, ProjectFile, ProjectInput } from "@galley/shared";
import { authorOrigin } from "./collab-document.js";
import type { BinaryAsset } from "./binary-assets.js";

const FILE_META = "fileMeta";
const FILE_TEXTS = "fileTexts";
const PROJECT_META = "projectMeta";
const MAIN_FILE_ID = "mainFileId";
// #7 slice 7B: binary files carry only a content-addressed POINTER in the CRDT
// (path/hash/size/mime/deleted); the bytes live in a BlobStore beside the doc.
// A separate map keeps the text-file state byte-for-byte and the doc empty of
// binaries until one is added.
const BINARY_META = "binaryMeta";

/** Project file paths are absolute; canonicalize to a leading slash everywhere. */
function canonicalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** A pristine doc has no client entries in its state vector (no writes ever). */
function hasHistory(ydoc: Y.Doc): boolean {
  return Y.decodeStateVector(Y.encodeStateVector(ydoc)).size > 0;
}

/** A unique, collision-free-across-peers file id. Injectable for tests. */
export type FileIdGenerator = () => string;

/** A file's current state (a flattened view of its meta + text). */
export interface ProjectFileSnapshot {
  fileId: string;
  path: string;
  text: string;
  deleted: boolean;
}

/** A binary file's current state (a flattened view of its pointer meta). */
export interface BinaryFileSnapshot {
  fileId: string;
  path: string;
  /** sha256 of the bytes — the BlobStore key (bytes are NOT in the CRDT). */
  hash: string;
  size: number;
  mime: string;
  deleted: boolean;
}

/** The whole project's state, with files sorted deterministically by [path, id]. */
export interface ProjectSnapshot {
  files: ProjectFileSnapshot[];
  mainFileId: string | null;
  duplicatePaths: string[];
  /**
   * Binary files (pointers; bytes live in a BlobStore). Present ONLY when the
   * project has binaries — omitted otherwise so existing text-only snapshots are
   * byte-for-byte unchanged. Paths collide with text files in `duplicatePaths`.
   */
  binaryFiles?: BinaryFileSnapshot[];
}

/** One file to seed (path + initial source). */
export interface SeedFile {
  path: string;
  text: string;
}

export class CollabProject {
  readonly doc: Y.Doc;
  private readonly fileMeta: Y.Map<Y.Map<unknown>>;
  private readonly fileTexts: Y.Map<Y.Text>;
  private readonly binaryMeta: Y.Map<Y.Map<unknown>>;
  private readonly projectMeta: Y.Map<unknown>;
  private readonly genId: FileIdGenerator;
  private counter: number;

  constructor(doc: Y.Doc = new Y.Doc(), opts: { newId?: FileIdGenerator } = {}) {
    this.doc = doc;
    this.fileMeta = doc.getMap<Y.Map<unknown>>(FILE_META);
    this.fileTexts = doc.getMap<Y.Text>(FILE_TEXTS);
    this.binaryMeta = doc.getMap<Y.Map<unknown>>(BINARY_META);
    this.projectMeta = doc.getMap<unknown>(PROJECT_META);
    // Default id: `${clientID}-${counter}`. clientID is unique per Y.Doc instance
    // (reassigned on reload, so persisted ids keep their old prefix). Guard the
    // counter past any existing id for THIS clientID so re-wrapping the same live
    // doc can't reissue an id (Architect review).
    this.counter = this.maxCounterForClient() + 1;
    this.genId = opts.newId ?? (() => `${this.doc.clientID}-${this.counter++}`);
  }

  private maxCounterForClient(): number {
    const prefix = `${this.doc.clientID}-`;
    let max = -1;
    // Scan BOTH file maps so a binary and a text file can never be issued the
    // same `${clientID}-${counter}` id after a reload.
    for (const id of [...this.fileMeta.keys(), ...this.binaryMeta.keys()]) {
      if (!id.startsWith(prefix)) continue;
      const n = Number(id.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max;
  }

  /** Add a file's meta + text. MUST be called inside a `doc.transact`. */
  private addFile(id: string, path: string, text: string): void {
    const meta = new Y.Map<unknown>();
    meta.set("path", canonicalizePath(path));
    meta.set("deleted", false);
    this.fileMeta.set(id, meta);
    const ytext = new Y.Text();
    if (text.length > 0) ytext.insert(0, text);
    this.fileTexts.set(id, ytext);
  }

  /**
   * Create a file (atomic: meta + text + content, and main if it's the first
   * file). Returns the new fileId. Creating a path that already exists is allowed
   * — the resulting duplicate surfaces via {@link duplicatePaths} (concurrent
   * creates can't be prevented; the UI blocks compile until resolved).
   */
  create(path: string, text: string, author: Author): string {
    const id = this.genId();
    this.doc.transact(() => {
      this.addFile(id, path, text);
      if (this.projectMeta.get(MAIN_FILE_ID) === undefined) {
        this.projectMeta.set(MAIN_FILE_ID, id);
      }
    }, authorOrigin(author));
    return id;
  }

  /** Rename a file (metadata only — its Y.Text, history, and attribution stay). */
  rename(fileId: string, newPath: string, author: Author): void {
    const meta = this.requireMeta(fileId, "rename");
    this.doc.transact(() => meta.set("path", canonicalizePath(newPath)), authorOrigin(author));
  }

  /** Tombstone a file. Its Y.Text is retained so it can be restored intact. */
  delete(fileId: string, author: Author): void {
    const meta = this.requireMeta(fileId, "delete");
    this.doc.transact(() => meta.set("deleted", true), authorOrigin(author));
  }

  /** Un-delete a tombstoned file (content + attribution come back unchanged). */
  restore(fileId: string, author: Author): void {
    const meta = this.requireMeta(fileId, "restore");
    this.doc.transact(() => meta.set("deleted", false), authorOrigin(author));
  }

  /** Point the project's main file at `fileId` (must exist and be live). */
  setMain(fileId: string, author: Author): void {
    const meta = this.requireMeta(fileId, "setMain");
    if (meta.get("deleted") === true) {
      throw new Error(`setMain: ${fileId} is deleted`);
    }
    this.doc.transact(() => this.projectMeta.set(MAIN_FILE_ID, fileId), authorOrigin(author));
  }

  /** Edit a file's source in one author-tagged transaction (for an editor binding). */
  transactFile(fileId: string, mutate: (text: Y.Text) => void, author: Author): void {
    const text = this.fileTexts.get(fileId);
    if (!text) throw new Error(`transactFile: unknown fileId ${fileId}`);
    this.doc.transact(() => mutate(text), authorOrigin(author));
  }

  private requireMeta(fileId: string, op: string): Y.Map<unknown> {
    const meta = this.fileMeta.get(fileId);
    if (!meta) throw new Error(`${op}: unknown fileId ${fileId}`);
    return meta;
  }

  // ---- #7 slice 7B: binary files (content-addressed pointers) ----------------

  /**
   * Add a binary file pointer (path + a content-addressed {@link BinaryAsset}).
   * The bytes are NOT stored here — they belong in a BlobStore keyed by
   * `asset.hash`. Never sets `mainFileId` (the compile entry is always a text
   * file). Returns the new fileId. A duplicate path surfaces via
   * {@link duplicatePaths} (across text AND binary), exactly like text creates.
   */
  createBinary(path: string, asset: BinaryAsset, author: Author): string {
    const id = this.genId();
    this.doc.transact(() => {
      const meta = new Y.Map<unknown>();
      meta.set("path", canonicalizePath(path));
      meta.set("hash", asset.hash);
      meta.set("size", asset.size);
      meta.set("mime", asset.mime);
      meta.set("deleted", false);
      this.binaryMeta.set(id, meta);
    }, authorOrigin(author));
    return id;
  }

  /** Rename a binary file (pointer metadata only; the blob is untouched). */
  renameBinary(fileId: string, newPath: string, author: Author): void {
    const meta = this.requireBinaryMeta(fileId, "renameBinary");
    this.doc.transact(() => meta.set("path", canonicalizePath(newPath)), authorOrigin(author));
  }

  /** Tombstone a binary file (the blob is retained so it can be restored). */
  deleteBinary(fileId: string, author: Author): void {
    const meta = this.requireBinaryMeta(fileId, "deleteBinary");
    this.doc.transact(() => meta.set("deleted", true), authorOrigin(author));
  }

  /** Un-delete a tombstoned binary file. */
  restoreBinary(fileId: string, author: Author): void {
    const meta = this.requireBinaryMeta(fileId, "restoreBinary");
    this.doc.transact(() => meta.set("deleted", false), authorOrigin(author));
  }

  private requireBinaryMeta(fileId: string, op: string): Y.Map<unknown> {
    const meta = this.binaryMeta.get(fileId);
    if (!meta) throw new Error(`${op}: unknown binary fileId ${fileId}`);
    return meta;
  }

  /** A binary file's flattened current state, or undefined if unknown. */
  getBinary(fileId: string): BinaryFileSnapshot | undefined {
    const meta = this.binaryMeta.get(fileId);
    if (!meta) return undefined;
    return {
      fileId,
      path: canonicalizePath(String(meta.get("path") ?? "")),
      hash: String(meta.get("hash") ?? ""),
      size: Number(meta.get("size") ?? 0),
      mime: String(meta.get("mime") ?? "application/octet-stream"),
      deleted: meta.get("deleted") === true,
    };
  }

  /** All binary files (including tombstoned), sorted deterministically by [path, id]. */
  private allBinaryFiles(): BinaryFileSnapshot[] {
    const out: BinaryFileSnapshot[] = [];
    for (const id of this.binaryMeta.keys()) {
      const f = this.getBinary(id);
      if (f) out.push(f);
    }
    out.sort((a, b) => (a.path === b.path ? cmp(a.fileId, b.fileId) : cmp(a.path, b.path)));
    return out;
  }

  /** The shared `Y.Text` for a file (e.g. to bind to CodeMirror), or undefined. */
  fileText(fileId: string): Y.Text | undefined {
    return this.fileTexts.get(fileId);
  }

  /** The current main fileId, or null if none set. */
  mainFileId(): string | null {
    const id = this.projectMeta.get(MAIN_FILE_ID);
    return typeof id === "string" ? id : null;
  }

  /** A file's flattened current state, or undefined if unknown. */
  getFile(fileId: string): ProjectFileSnapshot | undefined {
    const meta = this.fileMeta.get(fileId);
    if (!meta) return undefined;
    return {
      fileId,
      path: canonicalizePath(String(meta.get("path") ?? "")),
      text: this.fileTexts.get(fileId)?.toString() ?? "",
      deleted: meta.get("deleted") === true,
    };
  }

  /** All files (including tombstoned), sorted deterministically by [path, id]. */
  private allFiles(): ProjectFileSnapshot[] {
    const out: ProjectFileSnapshot[] = [];
    for (const id of this.fileMeta.keys()) {
      const f = this.getFile(id);
      if (f) out.push(f);
    }
    out.sort((a, b) => (a.path === b.path ? cmp(a.fileId, b.fileId) : cmp(a.path, b.path)));
    return out;
  }

  /**
   * Canonical paths held by more than one LIVE file (a compile-blocking conflict).
   * Counts text AND binary files together — compile/export can't represent two
   * files at one path, so a text↔binary collision is just as blocking.
   */
  duplicatePaths(): string[] {
    const counts = new Map<string, number>();
    for (const f of this.allFiles()) {
      if (f.deleted) continue;
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
    for (const f of this.allBinaryFiles()) {
      if (f.deleted) continue;
      counts.set(f.path, (counts.get(f.path) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p).sort(cmp);
  }

  /** A deterministic snapshot of the whole project. */
  snapshot(): ProjectSnapshot {
    const binaryFiles = this.allBinaryFiles();
    return {
      files: this.allFiles(),
      mainFileId: this.mainFileId(),
      duplicatePaths: this.duplicatePaths(),
      // Omit when empty so existing text-only snapshots stay byte-for-byte.
      ...(binaryFiles.length > 0 ? { binaryFiles } : {}),
    };
  }

  /**
   * Build a {@link ProjectInput} for the compiler from the LIVE files, or null if
   * the project can't compile yet: no main set, the main file is deleted, or two
   * live files share a path (duplicate-path conflict). We never silently pick a
   * winner — an unresolved conflict is the user's to resolve (Architect review).
   */
  toProjectInput(): ProjectInput | null {
    const mainId = this.mainFileId();
    if (mainId === null) return null;
    const mainMeta = this.fileMeta.get(mainId);
    if (!mainMeta || mainMeta.get("deleted") === true) return null;
    if (this.duplicatePaths().length > 0) return null;
    const files: ProjectFile[] = this.allFiles()
      .filter((f) => !f.deleted)
      .map((f) => ({ path: f.path, text: f.text }));
    return { kind: "project", files, main: canonicalizePath(String(mainMeta.get("path") ?? "")) };
  }

  /**
   * M13: a cheap content-revision string — the doc's state vector. It advances on
   * EVERY content change (a text edit, file add / rename / delete / restore, or a
   * set-main) but NOT on awareness/cursor moves (awareness lives outside the doc).
   * Because it is a SUPERSET of every compile-relevant input, the shell can
   * memoize the expensive {@link toProjectInput} materialization (and the compile
   * key) on it WITHOUT ever skipping a needed recompile — at worst it recomputes
   * for an unrelated doc change, which is harmless. This replaces re-serializing
   * every file's text on each render (a plain cursor move used to re-materialize
   * + re-stringify the whole project); the state vector is O(collaborators), not
   * O(total source length).
   */
  revision(): string {
    const sv = Y.encodeStateVector(this.doc);
    let s = "";
    for (const b of sv) s += (b < 16 ? "0" : "") + b.toString(16);
    return s;
  }

  /**
   * Seed the project's initial files — ONLY if the doc is pristine (no CRDT
   * history). Gating on history (not "is the map empty") is the same safe gate as
   * single-file `seedIfPristine`: a peer that received state, or a restored draft,
   * is non-pristine and must not re-seed (else duplicated files/content). The
   * whole seed is one transaction. Returns the created fileIds, or null if it
   * didn't seed.
   */
  seedIfPristine(files: SeedFile[], mainPath: string, author: Author): string[] | null {
    if (files.length === 0) return null;
    if (hasHistory(this.doc)) return null;
    const created: string[] = [];
    const wantMain = canonicalizePath(mainPath);
    this.doc.transact(() => {
      let mainId: string | undefined;
      for (const f of files) {
        const id = this.genId();
        created.push(id);
        this.addFile(id, f.path, f.text);
        if (canonicalizePath(f.path) === wantMain) mainId = id;
      }
      this.projectMeta.set(MAIN_FILE_ID, mainId ?? created[0]);
    }, authorOrigin(author));
    return created;
  }

  /** Encode full doc state (to seed a fresh peer / persist). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Merge another peer's update into this project. */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/** Stable string comparison (avoids locale-dependent default sort). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
