/**
 * Program mastering — the last stage of the export audio chain.
 *
 * One uniform gain across the whole programme, chosen so the mix lands on a
 * distribution target (default −14 LUFS, the loudness platforms normalize to)
 * without letting the true peak exceed a ceiling (default −1 dBTP, with a
 * small safety margin for decoder overshoot). Deliberately conservative v1:
 * no dynamic compression, no limiter, no look-ahead — a single gain factor.
 * When the target would push the true peak past the ceiling, the gain is
 * clamped to the ceiling (reporting `peakLimited: true`) rather than
 * compressing.
 *
 * All measurement composes the committed BS.1770-4 primitives in
 * `meter.ts` (`measureLoudness`: integrated loudness + 4×-oversampled true
 * peak) — this module reimplements no DSP. Because a uniform gain scales
 * loudness and true peak in exactly log-domain offset, the post-gain values
 * are computed analytically (integratedAfter = integratedBefore + gainDb),
 * which keeps mastering to a single measurement pass.
 */

import { measureLoudness } from "./meter";

export const DEFAULT_TARGET_LUFS = -14;
export const DEFAULT_TRUE_PEAK_CEILING_DBTP = -1;
/** Headroom kept below the ceiling so decoder/codec overshoot stays legal. */
export const DEFAULT_TRUE_PEAK_MARGIN_DB = 0.2;
/** Gains smaller than this are treated as "already on target" (no rewrite). */
export const GAIN_EPSILON_DB = 0.01;

export interface MasteringOptions {
  /** Programme target, LUFS. Default −14. */
  readonly targetLufs?: number;
  /** Maximum allowed oversampled (true) peak, dBTP. Default −1. */
  readonly truePeakCeilingDbtp?: number;
  /** Safety margin kept below the ceiling, dB. Default 0.2. */
  readonly truePeakMarginDb?: number;
}

export type MasteringSkipReason =
  | "empty-input"
  | "silent-input"
  | "unmeasurable"
  | "already-on-target";

export interface MasteringReport {
  /** False when the input was passed through untouched. */
  readonly applied: boolean;
  /** Why `applied` is false (undefined when gain was applied). */
  readonly skippedReason?: MasteringSkipReason;
  readonly integratedBefore: number | null;
  readonly integratedAfter: number | null;
  readonly truePeakBefore: number | null;
  readonly truePeakAfter: number | null;
  /** Uniform gain applied to every sample, dB (0 when skipped). */
  readonly gainAppliedDb: number;
  /** True when the peak ceiling, not the loudness target, set the gain. */
  readonly peakLimited: boolean;
  readonly targetLufs: number;
  readonly truePeakCeilingDbtp: number;
}

export interface MasteringResult {
  /**
   * The gained channels — the SAME arrays passed in, mutated in place. The
   * export path owns freshly-rendered buffers it encodes immediately, so a
   * copy would double peak memory for nothing. Callers that need their input
   * preserved must pass copies.
   */
  readonly channels: Float32Array[];
  readonly report: MasteringReport;
}

/** Minimal structural AudioBuffer so tests can pass stand-ins. */
export interface MasterableAudioBuffer {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

function skipReport(
  reason: MasteringSkipReason,
  options: Required<Pick<MasteringOptions, "targetLufs" | "truePeakCeilingDbtp">>,
  measured?: {
    integratedBefore: number | null;
    truePeakBefore: number | null;
  },
): MasteringResult {
  const integratedBefore = measured?.integratedBefore ?? null;
  const truePeakBefore = measured?.truePeakBefore ?? null;
  return {
    channels: [],
    report: {
      applied: false,
      skippedReason: reason,
      integratedBefore,
      integratedAfter: integratedBefore,
      truePeakBefore,
      truePeakAfter: truePeakBefore,
      gainAppliedDb: 0,
      peakLimited: false,
      targetLufs: options.targetLufs,
      truePeakCeilingDbtp: options.truePeakCeilingDbtp,
    },
  };
}

/**
 * Master one programme: measure → choose one uniform gain → apply in place.
 * Never throws on degenerate input (empty/silent), never produces NaN gains.
 */
export function masterAudio(
  channels: Float32Array[],
  sampleRate: number,
  options: MasteringOptions = {},
): MasteringResult {
  const targetLufs = options.targetLufs ?? DEFAULT_TARGET_LUFS;
  const ceiling = options.truePeakCeilingDbtp ?? DEFAULT_TRUE_PEAK_CEILING_DBTP;
  const margin = options.truePeakMarginDb ?? DEFAULT_TRUE_PEAK_MARGIN_DB;
  const ceilingWithMargin = ceiling - margin;
  const opts = { targetLufs, truePeakCeilingDbtp: ceiling };

  if (channels.length === 0 || sampleRate <= 0) return skipReport("empty-input", opts);
  if (channels.some((ch) => ch.length === 0)) return skipReport("empty-input", opts);

  const measured = measureLoudness(channels, sampleRate);
  const integratedBefore = measured.integratedLufs;
  const truePeakBefore = measured.truePeakDbtp;

  // All-digital-silence (or sub-400 ms) programmes have no gated loudness —
  // there is nothing to normalize, and any gain would just be invented.
  if (integratedBefore === null) return skipReport("silent-input", opts, { integratedBefore, truePeakBefore });
  if (truePeakBefore === null || !Number.isFinite(integratedBefore) || !Number.isFinite(truePeakBefore)) {
    return skipReport("unmeasurable", opts, { integratedBefore, truePeakBefore });
  }

  const desiredGainDb = targetLufs - integratedBefore;
  const maxGainForPeakDb = ceilingWithMargin - truePeakBefore;
  const gainDb = Math.min(desiredGainDb, maxGainForPeakDb);

  if (!Number.isFinite(gainDb)) return skipReport("unmeasurable", opts, { integratedBefore, truePeakBefore });

  const peakLimited =
    maxGainForPeakDb < desiredGainDb - GAIN_EPSILON_DB && Math.abs(gainDb) >= GAIN_EPSILON_DB;

  if (Math.abs(gainDb) < GAIN_EPSILON_DB) {
    const integratedAfter = integratedBefore;
    return {
      channels,
      report: {
        applied: false,
        skippedReason: "already-on-target",
        integratedBefore,
        integratedAfter,
        truePeakBefore,
        truePeakAfter: truePeakBefore,
        gainAppliedDb: 0,
        peakLimited,
        targetLufs,
        truePeakCeilingDbtp: ceiling,
      },
    };
  }

  const gainLinear = Math.pow(10, gainDb / 20);
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] = ch[i] * gainLinear;
  }

  // Uniform gain is exact in the log domain: loudness and true peak shift by
  // exactly gainDb. Clamp the reported peak at the ceiling for honesty about
  // float rounding (the margin, not this clamp, is the real overshoot guard).
  const truePeakAfter = Math.min(truePeakBefore + gainDb, ceiling);
  const integratedAfter = integratedBefore + gainDb;

  return {
    channels,
    report: {
      applied: true,
      integratedBefore,
      integratedAfter,
      truePeakBefore,
      truePeakAfter,
      gainAppliedDb: gainDb,
      peakLimited,
      targetLufs,
      truePeakCeilingDbtp: ceiling,
    },
  };
}

/** Buffer-level convenience: extracts channels, masters, returns the report. */
export function masterAudioBuffer(
  buffer: MasterableAudioBuffer,
  options: MasteringOptions = {},
): MasteringReport {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return masterAudio(channels, buffer.sampleRate, options).report;
}

/** One-line human-readable summary for export logs. */
export function formatMasteringReport(prefix: string, report: MasteringReport): string {
  if (!report.applied) {
    return `${prefix} loudness: skipped (${report.skippedReason ?? "unknown"}) integrated=${
      report.integratedBefore === null ? "n/a" : `${report.integratedBefore.toFixed(1)} LUFS`
    } truePeak=${report.truePeakBefore === null ? "n/a" : `${report.truePeakBefore.toFixed(2)} dBTP`}`;
  }
  return (
    `${prefix} loudness: ${report.integratedBefore?.toFixed(1)} → ${report.integratedAfter?.toFixed(1)} LUFS ` +
    `(target ${report.targetLufs}), true peak ${report.truePeakBefore?.toFixed(2)} → ${report.truePeakAfter?.toFixed(2)} dBTP ` +
    `(ceiling ${report.truePeakCeilingDbtp}), gain ${report.gainAppliedDb >= 0 ? "+" : ""}${report.gainAppliedDb.toFixed(2)} dB` +
    `${report.peakLimited ? " [peak-limited: gain clamped to ceiling]" : ""}`
  );
}
