import { withRetry, makeClientFromSend, llmHttpError, parseRetryAfterMs } from "../llm";
import type { LLMClient, LLMSend } from "../llm";

export interface WorkersAIConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly model: string;
}

export interface WorkersAITransportOptions {
  readonly fetchFn?: typeof fetch;
  readonly maxTokens?: number;
  /** Transport-level retries on 429/5xx; 0 when a fallback client owns failover. */
  readonly retries?: number;
}

/**
 * OpenAI-compatible Workers AI transport. The API key is used per-request for
 * the Authorization header only and is never stored or logged.
 */
export function makeWorkersAISend(
  cfg: WorkersAIConfig,
  opts: WorkersAITransportOptions = {},
): LLMSend {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1/chat/completions`;
  return async (body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify(body),
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

export function makeWorkersAIClient(
  cfg: WorkersAIConfig,
  opts: WorkersAITransportOptions = {},
): LLMClient {
  const send = withRetry(makeWorkersAISend(cfg, opts), { retries: opts.retries ?? 3 });
  return makeClientFromSend({
    provider: "openai",
    model: cfg.model,
    maxTokens: opts.maxTokens ?? 4096,
    send,
  });
}
