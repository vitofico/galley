import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@galley/shared";
import { createModelClient, usesOpenAIResponses } from "./model-client.js";

const config: ProviderConfig = {
  kind: "openai-compatible",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-6.1-terra",
  isLocal: false,
  transport: { mode: "direct", apiKey: "synthetic-test-key" },
};

describe("GPT-6 Responses transport", () => {
  it("uses Responses for a Svincolo alias on the dedicated proxy upstream", () => {
    const transport = {
      mode: "proxy" as const,
      proxyUrl: "https://proxy.example.test",
      upstreamId: "svincolo-responses",
    };
    expect(usesOpenAIResponses({ ...config, model: "high", transport })).toBe(true);
    expect(usesOpenAIResponses({ ...config, model: "high",
      transport: { ...transport, upstreamId: "openai" } })).toBe(false);
  });

  it("keeps other endpoints and models on their configured protocol", () => {
    expect(usesOpenAIResponses(config)).toBe(true);
    expect(
      usesOpenAIResponses({
        ...config,
        baseUrl: "https://api.openai.com.example/v1",
      }),
    ).toBe(false);
    expect(usesOpenAIResponses({ ...config, model: "gpt-4.1-mini" })).toBe(
      false,
    );
    expect(usesOpenAIResponses({ ...config, kind: "ollama" })).toBe(false);
    expect(
      usesOpenAIResponses({
        ...config,
        transport: {
          mode: "proxy",
          proxyUrl: "http://localhost",
          upstreamId: "openai",
        },
      }),
    ).toBe(true);
    expect(
      usesOpenAIResponses({
        ...config,
        transport: {
          mode: "proxy",
          proxyUrl: "http://localhost",
          upstreamId: "anthropic",
        },
      }),
    ).toBe(false);
  });

  it("uses the proxy Responses endpoint and returns tool calls without sending a key", async () => {
    let requestPath = "";
    let requestHeaders: Record<string, unknown> = {};
    let requestBody: Record<string, unknown> = {};
    const server = createServer((req, res) => {
      requestPath = req.url ?? "";
      requestHeaders = req.headers;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestBody = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "resp_test",
            object: "response",
            created_at: 0,
            model: "gpt-6.1-terra",
            status: "completed",
            output: [
              {
                type: "function_call",
                id: "fc_test",
                call_id: "call_test",
                name: "connection_test",
                arguments: '{"ok":true}',
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const client = createModelClient({
        ...config,
        transport: {
          mode: "proxy",
          proxyUrl: `http://127.0.0.1:${port}`,
          upstreamId: "openai",
        },
      });
      const result = await client.step({
        system: "Use the test tool.",
        messages: [{ role: "user", content: "Check." }],
        tools: [],
      });
      expect(requestPath).toBe("/forward/responses");
      expect(requestHeaders["x-galley-upstream"]).toBe("openai");
      expect(requestHeaders.authorization).toBe("Bearer proxy-injected");
      expect(JSON.stringify(requestBody)).not.toContain("synthetic-test-key");
      expect(requestBody.store).toBe(false);
      expect(requestBody.model).toBe("gpt-6.1-terra");
      expect(result.toolCalls).toEqual([
        { id: "call_test", name: "connection_test", args: { ok: true } },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
