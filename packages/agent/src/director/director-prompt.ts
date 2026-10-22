import type {
  SegmentMap,
  Genre,
  Pacing,
  VideoSegment,
  VideoSegmentMap,
} from "@kove-advanced/creation-schema";
import {
  CAMERA_MOVE_ATLAS,
  SIGNATURE_EFFECT_DEFS,
  SUPPORTED_TEXT_ANIMATIONS,
  SUPPORTED_TRANSITION_TYPES,
  planDensityBudget,
  resolveDensityTarget,
  summarizeSegmentMap,
} from "@kove-advanced/creation-schema";
import { CAPABILITY_MANIFEST } from "@kove-advanced/core/capabilities/manifest";

/**
 * Camera-move table rendered into the system prompt straight from the atlas
 * the compiler implements, so the vocabulary the model is told about can never
 * drift from the vocabulary that renders.
 */
const CAMERA_MOVE_BLOCK = Object.entries(CAMERA_MOVE_ATLAS)
  .map(([id, entry]) => {
    const settle = entry.settles ? " Settles back to the base frame (safe to cut out of)." : "";
    return `- \`${id}\` — ${entry.direction} Use when: ${entry.useWhen}.${settle}`;
  })
  .join("\n");

const TEXT_ANIMATION_BLOCK = SUPPORTED_TEXT_ANIMATIONS.join(", ");

/** Every rendered transition the engine can draw, straight from the schema. */
const TRANSITION_BLOCK = SUPPORTED_TRANSITION_TYPES.join(", ");

/**
 * Effect-param table rendered from the capability manifest — the ONE true
 * scale (core/types/clip-effect-params.ts is the source; the manifest reads
 * the same table). Prompt text must never restate these ranges by hand again:
 * generate the block or the drift comes back.
 */
export const EFFECT_PARAM_BLOCK = CAPABILITY_MANIFEST.clipEffectParams
  .map((spec) => {
    const params = spec.params
      .map(
        (param) =>
          `"${param.key}": ${param.min}..${param.max}${param.unit === "mix" ? "" : ` ${param.unit}`} (default ${param.default}; ${param.note})`,
      )
      .join(", ");
    return `- ${spec.type}: { ${params} }${spec.note ? ` — ${spec.note}` : ""}`;
  })
  .join("\n");

/**
 * Signature-effect catalogue, rendered from the mirrored shader table so the
 * names the model is told about are exactly the names materialization resolves.
 */
const SIGNATURE_EFFECT_BLOCK = SIGNATURE_EFFECT_DEFS.map((def) => {
  const params = Object.keys(def.defaults).join(", ");
  return `- \`${def.name}\` (${def.label}) — ${def.feel} Use when: ${def.useWhen} Params: ${params}.`;
}).join("\n");

/**
 * DIRECTOR_SYSTEM_PROMPT v2
 *
 * Code-side changes required alongside this prompt:
 *  1. EFFECT_PARAM_BLOCK must be GENERATED from the same table the renderer/materializer
 *     reads (the capability manifest). Never hardcode param ranges in any prompt.
 *     Fix the contrast/saturation 0..2 vs -100..100 mismatch in code first.
 *  2. Delete the duplicated director rules (effects, audio, perception, "less is more")
 *     from buildSystemPrompt. The chat agent only needs: call plan_edit once, summarize.
 *  3. Keep buildDirectorPrompt appending the density contract + footage graph.
 *  4. Reviewer gate: add a check that every effectSpec/transition/speedRamp has a
 *     rationale citing a signal (beat@t, motionPeak, importance, boundary). Reject if not.
 *  5. Biggest win: pass 4-6 thumbnails per segment to the planner. Text-only planning
 *     is the ceiling on craft.
 *  6. Optional: split into two calls (cut list first, treatment second).
 *     This prompt works in one call.
 */
export const DIRECTOR_SYSTEM_PROMPT = `You are the director and editor of record for Kove Advanced. You turn analyzed footage into an edit a skilled human editor would be proud of.

You have ONE job: call submit_edit_plan with a complete EditPlan. The system validates and applies it. Do NOT call editing tools, do NOT narrate, do NOT return the plan as chat text.

# Priority order (when rules conflict, higher wins)
1. Valid plan: real sourceVideoId values, supported names only, params that render.
2. The user's request and intent.
3. Story: a clear hook, a spine, and a deliberate landing.
4. Rhythm: shot lengths that breathe and accelerate on purpose.
5. Emphasis: a few accents placed where the footage already peaks.
6. The density contract (appended below this prompt) as a floor on shots, camera moves and text. Meet it by cutting and moving, not by stacking effects.
7. Decoration.

# How to work (do this order, silently)
1. Read the footage graph. Rank segments by importanceScore, motionPeak, sportsMomentScore. Pick the hook (strongest, readable in under 1s) and the payoff (second strongest, or strongest if it is a better ending).
2. Write the spine: hook, build, climax, landing. Assign segments to each part.
3. Build the cut list. For each shot choose the exact source range and give it a reason (see Cuts).
4. Set the rhythm map: durations per phase (see Rhythm).
5. Add emphasis: camera moves, then effect hits, then speed ramps, then signature looks. Every one needs a trigger (see Triggers).
6. Add type, audio, transitions.
7. Run the Review questions. Fix, then submit.

# Source of truth
- sourceVideoId: copy EXACTLY from the footage graph. Never invent or leave empty.
- Vocabularies below are generated from the renderer. If a name is not listed, it does not exist.
- Never claim an effect, transition, text, speed change or audio bed in rationale unless it is in the matching plan array.

# Plan layout (non-negotiable, validated mechanically)
- The main sequence is SEQUENTIAL. targetPosition of each shot = targetPosition + duration of the previous shot. Two segments may share a time range ONLY when they are on different trackIndex values with complementary layout.region (split or pip). Otherwise overlapping segments are a rejected plan.
- Total length: the last shot's targetPosition + duration MUST equal metadata.targetDuration (the target in the density contract), within 5%. Never exceed it. A 30s request is a 30s timeline, not 46 minutes.
- Duration of a shot = (sourceEndTime - sourceStartTime) / speed. Account for speed ramps when you place the next shot.
- Worked example, 12s target, no layout overlays:
  shot 0: source 4.0-5.0, targetPosition 0.0, duration 1.0
  shot 1: source 9.2-11.0, targetPosition 1.0, duration 1.8
  shot 2: source 2.0-3.2, targetPosition 2.8, duration 1.2
  shot 3: source 20.0-22.5, targetPosition 4.0, duration 2.5 ... continue until the last shot ends at exactly 12.0.
  Every targetPosition equals the previous end. No gaps, no stacking.

# Cuts
- Every shot has a rationale of the form "<what it shows> + <why here> + <signal>". Example: "striker release, payoff of the build, motionPeak .91 beat@12.4". No signal means no shot.
- Cut on motion or on a beat, never in dead time. Prefer segments with shotBoundaryAtStart as entry points.
- Snap cut points to the nearest beat within 0.1s. Beat source priority: the music track's beat grid, then the footage beatTimestamps, then motion peaks. Never snap to footage beats when a separate music track is the bed.
- Never cut away from a talking head mid-sentence. For dialogue, offset audio from picture (J-cut or L-cut) by 0.2-0.5s instead of cutting both together.
- Do not place adjacent shots when subjectContinuityScore drops sharply unless the hard cut is the point.
- Use match cuts (similar shape, motion direction or subject position) where footage allows. They read as authored.

# Rhythm
- Never uniform. Vary shot lengths with intent: hook 0.4-1.0s, build 1.0-2.5s, one or two holds of 2.5-4s for contrast, climax shorter than the build, landing a held shot.
- Three phases by runtime thirds. Phase 1: cleanest, readable. Phase 2: average shot length about 70% of phase 1. Phase 3: about 50% of phase 1, then the landing holds longer than anything before it.
- Slow genres (documentary, corporate, tutorial, podcast): longer shots, fewer accents, but still deliberate and still evolving.
- A pattern interrupt every 2-4s in fast genres: a speed ramp, layout change, freeze, text punch or different transition type.

# Triggers (an accent with no trigger is banned)
An effect hit, speed ramp, transition or signature effect must be triggered by one of: a beat timestamp, an audioEnergy peak, a motionPeak, a chapter change, or the hook/payoff moment. Cite it in the rationale.
- Grade: ONE coherent color treatment for the whole edit, chosen from the genre. Not per shot.
- Hits: 0.15-0.5s, landed ON the trigger, at most one per cut. Escalate intensity across phases; do not repeat identical type plus intensity on consecutive hits.
- High motionPeak: punchy (chromatic-aberration, motion-blur, glow). Low motion: subtle (vignette, tonal, brightness).
- High facePresenceRatio or hasTalkingHead: grade only. No glitch, no aberration, no blur on faces.
- Speed ramps: ramp into the peak, hold or slow through it, ramp out. Freeze only on a frame that reads instantly.
- Signature effects: 1-3 per edit, on a moment (hook, punchline, chapter break), never on consecutive shots.
- Hard cuts are the backbone, but a plan with ZERO rendered transitions is incomplete — unless the request explicitly asks for hard cuts only or no transitions, in which case zero rendered transitions is correct and the request wins. Otherwise include at least the density contract's minimum (or 2-5 for a 30s edit when the contract gives none), placed at chapter changes and treatment changes, drawn from the genre's transition palette. Each is 0.2-0.5s, never the same type twice in a row, never a glitch on calm footage. Put them in plan.transitions[]; hard cuts need no entry.

# Camera moves
- Each shot gets a move that matches what the shot is doing: push-in on emphasis, drift on b-roll, handheld on energy, punch or snap on hits, slow-push on holds. Vary neighbors.
- Moves on talking heads stay subtle (intensity 0.2-0.4).
- Prefer moves that settle before the cut. Intensity 0.4-0.8 body, 0.8-1.0 only on hook and climax.
- Shots under 0.6s may carry a single snap move or none.

# Typography
- Text is design. Hierarchy: one hook line, short callouts, captions. Each element has its own start, duration, position, style and animation. Use 3+ distinct animation presets across the edit.
- Reading time: duration at least max(0.8s, words / 3). If a line cannot fit its shot, let it span two shots. Text does not have to start and end with a shot.
- Hook text may start on frame 0. Otherwise start 0.2-0.4s after the shot begins. End before a cut unless it deliberately carries across it.
- Position is normalized 0-1. Respect platform UI: on 9:16 keep text out of the top 10% and bottom 20%. Never place text over the face region. Never stack two elements at the same position and time.
- Set captionTemplate once. Let elements inherit it. Override only deliberately and say why in the rationale.

# Audio
- Music: use an uploaded audio file as sourceVideoId when one exists. Use a video's own audio only if there is no audio file. If nothing carries audio, emit a silence decision.
- sourceVideoId is mandatory for music and sfx. A decision without it renders silent and invalidates the plan.
- Music covers the whole edit, volume about 0.6-0.8, lower under dialogue.
- SFX only on real impacts: big cuts, hits, reveals, text punches. Tie each to its trigger time. Not every cut needs one.
- Preserve source dialogue when it matters.

# Layout and motion moments
- For comparison or reaction styles use overlapping segments on different trackIndex values with complementary layout.region (split-left plus split-right, or fullscreen plus pip-corner).
- motionMoments is a closed vocabulary: particle-burst-on-cut, glitch-transition, 3d-title-card. Use sparingly. Never emit raw Motion Creator layers.

# Effect specs
- Prefer effectSpecs on a segment when you need timing or intensity: intensity, startOffset, duration, easing, params.
- Every effect MUST carry params that render. params: {} is a no-op. Param shapes come from this table (generated from the renderer):
${EFFECT_PARAM_BLOCK}
- Speed ramps, zoom/pan, transitions and text are NOT effects. Never put them in effects[] or effectSpecs[]. Speed: segment.speedRamp. Transitions: plan.transitions[]. Text: plan.textElements[].

# Vocabularies (generated from code)
Camera moves:
${CAMERA_MOVE_BLOCK}

Text animations: ${TEXT_ANIMATION_BLOCK}

Rendered transitions: ${TRANSITION_BLOCK}

Signature effects (statements, not wallpaper):
${SIGNATURE_EFFECT_BLOCK}

# Required plan fields
segments (each with sourceVideoId, sourceStartTime, sourceEndTime, targetPosition, rationale, cameraMoves), effects or effectSpecs, transitions where earned, audioDecisions, textElements (for social/short-form genres, optional elsewhere), metadata (targetDuration, targetPlatform, genre, pacing, rationale). Speed ramps per the density contract.

# Review questions (answer silently, fix before submitting)
1. Does the first second contain the strongest, most readable image, and does the last shot land instead of trail off?
2. Does every shot, effect, ramp and transition cite a real signal? Delete any that cannot.
3. Are phases 2 and 3 measurably faster and denser than phase 1?
4. Any adjacent repeat: same effect, same transition, same camera move, same shot length? Vary or cut it.
5. Any heavy effect on a face, any text over a face, any cut mid-sentence? Fix.
6. Do cuts land on the music beat grid, not the footage's?
7. Are counts at or above the density contract? If short, split long shots and add detail or reaction inserts from the same source ranges. Do not add effects to hit a count.
8. Add up the main-sequence durations: do they equal the target duration (within 5%), with every targetPosition equal to the previous end and no overlaps outside layout overlays? Does plan.transitions[] contain at least the contract minimum (zero is correct only when the request explicitly forbids transitions)?
9. Would a human editor call this authored, or clips dropped on a timeline with filters? If the latter, rework the cut list, not the filters.`;

/**
 * Best-effort read of how long the user wants the edit to be, in seconds.
 * The density contract is expressed in counts, so it needs a duration before
 * the director has committed to one — an explicit target in the prompt wins,
 * otherwise the format's typical length is used ("30s" for fast/social, "45s"
 * medium, "75s" slow).
 */
export function inferTargetDuration(prompt: string, pacing: Pacing): number {
  const text = prompt.toLowerCase();
  const hits: Array<{ value: number; interval: boolean }> = [];
  const pattern = /(\d+(?:\.\d+)?)(?:\s*-\s*|\s*)(minutes?|mins?|seconds?|secs?|m\b|s\b)/g;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 20), index);
    // "every 12-15 seconds" is a per-item rhythm, not a runtime: the tail of
    // a range ("-15 seconds") and counts preceded by every/each/per are
    // intervals. A hyphenated runtime ("45-second") is a real target and now
    // matches the separator at all — it never did with \s* alone.
    const interval =
      text.charAt(index - 1) === "-" || /(?:every|each|per|average|roughly)\s*$/.test(before);
    const minutes = /^m(in|inute)/.test(match[2]) || match[2] === "m";
    hits.push({ value: minutes ? value * 60 : value, interval });
  }
  const chosen = hits.find(hit => !hit.interval) ?? hits[0];
  if (chosen && Number.isFinite(chosen.value)) return clampDuration(chosen.value);
  const fallback = pacing === "fast" ? 30 : pacing === "medium" ? 45 : 75;
  return clampDuration(fallback);
}

function clampDuration(value: number): number {
  return Math.max(6, Math.min(600, value));
}

export interface DirectorDensityContract {
  readonly pacing: Pacing;
  readonly targetDuration: number;
  readonly shots: readonly [number, number];
  readonly effectHits: readonly [number, number];
  readonly cameraMoves: number;
  readonly treatedShots: number;
  readonly texts: readonly [number, number];
  readonly textAnimations: number;
  readonly effectTypes: number;
  readonly speedRamps: number;
  readonly sfxHits: number;
  readonly hookShots: number;
}

/**
 * Turn a genre's density target into the countable floor the director has to
 * hit for this specific request ("for a 30s social edit: 12-24 shots, 6-15
 * effect hits, …"). Per-minute ranges alone are easy for a model to under-
 * deliver; counts are checkable.
 */
export function buildDensityContract(prompt: string, genre?: Genre): DirectorDensityContract {
  const pacing: Pacing = genre?.pacing ?? genre?.rules.pacing ?? "medium";
  const targetDuration = inferTargetDuration(prompt, pacing);
  const budget = planDensityBudget(resolveDensityTarget(pacing, genre?.densityTarget), targetDuration);
  return {
    pacing,
    targetDuration,
    shots: budget.shots,
    effectHits: budget.effectHits,
    cameraMoves: budget.cameraMoves,
    treatedShots: budget.treatedShots,
    texts: budget.texts,
    textAnimations: budget.textAnimations,
    effectTypes: budget.effectTypes,
    speedRamps: budget.speedRamps,
    sfxHits: budget.sfxHits,
    hookShots: budget.hookShots,
  };
}

/** Render the contract as the markdown block injected into the task prompt. */
export function formatDensityContract(contract: DirectorDensityContract): string {
  const lines = [
    `For this request (${contract.targetDuration.toFixed(0)}s, ${contract.pacing} pacing), the floor is:`,
    `- **Shots**: ${contract.shots[0]}-${contract.shots[1]} segments (currently nothing is on the timeline; build it up)`,
    `- **Camera moves**: ≥${contract.cameraMoves} shots with a \`cameraMoves\` entry, ≥3 distinct move types`,
    `- **Effect hits**: ${contract.effectHits[0]}-${contract.effectHits[1]} hits across ≥${contract.effectTypes} distinct effect types`,
    `- **Treated shots**: ≥${contract.treatedShots} of the shots carry a move, effect, speed ramp, or layout`,
    `- **Text**: ${contract.texts[0]}-${contract.texts[1]} elements with ≥${contract.textAnimations} distinct animations`,
    `- **Speed ramps**: ${contract.speedRamps}${contract.speedRamps > 0 ? " (ramp into the peak, ramp out of it)" : ""}`,
    `- **SFX**: ≥${contract.sfxHits} one-shot hits timed to cuts/impacts`,
    `- **Hook**: ≥${contract.hookShots} shot(s) inside the first 2 seconds, before any title card`,
    "- **Evolution**: phase 3 (final third) must be visibly denser than phase 1 — more hits, shorter shots, stronger treatment.",
    "Meeting this floor is the minimum bar for submission, not the goal.",
  ];
  return lines.join("\n");
}

export function resolveDirectorVideoId(
  segmentMap: SegmentMap,
  reference: string,
): string {
  const videos = Array.isArray(segmentMap?.videos) ? segmentMap.videos : [];
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) {
    // Empty or whitespace reference — return the first available video ID
    return videos.length > 0 ? videos[0]!.videoId : reference;
  }
  const videoLookup = new Map<string, string>();

  videos.forEach((video, index) => {
    const aliases = [
      video.videoId,
      `video_${index}`,
      `video-${index}`,
      `clip_${index}`,
      `clip-${index}`,
      `source_${index}`,
      `source-${index}`,
    ];
    const sourceFile = (video as VideoSegmentMap & { sourceFile?: string }).sourceFile;
    if (sourceFile) aliases.push(sourceFile);
    for (const alias of aliases) videoLookup.set(alias.toLowerCase(), video.videoId);
  });

  if (videoLookup.has(normalizedReference)) {
    return videoLookup.get(normalizedReference) as string;
  }
  for (const [alias, videoId] of videoLookup) {
    if (alias.includes(normalizedReference) || normalizedReference.includes(alias)) {
      return videoId;
    }
  }
  // No match — fall back to first video instead of returning the raw reference
  return videos.length > 0 ? videos[0]!.videoId : reference;
}

/**
 * Format a single segment's perception data as a concise, decision-ready summary.
 * Highlights the signals that matter most for directorial decisions.
 */
function formatSegmentSignals(segment: VideoSegment): string {
  const parts: string[] = [];

  if (segment.importanceScore !== undefined) {
    parts.push(`importance=${segment.importanceScore.toFixed(2)}`);
  }
  if (segment.motionPeak !== undefined) {
    parts.push(`motionPeak=${segment.motionPeak.toFixed(2)}`);
  }
  if (segment.audioEnergy !== undefined) {
    parts.push(`audioEnergy=${segment.audioEnergy.toFixed(2)}`);
  }
  if (segment.facePresenceRatio !== undefined) {
    parts.push(`face=${segment.facePresenceRatio.toFixed(2)}`);
  }
  if (segment.hasTalkingHead) parts.push("talkingHead");
  if (segment.shotBoundaryAtStart) parts.push("cleanEntry");
  if (segment.subjectContinuityScore !== undefined) {
    parts.push(`continuity=${segment.subjectContinuityScore.toFixed(2)}`);
  }
  if (segment.beatTimestamps && segment.beatTimestamps.length > 0) {
    parts.push(`beats=[${segment.beatTimestamps.map((b) => b.toFixed(1)).join(",")}]`);
  }
  if (segment.sportsMomentScore !== undefined) {
    parts.push(`sports=${segment.sportsMomentScore.toFixed(2)}(${segment.sportsMomentEvent})`);
  }

  return parts.length > 0 ? ` {${parts.join(", ")}}` : "";
}

/**
 * Format the footage graph in a compact, decision-ready format that highlights
 * perception signals without dumping raw JSON.
 */
function formatFootageGraph(videos: readonly VideoSegmentMap[]): string {
  if (videos.length === 0) return "(no footage)";

  const lines: string[] = [];
  for (const video of videos) {
    const segments = Array.isArray(video.segments) ? video.segments : [];
    const duration = Number.isFinite(video.duration) ? video.duration.toFixed(1) : "?";
    lines.push(`\n### ${video.videoId} (${duration}s, ${segments.length} segments)`);

    for (const seg of segments) {
      const timeRange = `${seg.startTime.toFixed(1)}s-${seg.endTime.toFixed(1)}s`;
      const signals = formatSegmentSignals(seg);
      lines.push(`  [${seg.id}] ${timeRange} — ${seg.description} (${seg.sceneType}, ${seg.motionLevel} motion, conf=${seg.confidence.toFixed(2)})${signals}`);
    }

    // Summarize beat data at video level if present
    const allBeats = segments.flatMap((s) => s.beatTimestamps ?? []);
    if (allBeats.length > 0) {
      const uniqueBeats = [...new Set(allBeats)].sort((a, b) => a - b);
      lines.push(`  Beat timestamps: [${uniqueBeats.map((b) => b.toFixed(1)).join(",")}]`);
    }
  }

  return lines.join("\n");
}

export function buildDirectorPrompt(
  segmentMap: SegmentMap,
  prompt: string,
  genre?: Genre,
  referenceAnalysis?: unknown,
): string {
  const videos = Array.isArray(segmentMap?.videos) ? segmentMap.videos : [];
  const safeMap: SegmentMap = { videos };
  const summary = summarizeSegmentMap(safeMap);
  const hasVisionData = videos.some((v) => {
    const segments: readonly VideoSegment[] = Array.isArray(v.segments)
      ? v.segments
      : [];
    return segments.some((s) => s.confidence > 0.5 || s.description.length > 30);
  });
  const hasPerceptionSignals = videos.some((v) => {
    const segments: readonly VideoSegment[] = Array.isArray(v.segments)
      ? v.segments
      : [];
    return segments.some(
      (s) =>
        s.importanceScore !== undefined ||
        s.motionPeak !== undefined ||
        s.beatTimestamps !== undefined ||
        s.facePresenceRatio !== undefined,
    );
  });
  const videoIds = videos
    .map((video, index) => `- video_${index}: ${video.videoId}`)
    .join("\n");

  // Use the compact, signal-rich format instead of raw JSON
  const footageGraph = formatFootageGraph(videos);

  const genreSignatureLine =
    genre?.signatureEffects && genre.signatureEffects.length > 0
      ? `\nSignature looks this genre reaches for: ${genre.signatureEffects.join(", ")}. Place at most 1-2 of them on moments (hook, punchline, chapter break) — never on every shot.`
      : "";
  const genreInfo = genre
    ? `\nGenre: ${genre.name} — ${genre.description}${genreSignatureLine}\nConfiguration: ${JSON.stringify({
        ...genre,
        styleProfile: genre.styleProfile ?? {
          pacing: genre.pacing ?? genre.rules.pacing,
          cutsPerMinute: genre.cutsPerMinuteTarget,
          cutStyle: genre.rules.cutStyle,
          effectPalette: genre.effectPalette ?? genre.rules.effectPalette,
          transitionPalette: genre.transitionPalette ?? genre.rules.transitionPreference,
        },
        captionTemplate: genre.captionTemplate,
      }, null, 2)}`
    : "";
  const referenceInfo = referenceAnalysis
    ? `\nStyle profile target from reference footage (apply this style to source footage only; do not place reference footage on the timeline):\n${JSON.stringify(referenceAnalysis, null, 2)}`
    : "";

  // Build perception signal summary for quick reference
  let perceptionSummary = "";
  if (hasPerceptionSignals) {
    const highImportance = videos
      .flatMap((v) => (Array.isArray(v.segments) ? v.segments : [])
        .map((s: VideoSegment) => ({ videoId: v.videoId, segment: s })))
      .filter((e) => (e.segment.importanceScore ?? 0) > 0.7)
      .map((e) => `  ${e.videoId}:${e.segment.id} — "${e.segment.description}" (importance=${e.segment.importanceScore!.toFixed(2)})`);
    const highMotion = videos
      .flatMap((v) => (Array.isArray(v.segments) ? v.segments : [])
        .map((s: VideoSegment) => ({ videoId: v.videoId, segment: s })))
      .filter((e) => (e.segment.motionPeak ?? 0) > 0.7)
      .map((e) => `  ${e.videoId}:${e.segment.id} — "${e.segment.description}" (motionPeak=${e.segment.motionPeak!.toFixed(2)})`);
    const talkingHeads = videos
      .flatMap((v) => (Array.isArray(v.segments) ? v.segments : [])
        .map((s: VideoSegment) => ({ videoId: v.videoId, segment: s })))
      .filter((e) => e.segment.hasTalkingHead || (e.segment.facePresenceRatio ?? 0) > 0.6)
      .map((e) => `  ${e.videoId}:${e.segment.id} — "${e.segment.description}" (face=${(e.segment.facePresenceRatio ?? 0).toFixed(2)})`);

    const summaryLines: string[] = [];
    if (highImportance.length > 0) {
      summaryLines.push("High importance (hooks/payoffs):");
      summaryLines.push(...highImportance);
    }
    if (highMotion.length > 0) {
      summaryLines.push("High motion (action emphasis):");
      summaryLines.push(...highMotion);
    }
    if (talkingHeads.length > 0) {
      summaryLines.push("Talking heads / face coverage:");
      summaryLines.push(...talkingHeads);
    }
    if (summaryLines.length > 0) {
      perceptionSummary = `\n## Quick perception reference\n${summaryLines.join("\n")}`;
    }
  }

  const densityContract = buildDensityContract(prompt, genre);

  return [
    DIRECTOR_SYSTEM_PROMPT,
    "",
    "## Edit density contract (MANDATORY for this request)",
    formatDensityContract(densityContract),
    "",
    "## Current Task",
    `User request: "${prompt}"`,
    "",
    `Available footage: ${summary}`,
    "Canonical sourceVideoId values (use the value after the colon, never the alias):",
    videoIds || "(none)",
    perceptionSummary,
    "",
    "## Footage Analysis",
    "Use this analyzed segment data as the source of truth for timing, moment importance, subject coverage, and confidence.",
    "Pay special attention to the perception signals in {brackets} — they drive editorial decisions.",
    footageGraph,
    hasVisionData
      ? "\nNote: This footage was analyzed with real frame sampling and vision AI. Trust the scene descriptions, confidence scores, motion levels, and structured perception signals — they reflect evidence from the actual video."
      : "\nNote: This footage only has metadata-level analysis. Scene descriptions are placeholders — review the user's prompt to infer content.",
    genreInfo,
    referenceInfo,
    "",
    "Analyze the segments using perception-driven editing principles and create an EditPlan that fulfills this request.",
  ].join("\n");
}

export const EXPANSION_SYSTEM_PROMPT = `You are Monet, an AI film director for Kove Advanced. Your job right now is to take a user's prompt and expand it into a rich, detailed director's brief.

## Your Role
You transform vague or incomplete prompts into detailed, actionable editing instructions. You use the available footage context to inform your expansion.

## Rules
1. **Never ask for internal IDs** — work with descriptions, not identifiers.
2. **Be specific and cinematic** — use film language, not generic terms.
3. **Ground in the footage** — reference actual segment descriptions and their perception signals when expanding.
4. **Keep the user's intent** — expand on their vision, don't replace it.
5. **Platform-aware** — default to the prompt's implied platform, or pick the most likely one.
6. **Be opinionated** — make directorial choices. A vague prompt deserves a strong creative vision, not a generic template.

## Output Format
Call expand_prompt_result with your expansion. The expanded prompt should be 2-4 sentences that read like a director's brief — specific, visual, and actionable.

## Examples

Vague: "make something cool"
Expanded: "High-energy montage edit with punchy cuts synced to beat drops. Open with the strongest action shot, alternate between wide and tight angles, and close with a slow-motion payoff. Add bold sans-serif text overlays at key moments."

Vague: "help me make a tiktok"
Expanded: "Fast-paced 30-second TikTok edit optimized for vertical (9:16). Hook viewers in the first 2 seconds with the most visually striking clip. Use quick transitions (0.2-0.3s), trendy motion effects, and burned-in captions for accessibility. End with a strong visual that invites replay."

Vague: "turn this into a reel"
Expanded: "60-second Instagram Reel with a strong visual hook in the first frame. Use 3-5 of the best clips with 0.3-0.5s transitions, sync major cuts to the music beat, and add minimal text overlays for context. Keep the energy high throughout and end on the most visually striking moment."`;

export function buildExpansionPrompt(
  prompt: string,
  segmentMap?: SegmentMap,
  genre?: Genre,
): string {
  const parts: string[] = [
    EXPANSION_SYSTEM_PROMPT,
    "",
    "## User Prompt",
    `"${prompt}"`,
  ];

  if (segmentMap?.videos?.length) {
    const summary = summarizeSegmentMap(segmentMap);
    parts.push("", "## Available Footage", summary);

    // Include perception signals in the expansion context
    const descriptions = segmentMap.videos
      .flatMap((v) =>
        (Array.isArray(v.segments) ? v.segments : []).slice(0, 5).map(
          (s) => {
            const signals: string[] = [];
            if (s.importanceScore !== undefined) signals.push(`importance=${s.importanceScore.toFixed(2)}`);
            if (s.motionPeak !== undefined) signals.push(`motion=${s.motionPeak.toFixed(2)}`);
            if (s.hasTalkingHead) signals.push("talkingHead");
            const signalStr = signals.length > 0 ? ` [${signals.join(", ")}]` : "";
            return `- ${s.description} (${s.sceneType}, ${s.motionLevel} motion)${signalStr}`;
          },
        ),
      )
      .slice(0, 10);
    if (descriptions.length > 0) {
      parts.push("", "Key moments:", ...descriptions);
    }
  }

  if (genre) {
    parts.push("", "## Genre", `${genre.name} — ${genre.description}`);
  }

  // Name the signature looks the director can actually render, so an expansion
  // can ask for "a VHS-tape hook" instead of the vague "cool effects" that the
  // planner then has no vocabulary to satisfy.
  parts.push(
    "",
    "## Effects you may name in the brief",
    `Signature shader effects (exact names): ${SIGNATURE_EFFECT_DEFS.map((def) => def.name).join(", ")}.`,
    SIGNATURE_EFFECT_DEFS.map((def) => `- ${def.name}: ${def.feel}`).join("\n"),
    "Mention at most 1-3 of these, and say where they land (hook, payoff, chapter break). Plain filter effects (brightness, contrast, saturation, glow, vignette, grain, blur, chromatic-aberration, …) are for texture — do not enumerate them.",
  );

  parts.push(
    "",
    "Expand this into a detailed director's brief. Call expand_prompt_result.",
  );

  return parts.join("\n");
}
