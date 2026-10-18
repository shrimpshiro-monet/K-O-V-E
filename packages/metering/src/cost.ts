/**
 * Usage normalization + cost estimation.
 *
 * Cost figures are ESTIMATES for ledger bookkeeping only. Per the project
 * rule (no fabricated numbers), a model's pricing contributes a non-zero
 * `costUsd` ONLY when the owner has supplied a verified price list entry;
 * otherwise `costUsd` stays 0 and `costStatus` is "unverified" — the ledger
 * still records exact token counts so real costs can be back-filled later.
 */
import type { TurnUsage } from "./types";

/** Verified price per 1M tokens (USD). Owner-supplied before launch. */
export interface ModelPricing {
  readonly inputPerM: number;
  readonly outputPerM: number;
}

/**
 * Verified price list. EMPTY by design: until the owner adds entries here
 * (or via configurePricing), all cost estimates report "unverified".
 */
let PRICING: ReadonlyMap<string, ModelPricing> = new Map();

export function configurePricing(entries: ReadonlyMap<string, ModelPricing>): void {
  PRICING = new Map(entries);
}

export function getPricing(modelId: string): ModelPricing | undefined {
  return PRICING.get(modelId);
}

export interface CostEstimate {
  readonly usage: TurnUsage;
  readonly costUsd: number;
  /** "listed" when a verified price entry was applied; else "unverified". */
  readonly costStatus: "listed" | "unverified";
}

export function estimateCost(
  modelId: string,
  usage: TurnUsage,
): CostEstimate {
  const price = PRICING.get(modelId);
  if (!price) {
    return { usage, costUsd: 0, costStatus: "unverified" };
  }
  const costUsd =
    (usage.inputTokens * price.inputPerM + usage.outputTokens * price.outputPerM) / 1_000_000;
  // Round to 6 dp — ledger precision, not an illusion of exactness.
  return { usage, costUsd: Math.round(costUsd * 1e6) / 1e6, costStatus: "listed" };
}

/**
 * Normalize the heterogeneous `usage` shapes providers return (OpenAI-style
 * prompt/completion, Anthropic-style input/output) into {@link TurnUsage}.
 * Unknown shapes yield zeros rather than throwing — metering must never take
 * the turn down.
 */
export function parseProviderUsage(raw: unknown): TurnUsage {
  if (!raw || typeof raw !== "object") return { inputTokens: 0, outputTokens: 0 };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input =
    num(r.input_tokens) + num(r.prompt_tokens) + num(r.input);
  const output =
    num(r.output_tokens) + num(r.completion_tokens) + num(r.output);
  return { inputTokens: input, outputTokens: output };
}
