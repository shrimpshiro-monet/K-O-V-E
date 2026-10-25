import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditPlan } from "@kove-advanced/creation-schema";
import { getGenreById } from "@kove-advanced/agent/director/index";
import { executeTool } from "@kove-advanced/agent/executor";
import type { LLMClient, LLMResponse } from "@kove-advanced/agent/llm";
import { loadOmniRouteConfig } from "@kove-advanced/agent/eval/baseline";
import type { EditingHost } from "@kove-advanced/agent/host";
import { HeadlessHost } from "@kove-advanced/agent/headless-host";
import type { EvalProject, EvalPrompt } from "@kove-advanced/agent/eval/corpus";
import { loadCorpus, resolveCorpusFile } from "@kove-advanced/agent/eval/corpus";
import type { MediaItem, Project } from "@kove-advanced/core/types/project";
import type { Clip, Track } from "@kove-advanced/core/types/timeline";
import type { BaselineCaseResult } from "@kove-advanced/agent/eval/baseline";
import { buildBaselineProject } from "@kove-advanced/agent/eval/baseline";
import { createMirrorSnapshot, MirrorCompositor, type MirrorSnapshot } from "./mirror-compositor";

const execFile = promisify(execFileCallback);
const REPO_ROOT = typeof __dirname !== "undefined"
  ? resolve(__dirname, "../../..")
  : resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const EVALUATION_DIR = resolve(REPO_ROOT, "evaluation-files");
const DEFAULT_REPORT = resolve(EVALUATION_DIR, "baseline-v0.json");
const REFERENCES_DIR = resolve(EVALUATION_DIR, "reference videos (priority, needs to look LIKE or BETTER than)");
const DEFAULT_OUTPUT_DIR = resolve(EVALUATION_DIR, "wow-reviews");
const VISION_MODEL_TIMEOUT_MS = 180_000;
const REVIEW_FRAME_COUNT = 8;

export interface WowEvalOptions {
  readonly reportPath?: string;
  readonly outputDirectory?: string;
  readonly caseId?: string;
  readonly run?: number;
  readonly skipVision?: boolean;
  readonly maxDimension?: number;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly fetchFn?: typeof fetch;
}

export interface WowDimensionScores {
  readonly intentAndStory: number;
  readonly momentSelection: number;
  readonly pacingAndRhythm: number;
  readonly composition: number;
  readonly visualCoherence: number;
  readonly editingCraft: number;
  readonly typography: number;
  readonly impact: number;
}

export interface WowVisionScore {
  readonly model: string;
  readonly visualScore: number;
  readonly dimensions: WowDimensionScores;
  readonly strengths: readonly string[];
  readonly issues: readonly string[];
  readonly referenceComparison: string;
  readonly minimumVisualBarMet: boolean;
}

export interface WowEvalResult {
  readonly caseId: string;
  readonly run: number;
  readonly candidateVideo: string;
  readonly referenceVideo: string;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly fileSizeBytes: number;
  readonly audioPresent: boolean;
  readonly structuralGates: BaselineCaseResult["gates"];
  readonly vision: WowVisionScore | null;
  readonly humanVerdict: null;
}

interface BaselineReport {
  readonly status?: "complete" | "aborted";
  readonly results?: readonly BaselineCaseResult[];
}

interface ProbeResult {
  readonly duration: number;
  readonly hasAudio: boolean;
}

interface ReviewFrame {
  readonly filePath: string;
  readonly timestamp: number;
}

class SavedPlanClient implements LLMClient {
  constructor(private readonly plan: EditPlan) {}

  async complete(): Promise<LLMResponse> {
    return {
      text: "",
      stopReason: "tool_use",
      toolUses: [{
        id: randomUUID(),
        name: "submit_edit_plan",
        input: this.plan as unknown as Record<string, unknown>,
      }],
    };
  }
}

function parseScore(raw: string, model: string): WowVisionScore {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    throw new Error(`Vision model returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Vision model returned no score object");
  const record = parsed as Record<string, unknown>;
  const dimensions = record.dimensions;
  if (typeof dimensions !== "object" || dimensions === null) {
    throw new Error("Vision model response is missing dimensions");
  }
  const values = dimensions as Record<string, unknown>;
  const dimensionNames: (keyof WowDimensionScores)[] = [
    "intentAndStory",
    "momentSelection",
    "pacingAndRhythm",
    "composition",
    "visualCoherence",
    "editingCraft",
    "typography",
    "impact",
  ];
  const scoreValue = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 10) {
      throw new Error(`Vision model returned an invalid ${name} score`);
    }
    return value;
  };
  const dimensionScores = Object.fromEntries(
    dimensionNames.map((name) => [name, scoreValue(values[name], name)]),
  ) as unknown as WowDimensionScores;
  const visualScore = scoreValue(record.visualScore, "visualScore");
  const strings = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`Vision model response is missing ${name}`);
    }
    return value;
  };
  if (typeof record.referenceComparison !== "string" || !record.referenceComparison.trim()) {
    throw new Error("Vision model response is missing referenceComparison");
  }
  return {
    model,
    visualScore,
    dimensions: dimensionScores,
    strengths: strings(record.strengths, "strengths"),
    issues: strings(record.issues, "issues"),
    referenceComparison: record.referenceComparison,
    minimumVisualBarMet:
      visualScore >= 8.5 && dimensionNames.every((name) => dimensionScores[name] >= 7),
  };
}

export async function scoreVisualCandidate(options: {
  readonly config: NonNullable<ReturnType<typeof loadOmniRouteConfig>>;
  readonly prompt: string;
  readonly category: string;
  readonly candidateFrames: readonly ReviewFrame[];
  readonly referenceFrames: readonly ReviewFrame[];
  readonly fetchFn?: typeof fetch;
}): Promise<WowVisionScore> {
  const fetchFn = options.fetchFn ?? fetch;
  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text:
      `You are screening a rendered edit against the user's real reference video. ` +
      `The user-defined minimum bar is "looks like or better than the reference"; judge ` +
      `the visual evidence critically, not generously. Do not infer audio quality: you receive ` +
      `stills only. Sample order is chronological; timestamps are seconds. ` +
      `Prompt: ${options.prompt}\nCategory: ${options.category}\n` +
      `Return ONLY JSON with visualScore (1-10), dimensions (1-10 each: ` +
      `intentAndStory, momentSelection, pacingAndRhythm, composition, visualCoherence, ` +
      `editingCraft, typography, impact), strengths (string array), issues (string array), ` +
      `and referenceComparison (string).`,
  }];
  const addFrames = async (label: string, frames: readonly ReviewFrame[]): Promise<void> => {
    for (const [index, frame] of frames.entries()) {
      const bytes = await readFile(frame.filePath);
      content.push({ type: "text", text: `${label} frame ${index + 1}, ${frame.timestamp.toFixed(2)}s` });
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}`, detail: "high" },
      });
    }
  };
  await addFrames("Candidate", options.candidateFrames);
  await addFrames("Reference bar", options.referenceFrames);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_MODEL_TIMEOUT_MS);
  try {
    const response = await fetchFn(`${options.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.config.model,
        temperature: 0,
        max_tokens: 1800,
        messages: [{ role: "user", content }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 700);
      throw new Error(`Vision model request failed (${response.status}): ${body}`);
    }
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) throw new Error("Vision model returned a malformed response");
    const choices = (payload as { choices?: unknown }).choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : null;
    const message = typeof firstChoice === "object" && firstChoice !== null
      ? (firstChoice as { message?: unknown }).message
      : null;
    const raw = typeof message === "object" && message !== null
      ? (message as { content?: unknown }).content
      : null;
    if (typeof raw !== "string") throw new Error("Vision model response did not contain text content");
    return parseScore(raw, options.config.model);
  } finally {
    clearTimeout(timer);
  }
}

async function probeVideo(path: string, ffprobePath: string): Promise<ProbeResult> {
  const { stdout } = await execFile(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type",
    "-of", "json", path,
  ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine video duration: ${path}`);
  return { duration, hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false };
}

async function extractReviewFrames(
  videoPath: string,
  outputDirectory: string,
  duration: number,
  ffmpegPath: string,
): Promise<ReviewFrame[]> {
  await mkdir(outputDirectory, { recursive: true });
  const frameRate = Math.min(1, REVIEW_FRAME_COUNT / duration);
  const outputPattern = resolve(outputDirectory, "frame-%02d.jpg");
  await execFile(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vf", `fps=${frameRate.toFixed(6)},scale=512:-2:force_original_aspect_ratio=decrease`,
    "-frames:v", String(REVIEW_FRAME_COUNT),
    "-q:v", "4",
    outputPattern,
  ], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const files = (await readdir(outputDirectory))
    .filter((file) => /^frame-\d+\.jpg$/.test(file))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) throw new Error(`FFmpeg extracted no review frames from ${videoPath}`);
  const interval = 1 / frameRate;
  return files.map((file, index) => ({
    filePath: resolve(outputDirectory, file),
    timestamp: Math.min(duration, index * interval),
  }));
}

function referenceNeedle(category: string): RegExp {
  if (/sport/i.test(category)) return /steph.*curry|curry.*steph/i;
  if (/game|gaming/i.test(category)) return /spiderman/i;
  return /captain\s*price/i;
}

async function chooseReference(category: string, referenceDirectory: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(referenceDirectory);
  } catch (error) {
    throw new Error(`Could not read user reference-video folder: ${error instanceof Error ? error.message : String(error)}`);
  }
  const match = files.find((file) => referenceNeedle(category).test(file) && /\.(mp4|mov|m4v)$/i.test(file));
  if (!match) {
    throw new Error(`No category-matched reference video for "${category}" in ${referenceDirectory}`);
  }
  return resolve(referenceDirectory, match);
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function buildReviewPage(result: WowEvalResult, prompt: string): string {
  const vision = result.vision;
  const scoreBlock = vision
    ? `<h2>Vision screen: ${vision.visualScore.toFixed(1)}/10 — ${vision.minimumVisualBarMet ? "passes screening bar (human confirmation required)" : "below screening bar"}</h2>
       <p><strong>Reference comparison:</strong> ${htmlEscape(vision.referenceComparison)}</p>
       <p><strong>Strengths:</strong> ${htmlEscape(vision.strengths.join("; ") || "None reported")}</p>
       <p><strong>Issues:</strong> ${htmlEscape(vision.issues.join("; ") || "None reported")}</p>`
    : "<h2>Vision screen not run</h2>";
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>K.O.V.E. watchability review · ${htmlEscape(result.caseId)}</title>
<style>
body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;background:#111;color:#eee}
video{width:min(100%,720px);max-height:75vh;background:#000}section{margin:2rem 0;padding:1rem;border:1px solid #444;border-radius:12px}
label{display:block;margin:.8rem 0}textarea{width:100%;min-height:5rem}button{padding:.65rem 1rem;margin-right:.5rem}
</style>
<h1>Watchability review · ${htmlEscape(result.caseId)} · run ${result.run}</h1>
<p><strong>Prompt:</strong> ${htmlEscape(prompt)}</p>
<p>Rendered ${result.durationSeconds.toFixed(2)}s · ${result.frameCount} frames · ${Math.round(result.fileSizeBytes / 1024)} KiB · timeline audio: ${result.audioPresent ? "present" : "none"}</p>
${scoreBlock}
<section><h2>Candidate — watch with sound</h2><video controls preload="metadata" src="${htmlEscape(result.candidateVideo)}"></video></section>
<section><h2>Reference bar</h2><video controls preload="metadata" src="${htmlEscape(result.referenceVideo)}"></video></section>
<section><h2>Your verdict (the model is only a screen)</h2>
<label><input type="radio" name="verdict" value="amazing"> Amazing — meets or beats the reference bar</label>
<label><input type="radio" name="verdict" value="good"> Good, but not a “no way” edit</label>
<label><input type="radio" name="verdict" value="not-good"> Not good to watch</label>
<label>Notes<textarea id="notes" placeholder="What landed? What broke the watch?"></textarea></label>
<button id="download">Download your review</button>
<p id="saved" aria-live="polite"></p></section>
<script>
document.getElementById("download").addEventListener("click",()=>{
  const verdict=document.querySelector('input[name="verdict"]:checked')?.value;
  if(!verdict){document.getElementById("saved").textContent="Choose a verdict first.";return}
  const data={caseId:${JSON.stringify(result.caseId)},run:${result.run},verdict,notes:document.getElementById("notes").value,reviewedAt:new Date().toISOString()};
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.download="human-review.json";a.click();URL.revokeObjectURL(a.href);
  document.getElementById("saved").textContent="Review downloaded.";
});
</script></html>`;
}

function isCoreReady(gates: BaselineCaseResult["gates"]): boolean {
  return gates.planValidates && gates.materializes && gates.noClipOverlaps &&
    gates.noTimelineGaps && gates.durationWithinTolerance;
}

function safeCaseDirectory(outputDirectory: string, caseId: string, run: number): string {
  const slug = `${caseId}-run${run}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const result = resolve(outputDirectory, slug);
  if (!result.startsWith(`${resolve(outputDirectory)}${sep}`)) throw new Error("Invalid case output path");
  return result;
}

async function replayPlan(
  entry: EvalProject,
  prompt: EvalPrompt,
  corpusDirectory: string,
  plan: EditPlan,
): Promise<{ project: Project; mediaPaths: Record<string, string> }> {
  const built = buildBaselineProject(entry, corpusDirectory);
  const host = new HeadlessHost(built.project) as HeadlessHost & {
    llm: NonNullable<EditingHost["llm"]>;
  };
  host.llm = { provider: "openai", client: new SavedPlanClient(plan) };
  const genre = getGenreById(prompt.text.trim());
  const result = await executeTool("plan_edit", {
    prompt: prompt.text,
    segmentMap: built.segmentMap,
    ...(genre ? { genreId: genre.id } : {}),
  }, host);
  if (!result.ok) {
    throw new Error(`Saved plan could not be materialized: ${result.error?.message ?? result.summary}`);
  }
  const mediaPaths = Object.fromEntries(
    built.project.mediaLibrary.items.map((item) => [item.id, resolveCorpusFile(corpusDirectory, item.name)]),
  );
  return { project: host.getProject(), mediaPaths };
}

export async function prepareAudioProxyProject(
  sourceProject: Project,
  sourcePaths: Readonly<Record<string, string>>,
  outputDirectory: string,
  ffmpegPath: string,
): Promise<{ project: Project; mediaPaths: Record<string, string> }> {
  const mediaPaths = { ...sourcePaths };
  const mediaById = new Map(sourceProject.mediaLibrary.items.map((item) => [item.id, item]));
  const audioDirectory = resolve(outputDirectory, "audio-proxies");
  await mkdir(audioDirectory, { recursive: true });
  const hasSoloTracks = sourceProject.timeline.tracks.some((track) => track.solo && !track.muted);
  const addedMedia: MediaItem[] = [];
  const proxiedVideoIds = new Set<string>();
  const tracks: Track[] = [];

  const makeProxy = async (clip: Clip, item: MediaItem): Promise<Clip> => {
    const inputPath = sourcePaths[item.id];
    if (!inputPath) throw new Error(`No source path is available for audio clip ${clip.id}`);
    if (item.type === "video") proxiedVideoIds.add(item.id);
    const speed = clip.speed ?? 1;
    if (!Number.isFinite(speed) || speed <= 0) throw new Error(`Invalid playback speed on audio clip ${clip.id}`);
    const sourceDuration = Math.min(
      clip.outPoint - clip.inPoint,
      clip.duration * speed,
      item.metadata.duration - clip.inPoint,
    );
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
      throw new Error(`Audio clip ${clip.id} has no usable source range`);
    }
    const sourceStart = clip.reversed
      ? Math.max(0, clip.outPoint - sourceDuration)
      : clip.inPoint;
    const sampleRate = sourceProject.settings.sampleRate || 48_000;
    const channelCount = sourceProject.settings.channels || 2;
    const proxyId = randomUUID();
    const proxyPath = resolve(audioDirectory, `${proxyId}.wav`);
    const filters = [
      ...(clip.reversed ? ["areverse"] : []),
      `asetrate=${Math.round(sampleRate * speed)}`,
      `aresample=${sampleRate}`,
      `atrim=duration=${clip.duration.toFixed(6)}`,
      "asetpts=PTS-STARTPTS",
    ];
    await execFile(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", sourceStart.toFixed(6),
      "-i", inputPath,
      "-t", sourceDuration.toFixed(6),
      "-map", `0:a:${clip.audioTrackIndex ?? 0}`,
      "-vn",
      "-af", filters.join(","),
      "-ac", String(channelCount),
      "-ar", String(sampleRate),
      "-c:a", "pcm_s16le",
      proxyPath,
    ], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    const fileSize = (await stat(proxyPath)).size;
    if (fileSize <= 44) throw new Error(`FFmpeg produced an empty audio proxy for clip ${clip.id}`);

    addedMedia.push({
      id: proxyId,
      name: `${item.name} audio proxy`,
      type: "audio",
      fileHandle: null,
      blob: null,
      metadata: {
        duration: clip.duration,
        width: 0,
        height: 0,
        frameRate: 0,
        codec: "pcm_s16le",
        sampleRate,
        channels: channelCount,
        fileSize,
        hasVideo: false,
        hasAudio: true,
      },
      thumbnailUrl: null,
      waveformData: null,
    });
    mediaPaths[proxyId] = proxyPath;
    return {
      ...clip,
      id: randomUUID(),
      mediaId: proxyId,
      inPoint: 0,
      outPoint: clip.duration,
      duration: clip.duration,
    };
  };

  for (const track of sourceProject.timeline.tracks) {
    const audibleTrack = !track.muted && (!hasSoloTracks || track.solo);
    const proxyClips: Clip[] = [];
    const rewrittenClips: Clip[] = [];
    const clipIds = new Map<string, string>();

    for (const clip of track.clips) {
      const item = mediaById.get(clip.mediaId);
      const hasAudio = item?.type === "audio" ||
        (item?.type === "video" && item.metadata.hasAudio === true);
      if (!item || !hasAudio) {
        if (track.type === "audio") continue;
        rewrittenClips.push(clip);
        continue;
      }
      if (!audibleTrack || (clip.volume ?? 1) <= 0) {
        if (track.type === "audio") continue;
        rewrittenClips.push(clip);
        continue;
      }
      const proxyClip = await makeProxy(clip, item);
      clipIds.set(clip.id, proxyClip.id);
      if (track.type === "audio") {
        rewrittenClips.push(proxyClip);
      } else {
        rewrittenClips.push(clip);
        proxyClips.push(proxyClip);
      }
    }

    const transitions = track.transitions
      .filter((transition) => clipIds.has(transition.clipAId) &&
        (!transition.clipBId || clipIds.has(transition.clipBId)))
      .map((transition) => ({
        ...transition,
        clipAId: clipIds.get(transition.clipAId)!,
        ...(transition.clipBId ? { clipBId: clipIds.get(transition.clipBId)! } : {}),
      }));
    if (track.type === "audio") {
      if (rewrittenClips.length > 0) {
        tracks.push({ ...track, clips: rewrittenClips, transitions });
      }
    } else {
      tracks.push({
        ...track,
        clips: rewrittenClips,
      });
      if (proxyClips.length > 0) {
        tracks.push({
          id: randomUUID(),
          name: `${track.name} · rendered audio`,
          type: "audio",
          role: track.role,
          clips: proxyClips,
          transitions,
          locked: false,
          hidden: false,
          muted: track.muted,
          solo: track.solo,
        });
      }
    }
  }

  return {
    project: {
      ...sourceProject,
      mediaLibrary: {
        items: [
          ...sourceProject.mediaLibrary.items.map((item) =>
            proxiedVideoIds.has(item.id)
              ? { ...item, metadata: { ...item.metadata, hasAudio: false } }
              : item,
          ),
          ...addedMedia,
        ],
      },
      timeline: { ...sourceProject.timeline, tracks },
    },
    mediaPaths,
  };
}

async function renderCase(options: {
  readonly row: BaselineCaseResult;
  readonly entry: EvalProject;
  readonly prompt: EvalPrompt;
  readonly corpusDirectory: string;
  readonly outputDirectory: string;
  readonly referencesDirectory: string;
  readonly maxDimension: number;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly skipVision: boolean;
  readonly fetchFn?: typeof fetch;
}): Promise<WowEvalResult> {
  if (!isCoreReady(options.row.gates)) {
    throw new Error(`Refusing to render ${options.row.id} run ${options.row.run}: core timeline gates failed`);
  }
  const planPath = resolve(
    EVALUATION_DIR,
    "plans",
    options.entry.id,
    `${options.prompt.id}-run${options.row.run}.json`,
  );
  const plan = JSON.parse(await readFile(planPath, "utf8")) as EditPlan;
  const replay = await replayPlan(options.entry, options.prompt, options.corpusDirectory, plan);
  const caseDirectory = safeCaseDirectory(options.outputDirectory, options.row.id, options.row.run);
  await mkdir(caseDirectory, { recursive: true });
  let project = replay.project;
  let snapshot: MirrorSnapshot;
  try {
    const prepared = await prepareAudioProxyProject(
      replay.project,
      replay.mediaPaths,
      caseDirectory,
      options.ffmpegPath,
    );
    project = prepared.project;
    snapshot = await createMirrorSnapshot(project, prepared.mediaPaths);
  } finally {
    await rm(resolve(caseDirectory, "audio-proxies"), { recursive: true, force: true });
  }
  const candidatePath = resolve(caseDirectory, "candidate.mp4");
  const referencePath = await chooseReference(options.entry.category, options.referencesDirectory);
  const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
  let exportStats: { duration: number; framesRendered: number; fileSize: number };
  try {
    const sourceWidth = project.settings.width;
    const sourceHeight = project.settings.height;
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
      throw new Error("Project has invalid export dimensions");
    }
    const scale = Math.min(1, options.maxDimension / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(64, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(64, Math.round((sourceHeight * scale) / 2) * 2);
    exportStats = await compositor.exportVideo(snapshot, candidatePath, {
      format: "mp4",
      codec: "h264",
      width,
      height,
      frameRate: project.settings.frameRate,
      bitrate: Math.max(1500, Math.round((width * height * project.settings.frameRate) / 180_000)),
      bitrateMode: "vbr",
      encodeMode: "balanced",
      quality: 85,
      keyframeInterval: project.settings.frameRate * 2,
      audioSettings: {
        format: "aac",
        sampleRate: 48000,
        bitDepth: 16,
        bitrate: 192,
        channels: 2,
      },
    });
  } finally {
    await compositor.close();
  }

  const [candidateProbe, referenceProbe] = await Promise.all([
    probeVideo(candidatePath, options.ffprobePath),
    probeVideo(referencePath, options.ffprobePath),
  ]);
  const [candidateFrames, referenceFrames] = await Promise.all([
    extractReviewFrames(candidatePath, resolve(caseDirectory, "candidate-frames"), candidateProbe.duration, options.ffmpegPath),
    extractReviewFrames(referencePath, resolve(caseDirectory, "reference-frames"), referenceProbe.duration, options.ffmpegPath),
  ]);

  let vision: WowVisionScore | null = null;
  if (!options.skipVision) {
    const config = loadOmniRouteConfig(REPO_ROOT);
    if (!config) {
      throw new Error("Vision scoring requested, but OmniRoute config is missing; set OMNIROUTE_KEY and OMNIROUTE_MODEL or use --skip-vision");
    }
    vision = await scoreVisualCandidate({
      config,
      prompt: options.prompt.text,
      category: options.entry.category,
      candidateFrames,
      referenceFrames,
      fetchFn: options.fetchFn,
    });
  }

  const result: WowEvalResult = {
    caseId: options.row.id,
    run: options.row.run,
    candidateVideo: "candidate.mp4",
    referenceVideo: relativeTo(caseDirectory, referencePath),
    durationSeconds: candidateProbe.duration,
    frameCount: exportStats.framesRendered,
    fileSizeBytes: exportStats.fileSize,
    audioPresent: candidateProbe.hasAudio,
    structuralGates: options.row.gates,
    vision,
    humanVerdict: null,
  };
  await writeFile(resolve(caseDirectory, "wow-report.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(caseDirectory, "index.html"), buildReviewPage(result, options.prompt.text));
  return result;
}

function relativeTo(fromDirectory: string, targetPath: string): string {
  return relative(fromDirectory, targetPath).split(sep).join("/");
}

export async function runWowEval(options: WowEvalOptions = {}): Promise<WowEvalResult[]> {
  const reportPath = resolve(options.reportPath ?? DEFAULT_REPORT);
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_OUTPUT_DIR);
  const maxDimension = options.maxDimension ?? 720;
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 64 || maxDimension > 1920) {
    throw new Error("--max-dimension must be an integer from 64 to 1920");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as BaselineReport;
  if (!Array.isArray(report.results) || report.results.length === 0) {
    throw new Error(`Baseline report contains no results: ${reportPath}`);
  }
  if (!options.caseId && report.status !== "complete") {
    throw new Error("The baseline report is incomplete; pass --case to review a settled case or wait for the full campaign");
  }
  const corpusDirectory = dirname(resolve(EVALUATION_DIR, "projects.json"));
  const corpus = loadCorpus(resolve(corpusDirectory, "projects.json"));
  const entries = new Map(corpus.map((entry) => [entry.id, entry]));
  const rows = report.results.filter((row) =>
    (!options.caseId || row.id === options.caseId) &&
    (options.run === undefined || row.run === options.run) &&
    isCoreReady(row.gates),
  );
  if (rows.length === 0) {
    throw new Error("No settled case matches the selection with all core timeline gates passing");
  }
  if (options.caseId && !report.results.some((row) => row.id === options.caseId && (options.run === undefined || row.run === options.run))) {
    throw new Error(`Case not found in baseline report: ${options.caseId}`);
  }

  const output: WowEvalResult[] = [];
  for (const row of rows) {
    process.stdout.write(`[wow-eval] Materializing ${row.id} run ${row.run}.\n`);
    const [projectId, promptId] = row.id.split("/");
    const entry = projectId ? entries.get(projectId) : undefined;
    const prompt = entry?.prompts.find((item) => item.id === promptId);
    if (!entry || !prompt) throw new Error(`Could not resolve baseline case in corpus: ${row.id}`);
    process.stdout.write(`[wow-eval] Rendering against the ${entry.category} reference bar.\n`);
    const result = await renderCase({
      row,
      entry,
      prompt,
      corpusDirectory,
      outputDirectory,
      referencesDirectory: REFERENCES_DIR,
      maxDimension,
      ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
      ffprobePath: options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe",
      skipVision: options.skipVision ?? false,
      fetchFn: options.fetchFn,
    });
    output.push(result);
  }
  return output;
}
