/**
 * The gateway orchestrator: ties auth (Clerk), entitlements (Supabase),
 * policy (metering) and the provider call together.
 *
 * The HTTP layer (Cloudflare Pages Function) only:
 *   1. calls `gateway.authorize(request)` → TurnPolicy or structured error
 *   2. hands the approved provider call to `gateway.complete(...)`
 *   3. returns the provider response (or the structured error)
 *
 * Keeping the provider call inside `complete` makes the WHOLE flow — including
 * "replay = zero billable events" and the latency budget — unit-testable with
 * a mocked provider fetch + mocked JWKS + mocked entitlements.
 */
import {
  DEFAULT_PLAN_LIMITS,
  Ledger,
  TurnLatencyBudget,
  authorizeTurn,
  buildBudgetConfig,
  estimateCost,
  meteringError,
  parseProviderUsage,
  type MeteringError,
  type PlanTier,
} from "@kove-advanced/metering";
import { verifyClerkJwt, type VerifyJwtOptions } from "./clerk.ts";
import type { EntitlementStore } from "./supabase.ts";

export interface GatewayConfig {
  readonly clerk: Omit<VerifyJwtOptions, "fetchImpl"> & { fetchImpl?: typeof fetch };
  readonly entitlements: EntitlementStore;
  readonly ledger: Ledger;
  readonly isFrontierModel?: (modelId: string) => boolean;
  readonly nowMs?: number;
}

export interface AuthorizedTurn {
  readonly session: { userId: string };
  readonly tier: PlanTier;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly idempotencyKey: string;
  readonly budget: TurnLatencyBudget;
}

export type AuthorizeResult =
  | { ok: true; turn: AuthorizedTurn }
  | { ok: false; error: MeteringError };

const IDEMPOTENCY_HEADER = "idempotency-key";

export class Gateway {
  private readonly cfg: GatewayConfig;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
  }

  /**
   * Authenticate + resolve tier + run the pre-turn policy gates.
   *
   * The Idempotency-Key header (sent by the plan_edit client) drives
   * metering dedup. When absent we mint a single-use key so the call is still
   * recorded, but it can never be replayed (no dedup benefit).
   */
  async authorize(
    request: Request,
    opts: { readonly requestedModel?: string } = {},
  ): Promise<AuthorizeResult> {
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) {
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

    const verified = await verifyClerkJwt(token, this.cfg.clerk);
    if (!verified.ok) return verified;

    const now = this.cfg.nowMs ?? Date.now();

    // Entitlement store outage: fail CLOSED to the free tier (never grant Pro
    // without a confirmed entitlement).
    let tier: PlanTier = "free";
    try {
      tier = await this.cfg.entitlements.getTier(verified.session.userId);
    } catch {
      tier = "free";
    }

    const session = {
      userId: verified.session.userId,
      tier,
      expiresAtMs:
        typeof verified.session.raw.exp === "number"
          ? verified.session.raw.exp * 1000
          : Infinity,
    };

    // Rolling-day billable count. A read failure fails OPEN (availability
    // beats a strict quota) — the ledger insert still enforces replay safety.
    let turnsToday = 0;
    try {
      turnsToday = await this.cfg.ledger.billableTurnsSince(
        verified.session.userId,
        new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      );
    } catch {
      turnsToday = 0;
    }

    const authorized = authorizeTurn(session, opts.requestedModel, turnsToday, {
      nowMs: now,
      limitsByTier: DEFAULT_PLAN_LIMITS,
      isFrontierModel: this.cfg.isFrontierModel,
    });
    if (!authorized.ok) return authorized;

    const idempotencyKey =
      (request.headers.get(IDEMPOTENCY_HEADER) ?? "").trim() ||
      `oneuse_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    return {
      ok: true,
      turn: {
        session: { userId: verified.session.userId },
        tier: authorized.session.tier,
        model: authorized.policy.model,
        maxOutputTokens: authorized.policy.maxOutputTokens,
        idempotencyKey,
        budget: new TurnLatencyBudget(
          buildBudgetConfig(authorized.policy.limits.turnLatencyBudgetMs),
        ),
      },
    };
  }

  /**
   * Wrap the provider call: enforce the LLM-stage latency budget, time the
   * call, normalize usage, estimate cost, and record the billable event
   * idempotently (replay => zero new billable rows).
   */
  async complete(
    turn: AuthorizedTurn,
    providerRequest: () => Promise<Response>,
  ): Promise<
    | { ok: true; response: Response; billed: boolean; replayed: boolean }
    | { ok: false; error: MeteringError }
  > {
    const started = Date.now();
    let response: Response;
    try {
      response = await providerRequest();
    } catch {
      // A failed upstream call is NOT billable — nothing was produced.
      return {
        ok: false,
        error: meteringError(
          "INTERNAL",
          "The model request failed. Please try again.",
          "Retry the request; if it persists, contact support.",
          502,
        ),
      };
    }
    const latencyMs = Date.now() - started;

    const spent = turn.budget.spend("llm", latencyMs);
    if (!spent.ok) return spent;

    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const body = (await response.clone().json()) as { usage?: unknown };
      usage = parseProviderUsage(body.usage);
    } catch {
      // Non-JSON body or no usage block — record zeros; the turn still
      // happened (a response came back) but token counts are unknown.
    }

    if (!response.ok) {
      // Provider error passthrough; not billable (no successful turn).
      return { ok: true, response, billed: false, replayed: false };
    }

    const cost = estimateCost(turn.model, usage);
    const recorded = await this.cfg.ledger.recordTurn({
      userId: turn.session.userId,
      idempotencyKey: turn.idempotencyKey,
      tier: turn.tier,
      model: turn.model,
      usage,
      costUsd: cost.costUsd,
      costStatus: cost.costStatus,
      latencyMs,
    });

    return { ok: true, response, billed: recorded.billable, replayed: !recorded.billable };
  }
}
