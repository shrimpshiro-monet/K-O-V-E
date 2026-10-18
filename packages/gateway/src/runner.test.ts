import { describe, expect, it, beforeEach } from "vitest";
import {
  InMemoryLedger,
  Ledger,
  DEFAULT_FAST_MODEL,
  DEFAULT_FRONTIER_MODEL,
  DEFAULT_PLAN_LIMITS,
} from "@kove-advanced/metering";
import { Gateway } from "./runner";
import { EntitlementStore } from "./supabase";
import type { Jwk } from "./clerk";

/**
 * End-to-end gateway tests with every vendor mocked:
 *  - Clerk: locally generated ES256 key + in-memory JWKS fetch
 *  - Supabase: mocked PostgREST fetch (entitlements)
 *  - Ledger: in-memory
 *  - Provider: scripted fetch
 *
 * Acceptance under test: 401 unauth, QUOTA_EXCEEDED, and
 * "replay = zero billable events".
 */

const ISSUER = "https://test.clerk.accounts.dev";
const JWK_URL = "https://clerk.com/.well-known/jwks.json";
const SUPABASE = "https://test.supabase.co";
const SKEY = "service-role-test";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let jwk: Jwk;
let privateKey: CryptoKey;

async function makeToken(
  claims: Record<string, unknown>,
  key: CryptoKey = privateKey,
): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const header = { alg: "ES256", kid: "k1", typ: "JWT" };
  const data = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(data).buffer as ArrayBuffer,
  );
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

const jwksFetch = (async (_u: string | URL | Request, _i?: RequestInit) =>
  Response.json({ keys: [jwk] })) as unknown as typeof fetch;

/** Mocked Supabase: tier per user, 404 when absent. */
function supabaseFetch(tiers: Record<string, "free" | "pro">): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const match = url.match(/user_entitlements\?user_id=eq\.([^&]+)/);
    const user = match ? decodeURIComponent(match[1]) : "";
    if (!tiers[user]) return new Response("[]", { status: 404 });
    return Response.json([{ tier: tiers[user] }]);
  }) as unknown as typeof fetch;
}

class ScriptedLedger extends Ledger {
  constructor(store: InMemoryLedger, private readonly scriptedCount: number) {
    super(store);
  }
  override async billableTurnsSince(): Promise<number> {
    return this.scriptedCount;
  }
}

interface Harness {
  gateway: Gateway;
  store: InMemoryLedger;
  quotaUser: { calls: number };
}

async function makeHarness(overrides?: {
  quotaUserCalls?: number;
  tiers?: Record<string, "free" | "pro">;
  entitlements?: EntitlementStore;
}): Promise<Harness> {
  const store = new InMemoryLedger();
  const ledger = new ScriptedLedger(store, overrides?.quotaUserCalls ?? 0);
  const entitlements =
    overrides?.entitlements ??
    new EntitlementStore({
      url: SUPABASE,
      serviceRoleKey: SKEY,
      fetchImpl: supabaseFetch(overrides?.tiers ?? {}),
    });
  const gateway = new Gateway({
    clerk: { issuer: ISSUER, jwksUrl: JWK_URL, fetchImpl: jwksFetch, nowMs: 1_700_000_000_000 },
    entitlements,
    ledger,
    isFrontierModel: (m) => m === DEFAULT_FRONTIER_MODEL,
    nowMs: 1_700_000_000_000,
  });
  return { gateway, store, quotaUser: { calls: overrides?.quotaUserCalls ?? 0 } };
}

function providerFetch(payload: unknown, status = 200): () => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

const llmPayload = (usage: Record<string, number> = {
  prompt_tokens: 100,
  completion_tokens: 50,
}) => ({
  choices: [{ message: { content: "plan" }, finish_reason: "stop" }],
  usage,
});

describe("Gateway.authorize", () => {
  let gw: Gateway;

  beforeEach(async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    jwk = {
      ...((await subtle.exportKey("jwk", pair.publicKey)) as object),
      kid: "k1",
      alg: "ES256",
    } as Jwk;
    const h = await makeHarness();
    gw = h.gateway;
  });

  it("401 when no Authorization header is present", async () => {
    const res = await gw.authorize(new Request("https://app/api/llm/v1/chat/completions", { method: "POST" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNAUTHENTICATED");
      expect(res.error.httpStatus).toBe(401);
    }
  });

  it("401 for an invalid token (bad signature)", async () => {
    const token = await makeToken({ iss: ISSUER, sub: "user_1", exp: 1_700_003_600 });
    const tampered = token.slice(0, -4) + "AAAA";
    const res = await gw.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${tampered}` } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.httpStatus).toBe(401);
  });

  it("authorizes a free user to the fast model with the free budget", async () => {
    const token = await makeToken({ iss: ISSUER, sub: "user_free", exp: 1_700_003_600 });
    const res = await gw.authorize(
      new Request("https://app/api/llm", {
        headers: { authorization: `Bearer ${token}`, "idempotency-key": "ik-1" },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.turn.tier).toBe("free");
      expect(res.turn.model).toBe(DEFAULT_FAST_MODEL);
      expect(res.turn.idempotencyKey).toBe("ik-1");
      expect(res.turn.budget.totalBudgetMs).toBe(DEFAULT_PLAN_LIMITS.free.turnLatencyBudgetMs);
    }
  });

  it("routes a pro user and keeps the pro 300s budget", async () => {
    const h = await makeHarness({ tiers: { user_pro: "pro" } });
    const token = await makeToken({ iss: ISSUER, sub: "user_pro", exp: 1_700_003_600 });
    const res = await h.gateway.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.turn.tier).toBe("pro");
      expect(res.turn.budget.totalBudgetMs).toBe(300_000);
    }
  });

  it("free tier cannot request the frontier model (403)", async () => {
    const token = await makeToken({ iss: ISSUER, sub: "user_free", exp: 1_700_003_600 });
    const res = await gw.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${token}` } }),
      { requestedModel: DEFAULT_FRONTIER_MODEL },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("MODEL_NOT_ALLOWED");
  });

  it("pro tier CAN request the frontier model", async () => {
    const h = await makeHarness({ tiers: { user_pro: "pro" } });
    const token = await makeToken({ iss: ISSUER, sub: "user_pro", exp: 1_700_003_600 });
    const res = await h.gateway.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${token}` } }),
      { requestedModel: DEFAULT_FRONTIER_MODEL },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.turn.model).toBe(DEFAULT_FRONTIER_MODEL);
  });

  it("QUOTA_EXCEEDED when the rolling-day billable count is at the cap", async () => {
    const h = await makeHarness({ quotaUserCalls: DEFAULT_PLAN_LIMITS.free.maxTurnsPerDay });
    const token = await makeToken({ iss: ISSUER, sub: "user_free", exp: 1_700_003_600 });
    const res = await h.gateway.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("QUOTA_EXCEEDED");
      expect(res.error.httpStatus).toBe(429);
      expect(res.error.suggestedFix).toBeTruthy();
    }
  });

  it("fails CLOSED to free when the entitlement store errors", async () => {
    const h = await makeHarness({
      entitlements: {
        getTier: async () => {
          throw new Error("supabase down");
        },
        setEntitlement: async () => {},
      } as unknown as EntitlementStore,
    });
    const token = await makeToken({ iss: ISSUER, sub: "user_x", exp: 1_700_003_600 });
    const res = await h.gateway.authorize(
      new Request("https://app/api/llm", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.turn.tier).toBe("free");
  });
});

describe("Gateway.complete — metering + replay", () => {
  let gw: Gateway;
  let store: InMemoryLedger;

  beforeEach(async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    jwk = {
      ...((await subtle.exportKey("jwk", pair.publicKey)) as object),
      kid: "k1",
      alg: "ES256",
    } as Jwk;
    const h = await makeHarness();
    gw = h.gateway;
    store = h.store;
  });

  async function authorizedTurn(idempotencyKey: string) {
    const token = await makeToken({ iss: ISSUER, sub: "user_1", exp: 1_700_003_600 });
    const res = await gw.authorize(
      new Request("https://app/api/llm", {
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey },
      }),
    );
    if (!res.ok) throw new Error(res.error.message);
    return res.turn;
  }

  it("first call is billable, recording usage", async () => {
    const turn = await authorizedTurn("ik-1");
    const res = await gw.complete(turn, providerFetch(llmPayload()));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.billed).toBe(true);
    expect(res.replayed).toBe(false);
    const count = await store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z");
    expect(count).toBe(1);
  });

  it("replay (same idempotency key) = ZERO new billable events", async () => {
    const turn1 = await authorizedTurn("ik-same");
    const first = await gw.complete(turn1, providerFetch(llmPayload()));
    if (!first.ok) throw new Error(first.error.message);
    expect(first.billed).toBe(true);

    // A brand-new request object, but the SAME idempotency key (replay).
    const turn2 = await authorizedTurn("ik-same");
    const replay = await gw.complete(turn2, providerFetch(llmPayload()));
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.replayed).toBe(true);
    expect(replay.billed).toBe(false);

    // Exactly ONE billable row exists.
    const count = await store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z");
    expect(count).toBe(1);
  });

  it("a failed provider call (5xx) is passed through and NOT billed", async () => {
    const turn = await authorizedTurn("ik-fail");
    const res = await gw.complete(turn, providerFetch({ error: "boom" }, 500));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.response.status).toBe(500);
    expect(res.billed).toBe(false);
    const count = await store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z");
    expect(count).toBe(0);
  });

  it("throws a structured 502 when the provider fetch rejects", async () => {
    const turn = await authorizedTurn("ik-reject");
    const res = await gw.complete(turn, async () => {
      throw new TypeError("fetch failed");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.httpStatus).toBe(502);
    }
    const count = await store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z");
    expect(count).toBe(0);
  });
});
