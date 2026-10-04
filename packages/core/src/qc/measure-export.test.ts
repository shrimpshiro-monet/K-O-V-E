import { describe, expect, it } from "vitest";
import {
  assembleMeasureReport,
  buildMeasureCommands,
  measureExportFile,
  parseBlackdetect,
  parseEbur128,
  parseFreezedetect,
  parseProbeDuration,
  parseSilencedetect,
  summarizeMeasureReport,
  type QcCommandRunner,
} from "./measure-export";

/**
 * All fixtures below are recorded shapes of real ffmpeg/ffprobe output
 * (stream headers elided). The sandbox has no ffmpeg binary, so the whole
 * pipeline is verified against these recordings; on a machine with ffmpeg,
 * `measureExportFile(nodeRunner, path)` exercises the identical parse path.
 */

const EBUR128_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'export.mp4':
  Duration: 00:00:15.08, start: 0.000000, bitrate: 8413 kb/s
[Parsed_ebur128_0 @ 0x55e2c9a0] t: 15.0649    TARGET:-16 LUFS    M: -12.1 S:-11.8     I: -11.0 LUFS    LRA:   1.1 LU
[Parsed_ebur128_0 @ 0x55e2c9a0] Summary:

  Integrated loudness:
    I:        -11.0 LUFS
    Threshold: -21.0 LUFS

  Loudness range:
    LRA:         1.1 dB
    Threshold: -31.0 LUFS
    LRA low:   -11.6 LUFS
    LRA high:  -10.5 LUFS

  True peak:
    Peak:        4.5 dBFS
`;

const BLACKDETECT_STDERR = `Input #0, mov,mp4 from 'export.mp4':
[blackdetect @ 0x55f1] black_start:0 black_end:1.2 black_duration:1.2
[blackdetect @ 0x55f1] black_start:9.75 black_end:10.1 black_duration:0.35
`;

const SILENCEDETECT_STDERR = `Input #0, mov,mp4 from 'export.mp4':
[silencedetect @ 0x55aa] silence_start: 2
[silencedetect @ 0x55aa] silence_end: 3.5 | silence_duration: 1.5
[silencedetect @ 0x55aa] silence_start: 14.2
`;

const FREEZEDETECT_STDERR = `Input #0, mov,mp4 from 'export.mp4':
[freezedetect @ 0x55bb] freeze_start: 4
[freezedetect @ 0x55bb] freeze_duration: 2.5
`;

const PROBE_STDOUT = JSON.stringify({
  format: {
    filename: "export.mp4",
    duration: "15.080000",
    size: "15800000",
    bit_rate: "8413214",
  },
});

describe("measure_export parsers (recorded ffmpeg output)", () => {
  it("parses the ebur128 summary: I, LRA and true peak", () => {
    expect(parseEbur128(EBUR128_STDERR)).toEqual({
      integrated: -11.0,
      lra: 1.1,
      truePeak: 4.5,
    });
  });

  it("parses ebur128 even when only stderr frames exist", () => {
    expect(parseEbur128("")).toEqual({
      integrated: null,
      lra: null,
      truePeak: null,
    });
  });

  it("parses blackdetect events", () => {
    expect(parseBlackdetect(BLACKDETECT_STDERR)).toEqual([
      { start: 0, end: 1.2, duration: 1.2 },
      { start: 9.75, end: 10.1, duration: 0.35 },
    ]);
  });

  it("pairs silencedetect start/end lines and keeps a dangling start open-ended", () => {
    expect(parseSilencedetect(SILENCEDETECT_STDERR)).toEqual([
      { start: 2, end: 3.5, duration: 1.5 },
      { start: 14.2, end: null, duration: null },
    ]);
  });

  it("pairs freezedetect start/duration lines", () => {
    expect(parseFreezedetect(FREEZEDETECT_STDERR)).toEqual([
      { start: 4, duration: 2.5 },
    ]);
  });

  it("reads the container duration from ffprobe JSON", () => {
    expect(parseProbeDuration(PROBE_STDOUT)).toBeCloseTo(15.08, 5);
    expect(parseProbeDuration("not json")).toBeNull();
  });

  it("builds the four QC commands + probe against the given path", () => {
    const commands = buildMeasureCommands("/tmp/export.mp4");
    expect(Object.keys(commands).sort()).toEqual([
      "blackFrames",
      "drift",
      "freezes",
      "loudness",
      "silences",
    ]);
    expect(commands.loudness.args).toContain("ebur128=peak=true");
    expect(commands.blackFrames.args.join(" ")).toContain("blackdetect");
    expect(commands.silences.args.join(" ")).toContain("silencedetect");
    expect(commands.freezes.args.join(" ")).toContain("freezedetect");
    expect(commands.drift.command).toBe("ffprobe");
    for (const spec of Object.values(commands)) {
      expect(spec.args).toContain("/tmp/export.mp4");
    }
  });
});

function fixtureRunner(): QcCommandRunner {
  return async (_command, args) => {
    const joined = args.join(" ");
    if (joined.includes("ebur128"))
      return { stdout: "", stderr: EBUR128_STDERR, exitCode: 0 };
    if (joined.includes("blackdetect"))
      return { stdout: "", stderr: BLACKDETECT_STDERR, exitCode: 0 };
    if (joined.includes("silencedetect"))
      return { stdout: "", stderr: SILENCEDETECT_STDERR, exitCode: 0 };
    if (joined.includes("freezedetect"))
      return { stdout: "", stderr: FREEZEDETECT_STDERR, exitCode: 0 };
    if (_command === "ffprobe")
      return { stdout: PROBE_STDOUT, stderr: "", exitCode: 0 };
    throw new Error(`unexpected command: ${_command}`);
  };
}

describe("measureExportFile (fixture runner)", () => {
  it("assembles the full report and judges it against long-form targets", async () => {
    const report = await measureExportFile(fixtureRunner(), "export.mp4", {
      expectedDurationSec: 15.08,
    });

    expect(report.loudness.integrated).toBe(-11.0);
    expect(report.loudness.truePeak).toBe(4.5);
    expect(report.blackFrames).toHaveLength(2);
    expect(report.silences).toHaveLength(2);
    expect(report.freezes).toHaveLength(1);
    expect(report.drift.driftSec).toBeCloseTo(0, 5);

    // The Serene_Athles-shaped export: way hot, clipping, artifacts present.
    expect(report.verdicts.loudnessOk).toBe(false); // −11 vs −16 ±1
    expect(report.verdicts.truePeakOk).toBe(false); // +4.5 vs ≤ −1
    expect(report.verdicts.durationOk).toBe(true);
    expect(report.verdicts.clean).toBe(false);
    expect(report.errors).toEqual({});

    const summary = summarizeMeasureReport(report);
    expect(summary).toContain("I=-11.0 LUFS (OFF TARGET)");
    expect(summary).toContain("TP=4.5 dBTP (CLIPPING)");
    expect(summary).toContain("black=2");
  });

  it("flags a compliant long-form export as passing", async () => {
    const compliant = EBUR128_STDERR.replace(
      "I:        -11.0 LUFS",
      "I:        -15.8 LUFS",
    ).replace("Peak:        4.5 dBFS", "Peak:        -1.6 dBFS");
    const runner: QcCommandRunner = async (_command, args) => {
      const joined = args.join(" ");
      if (joined.includes("ebur128"))
        return { stdout: "", stderr: compliant, exitCode: 0 };
      if (joined.includes("blackdetect") || joined.includes("freezedetect"))
        return { stdout: "", stderr: "", exitCode: 0 };
      if (joined.includes("silencedetect"))
        return { stdout: "", stderr: "[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.5\n", exitCode: 0 };
      return { stdout: PROBE_STDOUT, stderr: "", exitCode: 0 };
    };

    const report = await measureExportFile(runner, "export.mp4", {
      expectedDurationSec: 15.08,
    });
    expect(report.verdicts.loudnessOk).toBe(true);
    expect(report.verdicts.truePeakOk).toBe(true);
    expect(report.verdicts.durationOk).toBe(true);
    expect(report.verdicts.clean).toBe(false); // one lead-in silence remains
  });

  it("records per-command failures without aborting the rest", async () => {
    const runner: QcCommandRunner = async (command, args) => {
      const joined = args.join(" ");
      if (joined.includes("freezedetect")) {
        throw new Error("spawn ffmpeg ENOENT");
      }
      if (joined.includes("ebur128"))
        return { stdout: "", stderr: EBUR128_STDERR, exitCode: 0 };
      if (command === "ffprobe")
        return { stdout: PROBE_STDOUT, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const report = await measureExportFile(runner, "export.mp4", {
      expectedDurationSec: 15.08,
    });
    expect(report.errors.freezes).toContain("ENOENT");
    expect(report.loudness.integrated).toBe(-11.0); // other sections intact
    expect(report.freezes).toEqual([]);
  });

  it("leaves verdicts null (never false) when a measurement is missing", () => {
    const report = assembleMeasureReport({ path: "x.mp4" });
    expect(report.verdicts.loudnessOk).toBeNull();
    expect(report.verdicts.truePeakOk).toBeNull();
    expect(report.verdicts.durationOk).toBeNull();
    expect(report.verdicts.clean).toBe(true);
  });
});
