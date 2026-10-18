// @vitest-environment node
/**
 * Server-side LLM gateway (Cloudflare Pages Function) — unit tests.
 *
 * These run in a plain Node environment (no jsdom): Request/Response/Headers
 * are native here, matching the Pages runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleLlmGateway, onRequest } from "./[[catchall]]";

const ENV = {
  CLOUDFLARE_API_TOKEN: "test-token-do-not-log",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
};

const jsonResponse = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("handleLlmGateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a structured 503 when Pages secrets are missing", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", { method: "POST" }),
      {},
      "v1/chat/completions",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "GATEWAY_NOT_CONFIGURED", message: expect.any(String) },
    });
  });

  it("answers CORS preflights without touching upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "https://kove-advanced.pages.dev",
          "Access-Control-Request-Method": "POST",
        },
      }),
      ENV,
      "v1/chat/completions",
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://kove-advanced.pages.dev",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds CORS for allowed origins and a safe default for unknown ones", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const allowed = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models", {
        headers: { Origin: "http://localhost:4173" },
      }),
      ENV,
      "v1/models",
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:4173",
    );

    const unknown = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models", {
        headers: { Origin: "https://evil.example" },
      }),
      ENV,
      "v1/models",
    );
    // Unknown origins never get their Origin echoed back.
    expect(unknown.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://kove-advanced.pages.dev",
    );
  });

  it("relays to Workers AI with server-side credentials (account + Bearer token)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "@cf/google/gemma-4-26b-a4b-it" }),
      }),
      ENV,
      "v1/chat/completions",
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, globalThis.RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
    );
    const headers = init?.headers as unknown as Headers;
    expect(headers.get("authorization")).toBe("Bearer test-token-do-not-log");
    expect(headers.get("content-type")).toBe("application/json");
    // Request body is passed through intact (re-buffered as ArrayBuffer).
    const bodyText = new TextDecoder().decode(
      new Uint8Array(init?.body as ArrayBuffer),
    );
    expect(JSON.parse(bodyText)).toEqual({
      model: "@cf/google/gemma-4-26b-a4b-it",
    });
  });

  it("strips CF hop headers from upstream responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "cf-ray": "abc",
            "set-cookie": "session=x",
          },
        }),
      ),
    );
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models"),
      ENV,
      "v1/models",
    );
    expect(res.headers.get("cf-ray")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("rejects disallowed paths and methods", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/embeddings"),
      ENV,
      "v1/embeddings",
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");

    const badMethod = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models", { method: "DELETE" }),
      ENV,
      "v1/models",
    );
    expect(badMethod.status).toBe(405);
  });

  it("rejects bodies over the 8 MB cap before touching upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        // Declared size above the cap — the fast path must trigger without
        // buffering the body.
        headers: { "Content-Length": String(9_000_000) },
        body: new Uint8Array(16),
      }),
      ENV,
      "v1/chat/completions",
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("BODY_TOO_LARGE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps upstream outages to a structured 502 (no raw error text to client)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", { method: "POST" }),
      ENV,
      "v1/chat/completions",
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("UPSTREAM_ERROR");
  });
});

describe("onRequest (Pages adapter)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("joins the catchall segments into the upstream path (query preserved)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await onRequest({
      request: new Request("https://app.example/api/llm/v1/models?x=1"),
      params: { catchall: ["v1", "models"] },
      env: ENV,
    });
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/models?x=1",
    );
  });
});
