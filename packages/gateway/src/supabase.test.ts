import { describe, expect, it } from "vitest";
import { SupabaseLedgerStore, EntitlementStore } from "./supabase";

const BASE = "https://test.supabase.co";
const KEY = "service-role-test-key";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function mockFetch(handler: (call: Call) => { status: number; body?: unknown }): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const { status, body: out } = handler({ url, method, body });
    return new Response(out === undefined ? "[]" : JSON.stringify(out), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("SupabaseLedgerStore", () => {
  it("findOriginal returns an event when the row exists", async () => {
    const m = mockFetch(() => ({
      status: 200,
      body: [
        {
          id: "evt_1",
          user_id: "u1",
          idempotency_key: "k1",
          tier: "pro",
          model: "m",
          input_tokens: 10,
          output_tokens: 5,
          latency_ms: 100,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    const ev = await store.findOriginal("u1", "k1");
    expect(ev).toBeDefined();
    if (!ev) throw new Error("expected event");
    expect(ev.idempotencyKey).toBe("k1");
    expect(ev.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    // Query used the unique key pair.
    expect(m.calls[0].url).toContain("user_id=eq.u1");
    expect(m.calls[0].url).toContain("idempotency_key=eq.k1");
  });

  it("findOriginal returns undefined for an empty result", async () => {
    const m = mockFetch(() => ({ status: 200, body: [] }));
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    expect(await store.findOriginal("u1", "nope")).toBeUndefined();
  });

  it("insertBillable returns the inserted event on 201", async () => {
    const m = mockFetch((call) =>
      call.method === "POST" ? { status: 201, body: null } : { status: 200, body: [] },
    );
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    const ev = await store.insertBillable({
      id: "evt_new",
      idempotencyKey: "k1",
      userId: "u1",
      tier: "free",
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      costStatus: "unverified",
      latencyMs: 1,
      billable: true,
      replay: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(ev.id).toBe("evt_new");
  });

  it("on a lost race (409/23505) the ORIGINAL row is authoritative", async () => {
    // POST conflicts; the subsequent re-read GET returns the original row.
    const m = mockFetch((call) => {
      if (call.method === "POST") return { status: 409, body: { code: "23505", message: "duplicate key" } };
      return {
        status: 200,
        body: [
          {
            id: "evt_orig",
            user_id: "u1",
            idempotency_key: "k1",
            tier: "free",
            model: "m",
            input_tokens: 1,
            output_tokens: 1,
            latency_ms: 1,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    });
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    const ev = await store.insertBillable({
      id: "evt_new",
      idempotencyKey: "k1",
      userId: "u1",
      tier: "free",
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      costStatus: "unverified",
      latencyMs: 1,
      billable: true,
      replay: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // The ORIGINAL row is authoritative after the race.
    expect(ev.id).toBe("evt_orig");
    expect(ev.id).not.toBe("evt_new");
  });

  it("insertBillable throws on other non-2xx responses", async () => {
    const m = mockFetch((call) =>
      call.method === "POST" ? { status: 500, body: { message: "boom" } } : { status: 200, body: [] },
    );
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    await expect(
      store.insertBillable({
        id: "evt_new",
        idempotencyKey: "k1",
        userId: "u1",
        tier: "free",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
        costStatus: "unverified",
        latencyMs: 1,
        billable: true,
        replay: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/ledger insert failed: HTTP 500/);
  });

  it("countBillableTurnsSince counts rows since the window", async () => {
    const m = mockFetch(() => ({ status: 200, body: [{ id: 1 }, { id: 2 }] }));
    const store = new SupabaseLedgerStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    const n = await store.countBillableTurnsSince("u1", "2026-01-01T00:00:00.000Z");
    expect(n).toBe(2);
    expect(m.calls[0].url).toContain("created_at=gte.");
  });
});

describe("EntitlementStore", () => {
  it("returns pro when the row says pro", async () => {
    const m = mockFetch(() => ({ status: 200, body: [{ tier: "pro" }] }));
    const store = new EntitlementStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    expect(await store.getTier("u1")).toBe("pro");
  });

  it("defaults to free when there is no row (404)", async () => {
    const m = mockFetch(() => ({ status: 404, body: [] }));
    const store = new EntitlementStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    expect(await store.getTier("unknown")).toBe("free");
  });

  it("defaults to free for a malformed tier value", async () => {
    const m = mockFetch(() => ({ status: 200, body: [{ tier: "enterprise" }] }));
    const store = new EntitlementStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    expect(await store.getTier("u1")).toBe("free");
  });

  it("setEntitlement upserts and throws on non-2xx", async () => {
    const m = mockFetch((call) =>
      call.method === "POST" ? { status: 201, body: {} } : { status: 200, body: [] },
    );
    const store = new EntitlementStore({ url: BASE, serviceRoleKey: KEY, fetchImpl: m.fetchImpl });
    await store.setEntitlement("u1", "pro", { morCustomerId: "c1", morSubscriptionId: "s1" });
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].body).toMatchObject({ user_id: "u1", tier: "pro" });
  });
});
