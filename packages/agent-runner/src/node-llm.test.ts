import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { makeNodeLLMSend, makeNodeLLMClient, resolveLlmProvider } from "./node-llm";

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

const jsonResponse = (json: unknown): Response =>
  new Response(JSON.stringify(json), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A repo root with no .dev.vars, so only env decides what is configured. */
const emptyRepoRoot = (): string => mkdtempSync(join(tmpdir(), "kove-ladder-"));

describe("makeNodeLLMSend", () => {
  it("sends the anthropic key via x-api-key only (never in the body)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    const send = makeNodeLLMSend("anthropic", "sk-ant-secret", fetchFn as unknown as typeof fetch);
    await send({ model: "claude", messages: [] });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("api.anthropic.com");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(init.body).not.toContain("sk-ant-secret");
  });

  it("sends the openai key via Authorization Bearer", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    const send = makeNodeLLMSend("openai", "sk-openai", fetchFn as unknown as typeof fetch);
    await send({ model: "gpt-4o" });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("api.openai.com");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-openai");
  });

  it("throws when no key is provided", () => {
    expect(() => makeNodeLLMSend("anthropic", "")).toThrow(/Missing API key/);
  });

  it("throws with the provider + status on a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      headers: { get: () => null },
    } as unknown as Response);
    const send = makeNodeLLMSend("openai", "k", fetchFn as unknown as typeof fetch);
    await expect(send({})).rejects.toThrow(/openai 429/);
  });
});

describe("gateway ladder", () => {
  const clearGatewayEnv = (): void => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "");
    vi.stubEnv("OMNIROUTE_KEY", "");
    vi.stubEnv("OMNIROUTE_MODEL", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("CLOUDFLARE_AI_MODEL", "");
  };

  it("routes the omni provider at the local gateway with SSE enabled", async () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      vi.stubEnv("OMNIROUTE_BASE_URL", "http://localhost:20128/v1");
      vi.stubEnv("OMNIROUTE_KEY", "omni-key");
      vi.stubEnv("OMNIROUTE_MODEL", "vendor/pinned-model");
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
      );

      const client = makeNodeLLMClient({ provider: "omni", repoRoot: root, fetchFn });
      const result = await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

      expect(result.text).toBe("ok");
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("http://localhost:20128/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer omni-key");
      expect(JSON.parse(String(init.body)).stream).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to Cloudflare Workers AI when the gateway is unreachable", async () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      vi.stubEnv("OMNIROUTE_KEY", "omni-key");
      vi.stubEnv("OMNIROUTE_MODEL", "vendor/pinned-model");
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
      vi.stubEnv("CLOUDFLARE_AI_MODEL", "@cf/test-model");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("localhost")) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(
          jsonResponse({
            choices: [{ message: { role: "assistant", content: "from-workers" }, finish_reason: "stop" }],
          }),
        );
      });
      const onFallback = vi.fn();

      const client = makeNodeLLMClient({
        provider: "omni",
        repoRoot: root,
        fetchFn,
        onFallback,
      });
      const result = await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

      expect(result.text).toBe("from-workers");
      expect(onFallback).toHaveBeenCalledTimes(1);
      const urls = fetchFn.mock.calls.map((call) => String(call[0]));
      expect(urls.some((u) => u.includes("localhost"))).toBe(true);
      expect(urls.some((u) => u.includes("api.cloudflare.com"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the gateway alone when Workers is not configured", async () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      vi.stubEnv("OMNIROUTE_KEY", "omni-key");
      vi.stubEnv("OMNIROUTE_MODEL", "vendor/pinned-model");
      const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const onFallback = vi.fn();

      const client = makeNodeLLMClient({ provider: "omni", repoRoot: root, fetchFn, onFallback });
      await expect(
        client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] }),
      ).rejects.toThrow();
      expect(onFallback).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forces the Workers side with --provider cloudflare", async () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      vi.stubEnv("OMNIROUTE_KEY", "omni-key");
      vi.stubEnv("OMNIROUTE_MODEL", "vendor/pinned-model");
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
      vi.stubEnv("CLOUDFLARE_AI_MODEL", "@cf/test-model");
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [{ message: { role: "assistant", content: "workers-only" }, finish_reason: "stop" }],
        }),
      );

      const client = makeNodeLLMClient({ provider: "cloudflare", repoRoot: root, fetchFn });
      const result = await client.complete({ messages: [{ role: "user", content: "hi" }], tools: [] });

      expect(result.text).toBe("workers-only");
      const [url] = fetchFn.mock.calls[0];
      expect(String(url)).toContain("api.cloudflare.com");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves auto down the ladder: gateway, then Workers, then anthropic", () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      expect(resolveLlmProvider("auto", root)).toBe("anthropic");

      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-1");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
      expect(resolveLlmProvider("auto", root)).toBe("cloudflare");

      vi.stubEnv("OMNIROUTE_KEY", "omni-key");
      vi.stubEnv("OMNIROUTE_MODEL", "vendor/pinned-model");
      expect(resolveLlmProvider("auto", root)).toBe("omni");

      // Explicit providers never consult the config.
      expect(resolveLlmProvider("openai", root)).toBe("openai");
      expect(resolveLlmProvider("anthropic", root)).toBe("anthropic");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails with a clear message when a gateway provider is unconfigured", () => {
    const root = emptyRepoRoot();
    try {
      clearGatewayEnv();
      expect(() => makeNodeLLMClient({ provider: "omni", repoRoot: root })).toThrow(
        /OmniRoute is not configured/,
      );
      expect(() => makeNodeLLMClient({ provider: "cloudflare", repoRoot: root })).toThrow(
        /Cloudflare Workers AI is not configured/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
