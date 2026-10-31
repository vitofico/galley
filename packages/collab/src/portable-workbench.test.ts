import { expect, it } from "vitest";
import { validPortableWorkbench } from "./portable-workbench.js";
const base = { version: 1, bindings: [], evidence: [], reviews: [] };
it("rejects unknown nested fields, wrong flags, excessive counts and bytes", () => {
  expect(
    validPortableWorkbench(
      JSON.stringify({
        ...base,
        evidence: [
          {
            id: "a",
            targetPath: "/main.typ",
            passage: "x",
            sourcePath: "/source.typ",
            sourceVersion: "x",
            excerpt: "x",
            reviewed: "true",
          },
        ],
      }),
    ),
  ).toBe(false);
  expect(
    validPortableWorkbench(
      JSON.stringify({ ...base, reviews: Array(101).fill({}) }),
    ),
  ).toBe(false);
  expect(validPortableWorkbench(" ".repeat(2_000_001))).toBe(false);
  expect(
    validPortableWorkbench(
      JSON.stringify({ ...base, bindings: [{ apiKey: "private" }] }),
    ),
  ).toBe(false);
});
it("accepts a realistic evidence record without changing its retained source", () => {
  expect(
    validPortableWorkbench(
      JSON.stringify({
        ...base,
        evidence: [
          {
            id: "a",
            targetPath: "/main.typ",
            passage: "x",
            sourcePath: "/source.typ",
            sourceVersion: "12 kg",
            excerpt: "12 kg",
            reviewed: true,
          },
        ],
      }),
    ),
  ).toBe(true);
});
