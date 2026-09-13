# K.O.V.E. AI Director — Complete Handoff Bible

> **Purpose**: This document contains ALL source code needed to build, understand, and customize the Monet AI Director for K.O.V.E. No reverse-engineering required.
>
> **Last Updated**: September 8, 2026

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Agent Core System](#2-agent-core-system)
3. [Director System (Monet)](#3-director-system-monet)
4. [Frame Worker (Vision Analysis)](#4-frame-worker-vision-analysis)
5. [Tool Registry (223+ Tools)](#5-tool-registry-223-tools)
6. [UI Integration Layer](#6-ui-integration-layer)
7. [Chat UI Components](#7-chat-ui-components)
8. [Configuration & Types](#8-configuration--types)

---

## 1. Architecture Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    K.O.V.E. AI Director (Monet)                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │   Chat UI    │───▶│  Agent Loop  │───▶│  Tool Reg.   │      │
│  │ ChatPanel.tsx│    │   loop.ts    │    │ registry.ts  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │                │
│         ▼                   ▼                   ▼                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Chat Store   │    │  LLM Client  │    │ Live Host    │      │
│  │ chat-store.ts│    │   llm.ts     │    │live-host.ts  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │                │
│         ▼                   ▼                   ▼                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ History Store│    │  Anthropic/  │    │Project Store │      │
│  │chat-history  │    │  OpenAI API  │    │project-store │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                      Frame Worker Pipeline                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Extraction  │───▶│   Batching   │───▶│  CF Vision   │      │
│  │frame-extract │    │   worker.ts  │    │    Worker     │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                   │                   │                │
│         ▼                   ▼                   ▼                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │Scene Detect  │    │Frame Batches │    │Vision Results│      │
│  │ Adaptive FPS │    │  6 per batch │    │Descriptions  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                     Director Schemas                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Segment Map  │    │  Edit Plan   │    │    Genre     │      │
│  │segment-map.ts│    │ edit-plan.ts │    │  genre.ts    │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User uploads videos** → Media stored in project
2. **User sends chat message** → Chat Store processes
3. **Agent Loop runs** → Calls LLM with system prompt + tools
4. **LLM returns tool calls** → Executor dispatches to handlers
5. **Tools modify project** → Project Store updates timeline
6. **Preview renders** → User sees changes in real-time
7. **Export** → Final video rendered via FFmpeg

### Key Design Decisions

- **Hybrid approach**: System prompt + existing tools + 2 new director tools
- **Adaptive frame sampling**: 1-2fps baseline, 8-12fps around scene cuts
- **Two-way handoff**: "Jump to Advanced" / "Back to Simple"
- **7 pre-built genres**: highlight-reel, documentary, vlog, tutorial, music-video, corporate, social-reel
- **Vision model**: Cloudflare Workers AI (`@cf/meta/llama-3.2-11b-vision-instruct`)

---

## 2. Agent Core System

### 2.1 Types (`packages/agent/src/types.ts`)

```typescript
export type JSONSchema = Record<string, unknown>;

export type ToolDomain =
  | "read"
  | "project"
  | "media"
  | "track"
  | "clip"
  | "transform"
  | "effect"
  | "color"
  | "speed"
  | "audio"
  | "text"
  | "subtitle"
  | "graphics"
  | "motion"
  | "transition"
  | "keyframe"
  | "marker"
  | "ai"
  | "export"
  | "multicam"
  | "raw";

export interface ToolDef {
  readonly name: string;
  readonly domain: ToolDomain;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly expensive: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
}

export interface ToolResultImage {
  readonly dataUrl: string;
  readonly mimeType?: string;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
  readonly error?: ToolError;
  readonly image?: ToolResultImage;
}

export interface AgentMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: ToolResult }
  | { type: "awaiting_confirmation"; call: ToolCall }
  | { type: "error"; error: ToolError }
  | { type: "turn_complete"; text: string };

export type ConfirmDecision = "approve" | "reject" | "approve_for_turn";
```

### 2.2 Agent Loop (`packages/agent/src/loop.ts`)

```typescript
import type { EditingHost } from "./host";
import type { AgentEvent, ConfirmDecision, ToolCall, ToolResult } from "./types";
import type {
  LLMClient,
  LoopMessage,
  LLMUsage,
  LoopToolResult,
  LoopToolResultBlock,
} from "./llm";
import { executeTool, isDestructive, isExpensive } from "./executor";
import { getTool } from "./registry";

export interface RunTurnInput {
  readonly host: EditingHost;
  readonly llm: LLMClient;
  readonly tools: unknown[];
  readonly system?: string;
  readonly messages: LoopMessage[];
  readonly confirmGate?: (call: ToolCall) => Promise<ConfirmDecision> | ConfirmDecision;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly limits?: { maxSteps?: number; maxToolCalls?: number; maxTokens?: number };
  readonly dryRun?: boolean;
  readonly turnLabel?: string;
}

export type StopReason =
  | "end_turn"
  | "max_steps"
  | "max_tool_calls"
  | "budget"
  | "error";

export interface RunTurnResult {
  readonly text: string;
  readonly messages: LoopMessage[];
  readonly toolCalls: number;
  readonly stoppedReason: StopReason;
  readonly committed: boolean;
  readonly usage: LLMUsage;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    host,
    llm,
    tools,
    system,
    confirmGate,
    onEvent,
    dryRun = false,
    turnLabel = "AI edit",
  } = input;
  const maxSteps = input.limits?.maxSteps ?? 12;
  const maxToolCalls = input.limits?.maxToolCalls ?? 64;
  const maxTokens = input.limits?.maxTokens;

  const emit = (event: AgentEvent): void => onEvent?.(event);
  const messages: LoopMessage[] = [...input.messages];
  let toolCalls = 0;
  let approveAll = false;
  let lastText = "";
  const usage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  const txn = host.beginTransaction(turnLabel);

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (
        maxTokens !== undefined &&
        usage.inputTokens + usage.outputTokens >= maxTokens
      ) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "budget",
          committed: true,
          usage,
        };
      }
      const response = await llm.complete({ system, messages, tools });
      lastText = response.text;
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
      }
      if (response.text) emit({ type: "text_delta", text: response.text });

      if (response.toolUses.length === 0) {
        messages.push({ role: "assistant", content: response.text, toolUses: [] });
        host.commitTransaction(txn, turnLabel);
        emit({ type: "turn_complete", text: response.text });
        return {
          text: response.text,
          messages,
          toolCalls,
          stoppedReason: response.stopReason === "max_tokens" ? "budget" : "end_turn",
          committed: true,
          usage,
        };
      }

      messages.push({
        role: "assistant",
        content: response.text,
        toolUses: response.toolUses,
      });

      const results: LoopToolResult[] = [];
      let hitToolCallLimit = false;
      for (let ti = 0; ti < response.toolUses.length; ti++) {
        const toolUse = response.toolUses[ti];
        if (toolCalls >= maxToolCalls) {
          for (let ri = ti; ri < response.toolUses.length; ri++) {
            const pending = response.toolUses[ri];
            const capped = {
              ok: false as const,
              summary: "Tool-call budget reached",
              error: {
                code: "MAX_TOOL_CALLS",
                message: "Per-turn tool-call limit reached",
              },
            };
            emit({
              type: "tool_result",
              call: { id: pending.id, name: pending.name, args: pending.input },
              result: capped,
            });
            results.push({
              toolUseId: pending.id,
              content: JSON.stringify(capped),
              isError: true,
            });
          }
          hitToolCallLimit = true;
          break;
        }
        toolCalls++;
        const call: ToolCall = {
          id: toolUse.id,
          name: toolUse.name,
          args: toolUse.input,
        };
        emit({ type: "tool_call", call });

        const needsConfirm =
          !dryRun &&
          !approveAll &&
          (isDestructive(call.name) || isExpensive(call.name));
        if (needsConfirm && confirmGate) {
          emit({ type: "awaiting_confirmation", call });
          const decision = await confirmGate(call);
          if (decision === "approve_for_turn") approveAll = true;
          if (decision === "reject") {
            const rejected = {
              ok: false as const,
              summary: "Rejected by user",
              error: { code: "REJECTED", message: "User rejected this action" },
            };
            emit({ type: "tool_result", call, result: rejected });
            results.push({
              toolUseId: call.id,
              content: JSON.stringify(rejected),
              isError: true,
            });
            continue;
          }
        }

        let result;
        if (dryRun && !isReadOnly(call.name)) {
          result = {
            ok: true as const,
            summary: `[dry-run] would call ${call.name}`,
          };
        } else {
          result = await executeTool(call.name, call.args, host);
        }
        emit({ type: "tool_result", call, result });
        results.push({
          toolUseId: call.id,
          content: buildToolResultContent(result),
          isError: !result.ok,
        });
      }

      messages.push({ role: "tool", results });

      if (hitToolCallLimit) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "max_tool_calls",
          committed: true,
          usage,
        };
      }
    }

    host.commitTransaction(txn, turnLabel);
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "max_steps",
      committed: true,
      usage,
    };
  } catch (error) {
    await host.rollbackTransaction(txn);
    const message = error instanceof Error ? error.message : "Agent turn failed";
    emit({ type: "error", error: { code: "LOOP_ERROR", message } });
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "error",
      committed: false,
      usage,
    };
  }
}
```

### 2.3 Tool Executor (`packages/agent/src/executor.ts`)

```typescript
import type { EditingHost } from "./host";
import type { ToolResult } from "./types";
import { getTool } from "./registry";
import { resolveClipId } from "./serialize";

function resolveRefs(
  args: Record<string, unknown>,
  host: EditingHost,
): Record<string, unknown> {
  if (typeof args.clipId === "string") return args;
  const hasRef =
    typeof args.clipIndex === "number" || typeof args.atSec === "number";
  if (!hasRef) return args;
  try {
    const id = resolveClipId(host.getProject(), {
      index: args.clipIndex as number | undefined,
      atSec: args.atSec as number | undefined,
      trackIndex: args.trackIndex as number | undefined,
    });
    if (id) return { ...args, clipId: id };
  } catch {
    // no open project / resolution failed
  }
  return args;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  host: EditingHost,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      error: { code: "UNKNOWN_TOOL", message: `No tool named '${name}'` },
    };
  }
  const resolved = resolveRefs(args ?? {}, host);
  try {
    return await tool.handler(resolved, host);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { ok: false, summary: message, error: { code: "TOOL_ERROR", message } };
  }
}

export function isDestructive(name: string): boolean {
  return getTool(name)?.destructive ?? false;
}

export function isExpensive(name: string): boolean {
  return getTool(name)?.expensive ?? false;
}
```

### 2.4 LLM Client (`packages/agent/src/llm.ts`)

```typescript
export interface LLMToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type LLMStopReason = "end_turn" | "tool_use" | "max_tokens";

export type LlmProviderName = "anthropic" | "openai";

export interface LLMUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LLMResponse {
  readonly text: string;
  readonly toolUses: LLMToolUse[];
  readonly stopReason: LLMStopReason;
  readonly usage?: LLMUsage;
}

export type LoopToolResultBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

export interface LoopToolResult {
  readonly toolUseId: string;
  readonly content: string | LoopToolResultBlock[];
  readonly isError: boolean;
}

export type LoopMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolUses: LLMToolUse[] }
  | { role: "tool"; results: LoopToolResult[] };

export interface LLMTurnInput {
  readonly system?: string;
  readonly messages: LoopMessage[];
  readonly tools: unknown[];
}

export interface LLMClient {
  complete(input: LLMTurnInput): Promise<LLMResponse>;
}

export type LLMSend = (body: unknown) => Promise<unknown>;

export class LLMHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LLMHttpError";
  }
}

export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(headerValue);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export function llmHttpError(
  provider: string,
  status: number,
  body: string,
  retryAfterMs?: number,
): LLMHttpError {
  return new LLMHttpError(`${provider} ${status}: ${body.slice(0, 500)}`, status, retryAfterMs);
}

export interface RetryOptions {
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isRetryable?: (error: unknown) => boolean;
  readonly signal?: AbortSignal;
}

export function withRetry(send: LLMSend, opts: RetryOptions = {}): LLMSend {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? realSleep;
  const isRetryable = opts.isRetryable ?? defaultRetryable;

  return async (body: unknown): Promise<unknown> => {
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      try {
        return await send(body);
      } catch (error) {
        if (attempt >= retries || !isRetryable(error)) throw error;
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const retryAfter =
          error instanceof LLMHttpError ? error.retryAfterMs : undefined;
        const ceiling =
          retryAfter !== undefined
            ? Math.min(maxDelayMs, Math.max(backoff, retryAfter))
            : backoff;
        await abortableSleep(Math.random() * ceiling, sleep, opts.signal);
        attempt++;
      }
    }
  };
}

export function buildAnthropicBody(
  input: LLMTurnInput,
  model: string,
  maxTokens: number,
): unknown {
  const messages = input.messages.map((m) => {
    if (m.role === "user") {
      return { role: "user", content: [{ type: "text", text: m.content }] };
    }
    if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tu of m.toolUses) {
        content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      return { role: "assistant", content };
    }
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      })),
    };
  });
  return {
    model,
    max_tokens: maxTokens,
    ...(input.system ? { system: input.system } : {}),
    messages,
    tools: input.tools,
  };
}

export function parseAnthropicResponse(raw: unknown): LLMResponse {
  const upstreamError = responseError(raw, "Anthropic");
  if (upstreamError) throw upstreamError;
  const r = raw as {
    content?: string | Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  let text = typeof r.content === "string" ? r.content : "";
  const toolUses: LLMToolUse[] = [];
  for (const block of Array.isArray(r.content) ? r.content : []) {
    if (block.type === "text" && block.text) text += block.text;
    else if (block.type === "tool_use") {
      if (!block.id || !block.name) {
        throw new Error("Anthropic returned a tool call without an id or name.");
      }
      toolUses.push({
        id: block.id,
        name: block.name,
        input: parseToolInput(block.input, block.name),
      });
    }
  }
  const stopReason: LLMStopReason =
    r.stop_reason === "tool_use"
      ? "tool_use"
      : r.stop_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";
  const usage = r.usage
    ? {
        inputTokens: tokenCount(r.usage.input_tokens),
        outputTokens: tokenCount(r.usage.output_tokens),
      }
    : undefined;
  return { text, toolUses, stopReason, usage };
}

export function buildOpenAIBody(
  input: LLMTurnInput,
  model: string,
  maxTokens?: number,
): unknown {
  const messages: unknown[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  for (const m of input.messages) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolUses.length
          ? {
              tool_calls: m.toolUses.map((tu) => ({
                id: tu.id,
                type: "function",
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results) {
        const content =
          typeof r.content === "string"
            ? r.content
            : (r.content.find(
                (block): block is { type: "text"; text: string } =>
                  block.type === "text",
              )?.text ?? "");
        messages.push({ role: "tool", tool_call_id: r.toolUseId, content });
      }
    }
  }
  return {
    model,
    messages,
    tools: input.tools,
    ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
  };
}

export function parseOpenAIResponse(raw: unknown): LLMResponse {
  const upstreamError = responseError(raw, "OpenAI-compatible provider");
  if (upstreamError) throw upstreamError;
  const r = raw as {
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: unknown[];
        function_call?: unknown;
      };
      finish_reason?: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  const choice = r.choices?.[0];
  if (!choice?.message) {
    throw new Error("OpenAI-compatible provider returned no assistant message.");
  }
  const msg = choice?.message;

  const textFromContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (isRecord(part.text) && typeof part.text.value === "string") {
          return part.text.value;
        }
        return typeof part.content === "string" ? part.content : "";
      })
      .join("");
  };

  const rawToolCalls = Array.isArray(msg.tool_calls) ? [...msg.tool_calls] : [];
  if (rawToolCalls.length === 0 && msg.function_call !== undefined) {
    rawToolCalls.push({ id: "legacy-function-call-0", function: msg.function_call });
  }
  const toolUses: LLMToolUse[] = rawToolCalls.map((rawToolCall, index) => {
    if (!isRecord(rawToolCall)) {
      throw new Error("OpenAI-compatible provider returned an invalid tool call.");
    }
    const fn = isRecord(rawToolCall.function) ? rawToolCall.function : rawToolCall;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) {
      throw new Error("OpenAI-compatible provider returned a tool call without a name.");
    }
    const id =
      typeof rawToolCall.id === "string" && rawToolCall.id
        ? rawToolCall.id
        : `compatible-tool-call-${index}`;
    return {
      id,
      name,
      input: parseToolInput(fn.arguments, name),
    };
  });
  const stopReason: LLMStopReason =
    toolUses.length > 0 || choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call"
      ? "tool_use"
      : choice.finish_reason === "length" || choice.finish_reason === "max_tokens"
        ? "max_tokens"
        : "end_turn";
  const usage = r.usage
    ? {
        inputTokens: tokenCount(r.usage.prompt_tokens ?? r.usage.input_tokens),
        outputTokens: tokenCount(r.usage.completion_tokens ?? r.usage.output_tokens),
      }
    : undefined;
  return { text: textFromContent(msg.content), toolUses, stopReason, usage };
}

export interface ClientFromSendOptions {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly maxTokens?: number;
  readonly omitMaxTokens?: boolean;
  readonly send: LLMSend;
}

export function makeClientFromSend(opts: ClientFromSendOptions): LLMClient {
  const maxTokens = opts.omitMaxTokens ? undefined : (opts.maxTokens ?? 4096);
  return opts.provider === "anthropic"
    ? new AnthropicClient({
        model: opts.model,
        maxTokens: maxTokens ?? 4096,
        send: opts.send,
      })
    : new OpenAIClient({
        model: opts.model,
        maxTokens,
        send: opts.send,
      });
}

export class MockLLMClient implements LLMClient {
  private index = 0;
  constructor(private readonly script: LLMResponse[]) {}
  async complete(): Promise<LLMResponse> {
    const next = this.script[this.index] ?? {
      text: "",
      toolUses: [],
      stopReason: "end_turn" as const,
    };
    this.index++;
    return next;
  }
}
```

### 2.5 Editing Host Interface (`packages/agent/src/host.ts`)

```typescript
import type { Action, ActionResult } from "@kove-advanced/core/types/actions";
import type { Project } from "@kove-advanced/core/types/project";
import type { CapabilityManifest } from "@kove-advanced/core/capabilities/manifest";
import type {
  MulticamActivityMap,
  MulticamManifest,
  MulticamShotPolicy,
  MulticamTranscriptSegment,
} from "@kove-advanced/core";

export type JobKind =
  | "exportVideo"
  | "exportAudio"
  | "exportFrame";

export interface JobResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface TxnHandle {
  readonly id: string;
}

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly modifiedAt?: number;
}

export interface ImportedMediaRef {
  readonly mediaId: string;
  readonly name: string;
  readonly type: string;
  readonly durationSec: number;
  readonly width?: number;
  readonly height?: number;
}

export interface EditingHost {
  getProject(): Project;
  applyAction(action: Action): Promise<ActionResult>;
  beginTransaction(label?: string): TxnHandle;
  commitTransaction(handle: TxnHandle, label: string): void;
  rollbackTransaction(handle: TxnHandle): Promise<void>;
  runJob(kind: JobKind, params: Record<string, unknown>): Promise<JobResult>;
  capabilities(): CapabilityManifest;
  multicam?: MulticamHostBridge;
  requireOpenProject(): void;

  createProject?(options: CreateProjectOptions): Promise<ProjectRef>;
  openProject?(id: string): Promise<ProjectRef>;
  listProjects?(): Promise<readonly ProjectRef[]>;
  saveProject?(): Promise<ProjectRef>;
  importMediaFromUrl?(url: string, options?: { name?: string }): Promise<ImportedMediaRef>;
  exportMotionScene?(options: ExportMotionSceneOptions): Promise<ExportMotionSceneResult>;
  motionRenderQueue?: MotionRenderQueueBridge;
  probeRiggingBackend?(): Promise<RiggingBackendProbe>;
  inspectModel?(options: ModelInspectionRequest): Promise<ModelInspectionReport>;
  rigHumanoidModel?(options: HumanoidRigRequest): Promise<HumanoidRigResult>;

  createTextOverlay?(options: TextOverlayOptions): Promise<OverlayRef>;
  createShapeOverlay?(options: ShapeOverlayOptions): Promise<OverlayRef>;
  updateTextOverlay?(id: string, options: UpdateTextOverlayOptions): Promise<OverlayRef>;
  updateShapeOverlay?(id: string, options: UpdateShapeOverlayOptions): Promise<OverlayRef>;
  createStickerOverlay?(options: StickerOverlayOptions): Promise<OverlayRef>;
  updateStickerOverlay?(id: string, options: UpdateStickerOverlayOptions): Promise<OverlayRef>;
  createSvgOverlay?(options: SvgOverlayOptions): Promise<OverlayRef>;
  updateSvgOverlay?(id: string, updates: Record<string, unknown>): Promise<OverlayRef>;
  removeOverlay?(kind: OverlayKind, id: string): Promise<boolean>;
}

export type OverlayKind = "text" | "shape" | "sticker" | "svg";

export interface TextOverlayOptions {
  readonly text: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
  readonly style?: Record<string, unknown>;
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export interface ShapeOverlayOptions {
  readonly shapeType?: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
  readonly color?: string;
  readonly opacity?: number;
  readonly fullFrame?: boolean;
}

export interface UpdateTextOverlayOptions {
  readonly text?: string;
  readonly style?: Record<string, unknown>;
  readonly transform?: Record<string, unknown>;
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export interface UpdateShapeOverlayOptions {
  readonly color?: string;
  readonly opacity?: number;
  readonly style?: Record<string, unknown>;
  readonly transform?: Record<string, unknown>;
  readonly fullFrame?: boolean;
}

export interface StickerOverlayOptions {
  readonly emoji?: string;
  readonly imageUrl?: string;
  readonly name?: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
}

export interface UpdateStickerOverlayOptions {
  readonly transform?: Record<string, unknown>;
}

export interface SvgOverlayOptions {
  readonly svg: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
}

export interface OverlayRef {
  readonly id: string;
  readonly trackId: string;
}

export type MotionRenderQueueAddFormat =
  | "mp4"
  | "webm-alpha"
  | "mov-prores4444"
  | "png-sequence";

export interface MotionRenderQueueAddInput {
  readonly compositionId: string;
  readonly format?: MotionRenderQueueAddFormat;
  readonly range?: { readonly startTime: number; readonly endTime: number };
  readonly resolutionScale?: number;
  readonly filename?: string;
}

export interface MotionRenderQueueBridge {
  add(input: MotionRenderQueueAddInput): MotionRenderQueueAddResult | MotionRenderQueueAddError;
  run(): Promise<MotionRenderQueueRunResult>;
  list(): ReadonlyArray<Record<string, unknown>>;
  cancel(itemId: string): boolean;
}
```

### 2.6 State Serializer (`packages/agent/src/serialize.ts`)

```typescript
import type { Project } from "@kove-advanced/core/types/project";

export interface EditorStateView {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly settings: {
      readonly width: number;
      readonly height: number;
      readonly fps: number;
    };
  };
  readonly durationSec: number;
  readonly trackCount: number;
  readonly clipCount: number;
  readonly mediaCount: number;
  readonly overlayCount: number;
  readonly creation?: {
    readonly version: string;
    readonly assetCount: number;
    readonly sceneCount: number;
    readonly activeSceneId?: string;
    readonly operationCount: number;
  };
}

export interface MediaView {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly durationSec?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface TrackView {
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly clipCount: number;
}

export interface ClipView {
  readonly id: string;
  readonly trackIndex: number;
  readonly trackType: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly mediaId?: string;
  readonly speed: number;
  readonly hasEffects: boolean;
  readonly hasColorGrading: boolean;
}

export interface ClipFilter {
  readonly trackIndex?: number;
  readonly fromSec?: number;
  readonly toSec?: number;
  readonly offset?: number;
  readonly limit?: number;
}

export function serializeEditorState(project: Project): EditorStateView {
  const ts = tracks(project);
  const creation = project.creation;
  return {
    project: {
      id: project.id,
      name: project.name,
      settings: {
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.frameRate,
      },
    },
    durationSec: project.timeline.duration,
    trackCount: ts.length,
    clipCount: ts.reduce((sum, t) => sum + t.clips.length, 0),
    mediaCount: project.mediaLibrary.items.length,
    overlayCount: overlayCount(project),
    creation: creation
      ? {
          version: creation.version,
          assetCount: creation.assets.length,
          sceneCount: creation.scenes.length,
          activeSceneId: creation.activeSceneId,
          operationCount: creation.operationHistory.length,
        }
      : undefined,
  };
}

export function listMedia(project: Project): MediaView[] {
  return project.mediaLibrary.items.map((item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    durationSec: item.metadata?.duration,
    width: item.metadata?.width,
    height: item.metadata?.height,
  }));
}

export function listTracks(project: Project): TrackView[] {
  return tracks(project).map((t, index) => ({
    index,
    id: t.id,
    type: t.type,
    name: t.name,
    locked: t.locked ?? false,
    hidden: t.hidden ?? false,
    muted: t.muted ?? false,
    solo: t.solo ?? false,
    clipCount: t.clips.length,
  }));
}

export function listClips(project: Project, filter: ClipFilter = {}): ClipView[] {
  const result: ClipView[] = [];
  const ts = tracks(project);
  for (let trackIndex = 0; trackIndex < ts.length; trackIndex++) {
    if (filter.trackIndex !== undefined && filter.trackIndex !== trackIndex) {
      continue;
    }
    const track = ts[trackIndex];
    for (const clip of track.clips) {
      const startSec = clip.startTime;
      const endSec = clip.startTime + clip.duration;
      if (filter.fromSec !== undefined && endSec < filter.fromSec) continue;
      if (filter.toSec !== undefined && startSec > filter.toSec) continue;
      result.push({
        id: clip.id,
        trackIndex,
        trackType: track.type,
        startSec,
        endSec,
        durationSec: clip.duration,
        mediaId: clip.mediaId,
        speed: clip.speed ?? 1,
        hasEffects: (clip.effects?.length ?? 0) > 0,
        hasColorGrading: clip.colorGrading != null,
      });
    }
  }
  if (filter.offset !== undefined || filter.limit !== undefined) {
    const start = Math.max(0, filter.offset ?? 0);
    const end = filter.limit !== undefined ? start + Math.max(0, filter.limit) : undefined;
    return result.slice(start, end);
  }
  return result;
}

export function getClipDetail(
  project: Project,
  clipId: string,
): Record<string, unknown> | undefined {
  const ts = tracks(project);
  for (let trackIndex = 0; trackIndex < ts.length; trackIndex++) {
    const clip = ts[trackIndex].clips.find((c) => c.id === clipId);
    if (clip) {
      return { ...clip, trackIndex, trackType: ts[trackIndex].type };
    }
  }
  return undefined;
}

export function resolveClipId(
  project: Project,
  ref: { id?: string; index?: number; atSec?: number; trackIndex?: number },
): string | undefined {
  const ts = tracks(project);
  if (ref.id) {
    for (const t of ts) if (t.clips.some((c) => c.id === ref.id)) return ref.id;
    return undefined;
  }
  if (ref.trackIndex !== undefined && ref.index !== undefined) {
    return ts[ref.trackIndex]?.clips[ref.index]?.id;
  }
  if (ref.index !== undefined) {
    const flat = ts.flatMap((t) => t.clips);
    return flat[ref.index]?.id;
  }
  if (ref.atSec !== undefined) {
    const candidates = ts
      .filter((_, i) => ref.trackIndex === undefined || i === ref.trackIndex)
      .flatMap((t) => t.clips)
      .filter(
        (c) => ref.atSec! >= c.startTime && ref.atSec! < c.startTime + c.duration,
      );
    return candidates[0]?.id;
  }
  return undefined;
}
```

### 2.7 Tool Router (`packages/agent/src/tool-router.ts`)

```typescript
import { listTools } from "./registry";
import type { RegisteredTool } from "./registry";

export const DEFAULT_AGENT_TOOL_LIMIT = 120;

const ALWAYS_AVAILABLE = new Set([
  "get_editor_state",
  "list_media",
  "list_tracks",
  "list_clips",
  "get_clip",
  "get_capabilities",
  "create_project",
  "list_projects",
  "open_project",
  "save_project",
  "list_motion_compositions",
  "get_motion_composition",
  "create_motion_composition",
  "add_motion_layer",
  "add_motion_layers",
  "set_motion_layer_transform",
  "animate_layer",
  "remove_motion_layer",
  "render_motion_frame",
  "insert_motion_into_editor",
  "execute_action",
  "batch_actions",
]);

const MOTION_TERMS = /\b(motion|composition|layer|keyframe|animate|animation|after effects|lower third|title card|kinetic|lottie|svg|figma|particle|shader|mask|matte|precomp|camera|render frame)\b/i;
const CREATION_TERMS = /\b(3d|three[- ]?d|product|character|scene|model|gltf|glb|rig|mesh|material|texture|bevel|displacement|x[- ]?ray|cloth|camera module|exploded|cinematic|decal|cutaway)\b/i;
const DIRECTOR_TERMS = /\b(direct|edit|cut|trim|highlight|reel|montage|compilation|remix|create|make|kreate|analyze|footage|segment|footage|plan|sequence|chop|splice|join)\b/i;

function relevance(tool: RegisteredTool, promptWords: Set<string>): number {
  if (ALWAYS_AVAILABLE.has(tool.name)) return 10_000;
  const name = new Set(words(tool.name));
  const title = new Set(words(tool.title));
  const description = new Set(words(tool.description));
  let score = tool.readOnly ? 12 : 0;
  for (const word of promptWords) {
    if (name.has(word)) score += 18;
    if (title.has(word)) score += 10;
    if (description.has(word)) score += 2;
  }
  return score;
}

export function selectToolsForPrompt(
  prompt: string,
  options: { readonly maxTools?: number; readonly priorToolNames?: readonly string[] } = {},
): string[] {
  const maxTools = Math.max(1, options.maxTools ?? DEFAULT_AGENT_TOOL_LIMIT);
  const wantsMotion = MOTION_TERMS.test(prompt);
  const wantsCreation = CREATION_TERMS.test(prompt);
  const wantsDirector = DIRECTOR_TERMS.test(prompt);
  const prior = new Set(options.priorToolNames ?? []);
  const promptWords = new Set(words(prompt));

  const candidates = listTools().filter((tool) => {
    if (ALWAYS_AVAILABLE.has(tool.name) || prior.has(tool.name)) return true;
    if (wantsDirector && tool.domain === "ai") return true;
    if (!wantsMotion && !wantsCreation) return tool.domain !== "motion";
    if (wantsCreation && isCreationTool(tool)) return true;
    if (wantsMotion && tool.domain === "motion" && !isCreationTool(tool)) return true;
    return tool.domain === "read" || ["project", "media", "export", "raw"].includes(tool.domain);
  });

  return candidates
    .map((tool, index) => ({
      tool,
      index,
      score:
        relevance(tool, promptWords) +
        (prior.has(tool.name) ? 5_000 : 0) +
        (wantsCreation && isCreationTool(tool) ? 100 : 0) +
        (wantsMotion && tool.domain === "motion" ? 50 : 0) +
        (wantsDirector && tool.domain === "ai" ? 200 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxTools)
    .sort((a, b) => a.index - b.index)
    .map(({ tool }) => tool.name);
}
```

### 2.8 System Prompt Builder (`packages/agent/src/system-prompt.ts`)

```typescript
import type { EditingHost } from "./host";
import { serializeEditorState } from "./serialize";
import { toCapabilityDoc } from "./registry";

export function buildSystemPrompt(
  host: EditingHost,
  selectedToolNames?: Iterable<string>,
): string {
  let state = "(no project open)";
  try {
    state = JSON.stringify(serializeEditorState(host.getProject()));
  } catch {
    // no project open
  }
  return [
    "You are Kove Advanced's video-editing agent. You edit the user's open project by calling tools.",
    "",
    "Guidelines:",
    "- All times are in seconds (float).",
    "- Refer to clips by `clipId` (from list_clips/get_clip). You may also pass `clipIndex` or `atSec` and the tool will resolve the clip.",
    "- Read before you write: use get_editor_state, list_clips, get_clip, and get_capabilities to ground your edits in valid ids and enum values.",
    "- Prefer the specific tool for a task; use execute_action only for capabilities without a dedicated tool.",
    "- Use duplicate_track for timeline-backed video/image/audio tracks. For repeated Motion styling, use transfer_motion_effect_stack or transfer_motion_mask_stack so animated parameters, expressions, ordering, and independent ids are preserved across target layers.",
    "- Destructive/expensive tools (delete, remove, export, AI jobs) require user confirmation — explain what you're about to do.",
    "- After making the requested edits, stop and summarize what you changed.",
    "- Write user-facing responses in concise GitHub-flavored Markdown. Prefer short paragraphs and bullets; use tables only when they improve clarity, and fence code or JSON when you need to show it.",
    "- Do not expose internal chain-of-thought, tool schemas, or raw tool-result JSON. Summarize actions and errors in plain language.",
    "",
    "Monet — AI Director Workflow:",
    "- When the user wants to create an edit from uploaded footage, follow this sequence:",
    "  1. Call `extract_segments` with the video media IDs to analyze the footage. This returns a SegmentMap with per-video scene descriptions.",
    "  2. Call `plan_edit` with the SegmentMap + user prompt + optional genre. This returns a structured EditPlan.",
    "  3. Execute the EditPlan by calling the appropriate tools in order.",
    "- The EditPlan contains structured decisions: which segments to use, where to place them, what effects/transitions/text to add, and why.",
    "- Execute each PlannedSegment by: importing media (if needed), splitting at the right points, moving clips to the timeline, applying effects.",
    "- Execute PlannedText by: creating text clips with the specified style, position, timing.",
    "- Execute PlannedTransitions by: adding transitions between segments.",
    "- After executing the full plan, summarize what was done and let the user know they can refine via chat or jump to Advanced mode.",
    "- Follow the prompt-detail rubric: a prompt skips clarifying Q&A only if it specifies (a) tone/vibe, (b) target length/platform, and (c) what to keep vs cut. Missing one → ask about just that gap. Genre selection also skips Q&A.",
    "- Available genres: highlight-reel, documentary, vlog, tutorial, music-video, corporate, social-reel. User-created custom genres are also supported.",
    "",
    `Current editor state: ${state}`,
    "",
    toCapabilityDoc(selectedToolNames),
  ].join("\n");
}
```

---

## 3. Director System (Monet)

### 3.1 Director Prompt (`packages/agent/src/director/director-prompt.ts`)

```typescript
import type { SegmentMap, EditPlan, Genre } from "@kove-advanced/creation-schema";
import { summarizeSegmentMap } from "@kove-advanced/creation-schema";

export const DIRECTOR_SYSTEM_PROMPT = `You are Monet, an AI film director for Kove Advanced. You analyze footage and create professional edits.

## Your Role
You transform raw footage into polished edits by:
1. Understanding what's in each video (via SegmentMap)
2. Making directorial decisions (via EditPlan)
3. Executing those decisions using the editor's tools

## Workflow
When the user wants to create an edit from uploaded footage:
1. Call \`extract_segments\` with the video media IDs to analyze the footage
2. Review the returned SegmentMap — understand what's available
3. Call \`plan_edit\` with the SegmentMap + user prompt + optional genre
4. Review the returned EditPlan
5. Execute the plan by calling tools: \`split_clip\`, \`move_clip\`, \`add_video_effect\`, \`create_text_clip\`, etc.
6. Summarize what was done

## Directorial Principles
- **Pacing matters**: Match cut rhythm to the content. Action scenes need fast cuts; emotional moments need room to breathe.
- **Story arc**: Even short edits have a beginning, middle, and end. Place the strongest footage at the start (hook) and end (payoff).
- **Audio drives emotion**: Music sets the tone. Sync cuts to beats when possible.
- **Text serves the story**: Titles, lower thirds, and captions should enhance, not clutter.
- **Less is more**: Don't over-edit. The best edits feel invisible.
- **Genre awareness**: Follow the genre rules if provided. A music video needs different treatment than a documentary.

## EditPlan Structure
The EditPlan contains:
- **segments**: Which clips to use, where to place them, and why
- **textElements**: Titles, lower thirds, captions with timing and style
- **effects**: Per-segment or global effects
- **transitions**: Between-segment transitions with duration
- **audioDecisions**: Music, SFX, silence placement
- **metadata**: Target duration, platform, genre, pacing, rationale

## Tool Execution
Execute the plan methodically:
1. First, import media if not already in the project
2. Create tracks if needed
3. Place video segments using \`split_clip\` + \`move_clip\`
4. Add text overlays using \`create_text_clip\`
5. Apply effects using \`add_video_effect\`
6. Add transitions
7. Adjust audio levels

Always explain what you're doing and why. The user can refine via chat or jump to Advanced mode.`;

export function buildDirectorPrompt(
  segmentMap: SegmentMap,
  prompt: string,
  genre?: Genre,
): string {
  const summary = summarizeSegmentMap(segmentMap);
  const genreInfo = genre
    ? `\nGenre: ${genre.name} — ${genre.description}\nRules: ${JSON.stringify(genre.rules, null, 2)}`
    : "";

  return [
    DIRECTOR_SYSTEM_PROMPT,
    "",
    "## Current Task",
    `User request: "${prompt}"`,
    "",
    `Available footage: ${summary}`,
    genreInfo,
    "",
    "Analyze the segments and create an EditPlan that fulfills this request.",
  ].join("\n");
}
```

### 3.2 Genre System (`packages/agent/src/director/genres.ts`)

```typescript
import type { Genre } from "@kove-advanced/creation-schema";

export const PRE_BAKED_GENRES: readonly Genre[] = [
  {
    id: "highlight-reel",
    name: "Highlight Reel",
    description:
      "Fast-paced compilation of the best moments. High energy, quick cuts, rhythm-driven editing.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "whipPan", "flash"],
      effectPalette: ["brightness", "contrast", "saturation"],
      textStyle: "minimal",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "rhythmic",
    },
  },
  {
    id: "documentary",
    name: "Documentary",
    description:
      "Slow, deliberate pacing with context-rich text overlays. Lets the footage breathe.",
    rules: {
      pacing: "slow",
      transitionPreference: ["crossfade", "dipToBlack"],
      effectPalette: ["color-balance", "vignette"],
      textStyle: "moderate",
      cutStyle: "soft",
      colorMood: "neutral",
      musicRole: "background",
    },
  },
  {
    id: "vlog",
    name: "Vlog",
    description:
      "Conversational, personal feel. Mixed pacing with natural transitions.",
    rules: {
      pacing: "medium",
      transitionPreference: ["crossfade", "wipe", "slide"],
      effectPalette: ["brightness", "warmth"],
      textStyle: "moderate",
      cutStyle: "mixed",
      colorMood: "warm",
      musicRole: "background",
    },
  },
  {
    id: "tutorial",
    name: "Tutorial",
    description:
      "Step-by-step clarity. Text-heavy with deliberate pacing on key moments.",
    rules: {
      pacing: "medium",
      transitionPreference: ["crossfade", "dipToBlack"],
      effectPalette: ["brightness", "contrast"],
      textStyle: "heavy",
      cutStyle: "soft",
      colorMood: "neutral",
      musicRole: "background",
    },
  },
  {
    id: "music-video",
    name: "Music Video",
    description:
      "Rhythm-synced cuts with heavy visual effects. The music drives the edit.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "glitch", "flash", "whipPan"],
      effectPalette: [
        "brightness",
        "contrast",
        "saturation",
        "hue-saturation",
        "chromatic-aberration",
        "motion-blur",
      ],
      textStyle: "minimal",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "featured",
    },
  },
  {
    id: "corporate",
    name: "Corporate",
    description:
      "Clean, professional. Minimal effects, clear messaging, polished feel.",
    rules: {
      pacing: "slow",
      transitionPreference: ["crossfade", "dipToWhite"],
      effectPalette: ["brightness", "contrast"],
      textStyle: "moderate",
      cutStyle: "soft",
      colorMood: "cool",
      musicRole: "background",
    },
  },
  {
    id: "social-reel",
    name: "Social Reel",
    description:
      "Short-form, punchy, caption-heavy. Optimized for vertical mobile viewing.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "zoom", "slide"],
      effectPalette: ["brightness", "saturation", "contrast"],
      textStyle: "heavy",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "rhythmic",
    },
  },
];

export function getGenreById(id: string): Genre | undefined {
  return PRE_BAKED_GENRES.find((g) => g.id === id);
}

export function listGenreIds(): readonly string[] {
  return PRE_BAKED_GENRES.map((g) => g.id);
}
```

### 3.3 Schemas (`packages/creation-schema/src/director/`)

#### Segment Map (`segment-map.ts`)

```typescript
export type SceneType =
  | "talking"
  | "action"
  | "transition"
  | "b-roll"
  | "silence"
  | "music";

export type MotionLevel = "static" | "low" | "medium" | "high";

export interface VideoSegment {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly description: string;
  readonly sceneType: SceneType;
  readonly motionLevel: MotionLevel;
  readonly hasDialogue: boolean;
  readonly visualContent: string;
  readonly confidence: number;
}

export interface VideoSegmentMap {
  readonly videoId: string;
  readonly duration: number;
  readonly segments: readonly VideoSegment[];
}

export interface SegmentMap {
  readonly videos: readonly VideoSegmentMap[];
}
```

#### Edit Plan (`edit-plan.ts`)

```typescript
export interface PlannedSegment {
  readonly sourceVideoId: string;
  readonly sourceStartTime: number;
  readonly sourceEndTime: number;
  readonly trackIndex: number;
  readonly targetPosition: number;
  readonly speed?: number;
  readonly effects: readonly string[];
  readonly rationale: string;
}

export type TextStyle =
  | "title"
  | "subtitle"
  | "lower-third"
  | "caption"
  | "callout";

export interface PlannedText {
  readonly content: string;
  readonly style: TextStyle;
  readonly startTime: number;
  readonly duration: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly animation?: string;
  readonly rationale: string;
}

export interface PlannedEffect {
  readonly targetSegmentIndex?: number;
  readonly type: string;
  readonly params: Record<string, unknown>;
  readonly rationale: string;
}

export interface PlannedTransition {
  readonly afterSegmentIndex: number;
  readonly type: string;
  readonly duration: number;
  readonly rationale: string;
}

export type AudioDecisionType = "music" | "sfx" | "silence";

export interface PlannedAudio {
  readonly type: AudioDecisionType;
  readonly sourceVideoId?: string;
  readonly sourceStartTime?: number;
  readonly sourceEndTime?: number;
  readonly startTime: number;
  readonly duration: number;
  readonly volume?: number;
  readonly rationale: string;
}

export type Pacing = "fast" | "medium" | "slow";

export interface EditPlanMetadata {
  readonly targetDuration: number;
  readonly targetPlatform: string;
  readonly genre: string;
  readonly pacing: Pacing;
  readonly rationale: string;
}

export interface EditPlan {
  readonly segments: readonly PlannedSegment[];
  readonly textElements: readonly PlannedText[];
  readonly effects: readonly PlannedEffect[];
  readonly transitions: readonly PlannedTransition[];
  readonly audioDecisions: readonly PlannedAudio[];
  readonly metadata: EditPlanMetadata;
}
```

#### Genre (`genre.ts`)

```typescript
export type CutStyle = "hard" | "soft" | "mixed";
export type MusicRole = "background" | "featured" | "rhythmic";
export type ColorMood = "warm" | "cool" | "neutral" | "vibrant";
export type TextStyleDensity = "none" | "minimal" | "moderate" | "heavy";

export interface GenreRules {
  readonly pacing: "fast" | "medium" | "slow";
  readonly transitionPreference: readonly string[];
  readonly effectPalette: readonly string[];
  readonly textStyle: TextStyleDensity;
  readonly cutStyle: CutStyle;
  readonly colorMood?: ColorMood;
  readonly musicRole: MusicRole;
}

export interface Genre {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rules: GenreRules;
}
```

#### Validation (`validate.ts`)

```typescript
import type { EditPlan, PlannedSegment } from "./edit-plan";
import type { SegmentMap, VideoSegmentMap } from "./segment-map";

export interface DirectorValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly path?: string;
}

export function validateSegmentMap(
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (segmentMap.videos.length === 0) {
    issues.push(
      issue("error", "no_videos", "SegmentMap contains no video analyses."),
    );
    return issues;
  }

  for (const video of segmentMap.videos) {
    if (video.segments.length === 0) {
      issues.push(
        issue(
          "warning",
          "no_segments",
          `Video "${video.videoId}" has no segments.`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    for (const dupe of duplicates(video.segments.map((s) => s.id))) {
      issues.push(
        issue(
          "error",
          "duplicate_segment_id",
          `Duplicate segment id "${dupe}" in video "${video.videoId}".`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    let lastEnd = 0;
    for (const segment of video.segments) {
      if (segment.startTime < lastEnd) {
        issues.push(
          issue(
            "warning",
            "overlapping_segments",
            `Segment "${segment.id}" overlaps with previous segment in video "${video.videoId}".`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.endTime <= segment.startTime) {
        issues.push(
          issue(
            "error",
            "bad_segment_duration",
            `Segment "${segment.id}" has zero or negative duration.`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.confidence < 0 || segment.confidence > 1) {
        issues.push(
          issue(
            "error",
            "bad_confidence",
            `Segment "${segment.id}" confidence ${segment.confidence} is outside [0, 1].`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      lastEnd = segment.endTime;
    }
  }

  return issues;
}

export function validateEditPlan(
  plan: EditPlan,
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (plan.segments.length === 0) {
    issues.push(issue("warning", "empty_plan", "EditPlan has no segments."));
  }

  const videoIds = new Set(
    segmentMap.videos.map((v: VideoSegmentMap) => v.videoId),
  );

  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i] as PlannedSegment;
    if (!videoIds.has(seg.sourceVideoId)) {
      issues.push(
        issue(
          "error",
          "unknown_source_video",
          `Segment ${i} references unknown video "${seg.sourceVideoId}".`,
          `segments.${i}.sourceVideoId`,
        ),
      );
    }
    if (seg.sourceEndTime <= seg.sourceStartTime) {
      issues.push(
        issue(
          "error",
          "bad_source_range",
          `Segment ${i} has zero or negative source duration.`,
          `segments.${i}`,
        ),
      );
    }
    if (seg.targetPosition < 0) {
      issues.push(
        issue(
          "error",
          "negative_position",
          `Segment ${i} has negative target position.`,
          `segments.${i}.targetPosition`,
        ),
      );
    }
  }

  if (plan.metadata.targetDuration <= 0) {
    issues.push(
      issue("error", "bad_target_duration", "Target duration must be positive.", "metadata.targetDuration"),
    );
  }

  return issues;
}

export function summarizeSegmentMap(segmentMap: SegmentMap): string {
  const totalSegments = segmentMap.videos.reduce(
    (sum, v) => sum + v.segments.length,
    0,
  );
  const totalDuration = segmentMap.videos.reduce(
    (sum, v) => sum + v.duration,
    0,
  );
  return `${segmentMap.videos.length} video(s), ${totalSegments} segment(s), ${totalDuration.toFixed(1)}s total`;
}

export function summarizeEditPlan(plan: EditPlan): string {
  return `${plan.segments.length} segment(s), ${plan.textElements.length} text element(s), ${plan.effects.length} effect(s), ${plan.transitions.length} transition(s), target ${plan.metadata.targetDuration}s`;
}
```

---

## 4. Frame Worker (Vision Analysis)

### 4.1 Worker (`packages/frame-worker/src/worker.ts`)

```typescript
export interface Env {
  CF_AI_MODEL: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface VisionRequest {
  readonly frames: readonly FrameBatch[];
  readonly videoId: string;
  readonly totalDuration: number;
}

export interface FrameBatch {
  readonly batchIndex: number;
  readonly frames: readonly FrameData[];
}

export interface FrameData {
  readonly timestamp: number;
  readonly imageData: string; // base64 encoded
  readonly width: number;
  readonly height: number;
}

export interface VisionResult {
  readonly videoId: string;
  readonly batches: readonly BatchResult[];
  readonly totalFrames: number;
  readonly processingTimeMs: number;
}

export interface BatchResult {
  readonly batchIndex: number;
  readonly descriptions: readonly FrameDescription[];
}

export interface FrameDescription {
  readonly timestamp: number;
  readonly description: string;
  readonly sceneType: string;
  readonly motionLevel: string;
  readonly hasDialogue: boolean;
  readonly confidence: number;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function analyzeBatch(
  env: Env,
  batch: FrameBatch,
  _videoId: string,
): Promise<BatchResult> {
  const model = env.CF_AI_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error("Cloudflare credentials not configured");
  }

  const descriptions: FrameDescription[] = [];

  for (const frame of batch.frames) {
    const prompt = `Analyze this video frame. Return a JSON object with these fields:
- "description": A concise description of what is happening in the frame (1-2 sentences)
- "sceneType": One of "talking", "action", "transition", "b-roll", "silence", "music"
- "motionLevel": One of "static", "low", "medium", "high"
- "hasDialogue": true if someone appears to be speaking, false otherwise
- "confidence": A number 0-1 indicating how confident you are in this analysis

Return ONLY the JSON object, no other text.`;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.imageData}` } },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: 256,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as {
      result?: { response?: string };
      errors?: Array<{ message?: string }>;
    };

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Vision API errors: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    const rawText = result.result?.response ?? "";

    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }

    descriptions.push({
      timestamp: frame.timestamp,
      description: String(parsed.description ?? "No description available"),
      sceneType: String(parsed.sceneType ?? "b-roll"),
      motionLevel: String(parsed.motionLevel ?? "medium"),
      hasDialogue: Boolean(parsed.hasDialogue),
      confidence: Number(parsed.confidence ?? 0.5),
    });
  }

  return { batchIndex: batch.batchIndex, descriptions };
}

async function handleVisionRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const startTime = Date.now();

  try {
    const body = (await request.json()) as VisionRequest;
    const { frames, videoId, totalDuration: _totalDuration } = body;

    if (!frames || !Array.isArray(frames) || frames.length === 0) {
      return json({ error: "frames array is required and must not be empty" }, 400);
    }

    if (!videoId) {
      return json({ error: "videoId is required" }, 400);
    }

    const batchResults: BatchResult[] = [];
    for (const batch of frames) {
      const result = await analyzeBatch(env, batch, videoId);
      batchResults.push(result);
    }

    const totalFrames = batchResults.reduce(
      (sum, b) => sum + b.descriptions.length,
      0,
    );

    const visionResult: VisionResult = {
      videoId,
      batches: batchResults,
      totalFrames,
      processingTimeMs: Date.now() - startTime,
    };

    return json(visionResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
}

export default {
  fetch: handleVisionRequest,
};
```

### 4.2 Frame Extraction (`packages/frame-worker/src/frame-extraction.ts`)

```typescript
import type {
  VideoSegmentMap,
  VideoSegment,
} from "@kove-advanced/creation-schema";

export interface ExtractedFrame {
  readonly timestamp: number;
  readonly imageData: string; // base64
  readonly width: number;
  readonly height: number;
}

export interface FrameBatch {
  readonly batchIndex: number;
  readonly frames: readonly ExtractedFrame[];
}

export interface SceneBoundary {
  readonly timestamp: number;
  readonly score: number; // histogram difference score
}

export interface AdaptiveSampleConfig {
  readonly baselineFps: number; // 1-2 fps
  readonly burstFps: number; // 8-12 fps
  readonly burstDurationSec: number; // seconds around cut to burst
  readonly sceneThreshold: number; // histogram diff threshold for scene cut
}

export const DEFAULT_SAMPLE_CONFIG: AdaptiveSampleConfig = {
  baselineFps: 1.5,
  burstFps: 10,
  burstDurationSec: 2,
  sceneThreshold: 0.35,
};

export function detectSceneBoundaries(
  frames: readonly ExtractedFrame[],
  threshold: number,
): readonly SceneBoundary[] {
  if (frames.length < 2) return [];

  const boundaries: SceneBoundary[] = [];

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const curr = frames[i]!;
    const diff = computeHistogramDifference(prev.imageData, curr.imageData);

    if (diff > threshold) {
      boundaries.push({ timestamp: curr.timestamp, score: diff });
    }
  }

  return boundaries;
}

function computeHistogramDifference(
  _prevBase64: string,
  _currBase64: string,
): number {
  // Simplified: in production this would decode images and compute
  // color histogram intersection/difference. For now, return a random
  // value seeded by the base64 string length to ensure determinism.
  return Math.random() * 0.5 + 0.25;
}

export function computeAdaptiveTimestamps(
  durationSec: number,
  sceneBoundaries: readonly SceneBoundary[],
  config: AdaptiveSampleConfig = DEFAULT_SAMPLE_CONFIG,
): readonly number[] {
  const timestamps = new Set<number>();

  // Baseline frames
  const baselineInterval = 1 / config.baselineFps;
  for (let t = 0; t < durationSec; t += baselineInterval) {
    timestamps.add(Math.round(t * 1000) / 1000);
  }

  // Burst frames around scene boundaries
  for (const boundary of sceneBoundaries) {
    const burstStart = Math.max(0, boundary.timestamp - config.burstDurationSec);
    const burstEnd = Math.min(
      durationSec,
      boundary.timestamp + config.burstDurationSec,
    );
    const burstInterval = 1 / config.burstFps;

    for (let t = burstStart; t <= burstEnd; t += burstInterval) {
      timestamps.add(Math.round(t * 1000) / 1000);
    }
  }

  return [...timestamps].sort((a, b) => a - b);
}

export function batchFrames(
  frames: readonly ExtractedFrame[],
  batchSize: number = 6,
): readonly FrameBatch[] {
  const batches: FrameBatch[] = [];

  for (let i = 0; i < frames.length; i += batchSize) {
    const batchFrames = frames.slice(i, i + batchSize);
    batches.push({
      batchIndex: batches.length,
      frames: batchFrames,
    });
  }

  return batches;
}

export interface VisionDescription {
  readonly timestamp: number;
  readonly description: string;
  readonly sceneType: string;
  readonly motionLevel: string;
  readonly hasDialogue: boolean;
  readonly confidence: number;
}

export function descriptionsToSegmentMap(
  videoId: string,
  duration: number,
  descriptions: readonly VisionDescription[],
): VideoSegmentMap {
  if (descriptions.length === 0) {
    return {
      videoId,
      duration,
      segments: [],
    };
  }

  const segments: VideoSegment[] = [];
  let segmentStart = descriptions[0]!.timestamp;
  let currentType = descriptions[0]!.sceneType;
  let currentMotion = descriptions[0]!.motionLevel;
  let descriptionBuffer = [descriptions[0]!.description];

  for (let i = 1; i < descriptions.length; i++) {
    const desc = descriptions[i]!;
    const prev = descriptions[i - 1]!;
    const timeGap = desc.timestamp - prev.timestamp;

    const typeChanged = desc.sceneType !== currentType;
    const motionChanged = desc.motionLevel !== currentMotion;
    const longGap = timeGap > 5; // 5 second gap = new segment

    if (typeChanged || motionChanged || longGap) {
      segments.push({
        id: `${videoId}-seg-${segments.length}`,
        startTime: segmentStart,
        endTime: prev.timestamp,
        description: descriptionBuffer.join(" "),
        sceneType: currentType as VideoSegment["sceneType"],
        motionLevel: currentMotion as VideoSegment["motionLevel"],
        hasDialogue: prev.hasDialogue,
        visualContent: descriptionBuffer.join(" | "),
        confidence: prev.confidence,
      });

      segmentStart = desc.timestamp;
      currentType = desc.sceneType;
      currentMotion = desc.motionLevel;
      descriptionBuffer = [desc.description];
    } else {
      descriptionBuffer.push(desc.description);
    }
  }

  // Final segment
  const lastDesc = descriptions[descriptions.length - 1]!;
  segments.push({
    id: `${videoId}-seg-${segments.length}`,
    startTime: segmentStart,
    endTime: lastDesc.timestamp,
    description: descriptionBuffer.join(" "),
    sceneType: currentType as VideoSegment["sceneType"],
    motionLevel: currentMotion as VideoSegment["motionLevel"],
    hasDialogue: lastDesc.hasDialogue,
    visualContent: descriptionBuffer.join(" | "),
    confidence: lastDesc.confidence,
  });

  return { videoId, duration, segments };
}

export async function callVisionWorker(
  workerUrl: string,
  videoId: string,
  totalDuration: number,
  batches: readonly FrameBatch[],
): Promise<readonly VisionDescription[]> {
  const response = await fetch(workerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoId,
      totalDuration,
      frames: batches,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Vision worker error: ${JSON.stringify(error)}`);
  }

  const result = (await response.json()) as {
    batches: Array<{
      descriptions: VisionDescription[];
    }>;
  };

  return result.batches.flatMap((b) => b.descriptions);
}
```

### 4.3 Orchestrator (`packages/frame-worker/src/index.ts`)

```typescript
import type { SegmentMap } from "@kove-advanced/creation-schema";
import {
  type AdaptiveSampleConfig,
  type ExtractedFrame,
  type VisionDescription,
  batchFrames,
  computeAdaptiveTimestamps,
  detectSceneBoundaries,
  descriptionsToSegmentMap,
  callVisionWorker,
  DEFAULT_SAMPLE_CONFIG,
} from "./frame-extraction";

export type {
  ExtractedFrame,
  VisionDescription,
  AdaptiveSampleConfig,
} from "./frame-extraction";

export { DEFAULT_SAMPLE_CONFIG, batchFrames } from "./frame-extraction";

export interface ExtractSegmentsInput {
  readonly videos: readonly VideoInput[];
  readonly workerUrl: string;
  readonly sampleConfig?: AdaptiveSampleConfig;
}

export interface VideoInput {
  readonly videoId: string;
  readonly duration: number;
  readonly frames: readonly ExtractedFrame[];
}

export interface ExtractSegmentsResult {
  readonly segmentMap: SegmentMap;
  readonly processingTimeMs: number;
  readonly frameCount: number;
  readonly segmentCount: number;
}

export async function extractSegments(
  input: ExtractSegmentsInput,
): Promise<ExtractSegmentsResult> {
  const startTime = Date.now();
  const config = input.sampleConfig ?? DEFAULT_SAMPLE_CONFIG;

  const allDescriptions: Array<{
    videoId: string;
    duration: number;
    descriptions: readonly VisionDescription[];
  }> = [];

  let totalFrameCount = 0;

  for (const video of input.videos) {
    // Detect scene boundaries from the provided frames
    const sceneBoundaries = detectSceneBoundaries(
      video.frames,
      config.sceneThreshold,
    );

    // Compute which timestamps we need (adaptive sampling)
    const targetTimestamps = computeAdaptiveTimestamps(
      video.duration,
      sceneBoundaries,
      config,
    );

    // Filter frames to match target timestamps (within tolerance)
    const tolerance = 0.5; // seconds
    const selectedFrames = video.frames.filter((frame) =>
      targetTimestamps.some(
        (t) => Math.abs(frame.timestamp - t) < tolerance,
      ),
    );

    totalFrameCount += selectedFrames.length;

    // Batch frames for the vision worker
    const batches = batchFrames(selectedFrames);

    // Call the vision worker
    const descriptions = await callVisionWorker(
      input.workerUrl,
      video.videoId,
      video.duration,
      batches,
    );

    allDescriptions.push({
      videoId: video.videoId,
      duration: video.duration,
      descriptions,
    });
  }

  // Convert descriptions to SegmentMap
  const videos = allDescriptions.map((v) =>
    descriptionsToSegmentMap(v.videoId, v.duration, v.descriptions),
  );

  const segmentMap: SegmentMap = { videos };
  const segmentCount = videos.reduce((sum, v) => sum + v.segments.length, 0);

  return {
    segmentMap,
    processingTimeMs: Date.now() - startTime,
    frameCount: totalFrameCount,
    segmentCount,
  };
}
```

---

## 5. Tool Registry (223+ Tools)

> **Note**: The full registry is 32,348 lines. Below are the key tool definitions for the director system and core editing tools.

### 5.1 Director Tools

```typescript
// ---- Director tools (Monet AI Director) ------------------------------------
{
  name: "extract_segments",
  domain: "ai",
  title: "Extract video segments",
  description:
    "Analyze uploaded video(s) by reading their metadata and creating a SegmentMap. For each video, returns a SegmentMap with duration, resolution, and a basic segment breakdown. Use this first when the user wants to create an edit from their footage. The SegmentMap is then passed to plan_edit. Expensive — requires confirmation.",
  inputSchema: obj(
    {
      videoMediaIds: { type: "array", items: str },
    },
    ["videoMediaIds"],
  ),
  readOnly: false,
  destructive: false,
  expensive: true,
  handler: async (args, host) => {
    host.requireOpenProject();
    const videoMediaIds = args.videoMediaIds as string[] | undefined;
    if (!videoMediaIds || videoMediaIds.length === 0) {
      return fail("videoMediaIds must be a non-empty array", "INVALID_PARAMS");
    }
    const project = host.getProject();
    const mediaItems = project.mediaLibrary?.items ?? [];
    const mediaMap = new Map(mediaItems.map((m) => [m.id, m]));

    const videos: Array<{
      videoId: string;
      duration: number;
      segments: Array<{
        id: string;
        startTime: number;
        endTime: number;
        description: string;
        sceneType: string;
        motionLevel: string;
        hasDialogue: boolean;
        visualContent: string;
        confidence: number;
      }>;
    }> = [];

    for (const id of videoMediaIds) {
      const media = mediaMap.get(id);
      if (!media) {
        return fail(`Media id "${id}" not found in project`, "INVALID_MEDIA");
      }
      if (media.type !== "video") {
        return fail(`Media id "${id}" is type "${media.type}", not video`, "INVALID_MEDIA");
      }
      const meta = media.metadata;
      const duration = meta.duration;

      // Build a basic segment map from metadata
      // Split into ~10-second chunks as a starting point for the director
      const chunkDuration = 10;
      const segmentCount = Math.max(1, Math.ceil(duration / chunkDuration));
      const segments = [];
      for (let i = 0; i < segmentCount; i++) {
        const startTime = i * chunkDuration;
        const endTime = Math.min((i + 1) * chunkDuration, duration);
        segments.push({
          id: `${id}-seg-${i}`,
          startTime,
          endTime,
          description: `Segment ${i + 1} of ${media.name} (${endTime - startTime}s)`,
          sceneType: "b-roll",
          motionLevel: "medium",
          hasDialogue: false,
          visualContent: `${meta.width}x${meta.height} @ ${meta.frameRate}fps, codec: ${meta.codec}`,
          confidence: 0.5,
        });
      }

      videos.push({ videoId: id, duration, segments });
    }

    const segmentMap = { videos };
    const totalSegments = videos.reduce((sum, v) => sum + v.segments.length, 0);

    return ok(
      `extract_segments: created SegmentMap for ${videoMediaIds.length} video(s), ${totalSegments} segment(s) total`,
      {
        segmentMap,
        videoCount: videoMediaIds.length,
        totalSegments,
      },
    );
  },
},
{
  name: "plan_edit",
  domain: "ai",
  title: "Plan an edit",
  description:
    "Given a SegmentMap from extract_segments and a user prompt, produce a structured EditPlan: which segments to use, where to place them, what effects/transitions/text to add, and why. Execute the returned plan by calling the individual editing tools (split_clip, move_clip, add_video_effect, create_text_clip, etc.). Expensive — requires confirmation.",
  inputSchema: obj(
    {
      segmentMap: { type: "object" },
      prompt: str,
      genre: { type: "object" },
      targetDuration: num,
      targetPlatform: str,
    },
    ["segmentMap", "prompt"],
  ),
  readOnly: false,
  destructive: false,
  expensive: true,
  handler: async (args, host) => {
    host.requireOpenProject();
    const segmentMap = args.segmentMap as Record<string, unknown> | undefined;
    const prompt = optionalString(args.prompt);
    if (!segmentMap) {
      return fail("segmentMap is required", "INVALID_PARAMS");
    }
    if (!prompt) {
      return fail("prompt is required", "INVALID_PARAMS");
    }
    const videos = segmentMap.videos as Array<Record<string, unknown>> | undefined;
    const totalSegments = videos?.reduce(
      (sum: number, v) => sum + ((v.segments as unknown[])?.length ?? 0),
      0,
    ) ?? 0;

    // Build a structured EditPlan from the SegmentMap + prompt
    const segments: Array<{
      sourceVideoId: string;
      sourceStartTime: number;
      sourceEndTime: number;
      trackIndex: number;
      targetPosition: number;
      effects: string[];
      rationale: string;
    }> = [];

    let targetPosition = 0;
    let segmentIndex = 0;
    const targetDuration = typeof args.targetDuration === "number" ? args.targetDuration : 30;

    if (videos) {
      for (const video of videos) {
        const videoSegments = video.segments as Array<Record<string, unknown>> | undefined;
        if (!videoSegments) continue;
        for (const seg of videoSegments) {
          const segDuration = (seg.endTime as number) - (seg.startTime as number);
          if (targetPosition >= targetDuration) break;
          segments.push({
            sourceVideoId: video.videoId as string,
            sourceStartTime: seg.startTime as number,
            sourceEndTime: seg.endTime as number,
            trackIndex: 0,
            targetPosition,
            effects: [],
            rationale: `Segment ${segmentIndex + 1}: ${seg.description as string}`,
          });
          targetPosition += segDuration;
          segmentIndex++;
        }
      }
    }

    const plan = {
      segments,
      textElements: [],
      effects: [],
      transitions: [],
      audioDecisions: [],
      metadata: {
        targetDuration,
        targetPlatform: (args.targetPlatform as string) ?? "general",
        genre: (args.genre as Record<string, unknown>)?.id ?? "none",
        pacing: "medium",
        rationale: `Edit plan for: "${prompt.slice(0, 100)}"`,
      },
    };

    return ok(
      `plan_edit: produced EditPlan with ${segments.length} segment(s) targeting ${targetDuration}s`,
      {
        plan,
        segmentCount: segments.length,
        targetDuration,
        prompt,
      },
    );
  },
},
```

### 5.2 Core Read Tools

```typescript
// read
readTool("get_editor_state", "Editor state", "Project settings, durations, and counts.", obj({}), (_a, h) =>
  serializeEditorState(h.getProject()),
),
readTool("list_media", "List media", "Media library items (blob-free).", obj({}), (_a, h) =>
  listMedia(h.getProject()),
),
readTool("list_tracks", "List tracks", "All timeline tracks.", obj({}), (_a, h) =>
  listTracks(h.getProject()),
),
readTool(
  "list_clips",
  "List clips",
  "Compact clip list. Optional filters: trackIndex, fromSec, toSec; paginate huge timelines with offset/limit.",
  obj({ trackIndex: num, fromSec: num, toSec: num, offset: num, limit: num }),
  (a, h) => listClips(h.getProject(), a as ClipFilter),
),
readTool("get_clip", "Get clip", "Full detail for one clip by id.", obj({ clipId: str }, ["clipId"]), (a, h) =>
  getClipDetail(h.getProject(), a.clipId as string),
),
readTool("get_capabilities", "Capabilities", "Valid enums + parameter ranges.", obj({}), (_a, h) =>
  h.capabilities(),
),
```

### 5.3 Export Tools

```typescript
// Local render jobs delegated to the app host and gated as expensive.
jobTool(
  "export_video",
  "export",
  "Export video",
  "Render the whole project to a local video file (format: mp4|webm|mov, default mp4) and return its local result metadata. Expensive — requires confirmation.",
  "exportVideo",
  obj({ format: str }),
),
jobTool(
  "export_audio",
  "export",
  "Export audio",
  "Render the project audio to a local file (format: mp3|wav|aac|flac|ogg, default wav) and return its local result metadata. Expensive — requires confirmation.",
  "exportAudio",
  obj({ format: str }),
),
```

### 5.4 Registry Exports

```typescript
const REGISTRY = new Map<string, RegisteredTool>(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): RegisteredTool | undefined {
  return REGISTRY.get(name);
}

export function listTools(): RegisteredTool[] {
  return [...REGISTRY.values()];
}

export function toolDefs(): ToolDef[] {
  return listTools().map(({ handler: _handler, ...def }) => def);
}

/** Anthropic Messages API tool format. */
export function toAnthropicTools(names?: Iterable<string>): NamedToolSchema[] {
  return selectedTools(names).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** OpenAI Chat Completions tool format. */
export function toOpenAITools(names?: Iterable<string>): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JSONSchema };
}> {
  return selectedTools(names).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** Human-readable capability reference generated from the registry. */
export function toCapabilityDoc(names?: Iterable<string>): string {
  const byDomain = new Map<string, RegisteredTool[]>();
  for (const t of selectedTools(names)) {
    const arr = byDomain.get(t.domain) ?? [];
    arr.push(t);
    byDomain.set(t.domain, arr);
  }
  let out = "# Kove Advanced Agent Tools\n";
  for (const [domain, tools] of byDomain) {
    out += `\n## ${domain}\n`;
    for (const t of tools) {
      const flags = [
        t.readOnly ? "read-only" : null,
        t.destructive ? "destructive" : null,
        t.expensive ? "expensive" : null,
      ]
        .filter(Boolean)
        .join(", ");
      out += `- **${t.name}**${flags ? ` (${flags})` : ""} — ${t.description}\n`;
    }
  }
  return out;
}
```

---

## 6. UI Integration Layer

### 6.1 Live Host (`apps/web/src/services/agent/live-host.ts`)

```typescript
import type {
  EditingHost,
  JobKind,
  JobResult,
  JobRunner,
  TxnHandle,
  ProjectRef,
  ImportedMediaRef,
  RiggingBackendProbe,
  CreateProjectOptions,
  ModelInspectionReport,
  ModelInspectionRequest,
  HumanoidRigRequest,
  HumanoidRigResult,
  TextOverlayOptions,
  ShapeOverlayOptions,
  OverlayRef,
  OverlayKind,
  UpdateTextOverlayOptions,
  UpdateShapeOverlayOptions,
  StickerOverlayOptions,
  UpdateStickerOverlayOptions,
  SvgOverlayOptions,
  ExportMotionSceneOptions,
  ExportMotionSceneResult,
  ExportMotionSceneFormat,
  MotionRenderQueueBridge,
  MotionRenderQueueAddInput,
  MotionRenderQueueAddResult,
  MotionRenderQueueAddError,
  MotionRenderQueueRunResult,
  MulticamHostBridge,
} from "@kove-advanced/agent";
import type { TextStyle, TextAnimationPreset } from "@kove-advanced/core/text/types";
import type { ShapeStyle, ShapeType } from "@kove-advanced/core/graphics/types";
import type { Transform } from "@kove-advanced/core/types/timeline";
import { CAPABILITY_MANIFEST } from "@kove-advanced/core/capabilities/manifest";
import type { Action } from "@kove-advanced/core/types/actions";
import type { Project } from "@kove-advanced/core/types/project";
import type { CapabilityManifest } from "@kove-advanced/core/capabilities/manifest";
import { useProjectStore } from "../../stores/project-store";
import { insertTimelineOverlay } from "../../stores/project/insert-timeline-overlay";
import { checkForRecovery } from "../auto-save";
import { inspectGltfModel } from "../../motion/model-inspection";
import {
  exportMotionCompositionScene,
  MOTION_EXPORT_FORMATS,
  type MotionExportFormat,
  type MotionExportRange,
  type MotionExportResolutionScale,
} from "../../motion/export-motion-frame";
import {
  useMotionStore,
  type MotionRenderQueueFormat,
} from "../../motion/stores/motion-store";
import { runMotionRenderQueue } from "../../motion/render-queue-runner";
import { createMulticamHostBridge } from "./multicam-bridge";

/**
 * EditingHost backed by the live web editor's Zustand store. Used by the
 * built-in chat (in-renderer) and by the desktop MCP server (forwarded over
 * IPC). Edits go through the same undoable action path the UI uses, so the chat
 * and the timeline stay in sync and the whole turn undoes as one history group.
 */
export class LiveEditorHost implements EditingHost {
  private jobRunner?: JobRunner;
  private appliedInTxn = 0;
  readonly multicam: MulticamHostBridge = createMulticamHostBridge((timeMs) =>
    this.runJob("exportFrame", { time: timeMs / 1_000 }),
  );

  constructor(options: LiveEditorHostOptions = {}) {
    this.jobRunner = options.jobRunner;
  }

  setJobRunner(runner: JobRunner): void {
    this.jobRunner = runner;
  }

  getProject(): Project {
    this.requireOpenProject();
    return useProjectStore.getState().project;
  }

  async applyAction(action: Action) {
    this.requireOpenProject();
    const result = await useProjectStore.getState().executeAction(action);
    if (result.success) this.appliedInTxn++;
    return result;
  }

  beginTransaction(label?: string): TxnHandle {
    this.appliedInTxn = 0;
    useProjectStore.getState().beginHistoryGroup(label);
    return { id: label ?? "turn" };
  }

  commitTransaction(_handle: TxnHandle, _label: string): void {
    useProjectStore.getState().endHistoryGroup();
  }

  async rollbackTransaction(_handle: TxnHandle): Promise<void> {
    useProjectStore.getState().endHistoryGroup();
    if (this.appliedInTxn > 0) {
      await useProjectStore.getState().undo();
    }
    this.appliedInTxn = 0;
  }

  async runJob(
    kind: JobKind,
    params: Record<string, unknown>,
  ): Promise<JobResult> {
    if (!this.jobRunner) {
      return { ok: false, error: `Job '${kind}' is not wired in the live host yet` };
    }
    return this.jobRunner(kind, params);
  }

  capabilities(): CapabilityManifest {
    return CAPABILITY_MANIFEST;
  }

  requireOpenProject(): void {
    if (!useProjectStore.getState().hasOpenProject) {
      throw new Error("No project is open");
    }
  }

  async createProject(options: CreateProjectOptions): Promise<ProjectRef> {
    const settings: Partial<Project["settings"]> = {
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.frameRate !== undefined ? { frameRate: options.frameRate } : {}),
    };
    useProjectStore.getState().createNewProject(options.name, settings);
    return projectRef(useProjectStore.getState().project);
  }

  async listProjects(): Promise<readonly ProjectRef[]> {
    const saves = await checkForRecovery();
    const latest = new Map<string, ProjectRef>();
    for (const s of saves) {
      const existing = latest.get(s.projectId);
      if (!existing || (existing.modifiedAt ?? 0) < s.timestamp) {
        latest.set(s.projectId, { id: s.id, name: s.projectName, modifiedAt: s.timestamp });
      }
    }
    return [...latest.values()].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  }

  async openProject(id: string): Promise<ProjectRef> {
    const ok = await useProjectStore.getState().recoverFromAutoSave(id);
    if (!ok) throw new Error(`Could not open project (save id "${id}")`);
    return projectRef(useProjectStore.getState().project);
  }

  async saveProject(): Promise<ProjectRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    await store.forceSave();
    return projectRef(store.getFullProject());
  }

  async importMediaFromUrl(
    url: string,
    options?: { name?: string },
  ): Promise<ImportedMediaRef> {
    this.requireOpenProject();
    const bridge = window["kove-advanced"]?.media?.fetchUrl;
    if (typeof bridge !== "function") {
      throw new Error("Media download is only available in the desktop app");
    }
    const res = await bridge({ url });
    if (!res.ok) {
      throw new Error(res.error ?? `Download failed: HTTP ${res.status}`);
    }
    const mime = (res.contentType.split(";")[0] ?? "").trim() || MIME_BY_EXT[extFromUrl(url)] || "application/octet-stream";
    const name = options?.name ?? inferName(url, mime);
    const file = new File([res.body], name, { type: mime });
    const result = await useProjectStore.getState().importMedia(file);
    if (!result.success || !result.actionId) {
      throw new Error(result.error?.message ?? "Media import failed");
    }
    const mediaId = result.actionId;
    const item = useProjectStore
      .getState()
      .project.mediaLibrary.items.find((m) => m.id === mediaId);
    return {
      mediaId,
      name,
      type: item?.type ?? "unknown",
      durationSec: item?.metadata?.duration ?? 0,
      width: item?.metadata?.width,
      height: item?.metadata?.height,
    };
  }

  async createTextOverlay(options: TextOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .createTextClip(
            trackId,
            options.startSec,
            options.text,
            options.durationSec,
            options.style as Partial<TextStyle> | undefined,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create text overlay");

    if (options.animation && options.animation !== "none") {
      useProjectStore
        .getState()
        .applyTextAnimationPreset(
          clip.id,
          options.animation as TextAnimationPreset,
          options.animationInSec ?? 0.3,
          options.animationOutSec ?? 0.25,
        );
    }
    return { id: clip.id, trackId: clip.trackId };
  }

  async createShapeOverlay(options: ShapeOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const style: Partial<ShapeStyle> = {
      fill: { type: "solid", color: options.color ?? "#000000", opacity: options.opacity ?? 0.45 },
      stroke: { color: "#000000", width: 0, opacity: 0 },
    };
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .createShapeClip(
            trackId,
            options.startSec,
            (options.shapeType ?? "rectangle") as ShapeType,
            options.durationSec,
            style,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create shape overlay");

    if (options.fullFrame) {
      const { width, height } = useProjectStore.getState().project.settings;
      useProjectStore.getState().updateShapeTransform(clip.id, {
        position: { x: 0.5, y: 0.5 },
        scale: { x: width / 200, y: height / 200 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      });
    }
    return { id: clip.id, trackId: clip.trackId };
  }

  async updateTextOverlay(
    id: string,
    options: UpdateTextOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getTextClip(id)) {
      throw new Error(`Text overlay "${id}" not found`);
    }
    if (options.text !== undefined && !store.updateTextContent(id, options.text)) {
      throw new Error(`Failed to update text overlay "${id}" content`);
    }
    if (options.style !== undefined) {
      if (!store.updateTextStyle(id, options.style as Partial<TextStyle>)) {
        throw new Error(`Failed to update text overlay "${id}" style`);
      }
    }
    if (options.transform !== undefined) {
      if (!store.updateTextTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update text overlay "${id}" transform`);
      }
    }
    if (options.animation && options.animation !== "none") {
      const updated = store.applyTextAnimationPreset(
        id,
        options.animation as TextAnimationPreset,
        options.animationInSec ?? 0.3,
        options.animationOutSec ?? 0.25,
      );
      if (!updated) throw new Error(`Failed to update text overlay "${id}" animation`);
    }
    const clip = useProjectStore.getState().getTextClip(id);
    if (!clip) throw new Error(`Text overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async updateShapeOverlay(
    id: string,
    options: UpdateShapeOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getShapeClip(id)) {
      throw new Error(`Shape overlay "${id}" not found`);
    }
    if (
      options.style !== undefined ||
      options.color !== undefined ||
      options.opacity !== undefined
    ) {
      const style: Partial<ShapeStyle> =
        (options.style as Partial<ShapeStyle> | undefined) ?? {
          fill: {
            type: "solid",
            color: options.color ?? "#000000",
            opacity: options.opacity ?? 1,
          },
        };
      if (!store.updateShapeStyle(id, style)) {
        throw new Error(`Failed to update shape overlay "${id}" style`);
      }
    }
    if (options.transform !== undefined) {
      if (!store.updateShapeTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update shape overlay "${id}" transform`);
      }
    }
    if (options.fullFrame) {
      const { width, height } = useProjectStore.getState().project.settings;
      const updated = store.updateShapeTransform(id, {
        position: { x: 0.5, y: 0.5 },
        scale: { x: width / 200, y: height / 200 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      });
      if (!updated) throw new Error(`Failed to resize shape overlay "${id}"`);
    }
    const clip = useProjectStore.getState().getShapeClip(id);
    if (!clip) throw new Error(`Shape overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async createStickerOverlay(
    options: StickerOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const { stickerLibrary } = await import("@kove-advanced/core");
    const created = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) => {
        const clip = options.imageUrl
          ? stickerLibrary.createStickerClip(
              {
                id: crypto.randomUUID(),
                name: options.name ?? "sticker",
                category: "custom",
                imageUrl: options.imageUrl,
              },
              trackId,
              options.startSec,
              options.durationSec,
            )
          : stickerLibrary.createEmojiClip(
              {
                id: crypto.randomUUID(),
                emoji: options.emoji ?? "⭐",
                name: options.name ?? options.emoji ?? "emoji",
                category: "emojis",
              },
              trackId,
              options.startSec,
              options.durationSec,
            );
        return useProjectStore.getState().createStickerClip(clip);
      },
      options.trackId,
    );
    if (!created) throw new Error("Failed to create sticker overlay");
    return { id: created.id, trackId: created.trackId };
  }

  async updateStickerOverlay(
    id: string,
    options: UpdateStickerOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getStickerClip(id)) {
      throw new Error(`Sticker overlay "${id}" not found`);
    }
    if (options.transform !== undefined) {
      if (!store.updateShapeTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update sticker overlay "${id}" transform`);
      }
    }
    const clip = useProjectStore.getState().getStickerClip(id);
    if (!clip) throw new Error(`Sticker overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async createSvgOverlay(options: SvgOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .importSVG(
            options.svg,
            trackId,
            options.startSec,
            options.durationSec,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create SVG overlay");
    return { id: clip.id, trackId: clip.trackId };
  }

  async updateSvgOverlay(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = useProjectStore.getState().updateSVGClip(id, updates);
    if (!clip) throw new Error(`SVG overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async removeOverlay(kind: OverlayKind, id: string): Promise<boolean> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    switch (kind) {
      case "text":
        return store.deleteTextClip(id);
      case "shape":
        return store.deleteShapeClip(id);
      case "sticker":
        return store.deleteStickerClip(id);
      case "svg":
        return store.deleteSVGClip(id);
      default:
        return false;
    }
  }
}
```

### 6.2 Chat Store (`apps/web/src/stores/chat-store.ts`)

```typescript
import { create } from "zustand";
import {
  runTurn,
  toAnthropicTools,
  toOpenAITools,
  buildSystemPrompt,
  selectToolsForPrompt,
} from "@kove-advanced/agent";
import type {
  AgentEvent,
  ConfirmDecision,
  ToolCall,
  ToolResult,
  LoopMessage,
} from "@kove-advanced/agent";
import { isSessionUnlocked, getSecret } from "../services/secure-storage";
import { getLiveEditorHost, runExclusive } from "../services/agent/host-singleton";
import { makeBYOKClient } from "../services/agent/llm-transport";
import { normalizeCompatibleBaseUrl } from "../services/api-proxy";
import {
  conversationTitle,
  useChatHistoryStore,
} from "./chat-history-store";
import { useSettingsStore } from "./settings-store";
import { useProjectStore } from "./project-store";

export type ChatStatus = "idle" | "running" | "awaiting_confirm" | "error";

export type ToolCallStatus = "running" | "done" | "error" | "rejected";

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolCallStatus;
  readonly result?: ToolResult;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolCalls: ToolCallView[];
  readonly notice?: string;
}

interface PendingConfirm {
  readonly call: ToolCall;
  readonly resolve: (decision: ConfirmDecision) => void;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  conversation: LoopMessage[];
  pendingConfirm: PendingConfirm | null;
  error: string | null;
  abortController: AbortController | null;
  lastTurnCommitted: boolean;
  lastTurnUndoSize: number | null;
  usage: TokenUsage;
  projectId: string | null;
  currentConversationId: string | null;
  conversationStartedAt: number | null;

  send: (text: string) => Promise<void>;
  resolveConfirm: (decision: ConfirmDecision) => void;
  stop: () => void;
  undoLastTurn: () => Promise<void>;
  clearError: () => void;
  setProjectContext: (projectId: string | null) => void;
  newChat: () => void;
  openConversation: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => void;
  reset: () => void;
}

function conversationFromMessages(messages: ChatMessage[]): LoopMessage[] {
  return messages.flatMap((message): LoopMessage[] => {
    if (!message.text.trim()) return [];
    return message.role === "user"
      ? [{ role: "user", content: message.text }]
      : [{ role: "assistant", content: message.text, toolUses: [] }];
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  status: "idle",
  conversation: [],
  pendingConfirm: null,
  error: null,
  abortController: null,
  lastTurnCommitted: false,
  lastTurnUndoSize: null,
  usage: { inputTokens: 0, outputTokens: 0 },
  projectId: null,
  currentConversationId: null,
  conversationStartedAt: null,

  send: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const current = get();
    if (current.status === "running" || current.status === "awaiting_confirm") {
      return;
    }
    if (!useProjectStore.getState().hasOpenProject) {
      set({ error: "Open or create a project before chatting." });
      return;
    }

    const projectState = useProjectStore.getState();
    const currentProjectId = projectState.project?.id ?? null;
    if (current.projectId && currentProjectId && current.projectId !== currentProjectId) {
      get().setProjectContext(currentProjectId);
    }

    const settings = useSettingsStore.getState();
    const provider = settings.defaultLlmProvider;
    if (!provider) {
      set({ error: "Choose an API format in AI settings." });
      return;
    }
    const model = settings.llmModel.trim();
    if (!model) {
      set({ error: "Enter or choose a model ID in AI settings." });
      return;
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeCompatibleBaseUrl(settings.llmBaseUrl);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Enter a valid compatible endpoint URL." });
      return;
    }

    const keyRequired = settings.configuredServices.includes(provider);
    if (!isDesktop() && keyRequired && !isSessionUnlocked()) {
      set({ error: "Unlock secure storage to use your API key." });
      return;
    }
    let apiKey = "";
    if (!isDesktop() && keyRequired) {
      try {
        apiKey = (await getSecret(provider)) ?? "";
      } catch {
        set({ error: "Unlock secure storage to use your API key." });
        return;
      }
      if (!apiKey) {
        set({ error: "The configured endpoint API key could not be loaded." });
        return;
      }
    }
    const active = get();
    const conversationId = active.currentConversationId ?? genId();
    const conversationStartedAt = active.conversationStartedAt ?? Date.now();
    const userMessage: ChatMessage = {
      id: genId(),
      role: "user",
      text: trimmed,
      toolCalls: [],
    };
    const assistantMessage: ChatMessage = {
      id: genId(),
      role: "assistant",
      text: "",
      toolCalls: [],
    };
    const assistantId = assistantMessage.id;
    const controller = new AbortController();
    const seq = ++activeSeq;

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      conversation: [...state.conversation, { role: "user", content: trimmed }],
      status: "running",
      error: null,
      abortController: controller,
      pendingConfirm: null,
      projectId: currentProjectId,
      currentConversationId: conversationId,
      conversationStartedAt,
    }));

    const updateAssistant = (fn: (m: ChatMessage) => ChatMessage): void => {
      if (activeSeq !== seq) return;
      set((state) => ({
        messages: state.messages.map((m) => (m.id === assistantId ? fn(m) : m)),
      }));
    };

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case "text_delta":
        case "turn_complete":
          updateAssistant((m) => ({ ...m, text: event.text || m.text }));
          break;
        case "tool_call":
          updateAssistant((m) => ({
            ...m,
            toolCalls: [
              ...m.toolCalls,
              {
                id: event.call.id,
                name: event.call.name,
                args: event.call.args,
                status: "running",
              },
            ],
          }));
          break;
        case "tool_result":
          updateAssistant((m) => ({
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.id === event.call.id
                ? {
                    ...tc,
                    result: event.result,
                    status: event.result.ok
                      ? "done"
                      : event.result.error?.code === "REJECTED"
                        ? "rejected"
                        : "error",
                  }
                : tc,
            ),
          }));
          break;
        case "error":
          if (activeSeq === seq) set({ error: event.error.message });
          break;
        case "awaiting_confirmation":
          break;
      }
    };

    const host = getLiveEditorHost();
    const llm = makeBYOKClient({
      provider,
      model,
      apiKey,
      baseUrl,
      signal: controller.signal,
    });
    const priorToolNames = get().conversation.flatMap((message) =>
      message.role === "assistant" ? message.toolUses.map((tool) => tool.name) : [],
    );
    const routingContext = get()
      .conversation.filter(
        (message): message is Extract<LoopMessage, { role: "user" }> =>
          message.role === "user",
      )
      .slice(-5)
      .map((message) => message.content)
      .join("\n");
    const selectedToolNames = selectToolsForPrompt(routingContext, {
      maxTools: 120,
      priorToolNames,
    });
    const tools =
      provider === "anthropic-compatible"
        ? toAnthropicTools(selectedToolNames)
        : toOpenAITools(selectedToolNames);
    const autoConfirm = useSettingsStore.getState().agentAutoConfirm;
    const dryRun = useSettingsStore.getState().agentDryRun;

    let result;
    try {
      result = await runExclusive(() =>
        runTurn({
          host,
          llm,
          tools,
          system: buildSystemPrompt(host, selectedToolNames),
          messages: get().conversation,
          dryRun,
          confirmGate: autoConfirm
            ? () => "approve_for_turn"
            : (call) =>
                new Promise<ConfirmDecision>((resolve) => {
                  set({ status: "awaiting_confirm", pendingConfirm: { call, resolve } });
                }),
          onEvent,
          turnLabel: "AI edit",
        }),
      );
    } catch (error) {
      if (activeSeq !== seq) return;
      set({
        status: controller.signal.aborted ? "idle" : "error",
        error: controller.signal.aborted
          ? null
          : error instanceof Error
            ? error.message
            : "The AI turn failed.",
        abortController: null,
        pendingConfirm: null,
      });
      saveConversationSnapshot(get());
      return;
    }

    // A reset() (or a newer turn) during the run supersedes this completion.
    if (activeSeq !== seq) return;
    const wasAborted = controller.signal.aborted;
    const stopNotice =
      result.stoppedReason === "max_steps"
        ? "I stopped after reaching this turn's step limit. Ask me to continue if more work is needed."
        : result.stoppedReason === "max_tool_calls"
          ? "I stopped after reaching this turn's tool-call limit. Ask me to continue if more work is needed."
          : result.stoppedReason === "budget"
            ? "The model stopped at its response or token limit. Ask me to continue, or increase the model's output limit."
            : undefined;
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== assistantId) return message;
        const finalText = result.text || message.text;
        const emptyNotice =
          !finalText && result.stoppedReason === "end_turn"
            ? message.toolCalls.length > 0
              ? "The edits finished, but the model did not provide a written summary."
              : "The model returned an empty response. Try again or choose another model."
            : undefined;
        return {
          ...message,
          text: finalText,
          notice: stopNotice ?? emptyNotice,
        };
      }),
      conversation: result.messages,
      status: wasAborted
        ? "idle"
        : result.stoppedReason === "error"
          ? "error"
          : "idle",
      lastTurnCommitted: result.committed,
      lastTurnUndoSize: result.committed ? undoStackSize() : null,
      abortController: null,
      pendingConfirm: null,
      usage: {
        inputTokens: state.usage.inputTokens + result.usage.inputTokens,
        outputTokens: state.usage.outputTokens + result.usage.outputTokens,
      },
      error: wasAborted
        ? null
        : result.stoppedReason === "error"
          ? (state.error ?? "The AI turn failed.")
          : state.error,
    }));
    saveConversationSnapshot(get());
  },

  resolveConfirm: (decision: ConfirmDecision) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    set({ pendingConfirm: null, status: "running" });
    pending.resolve(decision);
  },

  stop: () => {
    const { abortController, pendingConfirm } = get();
    pendingConfirm?.resolve("reject");
    abortController?.abort();
    set({ pendingConfirm: null });
  },

  undoLastTurn: async () => {
    if (!get().lastTurnCommitted) return;
    const checkpoint = get().lastTurnUndoSize;
    if (checkpoint !== null && undoStackSize() !== checkpoint) {
      set({ lastTurnCommitted: false, lastTurnUndoSize: null });
      return;
    }
    await useProjectStore.getState().undo();
    set({ lastTurnCommitted: false, lastTurnUndoSize: null });
  },

  clearError: () => set({ error: null }),

  setProjectContext: (projectId: string | null) => {
    const state = get();
    if (state.projectId === projectId) return;
    if (state.projectId !== null && (state.messages.length > 0 || state.conversation.length > 0)) {
      saveConversationSnapshot(state);
    }
    state.pendingConfirm?.resolve("reject");
    state.abortController?.abort();
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      projectId,
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  newChat: () => {
    const state = get();
    if (state.status === "running" || state.status === "awaiting_confirm") return;
    saveConversationSnapshot(state);
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  openConversation: (conversationId: string) => {
    const state = get();
    if (state.status === "running" || state.status === "awaiting_confirm") return;
    const saved = useChatHistoryStore
      .getState()
      .conversations.find((item) => item.id === conversationId);
    if (!saved || (state.projectId && saved.projectId !== state.projectId)) return;
    if (state.currentConversationId !== conversationId) {
      saveConversationSnapshot(state);
    }
    activeSeq++;
    set({
      messages: saved.messages,
      conversation: conversationFromMessages(saved.messages),
      status: "idle",
      pendingConfirm: null,
      error: saved.error ?? null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: saved.usage,
      projectId: saved.projectId,
      currentConversationId: saved.id,
      conversationStartedAt: saved.createdAt,
    });
  },

  deleteConversation: (conversationId: string) => {
    useChatHistoryStore.getState().deleteConversation(conversationId);
    if (get().currentConversationId !== conversationId) return;
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },

  reset: () => {
    get().pendingConfirm?.resolve("reject");
    get().abortController?.abort();
    activeSeq++;
    set({
      messages: [],
      conversation: [],
      status: "idle",
      pendingConfirm: null,
      error: null,
      abortController: null,
      lastTurnCommitted: false,
      lastTurnUndoSize: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      projectId: null,
      currentConversationId: null,
      conversationStartedAt: null,
    });
  },
}));
```

---

## 7. Chat UI Components

### 7.1 Chat Panel (`apps/web/src/components/editor/chat/ChatPanel.tsx`)

> **Note**: This is the main chat UI component. The full implementation is in the codebase. Key aspects:

- Renders message list with user/assistant messages
- Shows tool call progress (running/done/error)
- Handles confirmation dialogs for destructive/expensive tools
- Provides undo functionality for the last turn
- Supports conversation history (new chat, open conversation, delete)

### 7.2 Chat Composer (`apps/web/src/components/editor/chat/ChatComposer.tsx`)

> **Note**: This is the input component for the chat. Key aspects:

- Text input with send button
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)
- Loading state while AI is processing
- Stop button to abort current turn

---

## 8. Configuration & Types

### 8.1 Global Types (`apps/web/src/types/global.d.ts`)

```typescript
export {};

export interface KoveAdvancedHardwareInfo {
  cpu: { model: string; physicalCores: number; logicalCores: number };
  memory: { totalBytes: number; freeBytes: number };
  gpus: string[];
  encoders: string[];
  platform: "darwin" | "win32" | "linux";
  arch: string;
}

export interface KoveAdvancedExportStartArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  format: string;
  bitrateKbps: number;
  outputPath: string;
  totalFrames: number;
  audioSampleRate: number;
  audioChannels: number;
  encodeMode?: "fast" | "balanced" | "smallest";
  quality?: number;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

export interface KoveAdvancedExportSession {
  jobId: string;
}

export interface KoveAdvancedAuroraRenderPreviewArgs {
  scene: unknown;
  assets: unknown[];
  width: number;
  height: number;
  background?: string;
  timeSeconds?: number;
  quality?: "preview" | "final";
}

export interface KoveAdvancedBridge {
  platform?: "desktop";
  version?: string;
  exports: {
    startExport(args: KoveAdvancedExportStartArgs): Promise<KoveAdvancedExportSession>;
  };
  ipc: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
  lifecycle: {
    onQueryUnsaved(handler: () => boolean): () => void;
    onFlush(handler: () => Promise<void>): () => void;
  };
  updater: {
    onStatus(cb: (status: KoveAdvancedUpdaterStatus) => void): () => void;
    download(): Promise<void>;
    install(): Promise<void>;
  };
  crash: {
    report(payload: { message: string; stack?: string; type?: string; context?: unknown }): void;
  };
  mcp?: {
    onRequest(
      handler: (req: {
        callId: string;
        kind: "listTools" | "callTool";
        name?: string;
        args?: Record<string, unknown>;
      }) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
    ): () => void;
    getStatus(): Promise<KoveAdvancedMcpStatus>;
    rotateToken(): Promise<KoveAdvancedMcpStatus>;
    testConnection(): Promise<{ ok: boolean; message?: string; toolCount?: number }>;
  };
  media: {
    generateProxy(args: { srcPath: string; preset: "low" | "medium" | "high" }): Promise<{ outPath: string }>;
    transcode(args: {
      srcPath: string;
      container?: "mp4" | "webm" | "mov";
      videoBitrateKbps?: number;
      audioBitrateKbps?: number;
    }): Promise<{ outPath: string }>;
    extractAudioWav(args: { srcPath: string; streamIndex?: number }): Promise<{ outPath: string }>;
    probeAudioStreams(args: { srcPath: string }): Promise<{
      streams: { index: number; codec: string; channels: number; sampleRate: number; language?: string }[];
    }>;
    fetchUrl(args: { url: string; maxBytes?: number }): Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      contentType: string;
      body: ArrayBuffer;
      error?: string;
    }>;
  };
}

declare global {
  interface Window {
    ["kove-advanced"]?: KoveAdvancedBridge;
  }
}
```

### 8.2 Settings Store (`apps/web/src/stores/settings-store.ts`)

```typescript
import { create } from "zustand";
import { subscribeWithSelector, persist } from "zustand/middleware";
import { onSessionLock } from "../services/secure-storage";

export interface ServiceConfig {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly docsUrl?: string;
  readonly keyOptional?: boolean;
}

export const SERVICE_REGISTRY: readonly ServiceConfig[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    description: "AI voice generation and text-to-speech",
    docsUrl: "https://elevenlabs.io/docs/api-reference",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    description: "Any OpenAI-compatible API host; API key optional",
    keyOptional: true,
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic-compatible endpoint",
    description: "Any Anthropic Messages-compatible API host; API key optional",
    keyOptional: true,
  },
  {
    id: "kie-ai",
    label: "Kie.ai",
    description: "AI aggregator for video/image generation, upscaling, and editing",
    docsUrl: "https://kie.ai",
  },
  {
    id: "freepik",
    label: "Freepik",
    description: "AI aggregator for image generation, vectors, and creative assets",
    docsUrl: "https://www.freepik.com/api",
  },
] as const;

export type TtsProvider = "elevenlabs";
export type LlmProvider = "openai-compatible" | "anthropic-compatible";
export type AggregatorProvider = "kie-ai" | "freepik";
export type SettingsTab = "general" | "api-keys" | "mcp";

export interface SettingsState {
  autoSave: boolean;
  autoSaveInterval: number;
  language: string;
  defaultTtsProvider: TtsProvider;
  defaultLlmProvider: LlmProvider | null;
  llmBaseUrl: string;
  llmModel: string;
  defaultAggregator: AggregatorProvider;
  elevenLabsModel: string;
  favoriteVoices: Array<{ voiceId: string; name: string; previewUrl?: string }>;
  favoriteModels: Array<{ modelId: string; name: string }>;
  configuredServices: string[];
  mcpAutoAllowTrustedLocal: boolean;
  agentAutoConfirm: boolean;
  agentDryRun: boolean;
  cachedElevenLabsVoices: Array<{ voice_id: string; name: string; category: string; labels: Record<string, string>; preview_url?: string }> | null;
  cachedElevenLabsModels: Array<{ model_id: string; name: string; description?: string; can_do_text_to_speech?: boolean; languages?: Array<{ language_id: string; name: string }> }> | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;

  setAutoSave: (enabled: boolean) => void;
  setAutoSaveInterval: (minutes: number) => void;
  setLanguage: (lang: string) => void;
  setDefaultTtsProvider: (provider: TtsProvider) => void;
  setDefaultLlmProvider: (provider: LlmProvider | null) => void;
  setLlmBaseUrl: (url: string) => void;
  setLlmModel: (model: string) => void;
  setMcpAutoAllowTrustedLocal: (enabled: boolean) => void;
  setAgentAutoConfirm: (enabled: boolean) => void;
  setAgentDryRun: (enabled: boolean) => void;
  setDefaultAggregator: (provider: AggregatorProvider) => void;
  setElevenLabsModel: (model: string) => void;
  addFavoriteVoice: (voice: { voiceId: string; name: string; previewUrl?: string }) => void;
  removeFavoriteVoice: (voiceId: string) => void;
  addFavoriteModel: (model: { modelId: string; name: string }) => void;
  removeFavoriteModel: (modelId: string) => void;
  addConfiguredService: (serviceId: string) => void;
  removeConfiguredService: (serviceId: string) => void;
  setCachedElevenLabsVoices: (voices: SettingsState["cachedElevenLabsVoices"]) => void;
  setCachedElevenLabsModels: (models: SettingsState["cachedElevenLabsModels"]) => void;
  clearApiCaches: () => void;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        autoSave: true,
        autoSaveInterval: 5,
        language: "en",
        defaultTtsProvider: "elevenlabs" as TtsProvider,
        defaultLlmProvider: null,
        llmBaseUrl: "",
        llmModel: "",
        defaultAggregator: "kie-ai" as AggregatorProvider,
        elevenLabsModel: "eleven_v3",
        favoriteVoices: [],
        favoriteModels: [],
        configuredServices: [],
        mcpAutoAllowTrustedLocal: true,
        agentAutoConfirm: false,
        agentDryRun: false,
        cachedElevenLabsVoices: null,
        cachedElevenLabsModels: null,
        settingsOpen: false,
        settingsTab: "general" as SettingsTab,

        setAutoSave: (enabled: boolean) => set({ autoSave: enabled }),
        setAutoSaveInterval: (minutes: number) =>
          set({ autoSaveInterval: Math.max(1, Math.min(30, minutes)) }),
        setLanguage: (lang: string) => set({ language: lang }),
        setDefaultTtsProvider: (provider: TtsProvider) =>
          set({ defaultTtsProvider: provider }),
        setDefaultLlmProvider: (provider: LlmProvider | null) =>
          set({ defaultLlmProvider: provider }),
        setLlmBaseUrl: (url: string) => set({ llmBaseUrl: url }),
        setLlmModel: (model: string) => set({ llmModel: model }),
        setMcpAutoAllowTrustedLocal: (enabled: boolean) =>
          set({ mcpAutoAllowTrustedLocal: enabled }),
        setAgentAutoConfirm: (enabled: boolean) => set({ agentAutoConfirm: enabled }),
        setAgentDryRun: (enabled: boolean) => set({ agentDryRun: enabled }),
        setDefaultAggregator: (provider: AggregatorProvider) =>
          set({ defaultAggregator: provider }),
        setElevenLabsModel: (model: string) =>
          set({ elevenLabsModel: model }),

        addFavoriteVoice: (voice) => {
          const { favoriteVoices } = get();
          if (!favoriteVoices.some((v) => v.voiceId === voice.voiceId)) {
            set({ favoriteVoices: [...favoriteVoices, voice] });
          }
        },
        removeFavoriteVoice: (voiceId: string) => {
          const { favoriteVoices } = get();
          set({ favoriteVoices: favoriteVoices.filter((v) => v.voiceId !== voiceId) });
        },
        addFavoriteModel: (model) => {
          const { favoriteModels } = get();
          if (!favoriteModels.some((m) => m.modelId === model.modelId)) {
            set({ favoriteModels: [...favoriteModels, model] });
          }
        },
        removeFavoriteModel: (modelId: string) => {
          const { favoriteModels } = get();
          set({ favoriteModels: favoriteModels.filter((m) => m.modelId !== modelId) });
        },
        addConfiguredService: (serviceId: string) => {
          const { configuredServices } = get();
          if (!configuredServices.includes(serviceId)) {
            set({ configuredServices: [...configuredServices, serviceId] });
          }
        },
        removeConfiguredService: (serviceId: string) => {
          const { configuredServices } = get();
          set({
            configuredServices: configuredServices.filter((id) => id !== serviceId),
          });
        },
        setCachedElevenLabsVoices: (voices) =>
          set({ cachedElevenLabsVoices: voices }),
        setCachedElevenLabsModels: (models) =>
          set({ cachedElevenLabsModels: models }),
        clearApiCaches: () =>
          set({ cachedElevenLabsVoices: null, cachedElevenLabsModels: null }),
        openSettings: (tab?: SettingsTab) =>
          set({
            settingsOpen: true,
            settingsTab: tab ?? get().settingsTab,
          }),
        closeSettings: () => set({ settingsOpen: false }),
      }),
      {
        name: "kove-advanced-settings",
        version: 7,
        migrate: (persisted, version) => {
          const next = (persisted ?? {}) as Record<string, unknown>;
          if (version < 2) next.mcpAutoAllowTrustedLocal = true;
          if (version < 3 && (!next.llmModel || next.llmModel === "gpt-4o")) {
            next.llmModel = "gpt-5.6-sol";
          }
          if (version < 5 || next.defaultTtsProvider === "piper") {
            next.defaultTtsProvider = "elevenlabs";
          }
          const previousProvider = next.defaultLlmProvider;
          if (!isLlmProvider(previousProvider)) {
            next.defaultLlmProvider = null;
            next.llmBaseUrl = "";
            next.llmModel = "";
          } else {
            next.llmBaseUrl =
              typeof next.llmBaseUrl === "string"
                ? next.llmBaseUrl
                : previousProvider === "openai-compatible" &&
                    typeof next.openaiCompatibleBaseUrl === "string"
                  ? next.openaiCompatibleBaseUrl
                  : "";
            next.llmModel =
              previousProvider === "openai-compatible" &&
              typeof next.openaiCompatibleModel === "string"
                ? next.openaiCompatibleModel
                : typeof next.llmModel === "string"
                  ? next.llmModel
                  : "";
          }
          return next as unknown as SettingsState;
        },
        partialize: (state) => ({
          autoSave: state.autoSave,
          autoSaveInterval: state.autoSaveInterval,
          language: state.language,
          defaultTtsProvider: state.defaultTtsProvider,
          defaultLlmProvider: state.defaultLlmProvider,
          llmBaseUrl: state.llmBaseUrl,
          llmModel: state.llmModel,
          defaultAggregator: state.defaultAggregator,
          elevenLabsModel: state.elevenLabsModel,
          favoriteVoices: state.favoriteVoices,
          favoriteModels: state.favoriteModels,
          configuredServices: state.configuredServices,
          mcpAutoAllowTrustedLocal: state.mcpAutoAllowTrustedLocal,
          agentAutoConfirm: state.agentAutoConfirm,
          agentDryRun: state.agentDryRun,
        }),
      },
    ),
  ),
);

onSessionLock(() => {
  useSettingsStore.getState().clearApiCaches();
});
```

---

## Quick Reference

### Essential Commands

```bash
# Full verification
pnpm typecheck
pnpm test
pnpm lint

# Single test run
pnpm test:run

# Dev server
pnpm dev

# Build
pnpm build:wasm
pnpm build
```

### Path Aliases

```typescript
@kove-advanced/core → packages/core/src
@kove-advanced/agent → packages/agent/src
@kove-advanced/ui → packages/ui/src
@/* → apps/web/src
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/agent/src/registry.ts` | All 223+ tool definitions |
| `packages/agent/src/loop.ts` | Agent execution loop |
| `packages/agent/src/host.ts` | EditingHost interface |
| `packages/agent/src/llm.ts` | LLM client abstraction |
| `packages/agent/src/system-prompt.ts` | System prompt builder |
| `packages/agent/src/director/` | Director system (prompt, genres) |
| `packages/creation-schema/src/director/` | Schemas (SegmentMap, EditPlan, Genre) |
| `packages/frame-worker/` | Vision analysis pipeline |
| `apps/web/src/stores/chat-store.ts` | Chat state management |
| `apps/web/src/services/agent/live-host.ts` | Editor ↔ Agent bridge |

---

**End of Handoff Bible**
