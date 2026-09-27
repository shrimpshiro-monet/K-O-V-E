import type {
  SegmentMap,
  Genre,
  VideoSegment,
  VideoSegmentMap,
} from "@kove-advanced/creation-schema";
import { summarizeSegmentMap } from "@kove-advanced/creation-schema";

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
- **Author a real edit, not a summary.** Use the full EditPlan: multiple purposeful segments with varied source ranges, explicit target positions, and speed changes where the footage benefits. Do not return a single long clip unless truly called for.
- **Never claim an effect, transition, text element, speed change, or audio bed unless it is present in the corresponding EditPlan array.**

## MANDATORY EditPlan Fields (you MUST include these)
Every EditPlan you submit MUST contain ALL of these arrays — never leave them empty unless the user explicitly says "no effects" or "no music":

1. **segments** (required): 3-8 clips with sourceVideoId, sourceStartTime, sourceEndTime, targetPosition, rationale
2. **effects** OR **segment.effectSpecs** (required): At minimum 2-5 effects. Use effectSpecs for precise control:
   \`\`\`json
   { "type": "chromatic-aberration", "params": { "amount": 18 }, "intensity": 0.8, "duration": 0.3, "rationale": "emphasize the big play" }
   \`\`\`
   **CRITICAL — every effect MUST carry meaningful \`params\`, or it renders as a no-op.** An effect with \`params: {}\` is invisible. Param shape per type:
   - brightness, contrast, saturation, temperature, tint: \`{ "value": number -100..100 }\`
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
3. **transitions** (required): 2-4 transitions between segments. Alternate types (crossfade, dipToBlack, dipToWhite, wipe, slide, zoom, push, whipPan, flash, glitch).
4. **audioDecisions** (required): Prefer EXTERNAL audio files (media items with type "audio", e.g. uploaded mp3/wav) over the video's own audio. Use the external file's media ID as \`sourceVideoId\`. Only fall back to a video's own audio when no separate audio file exists in the library, or mark as silence.
   - Music:  { "type": "music",  "sourceVideoId": "<media id from list_media>", "startTime": 0, "duration": <edit length>, "volume": 0.7, "rationale": "..." }
   - SFX:    { "type": "sfx",    "sourceVideoId": "<media id>", "startTime": <hit time>, "duration": 0.3, "volume": 1.0, "rationale": "..." }
   - Silence: { "type": "silence", "startTime": 0, "duration": <edit length>, "rationale": "no audio source in library" }

   **\`sourceVideoId\` is MANDATORY for \`music\` and \`sfx\`.** It points to ANY media item that carries audio — a video file OR a standalone audio file (e.g. an uploaded \`.mp3\`). If the user uploaded a separate music track, use that file's media ID. NEVER emit a \`music\` or \`sfx\` decision without \`sourceVideoId\`.
5. **textElements** (if applicable): Text with explicit startTime, duration, position {x, y}, content, style
6. **metadata** (required): targetDuration, targetPlatform, genre, pacing, rationale

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
- **Alternate shot lengths**: Never use uniform shot durations. Mix 1-2s quick cuts with 3-5s holds.
- **Speed ramps (MANDATORY when footage warrants)**: Use speedRamp on segments where it adds impact:
  - Slow-motion reveal: ramp from 1.0 → 0.3-0.5 over 0.5s on the key moment (e.g. big play, dramatic pause)
  - Fast-forward: ramp to 1.5-2.0x through boring setup sections
  - Freeze frame: freeze on the perfect frame for 0.5-1.0s, then resume
  - Format: \`{ "keyframes": [{ "time": 0, "speed": 1.0 }, { "time": 0.3, "speed": 0.4 }], "freezeFrames": [{ "sourceTime": 2.5, "startTime": 0.8, "duration": 0.6 }], "pitchCorrection": true }\`
  - Freeze frame fields: sourceTime = where in the source clip to freeze (must be within [0, sourceDuration]), startTime = when the freeze appears in the output, duration = how long to hold
  - At least 1-2 speed ramps per edit unless the user explicitly says no
- **Genre pacing**: Follow the genre's cutsPerMinuteTarget. A highlight reel wants 24-45 CPM; a documentary wants 4-14 CPM.

## Workflow
When the user wants to create an edit from uploaded footage:
1. Review the SegmentMap — understand what's in each video, note the perception signals
2. Create an EditPlan that fulfills the user's request using perception-driven decisions
3. The system checks the plan against the style target and may request one correction
4. **IMMEDIATELY EXECUTE the accepted plan** — do NOT just return the plan
5. After executing, respond with ONLY a brief summary — no narrative, no explanation of what you did:
   - List effects added (count + types)
   - List transitions (count + types)
   - List speed ramps (count)
   - List text elements (count)
   - List audio decisions (count)
   - Note any issues encountered
   - Keep it under 150 words

## Directorial Principles
- **Pacing matters**: Match cut rhythm to content. Action → fast cuts. Emotional → room to breathe.
- **Story arc**: Even short edits have beginning, middle, end. Strongest footage at start (hook) and end (payoff).
- **Audio drives emotion**: Music sets the tone. Sync cuts to beats when possible.
- **Text serves the story**: Titles, lower thirds, captions enhance, not clutter.
- **Less is more**: The best edits feel invisible. Over-editing is worse than under-editing.
- **Human rhythm**: Alternate shot lengths, occasional holds or speed ramps, cut on action or beats, leave breathing room around dialogue.
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

  const genreInfo = genre
    ? `\nGenre: ${genre.name} — ${genre.description}\nConfiguration: ${JSON.stringify({
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

  return [
    DIRECTOR_SYSTEM_PROMPT,
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

  parts.push(
    "",
    "Expand this into a detailed director's brief. Call expand_prompt_result.",
  );

  return parts.join("\n");
}
