/**
 * Core metering/billing domain types.
 *
 * These are provider- and vendor-agnostic so the gateway (Cloudflare Pages
 * Function), the eval harness, and tests can all share one definition. No live
 * network or vendor SDK is imported here — everything is pure logic plus an
 * injectable store, so the whole package is mock-testable in CI.
 */

/** Subscription tiers. Pricing is handled by the merchant-of-record (owner
 * chose MoR such as Lemon Squeezy/Paddle); the tier only gates quotas/models. */
export type PlanTier = "free" | "pro";

/**
 * Per-tier policy limits.
 *
 * NOTE: the numeric defaults below are PLACEHOLDERS chosen to be conservative
 * and clearly separable by tier. They are not measured values and are not the
 * owner's final pricing — the owner must confirm them (or supply production
 * values via `configurePlans`) before launch. Do not treat them as facts.
 */
export interface PlanLimits {
  readonly tier: PlanTier;
  /** Max billable LLM turns per rolling day. */
  readonly maxTurnsPerDay: number;
  /** Max input tokens per turn (guards against runaway prompts). */
  readonly maxInputTokensPerTurn: number;
  /** Max output tokens requested from the model per turn. */
  readonly maxOutputTokens: number;
  /** End-to-end latency budget for a single plan_edit turn, in ms. */
  readonly turnLatencyBudgetMs: number;
  /** Model ids this tier may route to (first = default). */
  readonly allowedModels: readonly string[];
  /** Whether the tier may use a frontier (non-Workers-AI) model. */
  readonly allowsFrontierModel: boolean;
}

/** Default fast model: Cloudflare Workers AI (low latency, cheap, in-stack). */
export const DEFAULT_FAST_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/**
 * Default frontier slot. Kept as a reserved id so Pro routing + evals have a
 * concrete target; swap for the owner's chosen frontier model / GCP Vertex
 * endpoint when configured. Not a Workers-AI model by design.
 */
export const DEFAULT_FRONTIER_MODEL = "frontier/reserved";

export const DEFAULT_PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  // PLACEHOLDER values — pending owner pricing decision (see header). Free is
  // deliberately a tight smoke-test tier; Pro is a working tier.
  free: {
    tier: "free",
    maxTurnsPerDay: 10,
    maxInputTokensPerTurn: 16_000,
    maxOutputTokens: 2_048,
    turnLatencyBudgetMs: 60_000,
    allowedModels: [DEFAULT_FAST_MODEL],
    allowsFrontierModel: false,
  },
  pro: {
    tier: "pro",
    maxTurnsPerDay: 200,
    maxInputTokensPerTurn: 128_000,
    maxOutputTokens: 8_192,
    turnLatencyBudgetMs: 300_000,
    allowedModels: [DEFAULT_FAST_MODEL, DEFAULT_FRONTIER_MODEL],
    allowsFrontierModel: true,
  },
};

/**
 * Structured error shape required across the product. Every metering failure
 * (unauthenticated, quota exceeded, model not allowed, ...) uses this so the
 * client can render a consistent, actionable message.
 */
export interface MeteringError {
  readonly code:
    | "UNAUTHENTICATED"
    | "QUOTA_EXCEEDED"
    | "MODEL_NOT_ALLOWED"
    | "BUDGET_EXCEEDED"
    | "FRONTIER_NOT_CONFIGURED"
    | "GATEWAY_NOT_CONFIGURED"
    | "INTERNAL";
  readonly message: string;
  readonly suggestedFix: string;
  readonly httpStatus: number;
}

export function meteringError(
  code: MeteringError["code"],
  message: string,
  suggestedFix: string,
  httpStatus: number,
): MeteringError {
  return { code, message, suggestedFix, httpStatus };
}

/** Usage reported by an LLM provider for a single turn. */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * A single billable (or replayed) event in the ledger.
 *
 * `replay: true` rows are recorded for audit but carry `billable: false` —
 * this is what makes "replay = zero billable events" hold: a repeated
 * idempotencyKey resolves to the ORIGINAL event and adds no new billable row.
 */
export interface LedgerEvent {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly tier: PlanTier;
  readonly model: string;
  readonly usage: TurnUsage;
  /** Estimated cost in USD (0 + "unverified" until a verified price list is
   * configured — no fabricated numbers). */
  readonly costUsd: number;
  readonly costStatus: "unverified" | "listed";
  readonly latencyMs: number;
  readonly billable: boolean;
  readonly replay: boolean;
  readonly createdAt: string; // ISO-8601
}

/**
 * Storage seam for the ledger. The production implementation talks to
 * Supabase (owner choice); tests use {@link InMemoryLedger}. Keeping this an
 * interface is what makes the gateway mock-testable without a live vendor.
 */
export interface LedgerStore {
  /** Returns the event for this key, if a billable original already exists. */
  findOriginal(
    userId: string,
    idempotencyKey: string,
  ): Promise<LedgerEvent | undefined>;
  /** Insert a NEW billable event. Must be idempotent-safe at the store layer. */
  insertBillable(event: LedgerEvent): Promise<LedgerEvent>;
  /** Rolling-day billable turn count for quota checks (excludes replays). */
  countBillableTurnsSince(
    userId: string,
    sinceIso: string,
  ): Promise<number>;
}
