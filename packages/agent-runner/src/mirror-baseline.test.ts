import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { HeadlessHost } from "@kove-advanced/agent/headless-host";
import { mirrorReference1to1 } from "@kove-advanced/agent/director/mirror/mirror-reference-tool";
import { mirrorRefine } from "@kove-advanced/agent/director/mirror/mirror-refine-tool";
import {
  aggregateMirrorBaseline,
  assembleMirrorBaselineReport,
  compiledCutTimesMs,
  measureBeatAlignment,
  type MirrorBaselineCaseReport,
  type MirrorBaselineDecodePath,
  type MirrorBaselineMedia,
  type MirrorCrossRestyleReport,
} from "@kove-advanced/agent/eval/mirror-baseline";
import { BeatDetectionEngine } from "@kove-advanced/core/audio/beat-detection-engine";
import { computeLabStats, type LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { MediaItem, Project } from "@kove-advanced/core/types/project";
import { createCompositorMirrorFrameRunner } from "./mirror-frame-runner";
import { createEmptyProject } from "./project-io";

interface ManifestCase {
  readonly id: string;
  readonly styleFamily: string;
  readonly source: string;
  readonly sha256: string;
  readonly decodePath: MirrorBaselineDecodePath;
  readonly media: MirrorBaselineMedia;
}

interface ManifestCrossRestyle {
  readonly id: string;
  readonly styleProfile: string;
  readonly heldOutSource: string;
  readonly note: string;
}

interface Manifest {
  readonly cases: readonly ManifestCase[];
  readonly crossRestyle?: ManifestCrossRestyle;
}

interface ExtractionMeta {
  readonly id: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly decodePath: MirrorBaselineDecodePath;
  readonly clock: {
    readonly fps: { readonly num: number; readonly den: number };
    readonly fpsSource: string;
    readonly durationSeconds: number;
  };
  readonly extraction: {
    readonly backend: string;
    readonly includeReferenceText: boolean;
    readonly ffmpegSceneDetection: boolean;
    readonly endCardTrim: boolean;
  };
  readonly media: MirrorBaselineMedia;
  readonly elapsedMs: number;
  readonly warnings: readonly string[];
  readonly shotCount: number;
  readonly transitionCount: number;
  readonly textOverlayCount: number;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(repoRoot, "evaluation-files/reference/mirror-baseline-manifest.json"), "utf8"),
) as Manifest;
const profileDir = resolve(repoRoot, "evaluation-files/mirror-baseline/profiles");
const reportPath = resolve(repoRoot, "evaluation-files/mirror-baseline/report.json");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH ?? process.env.KOVE_E2E_CHROMIUM;
const enabled = process.env.KOVE_MIRROR_BASELINE_RUN === "1";
const only = process.env.KOVE_MIRROR_BASELINE_IDS?.split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const crossRestyle = manifest.crossRestyle;

function profilePath(id: string): string {
  return resolve(profileDir, `${id}.json`);
}

function metaPath(id: string): string {
  return resolve(profileDir, `${id}.meta.json`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function projectForCase(entry: ManifestCase): Project {
  const base = createEmptyProject(`Mirror baseline ${entry.id}`, {
    width: entry.media.width,
    height: entry.media.height,
    frameRate: entry.media.fps.num / entry.media.fps.den,
  });
  const item: MediaItem = {
    id: "source",
    name: `${entry.id} reference`,
    type: "video",
    blob: null,
    fileHandle: null,
    thumbnailUrl: null,
    waveformData: null,
    metadata: {
      duration: (entry.media.durationFrames * entry.media.fps.den) / entry.media.fps.num,
      width: entry.media.width,
      height: entry.media.height,
      frameRate: entry.media.fps.num / entry.media.fps.den,
      codec: entry.decodePath.codec,
      sampleRate: 48000,
      channels: 2,
      fileSize: 0,
    },
  };
  return { ...base, mediaLibrary: { items: [item] } };
}

function decodeMonoAudio(path: string): Promise<Float32Array> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(ffmpeg, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg audio decode failed for ${path}: ${stderr || code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(buffer.length / 4));
      for (let index = 0; index < samples.length; index++) samples[index] = buffer.readFloatLE(index * 4);
      resolvePromise(samples);
    });
  });
}

async function measureBeatGridMs(path: string): Promise<number[]> {
  const samples = await decodeMonoAudio(path);
  if (samples.length === 0) return [];
  const audioBuffer = {
    length: samples.length,
    duration: samples.length / 48_000,
    sampleRate: 48_000,
    numberOfChannels: 1,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
  const analysis = await new BeatDetectionEngine().analyzeAudioBuffer(audioBuffer);
  return [...new Set(analysis.beats.map((beat) => Math.round(beat.time * 1000)))].sort((a, b) => a - b);
}

function sampleShotLabStats(
  path: string,
  shots: readonly { readonly startFrame: number; readonly endFrame: number }[],
): Promise<LabStats[]> {
  const size = 64;
  const frameBytes = size * size * 4;
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(ffmpeg, ["-v", "error", "-i", path, "-vf", `scale=${size}:${size}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg lab sampling failed for ${path}: ${stderr || code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const available = Math.floor(buffer.length / frameBytes);
      if (available === 0) {
        reject(new Error(`No decoded frames for lab sampling: ${path}`));
        return;
      }
      resolvePromise(shots.map((shot) => {
        const midpoint = Math.min(available - 1, Math.max(0, Math.floor((shot.startFrame + shot.endFrame - 1) / 2)));
        const offset = midpoint * frameBytes;
        return computeLabStats(new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + offset, frameBytes));
      }));
    });
  });
}

function writeReport(entry: MirrorBaselineCaseReport): void {
  mkdirSync(resolve(repoRoot, "evaluation-files/mirror-baseline"), { recursive: true });
  const existing = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as {
        cases?: readonly MirrorBaselineCaseReport[];
        crossRestyle?: MirrorCrossRestyleReport;
      })
    : { cases: [] };
  const cases = [...(existing.cases ?? []).filter((value) => value.id !== entry.id), entry]
    .sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: aggregateMirrorBaseline(cases),
    ...(existing.crossRestyle && { crossRestyle: existing.crossRestyle }),
    cases,
  }, null, 2)}\n`);
}

function writeCrossRestyleReport(entry: MirrorCrossRestyleReport): void {
  mkdirSync(resolve(repoRoot, "evaluation-files/mirror-baseline"), { recursive: true });
  const existing = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, "utf8")) as {
        cases?: readonly MirrorBaselineCaseReport[];
        crossRestyle?: MirrorCrossRestyleReport;
      })
    : { cases: [] };
  const cases = existing.cases ?? [];
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: aggregateMirrorBaseline(cases),
    crossRestyle: entry,
    cases,
  }, null, 2)}\n`);
}

const runnable = enabled
  ? manifest.cases.filter((entry) =>
      (!only || only.includes(entry.id)) && existsSync(profilePath(entry.id)) && existsSync(metaPath(entry.id)))
  : [];
const crossRunnable = enabled && crossRestyle &&
  (!only || only.includes(crossRestyle.id)) &&
  existsSync(profilePath(crossRestyle.styleProfile)) &&
  existsSync(profilePath(crossRestyle.heldOutSource)) &&
  existsSync(metaPath(crossRestyle.heldOutSource));

describe("Mirror 10-reference baseline (real extract -> compile -> refine)", () => {
  if (!runnable.length && !crossRunnable) {
    it.skip("No runnable baseline cases: extract profiles first, then set KOVE_MIRROR_BASELINE_RUN=1", () => {});
    return;
  }

  for (const entry of runnable) {
    it(`compiles and refines ${entry.id}`, async () => {
      const meta = JSON.parse(readFileSync(metaPath(entry.id), "utf8")) as ExtractionMeta;
      const profile = JSON.parse(readFileSync(profilePath(entry.id), "utf8")) as ReferenceProfile;
      const mediaPath = resolve(repoRoot, entry.decodePath.kind === "h264-proxy" ? entry.decodePath.proxy! : entry.source);
      const expectedHash = entry.decodePath.kind === "h264-proxy"
        ? entry.decodePath.proxySha256!
        : entry.sha256;
      if (sha256File(mediaPath) !== expectedHash) throw new Error(`Media hash mismatch for ${entry.id}`);

      const targetStats = await sampleShotLabStats(mediaPath, profile.shots);
      let host: HeadlessHost;
      const runner = createCompositorMirrorFrameRunner({
        referencePath: mediaPath,
        getProject: () => host.getProject(),
        mediaPaths: { source: mediaPath },
        ffmpegPath: ffmpeg,
        chromiumExecutablePath,
      });
      host = new HeadlessHost(projectForCase(entry), { mirrorFrameRunner: runner.sample });

      try {
        const compiled = await mirrorReference1to1(host, profile, ["source"], targetStats);
        const refined = await mirrorRefine(host, compiled.shotItemIds, {
          iterations: 8,
          sampleCount: Math.min(3, profile.shots.length),
          seed: 0x1234abcd,
        });
        const beatGridMs = await measureBeatGridMs(mediaPath);
        const beatAlignment = measureBeatAlignment(
          compiledCutTimesMs(host.getProject(), compiled.shotItemIds),
          beatGridMs,
        );
        const textWarning = meta.warnings.find((warning) => warning.includes("Local OCR is unavailable"));
        const report = assembleMirrorBaselineReport({
          id: entry.id,
          styleFamily: entry.styleFamily,
          source: entry.source,
          sourceSha256: entry.sha256,
          decodePath: entry.decodePath,
          media: entry.media,
          clockProvenance: "external-ffprobe-manifest",
          extraction: {
            backend: meta.extraction.backend,
            shotCount: profile.shots.length,
            boundariesFrames: profile.shots.slice(1).map((shot) => shot.startFrame),
            cameraClasses: profile.shots.reduce<Record<string, number>>((classes, shot) => {
              const move = shot.cameraMotion?.dominantMove ?? "unknown";
              classes[move] = (classes[move] ?? 0) + 1;
              return classes;
            }, {}),
            transitionCount: profile.styleEvidence?.transitions.length ?? 0,
            eventCount: profile.structure?.events.length ?? 0,
            cameraShotCount: profile.shots.filter((shot) => (shot.cameraMotion?.samples.length ?? 0) > 0).length,
            elapsedMs: meta.elapsedMs,
            warnings: meta.warnings,
            textStatus: textWarning ? "unavailable" : "measured",
            textReason: textWarning ?? "Measured by the browser's local text detector.",
            watermarkMasking: profile.textMasking?.applied ? "applied" : "unknown",
            ...(profile.textMasking?.endCardTrimmedFrames !== undefined && { endCardTrimmedFrames: profile.textMasking.endCardTrimmedFrames }),
          },
          compile: {
            shotItemIds: compiled.shotItemIds,
            rhythmScore: compiled.rhythmScore,
            colorApplied: compiled.colorApplied,
            text: compiled.text,
          },
          beatAlignment,
          refine: {
            bestKnobs: refined.bestKnobs,
            bestScore: refined.bestScore,
            bestSsim: refined.bestSsim,
            rhythmScore: refined.rhythmScore,
            trials: refined.trials,
            history: refined.history,
            sampleFrames: refined.sampleFrames,
            fps: refined.fps,
          },
        });
        writeReport(report);
        console.info("Mirror baseline case", {
          id: entry.id,
          shots: profile.shots.length,
          clips: compiled.shotItemIds.length,
          rhythmScore: compiled.rhythmScore,
          colorApplied: compiled.colorApplied,
          bestSsim: refined.bestSsim,
          bestScore: refined.bestScore,
          trials: refined.trials,
          beatErrorMs: beatAlignment.meanAbsoluteErrorMs,
        });
      } finally {
        await runner.close();
      }
    }, 900_000);
  }

  if (crossRunnable) {
    it(`restyles held-out footage with ${crossRestyle.styleProfile}`, async () => {
      const styleEntry = manifest.cases.find((entry) => entry.id === crossRestyle.styleProfile);
      const footageEntry = manifest.cases.find((entry) => entry.id === crossRestyle.heldOutSource);
      if (!styleEntry || !footageEntry) throw new Error("Cross-restyle manifest case is incomplete");
      const styleProfile = JSON.parse(readFileSync(profilePath(styleEntry.id), "utf8")) as ReferenceProfile;
      const mediaPath = resolve(repoRoot, footageEntry.decodePath.kind === "h264-proxy"
        ? footageEntry.decodePath.proxy!
        : footageEntry.source);
      const expectedHash = footageEntry.decodePath.kind === "h264-proxy"
        ? footageEntry.decodePath.proxySha256!
        : footageEntry.sha256;
      if (sha256File(mediaPath) !== expectedHash) throw new Error(`Media hash mismatch for ${footageEntry.id}`);
      const targetStats = await sampleShotLabStats(mediaPath, styleProfile.shots);
      let host: HeadlessHost;
      const runner = createCompositorMirrorFrameRunner({
        referencePath: mediaPath,
        getProject: () => host.getProject(),
        mediaPaths: { source: mediaPath },
        ffmpegPath: ffmpeg,
        chromiumExecutablePath,
      });
      host = new HeadlessHost(projectForCase(footageEntry), { mirrorFrameRunner: runner.sample });
      try {
        const compiled = await mirrorReference1to1(host, styleProfile, ["source"], targetStats);
        const beatGridMs = await measureBeatGridMs(mediaPath);
        const beatAlignment = measureBeatAlignment(
          compiledCutTimesMs(host.getProject(), compiled.shotItemIds),
          beatGridMs,
        );
        writeCrossRestyleReport({
          id: crossRestyle.id,
          styleProfileId: styleEntry.id,
          styleSource: styleEntry.source,
          styleSourceSha256: styleEntry.sha256,
          heldOutProfileId: footageEntry.id,
          heldOutSource: footageEntry.source,
          heldOutSourceSha256: footageEntry.sha256,
          compile: {
            shotItemIds: compiled.shotItemIds,
            rhythmScore: compiled.rhythmScore,
            colorApplied: compiled.colorApplied,
            text: compiled.text,
          },
          beatAlignment,
          basis: {
            compile: "held-out-cross-restyle",
            refine: "not-scored",
            notes: [
              `Style DNA from ${styleEntry.id} was applied to ${footageEntry.id} footage that was not used to derive it.`,
              "No ground-truth render exists for this pairing, so SSIM, LPIPS, and fidelity are not scored; the case reports structure, color/text application, and beat alignment only.",
              beatAlignment.status === "measured"
                ? `Beat-alignment error compares the restyled cuts to the held-out footage's own measured beat grid (${Math.round(beatAlignment.meanAbsoluteErrorMs!)} ms mean).`
                : `Beat alignment is unavailable: ${beatAlignment.reason}`,
            ],
          },
        });
        console.info("Mirror cross-restyle case", {
          id: crossRestyle.id,
          style: styleEntry.id,
          footage: footageEntry.id,
          shots: compiled.shotItemIds.length,
          rhythmScore: compiled.rhythmScore,
          colorApplied: compiled.colorApplied,
          beatErrorMs: beatAlignment.meanAbsoluteErrorMs,
        });
      } finally {
        await runner.close();
      }
    }, 300_000);
  }
});
