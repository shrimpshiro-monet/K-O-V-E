import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clip, Effect, Track } from "@kove-advanced/core/types/timeline";
import type { Project } from "@kove-advanced/core/types/project";
import type { EditPlan, PlannedSegment } from "@kove-advanced/creation-schema/director/edit-plan";
import { describe, expect, it } from "vitest";
import { loadProjectFile, saveProjectFile } from "./project-io";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { measureRenderedVideoQuality } from "./render-quality";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDir = resolve(repoRoot, "evaluation-files/wow-reviews/curry-hero-montage");
const sourcePath = resolve(repoRoot, "evaluation-files/High Quality Steph Curry Clips for Edits! (2024-25).mp4");
const projectPath = resolve(outputDir, "curry-project.json");
const outputPath = resolve(outputDir, "curry-hero-v2.mp4");
const revisedProjectPath = resolve(outputDir, "curry-project-v2.json");
const revisedPlanPath = resolve(outputDir, "director-plan-v2.json");
const edlPath = resolve(outputDir, "EDIT-DECISIONS-v2.md");
const reportPath = resolve(outputDir, "render-report-v2.json");
const grid = 0.45;
const frameRate = 30;
const act2Start = 6.75;
const act2End = act2Start + 17 * grid;
const flashStart = act2End;
const blackStart = flashStart + 0.1;
const wordmarkStart = blackStart + 0.2;
const duration = blackStart + 1.2;
const colorWheels = {
  shadows: { r: -0.075, g: 0.06, b: 0.095 },
  midtones: { r: -0.07, g: 0.055, b: 0.1 },
  highlights: { r: 0.05, g: 0.025, b: 0 },
  shadowsLift: -0.1,
  midtonesGamma: 1,
  highlightsGain: 1.035,
};

const actionBeats = [
  { source: 36.5, rationale: "Curry drives into the lane; first attack beat." },
  { source: 37.5, rationale: "Curry reaches the rim for the first scoring attempt." },
  { source: 38.5, rationale: "Tight basket-side continuation of the attack." },
  { source: 39.5, rationale: "Curry accelerates into a close-range finish." },
  { source: 44, rationale: "Curry attacks the basket from the wing." },
  { source: 45.5, rationale: "Rim-side finish, held on the key action frame." },
  { source: 47.5, rationale: "Curry rises into the same play's shot; split-screen angle." },
  { source: 52.5, rationale: "Curry's shot release, switched to the yellow-green accent grade." },
  { source: 55, rationale: "Curry attacks the paint as the montage builds." },
  { source: 57, rationale: "Ball travels toward the rim; setup to the make." },
  { source: 58, rationale: "Rim and ball payoff, immediately followed by the reaction beat." },
  { source: 59.5, rationale: "Single Curry reaction after the scoring play." },
  { source: 61.5, rationale: "Curry pushes the ball into the next drive." },
  { source: 62.5, rationale: "Curry attacks the basket from the perimeter." },
  { source: 64, rationale: "Curry elevates into a jump-shot release." },
  { source: 65, rationale: "Ball reaches the rim; action rises toward the climax." },
  { source: 70.5, rationale: "Final Curry shot and strongest visual payoff before the flash." },
] as const;

function effect(id: string, type: string, params: Record<string, unknown>): Effect {
  return { id, type, params, enabled: true };
}

function applyGrade(clip: Clip, isActTwo: boolean, isHighKey: boolean, offPalette: boolean): Clip {
  const keep = clip.effects.filter((item) =>
    !["brightness", "contrast", "saturation", "temperature", "tint", "tonal", "grain", "motion-blur", "shader", "chromatic-aberration"].includes(item.type),
  );
  const gradeEffects = [
    effect(`${clip.id}-grade-exposure`, "brightness", { value: isActTwo ? (isHighKey ? 55 : -20) : -8 }),
    effect(`${clip.id}-grade-contrast`, "contrast", { value: isActTwo ? 1.4 : 1.12 }),
    effect(`${clip.id}-grade-saturation`, "saturation", { value: isActTwo ? 0.9 : 1.04 }),
    effect(`${clip.id}-grade-temperature`, "temperature", { value: isActTwo ? (offPalette ? -5 : -50) : -8 }),
    effect(`${clip.id}-grade-grain`, "grain", { amount: 4 }),
  ];
  if (isActTwo && !offPalette) {
    gradeEffects.push(effect(`${clip.id}-grade-tint`, "tint", { value: -28 }));
  }
  const signatureEffects = offPalette
    ? [effect(`${clip.id}-off-palette`, "shader", {
        shaderId: "duotone",
        shadowColor: "#15261a",
        highlightColor: "#d7ed55",
        mix: 0.38,
        contrast: 1.12,
      })]
    : [];
  return {
    ...clip,
    effects: [...keep, ...gradeEffects, ...signatureEffects],
    colorGrading: {
      colorWheels: offPalette
        ? {
            shadows: { r: -0.02, g: 0.04, b: -0.04 },
            midtones: { r: -0.025, g: 0.045, b: -0.04 },
            highlights: { r: 0.035, g: 0.055, b: -0.04 },
            shadowsLift: -0.1,
            midtonesGamma: 1,
            highlightsGain: 1.035,
          }
        : colorWheels,
    },
  };
}

function formatTime(seconds: number): string {
  const totalMilliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function row(
  index: number,
  start: number,
  sourceStart: number,
  sourceEnd: number,
  effects: string,
  rationale: string,
): string {
  return `| ${index} | ${formatTime(start)}–${formatTime(start + sourceEnd - sourceStart)} | ${formatTime(sourceStart)}–${formatTime(sourceEnd)} | ${(sourceEnd - sourceStart).toFixed(3)}s | ${effects} | ${rationale} |`;
}

function rebuildPlan(oldPlan: EditPlan): EditPlan {
  const opening = oldPlan.segments.slice(0, 3).map((segment, index) => ({
    ...segment,
    sourceEndTime: segment.sourceStartTime + 2.25,
    targetPosition: index * 2.25,
    rationale: [
      "Spotlit Curry walk-on; slow push establishes the hero.",
      "Curry portrait and focus; calm character beat before the drop.",
      "Tension and focus in the final held setup shot.",
    ][index]!,
    cameraMoves: [{ move: "slow-push" as const, intensity: 0.62 }],
  }));
  const segments: PlannedSegment[] = [];
  for (const [index, beat] of actionBeats.entries()) {
    const targetPosition = act2Start + index * grid;
    const effectSpecs: NonNullable<PlannedSegment["effectSpecs"]>[number][] = [
      { type: "brightness", params: { value: index === 16 ? 55 : -20 }, rationale: "Act-two exposure target." },
      { type: "contrast", params: { value: 1.4 }, rationale: "Crushed blacks and hard highlight separation." },
      { type: "saturation", params: { value: 0.9 }, rationale: "Maintain the cinematic palette without flattening the uniform." },
      { type: "temperature", params: { value: index === 7 ? -5 : -50 }, rationale: "Cool the shadows and midtones except the off-palette accent." },
      { type: "grain", params: { amount: 4 }, rationale: "Light film texture." },
    ];
    if (index !== 7) {
      effectSpecs.push({ type: "tint", params: { value: -28 }, rationale: "Bias shadow and midtone color toward teal-green." });
    }
    if ([0, 2, 4, 6, 8, 10, 12, 13, 14, 16].includes(index)) {
      effectSpecs.push({
        type: "motion-blur",
        params: { distance: 12, angle: -8 },
        startOffset: 0,
        duration: 0.1,
        rationale: "Three-frame cut-entry smear, then snap back to sharp.",
      });
    }
    if (index === 2 || index === 13) {
      effectSpecs.push({
        type: "speed-lines",
        params: { amount: 0.34, density: 42, speed: 1.8 },
        startOffset: 0,
        duration: 0.2,
        rationale: "Renderer-backed directional energy on a live drive.",
      });
    }
    if (index === 5 || index === 14) {
      effectSpecs.push({
        type: "prism",
        params: { amount: 7, angle: 0, mix: 0.75 },
        startOffset: 0,
        duration: 0.15,
        rationale: "Brief optical prism hit within the action shot.",
      });
    }
    if (index === 16) {
      effectSpecs.push({
        type: "chromatic-aberration",
        params: { amount: 4 },
        startOffset: 0,
        duration: 0.13,
        rationale: "Short lens split accent on the final shot.",
      });
    }
    segments.push({
      sourceVideoId: "curry-source",
      sourceStartTime: beat.source,
      sourceEndTime: beat.source + grid,
      targetPosition,
      trackIndex: 0,
      effects: [],
      effectSpecs,
      cameraMoves: [],
      rationale: `${beat.rationale} Distinct source window ${beat.source.toFixed(2)}–${(beat.source + grid).toFixed(2)}s on the 0.45s act-two grid.`,
    });
    if (index === 6) {
      segments.push({
        sourceVideoId: "curry-source",
        sourceStartTime: 47,
        sourceEndTime: 47.45,
        targetPosition,
        trackIndex: 1,
        effects: [],
        effectSpecs: [],
        layout: { region: "split-right", fit: "cover" },
        rationale: "Second non-overlapping source angle from the same play; paired in a two-panel split-screen.",
      });
    }
  }
  segments.push(
    {
      sourceVideoId: "flash-white",
      sourceStartTime: 0,
      sourceEndTime: 0.1,
      targetPosition: flashStart,
      trackIndex: 0,
      effects: [],
      rationale: "Three-frame white flash, cut rather than transitioned.",
    },
    {
      sourceVideoId: "black-card",
      sourceStartTime: 0,
      sourceEndTime: 1.2,
      targetPosition: blackStart,
      trackIndex: 0,
      effects: [],
      rationale: "Six clean black frames, then the glowing wordmark over black.",
    },
  );
  for (const targetPosition of [act2Start + 4 * grid, act2Start + 9 * grid, act2Start + 14 * grid]) {
    segments.push({
      sourceVideoId: "black-card",
      sourceStartTime: 0,
      sourceEndTime: 1 / frameRate,
      targetPosition: Math.round(targetPosition * frameRate) / frameRate,
      trackIndex: 2,
      effects: [],
      rationale: "One-frame black hit at a montage beat; never consecutive.",
    });
  }
  return {
    ...oldPlan,
    segments: [...opening, ...segments],
    transitions: [{
      afterSegmentIndex: 2,
      type: "whipPan",
      duration: 0.1,
      rationale: "One native whip transition launches the act-two drop.",
    }],
    audioDecisions: [{
      type: "silence",
      startTime: 0,
      duration,
      rationale: "Audio is explicitly out of scope for this visual revision.",
    }],
    metadata: {
      ...oldPlan.metadata,
      targetDuration: duration,
      rationale: "Three-shot 6.75s slow build, 17 unique action beats on a 0.45s grid, and a flash/black/wordmark landing.",
    },
  };
}

function makeEdl(project: Project): string {
  const main = project.timeline.tracks.find((track) => track.id === "track-4e05f61a-f255-4190-9d64-e1f5ce0d6c5b");
  const splitTrack = project.timeline.tracks.find((track) => track.id === "track-b0c64622-f0c9-409a-a4c8-8b7bfe9edfd4");
  const hitTrack = project.timeline.tracks.find((track) => track.id === "track-a68cbf9b-7a0f-423d-84c3-a7b2ef12dfa2");
  if (!main || !splitTrack || !hitTrack) throw new Error("Expected Curry montage tracks are missing");
  const lines = [
    "# Steph Curry — reference-targeted hero montage v2",
    "",
    "- Plan authorship: hand-authored revision; the configured AI director was unavailable because its provider quota was exhausted.",
    "- Materialization/export: existing K.O.V.E. project; rendered through K.O.V.E.'s browser `ExportEngine`.",
    "- Frame: 576×640 (9:10), 30 fps; audio omitted.",
    `- Runtime target: ${duration.toFixed(2)}s; act two begins at ${act2Start.toFixed(2)}s (${((act2Start / duration) * 100).toFixed(1)}% into the edit).`,
    "- Act-two source selection: 16 action beats and one reaction beat; no repeated source windows.",
    "",
    "| # | Timeline | Source in/out | Duration | Effect stack / transition | Editorial intent |",
    "|---:|---|---|---:|---|---|",
  ];
  const mainClips = main.clips
    .filter((clip) => clip.mediaId === "curry-source")
    .sort((a, b) => a.startTime - b.startTime);
  let rowIndex = 1;
  for (const clip of mainClips) {
    const effects = clip.effects.map((item) =>
      item.type === "shader" ? String(item.params.shaderId) : item.type,
    ).join(", ");
    const label = clip.startTime < act2Start
      ? "Slow push-in; setup portrait"
      : `0.45s action-grid beat ${Math.round((clip.startTime - act2Start) / grid) + 1}`;
    lines.push(row(rowIndex++, clip.startTime, clip.inPoint, clip.outPoint, effects, label));
  }
  for (const clip of splitTrack.clips) {
    lines.push(row(rowIndex++, clip.startTime, clip.inPoint, clip.outPoint, "two-panel split-screen", "Second angle from the same play; non-overlapping source window."));
  }
  for (const clip of hitTrack.clips) {
    lines.push(row(rowIndex++, clip.startTime, clip.inPoint, clip.outPoint, "one-frame black hit", "Single black-frame accent on a drop beat."));
  }
  for (const clip of main.clips.filter((item) => item.mediaId !== "curry-source")) {
    const label = clip.mediaId === "flash-white"
      ? "Three-frame white flash before the black hold."
      : "Six-frame clean black hold, then the wordmark overlay.";
    lines.push(row(rowIndex++, clip.startTime, clip.inPoint, clip.outPoint, "hard cut", label));
  }
  lines.push(
    "",
    "## Grade and rhythm targets",
    "",
    "- Teal shadows/midtones, crushed blacks, controlled amber highlight lift, and light grain across the whole montage.",
    "- Act-two brightness target: mean luma 38–45, p5 = 0, p95 ≥ 200; teal channel skew B−R ≥ 12 and G > R; mean saturation 0.50–0.58.",
    "- Act-two beats remain on a 0.45s cadence; ten of seventeen entrances have a three-frame motion-blur hit that snaps back to sharp.",
    "- One yellow-green off-palette shot, one high-key final shot, a two-panel split-screen, one zoom-punch, and three isolated one-frame black hits.",
    "- No act-two dissolves; one native whip-pan transition leads into the drop.",
    `- Ending: 3-frame flash at ${formatTime(flashStart)} → 6 black frames from ${formatTime(blackStart)} → STEPH CURRY wordmark from ${formatTime(wordmarkStart)}.`,
    "",
    "## Post-render QA",
    "",
    "The generated `render-report-v2.json` records measured color, cadence, rendered cut-boundary visibility, and ending-frame checks. Thresholds are based on the user's comparison targets.",
    "",
  );
  return lines.join("\n");
}

function reviseProject(project: Project): Project {
  const mainId = "track-4e05f61a-f255-4190-9d64-e1f5ce0d6c5b";
  const splitId = "track-b0c64622-f0c9-409a-a4c8-8b7bfe9edfd4";
  const hitId = "track-a68cbf9b-7a0f-423d-84c3-a7b2ef12dfa2";
  const mainTrack = project.timeline.tracks.find((track) => track.id === mainId);
  const splitTrack = project.timeline.tracks.find((track) => track.id === splitId);
  const hitTrack = project.timeline.tracks.find((track) => track.id === hitId);
  if (!mainTrack || !splitTrack || !hitTrack) throw new Error("Expected Curry montage tracks are missing");
  const sourceClips = mainTrack.clips.filter((clip) => clip.mediaId === "curry-source");
  const endings = mainTrack.clips.filter((clip) => clip.mediaId !== "curry-source");
  if (sourceClips.length !== 20 || endings.length !== 2) throw new Error("Curry project timeline shape changed");
  const introBase = sourceClips.slice(0, 3);
  const intro = introBase.map((clip, index) => {
    const inPoint = clip.inPoint;
    const end = inPoint + 2.25;
    const keyframes = [
      { id: `${clip.id}-push-x-start`, time: 0, property: "scale.x", value: 1, easing: "easeInOutSine" as const },
      { id: `${clip.id}-push-x-end`, time: 2.25, property: "scale.x", value: 1.08, easing: "linear" as const },
      { id: `${clip.id}-push-y-start`, time: 0, property: "scale.y", value: 1, easing: "easeInOutSine" as const },
      { id: `${clip.id}-push-y-end`, time: 2.25, property: "scale.y", value: 1.08, easing: "linear" as const },
    ];
    return {
      ...applyGrade(clip, false, false, false),
      startTime: index * 2.25,
      duration: 2.25,
      outPoint: end,
      keyframes,
    };
  });
  const actionTemplates = sourceClips.slice(3, 20);
  const blurIndices = new Set([0, 2, 4, 6, 8, 10, 12, 13, 14, 16]);
  const action = actionTemplates.map((template, index) => {
    const beat = actionBeats[index]!;
    const sourceStart = beat.source;
    const splitLayoutClip = sourceClips[10]!;
    const transform = index === 6 ? splitLayoutClip.transform : sourceClips[3]!.transform;
    const base = applyGrade(
      { ...template, effects: template.effects.filter((item) => item.type !== "motion-blur") },
      true,
      index === 16,
      index === 7,
    );
    const effects = [...base.effects];
    if (blurIndices.has(index)) {
      effects.push(effect(`${template.id}-entry-blur`, "motion-blur", {
        distance: 12,
        angle: -8,
        startOffset: 0,
        duration: 0.1,
      }));
    }
    if (index === 2 || index === 13) {
      effects.push(effect(`${template.id}-drive-lines`, "shader", {
        shaderId: "speed-lines",
        amount: 0.34,
        density: 42,
        speed: 1.8,
        startOffset: 0,
        duration: 0.2,
      }));
    }
    if (index === 5 || index === 14) {
      effects.push(effect(`${template.id}-prism-hit`, "shader", {
        shaderId: "prism",
        amount: 7,
        angle: 0,
        mix: 0.75,
        startOffset: 0,
        duration: 0.15,
      }));
    }
    if (index === 16) {
      effects.push(effect(`${template.id}-final-lens-split`, "chromatic-aberration", {
        amount: 4,
        startOffset: 0,
        duration: 0.13,
      }));
    }
    const zoomPunch = index === 16
      ? [
          { id: `${template.id}-punch-start-x`, time: 0, property: "scale.x", value: 1, easing: "linear" as const },
          { id: `${template.id}-punch-hit-x`, time: 0.1, property: "scale.x", value: 1.16, easing: "easeOutQuart" as const },
          { id: `${template.id}-punch-settle-x`, time: 0.2, property: "scale.x", value: 1.08, easing: "linear" as const },
          { id: `${template.id}-punch-start-y`, time: 0, property: "scale.y", value: 1, easing: "linear" as const },
          { id: `${template.id}-punch-hit-y`, time: 0.1, property: "scale.y", value: 1.16, easing: "easeOutQuart" as const },
          { id: `${template.id}-punch-settle-y`, time: 0.2, property: "scale.y", value: 1.08, easing: "linear" as const },
        ]
      : [];
    return {
      ...base,
      startTime: act2Start + index * grid,
      duration: grid,
      inPoint: sourceStart,
      outPoint: sourceStart + grid,
      transform,
      effects,
      keyframes: zoomPunch,
      ...(index === 16 ? { colorGrading: { ...base.colorGrading, colorWheels, } } : {}),
    };
  });
  const splitTemplate = splitTrack.clips[0]!;
  const splitOverlay = {
    ...applyGrade(splitTemplate, true, false, false),
    startTime: act2Start + 6 * grid,
    duration: grid,
    inPoint: 47,
    outPoint: 47.45,
  };
  const ending = endings.map((clip) => {
    const isFlash = clip.mediaId === "flash-white";
    return {
      ...clip,
      startTime: isFlash ? flashStart : blackStart,
      duration: isFlash ? 0.1 : 1.2,
      inPoint: 0,
      outPoint: isFlash ? 0.1 : 1.2,
    };
  });
  const hitClips = hitTrack.clips.map((clip, index) => {
    const beatIndex = [4, 9, 14][index]!;
    const start = act2Start + beatIndex * grid;
    return {
      ...clip,
      startTime: Math.round(start * frameRate) / frameRate,
      duration: 1 / frameRate,
      inPoint: 0,
      outPoint: 1 / frameRate,
    };
  });
  const textClips = (project.textClips ?? []).map((clip) =>
    clip.text === "STEPH CURRY"
      ? { ...clip, startTime: wordmarkStart, duration: duration - wordmarkStart }
      : clip,
  );
  const transition = mainTrack.transitions.find((item) => item.type === "whipPan");
  if (!transition) throw new Error("The existing drop transition is missing");
  const tracks: Track[] = project.timeline.tracks.map((track) => {
    if (track.id === mainId) {
      return {
        ...track,
        clips: [...intro, ...action, ...ending],
        transitions: [{
          ...transition,
          clipAId: intro[2]!.id,
          clipBId: action[0]!.id,
          duration: 0.1,
        }],
      };
    }
    if (track.id === splitId) return { ...track, clips: [splitOverlay], transitions: [] };
    if (track.id === hitId) return { ...track, clips: hitClips, transitions: [] };
    return track;
  });
  return {
    ...project,
    name: "Steph Curry — The Quiet Before (Reference QA v2)",
    modifiedAt: Date.now(),
    textClips,
    timeline: { ...project.timeline, duration, tracks },
  };
}

describe("Curry reference-targeted revision", () => {
  it("revises, exports, and measures the montage through K.O.V.E.", async () => {
    const project = reviseProject(await loadProjectFile(projectPath));
    const oldPlan = JSON.parse(await readFile(resolve(outputDir, "director-plan.json"), "utf8")) as EditPlan;
    const plan = rebuildPlan(oldPlan);
    await saveProjectFile(revisedProjectPath, project);
    await writeFile(revisedPlanPath, `${JSON.stringify({
      ...plan,
      planAuthorship: "hand-authored; AI director unavailable due provider quota",
      materializer: "K.O.V.E. project timeline; visual effects via K.O.V.E. renderer",
    }, null, 2)}\n`);
    await writeFile(edlPath, makeEdl(project));

    const mediaPaths = {
      "curry-source": sourcePath,
      "flash-white": resolve(outputDir, "white-flash.png"),
      "black-card": resolve(outputDir, "black-hold.png"),
    };
    const snapshot = await createMirrorSnapshot(project, mediaPaths);
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    let renderResult: Awaited<ReturnType<typeof compositor.exportVideo>>;
    try {
      await rm(outputPath, { force: true });
      renderResult = await compositor.exportVideo(snapshot, outputPath, {
        format: "mp4",
        codec: "h264",
        width: 576,
        height: 640,
        frameRate,
        bitrate: 4_500,
        bitrateMode: "vbr",
        quality: 90,
        keyframeInterval: 60,
        audioSettings: {
          format: "aac",
          sampleRate: 48000,
          bitDepth: 16,
          bitrate: 128,
          channels: 2,
        },
      });
    } finally {
      await compositor.close();
    }

    const quality = measureRenderedVideoQuality(outputPath, project, {
      act2Start,
      act2End,
      gridInterval: grid,
      frameRate,
      flashStart,
      blackStart,
      wordmarkStart,
    });
    const report = {
      planAuthorship: "hand-authored; not AI-generated",
      aiDirectorStatus: "plan_edit was attempted; OmniRoute returned free-quota-exhausted (HTTP 403)",
      materializer: "K.O.V.E. project timeline",
      exporter: "K.O.V.E. browser ExportEngine",
      source: "evaluation-files/High Quality Steph Curry Clips for Edits! (2024-25).mp4",
      output: "curry-hero-v2.mp4",
      resolution: "576x640",
      targetDuration: duration,
      actualDuration: renderResult.duration,
      frames: renderResult.framesRendered,
      fileSizeBytes: renderResult.fileSize,
      audioIncluded: false,
      plan: "director-plan-v2.json",
      edl: "EDIT-DECISIONS-v2.md",
      quality,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.info("Curry revision render QA", JSON.stringify(quality, null, 2));
    expect(renderResult.framesRendered).toBeGreaterThan(400);
    expect(quality.resolution).toEqual({ width: 576, height: 640 });
  }, 300_000);
});
