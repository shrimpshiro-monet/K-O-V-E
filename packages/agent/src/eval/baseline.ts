import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Track } from "@kove-advanced/core/types/timeline";
import type { EditPlan, SegmentMap } from "@kove-advanced/creation-schema";
import { validateEditPlan } from "@kove-advanced/creation-schema";
import { HeadlessHost } from "../headless-host";
import type { EditingHost } from "../host";
import { executeTool } from "../executor";
import { makeClientFromSend, withRetry } from "../llm";
import type { LLMClient, LLMSend } from "../llm";
import {
  loadOmniRouteConfig as loadOmniRouteProviderConfig,
  loadWorkersAIConfig as loadWorkersAIProviderConfig,
} from "../providers/dev-vars";
import { makeOmniRouteSend } from "../providers/omniroute";
import type { OmniRouteConfig, OmniTransportOptions } from "../providers/omniroute";
import { makeWorkersAISend as makeWorkersAISendTransport } from "../providers/workers-ai";
import type { WorkersAIConfig } from "../providers/workers-ai";
import { getGenreById } from "../director";
import { loadCorpus, missingAssets, resolveCorpusFile } from "./corpus";
import type { EvalProject, EvalPrompt, PromptType } from "./corpus";
import {
  bestQuality,
  loadReferenceFingerprints,
  summarizeQuality,
  type QualityScore,
  type ReferenceFingerprint,
} from "./quality";

function findRepositoryRoot(): string {
  const moduleDirectory = typeof __dirname !== "undefined"
    ? __dirname
    : fileURLToPath(new URL(".", import.meta.url));
  for (const start of [process.cwd(), moduleDirectory]) {
    let directory = resolve(start);
    for (;;) {
      if (existsSync(resolve(directory, "evaluation-files/projects.json"))) return directory;
      const parent = resolve(directory, "..");
      if (parent === directory) break;
      directory = parent;
    }
  }
  return resolve(moduleDirectory, "../../../..");
}

export const REPO_ROOT = findRepositoryRoot();
export const CORPUS_DIR = resolve(REPO_ROOT, "evaluation-files");
export const CORPUS_PATH = resolve(CORPUS_DIR, "projects.json");
export const DEFAULT_REPORT_PATH = resolve(CORPUS_DIR, "baseline-v0.json");
export const PLAN_DUMP_DIR = resolve(CORPUS_DIR, "plans");

/**
 * Durable per-row journal beside a report. The report JSON is written once at
 * the end of a run, so a crash or a harness timeout used to lose every
 * in-memory row; each result is also appended here the moment it settles, and
 * resume reads this first (later lines win per `id|run`).
 */
export function rowsPathFor(reportPath: string): string {
  return reportPath.replace(/\.json$/, ".rows.jsonl");
}

function loadRowsJournal(rowsPath: string): BaselineCaseResult[] {
  if (!existsSync(rowsPath)) return [];
  const byKey = new Map<string, BaselineCaseResult>();
  for (const line of readFileSync(rowsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as BaselineCaseResult;
      if (row && typeof row.id === "string") byKey.set(`${row.id}|${row.run}`, row);
    } catch {
      // A torn final line from a mid-write kill is expected; skip it.
    }
  }
  return [...byKey.values()];
}

/**
 * Persist the plan a run produced (accepted or rejected) so an audit can read
 * what the model actually emitted — e.g. the contrast/saturation values that
 * motivated the one true param scale. Untracked measurement artifact.
 */
export function dumpPlanJson(
  entryId: string,
  promptId: string,
  run: number,
  plan: unknown,
): string | null {
  try {
    const dir = resolve(PLAN_DUMP_DIR, entryId);
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${promptId}-run${run}.json`);
    writeFileSync(file, JSON.stringify(plan, null, 2));
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI client (same endpoint/shape the web app uses)
// ---------------------------------------------------------------------------

export type { WorkersAIConfig } from "../providers/workers-ai";
export { parseDevVars } from "../providers/dev-vars";
export type { OmniRouteConfig, OmniTransportOptions } from "../providers/omniroute";
export { makeOmniRouteSend } from "../providers/omniroute";

/**
 * Credential precedence: eval-scoped `KOVE_EVAL_CLOUDFLARE_*` (lets a second
 * account key be exported without disturbing the web app's credentials) →
 * generic `CLOUDFLARE_*` env → the repo's `.dev.vars`. Token and account id
 * must come from the same Cloudflare account or requests 403.
 */
export function loadWorkersAIConfig(repoRoot: string = REPO_ROOT): WorkersAIConfig | null {
  return loadWorkersAIProviderConfig(repoRoot, "KOVE_EVAL_");
}

export function loadOmniRouteConfig(repoRoot: string = REPO_ROOT): OmniRouteConfig | null {
  return loadOmniRouteProviderConfig(repoRoot, "KOVE_EVAL_");
}

export type EvalLLMConfig =
  | { readonly kind: "omni"; readonly config: OmniRouteConfig }
  | { readonly kind: "workers"; readonly config: WorkersAIConfig };

/**
 * Provider selection for baseline runs. `KOVE_EVAL_LLM_PROVIDER` forces a
 * side (`omni` | `workers`); otherwise a configured OmniRoute gateway wins
 * over Workers AI — local gateway first, quota-limited cloud as fallback.
 */
export function resolveEvalLLMConfig(repoRoot?: string): EvalLLMConfig | null {
  const provider = (process.env.KOVE_EVAL_LLM_PROVIDER || "").toLowerCase();
  const omni = loadOmniRouteConfig(repoRoot);
  const workers = loadWorkersAIConfig(repoRoot);
  if (provider === "omni") return omni ? { kind: "omni", config: omni } : null;
  if (provider === "workers") return workers ? { kind: "workers", config: workers } : null;
  if (omni) return { kind: "omni", config: omni };
  if (workers) return { kind: "workers", config: workers };
  return null;
}

export interface WorkersAIClientOptions {
  readonly maxTokens?: number;
  readonly fetchFn?: typeof fetch;
  /** Sampling pinning; `null` opts out (never the default for baseline runs). */
  readonly sampling?: SamplingPinning | null;
}

export interface SamplingPinning {
  readonly temperature: number;
  readonly seed?: number;
}

/**
 * Requested sampling hints injected into every request body. A provider may
 * ignore temperature/seed, so the report measures observed spread rather than
 * assuming repeated calls produce the same plan.
 */
export const PINNED_SAMPLING: SamplingPinning = { temperature: 0, seed: 1234 };

export function pinnedSend(send: LLMSend, pin: SamplingPinning): LLMSend {
  return async (body: unknown): Promise<unknown> => {
    const base = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    return send({
      ...base,
      temperature: pin.temperature,
      ...(pin.seed !== undefined ? { seed: pin.seed } : {}),
    });
  };
}

/**
 * OpenAI-compatible Workers AI transport. The API key is used per-request for
 * the Authorization header only and is never stored or logged. The transport
 * itself lives in providers/workers-ai so the app, the CLI, and the eval
 * harness all speak the same wire format.
 */
export function makeWorkersAISend(cfg: WorkersAIConfig, opts: WorkersAIClientOptions = {}): LLMSend {
  return makeWorkersAISendTransport(cfg, opts);
}

export function makeWorkersAIClient(cfg: WorkersAIConfig, opts: WorkersAIClientOptions = {}): LLMClient {
  const sampling = opts.sampling === undefined ? PINNED_SAMPLING : opts.sampling;
  const send = sampling
    ? pinnedSend(makeWorkersAISend(cfg, opts), sampling)
    : makeWorkersAISend(cfg, opts);
  return makeClientFromSend({
    provider: "openai",
    model: cfg.model,
    maxTokens: opts.maxTokens ?? 8192,
    send: withRetry(send),
  });
}

export interface OmniRouteEvalClientOptions extends OmniTransportOptions {
  /** Sampling pinning; `null` opts out (never the default for baseline runs). */
  readonly sampling?: SamplingPinning | null;
}

/**
 * Eval-side OmniRoute client: the shared gateway transport plus the pinned
 * sampling the baseline report measures against. Product callers use the
 * unpinned `makeOmniRouteClient` exported from ../providers/omniroute.
 */
export function makeOmniRouteClient(
  cfg: OmniRouteConfig,
  opts: OmniRouteEvalClientOptions = {},
): LLMClient {
  const sampling = opts.sampling === undefined ? PINNED_SAMPLING : opts.sampling;
  const send = sampling
    ? pinnedSend(makeOmniRouteSend(cfg, opts), sampling)
    : makeOmniRouteSend(cfg, opts);
  return makeClientFromSend({
    provider: "openai",
    model: cfg.model,
    maxTokens: opts.maxTokens ?? 8192,
    send: withRetry(send),
  });
}

// ---------------------------------------------------------------------------
// Project construction from corpus assets
// ---------------------------------------------------------------------------

interface ProbedMedia {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly fileSize: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function mediaTypeFor(file: string): "video" | "audio" | "image" {
  const ext = extname(file).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  throw new Error(`Unrecognized media extension for ${file}`);
}

function parseRate(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = Number(den ?? 1);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

export function probeMedia(file: string): ProbedMedia {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");
  const format = parsed.format ?? {};
  const duration = Number(format.duration ?? video?.duration ?? audio?.duration ?? 0);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: Number(video?.width ?? 0) || 0,
    height: Number(video?.height ?? 0) || 0,
    frameRate: parseRate(video?.avg_frame_rate as string | undefined) || parseRate(video?.r_frame_rate as string | undefined),
    codec: String(video?.codec_name ?? audio?.codec_name ?? ""),
    sampleRate: Number(audio?.sample_rate ?? 0) || 0,
    channels: Number(audio?.channels ?? 0) || 0,
    fileSize: Number(format.size ?? 0) || statSync(file).size,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

function toMediaItem(
  id: string,
  /** Corpus-relative path: prompts reference music by this exact string. */
  name: string,
  file: string,
  probe: ProbedMedia,
  analysisRole?: "source" | "reference",
): MediaItem {
  return {
    id,
    name,
    type: mediaTypeFor(file),
    ...(analysisRole ? { analysisRole } : {}),
    fileHandle: null,
    blob: null,
    metadata: {
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      frameRate: probe.frameRate,
      codec: probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      fileSize: probe.fileSize,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
    },
    thumbnailUrl: null,
    waveformData: null,
  } as MediaItem;
}

export interface BuiltBaselineProject {
  readonly project: Project;
  readonly segmentMap: SegmentMap;
}

/**
 * Builds an in-memory project for a corpus entry: source videos (`video-N`),
 * optional music (`audio-N`) and the optional reference clip (`reference-N`,
 * marked so the fallback segment map never treats it as cuttable footage).
 * Media metadata comes from ffprobe so plans validate against real durations.
 */
export function buildBaselineProject(
  entry: EvalProject,
  root: string = CORPUS_DIR,
  probe: (file: string) => ProbedMedia = probeMedia,
): BuiltBaselineProject {
  const items: MediaItem[] = [];
  let videoIndex = 0;
  let audioIndex = 0;
  let referenceIndex = 0;

  const addMedia = (relative: string, role: "source" | "reference" | "music"): void => {
    const file = resolveCorpusFile(root, relative);
    if (!existsSync(file)) throw new Error(`Missing corpus asset: ${entry.id}: ${relative}`);
    const type = mediaTypeFor(file);
    const id =
      role === "reference"
        ? `reference-${++referenceIndex}`
        : type === "audio"
          ? `audio-${++audioIndex}`
          : `video-${++videoIndex}`;
    // Materialization resolves audio decisions by media id OR exact name, and
    // several corpus prompts name the track by its corpus-relative path.
    items.push(toMediaItem(id, relative, file, probe(file), role === "reference" ? "reference" : undefined));
  };

  for (const media of entry.media) addMedia(media, "source");
  if (entry.music) addMedia(entry.music, "music");
  if (entry.reference) addMedia(entry.reference, "reference");

  const now = Date.now();
  const project: Project = {
    id: `eval-${entry.id}`,
    name: entry.id,
    createdAt: now,
    modifiedAt: now,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items },
    timeline: { tracks: [], subtitles: [], duration: 0, markers: [] },
  };

  return { project, segmentMap: buildSegmentMap(project) };
}

/**
 * Baseline (vision-free) segment map: one full-length segment per source
 * video. Mirrors plan_edit's metadata fallback so gate A can re-validate a
 * plan against exactly the map the director saw.
 */
export function buildSegmentMap(project: Project): SegmentMap {
  const sources = project.mediaLibrary.items.filter(
    item => item.type === "video" && item.analysisRole !== "reference",
  );
  return {
    videos: sources.map(item => ({
      videoId: item.id,
      duration: item.metadata.duration,
      segments: [
        {
          id: `${item.id}-seg-0`,
          startTime: 0,
          endTime: item.metadata.duration,
          description: `${item.name} — full source (${item.metadata.duration.toFixed(1)}s)`,
          sceneType: "b-roll" as const,
          motionLevel: "medium" as const,
          hasDialogue: false,
          visualContent: item.name,
          confidence: 0.5,
        },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Hard gates
// ---------------------------------------------------------------------------

export interface ClipOverlap {
  readonly trackId: string;
  readonly trackName: string;
  readonly aId: string;
  readonly bId: string;
  readonly overlapSeconds: number;
}

/** Per-track pairwise overlap check; clips on different tracks may overlap. */
export function clipOverlaps(project: Project, epsilon = 1e-6): ClipOverlap[] {
  const overlaps: ClipOverlap[] = [];
  for (const track of project.timeline.tracks as readonly Track[]) {
    // Overlay tracks (graphics: motion moments; text: titles/captions) are
    // designed to stack on top of primary footage — only video/image/audio
    // tracks are sequential and subject to collision.
    if (track.type === "graphics" || track.type === "text") continue;
    const clips = track.clips ?? [];
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i]!;
        const b = clips[j]!;
        const aStart = a.startTime;
        const aEnd = a.startTime + a.duration;
        const bStart = b.startTime;
        const bEnd = b.startTime + b.duration;
        const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
        if (overlap > epsilon) {
          overlaps.push({
            trackId: track.id,
            trackName: track.name,
            aId: a.id,
            bId: b.id,
            overlapSeconds: overlap,
          });
        }
      }
    }
  }
  return overlaps;
}

export const TIMELINE_GAP_EPSILON_SECONDS = 0.25;
export const CAMERA_MOVE_CLIP_SHARE_MAX = 0.7;
export const TARGET_DURATION_TOLERANCE_RATIO = 0.1;
/** Increment whenever hard-gate semantics change; resume refuses older reports. */
export const BASELINE_GATE_SEMANTICS_VERSION = 2;

export interface GateResult {
  readonly passed: boolean;
  /** Short, report-ready explanation of why this gate passed or failed. */
  readonly reason: string;
}

export interface BaselineCraftGateResults {
  readonly noTimelineGaps: GateResult;
  readonly meetsTransitionMinimum: GateResult;
  readonly cameraMoveDensityOk: GateResult;
  readonly noConsecutiveIdenticalAccents: GateResult;
  readonly durationWithinTolerance: GateResult;
}

export interface BaselineGates {
  readonly planValidates: boolean;
  readonly materializes: boolean;
  readonly noClipOverlaps: boolean;
  readonly noTimelineGaps: boolean;
  readonly meetsTransitionMinimum: boolean;
  readonly cameraMoveDensityOk: boolean;
  readonly noConsecutiveIdenticalAccents: boolean;
  readonly durationWithinTolerance: boolean;
}

export type SpreadOutcome = "all_pass" | "all_fail" | "mixed" | "incomplete";

export interface CombinationSpread {
  readonly id: string;
  readonly outcome: SpreadOutcome;
  readonly validRuns: number;
  readonly expectedRuns: number;
}

type TimelineClip = Track["clips"][number];

function footageClips(track: Track): TimelineClip[] {
  return (track.clips ?? []).filter(clip => clip.metadata?.motionClip !== true);
}

/**
 * Selects the main placed-footage lane, not motion/text graphics overlays.
 * The busiest footage track wins; ties prefer greater covered duration, then
 * a video track over an image track, then the earlier timeline track.
 */
export function primaryFootageTrack(project: Project): Track | undefined {
  const candidates = project.timeline.tracks
    .map((track, index) => ({ track, index, clips: footageClips(track) }))
    .filter(({ track, clips }) => (track.type === "video" || track.type === "image") && clips.length > 0);
  candidates.sort((a, b) => {
    const clipCountDifference = b.clips.length - a.clips.length;
    if (clipCountDifference !== 0) return clipCountDifference;
    const duration = (clips: readonly TimelineClip[]): number =>
      clips.reduce((sum, clip) => sum + (Number.isFinite(clip.duration) && clip.duration > 0 ? clip.duration : 0), 0);
    const durationDifference = duration(b.clips) - duration(a.clips);
    if (durationDifference !== 0) return durationDifference;
    const videoPriority = Number(a.track.type !== "video") - Number(b.track.type !== "video");
    return videoPriority || a.index - b.index;
  });
  return candidates[0]?.track;
}

function orderedPrimaryFootageClips(project: Project): TimelineClip[] {
  const track = primaryFootageTrack(project);
  return track
    ? footageClips(track).slice().sort((a, b) => a.startTime - b.startTime)
    : [];
}

/** Maximum end time of any materialized clip, across every timeline track. */
export function materializedTimelineDuration(project: Project): number {
  return project.timeline.tracks.reduce(
    (max, track) =>
      (track.clips ?? []).reduce((inner, clip) => {
        const end = clip.startTime + clip.duration;
        return Number.isFinite(end) ? Math.max(inner, end) : inner;
      }, max),
    0,
  );
}

const gateResult = (passed: boolean, reason: string): GateResult => ({ passed, reason });

/** Checks leading and between-clip dead air on the primary footage track. */
export function evaluateNoTimelineGaps(
  project: Project | null,
  epsilonSeconds = TIMELINE_GAP_EPSILON_SECONDS,
): GateResult {
  if (!project) return gateResult(false, "No materialized project is available to inspect for footage gaps.");
  const track = primaryFootageTrack(project);
  if (!track) return gateResult(false, "No primary video/image track with placed footage was materialized.");
  const clips = footageClips(track).slice().sort((a, b) => a.startTime - b.startTime);
  if (clips.length === 0) return gateResult(false, `Primary footage track "${track.name}" contains no clips.`);
  for (const clip of clips) {
    if (!Number.isFinite(clip.startTime) || !Number.isFinite(clip.duration) || clip.duration <= 0) {
      return gateResult(false, `Primary footage clip "${clip.id}" has an invalid start or duration.`);
    }
  }

  const first = clips[0]!;
  const leadingGap = Math.max(0, first.startTime);
  if (leadingGap > epsilonSeconds + 1e-9) {
    return gateResult(
      false,
      `Primary footage track "${track.name}" starts ${leadingGap.toFixed(3)}s after timeline zero ` +
        `(maximum allowed gap ${epsilonSeconds.toFixed(3)}s).`,
    );
  }
  let largestGap = leadingGap;
  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1]!;
    const current = clips[index]!;
    const gap = current.startTime - (previous.startTime + previous.duration);
    largestGap = Math.max(largestGap, gap);
    if (gap > epsilonSeconds + 1e-9) {
      return gateResult(
        false,
        `Primary footage has a ${gap.toFixed(3)}s gap between clips "${previous.id}" and "${current.id}" ` +
          `(maximum allowed gap ${epsilonSeconds.toFixed(3)}s).`,
      );
    }
  }
  return gateResult(
    true,
    `Primary footage track "${track.name}" has ${clips.length} clip(s); largest uncovered gap ` +
      `${Math.max(0, largestGap).toFixed(3)}s is within the ${epsilonSeconds.toFixed(3)}s limit.`,
  );
}

function promptExplicitlyRequestsHardCuts(prompt: EvalPrompt): boolean {
  return /\bhard[\s-]?cuts?\s+only\b|\b(?:no|zero)\s+(?:any\s+)?transitions?\b|\bwithout\s+(?:any\s+)?transitions?\b/i.test(
    prompt.text,
  );
}

function isDetailedSpeechProject(entry: Pick<EvalProject, "id" | "category">): boolean {
  return entry.category.trim().toLowerCase() === "speech" && /^pod(?:cast)?-/i.test(entry.id);
}

/** Reads transition presence from the materialized timeline, never the tool result. */
export function evaluateTransitionMinimum(
  project: Project | null,
  prompt: EvalPrompt,
  entry: Pick<EvalProject, "id" | "category">,
): GateResult {
  if (!project) return gateResult(false, "No materialized project is available to inspect for transitions.");
  const transitionCount = project.timeline.tracks.reduce(
    (sum, track) => sum + (track.transitions?.length ?? 0),
    0,
  );
  if (promptExplicitlyRequestsHardCuts(prompt)) {
    return gateResult(
      true,
      `The prompt explicitly requests hard cuts/no transitions; the minimum is waived ` +
        `(found ${transitionCount} materialized transition(s)).`,
    );
  }
  if (prompt.type === "detailed" && isDetailedSpeechProject(entry)) {
    return gateResult(
      true,
      `Detailed speech/podcast rows may use hard cuts; the minimum is waived ` +
        `(found ${transitionCount} materialized transition(s)).`,
    );
  }
  if (transitionCount >= 1) {
    return gateResult(true, `Found ${transitionCount} materialized transition(s); the minimum is 1.`);
  }
  return gateResult(
    false,
    `Found 0 materialized transitions; this non-exempt ${prompt.type} row requires at least 1.`,
  );
}

const CAMERA_MOVE_KEYFRAME_PROPERTIES = new Set(["position.x", "position.y", "scale.x", "scale.y", "rotation"]);

function hasCompiledCameraMove(clip: TimelineClip): boolean {
  const compilerIdPrefix = `${clip.id}-move-`;
  return (clip.keyframes ?? []).some(
    keyframe =>
      typeof keyframe.id === "string" &&
      keyframe.id.startsWith(compilerIdPrefix) &&
      CAMERA_MOVE_KEYFRAME_PROPERTIES.has(keyframe.property),
  );
}

/** Counts only camera keyframes emitted by the plan materializer's compiler. */
export function evaluateCameraMoveDensity(
  project: Project | null,
  maximumShare = CAMERA_MOVE_CLIP_SHARE_MAX,
): GateResult {
  if (!project) return gateResult(false, "No materialized project is available to inspect for camera moves.");
  const track = primaryFootageTrack(project);
  if (!track) return gateResult(false, "No primary footage clips are available for the camera-move density check.");
  const eligible = footageClips(track).filter(
    clip => Number.isFinite(clip.duration) && clip.duration > 0,
  );
  if (eligible.length === 0) return gateResult(false, "No eligible primary footage clips were materialized.");
  const moving = eligible.filter(hasCompiledCameraMove).length;
  const share = moving / eligible.length;
  const percentage = (share * 100).toFixed(1);
  const limit = (maximumShare * 100).toFixed(1);
  return gateResult(
    share <= maximumShare + 1e-9,
    `${moving}/${eligible.length} eligible primary clips carry compiler-authored camera moves ` +
      `(${percentage}%; maximum ${limit}%).`,
  );
}

function effectPresetKeys(clip: TimelineClip): string[] {
  const keys = new Set<string>();
  for (const effect of clip.effects ?? []) {
    if (effect.enabled === false || typeof effect.type !== "string" || !effect.type.trim()) continue;
    const type = effect.type.trim().toLowerCase();
    const shaderId = effect.params?.["shaderId"];
    keys.add(
      typeof shaderId === "string" && shaderId.trim()
        ? `${type}:${shaderId.trim().toLowerCase()}`
        : type,
    );
  }
  return [...keys];
}

function transitionTypesBetween(project: Project, leftId: string, rightId: string): string[] {
  const types = new Set<string>();
  for (const track of project.timeline.tracks) {
    for (const transition of track.transitions ?? []) {
      const joinsPair =
        (transition.clipAId === leftId && transition.clipBId === rightId) ||
        (transition.clipAId === rightId && transition.clipBId === leftId);
      if (joinsPair && typeof transition.type === "string" && transition.type.trim()) {
        types.add(transition.type.trim().toLowerCase());
      }
    }
  }
  return [...types];
}

/**
 * Rejects identical materialized transition + outgoing-clip effect pairs on
 * immediately adjacent cuts. A shader's shaderId is its preset identity.
 */
export function evaluateNoConsecutiveIdenticalAccents(project: Project | null): GateResult {
  if (!project) return gateResult(false, "No materialized project is available to inspect for repeated accents.");
  const clips = orderedPrimaryFootageClips(project);
  if (clips.length < 3) {
    return gateResult(true, "Fewer than two adjacent cuts exist; no repeated back-to-back accent can occur.");
  }

  const accentedCuts: Array<{ cutIndex: number; signatures: Map<string, { transition: string; effect: string }> }> = [];
  for (let cutIndex = 0; cutIndex < clips.length - 1; cutIndex += 1) {
    const outgoing = clips[cutIndex]!;
    const incoming = clips[cutIndex + 1]!;
    const transitions = transitionTypesBetween(project, outgoing.id, incoming.id);
    const effects = effectPresetKeys(outgoing);
    if (transitions.length === 0 || effects.length === 0) continue;
    const signatures = new Map<string, { transition: string; effect: string }>();
    for (const transition of transitions) {
      for (const effect of effects) signatures.set(JSON.stringify([transition, effect]), { transition, effect });
    }
    accentedCuts.push({ cutIndex, signatures });
  }

  for (let index = 1; index < accentedCuts.length; index += 1) {
    const previous = accentedCuts[index - 1]!;
    const current = accentedCuts[index]!;
    if (current.cutIndex !== previous.cutIndex + 1) continue;
    for (const [signature, accent] of current.signatures) {
      if (!previous.signatures.has(signature)) continue;
      const previousLeft = clips[previous.cutIndex]!;
      const previousRight = clips[previous.cutIndex + 1]!;
      const currentRight = clips[current.cutIndex + 1]!;
      return gateResult(
        false,
        `Consecutive cuts "${previousLeft.id}→${previousRight.id}" and ` +
          `"${previousRight.id}→${currentRight.id}" repeat transition "${accent.transition}" ` +
          `with effect preset "${accent.effect}".`,
      );
    }
  }
  return gateResult(
    true,
    `No adjacent accented cuts repeat both a materialized transition type and the outgoing clip's effect preset ` +
      `(${accentedCuts.length} accented cut(s) inspected).`,
  );
}

/** Compares materialized timeline extent with EditPlan.metadata.targetDuration (seconds). */
export function evaluateDurationWithinTolerance(
  project: Project | null,
  plan: EditPlan | null,
  actualDuration?: number,
  toleranceRatio = TARGET_DURATION_TOLERANCE_RATIO,
): GateResult {
  if (!project) return gateResult(false, "No materialized project is available for the duration check.");
  const target = plan?.metadata?.targetDuration;
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
    return gateResult(false, "The EditPlan does not declare a positive metadata.targetDuration in seconds.");
  }
  const actual = actualDuration ?? materializedTimelineDuration(project);
  const minimum = target * (1 - toleranceRatio);
  const maximum = target * (1 + toleranceRatio);
  const passed = Number.isFinite(actual) && actual >= minimum - 1e-6 && actual <= maximum + 1e-6;
  return gateResult(
    passed,
    `Materialized timeline is ${Number.isFinite(actual) ? actual.toFixed(2) : String(actual)}s; ` +
      `declared target is ${target.toFixed(2)}s (allowed ${minimum.toFixed(2)}–${maximum.toFixed(2)}s, ` +
      `±${(toleranceRatio * 100).toFixed(0)}%).`,
  );
}

/** Pure materialized-project craft checks; exported so fixtures need no LLM. */
export function evaluateCraftGates(
  project: Project | null,
  plan: EditPlan | null,
  prompt: EvalPrompt,
  entry: Pick<EvalProject, "id" | "category">,
  timelineDuration?: number,
): BaselineCraftGateResults {
  return {
    noTimelineGaps: evaluateNoTimelineGaps(project),
    meetsTransitionMinimum: evaluateTransitionMinimum(project, prompt, entry),
    cameraMoveDensityOk: evaluateCameraMoveDensity(project),
    noConsecutiveIdenticalAccents: evaluateNoConsecutiveIdenticalAccents(project),
    durationWithinTolerance: evaluateDurationWithinTolerance(project, plan, timelineDuration),
  };
}

export interface BaselineCaseResult {
  readonly id: string;
  /** 0-based repeat index within the k-run sampling of this combination. */
  readonly run: number;
  readonly projectId: string;
  readonly promptId: string;
  readonly promptType: PromptType;
  readonly ok: boolean;
  /** plan_edit failure code (null when the tool call succeeded). */
  readonly toolCode: string | null;
  /**
   * True when the failure was Cloudflare quota exhaustion (HTTP 429 /
   * code 4006), not a model outcome. Excluded from gate rates.
   */
  readonly quotaExhausted: boolean;
  /**
   * True when the failure was transport/infra (fetch dropped, stream idle,
   * gateway 5xx) rather than a model outcome. Excluded from gate rates and
   * re-run on resume — a dead socket is not evidence about the model.
   */
  readonly infraFailure: boolean;
  readonly gates: BaselineGates;
  /** Per-craft-gate pass status and report-ready reason. */
  readonly gateResults: BaselineCraftGateResults;
  readonly failures: string[];
  /** Non-blocking validation warnings (do not fail a case). */
  readonly warnings: string[];
  readonly stats: {
    readonly durationMs: number;
    readonly clipCount: number;
    readonly transitionCount: number;
    readonly effectCount: number;
    readonly audioCount: number;
    readonly textCount: number;
    readonly planScore: number | null;
    readonly timelineDuration: number;
  };
  /**
   * Structural quality vs the best-matching real reference fingerprint
   * (cut granularity, rhythm, craft). Informational — never part of ok/gates.
   */
  readonly quality?: QualityScore | null;
}

export interface GateRate {
  /** Mean pass rate across runs (0..1), excluding quota and infra results. */
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stdev: number;
  /** Pass rate at each run index. */
  readonly perRun: readonly number[];
  /** Valid model-result count backing each perRun entry; quota and infra are excluded. */
  readonly validPerRun: readonly number[];
}

export interface BaselineSummary {
  readonly generatedAt: string;
  readonly model: string;
  readonly gateSemanticsVersion: number;
  readonly sampling: SamplingPinning;
  readonly runsPerCombo: number;
  /** Distinct corpus combinations (independent of repeats). */
  readonly cases: number;
  /** Case-runs attempted (cases × runsPerCombo when complete, fewer when aborted). */
  readonly total: number;
  readonly passed: number;
  /** "complete" = every case-run attempted; "aborted" = stopped early or transport rows remain. */
  readonly status: "complete" | "aborted";
  readonly abortReason?: string;
  /** Case-runs excluded from gate rates because the provider returned quota errors. */
  readonly quotaExcluded: number;
  /** Case-runs excluded from gate rates because of transport/infra failures. */
  readonly infraExcluded: number;
  readonly gateRates: {
    readonly planValidates: GateRate;
    readonly materializes: GateRate;
    readonly noClipOverlaps: GateRate;
    readonly noTimelineGaps: GateRate;
    readonly meetsTransitionMinimum: GateRate;
    readonly cameraMoveDensityOk: GateRate;
    readonly noConsecutiveIdenticalAccents: GateRate;
    readonly durationWithinTolerance: GateRate;
    readonly allGates: GateRate;
  };
  /**
   * Observed spread across k samples. Every expected combination receives an
   * explicit status; transport-only or missing samples are `incomplete`.
   */
  readonly spread: {
    readonly all_pass: number;
    readonly all_fail: number;
    readonly mixed: number;
    readonly incomplete: number;
    readonly byCombination: readonly CombinationSpread[];
  };
  readonly results: readonly BaselineCaseResult[];
  /** Aggregate quality over passing valid runs (absent when nothing scored). */
  readonly quality?: ReturnType<typeof summarizeQuality>;
}

/** Workers AI daily-free-allocation exhaustion is transport, not a model result. */
export function isQuotaMessage(text: string): boolean {
  return /\b429\b|used up your daily free allocation|code.?:?4006/.test(text);
}

/**
 * Transport/infra failure signatures the director's own retry loop has
 * already failed to recover from (see requestPlan in registry.ts). These
 * rows say nothing about the model, so gate rates exclude them and resume
 * re-runs them.
 */
export function isInfraFailureMessage(text: string): boolean {
  if (isQuotaMessage(text)) return false;
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|stream idle|aborted|AbortError|omniroute 50[234]|cloudflare-ai 5\d\d|HTTP 408|\b408\b/i.test(
    text,
  );
}

interface PlanEditData {
  readonly editPlan?: EditPlan;
  readonly plan?: EditPlan;
  readonly clipIds?: string[];
  readonly textIds?: string[];
  readonly transitionIds?: string[];
  readonly audioClipIds?: string[];
  readonly effectCount?: number;
  readonly transitionCount?: number;
  readonly audioCount?: number;
  readonly planReview?: { score?: number };
}

/**
 * transitionCount is the materializer's own count of successful
 * transition/add calls; transitionIds is diff-detected and silently 0
 * when that detection misses — prefer the authoritative one.
 */
export function resolveTransitionCount(
  data:
    | { readonly transitionCount?: number; readonly transitionIds?: readonly string[] }
    | null
    | undefined,
): number {
  return data?.transitionCount ?? data?.transitionIds?.length ?? 0;
}

function timelineClipIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const track of project.timeline.tracks as readonly Track[]) {
    for (const clip of track.clips ?? []) ids.add(clip.id);
  }
  return ids;
}

/** Runs one corpus combination through the headless director and scores it. */
export async function runBaselineCase(opts: {
  readonly entry: EvalProject;
  readonly prompt: EvalPrompt;
  readonly client: LLMClient;
  readonly root?: string;
  readonly run?: number;
  readonly references?: readonly ReferenceFingerprint[];
}): Promise<BaselineCaseResult> {
  const started = Date.now();
  const id = `${opts.entry.id}/${opts.prompt.id}`;
  const run = opts.run ?? 0;
  const failures: string[] = [];
  const warnings: string[] = [];

  let project: Project | null = null;
  let segmentMap: SegmentMap | null = null;
  let toolOk = false;
  let toolCode: string | null = null;
  let data: PlanEditData | null = null;
  let planValidates = false;
  let materializes = false;

  try {
    const built = buildBaselineProject(opts.entry, opts.root);
    project = built.project;
    segmentMap = built.segmentMap;

    // HeadlessHost only surfaces llm through the EditingHost contract.
    const host = new HeadlessHost(project) as HeadlessHost & {
      llm: NonNullable<EditingHost["llm"]>;
    };
    host.llm = { provider: "openai", client: opts.client };
    const genre = getGenreById(opts.prompt.text.trim());
    const result = await executeTool(
      "plan_edit",
      {
        prompt: opts.prompt.text,
        segmentMap,
        ...(genre ? { genreId: genre.id } : {}),
      },
      host,
    );

    toolOk = result.ok;
    toolCode = result.ok ? null : (result.error?.code ?? "UNKNOWN");
    if (!result.ok) {
      failures.push(`plan_edit failed [${toolCode}]: ${result.error?.message ?? result.summary}`);
    }

    project = host.getProject();
    data = (result.data ?? null) as PlanEditData | null;

    // Dump the produced plan either way: the accepted editPlan on success, or
    // the rejected plan the failure payload carries. Audits read these.
    const producedPlan = data?.editPlan ?? data?.plan ?? null;
    if (producedPlan) dumpPlanJson(opts.entry.id, opts.prompt.id, run, producedPlan);

    // Gate A — the produced plan validates against the segment map it was
    // given (plan_edit itself only fails on error-severity issues, so
    // re-validating here makes the gate explicit and independent).
    if (result.ok && data?.editPlan && segmentMap) {
      const issues = validateEditPlan(data.editPlan, segmentMap);
      const errors = issues.filter(issue => issue.severity === "error");
      planValidates = errors.length === 0;
      for (const issue of errors) failures.push(`plan invalid [${issue.code}]: ${issue.message}`);
      for (const issue of issues.filter(i => i.severity === "warning")) {
        warnings.push(`plan warning [${issue.code}]: ${issue.message}`);
      }
    } else if (result.ok) {
      failures.push("plan_edit returned no editPlan");
    } else if (toolCode === "EDIT_PLAN_APPLY_FAILED") {
      // plan_edit runs validateEditPlan before materializeEditPlan: reaching
      // APPLY_FAILED means the plan itself cleared validation, so gate A holds
      // even though the plan object never reaches the result payload.
      planValidates = true;
    }

    // Gate B — materialization completed with zero errors: the tool did not
    // fail/throw and every clip it claims landed on the timeline.
    if (result.ok && data?.editPlan) {
      const placed = timelineClipIds(project);
      const claimed = data.clipIds ?? [];
      const missing = claimed.filter(clipId => !placed.has(clipId));
      const timelineClips = [...placed].length;
      materializes = missing.length === 0 && timelineClips > 0 && claimed.length > 0;
      if (missing.length > 0) failures.push(`materialized clips missing from timeline: ${missing.join(", ")}`);
      if (claimed.length === 0) failures.push("materialization reported 0 clips");
    }

    // Gate C — no clip overlaps on any single track.
    const overlaps = clipOverlaps(project);
    if (overlaps.length > 0) {
      for (const overlap of overlaps) {
        failures.push(
          `clip overlap on track "${overlap.trackName}" (${overlap.trackId}): ` +
            `${overlap.aId} ∩ ${overlap.bId} = ${overlap.overlapSeconds.toFixed(3)}s`,
        );
      }
    }

    const clipCount = data?.clipIds?.length ?? 0;
    const tracks = project.timeline.tracks as readonly Track[];
    const timelineDuration = materializedTimelineDuration(project);

    // Primary-track cut rhythm and footage gates use the same visual-footage
    // lane; graphics/text overlays must never win because they contain many clips.
    const primaryTrack = primaryFootageTrack(project);
    const clipDurationsSec = (primaryTrack ? footageClips(primaryTrack) : [])
      .slice()
      .sort((a, b) => a.startTime - b.startTime)
      .map(clip => clip.duration)
      .filter(duration => Number.isFinite(duration) && duration > 0);
    // Craft counters are read back from the materialized project, never from
    // the tool's self-report: a transition/effect that silently no-ops would
    // otherwise inflate the numbers it is being graded on.
    const transitionCount = tracks.reduce(
      (sum, track) => sum + (track.transitions?.length ?? 0),
      0,
    );
    const effectCount = tracks.reduce(
      (sum, track) =>
        sum + (track.clips ?? []).reduce((inner, clip) => inner + (clip.effects?.length ?? 0), 0),
      0,
    );
    const textCount = data?.textIds?.length ?? 0;
    const quality =
      opts.references && opts.references.length > 0 && clipDurationsSec.length > 0
        ? bestQuality(
            {
              clipCount: clipDurationsSec.length,
              clipDurationsSec,
              timelineDuration,
              transitionCount,
              effectCount,
              textCount,
            },
            opts.references,
          )
        : null;

    const gateResults = evaluateCraftGates(
      project,
      data?.editPlan ?? data?.plan ?? null,
      opts.prompt,
      opts.entry,
      timelineDuration,
    );
    const craftGateLabels: Record<keyof BaselineCraftGateResults, string> = {
      noTimelineGaps: "no_timeline_gaps",
      meetsTransitionMinimum: "meets_transition_minimum",
      cameraMoveDensityOk: "camera_move_density_ok",
      noConsecutiveIdenticalAccents: "no_consecutive_identical_accents",
      durationWithinTolerance: "duration_within_tolerance",
    };
    for (const [name, gate] of Object.entries(gateResults) as [keyof BaselineCraftGateResults, GateResult][]) {
      if (!gate.passed) failures.push(`${craftGateLabels[name]}: ${gate.reason}`);
    }
    const gates: BaselineGates = {
      planValidates,
      materializes,
      noClipOverlaps: overlaps.length === 0,
      noTimelineGaps: gateResults.noTimelineGaps.passed,
      meetsTransitionMinimum: gateResults.meetsTransitionMinimum.passed,
      cameraMoveDensityOk: gateResults.cameraMoveDensityOk.passed,
      noConsecutiveIdenticalAccents: gateResults.noConsecutiveIdenticalAccents.passed,
      durationWithinTolerance: gateResults.durationWithinTolerance.passed,
    };
    const passed = Object.values(gates).every(Boolean) && toolOk;
    if (!passed && failures.length === 0) failures.push("one or more hard gates failed");

    const failureText = failures.join("\n");
    return {
      id,
      run,
      projectId: opts.entry.id,
      promptId: opts.prompt.id,
      promptType: opts.prompt.type,
      ok: passed,
      toolCode,
      quotaExhausted: toolCode !== null && isQuotaMessage(failureText),
      infraFailure: toolCode !== null && isInfraFailureMessage(failureText),
      gates,
      gateResults,
      failures,
      warnings,
      stats: {
        durationMs: Date.now() - started,
        clipCount,
        transitionCount,
        effectCount,
        audioCount: data?.audioClipIds?.length ?? 0,
        textCount,
        planScore: data?.planReview?.score ?? null,
        timelineDuration,
      },
      quality,
    };
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    const overlaps = project ? clipOverlaps(project) : null;
    const gateResults = evaluateCraftGates(
      project,
      data?.editPlan ?? data?.plan ?? null,
      opts.prompt,
      opts.entry,
    );
    const gates: BaselineGates = {
      planValidates,
      materializes,
      noClipOverlaps: overlaps !== null && overlaps.length === 0,
      noTimelineGaps: gateResults.noTimelineGaps.passed,
      meetsTransitionMinimum: gateResults.meetsTransitionMinimum.passed,
      cameraMoveDensityOk: gateResults.cameraMoveDensityOk.passed,
      noConsecutiveIdenticalAccents: gateResults.noConsecutiveIdenticalAccents.passed,
      durationWithinTolerance: gateResults.durationWithinTolerance.passed,
    };
    return {
      id,
      run,
      projectId: opts.entry.id,
      promptId: opts.prompt.id,
      promptType: opts.prompt.type,
      ok: false,
      toolCode,
      quotaExhausted: toolCode !== null && isQuotaMessage(failures.join("\n")),
      infraFailure: isInfraFailureMessage(failures.join("\n")),
      gates,
      gateResults,
      failures,
      warnings,
      stats: {
        durationMs: Date.now() - started,
        clipCount: 0,
        transitionCount: 0,
        effectCount: 0,
        audioCount: 0,
        textCount: 0,
        planScore: null,
        timelineDuration: 0,
      },
    };
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const results = new Array<R | null>(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunBaselineOptions {
  readonly client?: LLMClient;
  /** Cap the number of combinations (smoke runs). */
  readonly limit?: number;
  /** Repeats per combination (k). Baseline runs use k >= 3 for spread. */
  readonly runsPerCombo?: number;
  readonly config?: WorkersAIConfig;
  readonly concurrency?: number;
  readonly reportPath?: string;
  readonly root?: string;
  /** Directory of measured reference profiles (real-*.json). Default: evaluation-files/reference. */
  readonly referenceDir?: string;
  readonly onCase?: (result: BaselineCaseResult) => void;
  /**
   * Merge the previous report at reportPath and skip measured case-runs.
   * Quota and infra rows are dropped and re-run; reports from older gate
   * semantics are rejected rather than silently mixed into a new campaign.
   */
  readonly resume?: boolean;
}

export interface SummarizeOptions {
  readonly model: string;
  readonly cases: number;
  readonly runsPerCombo: number;
  /** Full case ids, including combinations with no valid sample. */
  readonly combinationIds?: readonly string[];
  readonly status: "complete" | "aborted";
  readonly abortReason?: string;
  readonly quotaExcluded: number;
  readonly infraExcluded: number;
}

/**
 * Builds the report summary. Quota-exhausted and infra-failed results are
 * excluded from every gate rate (transport failure ≠ model failure). Every
 * expected combination is listed in the spread table, including missing rows.
 */
export function summarizeBaseline(
  results: readonly BaselineCaseResult[],
  opts: SummarizeOptions,
): BaselineSummary {
  const valid = results.filter(r => !r.quotaExhausted && !r.infraFailure);
  const round = (n: number): number => Math.round(n * 10000) / 10000;
  const rate = (pick: (r: BaselineCaseResult) => boolean): GateRate => {
    const perRun: number[] = [];
    const validPerRun: number[] = [];
    for (let runIndex = 0; runIndex < opts.runsPerCombo; runIndex++) {
      const group = valid.filter(r => r.run === runIndex);
      validPerRun.push(group.length);
      perRun.push(group.length > 0 ? group.filter(pick).length / group.length : 0);
    }
    const mean = perRun.reduce((sum, n) => sum + n, 0) / perRun.length;
    const variance =
      perRun.length > 1
        ? perRun.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (perRun.length - 1)
        : 0;
    return {
      mean: round(mean),
      min: round(Math.min(...perRun)),
      max: round(Math.max(...perRun)),
      stdev: round(Math.sqrt(variance)),
      perRun: perRun.map(round),
      validPerRun,
    };
  };

  const expectedIds = opts.combinationIds ?? [...new Set(results.map(result => result.id))];
  const byId = new Map<string, BaselineCaseResult[]>(expectedIds.map(id => [id, []]));
  for (const result of valid) {
    const bucket = byId.get(result.id);
    if (bucket) bucket.push(result);
    else byId.set(result.id, [result]);
  }
  const spreadCounts: Record<SpreadOutcome, number> = {
    all_pass: 0,
    all_fail: 0,
    mixed: 0,
    incomplete: 0,
  };
  const byCombination: CombinationSpread[] = [];
  for (const [id, group] of byId) {
    const samplesByRun = new Map<number, BaselineCaseResult>();
    for (const result of group) {
      if (result.run >= 0 && result.run < opts.runsPerCombo) samplesByRun.set(result.run, result);
    }
    const samples = [...samplesByRun.values()];
    const passing = samples.filter(result => result.ok).length;
    const outcome: SpreadOutcome =
      samples.length < opts.runsPerCombo
        ? "incomplete"
        : passing === 0
          ? "all_fail"
          : passing === samples.length
            ? "all_pass"
            : "mixed";
    spreadCounts[outcome] += 1;
    byCombination.push({ id, outcome, validRuns: samples.length, expectedRuns: opts.runsPerCombo });
  }

  const qualitySummary = summarizeQuality(
    valid.filter(r => r.ok && r.quality).map(r => r.quality!),
  );

  return {
    generatedAt: new Date().toISOString(),
    model: opts.model,
    gateSemanticsVersion: BASELINE_GATE_SEMANTICS_VERSION,
    sampling: PINNED_SAMPLING,
    runsPerCombo: opts.runsPerCombo,
    cases: opts.cases,
    total: results.length,
    passed: valid.filter(r => r.ok).length,
    status: opts.status,
    ...(opts.abortReason ? { abortReason: opts.abortReason } : {}),
    quotaExcluded: opts.quotaExcluded,
    infraExcluded: opts.infraExcluded,
    gateRates: {
      planValidates: rate(r => r.gates.planValidates),
      materializes: rate(r => r.gates.materializes),
      noClipOverlaps: rate(r => r.gates.noClipOverlaps),
      noTimelineGaps: rate(r => r.gates.noTimelineGaps),
      meetsTransitionMinimum: rate(r => r.gates.meetsTransitionMinimum),
      cameraMoveDensityOk: rate(r => r.gates.cameraMoveDensityOk),
      noConsecutiveIdenticalAccents: rate(r => r.gates.noConsecutiveIdenticalAccents),
      durationWithinTolerance: rate(r => r.gates.durationWithinTolerance),
      allGates: rate(r => r.ok),
    },
    spread: { ...spreadCounts, byCombination },
    ...(qualitySummary ? { quality: qualitySummary } : {}),
    results,
  };
}

/** Runs every corpus project × prompt combination and writes the report. */
export async function runBaseline(opts: RunBaselineOptions = {}): Promise<BaselineSummary> {
  const root = opts.root ?? CORPUS_DIR;
  const corpus = loadCorpus(opts.root ? resolve(opts.root, "projects.json") : CORPUS_PATH);
  const missing = missingAssets(corpus, root);
  if (missing.length > 0) {
    throw new Error(`Corpus asset gate failed:\n${missing.join("\n")}`);
  }

  const llmConfig: EvalLLMConfig | null = opts.client
    ? null
    : opts.config
      ? { kind: "workers", config: opts.config }
      : resolveEvalLLMConfig();
  const client =
    opts.client ??
    (llmConfig
      ? llmConfig.kind === "omni"
        ? makeOmniRouteClient(llmConfig.config)
        : makeWorkersAIClient(llmConfig.config)
      : null);
  if (!client) {
    throw new Error(
      "No LLM credentials (set KOVE_EVAL_OMNIROUTE_KEY + KOVE_EVAL_OMNIROUTE_MODEL for a local gateway, or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for Workers AI).",
    );
  }

  const runsPerCombo = Math.max(1, opts.runsPerCombo ?? 1);
  const references = loadReferenceFingerprints(
    opts.referenceDir ?? resolve(root, "reference"),
  );
  const combos = corpus
    .flatMap(entry => entry.prompts.map(prompt => ({ entry, prompt })))
    .slice(0, Math.max(1, opts.limit ?? Number.MAX_SAFE_INTEGER));
  const reportPath = opts.reportPath ?? DEFAULT_REPORT_PATH;

  let priorResults: BaselineCaseResult[] = [];
  let priorModel: string | null = null;
  let priorGateSemanticsVersion: number | null = null;
  let priorReportParsed = false;
  if (opts.resume) {
    const fromJournal = loadRowsJournal(rowsPathFor(reportPath));
    if (fromJournal.length > 0) priorResults = fromJournal;
    if (existsSync(reportPath)) {
      try {
        const prior = JSON.parse(readFileSync(reportPath, "utf8")) as Partial<BaselineSummary>;
        priorReportParsed = true;
        priorModel = typeof prior.model === "string" ? prior.model : null;
        priorGateSemanticsVersion =
          typeof prior.gateSemanticsVersion === "number" ? prior.gateSemanticsVersion : null;
        if (priorResults.length === 0) {
          priorResults = [...(prior.results ?? [])];
        }
      } catch {
        // Unreadable prior report: journal (if any) still stands.
      }
    }
    if (priorReportParsed && priorGateSemanticsVersion !== BASELINE_GATE_SEMANTICS_VERSION) {
      throw new Error(
        `Refusing to resume: ${reportPath} uses gate semantics version ` +
          `${priorGateSemanticsVersion ?? "unknown"}, not ${BASELINE_GATE_SEMANTICS_VERSION}. ` +
          `Archive the old report and its rows journal, then start a fresh campaign.`,
      );
    }
    // Transport rows were never measured — they are exactly what a resume
    // re-runs, alongside quota rows.
    priorResults = priorResults.filter(result => !result.quotaExhausted && !result.infraFailure);
    if (priorResults.some(result => !("gateResults" in result))) {
      throw new Error(
        `Refusing to resume: ${reportPath} contains rows from before the craft gates. ` +
          `Archive the old report and its rows journal, then start a fresh campaign.`,
      );
    }
    const nextModel = llmConfig?.config.model ?? null;
    if (priorModel && nextModel && priorModel !== nextModel) {
      throw new Error(
        `Refusing to resume: ${reportPath} was measured with model "${priorModel}" but the current config is "${nextModel}". ` +
          `One report per model — move the old report aside and start fresh.`,
      );
    }
  }
  const done = new Set(priorResults.map(result => `${result.id}|${result.run}`));
  const work = combos
    .flatMap(combo => Array.from({ length: runsPerCombo }, (_, run) => ({ ...combo, run })))
    .filter(item => !done.has(`${item.entry.id}/${item.prompt.id}|${item.run}`));
  let quotaHit = false;
  const rowsPath = rowsPathFor(reportPath);
  if (work.length > 0) mkdirSync(dirname(rowsPath), { recursive: true });
  const fresh = await mapLimit(work, opts.concurrency ?? 3, async item => {
    // Stop scheduling as soon as the provider reports quota exhaustion: further
    // calls are guaranteed transport failures and would only pollute the report.
    if (quotaHit) return null;
    const result = await runBaselineCase({
      entry: item.entry,
      prompt: item.prompt,
      client,
      root,
      run: item.run,
      references,
    });
    if (result.quotaExhausted) quotaHit = true;
    // Durable journal: a mid-run crash (or harness timeout) keeps every row
    // that has already settled.
    try {
      appendFileSync(rowsPath, `${JSON.stringify(result)}\n`, "utf8");
    } catch {
      // The report at the end is the contract; the journal is best-effort.
    }
    opts.onCase?.(result);
    return result;
  });
  const settled = [
    ...priorResults,
    ...fresh.filter((r): r is BaselineCaseResult => r !== null),
  ];

  const expected = combos.length * runsPerCombo;
  const quotaExcluded = settled.filter(r => r.quotaExhausted).length;
  const infraExcluded = settled.filter(r => !r.quotaExhausted && r.infraFailure).length;
  const summary = summarizeBaseline(settled, {
    model: llmConfig?.config.model ?? "injected-client",
    cases: combos.length,
    runsPerCombo,
    combinationIds: combos.map(combo => `${combo.entry.id}/${combo.prompt.id}`),
    status: settled.length === expected && quotaExcluded === 0 && infraExcluded === 0 ? "complete" : "aborted",
    ...(settled.length === expected && quotaExcluded === 0 && infraExcluded === 0
      ? {}
      : {
          abortReason: quotaHit
            ? `Workers AI quota exhausted after ${settled.length}/${expected} case-runs ` +
                `(${quotaExcluded} quota errors)`
            : infraExcluded > 0
              ? `stopped after ${settled.length}/${expected} case-runs (${infraExcluded} infra failures)`
              : `stopped after ${settled.length}/${expected} case-runs`,
        }),
    quotaExcluded,
    infraExcluded,
  });

  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
