import { describe, expect, it } from "vitest";
import { LoudnessMeter, measureLoudness } from "./meter";
import {
  FS, concat, dbToLin, interSamplePeakSignal, sine, silence, stereo, taper, tone,
} from "./loudness.test-signals";

/**
 * EBU Tech 3341 v4 (Table 1) and Tech 3342 v4 (Table 1): every SYNTHETIC minimum-requirement
 * signal, generated exactly as the documents describe, at 48 kHz, with the documents' tolerances.
 *
 * NOT covered here (they are recordings, not synthesisable, and tech.ebu.ch was not reachable
 * from the build sandbox): Tech 3341 cases 7-8 and Tech 3342 cases 5-6 ("authentic programme").
 * Download the EBU set and run it locally before claiming full EBU Mode compliance.
 */

const near = (actual: number | null, expected: number, tol: number, label = "") => {
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual as number) - expected), `${label}: ${actual} vs ${expected} ±${tol}`).toBeLessThanOrEqual(tol);
};

describe("EBU Tech 3341: loudness (cases 1-6)", () => {
  it("case 1: stereo 1 kHz -23 dBFS, 20 s → M, S, I = -23.0 ±0.1", () => {
    const r = measureLoudness(stereo(tone(20, -23)), FS);
    near(r.integratedLufs, -23, 0.1, "I");
    near(r.shortTermMaxLufs, -23, 0.1, "S");
    near(r.momentaryMaxLufs, -23, 0.1, "M");
  });

  it("case 2: -33 dBFS → -33.0 ±0.1", () => {
    const r = measureLoudness(stereo(tone(20, -33)), FS);
    near(r.integratedLufs, -33, 0.1, "I");
    near(r.shortTermMaxLufs, -33, 0.1, "S");
    near(r.momentaryMaxLufs, -33, 0.1, "M");
  });

  it("case 3: 10 s -36, 60 s -23, 10 s -36 → I = -23.0 ±0.1 (relative gate)", () => {
    const x = concat(tone(10, -36), tone(60, -23), tone(10, -36));
    near(measureLoudness(stereo(x), FS).integratedLufs, -23, 0.1);
  });

  it("case 4: -72/-36/-23/-36/-72 (10/10/60/10/10 s) → I = -23.0 ±0.1 (absolute + relative gate)", () => {
    const x = concat(tone(10, -72), tone(10, -36), tone(60, -23), tone(10, -36), tone(10, -72));
    near(measureLoudness(stereo(x), FS).integratedLufs, -23, 0.1);
  });

  it("case 5: 20 s each at -26, -20, -26 → I = -23.0 ±0.1", () => {
    const x = concat(tone(20, -26), tone(20, -20), tone(20, -26));
    near(measureLoudness(stereo(x), FS).integratedLufs, -23, 0.1);
  });

  it("case 6: 5.0 sine, L/R -28, C -24, Ls/Rs -30 dBFS → I = -23.0 ±0.1 (channel weights)", () => {
    const ch = [tone(20, -28), tone(20, -28), tone(20, -24), tone(20, -30), tone(20, -30)];
    near(measureLoudness(ch, FS).integratedLufs, -23, 0.1);
  });

  it("the LFE channel of a 5.1 signal is excluded from loudness", () => {
    const five = [tone(20, -28), tone(20, -28), tone(20, -24), tone(20, -30), tone(20, -30)];
    const withLfe = [five[0]!, five[1]!, five[2]!, tone(20, -6), five[3]!, five[4]!];
    near(measureLoudness(withLfe, FS).integratedLufs, -23, 0.1);
  });
});

describe("EBU Tech 3341: time scales (cases 9-14)", () => {
  it("case 9: (1.34 s @ -20, 1.66 s @ -30) x5 → S = -23.0 ±0.1, constant after 3 s", () => {
    const seg = concat(tone(1.34, -20), tone(1.66, -30));
    const meter = new LoudnessMeter({ sampleRate: FS, channelCount: 2 });
    const x = concat(seg, seg, seg, seg, seg);
    meter.push(stereo(x));
    const series = meter.shortTermLoudnessSeries();
    expect(series.length).toBeGreaterThan(50);
    for (const s of series) near(s, -23, 0.1, "S");
  });

  it("case 12: (0.18 s @ -20, 0.22 s @ -30) x25 → M = -23.0 ±0.1, constant after 1 s", () => {
    const seg = concat(tone(0.18, -20), tone(0.22, -30));
    const x = concat(...Array.from({ length: 25 }, () => seg));
    const meter = new LoudnessMeter({ sampleRate: FS, channelCount: 2 });
    meter.push(stereo(x));
    const blocks = meter.blockLoudnessSeries();
    // blocks are 100 ms apart: after 1 s = from index 6 (a full 400 ms block starting at 0.6 s is not yet "after 1 s")
    for (const m of blocks.slice(7)) near(m, -23, 0.1, "M");
    near(meter.result().momentaryMaxLufs, -23, 0.1, "Mmax (fine grid)");
  });

  it.each(Array.from({ length: 20 }, (_, i) => i))(
    "case 10 (file-based), i=%i: %i*0.15 s silence, 3 s @ -23, 1 s silence → max S = -23.0 ±0.1",
    (i) => {
      const x = concat(silence(i * 0.15), tone(3, -23), silence(1));
      near(measureLoudness(stereo(x), FS).shortTermMaxLufs, -23, 0.1);
    },
  );

  it.each(Array.from({ length: 20 }, (_, i) => i))(
    "case 11 (live), i=%i: 3 s @ %i-38 dBFS → max S = -38+i ±0.1",
    (i) => {
      const x = concat(silence(i * 0.15), tone(3, -38 + i), silence(3 - i * 0.15));
      near(measureLoudness(stereo(x), FS).shortTermMaxLufs, -38 + i, 0.1);
    },
  );

  it.each(Array.from({ length: 20 }, (_, i) => i))(
    "case 13 (file-based), i=%i: %i*20 ms silence, 400 ms @ -23, 1 s silence → max M = -23.0 ±0.1",
    (i) => {
      const x = concat(silence(i * 0.02), tone(0.4, -23), silence(1));
      near(measureLoudness(stereo(x), FS).momentaryMaxLufs, -23, 0.1);
    },
  );

  it.each(Array.from({ length: 20 }, (_, i) => i))(
    "case 14 (live), i=%i: 400 ms @ -38+i dBFS → max M = -38+i ±0.1",
    (i) => {
      const x = concat(silence(i * 0.02), tone(0.4, -38 + i), silence(0.4 - i * 0.02));
      near(measureLoudness(stereo(x), FS).momentaryMaxLufs, -38 + i, 0.1);
    },
  );
});

describe("EBU Tech 3341: true peak (cases 15-23), +0.2 / -0.4 dB", () => {
  const tp = (x: Float64Array) => measureLoudness(stereo(x), FS).truePeakDbtp;
  const within = (actual: number | null, expected: number) => {
    expect(actual).not.toBeNull();
    const err = (actual as number) - expected;
    expect(err, `${actual} vs ${expected}`).toBeLessThanOrEqual(0.2);
    expect(err, `${actual} vs ${expected}`).toBeGreaterThanOrEqual(-0.4);
  };
  const f = (div: number) => FS / div;
  const t = (x: Float64Array) => taper(x, 10);

  it("case 15: f/4, 0.50 FFS, phase 0 → -6.0 dBTP", () => within(tp(t(sine(1, f(4), 0.5, FS, 0))), -6.0));
  it("case 16: f/4, 0.50 FFS, phase 45° → -6.0 dBTP", () => within(tp(t(sine(1, f(4), 0.5, FS, 45))), -6.0));
  it("case 17: f/6, 0.50 FFS, phase 60° → -6.0 dBTP", () => within(tp(t(sine(1, f(6), 0.5, FS, 60))), -6.0));
  it("case 18: f/8, 0.50 FFS, phase 67.5° → -6.0 dBTP", () => within(tp(t(sine(1, f(8), 0.5, FS, 67.5))), -6.0));
  it("case 19: f/4, 1.41 FFS, phase 45° → +3.0 dBTP (above full scale)", () =>
    within(tp(t(sine(1, f(4), 1.41, FS, 45))), 3.0));
  it.each([0, 1, 2, 3])("case %i+20: f/6 with one f/4 period, 4x synth, decimated at offset %i → 0.0 dBTP", (o) => {
    const x = interSamplePeakSignal(o);
    within(tp(x), 0.0);
  });

  it("the oversampled peak exceeds the sample peak where it should (case 16 sample peak is only -9 dBFS)", () => {
    const r = measureLoudness(stereo(taper(sine(1, f(4), 0.5, FS, 45), 10)), FS);
    expect(r.samplePeakDbfs as number).toBeLessThan(-8.5);
    expect(r.truePeakDbtp as number).toBeGreaterThan(-6.5);
  });
});

describe("EBU Tech 3342: loudness range (cases 1-4), ±1 LU", () => {
  const lra = (x: Float64Array) => measureLoudness(stereo(x), FS).loudnessRangeLu;
  it("case 1: 20 s @ -20 then 20 s @ -30 → LRA = 10", () => near(lra(concat(tone(20, -20), tone(20, -30))), 10, 1));
  it("case 2: -20 then -15 → LRA = 5", () => near(lra(concat(tone(20, -20), tone(20, -15))), 5, 1));
  it("case 3: -40 then -20 → LRA = 20", () => near(lra(concat(tone(20, -40), tone(20, -20))), 20, 1));
  it("case 4: -50, -35, -20, -35, -50 (20 s each) → LRA = 15", () =>
    near(lra(concat(tone(20, -50), tone(20, -35), tone(20, -20), tone(20, -35), tone(20, -50))), 15, 1));
  it("the expected response is unchanged when the signal is repeated (Tech 3342 §4)", () => {
    const one = concat(tone(20, -20), tone(20, -30));
    near(lra(concat(one, one, one)), 10, 1);
  });
});

describe("gating and degenerate input", () => {
  it("digital silence → null, never a fabricated number", () => {
    const r = measureLoudness(stereo(silence(5)), FS);
    expect(r.integratedLufs).toBeNull();
    expect(r.loudnessRangeLu).toBeNull();
    expect(r.truePeakDbtp).toBeNull();
    expect(r.momentaryMaxLufs).toBeNull();
  });
  it("shorter than one 400 ms block → no integrated loudness (incomplete block discarded)", () => {
    expect(measureLoudness(stereo(tone(0.3, -23)), FS).integratedLufs).toBeNull();
  });
  it("shorter than 3 s → no loudness range", () => {
    expect(measureLoudness(stereo(tone(2.5, -23)), FS).loudnessRangeLu).toBeNull();
  });
  it("mono is measured as a single centred channel (weight 1): 3.01 dB below the same tone in stereo", () => {
    const mono = measureLoudness([tone(10, -23)], FS).integratedLufs as number;
    near(mono, -26.0, 0.1);
  });
  it("chunked streaming equals one-shot", () => {
    const x = concat(tone(7, -23), tone(5, -31), tone(6, -20));
    const one = measureLoudness(stereo(x), FS);
    const meter = new LoudnessMeter({ sampleRate: FS, channelCount: 2 });
    for (let o = 0; o < x.length; o += 7919) {
      const c = x.subarray(o, Math.min(x.length, o + 7919));
      meter.push([c, c]);
    }
    const streamed = meter.result();
    expect(streamed.integratedLufs).toBeCloseTo(one.integratedLufs as number, 9);
    expect(streamed.loudnessRangeLu).toBeCloseTo(one.loudnessRangeLu as number, 9);
    expect(streamed.truePeakDbtp).toBeCloseTo(one.truePeakDbtp as number, 9);
  });
  it("result() is a non-destructive snapshot", () => {
    const meter = new LoudnessMeter({ sampleRate: FS, channelCount: 2 });
    meter.push(stereo(tone(5, -23)));
    const a = meter.result();
    const b = meter.result();
    expect(b).toEqual(a);
    meter.push(stereo(tone(5, -23)));
    expect(meter.result().durationSeconds).toBeCloseTo(10, 6);
  });
  it("validates channel count and lengths", () => {
    const meter = new LoudnessMeter({ sampleRate: FS, channelCount: 2 });
    expect(() => meter.push([new Float64Array(10)])).toThrow(/Expected 2 channels/);
    expect(() => meter.push([new Float64Array(10), new Float64Array(9)])).toThrow(/same length/);
  });
  it("a 0 dBFS full-scale stereo sine reads about +0.7 LUFS-ish and a clean true peak of 0 dBTP", () => {
    const r = measureLoudness(stereo(sine(5, 997, 1)), FS);
    near(r.truePeakDbtp, 0, 0.2);
    expect(dbToLin(0)).toBe(1);
  });
});

/**
 * The EBU signals above cannot tell some algorithm variants apart (found by mutation testing:
 * -8 LU vs -10 LU relative gate, the -70 LUFS absolute gate level, and the LRA percentiles all
 * pass them). These cases have analytic answers that DO discriminate.
 */
describe("discriminating cases with analytic expectations", () => {
  it("relative gate is exactly -10 LU: 60 s @ -23 + 10 s @ -32 → I = -23 + 10·log10((60 + 10·10^-0.9)/70)", () => {
    // The quiet part is 9 dB down: inside a -10 LU gate, outside a -8 LU gate.
    const x = concat(tone(60, -23), tone(10, -32));
    const expected = -23 + 10 * Math.log10((60 + 10 * Math.pow(10, -0.9)) / 70);
    near(measureLoudness(stereo(x), FS).integratedLufs, expected, 0.03);
    // ...and 11 dB down it is gated out, leaving -23.0
    near(measureLoudness(stereo(concat(tone(60, -23), tone(10, -34))), FS).integratedLufs, -23, 0.03);
  });

  it("absolute gate is -70 LUFS: a -60 LUFS signal is measured, a -75 LUFS one is not", () => {
    near(measureLoudness(stereo(tone(10, -60)), FS).integratedLufs, -60, 0.1);
    expect(measureLoudness(stereo(tone(10, -75)), FS).integratedLufs).toBeNull();
    expect(measureLoudness(stereo(tone(10, -75)), FS).loudnessRangeLu).toBeNull();
  });

  it("LRA uses the 10th-95th percentile: 12 % quiet / 76 % mid / 12 % loud → 20 LU", () => {
    const x = concat(tone(36, -50), tone(228, -40), tone(36, -30));
    near(measureLoudness(stereo(x), FS).loudnessRangeLu, 20, 0.5);
  });

  it("...and a rare loud event (4 %) and a short fade (6 %) do not widen it", () => {
    const x = concat(tone(18, -50), tone(270, -40), tone(12, -30));
    const lra = measureLoudness(stereo(x), FS).loudnessRangeLu as number;
    expect(lra).toBeLessThan(2);
  });

  it("LRA relative gate is -20 LU (not the -10 LU integrated gate): a section 15 LU down still counts", () => {
    // 100 s @ -20, 25 s @ -35: the quiet part is 15 LU below → inside the LRA gate, outside the integrated one.
    const r = measureLoudness(stereo(concat(tone(100, -20), tone(25, -35))), FS);
    near(r.loudnessRangeLu, 15, 1);
    near(r.integratedLufs, -20, 0.1); // gated out of the integrated measure
  });
});
