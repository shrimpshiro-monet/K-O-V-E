import type { LLMClient, LLMTurnInput, LLMResponse } from "./llm";

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export type FallbackLeg = "primary" | "secondary" | "tertiary";

/** One provider in a fallback ladder. */
export interface LadderLeg {
  /** Stable label used in notices/diagnostics, e.g. "Cloudflare Workers AI". */
  readonly name: string;
  readonly client: LLMClient;
  /**
   * Adapt the replayed input for this leg. The first leg's tool set may be
   * sized for a stronger model; weaker providers can be handed their own
   * (smaller) set instead of inheriting a prompt they handle poorly.
   */
  readonly input?: (input: LLMTurnInput) => LLMTurnInput;
}

export interface FallbackLadderOptions {
  /** Ordered from most to least preferred. Must contain at least one leg. */
  readonly legs: readonly LadderLeg[];
  /**
   * Fires when a leg fails and the ladder advances, before the next leg is
   * attempted, e.g. to show a notice.
   */
  readonly onFallback?: (error: unknown, from: string, to: string) => void;
  /**
   * How long a leg stays bypassed after it fails. During the cooldown
   * completions skip it, so a dead provider costs one failed call per window
   * instead of one per turn. 0 disables cooling. The final leg is always tried.
   */
  readonly cooldownMs?: number;
  /** Gate on the current leg's error; default falls back on everything but a cancel. */
  readonly shouldFallback?: (error: unknown) => boolean;
  /**
   * A returned completion can still be useless (an empty response from a model
   * that failed to emit a tool call). Return false to treat it as a leg failure
   * and advance to the next provider. If every leg is unusable, the last
   * response is returned so the caller keeps its own recovery/error handling.
   */
  readonly acceptResponse?: (response: LLMResponse, input: LLMTurnInput) => boolean;
  /** Clock injection for tests. */
  readonly now?: () => number;
}

export interface FallbackClientOptions {
  /** Tried first on every completion while it is healthy. */
  readonly primary: LLMClient;
  /** Serves the turn once the primary fails or is cooling down. */
  readonly secondary: LLMClient;
  /**
   * Adapt the replayed input for the secondary side. The primary's tool set
   * may be sized for a stronger model; the secondary can be handed its own
   * (smaller) set instead of inheriting a prompt its provider handles poorly.
   * Only invoked for the replay — the primary always sees the original input.
   */
  readonly secondaryInput?: (input: LLMTurnInput) => LLMTurnInput;
  /**
   * Fires when a leg fails and the ladder advances (primary → secondary, or
   * secondary → tertiary), before the next leg is attempted, e.g. to show a notice.
   */
  readonly onFallback?: (error: unknown, leg: FallbackLeg) => void;
  /**
   * How long the primary stays bypassed after it fails. During the cooldown
   * completions go straight to the secondary, so a dead gateway costs one
   * failed call per window instead of one per turn. 0 disables cooling.
   */
  readonly cooldownMs?: number;
  /** Gate on the current leg's error; default falls back on everything but a cancel. */
  readonly shouldFallback?: (error: unknown) => boolean;
  /** Clock injection for tests. */
  readonly now?: () => number;
  /**
   * Final leg tried after the secondary fails. Unset keeps the historical
   * two-leg behavior (the secondary's error propagates).
   */
  readonly tertiary?: LLMClient;
  /** Adapt the replayed input for the tertiary leg. */
  readonly tertiaryInput?: (input: LLMTurnInput) => LLMTurnInput;
  /** Accept a completion as usable before advancing to the next leg. */
  readonly acceptResponse?: (response: LLMResponse, input: LLMTurnInput) => boolean;
}

class UnusableCompletionError extends Error {
  override readonly name = "UnusableCompletionError";

  constructor(leg: string) {
    super(`${leg} did not produce a usable completion`);
  }
}

/**
 * Wraps any number of clients into an ordered provider ladder. A leg is
 * attempted until one answers; failures (gateway down, quota, 5xx, stream
 * idle, or an unusable completion) advance to the next leg. Failed legs enter
 * a cooldown window, but the final leg is never skipped. User aborts are never
 * treated as provider failure.
 */
export function makeFallbackLadder(opts: FallbackLadderOptions): LLMClient {
  if (opts.legs.length === 0) {
    throw new Error("makeFallbackLadder requires at least one leg");
  }
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const downUntil = new Map<number, number>();
  const shouldFall = opts.shouldFallback ?? ((error: unknown) => !isAbortError(error));

  return {
    async complete(input: LLMTurnInput): Promise<LLMResponse> {
      let lastResponse: LLMResponse | undefined;
      let lastError: unknown;

      for (let index = 0; index < opts.legs.length; index++) {
        const isLast = index === opts.legs.length - 1;
        if (!isLast && now() < (downUntil.get(index) ?? 0)) continue;

        const leg = opts.legs[index];
        const replay = leg.input ? leg.input(input) : input;
        const next = opts.legs[index + 1];

        try {
          const response = await leg.client.complete(replay);
          if (!opts.acceptResponse || opts.acceptResponse(response, replay)) {
            return response;
          }
          lastResponse = response;
          if (isLast || !next) return response;
          if (cooldownMs > 0) downUntil.set(index, now() + cooldownMs);
          opts.onFallback?.(new UnusableCompletionError(leg.name), leg.name, next.name);
        } catch (error) {
          if (!shouldFall(error)) throw error;
          lastError = error;
          if (isLast || !next) throw error;
          if (cooldownMs > 0) downUntil.set(index, now() + cooldownMs);
          opts.onFallback?.(error, leg.name, next.name);
        }
      }

      if (lastResponse) return lastResponse;
      throw lastError ?? new Error("No provider legs were attempted");
    },
  };
}

/**
 * Two/three-leg compatibility wrapper around {@link makeFallbackLadder}.
 */
export function makeFallbackClient(opts: FallbackClientOptions): LLMClient {
  const legs: LadderLeg[] = [
    { name: "primary", client: opts.primary },
    { name: "secondary", client: opts.secondary, ...(opts.secondaryInput ? { input: opts.secondaryInput } : {}) },
  ];
  if (opts.tertiary) {
    legs.push({
      name: "tertiary",
      client: opts.tertiary,
      ...(opts.tertiaryInput ? { input: opts.tertiaryInput } : {}),
    });
  }

  return makeFallbackLadder({
    legs,
    ...(opts.onFallback
      ? { onFallback: (error: unknown, from: string) => opts.onFallback?.(error, from as FallbackLeg) }
      : {}),
    ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
    ...(opts.shouldFallback ? { shouldFallback: opts.shouldFallback } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.acceptResponse ? { acceptResponse: opts.acceptResponse } : {}),
  });
}
