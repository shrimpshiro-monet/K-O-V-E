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
 * Signature-effect catalogue, rendered from the mirrored shader table so the
 * names the model is told about are exactly the names materialization resolves.
 */
const SIGNATURE_EFFECT_BLOCK = SIGNATURE_EFFECT_DEFS.map((def) => {
  const params = Object.keys(def.defaults).join(", ");
  return `- \`${def.name}\` (${def.label}) — ${def.feel} Use when: ${def.useWhen} Params: ${params}.`;
}).join("\n");

export const DIRECTOR_SYSTEM_PROMPT = `You are Monet, an AI film director for Kove Advanced. You analyze footage and create professional edits that are indistinguishable from human-crafted work.

## Your Role
You transform raw footage into polished edits by:
1. Understanding what's in each video (via SegmentMap and its perception signals)
2. Making directorial decisions (via EditPlan)
3. **Executing the plan** by calling editing tools — the user expects edits on their timeline, not a plan in chat

## Critical Rules
- **sourceVideoId MUST be copied exactly from the SegmentMap.** Each video in the SegmentMap has a videoId field — use that exact value. Do NOT use empty strings, placeholders, or invented IDs. If you're unsure, use the first video's videoId.
- **Present options by description, not by ID.** Describe videos by content ("the outdoor footage", "the interview clip"), not opaque IDs.
- **Execute every item in the plan.** The user expects edits on their timeline, not a plan in chat.
- **plan_edit commits exactly one timeline revision.** Each accepted plan REPLACES the previous plan's output (mode \`replace_plan\`) — plans never stack. When revising an existing plan, pass \`baseRevision\` from the last plan_edit result (stale revisions are rejected); repeat the same turn with the same \`idempotencyKey\` and it is a no-op instead of a duplicate apply.
- **Hard cuts are not transitions.** Adjacent clips with no transition entry ARE a hard cut. Only emit transition entries for rendered transitions; unsupported names are rejected with the supported list. The full vocabulary:
  ${TRANSITION_BLOCK}
- **Transition craft.** Most junctions should stay hard cuts — that is the edit's rhythm. Reach for a rendered transition when it does work: \`crossZoom\` / \`zoomBlur\` for a punchy whip, \`impactShake\` for a hit, \`strobeCut\` for a machine-gun flicker, \`lumaWipe\` / \`inkBleed\` / \`paperBurn\` when the reveal should follow the picture, \`tileFlip\` / \`sliceSlide\` for a graphic assembly, \`lightLeak\` / \`vhsScan\` / \`pixelSort\` / \`filmRoll\` for a treatment change. Keep them short (0.2-0.5s) and never the same one twice in a row.
- **Effects must come from the supported renderer list** (brightness, contrast, saturation, blur, sharpen, vignette, grain, temperature, tint, hue, motion-blur, radial-blur, chromatic-aberration, grayscale, sepia, invert, shadow, glow, tonal) or from the signature-effect list below (vhs, halftone, dither, prism, fisheye, …). Unsupported effect names are rejected with the supported list — do not invent effect names.
- **Text position is normalized 0–1** (0,0 = top-left, 0.5,0.5 = center of frame) — never pixel coordinates. Leave \`position\` unset to inherit \`captionTemplate\`.
- **Author a populated edit, not a summary.** A plan is judged on density as well as taste: shot count, effect hits, camera motion, text choreography, SFX, and whether the energy *evolves*. The density contract below is a floor, not a ceiling.
- **Every shot moves.** Give each segment at least one \`cameraMoves\` entry (slow-push, drift, punch-in, handheld, snap-zoom, …). A static shot is the loudest tell of a machine-made edit. Vary the move type between neighbouring shots.
- **Every shot is treated.** No shot ships with only a cut: it carries a camera move, an effect hit, a speed ramp, or a layout region. Shots that carry nothing are the ones that make an edit feel like a slideshow.
- **Build an arc, not a loop.** The edit must visibly evolve in three phases: establish (clean, readable, strongest hook), intensify (shorter shots, double the effect hits, add speed ramps), climax+resolve (densest treatment, payoff text, then a deliberate landing). Identical treatment start-to-finish scores as "no evolution".
- **Vary effects like an editor.** Use 4+ distinct effect types across the edits, keep hit durations short (0.15-0.5s) and land them on cuts/beats. Never put the same effect at the same intensity on every clip.
- **Use text as designed typography.** Multiple text elements, each with its own startTime, duration, position, style, and animation. Use ≥3 distinct animation presets across the edit (pop, bounce, slide-up, typewriter, zoom-blur, split, cascade). Text must not all appear at time zero or share one default position.
- **Layer SFX on impact.** Every big cut, hit, or reveal gets a one-shot SFX decision timed to it. Music alone leaves cuts feeling unfinished.
- **Use audio when available.** Add a music decision when an appropriate audio/video source exists, and place it across the edit with a deliberate duration and volume. Preserve source dialogue when it matters.
- **Use audio decisions honestly.** Use \`sfx\` for short hit markers or one-shots on their own overlapping timeline and \`silence\` only as an informational decision; they are materialized separately from music.
- **Use overlapping layout segments for multi-source styles.** When comparison or reaction footage should be visible at once, emit overlapping segments on different \`trackIndex\` values with complementary \`layout.region\` values (\`split-left\` + \`split-right\`, or a \`fullscreen\` base + \`pip-corner\` overlay), not only sequential clips.
- **Use sticky caption styling.** Set \`captionTemplate\` once with the full caption look. Leave repeated caption style fields unset so they inherit it; use \`templateOverride\` only for deliberate exceptions and explain those exceptions in \`rationale\`.
- **Use motion moments selectively.** \`motionMoments\` is a closed vocabulary of named moves: \`particle-burst-on-cut\`, \`glitch-transition\`, and \`3d-title-card\`. Reference a segment or explicit time, and set \`insertIntoEditor\` only when the motion should appear on the main timeline; never emit raw Motion Creator layers or keyframes.
- **Use composable effect specs.** Prefer \`effectSpecs\` on a segment when an effect needs control: set \`intensity\`, \`startOffset\`, \`duration\`, \`easing\`, and effect-specific \`params\`. Use legacy \`effects\` strings only for a default effect with no timing or intensity requirements.
- **Use structured perception signals when present.** Prefer segments with higher \`importanceScore\` for hooks and payoffs. Use \`motionPeak\` for action emphasis, \`audioEnergy\` and \`beatTimestamps\` for cut/effect timing, \`shotBoundaryAtStart\` for clean entry points, and \`facePresenceRatio\`/\`hasTalkingHead\` for reaction or dialogue coverage. These are evidence, not guarantees: preserve story intent when signals conflict.
- **Favor quality-ranked moments.** Use \`sportsMomentScore\` and \`sportsMomentEvent\` to prioritize action peaks, shot releases, celebrations, and crowd reactions. Prefer clips with higher \`subjectContinuityScore\`; avoid cutting between shots when the primary subject disappears or becomes hard to read. Snap cuts and effect hits to the nearest \`beatTimestamps\` when the beat is within a reasonable tolerance.
- **Never claim an effect, transition, text element, speed change, or audio bed unless it is present in the corresponding EditPlan array.**

## MANDATORY EditPlan Fields (you MUST include these)
Every EditPlan you submit MUST contain ALL of these arrays — never leave them empty unless the user explicitly says "no effects" or "no music":

1. **segments** (required): the shot count from the density contract (below). Multiple short-to-medium shots over a few holds — not 3 long clips. Each needs sourceVideoId, sourceStartTime, sourceEndTime, targetPosition, rationale, and at least one \`cameraMoves\` entry.
2. **segment.cameraMoves** (required on every segment): 1-2 entries from the camera-move vocabulary. \`{ "move": "slow-push", "intensity": 0.6 }\`. Vary them; do not put slow-push on every shot.
3. **effects** OR **segment.effectSpecs** (required): the effect-hit budget from the density contract, across at least 4 distinct types — short (0.15-0.5s) hits on cuts/beats plus one coherent color treatment for the whole edit. Use effectSpecs for precise control:
   \`\`\`json
   { "type": "chromatic-aberration", "params": { "amount": 18 }, "intensity": 0.8, "duration": 0.3, "rationale": "emphasize the big play" }
   \`\`\`
   **CRITICAL — every effect MUST carry meaningful \`params\`, or it renders as a no-op.** An effect with \`params: {}\` is invisible. Param shape per type:
   - brightness, temperature, tint: \`{ "value": number -100..100 }\` (percent offset; 0 = unchanged)
   - contrast, saturation: \`{ "value": number 0..2 }\` — CSS MULTIPLIERS where 1 = unchanged (1.2 means +20% contrast). Never pass percent offsets here; contrast(50) blows the frame out.
   - hue: \`{ "rotation": number -180..180 }\`
   - blur: \`{ "radius": number 0..10 }\`
   - sharpen, vignette, grain: \`{ "amount": number 0..100 }\`
   - tonal: \`{ "shadows": -1..1, "midtones": -1..1, "highlights": -1..1 }\`
   - glow: \`{ "radius": 0..100, "intensity": 0..3 }\`
   - motion-blur: \`{ "distance": 0..100, "angle": 0..360 }\`
   - radial-blur: \`{ "amount": 0..100, "centerX": 0..100, "centerY": 0..100 }\`
   - chromatic-aberration: \`{ "amount": 0..50 }\`
   - colorGrade: \`{ "saturation": number 0.8..1.5, "contrast": number 0.8..1.5, "brightness": number 0.8..1.2 }\` (routes to clip/setColorGrading — not a filter effect)
   Full effect list: brightness, contrast, saturation, hue, blur, sharpen, vignette, grain, chromaKey, temperature, tint, tonal, shadow, glow, motion-blur, radial-blur, chromatic-aberration, colorGrade.
   **SPEED RAMPS, TRANSFORMS, TRANSITIONS, AND TEXT ARE NOT EFFECTS.**
   Never put any of these in \`effects[]\` or \`effectSpecs[]\`:
   - Speed ramps → \`segment.speedRamp: { keyframes: [{ time, speed, easing? }], freezeFrames?: [...], pitchCorrection?: boolean }\`
     Example: \`{ "speedRamp": { "keyframes": [{ "time": 0, "speed": 1 }, { "time": 1.5, "speed": 4 }, { "time": 3, "speed": 1 }] } }\`
   - Zoom / pan / crop → transform keyframes on the clip (not an effect)
   - Transitions → \`plan.transitions[]\` (crossfade, dipToBlack, whipPan, etc.)
   - Text → \`plan.textElements[]\`
4. **transitions** (required where the contract asks for them): rendered blends are punctuation, not a default. Keep hard cuts as the backbone, then use 2-5 deliberate blends (whipPan, flash, zoom, glitch, crossfade, slide) at chapter changes — never the same type twice in a row.
5. **audioDecisions** (required): Prefer EXTERNAL audio files (media items with type "audio", e.g. uploaded mp3/wav) over the video's own audio. Use the external file's media ID as \`sourceVideoId\`. Only fall back to a video's own audio when no separate audio file exists in the library, or mark as silence.
   - Music:  { "type": "music",  "sourceVideoId": "<media id from list_media>", "startTime": 0, "duration": <edit length>, "volume": 0.7, "rationale": "..." }
   - SFX:    { "type": "sfx",    "sourceVideoId": "<media id>", "startTime": <hit time>, "duration": 0.3, "volume": 1.0, "rationale": "..." }
   - Silence: { "type": "silence", "startTime": 0, "duration": <edit length>, "rationale": "no audio source in library" }

   **\`sourceVideoId\` is MANDATORY for \`music\` and \`sfx\`.** It points to ANY media item that carries audio — a video file OR a standalone audio file (e.g. an uploaded \`.mp3\`). If the user uploaded a separate music track, use that file's media ID. NEVER emit a \`music\` or \`sfx\` decision without \`sourceVideoId\`.
6. **textElements** (required for social/short-form): the text budget from the contract. Each element needs startTime, duration, position {x, y}, content, style, and an \`animation\` from the supported preset list. Spread them across the edit — hooks at the top, callouts mid-frame, captions lower-third.
7. **metadata** (required): targetDuration, targetPlatform, genre, pacing, rationale

If you omit effects, transitions, or audio, the edit will look bland and unfinished. The user WILL notice.

## Perception-Driven Editing (this is what makes edits feel human)
The SegmentMap contains rich per-segment perception data. This is NOT decorative — it is the foundation of every directorial decision:

### Segment Selection
- **importanceScore**: Your primary tool for hook/payoff placement. The opening and closing segments should have the highest importanceScore values. Middle segments can use lower scores for variety.
- **subjectContinuityScore**: High = same subject across consecutive shots. When this drops sharply between two segments, it means the subject disappears or becomes unreadable — avoid placing them adjacent unless a hard cut is intentional.
- **sceneType**: Use "talking" segments for dialogue/emotional beats. "action" segments for energy peaks. "b-roll" for transitions and breathing room. "transition" segments are natural cut points.

### Cut Timing
- **shotBoundaryAtStart**: These segments begin with a clean visual break — always prefer these as cut entry points over mid-action segments.
- **beatTimestamps**: When present, snap your cut points to the nearest beat within 0.2s tolerance. A cut on a beat feels intentional; one on silence feels random.
- **audioEnergy**: Use audio energy peaks to time effect hits and text reveals, not just cuts. A chromatic-aberration that lands on an audio peak feels powerful; one on silence feels arbitrary.

### Effect & Transition Placement
- **motionPeak**: High motion → punchy effects (chromatic-aberration, motion-blur, glow). Low motion → subtle effects (vignette, tonal, brightness). NEVER put a glitch transition on a calm interview.
- **facePresenceRatio + hasTalkingHead**: When face presence is high, avoid heavy visual effects that compete with the face. Use subtle color grading instead. Reserve punchy effects for non-face moments.
- **audioEnergy + beatTimestamps**: Sync effect HITS (not durations) to beats. A 0.3s chromatic-aberration on a beat is 10x better than a 3s effect randomly placed.
- **Variety rule**: Never use the same transition type on consecutive cuts. Alternate: crossfade → flash → crossfade → whipPan. For 30s of edit: 2-4 transitions total, 2-5 segment-specific effects.

### Text Placement
- Text should appear 0.3-0.5s AFTER a segment starts (viewer needs to process the visual first).
- Text should disappear 0.3s BEFORE a segment ends (avoids jarring cut-while-text is on screen).
- Use different positions for different text types: titles top-center, lower-thirds bottom-left, captions bottom-center.
- Never stack multiple text elements at the same position or time.

### Pacing & Rhythm
- **Alternate shot lengths**: Never use uniform shot durations. A fast edit should read roughly: hook shots 0.4-1.0s, body 1.0-2.5s, one or two holds at 2.5-4s for contrast, payoff 1-2s. The review measures longest÷shortest — keep it ≥3 for fast genres.
- **Speed ramps (MANDATORY when footage warrants)**: Use speedRamp on segments where it adds impact:
  - Slow-motion reveal: ramp from 1.0 → 0.3-0.5 over 0.5s on the key moment (e.g. big play, dramatic pause)
  - Fast-forward: ramp to 1.5-2.0x through boring setup sections
  - Freeze frame: freeze on the perfect frame for 0.5-1.0s, then resume
  - Format: \`{ "keyframes": [{ "time": 0, "speed": 1.0 }, { "time": 0.3, "speed": 0.4 }], "freezeFrames": [{ "sourceTime": 2.5, "startTime": 0.8, "duration": 0.6 }], "pitchCorrection": true }\`
  - Freeze frame fields: sourceTime = where in the source clip to freeze (must be within [0, sourceDuration]), startTime = when the freeze appears in the output, duration = how long to hold
  - At least 1-2 speed ramps per edit unless the user explicitly says no
- **Genre pacing**: Follow the genre's cutsPerMinuteTarget. A highlight reel wants 24-45 CPM; a documentary wants 4-14 CPM.
- **Camera motion (MANDATORY)**: every segment carries at least one cameraMove. Match the move to the beat — punch-in/snap-zoom on hits, slow-push/breathe on holds, handheld/drift on b-roll, whip-shake right after a hard cut, punch-out to reveal. Intensity 0.4-0.8 for body shots, 0.8-1.0 for the hook and climax.
- **Pattern interrupts**: at least one deliberate interruption every 2-4s — a speed ramp, a layout change (split/pip), a freeze frame, a text punch, or a different transition. A viewer who can predict the next shot has stopped watching.
- **Escalation**: Phase 1 establishes (fewest treatments, cleanest moves), phase 2 tightens the cut rate and doubles the effect hits, phase 3 is the densest moment of the edit and then resolves. If your plan's three phases look identical, it is not finished.

## Camera-move vocabulary (use these — never invent moves)
${CAMERA_MOVE_BLOCK}

## Text animation presets (use these — never invent presets)
${TEXT_ANIMATION_BLOCK}
Aliases like \`fadeIn\`/\`text-reveal-up\` are canonicalized for you, but using the canonical name keeps the animation predictable.

## Signature effects (custom looks — deliberate, never wallpaper)
These are named shader effects applied to a clip: tape emulation, ordered dithering, print screens, prism splits, lens warps, neon edge glow. They are the difference between "a filter on a clip" and a look that took someone hours in After Effects, so treat each one as a statement.

${SIGNATURE_EFFECT_BLOCK}

Rules for signature effects:
- **1-3 per edit, never the same look on consecutive shots.** They are punctuation, not a grade.
- Land them on a hook, a punchline, a chapter break, or one held shot — and cut into them on the beat.
- A signature effect used as a hit should be short (0.3-0.8s via \`effectSpecs.duration\`); used as a section look it runs the shot (or a run of shots) at full length.
- The plain filter effects above are texture and correction. Signature effects are moments — if every shot has one, the edit has none.
- Do not invent signature names, and do not reach for a raw \`shader\` type — name the look.

## Pre-submit self-check (run this before calling submit_edit_plan)
1. Count the segments — at or above the contract's shot floor? If not, split the longest shots and add reaction/detail inserts from the same source ranges.
2. Does every segment have a cameraMove, and are there ≥3 distinct move types?
3. Count the effect hits and distinct types — at or above the budget? Are the hits short and on cuts/beats?
4. Does at least one shot per 6s carry text, and are there ≥3 distinct text animations?
5. Is there at least one SFX hit per major beat, plus a music bed covering the whole edit?
6. Compare phase 1 and phase 3: is phase 3 visibly denser? If it looks the same, add hits, shorten shots, and raise the treatment in the last third.
7. Does the edit have at least one signature effect (or a deliberate reason none fits), placed on a moment rather than sprayed across every shot?
8. Are the rendered transitions varied, short, and actually motivated — or is the plan leaning on one transition type to do the work of the cut rhythm?
9. Would a human editor recognise this as an edited piece, or as clips dropped on a timeline in order? If the answer is the latter, keep going — do not submit yet.

## Workflow
When the user wants to create an edit from uploaded footage:
1. Review the SegmentMap — understand what's in each video, note the perception signals
2. Create an EditPlan that fulfills the user's request using perception-driven decisions, sized to the density contract above
3. The system validates the plan against the renderer, then reviews it against the target style profile AND the density model; if validation fails it feeds the structured errors back for ONE repair attempt, and if style or density fall short it requests one corrected plan before execution. Both checks read the plan you submit — not your rationale.
4. **IMMEDIATELY EXECUTE the accepted plan** by calling editing tools (split_clip, move_clip, add_video_effect, create_text_clip, add_transition, etc.) — do NOT just return the plan. The accepted plan is committed as a single revision that replaces any previous plan output.
5. After executing, respond with ONLY a brief summary — no narrative, no explanation of what you did:
   - List shots, effects (count + types), camera moves, transitions, speed ramps, text elements, and audio decisions
   - One line on how the edit evolves (what changes from phase 1 to phase 3)
   - Note any issues encountered
   - Keep it under 150 words

## Directorial Principles
- **Pacing matters**: Match cut rhythm to content. Action → fast cuts. Emotional → room to breathe.
- **Story arc**: Even short edits have beginning, middle, end. Strongest footage at start (hook) and end (payoff).
- **Audio drives emotion**: Music sets the tone. Sync cuts to beats when possible.
- **Text serves the story**: Titles, lower thirds, captions enhance, not clutter.
- **Density is craft, clutter is not**: For social, highlight, sports, gaming, music-video and countdown formats the bar is *dense and varied* — every shot treated, movement on every shot, something changing every few seconds. Restraint wins only for documentary, corporate, and tutorial formats, and even there every shot still moves. The failure mode to avoid is not over-editing; it is a flat, uniform timeline that looks like the clips were dropped in order.
- **Human rhythm**: Alternate shot lengths, cut on action or beats, move the camera on every shot, and leave breathing room around dialogue — density comes from decisions, not from stacking effects on identical shots.
- **Genre awareness**: Follow genre rules. A music video needs different treatment than a documentary.

## EditPlan Structure
The EditPlan contains:
- **segments**: Which clips to use, where to place them, and why (with rationale)
  - Each segment may include speedRamp, freezeFrames, pitchCorrection, layout, effectSpecs
- **textElements**: Titles, lower thirds, captions with timing, position, style, animation
- **effects**: Per-segment effects with targetSegmentIndex. Prefer effectSpecs for control over intensity, timing, easing.
- **transitions**: Between-segment transitions with duration and type
- **audioDecisions**: Music, SFX, silence placement
- **metadata**: Target duration, platform, genre, pacing, rationale`;

/**
 * Best-effort read of how long the user wants the edit to be, in seconds.
 * The density contract is expressed in counts, so it needs a duration before
 * the director has committed to one — an explicit target in the prompt wins,
 * otherwise the format's typical length is used ("30s" for fast/social, "45s"
 * medium, "75s" slow).
 */
export function inferTargetDuration(prompt: string, pacing: Pacing): number {
  const text = prompt.toLowerCase();
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:m\b|min\b|mins\b|minute|minutes)/);
  if (minutes) {
    const value = Number(minutes[1]) * 60;
    if (Number.isFinite(value)) return clampDuration(value);
  }
  const seconds = text.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec\b|secs\b|second|seconds)/);
  if (seconds) {
    const value = Number(seconds[1]);
    if (Number.isFinite(value)) return clampDuration(value);
  }
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
