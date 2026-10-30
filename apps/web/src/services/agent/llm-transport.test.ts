import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("../api-proxy", () => ({
  apiFetch: h.apiFetch,
}));

import { makeBYOKClient, makeOmniRouteGatewayClient } from "./llm-transport";

describe("compatible LLM transport", () => {
  beforeEach(() => {
    h.apiFetch.mockReset();
  });

  it("uses OpenAI message formatting for an arbitrary OpenAI-compatible model", async () => {
    h.apiFetch.mockResolvedValue(
      Response.json({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      }),
    );
    const client = makeBYOKClient({
      provider: "openai-compatible",
      baseUrl: "https://gateway.example/v1",
      model: "vendor/custom-tool-model",
      apiKey: "secret",
    });

    await expect(
      client.complete({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ text: "done" });

    expect(h.apiFetch).toHaveBeenCalledWith(
      "openai-compatible",
      "/chat/completions",
      "secret",
      expect.objectContaining({
        baseUrl: "https://gateway.example/v1",
        body: expect.stringContaining('"model":"vendor/custom-tool-model"'),
      }),
    );
  });

  it("uses Anthropic message formatting for an arbitrary Anthropic-compatible model", async () => {
    h.apiFetch.mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      }),
    );
    const client = makeBYOKClient({
      provider: "anthropic-compatible",
      baseUrl: "https://gateway.example/v1",
      model: "gateway/claude-tool-model",
      apiKey: "secret",
    });

    await expect(
      client.complete({
        system: "edit the video",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).resolves.toMatchObject({ text: "done" });

    const body = JSON.parse(
      (h.apiFetch.mock.calls[0][3] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(h.apiFetch).toHaveBeenCalledWith(
      "anthropic-compatible",
      "/messages",
      "secret",
      expect.objectContaining({ baseUrl: "https://gateway.example/v1" }),
    );
    expect(body).toMatchObject({
      model: "gateway/claude-tool-model",
      max_tokens: 4096,
      system: "edit the video",
    });
  });
});

describe("OmniRoute gateway transport", () => {
  beforeEach(() => {
    h.apiFetch.mockReset();
  });

  it("routes gateway calls through apiFetch with bearer auth and stream:true", async () => {
    h.apiFetch.mockResolvedValue(
      Response.json({
        choices: [{ message: { content: "from-gateway" }, finish_reason: "stop" }],
      }),
    );
    const client = makeOmniRouteGatewayClient({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "omni-key",
      model: "vendor/pinned-model",
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }),
    ).resolves.toMatchObject({ text: "from-gateway" });

    expect(h.apiFetch).toHaveBeenCalledWith(
      "omniroute",
      "/chat/completions",
      "omni-key",
      expect.objectContaining({
        baseUrl: "http://localhost:20128/v1",
        method: "POST",
      }),
    );
    const body = JSON.parse(
      (h.apiFetch.mock.calls[0][3] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "vendor/pinned-model", stream: true });
    const headers = (h.apiFetch.mock.calls[0][3] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer omni-key");
  });

  it("folds an SSE reply back into a single completion", async () => {
    const sse = [
      'data: {"model":"vendor/pinned-model","choices":[{"index":0,"delta":{"role":"assistant","content":"calling "}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"the tool."},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    h.apiFetch.mockResolvedValue(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = makeOmniRouteGatewayClient({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "omni-key",
      model: "vendor/pinned-model",
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }),
    ).resolves.toMatchObject({
      text: "calling the tool.",
      stopReason: "tool_use",
    });
  });
});
