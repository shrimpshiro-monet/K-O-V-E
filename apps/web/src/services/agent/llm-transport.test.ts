import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../api-proxy", () => ({
  apiFetch: h.apiFetch,
}));

import {
  makeBYOKClient,
  getCloudflareSlot,
  resetCloudflareSlot,
} from "./llm-transport";

const QUOTA_BODY = JSON.stringify({
  success: false,
  errors: [
    {
      code: 4006,
      message:
        "you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare Workers Paid",
    },
  ],
});

const quotaResponse = (): Response =>
  new Response(QUOTA_BODY, { status: 429 });

const okResponse = (content = "done"): Response =>
  Response.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
  });

const turn = {
  messages: [{ role: "user" as const, content: "hello" }],
  tools: [],
};

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

describe("cloudflare account fallback", () => {
  beforeEach(() => {
    h.fetch.mockReset();
    vi.stubGlobal("fetch", h.fetch);
    resetCloudflareSlot();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const primary = {
    provider: "cloudflare" as const,
    model: "@cf/google/gemma-4-26b-a4b-it",
    apiKey: "token-primary",
    baseUrl: "acct-primary",
  };
  const secondary = { accountId: "acct-secondary", apiToken: "token-secondary" };

  it("retries a dropped connection instead of failing the turn", async () => {
    h.fetch
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okResponse("recovered"));

    const client = makeBYOKClient(primary);

    await expect(client.complete(turn)).resolves.toMatchObject({ text: "recovered" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    // A network failure is not a quota event — never a reason to flip accounts.
    expect(getCloudflareSlot()).toBe(1);
  });

  it("flips to the secondary account when the primary quota is spent", async () => {
    h.fetch
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(okResponse("answered via secondary"));
    const onSlotChange = vi.fn();

    const client = makeBYOKClient({
      ...primary,
      cloudflareFallback: secondary,
      onCloudflareSlotChange: onSlotChange,
    });

    await expect(client.complete(turn)).resolves.toMatchObject({
      text: "answered via secondary",
    });

    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[0][0]).toBe(
      "/api/cf-ai/client/v4/accounts/acct-primary/ai/v1/chat/completions",
    );
    expect(h.fetch.mock.calls[1][0]).toBe(
      "/api/cf-ai-2/client/v4/accounts/acct-secondary/ai/v1/chat/completions",
    );
    expect(onSlotChange).toHaveBeenCalledTimes(1);
    expect(onSlotChange).toHaveBeenCalledWith(2);
    expect(getCloudflareSlot()).toBe(2);
  });

  it("keeps using the secondary account for later turns", async () => {
    h.fetch
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValueOnce(okResponse());

    await expect(
      makeBYOKClient({ ...primary, cloudflareFallback: secondary }).complete(turn),
    ).resolves.toMatchObject({ text: "done" });

    h.fetch.mockResolvedValueOnce(okResponse("second turn"));
    await expect(
      makeBYOKClient({ ...primary, cloudflareFallback: secondary }).complete(turn),
    ).resolves.toMatchObject({ text: "second turn" });

    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.fetch.mock.calls[2][0]).toBe(
      "/api/cf-ai-2/client/v4/accounts/acct-secondary/ai/v1/chat/completions",
    );
    expect(getCloudflareSlot()).toBe(2);
  });

  it("surfaces the error instead of ping-ponging when the secondary is also spent", async () => {
    h.fetch.mockImplementation(async () => quotaResponse());
    const onSlotChange = vi.fn();

    const client = makeBYOKClient({
      ...primary,
      cloudflareFallback: secondary,
      onCloudflareSlotChange: onSlotChange,
    });

    await expect(client.complete(turn)).rejects.toMatchObject({
      status: 429,
      code: 4006,
    });
    // One primary attempt, one flip + secondary attempt, then stop.
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(onSlotChange).toHaveBeenCalledTimes(1);
    expect(getCloudflareSlot()).toBe(2);
  });

  it("never flips without a configured fallback", async () => {
    h.fetch.mockImplementation(async () => quotaResponse());

    const client = makeBYOKClient(primary);

    await expect(client.complete(turn)).rejects.toMatchObject({
      status: 429,
      code: 4006,
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(getCloudflareSlot()).toBe(1);
  });

  it("does not flip on a 429 that is not a spent quota", async () => {
    vi.useFakeTimers();
    h.fetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: 4310, message: "slow down" }] }), {
          status: 429,
          headers: { "retry-after": "1" },
        }),
    );
    const onSlotChange = vi.fn();

    const client = makeBYOKClient({
      ...primary,
      cloudflareFallback: secondary,
      onCloudflareSlotChange: onSlotChange,
    });

    const pending = client.complete(turn);
    const assertion = expect(pending).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await assertion;

    expect(getCloudflareSlot()).toBe(1);
    expect(onSlotChange).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls[0][0]).toContain("/api/cf-ai/client");
  });
});
