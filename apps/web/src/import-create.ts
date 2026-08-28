/**
 * `importProjectFromZip` — create a NEW project from a converted Overleaf/LaTeX
 * zip tree and navigate to it (project-model redesign §3, relocated from
 * `ProjectApp` to the Projects page).
 *
 * Extracted verbatim from the old in-editor `onImportProject` so the import flow
 * can live on the Projects page (where it belongs — a zip is usually a whole
 * project) instead of the document's Insert menu. The CURRENT project, if any,
 * is left completely untouched; on failure nothing is navigated to.
 *
 * Text-only imports take the byte-for-byte `createProject` path; imports that
 * carry binaries pre-mint the id so the bytes land in the new project's BlobStore
 * and the CRDT pointers are stashed BEFORE navigation (the navigation-order fix).
 */
import type { LatexProjectReport, ProjectTextFile } from "@galley/agent";
import { toSafeProjectFiles } from "./components/import-project.js";
import {
  normalizeImportedBinaries,
  takeImportedBinaries,
  setPendingBinarySeed,
  type PendingBinaryPointer,
} from "./binary-files.js";
import { PersistentBlobStore, IndexeddbBlobBackend, blobDbName } from "./idb-blob-store.js";
import { createProject, projectNameFromZipFilename } from "./project-create.js";
import { navigate } from "./router.js";

/** Mint a `proj-…` id (pre-minted for the binary path so bytes land in its DB). */
function mintImportProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const token =
    c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `proj-${token}`;
}

/**
 * Create a new project from the converted `files` (+ any recorded binaries) and
 * navigate to `/p/<id>`. Returns `false` when nothing safe survives the VFS gate
 * (so the caller keeps its review panel open); `true` once the new project is
 * created and navigation has fired.
 */
export async function importProjectFromZip(
  files: ProjectTextFile[],
  report: LatexProjectReport,
  filename: string,
): Promise<boolean> {
  // Gate the FINAL (`/`-rooted) paths through the project VFS predicate the
  // version stores enforce: importLatexProject rewrites paths (.tex→.typ), so a
  // path that passed the zip-reader's input gate can still be VFS-unsafe (control
  // chars, the reserved `/.galley` namespace). Drop those rather than poison the
  // new project. The dropped paths are surfaced at REVIEW time before Accept.
  const { kept } = toSafeProjectFiles(files);
  if (kept.length === 0) return false;
  // Choose main by PATH: the converted main if the report names one (and it
  // survived the gate), else the first .typ file, else the first kept file.
  const mainRef =
    report.outcomes.find((o) => o.action === "converted" && o.outputPath)?.outputPath ?? null;
  const preferredMain =
    kept.find((f) => f.path === mainRef)?.path ??
    kept.find((f) => f.path.toLowerCase().endsWith(".typ"))?.path ??
    kept[0]!.path;

  // The binary bytes for THIS import, recorded by the zip reader into the
  // in-process handoff slot. Canonicalize + safety-gate them with the SAME VFS
  // predicate the text path uses; an empty set is the default-safe text-only path.
  const importedBinaries = normalizeImportedBinaries(takeImportedBinaries());

  if (importedBinaries.length === 0) {
    // Text-only import — byte-for-byte the existing path.
    await createProject({
      kind: "import",
      files: kept.map((f) => ({ path: f.path, text: f.text })),
      mainPath: preferredMain,
      demoHistory: false,
      name: projectNameFromZipFilename(filename),
    });
    return true;
  }

  // Binary import: persist the bytes into the NEW project's BlobStore and stash
  // the CRDT pointers for its boot to create (after the text seed). Pre-mint the
  // id so we can (a) target the right blob DB and (b) stash pointers BEFORE
  // navigation, then navigate manually — `createProject`'s own navigate is
  // suppressed so it can't mount the new ProjectApp before the handoff exists.
  const newId = mintImportProjectId();
  const newBlobStore = (() => {
    try {
      if (typeof indexedDB === "undefined") return null;
      return new PersistentBlobStore(new IndexeddbBlobBackend(blobDbName(newId)));
    } catch {
      return null;
    }
  })();
  const pointers: PendingBinaryPointer[] = [];
  if (newBlobStore) {
    for (const b of importedBinaries) {
      try {
        // `put` is content-addressed (dedup) + infers the mime from bytes/path.
        // Servable-provenance: this staging `put` is deliberately NEUTRAL — the
        // bytes exist but MUST NOT become servable here. The trusted local action
        // is the user COMMITTING the reviewed import; the servable grant lands only
        // once these pointers are applied at the new project's boot (ProjectApp's
        // pending-binary-seed effect, `markServable` after `createBinary`). Do NOT
        // add a `markServable` here — that would grant pre-commit (staged) bytes.
        const asset = await newBlobStore.put(b.bytes, { filename: b.path });
        pointers.push({ path: b.path, asset });
      } catch {
        /* a single blob failure skips that asset; the import continues */
      }
    }
  }

  await createProject(
    {
      kind: "import",
      files: kept.map((f) => ({ path: f.path, text: f.text })),
      mainPath: preferredMain,
      demoHistory: false,
      name: projectNameFromZipFilename(filename),
    },
    { newId: () => newId, navigate: () => undefined },
  );
  if (pointers.length > 0) setPendingBinarySeed(newId, pointers);
  navigate(`/p/${encodeURIComponent(newId)}`);
  return true;
}
