import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
  makeOmniRouteClient,
} from "@kove-advanced/agent";
import type { LLMClient, OmniRouteConfig } from "@kove-advanced/agent";
import { apiFetch } from "../api-proxy";
import type { LlmProvider } from "../../stores/settings-store";
import { logAIDiagnostic } from "./console-diagnostics";

const PATHS: Record<LlmProvider, string> = {
  "openai-compatible": "/chat/completions",
  "anthropic-compatible": "/messages",
  "cloudflare": "/chat/completions",
};

function requestBodyForDiagnostics(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** Cloudflare Workers AI uses OpenAI-compatible /v1/chat/completions. */
export interface CloudflareAIOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** Dev-only same-origin proxy prefix; ignored in production builds. */
  readonly proxyPrefix?: string;
  /** Transport retries; 0 when a fallback ladder owns failover. */
  readonly retries?: number;
}

/** Ensure content is always a string (Cloudflare rejects arrays/null). */
function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return String(content);
}

function makeCloudflareSend(
  accountId: string,
  apiToken: string,
  signal?: AbortSignal,
  proxyPrefix = "/api/cf-ai",
) {
  return async (body: unknown): Promise<unknown> => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Normalize body: ensure all message content fields are strings
    const normalized = normalizeCloudflareBody(body);
    const isDev = import.meta.env.DEV;
    const url = isDev
      ? `${proxyPrefix}/client/v4/accounts/${accountId}/ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    const startedAt = performance.now();
    logAIDiagnostic("request", {
      provider: "cloudflare",
      model: typeof normalized === "object" && normalized && "model" in normalized
        ? normalized.model
        : undefined,
      body: normalized,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!isDev) {
      headers.Authorization = `Bearer ${apiToken}`;
    }
    let responseStatus: number | undefined;
    let responseBody: unknown;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(normalized),
        signal,
      });
      responseStatus = res.status;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        responseBody = text;
        throw llmHttpError(
          "cloudflare-ai",
          res.status,
          text,
          parseRetryAfterMs(res.headers.get("retry-after")),
        );
      }
      const response = await res.json();
      responseBody = response;
      logAIDiagnostic("response", {
        provider: "cloudflare",
        status: res.status,
        durationMs: Math.round(performance.now() - startedAt),
        body: response,
      });
      return response;
    } catch (error) {
      logAIDiagnostic(
        "request failed",
        {
          provider: "cloudflare",
          status: responseStatus,
          durationMs: Math.round(performance.now() - startedAt),
          response: responseBody,
          error,
        },
        "error",
      );
      throw error;
    }
  };
}

function normalizeCloudflareBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const b = body as Record<string, unknown>;
  const messages = b.messages;
  if (!Array.isArray(messages)) return body;
  return {
    ...b,
    messages: messages.map((m: Record<string, unknown>) => ({
      ...m,
      content: contentToString(m.content),
    })),
  };
}

/**
 * Builds an LLMClient backed by Cloudflare Workers AI (OpenAI-compatible endpoint).
 * Defaults to the vision model used by Monet's frame analysis pipeline.
 */
export function makeCloudflareAIClient(opts: CloudflareAIOptions): LLMClient {
  const send = withRetry(
    makeCloudflareSend(opts.accountId, opts.apiToken, opts.signal, opts.proxyPrefix),
    { signal: opts.signal, retries: opts.retries ?? 3 },
  );
  return makeClientFromSend({
    provider: "openai",
    model: opts.model ?? "@cf/google/gemma-4-26b-a4b-it",
    maxTokens: opts.maxTokens ?? 4096,
    send,
  });
}

/** OmniRoute gateway credentials resolved from VITE_OMNIROUTE_* (.dev.vars). */
export interface OmniRouteGatewayOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * OmniRoute (local gateway) client for the product path. Uses the shared
 * SSE-folding gateway transport, but every request is routed through
 * apiFetch: dev goes through the same-origin Vite proxy (a renderer cannot
 * reach localhost cross-origin) and desktop through the native bridge (Node
 * fetch, no CORS at all).
 *
 * Transport retries are disabled — the fallback ladder decides when to
 * switch to Cloudflare, so sitting in backoff here only delays failover.
 */
export function makeOmniRouteGatewayClient(opts: OmniRouteGatewayOptions): LLMClient {
  const cfg: OmniRouteConfig = {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
  };
  const routedFetch = (async (
    input: globalThis.RequestInfo | URL,
    init?: globalThis.RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const path = url.startsWith(cfg.baseUrl) ? url.slice(cfg.baseUrl.length) : "/chat/completions";
    const startedAt = performance.now();
    const body = typeof init?.body === "string" ? init.body : undefined;
    logAIDiagnostic("request", {
      provider: "omniroute",
      model: cfg.model,
      body: requestBodyForDiagnostics(body),
    });
    try {
      const response = await apiFetch("omniroute", path, cfg.apiKey, {
        method: init?.method ?? "POST",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body,
        baseUrl: cfg.baseUrl,
        signal: init?.signal ?? undefined,
      });
      void response.clone().text().then((responseBody) => {
        logAIDiagnostic(response.ok ? "response" : "response failed", {
          provider: "omniroute",
          model: cfg.model,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          body: responseBody,
        }, response.ok ? "info" : "error");
      }).catch((error: unknown) => {
        logAIDiagnostic("response body unavailable", { provider: "omniroute", error }, "warn");
      });
      return response;
    } catch (error) {
      logAIDiagnostic(
        "request failed",
        {
          provider: "omniroute",
          model: cfg.model,
          durationMs: Math.round(performance.now() - startedAt),
          error,
        },
        "error",
      );
      throw error;
    }
  }) as typeof fetch;
  return makeOmniRouteClient(cfg, {
    fetchFn: routedFetch,
    signal: opts.signal,
    maxTokens: opts.maxTokens,
    retries: 0,
  });
}

function makeSend(
  provider: LlmProvider,
  apiKey: string,
  baseUrl?: string,
  signal?: AbortSignal,
) {
  return async (body: unknown): Promise<unknown> => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    let res: Response;
    const startedAt = performance.now();
    logAIDiagnostic("request", {
      provider,
      body: requestBodyForDiagnostics(JSON.stringify(body)),
    });
    try {
      res = await apiFetch(provider, PATHS[provider], apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        baseUrl,
        signal,
      });
    } catch (error) {
      const reportedError = error instanceof TypeError
        ? new Error(
            "Could not reach the compatible endpoint. Check its URL, availability, and browser CORS settings.",
          )
        : error;
      logAIDiagnostic(
        "request failed",
        {
          provider,
          durationMs: Math.round(performance.now() - startedAt),
          error: reportedError,
        },
        "error",
      );
      if (error instanceof TypeError) {
        throw reportedError;
      }
      throw error;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = llmHttpError(
        provider,
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
      logAIDiagnostic(
        "response failed",
        {
          provider,
          status: res.status,
          durationMs: Math.round(performance.now() - startedAt),
          body: text,
          error,
        },
        "error",
      );
      throw error;
    }
    try {
      const response = await res.json();
      logAIDiagnostic("response", {
        provider,
        status: res.status,
        durationMs: Math.round(performance.now() - startedAt),
        body: response,
      });
      return response;
    } catch (error) {
      logAIDiagnostic(
        "invalid response",
        {
          provider,
          status: res.status,
          durationMs: Math.round(performance.now() - startedAt),
          error,
        },
        "error",
      );
      throw error;
    }
  };
}

export interface BYOKClientOptions {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  /** Cloudflare only: dev proxy prefix for a secondary account. */
  readonly cloudflareProxyPrefix?: string;
  /** Cloudflare only: transport retries; 0 when a ladder owns failover. */
  readonly cloudflareRetries?: number;
}

/**
 * Builds an @kove-advanced/agent LLMClient whose transport routes through the
 * existing BYOK apiFetch (same-origin Pages proxy for built-ins, direct browser
 * requests for custom endpoints, and keychain-backed native requests on desktop).
 */
export function makeBYOKClient(opts: BYOKClientOptions): LLMClient {
  // Cloudflare Workers AI has its own dedicated transport
  if (opts.provider === "cloudflare") {
    return makeCloudflareAIClient({
      accountId: opts.baseUrl ?? "",
      apiToken: opts.apiKey,
      model: opts.model,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      proxyPrefix: opts.cloudflareProxyPrefix,
      retries: opts.cloudflareRetries,
    });
  }

  const send = withRetry(makeSend(opts.provider, opts.apiKey, opts.baseUrl, opts.signal), {
    signal: opts.signal,
  });
  return makeClientFromSend({
    provider:
      opts.provider === "anthropic-compatible" ? "anthropic" : "openai",
    model: opts.model,
    maxTokens: opts.maxTokens,
    omitMaxTokens: opts.provider === "openai-compatible" && opts.maxTokens === undefined,
    send,
  });
}
