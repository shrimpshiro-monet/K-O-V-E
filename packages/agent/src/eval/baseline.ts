import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { Track } from "@kove-advanced/core/types/timeline";
import type { EditPlan, SegmentMap } from "@kove-advanced/creation-schema";
import { validateEditPlan } from "@kove-advanced/creation-schema";
import { HeadlessHost } from "../headless-host";
import type { EditingHost } from "../host";
import { executeTool } from "../executor";
import {
  makeClientFromSend,
  withRetry,
  llmHttpError,
  parseRetryAfterMs,
} from "../llm";
import type { LLMClient, LLMSend } from "../llm";
import { getGenreById } from "../director";
import { loadCorpus, missingAssets, resolveCorpusFile } from "./corpus";
import type { EvalProject, EvalPrompt, PromptType } from "./corpus";

export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");
export const CORPUS_DIR = resolve(REPO_ROOT, "evaluation-files");
export const CORPUS_PATH = resolve(CORPUS_DIR, "projects.json");
export const DEFAULT_REPORT_PATH = resolve(CORPUS_DIR, "baseline-v0.json");

// ---------------------------------------------------------------------------
// Cloudflare Workers AI client (same endpoint/shape the web app uses)
// ---------------------------------------------------------------------------

export interface WorkersAIConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly model: string;
}

/** Parses KEY=VALUE lines; quotes and comments are tolerated. */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Credential precedence: eval-scoped `KOVE_EVAL_CLOUDFLARE_*` (lets a second
 * account key be exported without disturbing the web app's credentials) →
 * generic `CLOUDFLARE_*` env → the repo's `.dev.vars`. Token and account id
 * must come from the same Cloudflare account or requests 403.
 */
export function loadWorkersAIConfig(repoRoot: string = REPO_ROOT): WorkersAIConfig | null {
  let vars: Record<string, string> = {};
  const devVars = resolve(repoRoot, ".dev.vars");
  if (existsSync(devVars)) {
    vars = parseDevVars(readFileSync(devVars, "utf8"));
  }
  const pick = (name: string): string =>
    process.env[`KOVE_EVAL_${name}`] || process.env[name] || vars[name] || "";
  const accountId = pick("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = pick("CLOUDFLARE_API_TOKEN");
  const model = pick("CLOUDFLARE_AI_MODEL") || "@cf/google/gemma-4-26b-a4b-it";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken, model };
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
 * Pinned sampling for reproducible evals. `temperature: 0` (greedy) plus a
 * fixed seed are injected into every request body; Workers AI accepts both
 * (verified: POST with temperature+seed returns 200).
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
 * the Authorization header only and is never stored or logged.
 */
export function makeWorkersAISend(cfg: WorkersAIConfig, opts: WorkersAIClientOptions = {}): LLMSend {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1/chat/completions`;
  return async (body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw llmHttpError(
        "cloudflare-ai",
        res.status,
        text,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }
    return res.json();
  };
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

export interface BaselineGates {
  readonly planValidates: boolean;
  readonly materializes: boolean;
  readonly noClipOverlaps: boolean;
}

export type PlanIssue = ReturnType<typeof validateEditPlan>[number];

/** Failure-only payload too large for the report body: written to a sidecar file. */
export interface FailureArtifact {
  readonly editPlan: EditPlan;
  readonly issues: readonly PlanIssue[];
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
  readonly gates: BaselineGates;
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
   * Plan + issues captured for a failed case. In-memory only: `serializeCaseResult`
   * writes it to a sidecar file and strips it before the report is serialized.
   */
  readonly artifact?: FailureArtifact;
  /** Sidecar filename for this row's failure payload, relative to the report file. */
  readonly failureArtifact?: string;
}

export interface GateRate {
  /** Mean pass rate across runs (0..1), over non-quota results only. */
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly stdev: number;
  /** Pass rate at each run index. */
  readonly perRun: readonly number[];
  /** Valid (non-quota) result count backing each perRun entry. */
  readonly validPerRun: readonly number[];
}

export interface BaselineSummary {
  readonly generatedAt: string;
  readonly model: string;
  readonly sampling: SamplingPinning;
  readonly runsPerCombo: number;
  /**
   * sha256 of the corpus file bytes this run measured. Live runs happen
   * against whatever corpus the checkout holds (clean-clone synthetic or a
   * local real-media corpus), and two corpora may share project ids — a
   * report that does not pin its corpus can be silently cross-attributed.
   */
  readonly corpusFingerprint: string;
  /** Distinct corpus combinations (independent of repeats). */
  readonly cases: number;
  /** Case-runs attempted (cases × runsPerCombo when complete, fewer when aborted). */
  readonly total: number;
  readonly passed: number;
  /** "complete" = every case-run attempted; "aborted" = stopped early (quota). */
  readonly status: "complete" | "aborted";
  readonly abortReason?: string;
  /** Case-runs excluded from gate rates because the provider returned quota errors. */
  readonly quotaExcluded: number;
  readonly gateRates: {
    readonly planValidates: GateRate;
    readonly materializes: GateRate;
    readonly noClipOverlaps: GateRate;
    readonly allGates: GateRate;
  };
  /**
   * Per-combination agreement across runs: `allPass`/`allFail` are stable
   * outcomes, `mixed` means the combination is sampling-sensitive.
   */
  readonly determinism: {
    readonly allPass: number;
    readonly allFail: number;
    readonly mixed: number;
    readonly mixedIds: readonly string[];
    /** Combinations with fewer than runsPerCombo valid results. */
    readonly incomplete: number;
    readonly incompleteIds: readonly string[];
  };
  readonly results: readonly BaselineCaseResult[];
}

/** Workers AI daily-free-allocation exhaustion is transport, not a model result. */
export function isQuotaMessage(text: string): boolean {
  return /\b429\b|used up your daily free allocation|code.?:?4006/.test(text);
}

// ---------------------------------------------------------------------------
// Duration fidelity — WARN level only. Never feeds planValidates/materializes/
// noClipOverlaps/allGates, so v0 gate rates stay stitchable with new runs.
// ---------------------------------------------------------------------------

export interface DurationTarget {
  /** First mention's hi end, in seconds. Null when the prompt names no duration. */
  readonly target: number | null;
  /** Every raw matched substring, in order — quoted verbatim in the warning. */
  readonly mentions: readonly string[];
}

/**
 * Reads the brief's target length: first mention decides, ranges take the hi end.
 * "Cut a 45-second Short ... hit roughly one point every 12-15 seconds" → 45s.
 */
export function promptDurationTarget(promptText: string): DurationTarget {
  const mentions: string[] = [];
  let target: number | null = null;
  const pattern =
    /(\d+(?:\.\d+)?)(?:\s*(?:-|–|—|to|through)\s*(\d+(?:\.\d+)?))?\s*-?\s*(seconds?|secs?|s|minutes?|mins?)(?![a-z0-9])/gi;
  for (const match of promptText.matchAll(pattern)) {
    mentions.push(match[0]);
    if (target !== null) continue;
    const lo = Number(match[1]);
    const hi = match[2] !== undefined ? Number(match[2]) : lo;
    const unit = match[3].toLowerCase();
    target = Math.max(lo, hi) * (unit.startsWith("min") ? 60 : 1);
  }
  return { target, mentions };
}

function formatSeconds(value: number): string {
  return `${Math.round(value * 10) / 10}s`;
}

/**
 * `[duration_fidelity]` entry for a produced timeline outside [0.25x, 2x] of
 * the brief. Returns null when the prompt names no duration, when nothing was
 * produced (timelineDuration 0 — failures[] already says so), or when the edit
 * is in band: the channel exists to catch the passed row with an absurd length.
 */
export function durationFidelityWarning(
  promptText: string,
  timelineDuration: number,
): string | null {
  if (timelineDuration <= 0) return null;
  const { target, mentions } = promptDurationTarget(promptText);
  if (target === null) return null;
  if (timelineDuration >= target * 0.25 && timelineDuration <= target * 2) return null;
  return (
    `[duration_fidelity] timeline ${formatSeconds(timelineDuration)} vs ~${formatSeconds(target)} brief ` +
    `(mentions found: ${mentions.map(mention => `"${mention}"`).join(", ")})`
  );
}

interface PlanEditData {
  readonly editPlan?: EditPlan;
  readonly clipIds?: string[];
  readonly textIds?: string[];
  readonly transitionIds?: string[];
  readonly audioClipIds?: string[];
  readonly effectCount?: number;
  readonly transitionCount?: number;
  readonly audioCount?: number;
  readonly planReview?: { score?: number };
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
    const timelineDuration = tracks.reduce(
      (max, track) =>
        (track.clips ?? []).reduce(
          (inner, clip) => Math.max(inner, clip.startTime + clip.duration),
          max,
        ),
      0,
    );

    const gates: BaselineGates = { planValidates, materializes, noClipOverlaps: overlaps.length === 0 };
    const passed = gates.planValidates && gates.materializes && gates.noClipOverlaps && toolOk;
    if (!passed && failures.length === 0) failures.push("one or more hard gates failed");

    // Warn-level only — appended after the gates are computed so it can never
    // feed planValidates / materializes / noClipOverlaps / allGates.
    const durationWarning = durationFidelityWarning(opts.prompt.text, timelineDuration);
    if (durationWarning) warnings.push(durationWarning);

    // Failed cases keep their plan for a sidecar file. `editPlan` is
    // non-enumerable on the plan_edit fail() payload (so the model's
    // tool_result stays byte-identical) — direct property access is the read.
    const artifact: FailureArtifact | undefined =
      !toolOk && data?.editPlan && segmentMap
        ? {
            editPlan: data.editPlan,
            issues:
              (result.data as { issues?: readonly PlanIssue[] } | undefined)?.issues ??
              validateEditPlan(data.editPlan, segmentMap),
          }
        : undefined;

    return {
      id,
      run,
      projectId: opts.entry.id,
      promptId: opts.prompt.id,
      promptType: opts.prompt.type,
      ok: passed,
      toolCode,
      quotaExhausted: toolCode !== null && isQuotaMessage(failures.join("\n")),
      gates,
      failures,
      warnings,
      ...(artifact ? { artifact } : {}),
      stats: {
        durationMs: Date.now() - started,
        clipCount,
        transitionCount: data?.transitionIds?.length ?? 0,
        effectCount: data?.effectCount ?? 0,
        audioCount: data?.audioClipIds?.length ?? 0,
        textCount: data?.textIds?.length ?? 0,
        planScore: data?.planReview?.score ?? null,
        timelineDuration,
      },
    };
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    const overlaps = project ? clipOverlaps(project) : null;
    const gates: BaselineGates = {
      planValidates,
      materializes,
      noClipOverlaps: overlaps !== null && overlaps.length === 0,
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
      gates,
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
  /** Start index into the flattened corpus combinations (paired with limit for slices). */
  readonly offset?: number;
  /**
   * Exact combination ids (`projectId/promptId`) to run; when non-empty this
   * wins over offset/limit, and corpus order is preserved so report rows stay
   * comparable across split runs. Lets mixed-k samplings target a stratified
   * subset (e.g. k=3 on half the corpus, k=1 on the other half).
   */
  readonly includeIds?: readonly string[];
  /** Repeats per combination (k). Baseline runs use k >= 3 for spread. */
  readonly runsPerCombo?: number;
  readonly config?: WorkersAIConfig;
  readonly concurrency?: number;
  readonly reportPath?: string;
  readonly root?: string;
  readonly onCase?: (result: BaselineCaseResult) => void;
}

/**
 * Selects corpus combinations for a run. `includeIds` (exact
 * `projectId/promptId` ids) wins when non-empty and preserves corpus order;
 * otherwise the flattened combos are sliced with offset/limit. Unknown
 * include ids fail fast here — before a single provider call is made.
 */
export function selectCombos(
  all: readonly { entry: EvalProject; prompt: EvalPrompt }[],
  opts: { offset?: number; limit?: number; includeIds?: readonly string[] },
): { entry: EvalProject; prompt: EvalPrompt }[] {
  const includeIds = (opts.includeIds ?? []).map(id => id.trim()).filter(id => id.length > 0);
  if (includeIds.length > 0) {
    const wanted = new Set(includeIds);
    const present = new Set(all.map(c => `${c.entry.id}/${c.prompt.id}`));
    const unknown = [...wanted].filter(id => !present.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown corpus combos: ${unknown.sort().join(", ")}`);
    }
    return all.filter(c => wanted.has(`${c.entry.id}/${c.prompt.id}`));
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? Number.MAX_SAFE_INTEGER);
  return all.slice(offset, offset + limit);
}

export interface SummarizeOptions {
  readonly model: string;
  readonly cases: number;
  readonly runsPerCombo: number;
  readonly status: "complete" | "aborted";
  readonly abortReason?: string;
  readonly quotaExcluded: number;
  readonly corpusFingerprint: string;
}

/** sha256 of the corpus file bytes — pins every report to the exact corpus it ran. */
export function fingerprintCorpusFile(corpusFile: string): string {
  return createHash("sha256").update(readFileSync(corpusFile)).digest("hex");
}

/**
 * Builds the report summary. Quota-exhausted results are excluded from every
 * gate rate (transport failure ≠ model failure); determinism only considers
 * combinations with non-quota results.
 */
export function summarizeBaseline(
  results: readonly BaselineCaseResult[],
  opts: SummarizeOptions,
): BaselineSummary {
  const valid = results.filter(r => !r.quotaExhausted);
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

  const byId = new Map<string, BaselineCaseResult[]>();
  for (const result of valid) {
    const bucket = byId.get(result.id) ?? [];
    bucket.push(result);
    byId.set(result.id, bucket);
  }
  const mixedIds: string[] = [];
  const incompleteIds: string[] = [];
  let allPass = 0;
  let allFail = 0;
  for (const [id, group] of byId) {
    // A single valid result is not evidence of stability — require the
    // full k-run sample before classifying a combination.
    if (group.length < opts.runsPerCombo) {
      incompleteIds.push(id);
      continue;
    }
    const passing = group.filter(r => r.ok).length;
    if (passing === 0) allFail += 1;
    else if (passing === group.length) allPass += 1;
    else mixedIds.push(id);
  }

  return {
    generatedAt: new Date().toISOString(),
    model: opts.model,
    sampling: PINNED_SAMPLING,
    runsPerCombo: opts.runsPerCombo,
    corpusFingerprint: opts.corpusFingerprint,
    cases: opts.cases,
    total: results.length,
    passed: valid.filter(r => r.ok).length,
    status: opts.status,
    ...(opts.abortReason ? { abortReason: opts.abortReason } : {}),
    quotaExcluded: opts.quotaExcluded,
    gateRates: {
      planValidates: rate(r => r.gates.planValidates),
      materializes: rate(r => r.gates.materializes),
      noClipOverlaps: rate(r => r.gates.noClipOverlaps),
      allGates: rate(r => r.ok),
    },
    determinism: {
      allPass,
      allFail,
      mixed: mixedIds.length,
      mixedIds,
      incomplete: incompleteIds.length,
      incompleteIds,
    },
    results,
  };
}

/**
 * Writes a failed case's payload to `<report>.failures/<combo>#run<N>.json` and
 * returns the report row pointing at it. The plan never lands in the report
 * body — only the sidecar filename does.
 *
 * Built from named fields, never `JSON.stringify(result.data)`: `editPlan` is
 * non-enumerable on the plan_edit fail() payload, so a wholesale stringify of
 * the data object would silently omit the plan from the artifact.
 */
export function serializeCaseResult(
  result: BaselineCaseResult,
  reportPath: string,
): BaselineCaseResult {
  const { artifact, ...row } = result;
  if (!artifact || result.ok || result.quotaExhausted) return row;
  const relative = `${basename(reportPath)}.failures/${result.id}#run${result.run}.json`;
  const target = join(dirname(reportPath), relative);
  mkdirSync(dirname(target), { recursive: true });
  const payload = {
    id: result.id,
    run: result.run,
    projectId: result.projectId,
    promptId: result.promptId,
    promptType: result.promptType,
    toolCode: result.toolCode,
    failures: result.failures,
    warnings: result.warnings,
    issues: artifact.issues,
    editPlan: artifact.editPlan,
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { ...row, failureArtifact: relative };
}

/** Runs every selected corpus project × prompt combination and writes the report. */
export async function runBaseline(opts: RunBaselineOptions = {}): Promise<BaselineSummary> {
  const root = opts.root ?? CORPUS_DIR;
  const corpusFile = opts.root ? resolve(opts.root, "projects.json") : CORPUS_PATH;
  const corpus = loadCorpus(corpusFile);
  const corpusFingerprint = fingerprintCorpusFile(corpusFile);
  const missing = missingAssets(corpus, root);
  if (missing.length > 0) {
    throw new Error(`Corpus asset gate failed:\n${missing.join("\n")}`);
  }

  const config = opts.config ?? loadWorkersAIConfig();
  const client = opts.client ?? (config ? makeWorkersAIClient(config) : null);
  if (!client) {
    throw new Error("No Workers AI credentials (set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID or provide .dev.vars).");
  }

  const runsPerCombo = Math.max(1, opts.runsPerCombo ?? 1);
  const combos = selectCombos(
    corpus.flatMap(entry => entry.prompts.map(prompt => ({ entry, prompt }))),
    { offset: opts.offset, limit: opts.limit, includeIds: opts.includeIds },
  );
  const work = combos.flatMap(combo =>
    Array.from({ length: runsPerCombo }, (_, run) => ({ ...combo, run })),
  );
  let quotaHit = false;
  const results = await mapLimit(work, opts.concurrency ?? 3, async item => {
    // Stop scheduling as soon as the provider reports quota exhaustion: further
    // calls are guaranteed transport failures and would only pollute the report.
    if (quotaHit) return null;
    const result = await runBaselineCase({
      entry: item.entry,
      prompt: item.prompt,
      client,
      root,
      run: item.run,
    });
    if (result.quotaExhausted) quotaHit = true;
    opts.onCase?.(result);
    return result;
  });
  const settled = results.filter((r): r is BaselineCaseResult => r !== null);

  const expected = combos.length * runsPerCombo;
  const quotaExcluded = settled.filter(r => r.quotaExhausted).length;
  const reportPath = opts.reportPath ?? DEFAULT_REPORT_PATH;
  // Sidecars are written before summarizing, so report rows carry only the
  // artifact filename — the plan itself never lands in the report body.
  const rows = settled.map(result => serializeCaseResult(result, reportPath));
  const summary = summarizeBaseline(rows, {
    model: config?.model ?? "injected-client",
    cases: combos.length,
    runsPerCombo,
    corpusFingerprint,
    status: settled.length === expected && quotaExcluded === 0 ? "complete" : "aborted",
    ...(settled.length === expected && quotaExcluded === 0
      ? {}
      : {
          abortReason: quotaHit
            ? `Workers AI quota exhausted after ${settled.length}/${expected} case-runs ` +
                `(${quotaExcluded} quota errors)`
            : `stopped after ${settled.length}/${expected} case-runs`,
        }),
    quotaExcluded,
  });

  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}