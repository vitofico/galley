/** Native source bundles share the existing human review/create flow with ZIP imports. */
import {
  importLatexProject,
  type ImportLatexProjectInput,
  type ImportLatexProjectResult,
  type LatexProjectInputFile,
  type LatexProjectReport,
} from "@galley/agent";
import {
  portableWorkbenchFromTree,
  PORTABLE_WORKBENCH_PATH,
} from "@galley/collab";
import { isSafeProjectPath, isReservedProjectPath } from "@galley/shared";
import { rememberImportedBinaries } from "../binary-files.js";
import {
  MAX_ENTRY_BYTES,
  MAX_ENTRY_COUNT,
  MAX_ZIP_BYTES,
  readProjectZip,
  sanitizePath,
  ZipImportError,
} from "./import-project.js";

/** Decode ONLY the bounded regular-file ustar format emitted by bundleProject. */
export function readNativeProjectTar(
  input: ArrayBuffer | Uint8Array,
): ImportLatexProjectInput {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_ZIP_BYTES)
    throw new ZipImportError(
      "archive-too-large",
      "Source bundle exceeds the archive size limit",
    );
  const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files: LatexProjectInputFile[] = [];
  let offset = 0,
    ended = false;
  const text = (block: Uint8Array, start: number, length: number) =>
    decode.decode(block.subarray(start, start + length)).split("\0")[0]!;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    if (files.length >= MAX_ENTRY_COUNT)
      throw new ZipImportError(
        "too-many-entries",
        "Source bundle has too many files",
      );
    if (text(header, 257, 6) !== "ustar" || text(header, 345, 155))
      throw new ZipImportError(
        "bad-data",
        "Only native Galley ustar source bundles are supported",
      );
    const numeric = (start: number, length: number) => {
      const value = text(header, start, length).trim();
      if (!/^[0-7]+$/.test(value))
        throw new ZipImportError("bad-data", "Invalid tar numeric field");
      return Number.parseInt(value, 8);
    };
    const expected = numeric(148, 8);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== expected)
      throw new ZipImportError(
        "bad-data",
        "Source bundle header checksum does not match",
      );
    const path = text(header, 0, 100),
      size = numeric(124, 12),
      type = header[156];
    if (
      sanitizePath(path) !== path ||
      path.split("/").some((part) => !part || part === ".")
    )
      throw new ZipImportError(
        "unsafe-path",
        "Source bundle contains an unsafe path",
      );
    if (type !== 48 && type !== 0)
      throw new ZipImportError(
        "bad-data",
        "Source bundle contains unsupported entry types",
      );
    if (size > MAX_ENTRY_BYTES)
      throw new ZipImportError(
        "entry-too-large",
        "Source bundle entry exceeds its size limit",
      );
    if (offset + size > bytes.length)
      throw new ZipImportError("truncated", "Source bundle entry is truncated");
    const data = bytes.slice(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (path === ".galley/project.json" || path === PORTABLE_WORKBENCH_PATH)
      files.push({ path, text: decode.decode(data), bytes: data });
    else files.push({ path, binary: true, bytes: data });
  }
  if (!ended || files.length === 0)
    throw new ZipImportError("bad-data", "Not a complete native source bundle");
  // The native manifest identifies text bodies even when they have no extension.
  // Binary archive entries remain bytes unless their original text path is listed.
  const manifest = files.find((file) => file.path === ".galley/project.json");
  if (manifest?.text) {
    let declared: unknown;
    try {
      declared = JSON.parse(manifest.text).files;
    } catch {
      throw new Error("Native project manifest is invalid");
    }
    if (!Array.isArray(declared))
      throw new Error("Native project text manifest is invalid");
    const textPaths = new Set(
      declared.flatMap((entry) =>
        entry && typeof entry.path === "string" && isSafeProjectPath(entry.path)
          ? [entry.path]
          : [],
      ),
    );
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      if (file.bytes && textPaths.has(`/${file.path}`))
        files[index] = {
          path: file.path,
          text: decode.decode(file.bytes),
          bytes: file.bytes,
        };
    }
  }
  return { files };
}

/** Validate metadata before conversion can normalize/deduplicate paths. */
export function prepareProjectImport(
  tree: ImportLatexProjectInput,
  nativeOnly = false,
): ImportLatexProjectResult {
  portableWorkbenchFromTree(tree.files);
  const safeInput = tree.files.filter((file) => {
    if (file.path.includes("\\") || file.path.split("/").includes(".."))
      return false;
    const canonical = file.path.startsWith("/") ? file.path : `/${file.path}`;
    const normalized = canonical
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/");
    if (normalized !== PORTABLE_WORKBENCH_PATH) return true;
    return (
      file.path === PORTABLE_WORKBENCH_PATH ||
      file.path === `/${PORTABLE_WORKBENCH_PATH}`
    );
  });
  const manifests = tree.files.filter(
    (file) => file.path === ".galley/project.json",
  );
  if (manifests.length > 1)
    throw new Error("Native project manifest is duplicate");
  const manifest = manifests[0];
  if (manifest) {
    return preserveNativeProject(safeInput, manifest);
  }
  if (nativeOnly)
    throw new Error("Native source bundle requires a project manifest");
  return importLatexProject({ files: safeInput });
}

/** Native projects are an exact source tree, never a LaTeX conversion request. */
function preserveNativeProject(
  files: LatexProjectInputFile[],
  manifest: LatexProjectInputFile,
): ImportLatexProjectResult {
  let data: { schema?: unknown; main?: unknown; files?: unknown };
  try {
    data = JSON.parse(manifest.text ?? "");
  } catch {
    throw new Error("Native project manifest is invalid");
  }
  if (
    data.schema !== "galley.project/v1" ||
    typeof data.main !== "string" ||
    !isSafeProjectPath(data.main) ||
    !Array.isArray(data.files)
  )
    throw new Error("Native project manifest is invalid");
  const declared = new Set<string>();
  for (const entry of data.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !isSafeProjectPath(entry.path) ||
      declared.has(entry.path)
    )
      throw new Error("Native text manifest has unsafe or duplicate paths");
    declared.add(entry.path);
  }
  const result: ImportLatexProjectResult = {
    files: [],
    mainPath: data.main,
    binaryFiles: [],
    report: {
      outcomes: [],
      unconverted: [],
      unresolvedIncludes: [],
      assets: [],
      warnings: [],
    },
  };
  const report: LatexProjectReport = result.report;
  const seen = new Set<string>();
  const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const file of files) {
    const path = file.path.startsWith("/") ? file.path : `/${file.path}`;
    const workbench = path === `/${PORTABLE_WORKBENCH_PATH}`;
    if (!isSafeProjectPath(path) && !workbench) {
      report.outcomes.push({
        sourcePath: path,
        outputPath: null,
        action: "skipped",
        orphaned: false,
        note: "Reserved or unsafe path excluded",
      });
      continue;
    }
    if (seen.has(path))
      throw new Error("Native project has duplicate file paths");
    seen.add(path);
    if (declared.has(path) || workbench) {
      const text = file.bytes ? decode.decode(file.bytes) : file.text;
      if (typeof text !== "string")
        throw new Error(`Native text body is unavailable: ${path}`);
      result.files.push({ path, text });
      report.outcomes.push({
        sourcePath: path,
        outputPath: path,
        action: "passthrough",
        orphaned: false,
        note: "Native source preserved verbatim",
      });
    } else {
      const bytes =
        file.bytes ??
        (typeof file.text === "string"
          ? new TextEncoder().encode(file.text)
          : undefined);
      if (!bytes) throw new Error(`Native binary body is unavailable: ${path}`);
      result.binaryFiles.push({ path, bytes });
      report.assets.push({ path, referencedBy: [] });
      report.outcomes.push({
        sourcePath: path,
        outputPath: null,
        action: "asset",
        orphaned: false,
        note: "Native binary bytes preserved",
      });
    }
  }
  if (
    [...declared].some(
      (path) => !result.files.some((file) => file.path === path),
    ) ||
    !result.files.some((file) => file.path === data.main)
  )
    throw new Error(
      "Native project main or declared text entry is unavailable",
    );
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  result.binaryFiles.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return result;
}

export async function readProjectArchive(
  input: ArrayBuffer | Uint8Array,
  filename: string,
): Promise<ImportLatexProjectResult> {
  // Clear the cross-navigation slot before any parse so a failed pick cannot reuse old bytes.
  rememberImportedBinaries([]);
  try {
    const tree = /\.tar$/i.test(filename)
      ? readNativeProjectTar(input)
      : await readProjectZip(input, { preserveTextBytes: true });
    const result = prepareProjectImport(tree, /\.tar$/i.test(filename));
    rememberImportedBinaries(result.binaryFiles);
    return result;
  } catch (error) {
    rememberImportedBinaries([]);
    throw error;
  }
}
