import type { CompileInput, CompileInputWire } from "@galley/shared";
import { bytesToBase64 } from "./base64.js";

/** Text-only requests retain their original wire shape. */
export function encodeCompileInput(input: CompileInput): CompileInputWire {
  if (typeof input === "string") return input;
  const { binaryFiles, ...text } = input;
  return {
    ...text,
    ...(binaryFiles === undefined
      ? {}
      : {
          binaryFiles: binaryFiles.map(({ path, bytes }) => ({
            path,
            base64: bytesToBase64(bytes),
          })),
        }),
  };
}
