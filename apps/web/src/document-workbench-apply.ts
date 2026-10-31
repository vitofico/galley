import type { CompileInput } from "@galley/shared";
import { compileInputKey } from "./useCompiler.js";
import { resolveAccept } from "./accept.js";
import {
  readWorkbench,
  WORKBENCH_PATH,
  type WorkbenchFile,
} from "./document-workbench.js";
export interface WorkbenchAcceptRequest {
  targetFileId: string;
  targetPath: string;
  baseSource: string;
  finalSource: string;
  blocks: { search: string; replace: string }[];
  expectedMetadata: string;
  nextMetadata: string;
  expectedSources: { path: string; text: string }[];
  compiled: boolean;
  expectedInputKey: string;
  expectedScratchInputKey: string;
}
/** Pure preflight for the existing atomic multi-file Accept seam; no writes on failure. */
export function planWorkbenchAccept(
  files: WorkbenchFile[],
  activeFileId: string | null,
  run: WorkbenchAcceptRequest,
  currentInput: CompileInput,
) {
  if (!run.compiled)
    throw new Error(
      "Compile the scratch proposal successfully before accepting",
    );
  if (
    compileInputKey(currentInput) !== run.expectedInputKey ||
    compileInputKey(
      workbenchScratchInput(
        currentInput,
        run.targetPath,
        run.finalSource,
        run.nextMetadata,
      ),
    ) !== run.expectedScratchInputKey
  )
    throw new Error("Project compile input changed; compile a new preview");
  const target = files.find((f) => f.fileId === run.targetFileId);
  if (
    activeFileId !== run.targetFileId ||
    !target ||
    target.path !== run.targetPath
  )
    throw new Error("Target document changed; preview again");
  const metadata = files.filter((f) => f.path === WORKBENCH_PATH);
  if (metadata.length > 1 || (metadata[0]?.text ?? "") !== run.expectedMetadata)
    throw new Error("Workbench metadata changed; preview again");
  readWorkbench(run.nextMetadata);
  for (const expected of run.expectedSources) {
    const matches = files.filter((f) => f.path === expected.path);
    if (matches.length !== 1 || matches[0]!.text !== expected.text)
      throw new Error("Source dependency changed; preview again");
  }
  const outcome = resolveAccept(
    target.text,
    run.baseSource,
    run.finalSource,
    run.blocks,
  );
  if (!outcome.applied)
    throw new Error("Linked passage changed; relink and preview again");
  return {
    creates: metadata.length
      ? []
      : [{ path: WORKBENCH_PATH, text: run.nextMetadata }],
    edits: [
      { fileId: target.fileId, source: outcome.source! },
      ...(metadata[0]
        ? [{ fileId: metadata[0].fileId, source: run.nextMetadata }]
        : []),
    ],
  };
}

export function workbenchScratchInput(
  input: CompileInput,
  path: string,
  source: string,
  metadata?: string,
): CompileInput {
  if (typeof input === "string") return source;
  if (input.files.filter((file) => file.path === path).length !== 1)
    throw new Error("Compile target missing or ambiguous");
  const files = input.files
    .filter((file) => metadata === undefined || file.path !== WORKBENCH_PATH)
    .map((file) => (file.path === path ? { ...file, text: source } : file));
  if (metadata !== undefined)
    files.push({ path: WORKBENCH_PATH, text: metadata });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...input, files };
}
