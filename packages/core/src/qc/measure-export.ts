/**
 * measure_export — post-export QC as four callable ffmpeg checks + ffprobe.
 *
 * Everything here is PURE: command construction, output parsing, and report
 * assembly take plain strings/objects, so the whole pipeline is testable
 * against recorded ffmpeg/ffprobe output (the sandbox where this was written
 * has no ffmpeg binary). Hosts provide only a tiny command runner.
 *
 * The four QC commands:
 *   1. loudness + true peak   → `ebur128=peak=true`
 *   2. black frame detection  → `blackdetect`
 *   3. silence detection      → `silencedetect`
 *   4. freeze detection       → `freezedetect`
 * plus `ffprobe -show_format` for container duration vs. the expected
 * timeline duration (drift).
 */

export interface QcCommand {
  /** Executable name, e.g. "ffmpeg" or "ffprobe". */
  readonly command: string;
  /** Argument vector (path already interpolated). */
  readonly args: readonly string[];
}

export type QcCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

export interface LoudnessResult {
  /** Integrated loudness in LUFS. */
  readonly integrated: number | null;
  /** Loudness range in dB. */
  readonly lra: number | null;
  /** True peak in dBFS. */
  readonly truePeak: number | null;
}

export interface BlackDetectEvent {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export interface SilenceDetectEvent {
  readonly start: number;
  readonly end: number | null;
  readonly duration: number | null;
}

export interface FreezeDetectEvent {
  readonly start: number;
  readonly duration: number | null;
}

export interface StreamDrift {
  /** Container duration reported by ffprobe, seconds. */
  readonly containerDurationSec: number | null;
  /** Expected timeline duration, when provided. */
  readonly expectedDurationSec: number | null;
  /** container − expected, seconds (null when either side is unknown). */
  readonly driftSec: number | null;
}

export interface QcVerdicts {
  /** Integrated loudness inside [target − tolerance, target + tolerance]. */
  readonly loudnessOk: boolean | null;
  /** True peak at or below the ceiling. */
  readonly truePeakOk: boolean | null;
  /** Container duration within the drift tolerance of the expected value. */
  readonly durationOk: boolean | null;
  /** No black/silence/freeze events found. */
  readonly clean: boolean;
}

export interface ExportMeasureReport {
  readonly path: string;
  readonly loudness: LoudnessResult;
  readonly blackFrames: readonly BlackDetectEvent[];
  readonly silences: readonly SilenceDetectEvent[];
  readonly freezes: readonly FreezeDetectEvent[];
  readonly drift: StreamDrift;
  readonly verdicts: QcVerdicts;
  /** Per-command failures (missing binary, unreadable file…) — never thrown away. */
  readonly errors: Readonly<Record<string, string>>;
}

export interface MeasureTargets {
  /** Target integrated loudness, LUFS. Long-form defaults to −16. */
  readonly integratedLufs: number;
  /** Acceptable deviation from the target, LU. */
  readonly loudnessToleranceLu: number;
  /** True-peak ceiling, dBTP. */
  readonly truePeakDbtp: number;
  /** Max allowed |container − expected| duration difference, seconds. */
  readonly driftToleranceSec: number;
}

export const DEFAULT_MEASURE_TARGETS: MeasureTargets = {
  integratedLufs: -16,
  loudnessToleranceLu: 1,
  truePeakDbtp: -1,
  driftToleranceSec: 0.1,
};

// ---- Command construction ---------------------------------------------------

/** Loudness + true peak (EBU R128 with true-peak measurement). */
export function loudnessCommand(path: string): QcCommand {
  return {
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
  };
}

/** Black-frame detection (≥0.25s runs at ≥98% picture threshold). */
export function blackdetectCommand(path: string): QcCommand {
  return {
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-vf",
      "blackdetect=d=0.25:pic_th=0.98",
      "-an",
      "-f",
      "null",
      "-",
    ],
  };
}

/** Silence detection (below −50 dBFS for ≥0.5s). */
export function silencedetectCommand(path: string): QcCommand {
  return {
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-af",
      "silencedetect=n=-50dB:d=0.5",
      "-f",
      "null",
      "-",
    ],
  };
}

/** Freeze detection (noise-tolerant, runs ≥1s). */
export function freezedetectCommand(path: string): QcCommand {
  return {
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      path,
      "-vf",
      "freezedetect=n=0.003:d=1",
      "-an",
      "-f",
      "null",
      "-",
    ],
  };
}

/** Container format probe (source of the duration for drift checks). */
export function probeCommand(path: string): QcCommand {
  return {
    command: "ffprobe",
    args: ["-v", "error", "-print_format", "json", "-show_format", path],
  };
}

/** All five commands, keyed by report section. */
export function buildMeasureCommands(path: string): Readonly<Record<string, QcCommand>> {
  return {
    loudness: loudnessCommand(path),
    blackFrames: blackdetectCommand(path),
    silences: silencedetectCommand(path),
    freezes: freezedetectCommand(path),
    drift: probeCommand(path),
  };
}

// ---- Parsers ----------------------------------------------------------------

function findNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses the "Summary:" block ffmpeg prints when the ebur128 filter exits.
 * Handles the standard layout:
 *   Integrated loudness:  I: -11.0 LUFS / Threshold: ...
 *   Loudness range:       LRA: 1.1 dB / ...
 *   True peak:            Peak: 4.5 dBFS
 */
export function parseEbur128(stderr: string): LoudnessResult {
  const summaryIndex = stderr.lastIndexOf("Summary:");
  const summary = summaryIndex >= 0 ? stderr.slice(summaryIndex) : stderr;
  return {
    integrated: findNumber(summary, /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i),
    lra: findNumber(summary, /\bLRA:\s*(-?\d+(?:\.\d+)?)\s*dB/i),
    truePeak: findNumber(summary, /\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/i),
  };
}

/** Parses `[blackdetect @ …] black_start:X black_end:Y black_duration:Z` lines. */
export function parseBlackdetect(stderr: string): BlackDetectEvent[] {
  const events: BlackDetectEvent[] = [];
  for (const line of stderr.split("\n")) {
    const match = /blackdetect[^\]]*\]\s*black_start:(\d+(?:\.\d+)?)\s+black_end:(\d+(?:\.\d+)?)\s+black_duration:(\d+(?:\.\d+)?)/.exec(
      line,
    );
    if (!match) continue;
    events.push({
      start: Number.parseFloat(match[1]),
      end: Number.parseFloat(match[2]),
      duration: Number.parseFloat(match[3]),
    });
  }
  return events;
}

/**
 * Parses silencedetect pairs:
 *   `[silencedetect @ …] silence_start: 2.0`
 *   `[silencedetect @ …] silence_end: 3.5 | silence_duration: 1.5`
 * A start without an end (silence runs to EOF) is reported with end/duration null.
 */
export function parseSilencedetect(stderr: string): SilenceDetectEvent[] {
  const events: SilenceDetectEvent[] = [];
  let open: { start: number } | null = null;
  for (const line of stderr.split("\n")) {
    const start = /silencedetect[^\]]*\]\s*silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      if (open) events.push({ start: open.start, end: null, duration: null });
      open = { start: Number.parseFloat(start[1]) };
      continue;
    }
    const end = /silencedetect[^\]]*\]\s*silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(-?\d+(?:\.\d+)?)/.exec(
      line,
    );
    if (end && open) {
      events.push({
        start: open.start,
        end: Number.parseFloat(end[1]),
        duration: Number.parseFloat(end[2]),
      });
      open = null;
    }
  }
  if (open) events.push({ start: open.start, end: null, duration: null });
  return events;
}

/**
 * Parses freezedetect pairs:
 *   `[freezedetect @ …] freeze_start: 4`
 *   `[freezedetect @ …] freeze_duration: 2.5`
 */
export function parseFreezedetect(stderr: string): FreezeDetectEvent[] {
  const events: FreezeDetectEvent[] = [];
  let open: { start: number } | null = null;
  for (const line of stderr.split("\n")) {
    const start = /freezedetect[^\]]*\]\s*freeze_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      if (open) events.push({ start: open.start, duration: null });
      open = { start: Number.parseFloat(start[1]) };
      continue;
    }
    const duration = /freezedetect[^\]]*\]\s*freeze_duration:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (duration && open) {
      events.push({ start: open.start, duration: Number.parseFloat(duration[1]) });
      open = null;
    }
  }
  if (open) events.push({ start: open.start, duration: null });
  return events;
}

/** Container duration (seconds) from `ffprobe -show_format` JSON. */
export function parseProbeDuration(stdout: string): number | null {
  try {
    const probe = JSON.parse(stdout) as {
      format?: { duration?: string | number };
    };
    const raw = probe.format?.duration;
    if (raw === undefined) return null;
    const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- Assembly ---------------------------------------------------------------

/** Combines parsed sections into the report, judging them against targets. */
export function assembleMeasureReport(input: {
  path: string;
  expectedDurationSec?: number | null;
  loudness?: LoudnessResult;
  blackFrames?: readonly BlackDetectEvent[];
  silences?: readonly SilenceDetectEvent[];
  freezes?: readonly FreezeDetectEvent[];
  containerDurationSec?: number | null;
  errors?: Readonly<Record<string, string>>;
  targets?: Partial<MeasureTargets>;
}): ExportMeasureReport {
  const targets: MeasureTargets = { ...DEFAULT_MEASURE_TARGETS, ...input.targets };
  const loudness: LoudnessResult = input.loudness ?? {
    integrated: null,
    lra: null,
    truePeak: null,
  };
  const blackFrames = input.blackFrames ?? [];
  const silences = input.silences ?? [];
  const freezes = input.freezes ?? [];
  const containerDurationSec = input.containerDurationSec ?? null;
  const expectedDurationSec =
    typeof input.expectedDurationSec === "number" &&
    Number.isFinite(input.expectedDurationSec)
      ? input.expectedDurationSec
      : null;

  const driftSec =
    containerDurationSec !== null && expectedDurationSec !== null
      ? containerDurationSec - expectedDurationSec
      : null;

  const loudnessOk =
    loudness.integrated === null
      ? null
      : Math.abs(loudness.integrated - targets.integratedLufs) <=
        targets.loudnessToleranceLu;
  const truePeakOk =
    loudness.truePeak === null ? null : loudness.truePeak <= targets.truePeakDbtp;
  const durationOk =
    driftSec === null ? null : Math.abs(driftSec) <= targets.driftToleranceSec;

  return {
    path: input.path,
    loudness,
    blackFrames,
    silences,
    freezes,
    drift: { containerDurationSec, expectedDurationSec, driftSec },
    verdicts: {
      loudnessOk,
      truePeakOk,
      durationOk,
      clean:
        blackFrames.length === 0 && silences.length === 0 && freezes.length === 0,
    },
    errors: input.errors ?? {},
  };
}

/**
 * Runs the full QC pass for a file. The runner shells out to the real
 * binaries on hosts that have ffmpeg; tests inject recorded output instead.
 * A failing/missing command is recorded in `errors` and never aborts the
 * rest of the measurement.
 */
export async function measureExportFile(
  runner: QcCommandRunner,
  path: string,
  options?: { expectedDurationSec?: number; targets?: Partial<MeasureTargets> },
): Promise<ExportMeasureReport> {
  const commands = buildMeasureCommands(path);
  const errors: Record<string, string> = {};

  const runSection = async (
    name: string,
  ): Promise<{ stdout: string; stderr: string } | null> => {
    const spec = commands[name];
    try {
      const result = await runner(spec.command, spec.args);
      if (result.exitCode !== 0 && name !== "loudness") {
        errors[name] = `${spec.command} exited ${result.exitCode}: ${result.stderr.slice(-200)}`;
        return null;
      }
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : String(error);
      return null;
    }
  };

  const [loudnessOut, blackOut, silenceOut, freezeOut, probeOut] =
    await Promise.all([
      runSection("loudness"),
      runSection("blackFrames"),
      runSection("silences"),
      runSection("freezes"),
      runSection("drift"),
    ]);

  return assembleMeasureReport({
    path,
    expectedDurationSec: options?.expectedDurationSec ?? null,
    loudness: loudnessOut ? parseEbur128(loudnessOut.stderr) : undefined,
    blackFrames: blackOut ? parseBlackdetect(blackOut.stderr) : undefined,
    silences: silenceOut ? parseSilencedetect(silenceOut.stderr) : undefined,
    freezes: freezeOut ? parseFreezedetect(freezeOut.stderr) : undefined,
    containerDurationSec: probeOut ? parseProbeDuration(probeOut.stdout) : undefined,
    errors,
    targets: options?.targets,
  });
}

/** One-line human summary for tool responses. */
export function summarizeMeasureReport(report: ExportMeasureReport): string {
  const { loudness, verdicts, drift, blackFrames, silences, freezes, errors } =
    report;
  const bits: string[] = [];
  bits.push(
    loudness.integrated === null
      ? "loudness: n/a"
      : `I=${loudness.integrated.toFixed(1)} LUFS${
          verdicts.loudnessOk === false ? " (OFF TARGET)" : ""
        }`,
  );
  bits.push(
    loudness.truePeak === null
      ? "TP: n/a"
      : `TP=${loudness.truePeak.toFixed(1)} dBTP${
          verdicts.truePeakOk === false ? " (CLIPPING)" : ""
        }`,
  );
  bits.push(
    drift.driftSec === null
      ? "duration: n/a"
      : `drift=${drift.driftSec >= 0 ? "+" : ""}${drift.driftSec.toFixed(2)}s${
          verdicts.durationOk === false ? " (DRIFTED)" : ""
        }`,
  );
  if (blackFrames.length > 0) bits.push(`black=${blackFrames.length}`);
  if (silences.length > 0) bits.push(`silence=${silences.length}`);
  if (freezes.length > 0) bits.push(`freeze=${freezes.length}`);
  if (verdicts.clean) bits.push("clean");
  const errorNames = Object.keys(errors);
  if (errorNames.length > 0) bits.push(`errors: ${errorNames.join(",")}`);
  return bits.join(" | ");
}
