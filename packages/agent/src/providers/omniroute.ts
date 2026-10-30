import {
  withRetry,
  makeClientFromSend,
  llmHttpError,
  parseRetryAfterMs,
} from "../llm";
import type { LLMClient, LLMSend } from "../llm";

export interface OmniRouteConfig {
  /** OpenAI-compatible base, e.g. http://localhost:20128/v1 */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Pinned model slug — never `auto`, which can switch models mid-run. */
  readonly model: string;
}

interface OmniStreamToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

interface OmniStreamChunk {
  readonly model?: string;
  readonly usage?: unknown;
  readonly error?: unknown;
  readonly choices?: Array<{
    readonly delta?: {
      readonly content?: string;
      readonly tool_calls?: OmniStreamToolCallDelta[];
    };
    readonly message?: {
      readonly content?: string;
      readonly tool_calls?: OmniStreamToolCallDelta[];
    };
    readonly finish_reason?: string;
  }>;
}

/**
 * Alibaba (and most OpenAI-compatible relays) hard-terminate non-streaming
 * requests once a big generation passes their sync window (~15 min), which
 * killed every 16k-token plan_edit call as a bare "fetch failed". OmniRoute
 * happily relays SSE, so the omni transport always asks for stream:true and
 * folds the chunks back into the single JSON shape parseOpenAIResponse
 * expects.
 */
export function aggregateOmniStream(raw: string): unknown {
  let content = "";
  const toolCalls: Array<{ id?: string; name?: string; args: string }> = [];
  let finishReason: string | undefined;
  let model: string | undefined;
  let usage: unknown;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: OmniStreamChunk;
    try {
      chunk = JSON.parse(payload) as OmniStreamChunk;
    } catch {
      continue;
    }
    if (chunk.error) {
      throw llmHttpError("omniroute", 502, JSON.stringify(chunk.error), undefined);
    }
    model ??= chunk.model;
    usage ??= chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? choice.message;
    if (typeof delta?.content === "string") content += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      const index = typeof tc.index === "number" ? tc.index : 0;
      const slot = (toolCalls[index] ??= { args: "" });
      if (typeof tc.id === "string" && tc.id && !slot.id) slot.id = tc.id;
      const fnName = tc.function?.name;
      if (typeof fnName === "string" && fnName && !slot.name) slot.name = fnName;
      if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const toolCallsOut = toolCalls
    .map((tc, index) => ({
      id: tc.id ?? `stream-tool-call-${index}`,
      type: "function" as const,
      function: { name: tc.name ?? "", arguments: tc.args },
    }))
    .filter((tc) => tc.function.name);
  return {
    model,
    usage,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          ...(content ? { content } : {}),
          ...(toolCallsOut.length > 0 ? { tool_calls: toolCallsOut } : {}),
        },
        finish_reason: finishReason ?? (toolCallsOut.length > 0 ? "tool_calls" : "stop"),
      },
    ],
  };
}

const abortError = (): DOMException => new DOMException("Aborted", "AbortError");

export interface OmniTransportOptions {
  readonly fetchFn?: typeof fetch;
  /** Whole-request cap. A generation that never ends must not pin a slot. */
  readonly requestTimeoutMs?: number;
  /** Max silence between SSE chunks before the stream is torn down. */
  readonly idleTimeoutMs?: number;
  /**
   * Caller abort (user cancel). Propagated as a plain AbortError so a
   * surrounding fallback client never treats a cancel as provider failure.
   */
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  /**
   * Transport-level retries on 429/5xx. Pass 0 when a fallback client owns
   * failover — otherwise the ladder waits through a full backoff cycle
   * before it is allowed to switch providers.
   */
  readonly retries?: number;
}

/**
 * OpenAI-compatible transport for a self-hosted OmniRoute gateway (or any
 * /v1 relay). The API key is used per-request for the Authorization header
 * only and is never stored or logged.
 */
export function makeOmniRouteSend(
  cfg: OmniRouteConfig,
  opts: OmniTransportOptions = {},
): LLMSend {
  const fetchFn = opts.fetchFn ?? fetch;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30 * 60 * 1000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const callerSignal = opts.signal;
  const url = `${cfg.baseUrl}/chat/completions`;
  return async (body: unknown): Promise<unknown> => {
    if (callerSignal?.aborted) throw abortError();
    const base = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ ...base, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw llmHttpError(
          "omniroute",
          res.status,
          text,
          parseRetryAfterMs(res.headers.get("retry-after")),
        );
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let raw = "";
        for (;;) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              controller.abort();
              reject(llmHttpError("omniroute", 504, `omniroute stream idle for ${idleTimeoutMs}ms`));
            }, idleTimeoutMs);
          });
          const read = reader.read();
          // If the idle timer wins the race, controller.abort() makes this
          // read reject shortly after — swallow it so it never surfaces as an
          // unhandled rejection.
          read.catch(() => undefined);
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await Promise.race([read, idle]);
          } catch (error) {
            if (error instanceof Error && "status" in error) throw error;
            if (controller.signal.aborted) {
              if (callerSignal?.aborted) throw abortError();
              throw llmHttpError("omniroute", 504, `omniroute stream aborted: ${String(error)}`);
            }
            throw error;
          } finally {
            if (idleTimer) clearTimeout(idleTimer);
          }
          if (chunk.done) break;
          raw += decoder.decode(chunk.value, { stream: true });
        }
        return aggregateOmniStream(raw);
      }
      return res.json();
    } catch (error) {
      if (callerSignal?.aborted) throw abortError();
      if (controller.signal.aborted && !(error instanceof Error && "status" in error)) {
        throw llmHttpError(
          "omniroute",
          504,
          `omniroute request exceeded ${requestTimeoutMs}ms or was aborted`,
        );
      }
      throw error;
    } finally {
      clearTimeout(totalTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

export function makeOmniRouteClient(
  cfg: OmniRouteConfig,
  opts: OmniTransportOptions = {},
): LLMClient {
  const send = withRetry(makeOmniRouteSend(cfg, opts), { retries: opts.retries ?? 3 });
  return makeClientFromSend({
    provider: "openai",
    model: cfg.model,
    maxTokens: opts.maxTokens ?? 4096,
    send,
  });
}
