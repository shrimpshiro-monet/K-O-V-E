import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
  CLOUDFLARE_QUOTA_CODE,
  LLMNetworkError,
} from "@kove-advanced/agent";
import type { LLMClient } from "@kove-advanced/agent";
import { apiFetch } from "../api-proxy";
import type { LlmProvider } from "../../stores/settings-store";

const PATHS: Record<LlmProvider, string> = {
  "openai-compatible": "/chat/completions",
  "anthropic-compatible": "/messages",
  "cloudflare": "/chat/completions",
};

/** Active Cloudflare account. 1 = primary, 2 = the fallback pair. */
export type CloudflareSlot = 1 | 2;

/**
 * Measured against Workers AI (gemma-4-26b): 2516 prompt tokens → 22.9 neurons.
 * Cached prompt tokens are billed at the same rate on the free tier.
 */
export const CLOUDFLARE_NEURONS_PER_TOKEN = 0.0091;

/** A token/account credential pair (they must be a matching pair or you get 403). */
export interface CloudflareAccount {
  readonly accountId: string;
  readonly apiToken: string;
}

/**
 * Which account the transport is using. Module-level on purpose: a fresh
 * client is built every turn, but the "this account is out of quota" decision
 * has to outlive it. Reset on page reload (the daily allocation resets too).
 */
let cloudflareSlot: CloudflareSlot = 1;

export const getCloudflareSlot = (): CloudflareSlot => cloudflareSlot;
export const resetCloudflareSlot = (): void => {
  cloudflareSlot = 1;
};

/** Cloudflare Workers AI uses OpenAI-compatible /v1/chat/completions. */
export interface CloudflareAIOptions extends CloudflareAccount {
  /** Second token/account pair used once the primary's daily quota is spent. */
  readonly fallback?: CloudflareAccount;
  /** Fired once, with 2, when the primary account hits its daily allocation. */
  readonly onSlotChange?: (slot: CloudflareSlot) => void;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

const isQuotaExhausted = (status: number, body: string, code?: number | string): boolean => {
  if (status !== 429) return false;
  if (code !== undefined) return String(code) === String(CLOUDFLARE_QUOTA_CODE);
  return new RegExp(`"code"\\s*:\\s*${CLOUDFLARE_QUOTA_CODE}\\b`).test(body);
};

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

function makeCloudflareSend(opts: CloudflareAIOptions) {
  const isDev = import.meta.env.DEV;
  const primary: CloudflareAccount = {
    accountId: opts.accountId,
    apiToken: opts.apiToken,
  };
  const hasFallback = Boolean(opts.fallback);
  return async (body: unknown): Promise<unknown> => {
    // Normalize body: ensure all message content fields are strings
    const normalized = normalizeCloudflareBody(body);
    // At most one flip per request: a spent fallback must surface as an error,
    // never as an endless primary<->secondary ping-pong.
    let flipped = false;
    for (;;) {
      if (opts.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const slot: CloudflareSlot = hasFallback ? cloudflareSlot : 1;
      const creds = slot === 2 && opts.fallback ? opts.fallback : primary;
      const url = isDev
        ? `${slot === 2 ? "/api/cf-ai-2" : "/api/cf-ai"}/client/v4/accounts/${creds.accountId}/ai/v1/chat/completions`
        : `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/v1/chat/completions`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (!isDev) {
        headers.Authorization = `Bearer ${creds.apiToken}`;
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(normalized),
          signal: opts.signal,
        });
      } catch (error) {
        // Abort is deliberate; anything else means no answer came back. The dev
        // proxy answers upstream connection failures with a synthetic 500, so
        // this path covers the browser-side half of the same class of failure.
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (error instanceof TypeError) {
          throw new LLMNetworkError(
            "Could not reach the AI endpoint — the dev proxy or network is unavailable.",
            { cause: error },
          );
        }
        throw error;
      }
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      const error = llmHttpError(
        "cloudflare-ai",
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
      if (
        hasFallback &&
        !flipped &&
        cloudflareSlot === 1 &&
        isQuotaExhausted(res.status, text, error.code)
      ) {
        cloudflareSlot = 2;
        flipped = true;
        opts.onSlotChange?.(2);
        continue;
      }
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
  const send = withRetry(makeCloudflareSend(opts), { signal: opts.signal });
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
        throw new LLMNetworkError(
          "Could not reach the compatible endpoint. Check its URL, availability, and browser CORS settings.",
          { cause: error },
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
  /** Provider: "cloudflare" only. Second token/account pair for quota fallback. */
  readonly cloudflareFallback?: CloudflareAccount;
  /** Provider: "cloudflare" only. Fired with 2 when the primary quota is spent. */
  readonly onCloudflareSlotChange?: (slot: CloudflareSlot) => void;
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
      fallback: opts.cloudflareFallback,
      onSlotChange: opts.onCloudflareSlotChange,
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
