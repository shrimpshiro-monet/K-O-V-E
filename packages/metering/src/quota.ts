/**
 * Pre-turn policy checks: authentication, model routing, quotas, and the
 * tiered end-to-end latency budget.
 *
 * All checks return either `{ ok: true, ... }` or `{ ok: false, error }` with
 * the structured {@link MeteringError} — the gateway maps `error.httpStatus`
 * straight onto the HTTP response.
 */
import {
  DEFAULT_PLAN_LIMITS,
  meteringError,
  type MeteringError,
  type PlanLimits,
  type PlanTier,
} from "./types.ts";

/**
 * Verified session produced by the gateway's auth layer (Clerk JWT verify).
 * The metering package never sees a raw token — this keeps JWT/JWKS concerns
 * out of the billing logic and makes both independently testable.
 */
export interface VerifiedSession {
  readonly userId: string;
  /** Tier as reported by entitlements (defaults to "free" when unknown). */
  readonly tier: PlanTier;
  readonly expiresAtMs: number;
}

/** Returns the session or a structured 401. This is the "401 unauth" gate. */
export function authenticate(
  session: VerifiedSession | null | undefined,
  nowMs: number = Date.now(),
): { ok: true; session: VerifiedSession } | { ok: false; error: MeteringError } {
  if (!session || !session.userId) {
    return {
      ok: false,
      error: meteringError(
        "UNAUTHENTICATED",
        "A valid sign-in is required to use the AI director.",
        "Sign in to continue.",
        401,
      ),
    };
  }
  if (session.expiresAtMs !== Infinity && nowMs >= session.expiresAtMs) {
    return {
      ok: false,
      error: meteringError(
        "UNAUTHENTICATED",
        "Your sign-in has expired.",
        "Sign in again to continue.",
        401,
      ),
    };
  }
  return { ok: true, session };
}

/**
 * Model routing for a tier.
 * - No model requested → the tier's default (first allowed model).
 * - Requested model must be in the tier's allow-list; frontier models are
 *   additionally gated by `allowsFrontierModel`.
 */
export function resolveModel(
  limits: PlanLimits,
  requestedModel?: string,
  isFrontierModel?: (modelId: string) => boolean,
): { ok: true; model: string } | { ok: false; error: MeteringError } {
  const model = requestedModel?.trim() || limits.allowedModels[0];
  if (!model) {
    return {
      ok: false,
      error: meteringError(
        "MODEL_NOT_ALLOWED",
        "No model is configured for this plan.",
        "Contact support.",
        400,
      ),
    };
  }
  if (!limits.allowedModels.includes(model)) {
    return {
      ok: false,
      error: meteringError(
        "MODEL_NOT_ALLOWED",
        `Model "${model}" is not available on the ${limits.tier} plan.`,
        limits.tier === "free"
          ? "Upgrade to Pro to use additional models."
          : "Remove the custom model or pick one listed in your plan.",
        403,
      ),
    };
  }
  if (isFrontierModel?.(model) && !limits.allowsFrontierModel) {
    return {
      ok: false,
      error: meteringError(
        "MODEL_NOT_ALLOWED",
        "Frontier models are only available on the Pro plan.",
        "Upgrade to Pro to use frontier models.",
        403,
      ),
    };
  }
  return { ok: true, model };
}

/** Rolling-day quota check (replays never count — see Ledger.recordTurn). */
export function checkQuota(
  limits: PlanLimits,
  billableTurnsToday: number,
): { ok: true; remaining: number } | { ok: false; error: MeteringError } {
  const remaining = limits.maxTurnsPerDay - billableTurnsToday;
  if (remaining <= 0) {
    return {
      ok: false,
      error: meteringError(
        "QUOTA_EXCEEDED",
        `The ${limits.tier} plan includes ${limits.maxTurnsPerDay} AI turns per day.`,
        limits.tier === "free"
          ? "Upgrade to Pro for more daily turns, or try again tomorrow."
          : "Contact support to raise your daily limit.",
        429,
      ),
    };
  }
  return { ok: true, remaining };
}

export interface TurnPolicy {
  readonly limits: PlanLimits;
  readonly model: string;
  /** Cap applied to this turn's output (min of plan cap and caller cap). */
  readonly maxOutputTokens: number;
}

/**
 * Full pre-turn gate: auth → model routing → quota. Returns a ready-to-use
 * {@link TurnPolicy} or the FIRST failing structured error (checked in that
 * order, matching how the gateway should surface problems).
 */
export function authorizeTurn(
  session: VerifiedSession | null | undefined,
  requestedModel: string | undefined,
  billableTurnsToday: number,
  opts: {
    readonly nowMs?: number;
    readonly limitsByTier?: Record<PlanTier, PlanLimits>;
    readonly isFrontierModel?: (modelId: string) => boolean;
  } = {},
):
  | { ok: true; policy: TurnPolicy; session: VerifiedSession }
  | { ok: false; error: MeteringError } {
  const auth = authenticate(session, opts.nowMs);
  if (!auth.ok) return auth;

  const tables = opts.limitsByTier ?? DEFAULT_PLAN_LIMITS;
  const limits = tables[auth.session.tier] ?? tables.free;

  const model = resolveModel(limits, requestedModel, opts.isFrontierModel);
  if (!model.ok) return model;

  const quota = checkQuota(limits, billableTurnsToday);
  if (!quota.ok) return quota;

  return {
    ok: true,
    session: auth.session,
    policy: {
      limits,
      model: model.model,
      maxOutputTokens: limits.maxOutputTokens,
    },
  };
}
