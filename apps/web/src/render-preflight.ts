export type CheckStatus = "passed" | "failed" | "unavailable";
export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export function renderPreflight(input: {
  source: string;
  fresh: boolean;
  pageCount: number | null;
  pages?: { widthPt: number; heightPt: number }[] | undefined;
  maxPages: number;
  paper: "any" | "a4" | "letter";
}): PreflightCheck[] {
  const unavailable =
    "No successful SVG render for the current project input. Compile the current document first.";
  const check = (
    name: string,
    ok: boolean,
    detail: string,
  ): PreflightCheck => ({
    name,
    status: input.fresh ? (ok ? "passed" : "failed") : "unavailable",
    detail: input.fresh ? detail : unavailable,
  });
  const markers =
    input.source.match(/\b(?:TODO|FIXME|XXX|TBD)\b|\[\[(?:[^\]]*)\]\]/g) ?? [];
  const result = [
    check(
      "Editorial markers (source scan)",
      !markers.length,
      markers.length
        ? markers.join(", ")
        : "No TODO, FIXME, XXX, TBD or [[…]] markers found in source; not a semantic review.",
    ),
    input.pageCount === null
      ? {
          name: "SVG page cap",
          status: "unavailable" as const,
          detail: "Page count unavailable.",
        }
      : check(
          "SVG page cap",
          input.pageCount <= input.maxPages,
          `${input.pageCount} pages; maximum ${input.maxPages}.`,
        ),
  ];
  if (input.paper !== "any") {
    const target = input.paper === "a4" ? [595.28, 841.89] : [612, 792];
    const pages = input.pages;
    result.push(
      !pages?.length || pages.length !== input.pageCount
        ? {
            name: "SVG paper size",
            status: "unavailable",
            detail: "Per-page geometry is unavailable on this compiler route.",
          }
        : check(
            "SVG paper size",
            pages.every(
              (p) =>
                Math.abs(p.widthPt - target[0]!) < 1 &&
                Math.abs(p.heightPt - target[1]!) < 1,
            ),
            `Checked every rendered page against ${input.paper.toUpperCase()} portrait (1 pt tolerance).`,
          ),
    );
  }
  return result;
}
