import { describe, expect, it } from "vitest";
import { measureLoudness } from "./meter";
import {
  DEFAULT_TARGET_LUFS,
  DEFAULT_TRUE_PEAK_CEILING_DBTP,
  formatMasteringReport,
  masterAudio,
  masterAudioBuffer,
  type MasterableAudioBuffer,
} from "./loudness-master";
import { FS, concat, dbToLin, sine } from "./loudness.test-signals";

/** Full-scale 1 kHz MONO sine — the BS.1770 anchor (−3.01 LUFS). Stereo
 * in-phase would sit 3.01 dB above that (≈0 LUFS); the repo's committed EBU
 * suite pins both relationships. */
function fullScaleMonoSine(seconds: number): Float32Array[] {
  return [Float32Array.from(sine(seconds, 1000, 1))];
}

/** Digital silence as Float32Array channels (masterAudio's input type). */
function silenceStereo(seconds: number): Float32Array[] {
  const n = Math.round(seconds * FS);
  return [new Float32Array(n), new Float32Array(n)];
}

/**
 * Low-level programme with one short full-scale hit: ≈−17 LUFS integrated,
 * ≈0 dBTP true peak — a crest of ~17 dB, far beyond the 12.8 dB crest at
 * which the −14 LUFS target demands more gain than the −1 dBTP ceiling allows.
 */
function hotPeakySignal(): Float32Array[] {
  const mono = concat(sine(20, 1000, dbToLin(-24)), sine(0.2, 1000, 1));
  return [Float32Array.from(mono), Float32Array.from(mono)];
}



function measure(channels: Float32Array[]): ReturnType<typeof measureLoudness> {
  return measureLoudness(channels, FS);
}

describe("masterAudio", () => {
  it("brings a full-scale mono sine from ≈−3 LUFS to the −14 LUFS target", () => {
    const channels = fullScaleMonoSine(10);
    const before = measure(channels);
    expect(before.integratedLufs).toBeCloseTo(-3.01, 1); // BS.1770 anchor

    const { report } = masterAudio(channels, FS);
    expect(report.applied).toBe(true);
    expect(report.peakLimited).toBe(false);
    expect(report.integratedBefore).toBeCloseTo(-3.01, 1);
    expect(report.integratedAfter).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
    expect(report.gainAppliedDb).toBeCloseTo(DEFAULT_TARGET_LUFS - -3.01, 1);

    // Post-check with the actual meter, not just the analytic shift.
    const after = measure(channels);
    expect(after.integratedLufs).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
    expect(after.truePeakDbtp!).toBeLessThanOrEqual(DEFAULT_TRUE_PEAK_CEILING_DBTP);
  });

  it("leaves a programme already on target AND under the ceiling untouched", () => {
    // −11 dBFS mono sine ≈ −14 LUFS with an ≈−11 dBTP peak: nothing to do.
    const level = dbToLin(-11.01);
    const channels = [Float32Array.from(sine(10, 1000, level)), Float32Array.from(sine(10, 1000, level))];
    const { report } = masterAudio(channels, FS, { targetLufs: measure(channels).integratedLufs! });
    expect(report.applied).toBe(false);
    expect(report.skippedReason).toBe("already-on-target");
    expect(report.peakLimited).toBe(false);
    expect(report.gainAppliedDb).toBe(0);
  });

  it("still enforces the ceiling on a programme that is on target but hot", () => {
    // Full-scale mono sine at −3 LUFS with target set to −3: loudness is done,
    // but the 0 dBTP peak violates the −1 dBTP ceiling — pull it down.
    const channels = fullScaleMonoSine(10);
    const measured = measure(channels).integratedLufs!;
    const { report } = masterAudio(channels, FS, { targetLufs: measured });
    expect(report.applied).toBe(true);
    expect(report.peakLimited).toBe(true);
    expect(report.truePeakAfter!).toBeCloseTo(DEFAULT_TRUE_PEAK_CEILING_DBTP - 0.2, 3);
  });

  it("clamps gain at the true-peak ceiling for hot, peaky material", () => {
    const channels = hotPeakySignal();
    const before = measure(channels);
    // Sanity: hot at the peak, quiet as a programme…
    expect(before.truePeakDbtp!).toBeGreaterThan(-3);
    // …so the −14 target demands MORE gain than the peak allows.
    const desiredGain = DEFAULT_TARGET_LUFS - before.integratedLufs!;
    const maxGain = DEFAULT_TRUE_PEAK_CEILING_DBTP - 0.2 - before.truePeakDbtp!;
    expect(desiredGain).toBeGreaterThan(maxGain); // precondition for the clamp

    const { report } = masterAudio(channels, FS);
    expect(report.applied).toBe(true);
    expect(report.peakLimited).toBe(true);
    expect(report.gainAppliedDb).toBeCloseTo(maxGain, 3);
    expect(report.truePeakAfter!).toBeCloseTo(DEFAULT_TRUE_PEAK_CEILING_DBTP - 0.2, 3);
    // Peak-limited gain can leave loudness below target — the honest
    // invariant is the exact log-domain shift, not "louder".
    expect(report.integratedAfter!).toBeCloseTo(before.integratedLufs! + report.gainAppliedDb, 3);

    const after = measure(channels);
    expect(after.truePeakDbtp!).toBeLessThanOrEqual(DEFAULT_TRUE_PEAK_CEILING_DBTP);
  });

  it("gains quiet material up to the target without touching the peak ceiling", () => {
    const channels = [Float32Array.from(sine(10, 1000, dbToLin(-30))), Float32Array.from(sine(10, 1000, dbToLin(-30)))];
    const { report } = masterAudio(channels, FS);
    expect(report.applied).toBe(true);
    expect(report.peakLimited).toBe(false);
    expect(measure(channels).integratedLufs).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
  });

  it("passes digital silence through unchanged with a finite report", () => {
    const channels = silenceStereo(2);
    const before = Float32Array.from(channels[0]!);
    const { report } = masterAudio(channels, FS);
    expect(report.applied).toBe(false);
    expect(report.skippedReason).toBe("silent-input");
    expect(report.gainAppliedDb).toBe(0);
    expect(Array.from(channels[0]!)).toEqual(Array.from(before));
    for (const value of Object.values(report)) {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("passes empty and degenerate input through without throwing", () => {
    expect(() => masterAudio([], FS)).not.toThrow();
    expect(masterAudio([], FS).report.skippedReason).toBe("empty-input");
    expect(masterAudio([new Float32Array(0), new Float32Array(0)], FS).report.applied).toBe(false);
  });

  it("masters mono programmes", () => {
    const channels = [Float32Array.from(sine(10, 1000, 1))];
    const { report } = masterAudio(channels, FS);
    expect(report.applied).toBe(true);
    expect(measure(channels).integratedLufs).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
  });

  it("honours explicit targets and ceilings", () => {
    const channels = fullScaleMonoSine(10);
    const { report } = masterAudio(channels, FS, { targetLufs: -16, truePeakCeilingDbtp: -2 });
    expect(report.targetLufs).toBe(-16);
    expect(report.truePeakCeilingDbtp).toBe(-2);
    expect(report.integratedAfter).toBeCloseTo(-16, 1);
    expect(report.truePeakAfter!).toBeLessThanOrEqual(-2);
  });

  it("never emits NaN in the report", () => {
    for (const report of [
      masterAudio([], FS).report,
      masterAudio(silenceStereo(1), FS).report,
      masterAudio(fullScaleMonoSine(10), FS).report,
      masterAudio(hotPeakySignal(), FS).report,
    ]) {
      for (const [key, value] of Object.entries(report)) {
        if (typeof value === "number") expect(Number.isNaN(value), key).toBe(false);
      }
    }
  });
});

describe("masterAudioBuffer", () => {
  function fakeBuffer(channels: Float32Array[], sampleRate = FS): MasterableAudioBuffer {
    return {
      sampleRate,
      numberOfChannels: channels.length,
      length: channels[0]?.length ?? 0,
      getChannelData: (c: number) => channels[c]!,
    };
  }

  it("masters through the AudioBuffer surface", () => {
    const channels = fullScaleMonoSine(10);
    const report = masterAudioBuffer(fakeBuffer(channels));
    expect(report.applied).toBe(true);
    expect(measure(channels).integratedLufs).toBeCloseTo(DEFAULT_TARGET_LUFS, 1);
  });
});

describe("formatMasteringReport", () => {
  it("summarizes applied and skipped runs in one line each", () => {
    const applied = formatMasteringReport("[export]", masterAudio(fullScaleMonoSine(10), FS).report);
    expect(applied).toContain("→ -14.0 LUFS");
    const skipped = formatMasteringReport("[export]", masterAudio(silenceStereo(1), FS).report);
    expect(skipped).toContain("skipped (silent-input)");
  });
});
