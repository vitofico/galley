import { describe, it, expect } from "vitest";
import { messageText, type ContentPart, type ModelMessage } from "./model.js";

describe("messageText", () => {
  it("returns a plain string verbatim (the common case)", () => {
    expect(messageText("hello world")).toBe("hello world");
    expect(messageText("")).toBe("");
  });

  it("concatenates the text parts of a ContentPart[], ignoring images", () => {
    const parts: ContentPart[] = [
      { type: "text", text: "look at " },
      { type: "image", image: "data:image/png;base64,AAAA", mimeType: "image/png" },
      { type: "text", text: "this figure" },
    ];
    expect(messageText(parts)).toBe("look at this figure");
  });

  it("returns an empty string when a part array has no text", () => {
    const parts: ContentPart[] = [{ type: "image", image: new Uint8Array([1, 2, 3]) }];
    expect(messageText(parts)).toBe("");
  });

  it("accepts a message's content field directly", () => {
    const stringMsg: ModelMessage = { role: "user", content: "plain" };
    const partsMsg: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    };
    expect(messageText(stringMsg.content)).toBe("plain");
    expect(messageText(partsMsg.content)).toBe("ab");
  });
});
