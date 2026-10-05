import { describe, expect, it } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import { HeadlessHost } from "../headless-host";
import { runTurn } from "../loop";
import type { LoopMessage } from "../llm";
import type { AgentEvent } from "../types";
import { toOpenAITools } from "../registry";
import { makeWorkersAIClient, loadWorkersAIConfig } from "../eval/baseline";
import { makeProjectWithClip } from "../test-fixtures";

/**
 * LIVE EVAL (requires Cloudflare Workers AI credentials; auto-skips without).
 *
 * Verifies the director-prompt unit fix behaviorally: after the prompt was
 * corrected (contrast/saturation documented as 0..2 CSS multipliers,
 * brightness/temperature/tint as −100..100 percent), the model must actually
 * EMIT values in those windows. The compile-time suite can't prove that.
 *
 * Credentials resolve exactly like the baseline harness (eval/baseline.ts):
 *   KOVE_EVAL_CLOUDFLARE_API_TOKEN / KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID
 *     (eval-scoped second key — does not disturb the web app's credentials)
 *   → CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID env
 *   → the repo's .dev.vars
 * Optional KOVE_EVAL_CLOUDFLARE_AI_MODEL / CLOUDFLARE_AI_MODEL overrides the
 * default Workers AI model. Token and account id must match (else 403).
 *
 * Run: pnpm --filter @kove-advanced/agent exec vitest run src/director/director-units-live.eval.test.ts
 */

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

const config = loadWorkersAIConfig();

/**
 * Workers AI's free tier resets daily (10k neurons). Hitting it is an
 * environment limit, not a regression in the prompt fix under test — skip
 * rather than report a red suite. 403/401 (bad creds) still fail loudly.
 */
function quotaExhausted(message: string): boolean {
  return (
    message.includes("429") ||
    message.includes("daily free allocation") ||
    message.includes("neurons") ||
    message.includes("rate limit")
  );
}

describe.skipIf(!config)("director emits grade params in renderer units (live Workers AI)", () => {
  // Plain `it` (not `it.each`) so the test context — and ctx.skip() for the
  // quota case — is available; vitest 1.6 doesn't pass context to each-callbacks.
  PROMPTS.forEach((prompt, index) => {
    it(`prompt ${index} emits contrast/saturation in 0..2 and brightness in ±100`, async (ctx) => {
      const cfg = config as NonNullable<typeof config>;
      const host = new HeadlessHost(makeProjectWithClip());
      const client = makeWorkersAIClient(cfg);
      const tools = toOpenAITools();
      const messages: LoopMessage[] = [{ role: "user", content: prompt }];
      const errors: string[] = [];

      const result = await runTurn({
        host,
        llm: client,
        tools,
        messages,
        limits: { maxSteps: 10 },
        confirmGate: () => "approve",
        onEvent: (event: AgentEvent) => {
          if (event.type === "error") errors.push(event.error.message);
        },
      });
      if (result.stoppedReason === "error") {
        const message = errors.join("\n");
        if (quotaExhausted(message)) {
          ctx.skip();
          return;
        }
        expect(
          result.stoppedReason,
          `turn stopped with: ${result.stoppedReason}: ${message}`,
        ).not.toBe("error");
      }

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
    }, 180_000);
  });
});
