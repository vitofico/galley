import { resolveAccept } from "./accept.js";
import { describe, expect, it } from "vitest";
import {
  bindingStatus,
  replaceLinkedPassage,
  emptyWorkbench,
  evidenceStatus,
  importedValue,
  readWorkbench,
  refreshedBinding,
  responseLetter,
  uniquePassage,
  type Binding,
  type Evidence,
  type WorkbenchFile,
} from "./document-workbench.js";
const files: WorkbenchFile[] = [
  { fileId: "data", path: "/data.json", text: '{"revenue":24}' },
  { fileId: "doc", path: "/main.typ", text: "Revenue was 12 million in 2025." },
];
const binding: Binding = {
  id: "one",
  name: "Revenue",
  sourcePath: "/data.json",
  sourceVersion: '{"revenue":12}',
  selector: "revenue",
  value: "12",
  targetPath: "/main.typ",
  passage: "Revenue was 12 million in 2025.",
};
describe("living numbers", () => {
  it("extracts scalar JSON through explicit own-property paths", () => {
    expect(importedValue('{"a":[{"x":4}]}', "/data.json", "a.0.x")).toBe("4");
    for (const selector of ["a", "constructor", "missing"])
      expect(() => importedValue('{"a":{}}', "/data.json", selector)).toThrow();
    expect(() => importedValue('{"a":null}', "/data.json", "a")).toThrow();
  });
  it("parses quoted CSV values, newlines, escaped quotes and CRLF", () => {
    const csv = 'name,value\r\n"a,b","12"\r\n"two\nlines","a""b"\r\n';
    expect(importedValue(csv, "/data.csv", "1.name")).toBe("a,b");
    expect(importedValue(csv, "/data.csv", "2.value")).toBe('a"b');
    expect(importedValue(csv, "/data.csv", "2.name")).toBe("two\nlines");
    for (const key of ["0.name", "-1.value", "3.value", "1.missing"])
      expect(() => importedValue(csv, "/data.csv", key)).toThrow();
    expect(() =>
      importedValue('a\n"unterminated', "/data.csv", "1.a"),
    ).toThrow();
  });
  it("retains original provenance and proposes a scoped immutable refresh", () => {
    const next = refreshedBinding(binding, files);
    expect(bindingStatus(binding, files)).toContain("Source changed");
    expect(next.search).toBe(binding.passage);
    expect(next.replace).toBe("Revenue was 24 million in 2025.");
    expect(next.binding.sourceVersion).toBe(files[0]!.text);
    expect(binding.value).toBe("12");
    expect(files[1]!.text).toContain("12");
  });
  it("fails closed for changed or repeated target passages and ambiguous old values", () => {
    expect(() =>
      refreshedBinding(binding, [
        files[0]!,
        { ...files[1]!, text: binding.passage.repeat(2) },
      ]),
    ).toThrow();
    expect(() =>
      refreshedBinding(binding, [files[0]!, { ...files[1]!, text: "changed" }]),
    ).toThrow();
    expect(() => refreshedBinding({ ...binding, value: "2" }, files)).toThrow();
    expect(bindingStatus(binding, [files[0]!])).toBe("File unavailable");
  });
});
describe("evidence provenance", () => {
  const evidence: Evidence = {
    id: "e",
    sourcePath: "/data.json",
    sourceVersion: files[0]!.text,
    targetPath: "/main.typ",
    passage: binding.passage,
    excerpt: "",
    reviewed: false,
  };
  it("distinguishes attachment, excerpt selection, human review and changed sources", () => {
    expect(evidenceStatus(evidence, files)).toBe("Source attached");
    expect(evidenceStatus({ ...evidence, excerpt: "24" }, files)).toBe(
      "Passage selected",
    );
    expect(
      evidenceStatus({ ...evidence, excerpt: "24", reviewed: true }, files),
    ).toBe("Reviewed by you");
    expect(
      evidenceStatus(
        { ...evidence, sourceVersion: "old", reviewed: true },
        files,
      ),
    ).toBe("Source changed");
    expect(evidenceStatus(evidence, [files[0]!])).toContain(
      "Claim passage changed",
    );
  });
  it("never treats empty or repeated passages as links", () => {
    expect(uniquePassage("text", "")).toBe(false);
    expect(uniquePassage("aaaa", "aa")).toBe(false);
  });
});
describe("workbench persistence and response export", () => {
  it("round trips metadata without discarding retained versions", () => {
    const data = { ...emptyWorkbench(), bindings: [binding] };
    expect(readWorkbench(JSON.stringify(data))).toEqual(data);
    for (const value of [
      { version: 2 },
      { version: 1, bindings: [], evidence: [], reviews: [null] },
      { ...emptyWorkbench(), bindings: [{ id: "missing fields" }] },
    ])
      expect(() => readWorkbench(JSON.stringify(value))).toThrow();
  });
  it("exports reviewer comments with explicit locations, decisions and draft responses", () => {
    const text = responseLetter([
      {
        id: "r",
        comment: "Clarify estimate",
        targetPath: "/main.typ",
        passage: "12 million",
        revision: "24 million",
        response: "We updated the estimate.",
        state: "addressed",
      },
    ]);
    for (const expected of [
      "Clarify estimate",
      "/main.typ",
      "12 million",
      "24 million",
      "addressed",
      "We updated the estimate.",
    ])
      expect(text).toContain(expected);
    expect(
      responseLetter([
        {
          id: "r",
          comment: "Explain",
          targetPath: "/main.typ",
          passage: "x",
          revision: "",
          response: "",
          state: "open",
        },
      ]),
    ).toContain("Response pending");
  });
});

describe("bounded metadata", () => {
  it("rejects oversized records and retained source versions without changing the input", () => {
    const retained = {
      ...emptyWorkbench(),
      bindings: [{ ...binding, sourceVersion: "x".repeat(500_001) }],
    };
    const input = JSON.stringify(retained);
    expect(() => readWorkbench(input)).toThrow("size limit");
    expect(retained.bindings[0]!.sourceVersion.length).toBe(500_001);
    expect(() =>
      readWorkbench(
        JSON.stringify({
          ...emptyWorkbench(),
          bindings: Array.from({ length: 101 }, () => binding),
        }),
      ),
    ).toThrow("100 records");
    expect(() => readWorkbench(" ".repeat(2_000_001))).toThrow("2 MB");
  });
});

describe("literal imported and reviewer replacements", () => {
  for (const replacement of ["$&", "$`", "$'", "$$"]) {
    it(`preserves scalar ${replacement} literally in the refresh passage and provenance`, () => {
      const updated = files.map((f) =>
        f.path === "/data.json"
          ? { ...f, text: JSON.stringify({ revenue: replacement }) }
          : f,
      );
      const result = refreshedBinding(binding, updated);
      expect(result.replace).toBe(
        `Revenue was ${replacement} million in 2025.`,
      );
      expect(result.binding.value).toBe(replacement);
    });
    it(`preserves reviewer ${replacement} literally in scratch and accepted text`, () => {
      const base = "Before\nLinked passage\nAfter";
      const next = replaceLinkedPassage(base, "Linked passage", replacement);
      expect(next).toBe(`Before\n${replacement}\nAfter`);
      expect(
        resolveAccept(base, base, next, [
          { search: "Linked passage", replace: replacement },
        ]).source,
      ).toBe(next);
    });
  }
});
