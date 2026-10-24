import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import type { Clip, Track, Transition } from "@kove-advanced/core/types/timeline";
import type { EditPlan } from "@kove-advanced/creation-schema";
import {
  BASELINE_GATE_SEMANTICS_VERSION,
  CAMERA_MOVE_CLIP_SHARE_MAX,
  DEFAULT_REPORT_PATH,
  PINNED_SAMPLING,
  buildBaselineProject,
  buildSegmentMap,
  clipOverlaps,
  evaluateCameraMoveDensity,
  evaluateCraftGates,
  evaluateDurationWithinTolerance,
  evaluateNoConsecutiveIdenticalAccents,
  evaluateNoTimelineGaps,
  evaluateTransitionMinimum,
  TIMELINE_GAP_EPSILON_SECONDS,
  loadOmniRouteConfig,
  loadWorkersAIConfig,
  makeOmniRouteSend,
  parseDevVars,
  isQuotaMessage,
  isInfraFailureMessage,
  pinnedSend,
  resolveEvalLLMConfig,
  runBaseline,
  resolveTransitionCount,
  summarizeBaseline,
  REPO_ROOT,
} from "./baseline";
import { loadCorpus, missingAssets } from "./corpus";
import { CORPUS_PATH } from "./baseline";

const LIVE = process.env.KOVE_EVAL_BASELINE === "1";
const LIMIT = Number(process.env.KOVE_EVAL_LIMIT ?? "0") || undefined;
/** Repeats per combination (k). k >= 3 so gate rates carry a spread. */
const RUNS = Number(process.env.KOVE_EVAL_RUNS ?? "3") || 3;
/** Merge the previous report and skip already-measured case-runs. */
const RESUME = process.env.KOVE_EVAL_RESUME === "1";
const reportPath = LIMIT
  ? new URL("../../../../evaluation-files/baseline-smoke.json", import.meta.url).pathname
  : undefined;

function syntheticProject(tracks: Track[]): Project {
  const now = Date.now();
  return {
    id: "synthetic",
    name: "synthetic",
    createdAt: now,
    modifiedAt: now,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks, subtitles: [], duration: 0, markers: [] },
  };
}

interface SyntheticClip {
  readonly id: string;
  readonly startTime: number;
  readonly duration: number;
  readonly effects?: Clip["effects"];
  readonly keyframes?: Clip["keyframes"];
  readonly metadata?: Clip["metadata"];
}

interface SyntheticTrackOptions {
  readonly id?: string;
  readonly name?: string;
  readonly type?: Track["type"];
  readonly transitions?: Track["transitions"];
}

function trackWith(clips: SyntheticClip[], options: SyntheticTrackOptions = {}): Track {
  const trackId = options.id ?? "v1";
  return {
    id: trackId,
    type: options.type ?? "video",
    name: options.name ?? "Video 1",
    clips: clips.map(clip => ({
      id: clip.id,
      mediaId: "video-1",
      trackId,
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: 0,
      outPoint: clip.duration,
      effects: clip.effects ?? [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: clip.keyframes ?? [],
      ...(clip.metadata ? { metadata: clip.metadata } : {}),
    })),
    transitions: options.transitions ?? [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  } as unknown as Track;
}

function syntheticEditPlan(targetDuration: number): EditPlan {
  return {
    segments: [],
    textElements: [],
    effects: [],
    transitions: [],
    audioDecisions: [],
    metadata: {
      targetDuration,
      targetPlatform: "test",
      genre: "test",
      pacing: "medium",
      rationale: "Synthetic unit-test plan.",
    },
  };
}

function syntheticTransition(clipAId: string, clipBId: string, type = "crossfade"): Transition {
  return {
    id: `${clipAId}-${clipBId}-transition`,
    clipAId,
    clipBId,
    type: type as Transition["type"],
    duration: 0.25,
    params: {},
  };
}

function syntheticGateResults(passed: boolean) {
  const result = { passed, reason: "Synthetic gate result." };
  return {
    noTimelineGaps: result,
    meetsTransitionMinimum: result,
    cameraMoveDensityOk: result,
    noConsecutiveIdenticalAccents: result,
    durationWithinTolerance: result,
  };
}

const corpusAvailable = existsSync(CORPUS_PATH);
const corpusMissingAssets = corpusAvailable ? missingAssets(loadCorpus(CORPUS_PATH), `${REPO_ROOT}/evaluation-files`) : [];
const corpusReady = corpusAvailable && corpusMissingAssets.length === 0;
const corpusTest = corpusReady ? it : it.skip;
const corpusSkipReason = !corpusAvailable
  ? "evaluation corpus not present"
  : `${corpusMissingAssets.length} evaluation media asset(s) are absent`;
const corpusTitle = (title: string) => corpusReady ? title : `${title} (skipped: ${corpusSkipReason})`;

describe("baseline harness helpers", () => {
  corpusTest(corpusTitle("loads the corpus and passes the asset-existence gate"), () => {
    const corpus = loadCorpus(CORPUS_PATH);
    expect(corpus).toHaveLength(9);
    expect(missingAssets(corpus, `${REPO_ROOT}/evaluation-files`)).toEqual([]);
  });

  it("parses .dev.vars style key/value lines", () => {
    const parsed = parseDevVars('# comment\nFOO=bar\nQUOTED="a b"\n\nEMPTY=\n');
    expect(parsed).toEqual({ FOO: "bar", QUOTED: "a b", EMPTY: "" });
  });

  corpusTest(corpusTitle("builds a project with probed metadata and a reference-free segment map"), () => {
    const corpus = loadCorpus(CORPUS_PATH);
    const game = corpus.find(entry => entry.id === "game-01");
    expect(game).toBeDefined();

    const { project, segmentMap } = buildBaselineProject(game!);
    const items = project.mediaLibrary.items;
    expect(items.filter(item => item.type === "video")).toHaveLength(2); // 1 source + reference
    expect(items.some(item => item.analysisRole === "reference")).toBe(true);
    for (const item of items) expect(item.metadata.duration).toBeGreaterThan(0);

    // Reference footage must never become cuttable baseline material.
    expect(segmentMap.videos.map(video => video.videoId)).toEqual(["video-1"]);
    for (const video of segmentMap.videos) expect(video.segments).toHaveLength(1);
  });

  corpusTest(corpusTitle("builds a segment map identical to plan_edit's metadata fallback shape"), () => {
    const corpus = loadCorpus(CORPUS_PATH);
    const { project } = buildBaselineProject(corpus.find(entry => entry.id === "pod-02")!);
    const map = buildSegmentMap(project);
    expect(map.videos).toHaveLength(1);
    const [video] = map.videos;
    expect(video!.segments[0]).toMatchObject({ startTime: 0, endTime: video!.duration, confidence: 0.5 });
  });

  it("detects same-track clip overlaps and passes adjacent clips", () => {
    const overlapping = syntheticProject([
      trackWith([
        { id: "a", startTime: 0, duration: 4 },
        { id: "b", startTime: 3, duration: 2 },
      ]),
    ]);
    const overlaps = clipOverlaps(overlapping);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({ aId: "a", bId: "b", overlapSeconds: 1 });

    const adjacent = syntheticProject([
      trackWith([
        { id: "a", startTime: 0, duration: 4 },
        { id: "b", startTime: 4, duration: 2 },
      ]),
    ]);
    expect(clipOverlaps(adjacent)).toEqual([]);
  });

  it("gates primary-footage gaps with a 0.25-second epsilon", () => {
    expect(TIMELINE_GAP_EPSILON_SECONDS).toBe(0.25);
    const withinEpsilon = syntheticProject([
      trackWith([
        { id: "a", startTime: 0, duration: 1 },
        { id: "b", startTime: 1 + TIMELINE_GAP_EPSILON_SECONDS - 0.001, duration: 1 },
      ]),
    ]);
    const pass = evaluateNoTimelineGaps(withinEpsilon);
    expect(pass.passed).toBe(true);
    expect(pass.reason).toContain("largest uncovered gap");
    const leadingGap = evaluateNoTimelineGaps(
      syntheticProject([trackWith([{ id: "late-start", startTime: TIMELINE_GAP_EPSILON_SECONDS + 0.001, duration: 1 }])]),
    );
    expect(leadingGap.passed).toBe(false);
    expect(leadingGap.reason).toContain("starts 0.251s after timeline zero");

    const overEpsilon = syntheticProject([
      trackWith([
        { id: "a", startTime: 0, duration: 1 },
        { id: "b", startTime: 1 + TIMELINE_GAP_EPSILON_SECONDS + 0.001, duration: 1 },
      ]),
    ]);
    const fail = evaluateNoTimelineGaps(overEpsilon);
    expect(fail.passed).toBe(false);
    expect(fail.reason).toContain("0.251s gap");

    const primaryFootage = trackWith(
      [
        { id: "shot-1", startTime: 0, duration: 1 },
        { id: "shot-2", startTime: 1, duration: 1 },
      ],
      { id: "footage", name: "Footage" },
    );
    const graphicOverlay = trackWith(
      [
        { id: "overlay-1", startTime: 5, duration: 0.2 },
        { id: "overlay-2", startTime: 8, duration: 0.2 },
        { id: "overlay-3", startTime: 11, duration: 0.2 },
      ],
      { id: "graphics", name: "Graphics", type: "graphics" },
    );
    const overlaysIgnored = evaluateNoTimelineGaps(syntheticProject([primaryFootage, graphicOverlay]));
    expect(overlaysIgnored.passed).toBe(true);
    expect(overlaysIgnored.reason).toContain('track "Footage"');
  });

  it("requires a materialized transition except for explicit hard cuts and detailed speech", () => {
    const noTransitions = syntheticProject([trackWith([{ id: "a", startTime: 0, duration: 4 }])]);
    const detailedSpeech = { id: "pod-01-detailed", type: "detailed" as const, text: "Tell one clear story." };
    expect(evaluateTransitionMinimum(noTransitions, detailedSpeech, { id: "pod-01", category: "speech" })).toMatchObject({
      passed: true,
    });
    expect(
      evaluateTransitionMinimum(noTransitions, detailedSpeech, { id: "interview-01", category: "speech" }).passed,
    ).toBe(false);

    const genreSpeech = { id: "pod-01-genre", type: "genre" as const, text: "podcast-clips" };
    const required = evaluateTransitionMinimum(noTransitions, genreSpeech, { id: "pod-01", category: "speech" });
    expect(required.passed).toBe(false);
    expect(required.reason).toContain("requires at least 1");

    for (const hardCuts of [
      { id: "game-01-only", type: "detailed" as const, text: "Use hard cuts only." },
      { id: "game-01-none", type: "detailed" as const, text: "No transitions." },
    ]) {
      expect(evaluateTransitionMinimum(noTransitions, hardCuts, { id: "game-01", category: "game" })).toMatchObject({
        passed: true,
      });
    }
    const ambiguousHardCut = {
      id: "multi-01-detailed",
      type: "detailed" as const,
      text: "Hard cut between every beat.",
    };
    expect(
      evaluateTransitionMinimum(noTransitions, ambiguousHardCut, { id: "multi-01", category: "multi" }).passed,
    ).toBe(false);

    const withTransition = syntheticProject([
      trackWith(
        [
          { id: "a", startTime: 0, duration: 2 },
          { id: "b", startTime: 2, duration: 2 },
        ],
        { transitions: [syntheticTransition("a", "b")] },
      ),
    ]);
    expect(evaluateTransitionMinimum(withTransition, genreSpeech, { id: "pod-01", category: "speech" })).toMatchObject({
      passed: true,
      reason: expect.stringContaining("materialized transition"),
    });
  });

  it("caps compiler-authored camera moves at 70% of primary footage clips", () => {
    const makeClips = (movingCount: number): SyntheticClip[] =>
      Array.from({ length: 10 }, (_, index) => {
        const id = `clip-${index}`;
        return {
          id,
          startTime: index,
          duration: 1,
          keyframes:
            index < movingCount
              ? [{ id: `${id}-move-0`, time: 0, property: "scale.x", value: 1.08, easing: "linear" }]
              : index === 9
                ? [{ id: `${id}-manual-0`, time: 0, property: "position.x", value: 5, easing: "linear" }]
                : [],
        };
      });
    const atCap = evaluateCameraMoveDensity(syntheticProject([trackWith(makeClips(7))]));
    expect(CAMERA_MOVE_CLIP_SHARE_MAX).toBe(0.7);
    expect(atCap.passed).toBe(true);
    expect(atCap.reason).toContain("7/10");

    const overCap = evaluateCameraMoveDensity(syntheticProject([trackWith(makeClips(8))]));
    expect(overCap.passed).toBe(false);
    expect(overCap.reason).toContain("8/10");
    expect(overCap.reason).toContain("maximum 70.0%");
  });

  it("rejects repeated transition + effect-preset pairs on adjacent cuts", () => {
    const effect = {
      id: "look",
      type: "shader",
      params: { shaderId: "analog-vhs" },
      enabled: true,
    };
    const makeProject = (secondPreset: string, secondTransition = "crossfade") =>
      syntheticProject([
        trackWith(
          [
            { id: "a", startTime: 0, duration: 1, effects: [effect] },
            {
              id: "b",
              startTime: 1,
              duration: 1,
              effects: [{ ...effect, params: { shaderId: secondPreset } }],
            },
            { id: "c", startTime: 2, duration: 1 },
          ],
          {
            transitions: [
              syntheticTransition("a", "b", "crossfade"),
              syntheticTransition("b", "c", secondTransition),
            ],
          },
        ),
      ]);

    const repeated = evaluateNoConsecutiveIdenticalAccents(makeProject("analog-vhs"));
    expect(repeated.passed).toBe(false);
    expect(repeated.reason).toContain("crossfade");
    expect(repeated.reason).toContain("shader:analog-vhs");

    expect(evaluateNoConsecutiveIdenticalAccents(makeProject("film-grain")).passed).toBe(true);
    expect(evaluateNoConsecutiveIdenticalAccents(makeProject("analog-vhs", "wipe")).passed).toBe(true);
  });

  it("checks materialized timeline duration against metadata.targetDuration ±10%", () => {
    const within = syntheticProject([trackWith([{ id: "a", startTime: 0, duration: 9.1 }])]);
    const pass = evaluateDurationWithinTolerance(within, syntheticEditPlan(10));
    expect(pass.passed).toBe(true);
    expect(pass.reason).toContain("±10%");

    const outside = syntheticProject([trackWith([{ id: "a", startTime: 0, duration: 8.9 }])]);
    const fail = evaluateDurationWithinTolerance(outside, syntheticEditPlan(10));
    expect(fail.passed).toBe(false);
    expect(fail.reason).toContain("8.90s");
  });

  it("returns reasons for every new gate using only a synthetic plan and project", () => {
    const project = syntheticProject([
      trackWith([
        { id: "a", startTime: 0, duration: 5 },
        { id: "b", startTime: 5, duration: 5 },
      ], { transitions: [syntheticTransition("a", "b")] }),
    ]);
    const plan = syntheticEditPlan(10);
    const results = evaluateCraftGates(
      project,
      plan,
      { id: "vague", type: "vague", text: "Make it feel good." },
      { id: "sport-01", category: "sport" },
      10,
    );
    expect(Object.values(results)).toHaveLength(5);
    for (const result of Object.values(results)) {
      expect(typeof result.passed).toBe("boolean");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("pins temperature and seed on every outgoing request body", async () => {
    const seen: unknown[] = [];
    const inner = async (body: unknown): Promise<unknown> => {
      seen.push(body);
      return { choices: [{ message: { content: "ok" } }] };
    };
    const send = pinnedSend(inner, PINNED_SAMPLING);
    await send({ model: "m", messages: [], tools: [], max_completion_tokens: 8192 });
    expect(PINNED_SAMPLING.temperature).toBe(0);
    expect(PINNED_SAMPLING.seed).toBeTypeOf("number");
    const body = seen[0] as Record<string, unknown>;
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(PINNED_SAMPLING.seed);
    expect(body.model).toBe("m"); // existing fields preserved
    expect(body.max_completion_tokens).toBe(8192);
  });

  it("recognizes quota exhaustion as transport, not model output", () => {
    expect(isQuotaMessage('cloudflare-ai 429: {"code":4006}')).toBe(true);
    expect(isQuotaMessage("you have used up your daily free allocation of 10,000 neurons")).toBe(true);
    expect(isQuotaMessage("plan invalid [insufficient_speed_keyframes]")).toBe(false);
  });

  it("recognizes infra/transport failures, and never confuses them with quota or model errors", () => {
    expect(isInfraFailureMessage("plan_edit failed [TOOL_ERROR]: fetch failed")).toBe(true);
    expect(isInfraFailureMessage("omniroute 504: omniroute stream idle for 120000ms")).toBe(true);
    expect(isInfraFailureMessage("omniroute 502: upstream melted")).toBe(true);
    expect(isInfraFailureMessage("cloudflare-ai 408: gateway timeout")).toBe(true);
    // Quota rows carry their own flag; infra must not double-claim them.
    expect(isInfraFailureMessage('cloudflare-ai 429: {"code":4006}')).toBe(false);
    // Genuine model/validation failures are not infra.
    expect(isInfraFailureMessage("plan invalid [overlap]: segments overlap")).toBe(false);
    expect(isInfraFailureMessage("plan_edit failed [EDIT_PLAN_APPLY_FAILED]: rolled back")).toBe(false);
  });

  it("excludes quota/infra rows from gate rates and reports per-combination spread", () => {
    const stats = {
      durationMs: 1,
      clipCount: 0,
      transitionCount: 0,
      effectCount: 0,
      audioCount: 0,
      textCount: 0,
      planScore: null,
      timelineDuration: 0,
    };
    const make = (id: string, run: number, ok: boolean, quota = false, infra = false) => ({
      id,
      run,
      projectId: "p",
      promptId: "q",
      promptType: "vague" as const,
      ok,
      toolCode: quota || infra ? "TOOL_ERROR" : null,
      quotaExhausted: quota,
      infraFailure: infra,
      gates: {
        planValidates: ok,
        materializes: ok,
        noClipOverlaps: true,
        noTimelineGaps: ok,
        meetsTransitionMinimum: ok,
        cameraMoveDensityOk: ok,
        noConsecutiveIdenticalAccents: ok,
        durationWithinTolerance: ok,
      },
      gateResults: syntheticGateResults(ok),
      failures: quota
        ? ["plan_edit failed [TOOL_ERROR]: cloudflare-ai 429 ..."]
        : infra
          ? ["plan_edit failed [TOOL_ERROR]: fetch failed"]
          : [],
      warnings: [],
      stats,
    });
    const summary = summarizeBaseline(
      [
        make("a", 0, true, false), // mixed: pass/fail/pass
        make("a", 1, false, false),
        make("a", 2, true, false),
        make("b", 0, true, true), // incomplete: one quota row is not a model result
        make("b", 1, true, false),
        make("b", 2, true, false),
        make("c", 0, true, false), // all_pass
        make("c", 1, true, false),
        make("c", 2, true, false),
        make("d", 0, false, false), // all_fail
        make("d", 1, false, false),
        make("d", 2, false, false),
        make("e", 0, true, false, true), // incomplete: infra row is excluded
        make("e", 1, true, false),
        make("e", 2, true, false),
      ],
      {
        model: "m",
        cases: 6,
        runsPerCombo: 3,
        combinationIds: ["a", "b", "c", "d", "e", "f"],
        status: "aborted",
        abortReason: "stopped early",
        quotaExcluded: 1,
        infraExcluded: 1,
      },
    );
    expect(summary.gateSemanticsVersion).toBe(BASELINE_GATE_SEMANTICS_VERSION);
    expect(summary.quotaExcluded).toBe(1);
    expect(summary.infraExcluded).toBe(1);
    expect(summary.status).toBe("aborted");
    expect(summary.abortReason).toBe("stopped early");
    // Run-wise pass rates exclude quota and infra results: 2/3, 3/5, and 4/5.
    expect(summary.gateRates.planValidates.perRun).toEqual([0.6667, 0.6, 0.8]);
    expect(summary.gateRates.noTimelineGaps.perRun).toEqual([0.6667, 0.6, 0.8]);
    expect(summary.gateRates.durationWithinTolerance.perRun).toEqual([0.6667, 0.6, 0.8]);
    expect(summary.gateRates.planValidates.validPerRun).toEqual([3, 5, 5]);
    expect(summary.gateRates.allGates.perRun).toEqual([0.6667, 0.6, 0.8]);
    expect(summary.spread).toEqual({
      all_pass: 1,
      all_fail: 1,
      mixed: 1,
      incomplete: 3,
      byCombination: [
        { id: "a", outcome: "mixed", validRuns: 3, expectedRuns: 3 },
        { id: "b", outcome: "incomplete", validRuns: 2, expectedRuns: 3 },
        { id: "c", outcome: "all_pass", validRuns: 3, expectedRuns: 3 },
        { id: "d", outcome: "all_fail", validRuns: 3, expectedRuns: 3 },
        { id: "e", outcome: "incomplete", validRuns: 2, expectedRuns: 3 },
        { id: "f", outcome: "incomplete", validRuns: 0, expectedRuns: 3 },
      ],
    });
    expect(summary.passed).toBe(9);
    expect(summary.total).toBe(15);
  });

  it("reads Workers AI credentials from .dev.vars when present", () => {
    const devVarsPath = `${REPO_ROOT}/.dev.vars`;
    if (!existsSync(devVarsPath)) {
      expect(loadWorkersAIConfig()).toBeNull();
      return;
    }
    const config = loadWorkersAIConfig();
    expect(config).not.toBeNull();
    expect(config!.accountId).toBeTruthy();
    expect(config!.apiToken).toBeTruthy();
    expect(config!.model).toContain("@cf/");
    // Never leak the token into the report/test output.
    expect(JSON.stringify(config)).not.toContain(readFileSync(devVarsPath, "utf8").trim());
  });

  it("prefers KOVE_EVAL_CLOUDFLARE_* credentials over generic env and .dev.vars", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-generic");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-generic");
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID", "acct-eval");
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_API_TOKEN", "tok-eval");
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_AI_MODEL", "@cf/eval-model");
    try {
      expect(loadWorkersAIConfig()).toEqual({
        accountId: "acct-eval",
        apiToken: "tok-eval",
        model: "@cf/eval-model",
      });

      // Without the eval override, generic env still wins over .dev.vars.
      // Ambient KOVE_EVAL_* exports (a shell running a live eval) are cleared
      // explicitly: unstubAllEnvs restores them, and they outrank CLOUDFLARE_*.
      vi.unstubAllEnvs();
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-generic");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-generic");
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_AI_MODEL", "");
      const config = loadWorkersAIConfig();
      expect(config?.accountId).toBe("acct-generic");
      expect(config?.apiToken).toBe("tok-generic");
      expect(config?.model).toContain("@cf/");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prefers the materializer's transition count over diff-detected ids", () => {
    expect(resolveTransitionCount(null)).toBe(0);
    expect(resolveTransitionCount({})).toBe(0);
    expect(resolveTransitionCount({ transitionIds: ["t1", "t2"] })).toBe(2);
    expect(resolveTransitionCount({ transitionCount: 5, transitionIds: ["t1"] })).toBe(5);
    expect(resolveTransitionCount({ transitionCount: 0, transitionIds: ["t1"] })).toBe(0);
  });

  it("loads OmniRoute config with env over .dev.vars and refuses an unpinned model", () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-omni-cfg-"));
    writeFileSync(
      join(dir, ".dev.vars"),
      "OMNIROUTE_KEY=vars-key\nOMNIROUTE_MODEL=vars/model\nOMNIROUTE_BASE_URL=http://vars-host:20128/v1/\n",
      "utf8",
    );
    try {
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_KEY", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_MODEL", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_BASE_URL", "");
      expect(loadOmniRouteConfig(dir)).toEqual({
        baseUrl: "http://vars-host:20128/v1",
        apiKey: "vars-key",
        model: "vars/model",
      });

      vi.unstubAllEnvs();
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_KEY", "env-key");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_MODEL", "env/model");
      expect(loadOmniRouteConfig(dir)).toEqual({
        baseUrl: "http://vars-host:20128/v1",
        apiKey: "env-key",
        model: "env/model",
      });

      vi.unstubAllEnvs();
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_KEY", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_MODEL", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_BASE_URL", "");
      writeFileSync(join(dir, ".dev.vars"), "OMNIROUTE_KEY=only-a-key\n", "utf8");
      expect(loadOmniRouteConfig(dir)).toBeNull();
      expect(loadOmniRouteConfig(join(dir, "missing"))).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("routes eval provider selection: forced provider wins, configured gateway beats Workers", () => {
    const dir = mkdtempSync(join(tmpdir(), "kove-omni-resolve-"));
    const withGatewayAndWorkers =
      "CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_AI_MODEL=@cf/test-model\n" +
      "OMNIROUTE_KEY=omni-key\nOMNIROUTE_MODEL=vendor/pinned-model\n";
    const workersOnly = "CLOUDFLARE_ACCOUNT_ID=acct\nCLOUDFLARE_API_TOKEN=tok\nCLOUDFLARE_AI_MODEL=@cf/test-model\n";
    writeFileSync(join(dir, ".dev.vars"), withGatewayAndWorkers, "utf8");
    try {
      vi.stubEnv("KOVE_EVAL_LLM_PROVIDER", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_KEY", "");
      vi.stubEnv("KOVE_EVAL_OMNIROUTE_MODEL", "");
      expect(resolveEvalLLMConfig(dir)?.kind).toBe("omni");

      vi.stubEnv("KOVE_EVAL_LLM_PROVIDER", "workers");
      expect(resolveEvalLLMConfig(dir)?.kind).toBe("workers");

      vi.stubEnv("KOVE_EVAL_LLM_PROVIDER", "omni");
      expect(resolveEvalLLMConfig(dir)?.kind).toBe("omni");

      writeFileSync(join(dir, ".dev.vars"), workersOnly, "utf8");
      expect(resolveEvalLLMConfig(dir)).toBeNull();

      vi.stubEnv("KOVE_EVAL_LLM_PROVIDER", "workers");
      expect(resolveEvalLLMConfig(dir)?.kind).toBe("workers");

      vi.stubEnv("KOVE_EVAL_LLM_PROVIDER", "omni");
      expect(resolveEvalLLMConfig(dir)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("posts to the OmniRoute gateway with bearer auth and maps HTTP failures", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const okFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://localhost:20128/v1", apiKey: "omni-key", model: "vendor/model" };
    const send = makeOmniRouteSend(cfg, { fetchFn: okFetch });
    await send({ model: "vendor/model", messages: [] });
    expect(calls[0]?.url).toBe("http://localhost:20128/v1/chat/completions");
    expect(calls[0]?.headers.Authorization).toBe("Bearer omni-key");

    const limitedFetch = (async () =>
      new Response('{"error":{"code":429}}', {
        status: 429,
        headers: { "retry-after": "7", "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const failing = makeOmniRouteSend(cfg, { fetchFn: limitedFetch });
    await expect(failing({})).rejects.toThrow("omniroute 429");
  });

  it("requests stream:true and folds SSE chunks back into one OpenAI-shaped message", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const sse = [
      'data: {"model":"vendor/model","choices":[{"index":0,"delta":{"role":"assistant","content":"I will call "}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"content":"the tool."}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"submit_edit_plan","arguments":"{\\"segments\\""}}]}}]}',
      "",
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[]}"}}]},"finish_reason":"tool_calls"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const streamFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://localhost:20128/v1", apiKey: "omni-key", model: "vendor/model" };
    const raw = await makeOmniRouteSend(cfg, { fetchFn: streamFetch })({ model: "vendor/model", messages: [] });
    expect(bodies[0]?.stream).toBe(true);
    const choice = (raw as { choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }> })
      .choices?.[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message?.content).toBe("I will call the tool.");
    expect(choice?.message?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "submit_edit_plan", arguments: '{"segments":[]}' },
      },
    ]);
  });

  it("surfaces mid-stream upstream error events as omniroute transport failures", async () => {
    const sse = ['data: {"error":{"message":"upstream melted"}}', "", "data: [DONE]", ""].join("\n");
    const streamFetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://localhost:20128/v1", apiKey: "omni-key", model: "vendor/model" };
    await expect(makeOmniRouteSend(cfg, { fetchFn: streamFetch })({})).rejects.toThrow("omniroute 502");
  });

  it("tears down a stalled stream after the idle window instead of pinning the slot", async () => {
    const hanging = new ReadableStream<Uint8Array>({});
    const streamFetch = (async () =>
      new Response(hanging, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const cfg = { baseUrl: "http://localhost:20128/v1", apiKey: "omni-key", model: "vendor/model" };
    await expect(
      makeOmniRouteSend(cfg, { fetchFn: streamFetch, idleTimeoutMs: 40 })({}),
    ).rejects.toThrow("omniroute 504");
  });
});

describe.skipIf(!LIVE || !corpusReady)("baseline v0 (live eval run)", () => {
  it(
    "measures validity, materialization, and craft gates over k runs per combination",
    async () => {
      const summary = await runBaseline({
        limit: LIMIT,
        runsPerCombo: RUNS,
        reportPath,
        resume: RESUME,
        concurrency: 3,
        onCase: result => {
          const gateLabel = [
            result.gates.planValidates ? "plan✓" : "plan✗",
            result.gates.materializes ? "mat✓" : "mat✗",
            result.gates.noClipOverlaps ? "overlap✓" : "overlap✗",
            result.gates.noTimelineGaps ? "gaps✓" : "gaps✗",
            result.gates.meetsTransitionMinimum ? "transition✓" : "transition✗",
            result.gates.cameraMoveDensityOk ? "camera✓" : "camera✗",
            result.gates.noConsecutiveIdenticalAccents ? "accents✓" : "accents✗",
            result.gates.durationWithinTolerance ? "duration✓" : "duration✗",
          ].join(" ");
          console.log(
            `[baseline] run ${result.run} ${result.id} (${result.promptType}): ` +
              `${result.quotaExhausted ? "QUOTA" : result.ok ? "PASS" : "FAIL"} ${gateLabel} ` +
              `${result.stats.clipCount} clips / ${result.stats.transitionCount} tr / ${result.stats.effectCount} fx, ` +
              `${(result.stats.durationMs / 1000).toFixed(1)}s` +
              (result.failures.length ? ` — ${result.failures.join(" | ")}` : ""),
          );
        },
      });

      const cases = LIMIT ?? 27;
      expect(summary.cases).toBe(cases);
      expect(summary.runsPerCombo).toBe(RUNS);
      expect(summary.total).toBeLessThanOrEqual(cases * RUNS);
      expect(summary.sampling).toEqual(PINNED_SAMPLING);
      if (summary.status === "complete") {
        expect(summary.total).toBe(cases * RUNS);
        expect(summary.quotaExcluded).toBe(0);
        expect(summary.infraExcluded).toBe(0);
      } else {
        console.log(`[baseline] ABORTED: ${summary.abortReason}`);
        expect(summary.quotaExcluded + summary.infraExcluded).toBeGreaterThan(0);
      }
      const writtenPath = reportPath ?? DEFAULT_REPORT_PATH;
      expect(existsSync(writtenPath), `report not written to ${writtenPath}`).toBe(true);

      // Baseline is a measurement, not a hard gate: assert harness correctness
      // and let the hard-gate rates land in the JSON report.
      const valid = summary.results.filter(result => !result.quotaExhausted && !result.infraFailure);
      expect(summary.passed).toBe(valid.filter(result => result.ok).length);
      for (const result of summary.results) {
        if (result.quotaExhausted || result.infraFailure) continue;
        for (const gatePassed of Object.values(result.gates)) expect(typeof gatePassed, result.id).toBe("boolean");
        for (const gateResult of Object.values(result.gateResults)) {
          expect(typeof gateResult.passed, result.id).toBe("boolean");
          expect(gateResult.reason.length, result.id).toBeGreaterThan(0);
        }
        const hardGatesPass = Object.values(result.gates).every(Boolean);
        const processingCompleted = !result.failures.some(failure => failure.startsWith("threw:"));
        expect(result.ok, `${result.id} run ${result.run}: ${result.failures.join(" | ")}`).toBe(
          hardGatesPass && result.toolCode === null && processingCompleted,
        );
        expect(result.stats.durationMs).toBeGreaterThan(0);
      }
      // Quota- and infra-excluded rows must never appear inside a gate rate.
      for (const rate of Object.values(summary.gateRates)) {
        expect(rate.validPerRun.reduce((sum, n) => sum + n, 0)).toBe(valid.length);
      }

      const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
      const line = (
        label: string,
        rate: { mean: number; stdev: number; perRun: readonly number[]; validPerRun: readonly number[] },
      ): string =>
        `${label} ${pct(rate.mean)} ± ${pct(rate.stdev)} [${rate.perRun.map((v, i) => `${pct(v)}/${rate.validPerRun[i]}`).join(", ")}]`;
      console.log(
        `[baseline] k=${RUNS}, sampling T=${summary.sampling.temperature} seed=${summary.sampling.seed}, ` +
          `valid ${valid.length}/${summary.total} (quota excluded ${summary.quotaExcluded}, infra excluded ${summary.infraExcluded}); gate rates: ` +
          line("plan_validates", summary.gateRates.planValidates) + "; " +
          line("materializes", summary.gateRates.materializes) + "; " +
          line("no_clip_overlaps", summary.gateRates.noClipOverlaps) + "; " +
          line("no_timeline_gaps", summary.gateRates.noTimelineGaps) + "; " +
          line("transition_minimum", summary.gateRates.meetsTransitionMinimum) + "; " +
          line("camera_move_density", summary.gateRates.cameraMoveDensityOk) + "; " +
          line("distinct_accents", summary.gateRates.noConsecutiveIdenticalAccents) + "; " +
          line("duration_tolerance", summary.gateRates.durationWithinTolerance) + "; " +
          line("all_gates", summary.gateRates.allGates),
      );
      console.log(
        `[baseline] spread across k=${RUNS} (valid model results): all_pass ${summary.spread.all_pass}, ` +
          `all_fail ${summary.spread.all_fail}, mixed ${summary.spread.mixed}, incomplete ${summary.spread.incomplete}; ` +
          summary.spread.byCombination.map(combo => `${combo.id}:${combo.outcome}`).join(", "),
      );
    },
    43_200_000,
  );
}, 43_200_000);
