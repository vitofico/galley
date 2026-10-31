import { validPortableWorkbench } from "@galley/collab";
/** Explicit, offline provenance. These records track human decisions, not truth. */
export const MAX_WORKBENCH_BYTES = 2_000_000;
export const MAX_SOURCE_VERSION = 500_000;
export const MAX_WORKBENCH_RECORDS = 100;
export const WORKBENCH_PATH = "/.galley/workbench.json";
export interface WorkbenchFile {
  fileId: string;
  path: string;
  text: string;
}
export interface Binding {
  id: string;
  name: string;
  sourcePath: string;
  sourceVersion: string;
  selector: string;
  value: string;
  targetPath: string;
  passage: string;
}
export interface Evidence {
  id: string;
  targetPath: string;
  passage: string;
  sourcePath: string;
  sourceVersion: string;
  excerpt: string;
  reviewed: boolean;
}
export interface ReviewerItem {
  id: string;
  comment: string;
  targetPath: string;
  passage: string;
  revision: string;
  response: string;
  state: "open" | "addressed" | "declined";
}
export interface Workbench {
  version: 1;
  bindings: Binding[];
  evidence: Evidence[];
  reviews: ReviewerItem[];
}
export function emptyWorkbench(): Workbench {
  return { version: 1, bindings: [], evidence: [], reviews: [] };
}
export function readWorkbench(text: string): Workbench {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKBENCH_BYTES)
    throw new Error("Workbench exceeds the 2 MB metadata limit");
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1
  )
    throw new Error("Unsupported workbench version");
  const v = value as Workbench;
  for (const key of ["bindings", "evidence", "reviews"] as const)
    if (!Array.isArray(v[key])) throw new Error(`Invalid ${key}`);
  const strings = (row: unknown, fields: string[]) =>
    !!row &&
    typeof row === "object" &&
    fields.every(
      (key) => typeof (row as Record<string, unknown>)[key] === "string",
    );
  if (
    !v.bindings.every((r) =>
      strings(r, [
        "id",
        "name",
        "sourcePath",
        "sourceVersion",
        "selector",
        "value",
        "targetPath",
        "passage",
      ]),
    ) ||
    !v.evidence.every(
      (r) =>
        strings(r, [
          "id",
          "targetPath",
          "passage",
          "sourcePath",
          "sourceVersion",
          "excerpt",
        ]) && typeof r.reviewed === "boolean",
    ) ||
    !v.reviews.every(
      (r) =>
        strings(r, [
          "id",
          "comment",
          "targetPath",
          "passage",
          "revision",
          "response",
        ]) && ["open", "addressed", "declined"].includes(r.state),
    )
  )
    throw new Error("Invalid workbench records");
  if (
    v.bindings.length + v.evidence.length + v.reviews.length >
    MAX_WORKBENCH_RECORDS
  )
    throw new Error("Workbench is limited to 100 records");
  for (const record of [...v.bindings, ...v.evidence, ...v.reviews]) {
    for (const [key, value] of Object.entries(record)) {
      if (
        typeof value === "string" &&
        new TextEncoder().encode(value).byteLength >
          (key === "sourceVersion" ? MAX_SOURCE_VERSION : 64_000)
      )
        throw new Error("Workbench field exceeds its size limit");
    }
  }
  if (!validPortableWorkbench(text))
    throw new Error("Invalid or duplicate workbench records or fields");
  return v;
}
/** JSON uses a dot path (including array indices). CSV uses row.column, header row excluded. */
export function importedValue(
  text: string,
  path: string,
  selector: string,
): string {
  const parts = selector.split(".");
  if (path.toLowerCase().endsWith(".json")) {
    let value: unknown = JSON.parse(text);
    for (const part of parts) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new Error("JSON value not found");
      value = (value as Record<string, unknown>)[part];
    }
    if (
      value === null ||
      !["string", "number", "boolean"].includes(typeof value)
    )
      throw new Error("Select a scalar JSON value");
    return String(value);
  }
  if (!path.toLowerCase().endsWith(".csv"))
    throw new Error("Choose a CSV or JSON project file");
  const rows = parseCsv(text);
  const row = Number(parts.shift());
  const column = parts.join(".");
  const index = rows[0]?.indexOf(column) ?? -1;
  if ((rows[0]?.filter((header) => header === column).length ?? 0) > 1)
    throw new Error("CSV header is ambiguous");
  if (
    !Number.isInteger(row) ||
    row < 1 ||
    index < 0 ||
    rows[row]?.[index] === undefined
  )
    throw new Error("CSV selector must be row.header, e.g. 1.revenue");
  return rows[row]![index]!;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(field.replace(/\r$/, ""));
      field = "";
      if (c === "\n") {
        rows.push(row);
        row = [];
      }
    } else field += c;
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
export function uniquePassage(text: string, passage: string): boolean {
  const i = text.indexOf(passage);
  return passage.length > 0 && i >= 0 && text.indexOf(passage, i + 1) < 0;
}
export function bindingStatus(
  binding: Binding,
  files: WorkbenchFile[],
): string {
  if (
    files.filter((f) => f.path === binding.sourcePath).length > 1 ||
    files.filter((f) => f.path === binding.targetPath).length > 1
  )
    return "File path ambiguous — relink";
  const source = files.find((f) => f.path === binding.sourcePath),
    target = files.find((f) => f.path === binding.targetPath);
  if (!source || !target) return "File unavailable";
  if (!uniquePassage(target.text, binding.passage))
    return "Passage changed or ambiguous — relink";
  if (source.text !== binding.sourceVersion)
    return "Source changed — prose may be stale; review refresh";
  return "Source version retained — linked passage unchanged";
}
export function evidenceStatus(item: Evidence, files: WorkbenchFile[]): string {
  if (
    files.filter((f) => f.path === item.sourcePath).length > 1 ||
    files.filter((f) => f.path === item.targetPath).length > 1
  )
    return "File path ambiguous — relink";
  const source = files.find((f) => f.path === item.sourcePath),
    target = files.find((f) => f.path === item.targetPath);
  if (!source) return "Source unavailable";
  if (source.text !== item.sourceVersion) return "Source changed";
  if (!target || !uniquePassage(target.text, item.passage))
    return "Claim passage changed or ambiguous";
  if (!item.excerpt) return "Source attached";
  return item.reviewed ? "Reviewed by you" : "Passage selected";
}
export function refreshedBinding(
  binding: Binding,
  files: WorkbenchFile[],
): { binding: Binding; search: string; replace: string } {
  if (
    files.filter((f) => f.path === binding.sourcePath).length !== 1 ||
    files.filter((f) => f.path === binding.targetPath).length !== 1
  )
    throw new Error("File path missing or ambiguous");
  const source = files.find((f) => f.path === binding.sourcePath),
    target = files.find((f) => f.path === binding.targetPath);
  if (!source || !target || !uniquePassage(target.text, binding.passage))
    throw new Error("Relink a unique current target passage before refreshing");
  if (!uniquePassage(binding.passage, binding.value))
    throw new Error(
      "The old value must occur exactly once in the linked passage",
    );
  const value = importedValue(source.text, source.path, binding.selector);
  const passage = binding.passage.replace(binding.value, () => value);
  return {
    binding: { ...binding, value, passage, sourceVersion: source.text },
    search: binding.passage,
    replace: passage,
  };
}
export function responseLetter(items: ReviewerItem[]): string {
  return [
    "# Response to reviewers",
    ...items.map(
      (r, i) =>
        `## Comment ${i + 1} (${r.state})\n\n${r.comment}\n\nLocation: ${r.targetPath}\nPassage: ${r.passage}\n\nResponse: ${r.response || "[Response pending]"}\n\nProposed revision: ${r.revision || "[No revision]"}`,
    ),
  ].join("\n\n");
}

/** Exact passage revisions treat imported/reviewer text literally, including dollar templates. */
export function replaceLinkedPassage(
  source: string,
  search: string,
  replacement: string,
): string {
  if (!uniquePassage(source, search))
    throw new Error(
      "Linked passage changed or ambiguous. Relink it before proposing.",
    );
  return source.replace(search, () => replacement);
}
