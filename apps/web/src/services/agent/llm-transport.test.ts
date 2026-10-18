import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("../api-proxy", () => ({
  apiFetch: h.apiFetch,
}));

import { makeBYOKClient } from "./llm-transport";

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

describe("Cloudflare gateway transport (PR1: no client credentials)", () => {
  const openAIResponse = () =>
    Response.json({
      choices: [{ message: { content: "planned" }, finish_reason: "stop" }],
    });

  it("POSTs to same-origin /api/llm with no Authorization header and no CF host", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: globalThis.RequestInit) =>
      openAIResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = makeBYOKClient({
        provider: "cloudflare",
        model: "@cf/google/gemma-4-26b-a4b-it",
        // These must NOT leak into the request: the gateway authenticates.
        apiKey: "MUST_NOT_LEAK",
        baseUrl: "acct-must-not-leak",
      });

      const result = await client.complete({
        messages: [{ role: "user", content: "trim the intro" }],
        tools: [],
      });

      expect(result.text).toBe("planned");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, globalThis.RequestInit];
      // Same-origin gateway only — never the provider host, never an account id.
      expect(url).toBe("/api/llm/v1/chat/completions");
      expect(url).not.toContain("api.cloudflare.com");
      expect(url).not.toContain("acct-must-not-leak");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization ?? headers.authorization).toBeUndefined();
      const rawBody = String(init?.body ?? "");
      expect(rawBody).not.toContain("MUST_NOT_LEAK");
      expect(rawBody).not.toContain("acct-must-not-leak");
      // The model rides in the body, not the URL.
      expect(rawBody).toContain('"model":"@cf/google/gemma-4-26b-a4b-it"');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("forwards upstream auth failures as structured errors without retrying 401", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid api token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = makeBYOKClient({
        provider: "cloudflare",
        model: "@cf/google/gemma-4-26b-a4b-it",
        apiKey: "",
      });

      await expect(
        client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      ).rejects.toMatchObject({ name: "LLMHttpError", status: 401 });
      // 401 is not retryable — exactly one upstream call, no credential fixups.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("normalizes array message content before sending (Workers AI is strict)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: globalThis.RequestInit) =>
      openAIResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = makeBYOKClient({
        provider: "cloudflare",
        model: "@cf/google/gemma-4-26b-a4b-it",
        apiKey: "",
      });

      await client.complete({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "frame 1" },
              { type: "text", text: " and frame 2" },
            ] as never,
          },
        ],
        tools: [],
      });

      const [, init] = fetchMock.mock.calls[0] as [string, globalThis.RequestInit];
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: unknown }>;
      };
      expect(body.messages[0].content).toBe("frame 1 and frame 2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
