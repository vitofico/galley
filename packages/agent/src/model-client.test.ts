import { describe, it, expect } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderConfig } from "@galley/shared";
import { AGENT_TOOLS } from "./tools.js";
import { classifyProbeError, createModelClient } from "./model-client.js";

interface OpenAIMessage {
  role: string;
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}
function chatCompletion(message: OpenAIMessage, finish: string) {
  return {
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "mock",
    choices: [{ index: 0, finish_reason: finish, message }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

interface Mock {
  url: string;
  lastHeaders: () => IncomingMessage["headers"];
  close: () => Promise<void>;
}
function startMock(respond: (body: unknown) => unknown): Promise<Mock> {
  let headers: IncomingMessage["headers"] = {};
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      headers = req.headers;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(respond(raw ? JSON.parse(raw) : {})));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}/v1`,
        lastHeaders: () => headers,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function directConfig(baseUrl: string): ProviderConfig {
  return {
    kind: "openai-compatible",
    label: "Mock",
    baseUrl,
    model: "mock-model",
    isLocal: false,
    transport: { mode: "direct", apiKey: "sk-test" },
  };
}

describe("AiSdkClient.step (openai-compatible, mocked)", () => {
  it("returns assistant text + tool calls", async () => {
    const mock = await startMock(() =>
      chatCompletion(
        {
          role: "assistant",
          content: "editing now",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "propose_edit", arguments: JSON.stringify({ edits: [{ search: "a", replace: "b" }] }) },
            },
          ],
        },
        "tool_calls",
      ),
    );
    try {
      const client = createModelClient(directConfig(mock.url));
      const step = await client.step({
        system: "you edit typst",
        messages: [{ role: "user", content: "edit it" }],
        tools: AGENT_TOOLS,
      });
      expect(step.text).toBe("editing now");
      expect(step.toolCalls).toHaveLength(1);
      expect(step.toolCalls[0]).toMatchObject({ name: "propose_edit", id: "call_1" });
      expect(step.toolCalls[0]!.args).toEqual({ edits: [{ search: "a", replace: "b" }] });
      // The client sent the Bearer key (direct mode).
      expect(mock.lastHeaders().authorization).toBe("Bearer sk-test");
    } finally {
      await mock.close();
    }
  });

  it("maps a full tool-using conversation back without error", async () => {
    const mock = await startMock(() => chatCompletion({ role: "assistant", content: "done" }, "stop"));
    try {
      const client = createModelClient(directConfig(mock.url));
      const step = await client.step({
        system: "s",
        messages: [
          { role: "user", content: "edit it" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "propose_edit", args: { edits: [] } }] },
          { role: "tool", content: "compiled clean", toolCallId: "c1", toolName: "propose_edit" },
        ],
        tools: AGENT_TOOLS,
      });
      expect(step.text).toBe("done");
      expect(step.toolCalls).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe("AiSdkClient.step — content mapping (openai-compatible, mocked)", () => {
  /** Capture the outgoing chat-completions request body for assertions. */
  function startBodyMock(): Promise<Mock & { lastBody: () => any }> {
    let body: unknown = undefined;
    return startMock((b) => {
      body = b;
      return chatCompletion({ role: "assistant", content: "ok" }, "stop");
    }).then((m) => ({ ...m, lastBody: () => body as any }));
  }

  it("string content maps byte-for-byte to a bare string user message", async () => {
    const mock = await startBodyMock();
    try {
      const client = createModelClient(directConfig(mock.url));
      await client.step({
        system: "s",
        messages: [{ role: "user", content: "edit it" }],
        tools: AGENT_TOOLS,
      });
      const userMsg = mock.lastBody().messages.find((m: any) => m.role === "user");
      // A plain string stays a bare string (NOT wrapped into a parts array).
      expect(typeof userMsg.content).toBe("string");
      expect(userMsg.content).toBe("edit it");
    } finally {
      await mock.close();
    }
  });

  it("a text+image ContentPart[] maps to the AI SDK's multimodal content parts", async () => {
    const mock = await startBodyMock();
    try {
      const client = createModelClient(directConfig(mock.url));
      await client.step({
        system: "s",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this figure" },
              {
                type: "image",
                image: "data:image/png;base64,iVBORw0KGgo=",
                mimeType: "image/png",
              },
            ],
          },
        ],
        tools: AGENT_TOOLS,
      });
      const userMsg = mock.lastBody().messages.find((m: any) => m.role === "user");
      // Multimodal: content is an array, not a bare string.
      expect(Array.isArray(userMsg.content)).toBe(true);
      const text = userMsg.content.find((p: any) => p.type === "text");
      const image = userMsg.content.find((p: any) => p.type === "image_url");
      expect(text).toMatchObject({ type: "text", text: "describe this figure" });
      // The image part rode through as an image_url carrying the data URL.
      expect(image).toBeTruthy();
      expect(image.image_url.url).toContain("data:image/png;base64,");
    } finally {
      await mock.close();
    }
  });
});

describe("AiSdkClient — proxy transport", () => {
  it("targets /forward with the upstream selector and no client key", async () => {
    const mock = await startMock(() => chatCompletion({ role: "assistant", content: "ok" }, "stop"));
    try {
      const base = mock.url.replace(/\/v1$/, ""); // proxy root
      const config: ProviderConfig = {
        kind: "openai-compatible",
        label: "Proxied",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
        isLocal: false,
        transport: { mode: "proxy", proxyUrl: base, upstreamId: "openai" },
      };
      const client = createModelClient(config);
      await client.step({ system: "s", messages: [{ role: "user", content: "go" }], tools: AGENT_TOOLS });
      expect(mock.lastHeaders()["x-galley-upstream"]).toBe("openai");
      expect(mock.lastHeaders().authorization).toBeUndefined();
    } finally {
      await mock.close();
    }
  });
});

describe("AiSdkClient.step (anthropic, mocked)", () => {
  it("parses tool_use blocks and sends the anthropic auth + browser-access headers", async () => {
    const mock = await startMock(() => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-x",
      content: [
        { type: "text", text: "editing" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "propose_edit",
          input: { edits: [{ search: "a", replace: "b" }] },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    try {
      const config: ProviderConfig = {
        kind: "anthropic",
        label: "Claude",
        baseUrl: mock.url,
        model: "claude-x",
        isLocal: false,
        transport: { mode: "direct", apiKey: "sk-ant-test" },
      };
      const step = await createModelClient(config).step({
        system: "s",
        messages: [{ role: "user", content: "edit it" }],
        tools: AGENT_TOOLS,
      });
      expect(step.text).toBe("editing");
      expect(step.toolCalls[0]).toMatchObject({ name: "propose_edit" });
      expect(step.toolCalls[0]!.args).toEqual({ edits: [{ search: "a", replace: "b" }] });
      expect(mock.lastHeaders()["x-api-key"]).toBe("sk-ant-test");
      expect(mock.lastHeaders()["anthropic-dangerous-direct-browser-access"]).toBe("true");
    } finally {
      await mock.close();
    }
  });
});

/** Start a mock that streams an OpenAI-compatible chat-completion SSE response. */
function startStreamMock(chunks: unknown[]): Promise<Mock> {
  let headers: IncomingMessage["headers"] = {};
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      headers = req.headers;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "text/event-stream");
        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://localhost:${port}/v1`,
        lastHeaders: () => headers,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function streamChunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "x",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

describe("AiSdkClient.stepStream (openai-compatible, mocked SSE)", () => {
  it("yields incremental text deltas then returns the settled step", async () => {
    const mock = await startStreamMock([
      streamChunk({ role: "assistant", content: "" }),
      streamChunk({ content: "Hello" }),
      streamChunk({ content: ", " }),
      streamChunk({ content: "world" }),
      streamChunk({}, "stop"),
    ]);
    try {
      const client = createModelClient(directConfig(mock.url));
      expect(typeof client.stepStream).toBe("function");
      const stream = client.stepStream!({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: AGENT_TOOLS,
      });
      const deltas: string[] = [];
      let next = await stream.next();
      while (!next.done) {
        expect(next.value.type).toBe("text-delta");
        deltas.push(next.value.text);
        next = await stream.next();
      }
      // Streamed in pieces (more than one delta), reassembling to the full text.
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join("")).toBe("Hello, world");
      // The generator's RETURN value is the same ModelStep shape as `step`.
      expect(next.value.text).toBe("Hello, world");
      expect(next.value.toolCalls).toEqual([]);
    } finally {
      await mock.close();
    }
  });
});

describe("AiSdkClient.probe", () => {
  it("reports reachable on success", async () => {
    const mock = await startMock(() => chatCompletion({ role: "assistant", content: "pong" }, "stop"));
    try {
      const caps = await createModelClient(directConfig(mock.url)).probe();
      expect(caps).toMatchObject({ reachable: true, supportsToolCalls: true });
      // The real AI-SDK transport can carry E3's image content parts, so a
      // successful probe advertises image-input support (model vision is the
      // user's model choice, not this flag).
      expect(caps.supportsImageInput).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("reports unreachable with an error when the endpoint is down", async () => {
    // Nothing listening on this port.
    const caps = await createModelClient(directConfig("http://localhost:1/v1")).probe();
    expect(caps.reachable).toBe(false);
    expect(caps.error).toBeTruthy();
    // A failed probe claims no capability — including image input.
    expect(caps.supportsImageInput).toBe(false);
  });
});

describe("classifyProbeError", () => {
  it("maps common failures to actionable hints", () => {
    expect(classifyProbeError(new Error("401 Unauthorized")).error).toMatch(/api key/i);
    expect(classifyProbeError(new Error("Failed to fetch")).error).toMatch(/cors|proxy/i);
    expect(classifyProbeError(new Error("404 Not Found")).error).toMatch(/base url|model/i);
  });

  it("claims no capabilities on failure, including image input", () => {
    const caps = classifyProbeError(new Error("boom"));
    expect(caps).toMatchObject({
      reachable: false,
      supportsStreaming: false,
      supportsToolCalls: false,
      supportsImageInput: false,
    });
  });
});
