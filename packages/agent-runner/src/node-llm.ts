import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
  makeOmniRouteClient,
  makeWorkersAIClient,
  makeFallbackClient,
} from "@kove-advanced/agent";
import type { LLMClient, LLMSend } from "@kove-advanced/agent";
import { loadOmniRouteConfig, loadWorkersAIConfig } from "@kove-advanced/agent/providers/dev-vars";

export type DirectLlmProvider = "anthropic" | "openai";
/**
 * `auto` is the ladder: a configured OmniRoute gateway first, Cloudflare
 * Workers AI second, direct anthropic/openai endpoints only when a key says
 * so. `omni`/`cloudflare` force one side (omni keeps Workers as its
 * secondary); `anthropic`/`openai` behave exactly as before.
 */
export type LlmProvider = DirectLlmProvider | "omni" | "cloudflare" | "auto";

export function resolveLlmProvider(
  provider: LlmProvider,
  repoRoot?: string,
): DirectLlmProvider | "omni" | "cloudflare" {
  if (provider !== "auto") return provider;
  if (loadOmniRouteConfig(repoRoot)) return "omni";
  if (loadWorkersAIConfig(repoRoot)) return "cloudflare";
  return "anthropic";
}

const ENDPOINTS: Record<DirectLlmProvider, string> = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

function authHeaders(
  provider: DirectLlmProvider,
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Builds a fetch-based transport for the agent LLM clients. The API key is used
 * per-request for the Authorization header only and is never stored or logged —
 * preserving the BYOK no-persist guarantee on the server side.
 */
export function makeNodeLLMSend(
  provider: DirectLlmProvider,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): LLMSend {
  if (!apiKey) {
    throw new Error(`Missing API key for provider '${provider}'`);
  }
  return async (body: unknown): Promise<unknown> => {
    const res = await fetchFn(ENDPOINTS[provider], {
      method: "POST",
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify(body),
    });
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

export interface NodeLLMOptions {
  readonly provider: LlmProvider;
  /** Overrides the provider's configured/default model where one exists. */
  readonly model?: string;
  /** anthropic/openai only; gateway providers read their key from env/.dev.vars. */
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly fetchFn?: typeof fetch;
  /** Notified once per gateway→Workers failover (CLI logs it to stderr). */
  readonly onFallback?: (error: unknown) => void;
  /** Explicit `.dev.vars` root (tests); default walks up from the cwd. */
  readonly repoRoot?: string;
}

/**
 * Gateway ladder client. OmniRoute leads (SSE transport, retries disabled so
 * failover is immediate), Cloudflare Workers AI is the secondary; with only
 * one side configured the lone side keeps its own retry policy.
 */
function makeGatewayClient(
  provider: "omni" | "cloudflare",
  opts: NodeLLMOptions,
): LLMClient {
  const omni = loadOmniRouteConfig(opts.repoRoot);
  const workers = loadWorkersAIConfig(opts.repoRoot);

  if (provider === "cloudflare") {
    if (!workers) {
      throw new Error(
        "Cloudflare Workers AI is not configured (set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, in env or .dev.vars).",
      );
    }
    const cfg = opts.model ? { ...workers, model: opts.model } : workers;
    return makeWorkersAIClient(cfg, {
      fetchFn: opts.fetchFn,
      maxTokens: opts.maxTokens,
    });
  }

  if (!omni) {
    throw new Error(
      "OmniRoute is not configured (set OMNIROUTE_KEY + OMNIROUTE_MODEL, in env or .dev.vars).",
    );
  }
  const cfg = opts.model ? { ...omni, model: opts.model } : omni;
  const primary = makeOmniRouteClient(cfg, {
    fetchFn: opts.fetchFn,
    maxTokens: opts.maxTokens,
    retries: workers ? 0 : 3,
  });
  if (!workers) return primary;
  const secondary = makeWorkersAIClient(workers, {
    fetchFn: opts.fetchFn,
    maxTokens: opts.maxTokens,
  });
  return makeFallbackClient({ primary, secondary, onFallback: opts.onFallback });
}

export function makeNodeLLMClient(opts: NodeLLMOptions): LLMClient {
  const provider = resolveLlmProvider(opts.provider);
  if (provider === "omni" || provider === "cloudflare") {
    return makeGatewayClient(provider, opts);
  }
  const apiKey = opts.apiKey ?? "";
  if (!apiKey) {
    throw new Error(`Missing API key for provider '${provider}'`);
  }
  if (!opts.model) {
    throw new Error(`Missing model for provider '${provider}' (pass --model).`);
  }
  const send = withRetry(makeNodeLLMSend(provider, apiKey, opts.fetchFn));
  return makeClientFromSend({
    provider,
    model: opts.model,
    maxTokens: opts.maxTokens,
    send,
  });
}
