/** Exact, bounded allowlist for portable user-authored workbench records.
 * Unknown fields are rejected so future device/private fields cannot leak by default. */
export const PORTABLE_WORKBENCH_PATH = ".galley/workbench.json";
export function validPortableWorkbench(text: string): boolean {
  if (new TextEncoder().encode(text).byteLength > 2_000_000) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const root = value as Record<string, unknown>;
    if (
      root.version !== 1 ||
      Object.keys(root).sort().join(",") !== "bindings,evidence,reviews,version"
    )
      return false;
    const schemas = {
      bindings: [
        "id",
        "name",
        "sourcePath",
        "sourceVersion",
        "selector",
        "value",
        "targetPath",
        "passage",
      ],
      evidence: [
        "id",
        "targetPath",
        "passage",
        "sourcePath",
        "sourceVersion",
        "excerpt",
        "reviewed",
      ],
      reviews: [
        "id",
        "comment",
        "targetPath",
        "passage",
        "revision",
        "response",
        "state",
      ],
    };
    let count = 0;
    const ids = new Set<string>();
    for (const [key, fields] of Object.entries(schemas)) {
      const rows = root[key];
      if (!Array.isArray(rows)) return false;
      count += rows.length;
      if (count > 100) return false;
      for (const row of rows) {
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(",") !== [...fields].sort().join(",")
        )
          return false;
        for (const field of fields) {
          const entry: unknown = row[field];
          if (field === "reviewed") {
            if (typeof entry !== "boolean") return false;
          } else if (
            typeof entry !== "string" ||
            new TextEncoder().encode(entry).byteLength >
              (field === "sourceVersion" ? 500_000 : 64_000)
          )
            return false;
        }
        if (!row.id || ids.has(row.id)) return false;
        ids.add(row.id);
        if (
          key === "reviews" &&
          !["open", "addressed", "declined"].includes(row.state)
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Only the exact exported path (or canonical CRDT form) may carry user records. */
export function portableWorkbenchFromTree(
  tree: readonly { path: string; text?: string }[],
): string | undefined {
  const entries = tree.filter(
    (file) =>
      file.path === PORTABLE_WORKBENCH_PATH ||
      file.path === `/${PORTABLE_WORKBENCH_PATH}`,
  );
  if (
    entries.length > 1 ||
    (entries[0] &&
      (typeof entries[0].text !== "string" ||
        !validPortableWorkbench(entries[0].text)))
  )
    throw new Error("Workbench metadata is duplicate or invalid");
  return entries[0]?.text;
}
