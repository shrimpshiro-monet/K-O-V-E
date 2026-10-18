import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryLedger, Ledger } from "./ledger";
import {
  authenticate,
  authorizeTurn,
  checkQuota,
  resolveModel,
  type VerifiedSession,
} from "./quota";
import { TurnLatencyBudget, buildBudgetConfig } from "./latency-budget";
import { estimateCost, configurePricing, parseProviderUsage } from "./cost";
import {
  DEFAULT_PLAN_LIMITS,
  DEFAULT_FAST_MODEL,
  DEFAULT_FRONTIER_MODEL,
} from "./types";

const session = (tier: "free" | "pro"): VerifiedSession => ({
  userId: "user_1",
  tier,
  expiresAtMs: Infinity,
});

describe("Ledger — idempotent billable recording", () => {
  let store: InMemoryLedger;
  let ledger: Ledger;

  beforeEach(() => {
    store = new InMemoryLedger();
    ledger = new Ledger(store);
  });

  it("first turn is billable", async () => {
    const res = await ledger.recordTurn({
      userId: "u",
      idempotencyKey: "k1",
      tier: "pro",
      model: DEFAULT_FAST_MODEL,
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0,
      costStatus: "unverified" as const,
      latencyMs: 1200,
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    expect(res.billable).toBe(true);
    expect(res.event.replay).toBe(false);
    expect(res.event.billable).toBe(true);
  });

  it("replaying the same idempotencyKey produces ZERO new billable events", async () => {
    const args = {
      userId: "u",
      idempotencyKey: "k1",
      tier: "pro" as const,
      model: DEFAULT_FAST_MODEL,
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0,
      costStatus: "unverified" as const,
      latencyMs: 1200,
      nowIso: "2026-01-01T00:00:00.000Z",
    };
    const first = await ledger.recordTurn(args);
    const replay = await ledger.recordTurn(args);

    expect(first.billable).toBe(true);
    expect(replay.billable).toBe(false);
    expect(replay.event.replay).toBe(true);
    expect(replay.event.billable).toBe(false);
    // Same original event resolved, not a new row.
    expect(replay.event.id).toBe(first.event.id);

    // Quota counter must count exactly ONE billable turn, not two.
    const count = await store.countBillableTurnsSince(
      "u",
      "2025-12-31T00:00:00.000Z",
    );
    expect(count).toBe(1);
  });

  it("replays are scoped per user (same key, different user = new billable)", async () => {
    const a = await ledger.recordTurn({
      userId: "alice",
      idempotencyKey: "k",
      tier: "free",
      model: DEFAULT_FAST_MODEL,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      costStatus: "unverified",
      latencyMs: 1,
    });
    const b = await ledger.recordTurn({
      userId: "bob",
      idempotencyKey: "k",
      tier: "free",
      model: DEFAULT_FAST_MODEL,
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      costStatus: "unverified",
      latencyMs: 1,
    });
    expect(a.billable).toBe(true);
    expect(b.billable).toBe(true);
  });
});

describe("authenticate — 401 gate", () => {
  it("rejects a missing session with UNAUTHENTICATED / 401", () => {
    const res = authenticate(null, 1000);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) {
      expect(res.error.code).toBe("UNAUTHENTICATED");
      expect(res.error.httpStatus).toBe(401);
      expect(res.error.suggestedFix).toBeTruthy();
    }
  });

  it("rejects an expired session with 401", () => {
    const res = authenticate({ userId: "u", tier: "pro", expiresAtMs: 100 }, 101);
    if (res.ok) throw new Error("expected failure");
    expect(res.error.code).toBe("UNAUTHENTICATED");
    expect(res.error.httpStatus).toBe(401);
  });

  it("accepts a live session", () => {
    const res = authenticate(session("pro"), 100);
    expect(res.ok).toBe(true);
  });
});

describe("resolveModel — tier routing + frontier gate", () => {
  it("defaults to the first allowed model", () => {
    const res = resolveModel(DEFAULT_PLAN_LIMITS.free);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.model).toBe(DEFAULT_FAST_MODEL);
  });

  it("free tier cannot request a frontier model", () => {
    const res = resolveModel(DEFAULT_PLAN_LIMITS.free, DEFAULT_FRONTIER_MODEL, (m) =>
      m === DEFAULT_FRONTIER_MODEL,
    );
    // Frontier id isn't in the free allow-list, so it's rejected as not allowed.
    if (res.ok) throw new Error("expected rejection");
    expect(res.error.code).toBe("MODEL_NOT_ALLOWED");
  });

  it("pro tier can request its frontier model", () => {
    const res = resolveModel(DEFAULT_PLAN_LIMITS.pro, DEFAULT_FRONTIER_MODEL, (m) =>
      m === DEFAULT_FRONTIER_MODEL,
    );
    if (!res.ok) throw new Error(res.error.message);
    expect(res.model).toBe(DEFAULT_FRONTIER_MODEL);
  });

  it("pro tier cannot request a model outside its allow-list", () => {
    const res = resolveModel(DEFAULT_PLAN_LIMITS.pro, "totally/unknown-model", () => false);
    if (res.ok) throw new Error("expected rejection");
    expect(res.error.code).toBe("MODEL_NOT_ALLOWED");
  });
});

describe("checkQuota — QUOTA_EXCEEDED", () => {
  it("ok under the cap with remaining count", () => {
    const res = checkQuota(DEFAULT_PLAN_LIMITS.free, 3);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.remaining).toBe(DEFAULT_PLAN_LIMITS.free.maxTurnsPerDay - 3);
  });

  it("exceeds with QUOTA_EXCEEDED / 429 at the cap", () => {
    const res = checkQuota(DEFAULT_PLAN_LIMITS.free, DEFAULT_PLAN_LIMITS.free.maxTurnsPerDay);
    if (res.ok) throw new Error("expected quota failure");
    expect(res.error.code).toBe("QUOTA_EXCEEDED");
    expect(res.error.httpStatus).toBe(429);
    expect(res.error.suggestedFix).toMatch(/upgrade|tomorrow/i);
  });
});

describe("authorizeTurn — full pre-turn gate", () => {
  it("returns a TurnPolicy for a valid pro turn", () => {
    const res = authorizeTurn(session("pro"), undefined, 0);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.policy.model).toBe(DEFAULT_FAST_MODEL);
    expect(res.policy.maxOutputTokens).toBe(DEFAULT_PLAN_LIMITS.pro.maxOutputTokens);
    expect(res.session.userId).toBe("user_1");
  });

  it("surfaces 401 before quota when unauthenticated", () => {
    const res = authorizeTurn(null, undefined, 999);
    if (res.ok) throw new Error("expected auth failure");
    expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("surfaces QUOTA_EXCEEDED for an exhausted free tier", () => {
    const res = authorizeTurn(session("free"), undefined, DEFAULT_PLAN_LIMITS.free.maxTurnsPerDay);
    if (res.ok) throw new Error("expected quota failure");
    expect(res.error.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("TurnLatencyBudget — tiered budgets", () => {
  it("free tier has a tighter budget than pro", () => {
    const free = buildBudgetConfig(DEFAULT_PLAN_LIMITS.free.turnLatencyBudgetMs);
    const pro = buildBudgetConfig(DEFAULT_PLAN_LIMITS.pro.turnLatencyBudgetMs);
    expect(free.totalMs).toBeLessThan(pro.totalMs);
    expect(pro.totalMs).toBe(300_000);
  });

  it("spends within a stage succeed", () => {
    const b = new TurnLatencyBudget(buildBudgetConfig(300_000));
    expect(b.spend("llm", 1000).ok).toBe(true);
    expect(b.totalSpentMs).toBe(1000);
  });

  it("rejects a stage overflow with BUDGET_EXCEEDED", () => {
    const b = new TurnLatencyBudget(buildBudgetConfig(300_000));
    const llmCap = b.stageCap("llm");
    const res = b.spend("llm", llmCap + 1);
    if (res.ok) throw new Error("expected budget failure");
    expect(res.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("rejects total overflow even when the stage fits", () => {
    const b = new TurnLatencyBudget(buildBudgetConfig(300_000));
    // Fill most of the total via apply (largest single stage here is llm).
    const big = b.stageCap("apply");
    expect(b.spend("apply", big).ok).toBe(true);
    // Now push llm to exceed the 300s total.
    const res = b.spend("llm", b.totalBudgetMs);
    if (res.ok) throw new Error("expected total budget failure");
    expect(res.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("canAfford pre-flight guard", () => {
    const b = new TurnLatencyBudget(buildBudgetConfig(60_000));
    const llm = b.stageCap("llm");
    expect(b.canAfford("llm", llm)).toBe(true);
    expect(b.canAfford("llm", llm + 1)).toBe(false);
  });
});

describe("cost estimation — no fabricated numbers", () => {
  beforeEach(() => {
    configurePricing(new Map());
  });

  it("reports unverified (costUsd 0) when no price list is configured", () => {
    const est = estimateCost(DEFAULT_FAST_MODEL, { inputTokens: 1000, outputTokens: 500 });
    expect(est.costUsd).toBe(0);
    expect(est.costStatus).toBe("unverified");
  });

  it("computes cost only from a verified price entry", () => {
    configurePricing(
      new Map([
        [DEFAULT_FAST_MODEL, { inputPerM: 0.05, outputPerM: 0.15 }],
      ]),
    );
    const est = estimateCost(DEFAULT_FAST_MODEL, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(est.costStatus).toBe("listed");
    expect(est.costUsd).toBeCloseTo(0.05 + 0.15, 6);
  });
});

describe("parseProviderUsage — tolerant normalization", () => {
  it("normalizes OpenAI-style usage", () => {
    expect(parseProviderUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it("normalizes Anthropic-style usage", () => {
    expect(parseProviderUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("returns zeros for unknown/absent usage instead of throwing", () => {
    expect(parseProviderUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parseProviderUsage({ weird: true })).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
