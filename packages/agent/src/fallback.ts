import type { LLMClient, LLMTurnInput, LLMResponse } from "./llm";

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

export type FallbackLeg = "primary" | "secondary" | "tertiary";

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
}

/**
 * Wraps clients into an omni-first ladder: `primary` is attempted, and any
 * failure it surfaces (gateway down, quota, 5xx, stream idle) replays the same
 * turn on `secondary` after tripping a cooldown window; a secondary failure
 * falls through to `tertiary` when present. The failing leg's error is
 * rethrown unchanged when no further leg exists, so provider-specific handling
 * upstream (retry regexes that match `cloudflare-ai 429`, quota classification)
 * keeps working. User aborts are never treated as provider failure.
 */
export function makeFallbackClient(opts: FallbackClientOptions): LLMClient {
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let primaryDownUntil = 0;
  const shouldFall = opts.shouldFallback ?? ((error: unknown) => !isAbortError(error));

  return {
    async complete(input: LLMTurnInput): Promise<LLMResponse> {
      if (now() >= primaryDownUntil) {
        try {
          return await opts.primary.complete(input);
        } catch (error) {
          if (!shouldFall(error)) throw error;
          if (cooldownMs > 0) primaryDownUntil = now() + cooldownMs;
          opts.onFallback?.(error, "primary");
        }
      }
      const replay = opts.secondaryInput ? opts.secondaryInput(input) : input;
      try {
        return await opts.secondary.complete(replay);
      } catch (error) {
        if (!shouldFall(error)) throw error;
        if (opts.tertiary) {
          opts.onFallback?.(error, "secondary");
          return await opts.tertiary.complete(input);
        }
        throw error;
      }
    },
  };
}
