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

/** Cloudflare Workers AI uses OpenAI-compatible /v1/chat/completions. */
export interface CloudflareAIOptions {
  readonly accountId: string;
  readonly apiToken: string;
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

function makeCloudflareSend(
  accountId: string,
  apiToken: string,
  signal?: AbortSignal,
) {
  return async (body: unknown): Promise<unknown> => {
    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    // Normalize body: ensure all message content fields are strings
    const normalized = normalizeCloudflareBody(body);
    const isDev = import.meta.env.DEV;
    const url = isDev
      ? `/api/cf-ai/client/v4/accounts/${accountId}/ai/v1/chat/completions`
      : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (!isDev) {
      headers.Authorization = `Bearer ${apiToken}`;
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(normalized),
      signal,
    });
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
 * Builds an LLMClient backed by Cloudflare Workers AI (OpenAI-compatible endpoint).
 * Defaults to the vision model used by Monet's frame analysis pipeline.
 */
export function makeCloudflareAIClient(opts: CloudflareAIOptions): LLMClient {
  const send = withRetry(
    makeCloudflareSend(opts.accountId, opts.apiToken, opts.signal),
    { signal: opts.signal },
  );
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
  // Cloudflare Workers AI has its own dedicated transport
  if (opts.provider === "cloudflare") {
    return makeCloudflareAIClient({
      accountId: opts.baseUrl ?? "",
      apiToken: opts.apiKey,
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
