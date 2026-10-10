import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import type { Track } from "@kove-advanced/core/types/timeline";
import type { LLMClient } from "../llm";
import type { BaselineCaseResult, FailureArtifact, PlanIssue } from "./baseline";
import {
  DEFAULT_REPORT_PATH,
  PINNED_SAMPLING,
  buildBaselineProject,
  buildSegmentMap,
  clipOverlaps,
  durationFidelityWarning,
  loadWorkersAIConfig,
  parseDevVars,
  isQuotaMessage,
  fingerprintCorpusFile,
  pinnedSend,
  promptDurationTarget,
  runBaseline,
  selectCombos,
  serializeCaseResult,
  summarizeBaseline,
  REPO_ROOT,
} from "./baseline";
import { loadCorpus, missingAssets } from "./corpus";
import type { EvalProject, EvalPrompt } from "./corpus";
import { CORPUS_PATH } from "./baseline";

const LIVE = process.env.KOVE_EVAL_BASELINE === "1";
const LIMIT = Number(process.env.KOVE_EVAL_LIMIT ?? "0") || undefined;
/** Start index into the flattened combos (pairs with LIMIT for slices). */
const OFFSET = Number(process.env.KOVE_EVAL_OFFSET ?? "0") || undefined;
/**
 * Mixed-k sampling: exact `projectId/promptId` combos to run (comma-separated).
 * Wins over OFFSET/LIMIT, so one run can do k=3 on a stratified half of the
 * corpus and a second run k=1 on the rest. Reports land in distinct files so
 * split runs never clobber each other.
 */
const INCLUDE = (process.env.KOVE_EVAL_INCLUDE ?? "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);
/** Repeats per combination (k). k >= 3 so gate rates carry a spread. */
const RUNS = Number(process.env.KOVE_EVAL_RUNS ?? "3") || 3;
const selection = INCLUDE.length > 0 ? `include-${INCLUDE.length}` : OFFSET ? `offset-${OFFSET}` : undefined;
const reportPath = selection
  ? new URL(`../../../../evaluation-files/baseline-r${RUNS}-${selection}.json`, import.meta.url).pathname
  : LIMIT
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

function trackWith(clips: Array<{ id: string; startTime: number; duration: number }>): Track {
  return {
    id: "v1",
    type: "video",
    name: "Video 1",
    clips: clips.map(clip => ({
      id: clip.id,
      mediaId: "video-1",
      trackId: "v1",
      startTime: clip.startTime,
      duration: clip.duration,
      inPoint: 0,
      outPoint: clip.duration,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    })),
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  } as unknown as Track;
}

describe("combo selection for split-k runs", () => {
  const prompt = (id: string, type: EvalPrompt["type"]): EvalPrompt => ({
    id,
    type,
    text: `prompt ${id}`,
  });
  const project = (id: string, prompts: readonly EvalPrompt[]): EvalProject => ({
    id,
    category: "test",
    media: ["clip.mp4"],
    music: null,
    reference: null,
    notes: "",
    prompts,
  });
  const corpus: EvalProject[] = [
    project("a", [prompt("d", "detailed"), prompt("v", "vague"), prompt("g", "genre")]),
    project("b", [prompt("d", "detailed"), prompt("v", "vague"), prompt("g", "genre")]),
  ];
  const combos = corpus.flatMap(entry => entry.prompts.map(p => ({ entry, prompt: p })));
  const ids = (selected: readonly { entry: EvalProject; prompt: EvalPrompt }[]): string[] =>
    selected.map(({ entry, prompt }) => `${entry.id}/${prompt.id}`);

  it("slices with offset and limit; offset alone runs the tail", () => {
    expect(ids(selectCombos(combos, {}))).toEqual(["a/d", "a/v", "a/g", "b/d", "b/v", "b/g"]);
    expect(ids(selectCombos(combos, { limit: 2 }))).toEqual(["a/d", "a/v"]);
    expect(ids(selectCombos(combos, { offset: 4 }))).toEqual(["b/v", "b/g"]);
    expect(ids(selectCombos(combos, { offset: 2, limit: 2 }))).toEqual(["a/g", "b/d"]);
  });

  it("include wins over offset/limit, preserves corpus order, and tolerates whitespace", () => {
    const include = [" b/v ", "a/d", "b/g"];
    expect(ids(selectCombos(combos, { includeIds: include, offset: 4, limit: 1 }))).toEqual([
      "a/d",
      "b/v",
      "b/g",
    ]);
    expect(ids(selectCombos(combos, { includeIds: ["b/g"] }))).toEqual(["b/g"]);
  });

  it("fails fast on unknown include ids before any case runs", () => {
    expect(() => selectCombos(combos, { includeIds: ["a/d", "zzz/q"] })).toThrow(
      /Unknown corpus combos: zzz\/q/,
    );
  });

  it("runs only the included combinations at k repeats and writes the report", async () => {
    const root = mkdtempSync(join(tmpdir(), "kove-eval-include-"));
    try {
      writeFileSync(join(root, "clip.mp4"), "");
      writeFileSync(
        join(root, "projects.json"),
        JSON.stringify(
          corpus.map(entry => ({
            id: entry.id,
            category: entry.category,
            media: entry.media,
            music: entry.music,
            reference: entry.reference,
            notes: entry.notes,
            prompts: entry.prompts,
          })),
        ),
      );
      const reportPath = join(root, "report.json");
      // Every case fails here (dummy assets cannot probe): fine — selection is
      // observable purely from which result rows exist and how often.
      const client: LLMClient = {
        complete: () => Promise.reject(new Error("offline client; must never be called")),
      };
      const summary = await runBaseline({
        root,
        client,
        includeIds: ["a/g", "b/d"],
        runsPerCombo: 2,
        reportPath,
      });
      expect(summary.cases).toBe(2);
      expect(summary.runsPerCombo).toBe(2);
      expect(summary.total).toBe(4);
      expect(summary.results.map(r => `${r.id}#${r.run}`)).toEqual([
        "a/g#0",
        "a/g#1",
        "b/d#0",
        "b/d#1",
      ]);
      expect(summary.status).toBe("complete");
      // The report pins the exact corpus bytes it ran: sha256 of the file we wrote.
      const expectedFp = createHash("sha256").update(readFileSync(join(root, "projects.json"))).digest("hex");
      expect(summary.corpusFingerprint).toBe(expectedFp);
      const written = JSON.parse(readFileSync(reportPath, "utf8")) as {
        results: unknown[];
        cases: number;
        corpusFingerprint: string;
      };
      expect(written.cases).toBe(2);
      expect(written.results).toHaveLength(4);
      expect(written.corpusFingerprint).toBe(expectedFp);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the corpus fingerprint changes when any corpus byte changes", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-eval-fp-"));
    try {
      const a = join(root, "a.json");
      const b = join(root, "b.json");
      const bytes = JSON.stringify([{ id: "p" }], null, 2);
      writeFileSync(a, bytes);
      writeFileSync(b, `${bytes}\n`); // single-byte difference
      const fpA = fingerprintCorpusFile(a);
      expect(fpA).toMatch(/^[0-9a-f]{64}$/);
      expect(fingerprintCorpusFile(a)).toBe(fpA); // stable
      expect(fingerprintCorpusFile(b)).not.toBe(fpA); // byte-sensitive
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baseline harness helpers", () => {
  it("loads the corpus and passes the asset-existence gate", () => {
    const corpus = loadCorpus(CORPUS_PATH);
    expect(corpus).toHaveLength(9);
    expect(missingAssets(corpus, `${REPO_ROOT}/evaluation-files`)).toEqual([]);
  });

  it("parses .dev.vars style key/value lines", () => {
    const parsed = parseDevVars('# comment\nFOO=bar\nQUOTED="a b"\n\nEMPTY=\n');
    expect(parsed).toEqual({ FOO: "bar", QUOTED: "a b", EMPTY: "" });
  });

  it("builds a project with probed metadata and a reference-free segment map", () => {
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

  it("builds a segment map identical to plan_edit's metadata fallback shape", () => {
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

  it("excludes quota results from gate rates and marks aborted runs", () => {
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
    const make = (id: string, run: number, ok: boolean, quota: boolean) => ({
      id,
      run,
      projectId: "p",
      promptId: "q",
      promptType: "vague" as const,
      ok,
      toolCode: quota ? "TOOL_ERROR" : null,
      quotaExhausted: quota,
      gates: { planValidates: ok, materializes: ok, noClipOverlaps: true },
      failures: quota ? ["plan_edit failed [TOOL_ERROR]: cloudflare-ai 429 ..."] : [],
      warnings: [],
      stats,
    });
    const summary = summarizeBaseline(
      [
        make("a", 0, true, false), // combo a: complete k-run sample, pass/fail/pass
        make("a", 1, false, false),
        make("a", 2, true, false),
        make("b", 0, true, true), // combo b: quota run excluded -> only 2 valid
        make("b", 1, true, false),
        make("b", 2, true, false),
        make("c", 0, true, false), // combo c: complete and stable pass
        make("c", 1, true, false),
        make("c", 2, true, false),
      ],
      {
        model: "m",
        cases: 3,
        runsPerCombo: 3,
        status: "aborted",
        abortReason: "stopped early",
        quotaExcluded: 1,
        corpusFingerprint: "test-fingerprint",
      },
    );
    expect(summary.quotaExcluded).toBe(1);
    expect(summary.status).toBe("aborted");
    expect(summary.abortReason).toBe("stopped early");
    // planValidates over non-quota results: run0 2/2, run1 2/3, run2 3/3
    expect(summary.gateRates.planValidates.perRun).toEqual([1, 0.6667, 1]);
    expect(summary.gateRates.planValidates.validPerRun).toEqual([2, 3, 3]);
    expect(summary.gateRates.allGates.perRun).toEqual([1, 0.6667, 1]);
    // b is not evidence of stability: 2 valid < runsPerCombo
    expect(summary.determinism).toEqual({
      allPass: 1,
      allFail: 0,
      mixed: 1,
      mixedIds: ["a"],
      incomplete: 1,
      incompleteIds: ["b"],
    });
    expect(summary.passed).toBe(7);
    expect(summary.total).toBe(9);
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
    // Ambient eval-scoped creds must never decide this test's outcome: a live
    // harness run exports these to select an account, and unstubAllEnvs below
    // would restore them mid-test.
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("KOVE_EVAL_CLOUDFLARE_AI_MODEL", "");
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
      vi.unstubAllEnvs();
      // unstubAllEnvs restores ambient shell env, so re-scrub before asserting.
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID", "");
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_API_TOKEN", "");
      vi.stubEnv("KOVE_EVAL_CLOUDFLARE_AI_MODEL", "");
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acct-generic");
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok-generic");
      const config = loadWorkersAIConfig();
      expect(config?.accountId).toBe("acct-generic");
      expect(config?.apiToken).toBe("tok-generic");
      expect(config?.model).toContain("@cf/");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("duration fidelity (warn-level only)", () => {
  it("takes the first mention's hi end and keeps every raw mention", () => {
    const cut = "Cut a 45-second Short from podcast #1.mp4. Hit roughly one point every 12-15 seconds.";
    expect(promptDurationTarget(cut)).toEqual({
      target: 45,
      mentions: ["45-second", "12-15 seconds"],
    });
    // A later, shorter mention (teaser/beat length) never steals the target.
    const teaser =
      "Create a 60-second Instagram Reels cut. Cold-open on a 2-second teaser of the best moment.";
    expect(promptDurationTarget(teaser).target).toBe(60);
    // Ranges take the hi end.
    expect(promptDurationTarget("make it 2-3 minutes long")).toEqual({
      target: 180,
      mentions: ["2-3 minutes"],
    });
    expect(promptDurationTarget("make the best clip possible")).toEqual({
      target: null,
      mentions: [],
    });
  });

  it("warns only outside [0.25x, 2x], never for an empty timeline", () => {
    const brief = "Build a 90-second YouTube long-form video.";
    expect(durationFidelityWarning(brief, 1845.24)).toBe(
      '[duration_fidelity] timeline 1845.2s vs ~90s brief (mentions found: "90-second")',
    );
    expect(durationFidelityWarning(brief, 23)).toBeNull(); // 0.25x is inclusive
    expect(durationFidelityWarning(brief, 180)).toBeNull(); // 2x is inclusive
    expect(durationFidelityWarning(brief, 22.4)).not.toBeNull();
    expect(durationFidelityWarning(brief, 181)).not.toBeNull();
    expect(durationFidelityWarning(brief, 0)).toBeNull(); // nothing produced
    expect(durationFidelityWarning(brief, NaN)).toBeNull(); // underspecified clip path
    expect(durationFidelityWarning(brief, Infinity)).toBeNull(); // non-finite is never a fidelity signal
    expect(durationFidelityWarning("make the best clip possible", 1845)).toBeNull(); // no mention
  });

  it("never feeds pass/fail, any gate, or the report's gate rates", () => {
    const stats = {
      durationMs: 1,
      clipCount: 4,
      transitionCount: 1,
      effectCount: 2,
      audioCount: 0,
      textCount: 1,
      planScore: 0.8,
      timelineDuration: 1845.24,
    };
    const make = (warnings: string[]) => ({
      id: "a",
      run: 0,
      projectId: "p",
      promptId: "q",
      promptType: "detailed" as const,
      ok: true,
      toolCode: null,
      quotaExhausted: false,
      gates: { planValidates: true, materializes: true, noClipOverlaps: true },
      failures: [],
      warnings,
      stats,
    });
    const opts = {
      model: "m",
      cases: 1,
      runsPerCombo: 1,
      status: "complete" as const,
      quotaExcluded: 0,
      corpusFingerprint: "fp",
    };
    const warned = summarizeBaseline(
      [make(['[duration_fidelity] timeline 1845.2s vs ~90s brief (mentions found: "90-second")'])],
      opts,
    );
    const clean = summarizeBaseline([make([])], opts);
    expect(warned.gateRates).toEqual(clean.gateRates);
    expect(warned.determinism).toEqual(clean.determinism);
    expect(warned.passed).toBe(clean.passed);

    // The warning is appended only after pass/fail is already computed, and the
    // pass/fail expression itself carries no duration signal.
    const source = readFileSync(join(REPO_ROOT, "packages/agent/src/eval/baseline.ts"), "utf8");
    const body = source.slice(source.indexOf("export async function runBaselineCase"));
    const passedAt = body.indexOf("const passed =");
    const warnedAt = body.indexOf("durationFidelityWarning(");
    expect(passedAt).toBeGreaterThan(-1);
    expect(warnedAt).toBeGreaterThan(passedAt);
    expect(body.slice(passedAt, body.indexOf("\n", passedAt))).not.toMatch(/duration/i);
  });
});

describe("failure sidecars", () => {
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
  const make = (overrides: Partial<BaselineCaseResult> = {}): BaselineCaseResult => ({
    id: "pod-02/pod-02-genre",
    run: 0,
    projectId: "pod-02",
    promptId: "pod-02-genre",
    promptType: "genre",
    ok: false,
    toolCode: "EDIT_PLAN_APPLY_FAILED",
    quotaExhausted: false,
    gates: { planValidates: true, materializes: false, noClipOverlaps: true },
    failures: ["plan_edit failed [EDIT_PLAN_APPLY_FAILED]: Cannot convert undefined or null to object"],
    warnings: [],
    stats,
    ...overrides,
  });
  const plan = {
    segments: [{ sourceVideoId: "video-1", sourceStartTime: 0, sourceEndTime: 4 }],
    transitions: [],
  } as unknown as FailureArtifact["editPlan"];
  const artifact: FailureArtifact = {
    editPlan: plan,
    issues: [
      {
        code: "insufficient_speed_keyframes",
        severity: "error",
        message: "Segment 2 speed ramps need at least two keyframes.",
        path: "segments.2.speedRamp.keyframes",
      } as unknown as PlanIssue,
    ],
  };

  it("writes the plan to a sidecar and keeps it out of the report body", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-sidecar-"));
    try {
      const reportPath = join(root, "baseline-r1-include-18.json");
      const row = serializeCaseResult(make({ artifact }), reportPath);

      expect(row.artifact).toBeUndefined(); // stripped from the report row
      expect(row.failureArtifact).toBe(
        "baseline-r1-include-18.json.failures/pod-02/pod-02-genre#run0.json",
      );
      const sidecar = JSON.parse(readFileSync(join(root, row.failureArtifact ?? ""), "utf8")) as {
        editPlan: unknown;
        issues: { code: string }[];
        failures: string[];
        warnings: string[];
        toolCode: string;
      };
      expect(sidecar.editPlan).toEqual(plan); // plan is IN the sidecar
      expect(sidecar.issues[0]?.code).toBe("insufficient_speed_keyframes");
      expect(sidecar.failures[0]).toContain("EDIT_PLAN_APPLY_FAILED");
      expect(sidecar.toolCode).toBe("EDIT_PLAN_APPLY_FAILED");
      expect(JSON.stringify(row)).not.toContain("sourceVideoId"); // ...and NOT in the report
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes no sidecar when no plan was captured (skip-write)", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-sidecar-"));
    try {
      const reportPath = join(root, "baseline-r1-include-18.json");
      const row = serializeCaseResult(make(), reportPath);
      expect(row.failureArtifact).toBeUndefined();
      expect(existsSync(join(root, "baseline-r1-include-18.json.failures"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes no sidecar for quota rows or passing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "kove-sidecar-"));
    try {
      const reportPath = join(root, "report.json");
      const quota = serializeCaseResult(make({ artifact, quotaExhausted: true }), reportPath);
      const pass = serializeCaseResult(make({ artifact, ok: true, toolCode: null }), reportPath);
      expect(quota.failureArtifact).toBeUndefined();
      expect(pass.failureArtifact).toBeUndefined();
      expect(existsSync(join(root, "report.json.failures"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!LIVE)("baseline v0 (live Workers AI run)", () => {
  it(
    "measures plan-validates / materializes / no-overlap over k runs per combination",
    async () => {
      const summary = await runBaseline({
        limit: LIMIT,
        offset: OFFSET,
        includeIds: INCLUDE.length > 0 ? INCLUDE : undefined,
        runsPerCombo: RUNS,
        reportPath,
        concurrency: 3,
        onCase: result => {
          const gateLabel = [
            result.gates.planValidates ? "plan✓" : "plan✗",
            result.gates.materializes ? "mat✓" : "mat✗",
            result.gates.noClipOverlaps ? "overlap✓" : "overlap✗",
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

      const cases = INCLUDE.length > 0
        ? INCLUDE.length
        : Math.max(0, Math.min(LIMIT ?? 27, 27 - (OFFSET ?? 0)));
      expect(summary.cases).toBe(cases);
      expect(summary.runsPerCombo).toBe(RUNS);
      expect(summary.total).toBeLessThanOrEqual(cases * RUNS);
      expect(summary.sampling).toEqual(PINNED_SAMPLING);
      if (summary.status === "complete") {
        expect(summary.total).toBe(cases * RUNS);
        expect(summary.quotaExcluded).toBe(0);
      } else {
        console.log(`[baseline] ABORTED: ${summary.abortReason}`);
        expect(summary.quotaExcluded).toBeGreaterThan(0);
      }
      const writtenPath = reportPath ?? DEFAULT_REPORT_PATH;
      expect(existsSync(writtenPath), `report not written to ${writtenPath}`).toBe(true);

      // Baseline is a measurement, not a hard gate: assert harness correctness
      // and let the hard-gate rates land in the JSON report.
      const valid = summary.results.filter(result => !result.quotaExhausted);
      expect(summary.passed).toBe(valid.filter(result => result.ok).length);
      for (const result of summary.results) {
        if (result.quotaExhausted) continue;
        expect(typeof result.gates.planValidates, result.id).toBe("boolean");
        expect(typeof result.gates.materializes, result.id).toBe("boolean");
        expect(typeof result.gates.noClipOverlaps, result.id).toBe("boolean");
        expect(result.ok, `${result.id} run ${result.run}: ${result.failures.join(" | ")}`).toBe(
          result.gates.planValidates && result.gates.materializes && result.gates.noClipOverlaps,
        );
        expect(result.stats.durationMs).toBeGreaterThan(0);
      }
      // Quota-excluded runs must never appear inside a gate rate.
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
          `valid ${valid.length}/${summary.total} (quota excluded ${summary.quotaExcluded}); gate rates: ` +
          line("plan_validates", summary.gateRates.planValidates) + "; " +
          line("materializes", summary.gateRates.materializes) + "; " +
          line("no_clip_overlaps", summary.gateRates.noClipOverlaps) + "; " +
          line("all_three", summary.gateRates.allGates),
      );
      console.log(
        `[baseline] determinism across k=${RUNS} (non-quota only): stable pass ${summary.determinism.allPass}, ` +
          `stable fail ${summary.determinism.allFail}, mixed ${summary.determinism.mixed}` +
          (summary.determinism.mixedIds.length
            ? ` → ${summary.determinism.mixedIds.join(", ")}`
            : "") +
          `, incomplete ${summary.determinism.incomplete}` +
          (summary.determinism.incompleteIds.length
            ? ` → ${summary.determinism.incompleteIds.join(", ")}`
            : ""),
      );
    },
    5_400_000,
  );
}, 5_400_000);
