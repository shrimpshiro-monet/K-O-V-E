import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { HeadlessHost } from "../headless-host";
import { runTurn } from "../loop";
import {
  AnthropicClient,
  OpenAIClient,
  withRetry,
  type LLMClient,
  type LLMSend,
  type LoopMessage,
} from "../llm";
import { toAnthropicTools, toOpenAITools } from "../registry";
import { makeProjectWithClip } from "../test-fixtures";

/**
 * LIVE EVAL (requires real LLM credentials; auto-skips without them).
 *
 * Verifies the director-prompt unit fix behaviorally: after the prompt was
 * corrected (contrast/saturation documented as 0..2 CSS multipliers,
 * brightness/temperature/tint as −100..100 percent), the model must actually
 * EMIT values in those windows. The compile-time suite can't prove that.
 *
 * Configure one of:
 *   ANTHROPIC_API_KEY [+ ANTHROPIC_BASE_URL, ANTHROPIC_MODEL]
 *   OPENAI_API_KEY    [+ OPENAI_BASE_URL, OPENAI_MODEL]
 * Run: pnpm exec vitest run src/director/director-units-live.eval.test.ts
 */

interface LiveEnv {
  client: LLMClient;
  provider: "anthropic" | "openai";
}

function fetchSend(url: string, headers: Record<string, string>): LLMSend {
  return async (body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };
}

function clientFromEnv(): LiveEnv | null {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const base = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1/messages";
    return {
      provider: "anthropic",
      client: new AnthropicClient({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
        send: withRetry(
          fetchSend(base, {
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          }),
        ),
      }),
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
    return {
      provider: "openai",
      client: new OpenAIClient({
        model: process.env.OPENAI_MODEL ?? "gpt-4o",
        send: withRetry(fetchSend(base, { authorization: `Bearer ${openaiKey}` })),
      }),
    };
  }
  return null;
}

const PROMPTS = [
  "Give this footage a high-contrast black & white look — punchy, crushed blacks.",
  "Make the colors vivid and saturated for a hype reel, and bump the contrast a little.",
  "Grade this dark and moody: drop the brightness, add contrast, keep it desaturated.",
];

function collectedEffects(project: Project): Array<{ type: string; params: Record<string, unknown> }> {
  return project.timeline.tracks.flatMap((track) =>
    track.clips.flatMap((clip) => (clip.effects ?? []).map((e) => ({ type: e.type, params: e.params as Record<string, unknown> }))),
  );
}

const live = clientFromEnv();

describe.skipIf(!live)("director emits grade params in renderer units (live LLM)", () => {
  it.each(PROMPTS.map((p, i) => [i, p] as const))(
    "prompt %# emits contrast/saturation in 0..2 and brightness in ±100",
    async (_i, prompt) => {
      const env = live as LiveEnv;
      const host = new HeadlessHost(makeProjectWithClip());
      const tools = env.provider === "anthropic" ? toAnthropicTools() : toOpenAITools();
      const messages: LoopMessage[] = [{ role: "user", content: prompt }];

      const result = await runTurn({
        host,
        llm: env.client,
        tools,
        messages,
        limits: { maxSteps: 10 },
        confirmGate: () => "approve",
      });
      expect(
        result.stoppedReason,
        `turn stopped with: ${result.stoppedReason}`,
      ).not.toBe("error");

      const effects = collectedEffects(host.getProject());
      const graded = effects.filter((e) =>
        ["contrast", "saturation", "brightness", "temperature", "tint"].includes(e.type),
      );
      // The director must have actually graded something, or the test proves nothing.
      expect(graded.length, `no grade effects emitted for: ${prompt}`).toBeGreaterThan(0);

      for (const effect of graded) {
        const value = effect.params.value;
        if (typeof value !== "number") continue;
        if (effect.type === "contrast" || effect.type === "saturation") {
          expect(value, `${effect.type} must be a CSS multiplier (0..2), got ${value}`).toBeGreaterThanOrEqual(0);
          expect(value, `${effect.type} must be a CSS multiplier (0..2), got ${value}`).toBeLessThanOrEqual(2);
        } else {
          expect(value, `${effect.type} must be percent −100..100, got ${value}`).toBeGreaterThanOrEqual(-100);
          expect(value, `${effect.type} must be percent −100..100, got ${value}`).toBeLessThanOrEqual(100);
        }
      }
    },
    180_000,
  );
});
