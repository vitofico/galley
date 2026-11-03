import type { CompileInput, ProjectInput } from "@galley/shared";
import { base64ToBytes } from "@galley/compiler";
import type { CompileLimits } from "./index.js";

export function decodeCompileInput(
  input: unknown,
  limits: CompileLimits,
): { input: CompileInput } | { error: string; status: 400 | 413 } {
  const bad = () => ({
    error: "input must be a source string or a ProjectInput",
    status: 400 as const,
  });
  const over = () => ({
    error: "project exceeds size cap",
    status: 413 as const,
  });
  if (typeof input === "string") {
    return new TextEncoder().encode(input).length > limits.maxFileBytes
      ? over()
      : { input };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return bad();
  const p = input as Record<string, unknown>;
  if (
    p.kind !== "project" ||
    typeof p.main !== "string" ||
    !Array.isArray(p.files) ||
    (p.binaryFiles !== undefined && !Array.isArray(p.binaryFiles))
  )
    return bad();
  const bins = (p.binaryFiles ?? []) as unknown[];
  if (p.files.length + bins.length > limits.maxFiles) return over();
  const paths = new Set<string>();
  const safePath = (path: unknown): path is string =>
    typeof path === "string" &&
    path.length <= 1024 &&
    path.startsWith("/") &&
    !/[\\\x00-\x1f]/.test(path) &&
    path
      .split("/")
      .slice(1)
      .every((x) => x !== "" && x !== "." && x !== "..");
  let total = 0;
  const files: ProjectInput["files"] = [];
  for (const raw of p.files) {
    if (typeof raw !== "object" || raw === null) return bad();
    const f = raw as Record<string, unknown>;
    if (!safePath(f.path) || paths.has(f.path) || typeof f.text !== "string")
      return bad();
    const size = new TextEncoder().encode(f.text).length;
    total += size;
    if (size > limits.maxFileBytes || total > limits.maxTotalBytes)
      return over();
    paths.add(f.path);
    files.push({ path: f.path, text: f.text });
  }
  if (!paths.has(p.main)) return bad();
  const pending: { path: string; base64: string }[] = [];
  for (const raw of bins) {
    if (typeof raw !== "object" || raw === null) return bad();
    const f = raw as Record<string, unknown>;
    if (
      !safePath(f.path) ||
      paths.has(f.path) ||
      typeof f.base64 !== "string" ||
      f.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64)
    )
      return bad();
    const size =
      (f.base64.length / 4) * 3 -
      (f.base64.endsWith("==") ? 2 : f.base64.endsWith("=") ? 1 : 0);
    total += size;
    if (size > limits.maxFileBytes || total > limits.maxTotalBytes)
      return over();
    paths.add(f.path);
    pending.push({ path: f.path, base64: f.base64 });
  }
  return {
    input: {
      kind: "project",
      main: p.main,
      files,
      ...(p.binaryFiles === undefined
        ? {}
        : {
            binaryFiles: pending.map((f) => ({
              path: f.path,
              bytes: base64ToBytes(f.base64),
            })),
          }),
    },
  };
}
