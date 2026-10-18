/**
 * Tiered end-to-end latency budget for a plan_edit turn.
 *
 * The owner chose TIERED budgets: the free tier gets a tighter cap, Pro gets
 * the 300 s design budget. The budget is split into stages so the gateway can
 * fail EARLY (before spending the LLM call) when earlier stages already
 * exhausted the cap, and can surface which stage is the bottleneck.
 */
import { meteringError, type MeteringError } from "./types";

export type BudgetStage = "frame-sampling" | "perception" | "llm" | "apply";

export interface StageBudgets {
  readonly "frame-sampling": number;
  readonly perception: number;
  readonly llm: number;
  readonly apply: number;
}

export interface BudgetConfig {
  readonly totalMs: number;
  readonly stages: StageBudgets;
}

/**
 * Build the tiered stage budgets from a total (defaults follow the 300 s
 * Pro design: sampling 45 s, perception 60 s, LLM 150 s, apply 45 s).
 * Free tier (60 s) scales the same split. These are policy constants, not
 * measurements — owners can override any stage via `stages`.
 */
export function buildBudgetConfig(totalMs: number, stages?: Partial<StageBudgets>): BudgetConfig {
  const fractions = { "frame-sampling": 0.15, perception: 0.2, llm: 0.5, apply: 0.15 };
  const base: Record<BudgetStage, number> = {
    "frame-sampling": Math.floor(totalMs * fractions["frame-sampling"]),
    perception: Math.floor(totalMs * fractions.perception),
    llm: Math.floor(totalMs * fractions.llm),
    apply: Math.floor(totalMs * fractions.apply),
  };
  return { totalMs, stages: { ...base, ...stages } };
}

export interface SpentStage {
  readonly stage: BudgetStage;
  readonly spentMs: number;
}

/**
 * Accumulates stage spend and enforces both the per-stage and total caps.
 * `spend()` fails with BUDGET_EXCEEDED when a stage (or the turn total) would
 * overflow — the caller should stop the pipeline and surface the error.
 */
export class TurnLatencyBudget {
  private readonly spent: Record<BudgetStage, number> = {
    "frame-sampling": 0,
    perception: 0,
    llm: 0,
    apply: 0,
  };

  constructor(private readonly config: BudgetConfig) {}

  get totalBudgetMs(): number {
    return this.config.totalMs;
  }

  /** The configured per-stage cap (ms) — tests and diagnostics. */
  stageCap(stage: BudgetStage): number {
    return this.config.stages[stage];
  }

  get totalSpentMs(): number {
    return (
      this.spent["frame-sampling"] + this.spent.perception + this.spent.llm + this.spent.apply
    );
  }

  stageRemaining(stage: BudgetStage): number {
    return Math.max(0, this.config.stages[stage] - this.spent[stage]);
  }

  /** Record completed stage time; fails if it would overflow stage or total. */
  spend(stage: BudgetStage, ms: number): { ok: true } | { ok: false; error: MeteringError } {
    if (ms < 0) return this.fail(`negative duration for ${stage}`);
    const stageBudget = this.config.stages[stage];
    if (this.spent[stage] + ms > stageBudget) {
      return this.fail(
        `stage "${stage}" exceeded its ${stageBudget} ms cap ` +
          `(already spent ${this.spent[stage]} ms)`,
      );
    }
    if (this.totalSpentMs + ms > this.config.totalMs) {
      return this.fail(
        `turn exceeded the ${this.config.totalMs} ms end-to-end budget ` +
          `(spent so far ${this.totalSpentMs} ms)`,
      );
    }
    this.spent[stage] += ms;
    return { ok: true };
  }

  /**
   * Pre-flight guard before an expensive stage: is at least `needMs` left in
   * both the stage and the total? Lets the pipeline skip a stage it cannot
   * afford instead of discovering it mid-flight.
   */
  canAfford(stage: BudgetStage, needMs: number): boolean {
    return (
      this.spent[stage] + needMs <= this.config.stages[stage] &&
      this.totalSpentMs + needMs <= this.config.totalMs
    );
  }

  /** Snapshot for logging/ledger (no secrets, no prompt content). */
  report(): readonly SpentStage[] {
    return (Object.keys(this.spent) as BudgetStage[])
      .filter((stage) => this.spent[stage] > 0)
      .map((stage) => ({ stage, spentMs: this.spent[stage] }));
  }

  private fail(detail: string): { ok: false; error: MeteringError } {
    return {
      ok: false,
      error: meteringError(
        "BUDGET_EXCEEDED",
        `Latency budget exceeded: ${detail}.`,
        "Try a shorter clip, a simpler brief, or upgrade to Pro for a larger budget.",
        504,
      ),
    };
  }
}
