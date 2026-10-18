// @vitest-environment node
/**
 * Server-side LLM gateway (Cloudflare Pages Function) — unit tests.
 *
 * Run in a plain Node environment (no jsdom): Request/Response/Headers are
 * native here, matching the Pages runtime. Every vendor is mocked:
 *  - Clerk: locally generated ES256 key + in-memory JWKS fetch
 *  - Supabase: mocked PostgREST fetch (entitlements + ledger race behavior)
 *  - Workers AI / frontier: scripted fetch
 *
 * Acceptance under test (§2): 401 unauth, QUOTA_EXCEEDED, model gating,
 * model rewrite, replay = zero billable events, frontier-not-configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLlmGateway, onRequest, type LlmGatewayDeps } from "./[[catchall]]";
import { EntitlementStore, Gateway } from "@kove-advanced/gateway";
import {
  DEFAULT_FAST_MODEL,
  DEFAULT_FRONTIER_MODEL,
  DEFAULT_PLAN_LIMITS,
  InMemoryLedger,
  Ledger,
} from "@kove-advanced/metering";

const ENV = {
  CLOUDFLARE_API_TOKEN: "test-token-do-not-log",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
};

const ISSUER = "https://test.clerk.accounts.dev";
const SUPABASE = "https://test.supabase.co";
const SKEY = "service-role-test";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let jwk: Record<string, unknown>;
let privateKey: CryptoKey;

async function makeToken(claims: Record<string, unknown>): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const header = { alg: "ES256", kid: "k1", typ: "JWT" };
  const data = `${b64url(new TextEncoder().encode(JSON.stringify(header)))}.${b64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(data).buffer as ArrayBuffer,
  );
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

const jwksFetch = (async (_u: string | URL | Request, _i?: RequestInit) =>
  Response.json({ keys: [jwk] })) as unknown as typeof fetch;

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

interface Harness extends LlmGatewayDeps {
  store: InMemoryLedger;
  providerCalls: Array<{ url: string; auth?: string; body?: unknown }>;
}

async function makeHarness(opts?: {
  tiers?: Record<string, "free" | "pro">;
  quota?: number;
  hasFrontier?: boolean;
  provider?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<Harness> {
  const store = new InMemoryLedger();
  const ledger = new ScriptedLedger(store, opts?.quota ?? 0);
  const gateway = new Gateway({
    clerk: { issuer: ISSUER, jwksUrl: "https://clerk.com/.well-known/jwks.json", fetchImpl: jwksFetch, nowMs: 1_700_000_000_000 },
    entitlements: new EntitlementStore({ url: SUPABASE, serviceRoleKey: SKEY, fetchImpl: supabaseFetch(opts?.tiers ?? {}) }),
    ledger,
    isFrontierModel: (m) => m === DEFAULT_FRONTIER_MODEL,
    nowMs: 1_700_000_000_000,
  });
  const providerCalls: Harness["providerCalls"] = [];
  const fetchProvider: LlmGatewayDeps["fetchProvider"] = async (url, init) => {
    const headers = init?.headers as
      | undefined
      | Headers
      | Record<string, string>;
    const auth =
      headers instanceof Headers
        ? headers.get("Authorization") ?? undefined
        : headers
          ? (headers as Record<string, string>)["Authorization"] ??
            (headers as Record<string, string>)["authorization"] ??
            undefined
          : undefined;
    providerCalls.push({
      url,
      auth,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (opts?.provider) return opts.provider(url, init);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    gateway,
    fetchProvider,
    fastModel: DEFAULT_FAST_MODEL,
    frontierModel: DEFAULT_FRONTIER_MODEL,
    hasFrontier: opts?.hasFrontier ?? false,
    isFrontierModel: (m) => m === DEFAULT_FRONTIER_MODEL,
    store,
    providerCalls,
  };
}

function authHeaders(token?: string, idemKey?: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (idemKey) h["Idempotency-Key"] = idemKey;
  return h;
}

const BODY = { model: DEFAULT_FAST_MODEL, messages: [{ role: "user", content: "cut it" }] };

describe("handleLlmGateway — auth", () => {
  let h: Harness;

  beforeEach(async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    jwk = { ...((await subtle.exportKey("jwk", pair.publicKey)) as object), kid: "k1", alg: "ES256" };
    h = await makeHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401 when no Authorization header is present", async () => {
    h = await makeHarness();
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("401 for a tampered token (provider never called)", async () => {
    h = await makeHarness();
    const token = await makeToken({ iss: ISSUER, sub: "user_1", exp: 1_700_003_600 });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token.slice(0, -4) + "AAAA"),
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(401);
    expect(h.providerCalls).toHaveLength(0);
  });

  it("401 even for /v1/models (no free data endpoint)", async () => {
    h = await makeHarness();
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models"),
      ENV,
      "v1/models",
      h,
    );
    expect(res.status).toBe(401);
  });
});

describe("handleLlmGateway — routing + metering", () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    jwk = { ...((await subtle.exportKey("jwk", pair.publicKey)) as object), kid: "k1", alg: "ES256" };
    h = await makeHarness();
    token = await makeToken({ iss: ISSUER, sub: "user_1", exp: 1_700_003_600 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("relays to Workers AI with server-side credentials and rewrites the model", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-1"),
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: "ok" } }] });
    expect(h.providerCalls).toHaveLength(1);
    const call = h.providerCalls[0];
    expect(call.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
    );
    expect(call.auth).toBe("Bearer test-token-do-not-log");
    expect(call.body).toMatchObject({ model: DEFAULT_FAST_MODEL });
    expect(res.headers.get("X-Kove-Billed")).toBe("1");
    expect(res.headers.get("X-Kove-Replayed")).toBe("0");
  });

  it("REPLAY (same Idempotency-Key) = zero new billable rows", async () => {
    const make = () =>
      handleLlmGateway(
        new Request("https://app.example/api/llm/v1/chat/completions", {
          method: "POST",
          headers: authHeaders(token, "ik-same"),
          body: JSON.stringify(BODY),
        }),
        ENV,
        "v1/chat/completions",
        h,
      );
    const first = await make();
    expect(first.headers.get("X-Kove-Billed")).toBe("1");
    const replay = await make();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Kove-Billed")).toBe("0");
    expect(replay.headers.get("X-Kove-Replayed")).toBe("1");
    // The provider WAS called again (the client needs the response), but the
    // ledger has exactly ONE billable row.
    expect(h.providerCalls).toHaveLength(2);
    const count = await h.store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z");
    expect(count).toBe(1);
  });

  it("QUOTA_EXCEEDED (429) when the rolling-day count is at the cap", async () => {
    const full = await makeHarness({ quota: DEFAULT_PLAN_LIMITS.free.maxTurnsPerDay });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-q"),
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      full,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; suggestedFix: string } };
    expect(body.error.code).toBe("QUOTA_EXCEEDED");
    expect(body.error.suggestedFix).toMatch(/upgrade|tomorrow/i);
    expect(full.providerCalls).toHaveLength(0);
  });

  it("free tier requesting the frontier model → 403 MODEL_NOT_ALLOWED", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-f"),
        body: JSON.stringify({ ...BODY, model: DEFAULT_FRONTIER_MODEL }),
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MODEL_NOT_ALLOWED");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("pro tier + frontier configured → relays to the frontier endpoint", async () => {
    const pro = await makeHarness({ tiers: { user_1: "pro" }, hasFrontier: true });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-p"),
        body: JSON.stringify({ ...BODY, model: DEFAULT_FRONTIER_MODEL }),
      }),
      { ...ENV, FRONTIER_BASE_URL: "https://frontier.example", FRONTIER_API_KEY: "fk" },
      "v1/chat/completions",
      pro,
    );
    expect(res.status).toBe(200);
    expect(pro.providerCalls[0].url).toBe("https://frontier.example/v1/chat/completions");
    expect(pro.providerCalls[0].auth).toBe("Bearer fk");
  });

  it("pro tier + frontier NOT configured → structured 503 FRONTIER_NOT_CONFIGURED", async () => {
    const pro = await makeHarness({ tiers: { user_1: "pro" }, hasFrontier: false });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-pc"),
        body: JSON.stringify({ ...BODY, model: DEFAULT_FRONTIER_MODEL }),
      }),
      ENV, // no FRONTIER_* env
      "v1/chat/completions",
      pro,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FRONTIER_NOT_CONFIGURED");
  });

  it("/v1/models returns the tier's allowed models (authenticated, not billable)", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models", {
        headers: authHeaders(token),
      }),
      ENV,
      "v1/models",
      h,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [DEFAULT_FAST_MODEL] });
    expect(await h.store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z")).toBe(0);
  });

  it("strips CF hop headers + adds CORS to the provider response", async () => {
    const withHeaders = await makeHarness({
      provider: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "cf-ray": "abc",
            "set-cookie": "session=x",
          },
        }),
    });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: { ...authHeaders(token, "ik-h"), Origin: "https://kove-advanced.pages.dev" },
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      withHeaders,
    );
    expect(res.headers.get("cf-ray")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://kove-advanced.pages.dev");
  });

  it("maps a rejecting provider to a structured 502 (no raw text)", async () => {
    const failing = await makeHarness({
      provider: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-e"),
        body: JSON.stringify(BODY),
      }),
      ENV,
      "v1/chat/completions",
      failing,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(String(body.error.message)).not.toContain("fetch failed");
    // Failed upstream is NOT billable.
    expect(await failing.store.countBillableTurnsSince("user_1", "2025-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("handleLlmGateway — hardening (preserved)", () => {
  let h: Harness;
  let token: string;

  beforeEach(async () => {
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    privateKey = pair.privateKey;
    jwk = { ...((await subtle.exportKey("jwk", pair.publicKey)) as object), kid: "k1", alg: "ES256" };
    h = await makeHarness();
    token = await makeToken({ iss: ISSUER, sub: "user_1", exp: 1_700_003_600 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a structured 503 when deps cannot be built (missing env)", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", { method: "POST" }),
      {}, // no secrets at all
      "v1/chat/completions",
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("GATEWAY_NOT_CONFIGURED");
  });

  it("answers CORS preflights without touching auth or upstream", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          Origin: "https://kove-advanced.pages.dev",
          "Access-Control-Request-Method": "POST",
        },
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://kove-advanced.pages.dev");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("rejects disallowed paths and methods", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/embeddings"),
      ENV,
      "v1/embeddings",
      h,
    );
    expect(res.status).toBe(404);

    const badMethod = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/models", { method: "DELETE" }),
      ENV,
      "v1/models",
      h,
    );
    expect(badMethod.status).toBe(405);
  });

  it("rejects bodies over the 8 MB cap before touching upstream", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Length": String(9_000_000) },
        body: new Uint8Array(16),
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BODY_TOO_LARGE");
    expect(h.providerCalls).toHaveLength(0);
  });

  it("rejects non-JSON bodies with 400", async () => {
    const res = await handleLlmGateway(
      new Request("https://app.example/api/llm/v1/chat/completions", {
        method: "POST",
        headers: authHeaders(token, "ik-bad"),
        body: "not json",
      }),
      ENV,
      "v1/chat/completions",
      h,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("onRequest (Pages adapter)", () => {
  it("fails CLOSED (503) when env lacks auth/ledger config", async () => {
    // ENV has Workers AI secrets but no CLERK_ISSUER/SUPABASE_* — the adapter
    // must build deps from env and fail closed, never serve unauthenticated.
    const res = await onRequest({
      request: new Request("https://app.example/api/llm/v1/models"),
      params: { catchall: ["v1", "models"] },
      env: ENV,
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "GATEWAY_NOT_CONFIGURED",
    );
  });
});
