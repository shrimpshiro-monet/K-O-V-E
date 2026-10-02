import type { ToolResult } from "./types";

/**
 * Multicam tools historically took MILLISECONDS (`startMs`, `commitMs`, ...)
 * while every other tool takes SECONDS. This adds second-based parameters named
 * like the rest of the editor and keeps the old names as deprecated aliases.
 * Conversion happens here, at the tool layer: the host bridge interface and the
 * persisted .orma artifact stay millisecond-based and are not touched.
 *
 *   old (ms)            new (seconds)
 *   startMs / endMs     startTime / endTime
 *   timeMs              time
 *   deltaMs             delta
 *   commitMs            commitDuration
 *   layoutEnterMs       layoutEnterDuration
 *   layoutExitMs        layoutExitDuration
 *   minLayoutLifeMs     minLayoutLifeDuration
 */

export interface TimeParamSpec {
  /** New, seconds-based parameter name. */
  readonly sec: string;
  /** Deprecated, milliseconds-based alias. */
  readonly ms: string;
}

export interface ResolvedMs {
  readonly ms: number | undefined;
  readonly warnings: string[];
  readonly error?: ToolResult;
}

const invalid = (message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code: "INVALID_PARAMS", message, suggestedFix },
});

const toMs = (seconds: number): number => Number((seconds * 1000).toFixed(6));

/** Read one time parameter given in seconds (preferred) and/or ms (deprecated). */
export function resolveMs(args: Record<string, unknown>, spec: TimeParamSpec): ResolvedMs {
  const warnings: string[] = [];
  const rawSec = args[spec.sec];
  const rawMs = args[spec.ms];

  if (rawSec !== undefined && (typeof rawSec !== "number" || !Number.isFinite(rawSec))) {
    return {
      ms: undefined,
      warnings,
      error: invalid(
        `'${spec.sec}' must be a finite number of seconds.`,
        `Pass ${spec.sec} as a number of SECONDS, e.g. ${spec.sec}: 1.5 means 1.5 seconds.`,
      ),
    };
  }
  if (rawMs !== undefined && (typeof rawMs !== "number" || !Number.isFinite(rawMs))) {
    return {
      ms: undefined,
      warnings,
      error: invalid(
        `'${spec.ms}' must be a finite number of milliseconds.`,
        `Use ${spec.sec} (seconds) instead of the deprecated ${spec.ms}.`,
      ),
    };
  }

  if (rawMs !== undefined) {
    warnings.push(
      `'${spec.ms}' is deprecated (milliseconds); use '${spec.sec}' (seconds) instead.`,
    );
  }
  if (rawSec !== undefined && rawMs !== undefined && Math.abs(toMs(rawSec as number) - (rawMs as number)) > 0.5) {
    return {
      ms: undefined,
      warnings,
      error: invalid(
        `'${spec.sec}' (${rawSec} s = ${toMs(rawSec as number)} ms) conflicts with '${spec.ms}' (${rawMs} ms).`,
        `Pass only '${spec.sec}' in seconds. ${spec.ms} is deprecated and in milliseconds.`,
      ),
    };
  }
  const ms = rawMs !== undefined ? (rawMs as number) : rawSec !== undefined ? toMs(rawSec as number) : undefined;
  return { ms, warnings };
}

export const START: TimeParamSpec = { sec: "startTime", ms: "startMs" };
export const END: TimeParamSpec = { sec: "endTime", ms: "endMs" };

export interface ResolvedRange {
  readonly startMs: number | undefined;
  readonly endMs: number | undefined;
  readonly warnings: string[];
  readonly error?: ToolResult;
}

/** startTime/endTime (or deprecated startMs/endMs) with 0 <= start < end. */
export function resolveRange(
  args: Record<string, unknown>,
  label: string,
  options: { required?: boolean } = {},
): ResolvedRange {
  const start = resolveMs(args, START);
  if (start.error) return { startMs: undefined, endMs: undefined, warnings: start.warnings, error: start.error };
  const end = resolveMs(args, END);
  const warnings = [...start.warnings, ...end.warnings];
  if (end.error) return { startMs: undefined, endMs: undefined, warnings, error: end.error };
  const { ms: startMs } = start;
  const { ms: endMs } = end;
  if (options.required && (startMs === undefined || endMs === undefined)) {
    return {
      startMs,
      endMs,
      warnings,
      error: invalid(
        `${label} requires both startTime and endTime (seconds).`,
        "Pass startTime and endTime in seconds, e.g. startTime: 12.5, endTime: 15.",
      ),
    };
  }
  if (
    (startMs !== undefined && startMs < 0) ||
    (endMs !== undefined && endMs < 0) ||
    (startMs !== undefined && endMs !== undefined && endMs <= startMs)
  ) {
    return {
      startMs,
      endMs,
      warnings,
      error: invalid(
        `${label} range must satisfy 0 <= startTime < endTime (seconds).`,
        "Check the order and units: both values are seconds from the start of the group.",
      ),
    };
  }
  return { startMs, endMs, warnings };
}

/** Attach non-empty warnings to a tool result. */
export function withWarnings(result: ToolResult, warnings: readonly string[]): ToolResult {
  return warnings.length > 0 ? { ...result, warnings: [...warnings] } : result;
}

// ---- outputs ------------------------------------------------------------

const MS_KEY = /^([a-z][A-Za-z0-9]*)Ms$/;

function secondsKeyFor(key: string): string | null {
  const base = MS_KEY.exec(key)?.[1];
  if (!base) return null;
  switch (base) {
    case "start":
      return "startTime";
    case "end":
      return "endTime";
    case "time":
      return "time";
    case "delta":
      return "delta";
    case "duration":
      return "duration";
    default:
      return `${base}Duration`;
  }
}

/**
 * Deep copy of a tool output where every numeric `*Ms` field gains a sibling in
 * seconds (`startMs`→`startTime`, `windowMs`→`windowDuration`, ...). The `*Ms`
 * originals are kept; an existing sibling is never overwritten.
 */
export function withSecondFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withSecondFields(v)) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(src)) out[key] = withSecondFields(v);
  for (const [key, v] of Object.entries(src)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const secKey = secondsKeyFor(key);
    if (secKey && !(secKey in src)) out[secKey] = v / 1000;
  }
  return out as T;
}
