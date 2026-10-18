/**
 * Ledger logic: idempotent recording of billable turns.
 *
 * THE invariant (PR2 acceptance): replaying a turn with the same
 * idempotencyKey MUST produce zero new billable events. `recordTurn` returns
 * the ORIGINAL event with `replay: true` on repeats, and the store is only
 * ever told to insert a billable row the first time a key is seen.
 */
import type {
  LedgerEvent,
  LedgerStore,
  PlanTier,
  TurnUsage,
} from "./types";

let counter = 0;
function nextEventId(): string {
  counter += 1;
  return `evt_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export interface RecordTurnArgs {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly tier: PlanTier;
  readonly model: string;
  readonly usage: TurnUsage;
  readonly costUsd: number;
  readonly costStatus: "unverified" | "listed";
  readonly latencyMs: number;
  readonly nowIso?: string;
}

export interface RecordTurnResult {
  readonly event: LedgerEvent;
  /** True when this call created the billable row (first time only). */
  readonly billable: boolean;
}

export class Ledger {
  constructor(private readonly store: LedgerStore) {}

  /**
   * Record a completed turn. Safe to call repeatedly with the same
   * idempotencyKey: only the first call is billable, all later calls resolve
   * to the original event flagged as a replay.
   */
  async recordTurn(args: RecordTurnArgs): Promise<RecordTurnResult> {
    const existing = await this.store.findOriginal(args.userId, args.idempotencyKey);
    if (existing) {
      return {
        event: { ...existing, replay: true, billable: false },
        billable: false,
      };
    }
    const event: LedgerEvent = {
      id: nextEventId(),
      idempotencyKey: args.idempotencyKey,
      userId: args.userId,
      tier: args.tier,
      model: args.model,
      usage: args.usage,
      costUsd: args.costUsd,
      costStatus: args.costStatus,
      latencyMs: args.latencyMs,
      billable: true,
      replay: false,
      createdAt: args.nowIso ?? new Date().toISOString(),
    };
    await this.store.insertBillable(event);
    return { event, billable: true };
  }

  /** Resolve an earlier turn (for idempotent responses) without bill effects. */
  async resolve(userId: string, idempotencyKey: string): Promise<LedgerEvent | undefined> {
    return this.store.findOriginal(userId, idempotencyKey);
  }

  /** Rolling-window billable turn count (replays never count). */
  async billableTurnsSince(userId: string, sinceIso: string): Promise<number> {
    return this.store.countBillableTurnsSince(userId, sinceIso);
  }
}

/**
 * Dependency-free store for tests, local dev, and as the reference behavior
 * for the Supabase-backed store (unique (user_id, idempotency_key) constraint
 * mirrors `unique` here).
 */
export class InMemoryLedger implements LedgerStore {
  private readonly originals = new Map<string, LedgerEvent>();

  private key(userId: string, idempotencyKey: string): string {
    return `${userId}\u0000${idempotencyKey}`;
  }

  async findOriginal(
    userId: string,
    idempotencyKey: string,
  ): Promise<LedgerEvent | undefined> {
    return this.originals.get(this.key(userId, idempotencyKey));
  }

  async insertBillable(event: LedgerEvent): Promise<LedgerEvent> {
    const k = this.key(event.userId, event.idempotencyKey);
    // Reference behavior: a concurrent second insert of the same key is a
    // no-op (the DB enforces this with a unique constraint).
    if (!this.originals.has(k)) {
      this.originals.set(k, event);
    }
    return event;
  }

  async countBillableTurnsSince(
    userId: string,
    sinceIso: string,
  ): Promise<number> {
    const since = Date.parse(sinceIso);
    let n = 0;
    for (const ev of this.originals.values()) {
      if (ev.userId !== userId || !ev.billable) continue;
      if (Date.parse(ev.createdAt) >= since) n += 1;
    }
    return n;
  }
}
