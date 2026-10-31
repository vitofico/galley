import type { CompileInput } from "@galley/shared";
/** Only adds page layout rules. Existing wording, imports and text-size rules are untouched. */
export function layoutCandidates(
  source: string,
  marginMm: number,
  spreadMm: number,
) {
  if (
    !Number.isFinite(marginMm) ||
    marginMm < 10 ||
    marginMm > 50 ||
    !Number.isFinite(spreadMm) ||
    spreadMm < 1 ||
    spreadMm > 10
  )
    throw new Error("Choose a margin of 10–50 mm and spread of 1–10 mm");
  return [-1, 0, 1].map((step) => {
    const margin = Math.max(10, Math.min(50, marginMm + step * spreadMm));
    return {
      label: `${margin} mm margins`,
      source: `#set page(margin: ${margin}mm)\n${source}`,
    };
  });
}
export function replaceScratchMain(
  input: CompileInput,
  path: string,
  source: string,
): CompileInput {
  if (typeof input === "string") return source;
  if (input.main !== path)
    throw new Error("Select the project main document for layout auditions");
  return {
    ...input,
    files: input.files.map((f) =>
      f.path === path ? { ...f, text: source } : f,
    ),
  };
}
