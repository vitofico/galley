import { describe, expect, it } from "vitest";
import {
  bundleProject,
  CollabProject,
  materializeProject,
  writeUstar,
} from "@galley/collab";
import type { ProjectTextFile } from "@galley/agent";
import {
  readNativeProjectTar,
  readProjectArchive,
  prepareProjectImport,
} from "./native-project-import.js";
import { toSafeProjectFiles } from "./import-project.js";
import {
  emptyWorkbench,
  readWorkbench,
  bindingStatus,
  evidenceStatus,
  WORKBENCH_PATH,
} from "../document-workbench.js";
import { restoreProjectFromTree } from "../project-session.js";
const author = { kind: "human" as const, userId: "native-import" };
const records = {
  ...emptyWorkbench(),
  bindings: [
    {
      id: "number",
      name: "Revenue",
      sourcePath: "/data.csv",
      sourceVersion: "revenue\n12\n",
      selector: "1.revenue",
      value: "12",
      targetPath: "/report.typ",
      passage: "Revenue was 12 million.",
    },
  ],
  evidence: [
    {
      id: "evidence",
      targetPath: "/report.typ",
      passage: "Revenue was 12 million.",
      sourcePath: "/source",
      sourceVersion: "Revenue estimate: 12 million",
      excerpt: "12 million",
      reviewed: true,
    },
  ],
  reviews: [
    {
      id: "review",
      comment: "Explain estimate",
      targetPath: "/report.typ",
      passage: "Revenue was 12 million.",
      revision: "Revenue is estimated at 12 million.",
      response: "Clarified $& and $$ literally.",
      state: "open" as const,
    },
  ],
};
const metadata = JSON.stringify(records);
function sourceProject() {
  const project = new CollabProject();
  project.seedIfPristine(
    [
      { path: "/report.typ", text: "Revenue was 12 million." },
      { path: "/data.csv", text: "revenue\n12\n" },
      { path: "/source", text: "Revenue estimate: 12 million" },
      { path: WORKBENCH_PATH, text: metadata },
      { path: "/.galley/device.json", text: '{"apiKey":"must-stay-private"}' },
    ],
    "/report.typ",
    author,
  );
  return project;
}
const liveFiles = (project: CollabProject) =>
  project
    .snapshot()
    .files.filter((f) => !f.deleted)
    .map((f) => ({
      fileId: f.fileId,
      path: f.path,
      text: project.getFile(f.fileId)!.text,
    }));
describe("native source bundle workbench roundtrip", () => {
  it("exports, parses, reviews and imports actual linked records with the main entry preserved", async () => {
    const original = sourceProject();
    const bundle = bundleProject(original.snapshot());
    if ("error" in bundle) throw new Error(bundle.error);
    const review = await readProjectArchive(bundle.bytes, "project.tar");
    expect(review.mainPath).toBe("/report.typ");
    const kept = toSafeProjectFiles(review.files).kept;
    const imported = new CollabProject();
    // This is the existing explicit Accept create seam, not an eager mutation during parsing.
    expect(imported.snapshot().files).toHaveLength(0);
    imported.seedIfPristine(kept, review.mainPath!, author);
    const actual = readWorkbench(
      liveFiles(imported).find((f) => f.path === WORKBENCH_PATH)!.text,
    );
    expect(actual).toEqual(records);
    expect(bindingStatus(actual.bindings[0]!, liveFiles(imported))).toContain(
      "Source version retained",
    );
    expect(evidenceStatus(actual.evidence[0]!, liveFiles(imported))).toBe(
      "Reviewed by you",
    );
    expect(actual.reviews[0]!.response).toBe(records.reviews[0]!.response);
    expect(
      liveFiles(imported).some((f) => f.path === "/.galley/device.json"),
    ).toBe(false);
    const again = bundleProject(imported.snapshot());
    if ("error" in again) throw new Error(again.error);
    expect(
      readWorkbench(
        (await readProjectArchive(again.bytes, "again.tar")).files.find(
          (f) => f.path === WORKBENCH_PATH,
        )!.text,
      ),
    ).toEqual(records);
    original.destroy();
    imported.destroy();
  });
  it("restores the exported native tree into a real project and admits the same validated git projection", () => {
    const original = sourceProject();
    const bundle = bundleProject(original.snapshot());
    if ("error" in bundle) throw new Error(bundle.error);
    const tree = readNativeProjectTar(bundle.bytes).files.map((f) => ({
      path: f.path,
      text: f.text!,
    }));
    const destination = new CollabProject();
    destination.seedIfPristine(
      [
        { path: "/old.typ", text: "Old" },
        { path: WORKBENCH_PATH, text: JSON.stringify(emptyWorkbench()) },
      ],
      "/old.typ",
      author,
    );
    restoreProjectFromTree(destination, tree, author);
    expect(
      readWorkbench(
        liveFiles(destination).find((f) => f.path === WORKBENCH_PATH)!.text,
      ),
    ).toEqual(records);
    expect(destination.toProjectInput()!.main).toBe("/report.typ");
    const projection = materializeProject(original.snapshot(), {
      includeWorkbench: true,
    });
    if (!projection.ok) throw new Error(projection.detail);
    restoreProjectFromTree(destination, projection.result.files, author);
    expect(
      readWorkbench(
        liveFiles(destination).find((f) => f.path === WORKBENCH_PATH)!.text,
      ),
    ).toEqual(records);
    expect(
      liveFiles(destination).some((f) => f.path === "/.galley/device.json"),
    ).toBe(false);
    original.destroy();
    destination.destroy();
  });
  it("rejects malformed/duplicate/unknown metadata before any regular source restore writes", () => {
    const project = sourceProject();
    const before = project.encodeState();
    const invalid = [
      [{ path: ".galley/workbench.json", text: "bad JSON" }],
      [
        { path: ".galley/workbench.json", text: metadata },
        { path: "/.galley/workbench.json", text: metadata },
      ],
      [
        {
          path: ".galley/workbench.json",
          text: JSON.stringify({
            ...records,
            reviews: [records.reviews[0], records.reviews[0]],
          }),
        },
      ],
      [
        {
          path: ".galley/workbench.json",
          text: JSON.stringify({ ...records, apiKey: "private" }),
        },
      ],
    ];
    for (const tree of invalid) {
      expect(() =>
        restoreProjectFromTree(
          project,
          [{ path: "report.typ", text: "Should never apply" }, ...tree],
          author,
        ),
      ).toThrow();
      expect(project.encodeState()).toEqual(before);
      expect(() =>
        toSafeProjectFiles(
          tree.map((f) => ({
            ...f,
            path: f.path.startsWith("/") ? f.path : `/${f.path}`,
          })),
        ),
      ).toThrow();
    }
    project.destroy();
  });
  it("validates metadata before conversion deduplication and keeps all other reserved paths excluded", () => {
    expect(() =>
      prepareProjectImport({
        files: [
          { path: ".galley/workbench.json", text: metadata },
          { path: ".galley/workbench.json", text: metadata },
        ],
      }),
    ).toThrow();
    const result = prepareProjectImport({
      files: [
        { path: "main.typ", text: "Main" },
        { path: "./.galley/workbench.json", text: metadata },
        { path: ".galley/device.json", text: "secret" },
        { path: ".galley/workbench.json", text: metadata },
      ],
    });
    const kept = toSafeProjectFiles(result.files).kept;
    expect(kept.map((f) => f.path)).toEqual([WORKBENCH_PATH, "/main.typ"]);
    expect(kept.filter((f) => f.path === WORKBENCH_PATH)).toHaveLength(1);
  });
  it("rejects invalid metadata in tar at parse/review time and rejects unsafe tar types/checksums", async () => {
    const entries = (files: ProjectTextFile[]) =>
      writeUstar(
        files.map((f) => ({
          type: "file" as const,
          path: f.path,
          bytes: new TextEncoder().encode(f.text),
        })),
      );
    await expect(
      readProjectArchive(
        entries([
          { path: "main.typ", text: "Source" },
          { path: ".galley/workbench.json", text: "malformed" },
        ]),
        "project.tar",
      ),
    ).rejects.toThrow("Workbench");
    const unsafe = entries([{ path: "../escape.typ", text: "Source" }]);
    expect(() => readNativeProjectTar(unsafe)).toThrow("unsafe path");
    const broken = entries([{ path: "main.typ", text: "Source" }]);
    broken[0] = broken[0]! ^ 1;
    expect(() => readNativeProjectTar(broken)).toThrow("checksum");
  });
});

it("native read() and evidence assets retain .tex/.cls/.sty names, exact text and binary bytes", async () => {
  const project = new CollabProject();
  const appendix =
    "\uFEFF\\documentclass{article}\r\nEvidence $& and $$ retained.\r\n";
  const cls = "\\ProvidesClass{evidence}\n\\newcommand{\\value}{12}";
  const sty = "\\ProvidesPackage{evidence}\n\\newcommand{\\unit}{MW}";
  const main =
    '#read("appendix.tex")\n#read("styles.cls")\n#read("macros.sty")';
  const metadata = JSON.stringify({
    ...emptyWorkbench(),
    evidence: [
      {
        id: "native-tex-evidence",
        targetPath: "/main.typ",
        passage: '#read("appendix.tex")',
        sourcePath: "/appendix.tex",
        sourceVersion: appendix,
        excerpt: "Evidence $& and $$ retained.",
        reviewed: true,
      },
    ],
  });
  project.seedIfPristine(
    [
      { path: "/main.typ", text: main },
      { path: "/appendix.tex", text: appendix },
      { path: "/styles.cls", text: cls },
      { path: "/macros.sty", text: sty },
      { path: WORKBENCH_PATH, text: metadata },
    ],
    "/main.typ",
    author,
  );
  const binary = new Uint8Array([0xff, 0x00, 0x80, 0x04]);
  project.createBinary(
    "/raw.tex",
    {
      type: "binary",
      hash: "raw-native-test",
      size: binary.length,
      mime: "application/octet-stream",
    },
    author,
  );
  const bundle = bundleProject(
    project.snapshot(),
    new Map([["raw-native-test", binary]]),
  );
  if ("error" in bundle) throw new Error(bundle.error);
  const prepared = await readProjectArchive(bundle.bytes, "native.tar");
  expect(prepared.report.unconverted).toEqual([]);
  expect(prepared.files.some((file) => file.path === "/appendix.typ")).toBe(
    false,
  );
  const imported = new CollabProject();
  imported.seedIfPristine(
    toSafeProjectFiles(prepared.files).kept,
    prepared.mainPath!,
    author,
  );
  for (const [path, text] of [
    ["/main.typ", main],
    ["/appendix.tex", appendix],
    ["/styles.cls", cls],
    ["/macros.sty", sty],
  ])
    expect(liveFiles(imported).find((file) => file.path === path)?.text).toBe(
      text,
    );
  expect(
    evidenceStatus(
      readWorkbench(
        liveFiles(imported).find((file) => file.path === WORKBENCH_PATH)!.text,
      ).evidence[0]!,
      liveFiles(imported),
    ),
  ).toBe("Reviewed by you");
  expect(prepared.binaryFiles).toEqual([{ path: "/raw.tex", bytes: binary }]);
  project.destroy();
  imported.destroy();
});
