import { describe, expect, it } from "vitest";
import { CollabProject } from "@galley/collab";
import type { CompileInput, ProjectInput } from "@galley/shared";
import {
  planWorkbenchAccept,
  workbenchScratchInput,
  type WorkbenchAcceptRequest,
} from "./document-workbench-apply.js";
import {
  emptyWorkbench,
  WORKBENCH_PATH,
  type WorkbenchFile,
} from "./document-workbench.js";
import { compileInputKey } from "./useCompiler.js";
import { applyAcceptedFileSetAsAgent } from "./project-session.js";
const metadata = JSON.stringify(emptyWorkbench());
const files: WorkbenchFile[] = [
  { fileId: "doc", path: "/main.typ", text: "Revenue 12" },
  { fileId: "data", path: "/data.json", text: '{"x":24}' },
  { fileId: "helper", path: "/helper.typ", text: "Helper" },
  { fileId: "meta", path: WORKBENCH_PATH, text: metadata },
];
const inputOf = (files: WorkbenchFile[]): ProjectInput => ({
  kind: "project",
  main: "/main.typ",
  files: files
    .filter((f) => !f.path.startsWith("/.galley/"))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ path: f.path, text: f.text })),
});
const input = inputOf(files);
function request(input: CompileInput = inputOf(files)): WorkbenchAcceptRequest {
  return {
    targetFileId: "doc",
    targetPath: "/main.typ",
    baseSource: "Revenue 12",
    finalSource: "Revenue 24",
    blocks: [{ search: "Revenue 12", replace: "Revenue 24" }],
    expectedMetadata: metadata,
    nextMetadata: metadata,
    expectedSources: [{ path: "/data.json", text: '{"x":24}' }],
    compiled: true,
    expectedInputKey: compileInputKey(input),
    expectedScratchInputKey: compileInputKey(
      workbenchScratchInput(input, "/main.typ", "Revenue 24", metadata),
    ),
  };
}
describe("atomic workbench Accept plan", () => {
  it("rejects file switches, renamed files and unavailable or failed scratch compiles", () => {
    expect(() => planWorkbenchAccept(files, "other", request(), input)).toThrow(
      "Target document changed",
    );
    expect(() =>
      planWorkbenchAccept(
        files,
        "doc",
        { ...request(), targetPath: "/renamed.typ" },
        input,
      ),
    ).toThrow();
    expect(() =>
      planWorkbenchAccept(
        files,
        "doc",
        { ...request(), compiled: false },
        input,
      ),
    ).toThrow("Compile");
    expect(() =>
      planWorkbenchAccept(
        files,
        "doc",
        { ...request(), expectedScratchInputKey: "wrong preview" },
        input,
      ),
    ).toThrow("compile input changed");
  });
  it("fails closed when metadata or selected source changed after preview", () => {
    expect(() =>
      planWorkbenchAccept(
        files.map((f) => (f.fileId === "data" ? { ...f, text: "changed" } : f)),
        "doc",
        request(),
        input,
      ),
    ).toThrow("Source dependency changed");
    expect(() =>
      planWorkbenchAccept(
        files.map((f) =>
          f.fileId === "meta" ? { ...f, text: metadata + " " } : f,
        ),
        "doc",
        request(),
        input,
      ),
    ).toThrow("metadata changed");
    expect(() =>
      planWorkbenchAccept(
        [...files, { ...files[1]!, fileId: "duplicate" }],
        "doc",
        request(),
        input,
      ),
    ).toThrow("Source dependency changed");
    expect(() =>
      planWorkbenchAccept(
        files,
        "doc",
        { ...request(), nextMetadata: "invalid" },
        input,
      ),
    ).toThrow();
  });
  it("requires recompilation for target, helper, data, main-entry and resolved-binary changes", () => {
    const frozen: ProjectInput = {
      ...input,
      binaryFiles: [{ path: "/figure.png", bytes: new Uint8Array([1, 2, 3]) }],
    };
    const run = request(frozen);
    const variants: ProjectInput[] = [
      ...["doc", "helper", "data"].map((id) => ({
        ...frozen,
        files: inputOf(
          files.map((f) =>
            f.fileId === id ? { ...f, text: "peer changed this file" } : f,
          ),
        ).files,
      })),
      { ...frozen, main: "/helper.typ" },
      {
        ...frozen,
        binaryFiles: [
          { path: "/figure.png", bytes: new Uint8Array([1, 2, 4]) },
        ],
      },
      { ...frozen, binaryFiles: [] },
    ];
    for (const current of variants)
      expect(() => planWorkbenchAccept(files, "doc", run, current)).toThrow(
        "compile input changed",
      );
    expect(
      planWorkbenchAccept(files, "doc", run, frozen).edits[0]!.source,
    ).toBe("Revenue 24");
  });
  it("supports compiling an active helper file without changing the main entry", () => {
    const scratch = workbenchScratchInput(
      input,
      "/helper.typ",
      "Revised helper",
    ) as ProjectInput;
    expect(scratch.main).toBe("/main.typ");
    expect(scratch.files.find((f) => f.path === "/helper.typ")!.text).toBe(
      "Revised helper",
    );
  });
  it("lands document and provenance as one CRDT update; freshness failures write neither", () => {
    const project = new CollabProject();
    const author = { kind: "human" as const, userId: "me" };
    project.seedIfPristine(
      [
        { path: "/main.typ", text: "Revenue 12" },
        { path: "/data.json", text: '{"x":24}' },
        { path: "/helper.typ", text: "Helper" },
      ],
      "/main.typ",
      author,
    );
    const live = () =>
      project.snapshot().files.map((f) => ({
        fileId: f.fileId,
        path: f.path,
        text: project.getFile(f.fileId)!.text,
      }));
    const doc = live().find((f) => f.path === "/main.typ")!;
    const next = {
      ...request(),
      targetFileId: doc.fileId,
      expectedMetadata: "",
    };
    const before = project.encodeState();
    expect(() =>
      applyAcceptedFileSetAsAgent(
        project,
        planWorkbenchAccept(live(), doc.fileId, next, {
          ...input,
          main: "/helper.typ",
        }),
        "workbench",
      ),
    ).toThrow();
    expect(project.encodeState()).toEqual(before);
    const updates: string[][] = [];
    project.doc.on("update", () =>
      updates.push(
        project.snapshot().files.map((f) => project.getFile(f.fileId)!.text),
      ),
    );
    applyAcceptedFileSetAsAgent(
      project,
      planWorkbenchAccept(live(), doc.fileId, next, project.toProjectInput()!),
      "workbench",
    );
    expect(updates).toHaveLength(1);
    expect(project.getFile(doc.fileId)!.text).toBe("Revenue 24");
    expect(updates[0]).toContain(metadata);
    project.destroy();
  });
});
