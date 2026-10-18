/**
 * Supabase (PostgREST) adapters for the gateway:
 *  - {@link SupabaseLedgerStore}: the usage-ledger {@link LedgerStore}
 *  - {@link EntitlementStore}:    plan tier lookups (free by default)
 *
 * Plain REST against the PostgREST endpoint with the service-role key — no
 * vendor SDK, and every `fetch` is injectable so CI runs against mocks. The
 * SQL contract is packages/metering/schema/ledger.sql.
 *
 * Security notes:
 *  - The service-role key lives ONLY in Pages secrets; it never reaches the
 *    client bundle (checked by the bundle gate).
 *  - Queries use the `Prefer: resolution=merge-duplicates` / upsert patterns
 *    so the unique (user_id, idempotency_key) constraint is the authority on
 *    replay safety (the DB, not app logic, enforces "zero billable replays").
 */
import type { LedgerEvent, LedgerStore, PlanTier } from "@kove-advanced/metering";

export interface SupabaseConfig {
  /** e.g. https://xxxx.supabase.co */
  readonly url: string;
  /** service-role key (Pages secret) */
  readonly serviceRoleKey: string;
  readonly fetchImpl?: typeof fetch;
}

interface PostgrestError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

/**
 * Ledger store backed by `public.usage_ledger`.
 *
 * Replay safety: `findOriginal` first; a lost race is caught by the unique
 * constraint on insert (23505) and treated as "original already exists".
 */
export class SupabaseLedgerStore implements LedgerStore {
  constructor(private readonly cfg: SupabaseConfig) {}

  private get fetchFn(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.cfg.serviceRoleKey,
      Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
  }

  private async get(
    table: string,
    params: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchFn(`${this.cfg.url}/rest/v1/${table}?${qs}`, {
      method: "GET",
      headers: this.headers(),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body };
  }

  async findOriginal(
    userId: string,
    idempotencyKey: string,
  ): Promise<LedgerEvent | undefined> {
    const { status, body } = await this.get("usage_ledger", {
      user_id: `eq.${encodeURIComponent(userId)}`,
      idempotency_key: `eq.${encodeURIComponent(idempotencyKey)}`,
      limit: "1",
    });
    if (status === 404) return undefined;
    if (status !== 200) throw new Error(`ledger find failed: HTTP ${status}`);
    const rows = body as unknown[] | undefined;
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    return rowToEvent(rows[0] as Record<string, unknown>);
  }

  async insertBillable(event: LedgerEvent): Promise<LedgerEvent> {
    // Plain insert — NO merge resolution: on a lost race the unique
    // (user_id, idempotency_key) constraint rejects us (409/23505) and the
    // ORIGINAL row stays authoritative. A merge would have overwritten it.
    const res = await this.fetchFn(`${this.cfg.url}/rest/v1/usage_ledger`, {
      method: "POST",
      headers: { ...this.headers(), Prefer: "return=minimal" },
      body: JSON.stringify(eventToRow(event)),
    });
    if (res.status === 201) return event;
    if (res.status === 409) {
      const err = (await res.json().catch(() => ({}))) as PostgrestError;
      if (err.code === "23505") {
        const existing = await this.findOriginal(event.userId, event.idempotencyKey);
        return existing ?? event;
      }
    }
    const err = (await res.json().catch(() => ({}))) as PostgrestError;
    throw new Error(`ledger insert failed: HTTP ${res.status} ${err.message ?? ""}`);
  }

  async countBillableTurnsSince(
    userId: string,
    sinceIso: string,
  ): Promise<number> {
    const { status, body } = await this.get("usage_ledger", {
      user_id: `eq.${encodeURIComponent(userId)}`,
      created_at: `gte.${encodeURIComponent(sinceIso)}`,
      select: "id",
    });
    if (status !== 200) throw new Error(`ledger count failed: HTTP ${status}`);
    const rows = body as unknown[] | undefined;
    return Array.isArray(rows) ? rows.length : 0;
  }
}

/**
 * Entitlements: one row per user in `public.user_entitlements`, default
 * "free" when absent. Written only by the MoR webhook handler.
 */
export class EntitlementStore {
  constructor(private readonly cfg: SupabaseConfig) {}

  private get fetchFn(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  async getTier(userId: string): Promise<PlanTier> {
    const res = await this.fetchFn(
      `${this.cfg.url}/rest/v1/user_entitlements?user_id=eq.${encodeURIComponent(userId)}&select=tier&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: this.cfg.serviceRoleKey,
          Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
        },
      },
    );
    if (res.status === 404) return "free";
    if (res.status !== 200) throw new Error(`entitlement read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ tier?: string }>;
    const tier = rows[0]?.tier;
    return tier === "pro" ? "pro" : "free";
  }

  /** Upsert an entitlement (called by the MoR webhook handler only). */
  async setEntitlement(
    userId: string,
    tier: PlanTier,
    refs?: { morCustomerId?: string; morSubscriptionId?: string },
  ): Promise<void> {
    const res = await this.fetchFn(
      `${this.cfg.url}/rest/v1/user_entitlements?on_conflict=user_id`,
      {
        method: "POST",
        headers: {
          apikey: this.cfg.serviceRoleKey,
          Authorization: `Bearer ${this.cfg.serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          user_id: userId,
          tier,
          mor_customer_id: refs?.morCustomerId ?? null,
          mor_subscription_id: refs?.morSubscriptionId ?? null,
        }),
      },
    );
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`entitlement write failed: HTTP ${res.status}`);
    }
  }
}

// ---- row mapping -----------------------------------------------------------

function eventToRow(ev: LedgerEvent): Record<string, unknown> {
  return {
    id: ev.id,
    user_id: ev.userId,
    idempotency_key: ev.idempotencyKey,
    tier: ev.tier,
    model: ev.model,
    input_tokens: ev.usage.inputTokens,
    output_tokens: ev.usage.outputTokens,
    // 0 + "unverified" until the owner's verified price list is configured
    // (no fabricated numbers); back-fill later via UPDATE.
    cost_usd: ev.costUsd,
    cost_status: ev.costStatus,
    latency_ms: ev.latencyMs,
    replay_of: null,
    created_at: ev.createdAt,
  };
}

function rowToEvent(row: Record<string, unknown>): LedgerEvent {
  return {
    id: String(row.id ?? ""),
    idempotencyKey: String(row.idempotency_key ?? ""),
    userId: String(row.user_id ?? ""),
    tier: (row.tier === "pro" ? "pro" : "free"),
    model: String(row.model ?? ""),
    usage: {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
    },
    costUsd: Number(row.cost_usd ?? 0),
    costStatus: (row.cost_status === "listed" ? "listed" : "unverified"),
    latencyMs: Number(row.latency_ms ?? 0),
    billable: true,
    replay: false,
    createdAt: String(row.created_at ?? new Date().toISOString()),
  };
}
