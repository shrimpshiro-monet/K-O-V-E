import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
} from "@kove-advanced/agent";
import type { LLMClient } from "@kove-advanced/agent";
import { apiFetch } from "../api-proxy";
import type { LlmProvider } from "../../stores/settings-store";

const PATHS: Record<LlmProvider, string> = {
  "openai-compatible": "/chat/completions",
  "anthropic-compatible": "/messages",
  "cloudflare": "/chat/completions",
};

/**
 * Cloudflare Workers AI is reached through a server-side gateway ONLY.
 *
 * The provider token and account id are NEVER part of the client: in the
 * browser they live in Cloudflare Pages secrets (apps/web/functions/api/llm),
 * in dev they are injected by the Vite dev proxy (vite.config.ts) reading
 * .dev.vars, and on desktop the Electron main process reads them from the
 * environment at runtime. The client sends an unauthenticated JSON body to a
 * same-origin path and receives the provider response.
 *
 * Workers AI uses an OpenAI-compatible /v1/chat/completions shape.
 */
export interface CloudflareAIOptions {
  readonly model?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
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

/**
 * Same-origin gateway path for Cloudflare Workers AI. The server side
 * (Pages Function in prod, Vite dev proxy in dev, Electron main process on
 * desktop) attaches the provider credentials. The client never sees them and
 * never calls api.cloudflare.com directly.
 */
const CF_LLM_PATH = "/v1/chat/completions";

async function gatewayFetch(
  path: string,
  payload: string,
  signal?: AbortSignal,
): Promise<Response> {
  const bridge = typeof window !== "undefined" ? window["kove-advanced"] : undefined;
  if (bridge?.platform === "desktop" && bridge.cloud) {
    // Desktop: the main process performs the request with runtime
    // credentials (env / .dev.vars) and relays the response.
    const result = await bridge.cloud.fetch("cloudflare", path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }
  // Browser (dev + prod): same-origin gateway. Dev is served by the Vite dev
  // proxy; production by apps/web/functions/api/llm (Cloudflare Pages).
  return fetch(`/api/llm${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal,
  });
}

function makeCloudflareSend(signal?: AbortSignal) {
  return async (body: unknown): Promise<unknown> => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Normalize body: ensure all message content fields are strings
    const normalized = normalizeCloudflareBody(body);
    const res = await gatewayFetch(CF_LLM_PATH, JSON.stringify(normalized), signal);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw llmHttpError(
        "cloudflare-ai",
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json();
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
 * Builds an LLMClient backed by Cloudflare Workers AI through the
 * server-side gateway (see CloudflareAIOptions). No provider credentials are
 * accepted or sent by the client.
 */
export function makeCloudflareAIClient(opts: CloudflareAIOptions): LLMClient {
  const send = withRetry(makeCloudflareSend(opts.signal), {
    signal: opts.signal,
  });
  return makeClientFromSend({
    provider: "openai",
    model: opts.model ?? "@cf/google/gemma-4-26b-a4b-it",
    maxTokens: opts.maxTokens ?? 4096,
    send,
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
    try {
      res = await apiFetch(provider, PATHS[provider], apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        baseUrl,
        signal,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          "Could not reach the compatible endpoint. Check its URL, availability, and browser CORS settings.",
        );
      }
      throw error;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw llmHttpError(
        provider,
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json();
  };
}

export interface BYOKClientOptions {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * Builds an @kove-advanced/agent LLMClient whose transport routes through the
 * existing BYOK apiFetch (same-origin Pages proxy for built-ins, direct browser
 * requests for custom endpoints, and keychain-backed native requests on desktop).
 */
export function makeBYOKClient(opts: BYOKClientOptions): LLMClient {
  // Cloudflare Workers AI routes through the server-side gateway; no
  // provider credentials are passed or stored client-side. (opts.apiKey /
  // opts.baseUrl are ignored for this provider by design.)
  if (opts.provider === "cloudflare") {
    return makeCloudflareAIClient({
      model: opts.model,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
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
