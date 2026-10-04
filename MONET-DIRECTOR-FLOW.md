# Monet AI Director — Complete Flow

> What happens from the moment the user types a prompt to the final timeline output.

---

## Overview

Monet is a chat-first AI director. The user gives a prompt, Monet produces a structured `EditPlan`, and materializes it directly onto the timeline — clips, effects, transitions, text, audio, motion. One shot. If the user wants changes, they ask via chat and Monet edits the existing timeline with clip/effect/text tools.

---

## Phase 1: User Prompt Arrives

The user types a message in chat (e.g. "Create a 15-second highlight reel of Steph Curry").

**`packages/agent/src/loop.ts:194`** — `runTurn()` is called with the full conversation history, the LLM client, available tools, and `enforceDirectorWorkflow: true`.

The loop initializes:
- `maxSteps = 12` (LLM completion rounds)
- `maxToolCalls = 64`
- `planEditAttempted = false`
- `directorPlanCompleted = false`

---

## Phase 2: Director Request Detection

**`loop.ts:56`** — A regex checks the latest user message for editing keywords:

```
DIRECTOR_REQUEST = /\b(edit|video|footage|clip|cut|trim|highlight|reel, montage,
  reference|b-roll|vlog|podcast|timeline|sequence|splice|join)\b/i
```

If the prompt matches AND `enforceDirectorWorkflow` is true, the full director flow activates.

---

## Phase 3: Automatic Discovery Checkup

**`loop.ts:227-249`** — Before the LLM sees the user's message, the loop silently executes 3 discovery tools to populate the conversation with project context:

| Step | Tool | Purpose |
|------|------|---------|
| 1 | `get_capabilities` | Available tools, effect types, transition types, enums |
| 2 | `get_editor_state` | Current timeline, tracks, clips, playhead position |
| 3 | `list_media` | All imported media — IDs, names, durations, types |

These results are injected as tool-role messages so the LLM has full context before deciding what to do.

---

## Phase 4: LLM Completion #1

**`loop.ts:266`** — The system prompt is built via `buildSystemPrompt()`:

**`system-prompt.ts:41-142`** assembles:
1. **Core identity**: "You are Kove Advanced's video-editing agent."
2. **Core rules**: ID discovery, read-before-write, one-shot plan_edit
3. **Monet Director Workflow**: The 4-step director process, perception-driven editing rules, effect/transition placement guidelines
4. **Current editor state**: Serialized JSON of the project
5. **Capability doc**: Tool schemas and parameter reference

The LLM receives this system prompt + the user message + the 3 checkup results, and decides which tools to call.

---

## Phase 5: Tool Execution — Director Guard

**`loop.ts:333-376`** — The loop processes each tool call from the LLM response:

**Director guard**: If `plan_edit` hasn't been called yet, ALL non-read-only, non-discovery editing tools are blocked with:
> "Planning is required before editing — Call plan_edit directly before any editing tool."

**One-shot guard**: If `plan_edit` has already been called this turn, any second `plan_edit` call is blocked with:
> "plan_edit was already called this turn. To refine the edit, describe what you want changed and use clip/effect/text tools to modify the existing timeline."

The LLM is expected to call `plan_edit` as its first (and only) editing action.

---

## Phase 6: The `plan_edit` Tool

**`registry.ts:33003-33199`** — This is where the magic happens. One tool call handles the entire director pipeline.

### 6.1 Input Validation

```
1. host.requireOpenProject()              → fail if no project open
2. prompt = args.prompt?.trim()            → fail if empty
3. host.llm must exist                     → fail if no LLM configured
4. videoMedia.length > 0                   → fail if no video in project
```

### 6.2 SegmentMap Resolution

The SegmentMap describes all available footage and their segments.

**If provided** (from `extract_segments` vision analysis):
```
resolvedMap = providedMap  // has real per-segment perception data
```

**If not provided** (fallback):
```
For each video in the project (excluding reference files):
  Create a single segment covering [0, fullDuration]
  Set sceneType: "b-roll", motionLevel: "medium", confidence: 0.5
```

### 6.3 Genre Lookup

**`director/genres.ts:3-292`** — If a `genreId` was passed, look up the pre-baked genre config:
- `highlight-reel`, `documentary`, `vlog`, `tutorial`, `music-video`, `corporate`, `social-reel`, `same-person-compare`, `kill-montage`, `cinematic-trailer`, `podcast-clip`, etc.
- Each genre defines: pacing rules, cut frequency, effect palette, transition palette, style profile targets

### 6.4 Director Prompt Construction

**`director/director-prompt.ts:213-327`** — `buildDirectorPrompt()` assembles the LLM prompt:

1. **System prompt** (`DIRECTOR_SYSTEM_PROMPT`, line 9-108): Role definition, critical rules, EditPlan field documentation, perception-driven editing principles
2. **Footage graph** (`formatFootageGraph()`, line 187): Per-video, per-segment summary with perception signals:
   ```
   ### video_0 (45.2s, 8 segments)
     [seg-0] 0.0s-5.2s — Opening shot (action, high motion, conf=0.92)
       {importance=0.85, motionPeak=0.72, beats=[1.2,2.4,3.6]}
   ```
3. **Genre config**: Style profile targets, pacing rules, effect/transition preferences
4. **Reference style**: If a reference video was analyzed, its style profile
5. **Quick perception reference**: Highlighted high-importance (>0.7), high-motion (>0.7), and talking-head segments

### 6.5 LLM Sub-Call (Director Call)

**`registry.ts:33067-33085`** — A dedicated LLM call with ONLY the `submit_edit_plan` tool available:

```
system: directorPrompt (the full Monet prompt)
messages: [{ role: "user", content: "Analyze the footage and call submit_edit_plan..." }]
tools: [submit_edit_plan]   ← ONLY tool available
maxTokens: 8192
```

The `submit_edit_plan` tool schema defines the exact EditPlan structure:
- `segments[]`: sourceVideoId, sourceStartTime, sourceEndTime, trackIndex, targetPosition, speed, speedRamp, effects, effectSpecs, layout
- `textElements[]`: content, style, startTime, duration, position, font, color, animation
- `effects[]`: targetSegmentIndex, type, params, intensity
- `transitions[]`: afterSegmentIndex, type, duration
- `audioDecisions[]`: type, sourceVideoId, timing, volume
- `motionMoments[]`: move type, segmentIndex, timing
- `metadata`: targetDuration, targetPlatform, genre, pacing, rationale

The tool is **internal-only** — it captures structured output from the LLM. It never executes directly.

### 6.6 Normalize Raw LLM Output

**`registry.ts:2422-2479`** — `normalizeDirectorPlanInput()`:

1. Parse raw JSON into typed `EditPlan`
2. For each segment: ensure `sourceVideoId` is a string, filter effects to strings, filter effectSpecs to objects
3. Process speed ramps: filter keyframes/freezeFrames to valid objects, filter out freeze frames with non-finite values or `startTime < 0`
4. Process motion moments: validate move type is one of `particle-burst-on-cut`, `glitch-transition`, `3d-title-card`
5. Default metadata fields

### 6.7 Resolve Video IDs

**`director/director-prompt.ts:110-147`** — `resolveDirectorVideoId()`:

Maps each segment's `sourceVideoId` from LLM-provided aliases (`video_0`, `clip-1`, `source_0`) to the canonical `videoId` in the SegmentMap.

### 6.8 Normalize Timing

**`creation-schema/director/validate.ts:280-326`** — `normalizeEditPlan()`:

1. **Per-segment**: Clamp `sourceStartTime`/`sourceEndTime` to `[0, video.duration]`. If `end <= start`, reset to `[0, duration]`
2. **Per-transition**: Clamp duration to `[0.25, min(prevSeg, nextSeg) * 2]`

### 6.9 Validate

**`creation-schema/director/validate.ts:111-224`** — `validateEditPlan()`:

| Check | Severity | Code |
|-------|----------|------|
| No segments | warning | `empty_plan` |
| Unknown source video | error | `unknown_source_video` |
| Zero/negative source duration | error | `bad_source_range` |
| Negative target position | error | `negative_position` |
| Custom layout rect out of bounds | error | `invalid_layout_rect` |
| Speed ramp < 2 keyframes | error | `insufficient_speed_keyframes` |
| Keyframe time out of range | error | `speed_keyframe_out_of_range` |
| Keyframes not sorted | error | `speed_keyframes_unsorted` |
| Speed out of [0.1, 20] | error | `speed_out_of_range` |
| Freeze frame non-finite values | error | `invalid_freeze_frame` |
| Freeze frame out of range | warning | `clamp_freeze_frame` (clamped by materializer) |
| Effect intensity out of [0,1] | warning | `effect_intensity_out_of_range` (clamped) |
| Effect startOffset negative | warning | `effect_offset_out_of_range` (clamped) |
| Effect duration non-positive | warning | `effect_duration_invalid` (clamped) |
| Effect empty type | error | `empty_effect_type` |
| Orphan split/PiP layout | warning | `orphan_split_layout` / `orphan_pip_layout` |
| Invalid motion segment index | error | `invalid_motion_segment` |
| Target duration <= 0 | error | `bad_target_duration` |

**Blocking check**: If ANY error-severity issues exist → return `INVALID_EDIT_PLAN` and stop.

### 6.10 Style Review

**`director/plan-review.ts:100-115`** — `reviewEditPlan()`:

1. **Measure style profile** (`measureEditPlanStyle()`): Computes cutsPerMinute, medianShotDuration, effectDensity, transitionDensity, textOverlayDensity, musicRatio, cutStyle
2. **Merge targets**: Combine genre targets + reference video targets
3. **Compare**: Score the plan against the target profile
4. If `score < 0.6` → **needs revision**

### 6.11 Revision (If Needed)

**`registry.ts:33109-33142`** — One revision attempt:

1. Build revision prompt with the score and deviations
2. Send current plan as JSON to the LLM
3. LLM returns revised plan via `submit_edit_plan`
4. Normalize + validate the revision
5. If no blocking errors → accept revision, re-review

### 6.12 Materialize Onto Timeline

**`registry.ts:2019-2309`** — `materializeEditPlan()`:

#### Step 1: Tear Down Previous Plan
If this project has a previous plan stored (from a prior `plan_edit` call):
1. Remove all previous text overlays (best-effort)
2. Remove all previous video/audio clips (best-effort)
3. Delete stored state

#### Step 2: Create/Find Video Track
```
videoTrack = project.timeline.tracks.find(t => t.type === "video")
if (!videoTrack) → create via track/add
```

#### Step 3: Insert Video Clips
For each segment:
1. Create additional tracks if `trackIndex` exceeds existing count
2. Calculate position (after previous clip, or at `targetPosition`, or appended)
3. Insert clip via `clip/add` with `inPoint`, `outPoint`, `duration`, optional `speed`
4. Apply layout transform if not fullscreen (split, PiP, custom rect)
5. Apply speed ramp with keyframes and freeze frames via `speed/setRampData`

#### Step 4: Apply Effects
Collect effects from `plan.effects`, `plan.segments[].effectSpecs`, and `plan.segments[].effects`. For each:
- Color grading → `clip/setColorGrading`
- Other effects → `effect/add` with intensity clamped to [0,1]

#### Step 5: Apply Audio
For each audio decision (music/sfx):
- Find or create target audio track ("Music" or "SFX")
- Insert audio clip via `clip/add` with volume clamped to [0,4]

#### Step 6: Apply Transitions
For each transition between consecutive segments:
- `transition/add` with clipA, clipB, type, duration

#### Step 7: Create Text Overlays
For each text element:
- Resolve style from caption template + per-element overrides
- Create overlay via `host.createTextOverlay()`
- Position via `transform/update`

#### Step 8: Motion Moments
For each motion moment:
- Create motion composition (particle burst, glitch transition, or 3D title card)
- Insert into timeline at the target clip's time

#### Step 9: Store State
Save `{ clipIds, textIds }` for this project so the next `plan_edit` can tear down before replacing.

### 6.13 Quality Pipeline

**`director/quality-pipeline.ts`** — Post-materialization review:

#### Frame Sampling
`sampleRenderedFrames()`: Render and extract 4-20 frames at evenly-spaced timestamps. For each frame measure: sharpness, subject visibility, text legibility, audio energy, black frame detection.

#### Three-Layer Review

| Review | What It Checks | Weight |
|--------|---------------|--------|
| **Visual frame review** | Black frames, blur, low visibility, unreadable text | 25% |
| **Draft execution review** | Expected vs applied effects/transitions/text, low-confidence segments | 35% |
| **Editorial quality review** | Pacing (cuts/minute), variety (no duplicate transitions), beat alignment, text overlaps | 40% |

**Combined score** formula:
```
0.25 * visualScore + 0.35 * executionScore + 0.15 * pacingScore + 0.15 * varietyScore + 0.10 * beatScore
```

#### Auto-Corrections
If `combinedScore < 0.65` or issues detected:
- **Effect corrections**: Re-apply effects to specific clips
- **Timing corrections**: Move clips to correct positions
- Transition/pacing/text corrections: Advisory only (logged for the LLM)

### 6.14 Return

`plan_edit` returns success with:
- Clip count, text overlay count, effect count, transition count, audio count
- Quality score percentage
- Validation warnings
- Style review score and deviations
- Quality pipeline details

---

## Phase 7: Loop Continues

**`loop.ts:411-416`** — After `plan_edit` returns:
- `directorPlanCompleted = true` → all editing tools are now unlocked
- `planEditAttempted = true` → second `plan_edit` call blocked

The LLM sees the `plan_edit` result, may execute additional tool calls (if the plan had issues or the LLM wants to make targeted adjustments), and eventually generates a text response summarizing what was done.

---

## Phase 8: Turn Ends

When the LLM produces a response with no more tool uses, the turn completes:
- Transaction is committed
- `RunTurnResult` returned with: final text, messages, tool call count, stop reason, usage stats

---

## Complete Call Graph

```
User types prompt
  │
  ▼
runTurn()                                    loop.ts:194
  │
  ├─ DIRECTOR_REQUEST regex test             loop.ts:56
  │
  ├─ [CHECKUP SEQUENCE]                      loop.ts:227-249
  │   ├─ get_capabilities
  │   ├─ get_editor_state
  │   └─ list_media
  │
  ├─ [LLM COMPLETION #1]                     loop.ts:266
  │   └─ system = buildSystemPrompt()        system-prompt.ts:41
  │
  ├─ [TOOL EXECUTION LOOP]                   loop.ts:296-423
  │   │
  │   └─ plan_edit                           registry.ts:33003
  │       │
  │       ├─ Validate inputs                 33003-33011
  │       ├─ Resolve SegmentMap              33022-33056
  │       ├─ Genre lookup                    33058
  │       ├─ buildDirectorPrompt()           director-prompt.ts:213
  │       │   ├─ DIRECTOR_SYSTEM_PROMPT      director-prompt.ts:9
  │       │   ├─ formatFootageGraph()        director-prompt.ts:187
  │       │   └─ Genre + reference config
  │       │
  │       ├─ [DIRECTOR LLM SUB-CALL]         33067-33085
  │       │   └─ tools: [submit_edit_plan]
  │       │   └─ maxTokens: 8192
  │       │
  │       ├─ normalizeDirectorPlanInput()    registry.ts:2422
  │       ├─ resolveDirectorVideoId()        director-prompt.ts:110
  │       ├─ normalizeEditPlan()             validate.ts:280
  │       ├─ validateEditPlan()              validate.ts:111
  │       │
  │       ├─ reviewEditPlan()                plan-review.ts:100
  │       │   ├─ measureEditPlanStyle()      plan-review.ts:117
  │       │   └─ compareStyleProfile()       style-profile.ts:36
  │       │
  │       ├─ [REVISION IF NEEDED]            33109-33142
  │       │
  │       ├─ materializeEditPlan()           registry.ts:2019
  │       │   ├─ Tear down previous plan     2024-2045
  │       │   ├─ Create video track          2047-2058
  │       │   ├─ Insert video clips          2067-2162
  │       │   │   ├─ Layout transforms
  │       │   │   └─ Speed ramps + freeze frames
  │       │   ├─ Apply effects               2164-2202
  │       │   ├─ Apply audio                 2204-2244
  │       │   ├─ Apply transitions           2246-2259
  │       │   ├─ Create text overlays        2261-2303
  │       │   └─ Materialize motion moments  2311
  │       │
  │       ├─ sampleRenderedFrames()          quality-pipeline.ts:50
  │       ├─ runQualityPipeline()            quality-pipeline.ts:98
  │       │   ├─ reviewRenderedDraft()       quality-signals.ts:70
  │       │   ├─ reviewMaterializedDraft()   plan-review.ts:43
  │       │   └─ reviewEditorialQuality()    quality-pipeline.ts:217
  │       │
  │       ├─ applyTargetedCorrections()      quality-pipeline.ts:128
  │       │
  │       └─ return ok(result)               33177-33199
  │
  ├─ directorPlanCompleted = true            loop.ts:411
  ├─ planEditAttempted = true                loop.ts:414
  │
  └─ [LOOP CONTINUES until no toolUses]
```

---

## Key Files Reference

| Component | File | Lines |
|-----------|------|-------|
| Agent loop | `packages/agent/src/loop.ts` | 194-438 |
| System prompt | `packages/agent/src/system-prompt.ts` | 41-142 |
| Tool routing | `packages/agent/src/tool-router.ts` | 89-131 |
| `plan_edit` tool | `packages/agent/src/registry.ts` | 33003-33199 |
| `submit_edit_plan` schema | `packages/agent/src/registry.ts` | 32803-32896 |
| `normalizeDirectorPlanInput` | `packages/agent/src/registry.ts` | 2422-2479 |
| `materializeEditPlan` | `packages/agent/src/registry.ts` | 2019-2309 |
| Director prompt builder | `packages/agent/src/director/director-prompt.ts` | 213-327 |
| Director system prompt | `packages/agent/src/director/director-prompt.ts` | 9-108 |
| Style review | `packages/agent/src/director/plan-review.ts` | 100-115 |
| Quality pipeline | `packages/agent/src/director/quality-pipeline.ts` | 50-434 |
| Genre definitions | `packages/agent/src/director/genres.ts` | 3-292 |
| Motion moves | `packages/agent/src/director/motion-moves.ts` | 48-61 |
| EditPlan type | `packages/creation-schema/src/director/edit-plan.ts` | 165-174 |
| Validation | `packages/creation-schema/src/director/validate.ts` | 111-224 |
| Normalization | `packages/creation-schema/src/director/validate.ts` | 280-326 |
| Style profile comparison | `packages/creation-schema/src/director/style-profile.ts` | 36-81 |
| Quality signals | `packages/creation-schema/src/director/quality-signals.ts` | 70-85 |

---

# Source Code

## `packages/agent/src/loop.ts`

```typescript
import type { EditingHost } from "./host";
import type { AgentEvent, ConfirmDecision, ToolCall, ToolResult } from "./types";
import type {
  LLMClient,
  LoopMessage,
  LLMUsage,
  LoopToolResult,
  LoopToolResultBlock,
} from "./llm";
import { executeTool, isDestructive, isExpensive } from "./executor";
import { getTool } from "./registry";

export interface RunTurnInput {
  readonly host: EditingHost;
  readonly llm: LLMClient;
  readonly tools: unknown[];
  readonly system?: string;
  readonly messages: LoopMessage[];
  readonly confirmGate?: (call: ToolCall) => Promise<ConfirmDecision> | ConfirmDecision;
  readonly onEvent?: (event: AgentEvent) => void;
  readonly limits?: { maxSteps?: number; maxToolCalls?: number; maxTokens?: number };
  readonly dryRun?: boolean;
  readonly turnLabel?: string;
  readonly enforceDirectorWorkflow?: boolean;
}

export type StopReason =
  | "end_turn"
  | "max_steps"
  | "max_tool_calls"
  | "budget"
  | "error";

export interface RunTurnResult {
  readonly text: string;
  readonly messages: LoopMessage[];
  readonly toolCalls: number;
  readonly stoppedReason: StopReason;
  readonly committed: boolean;
  readonly usage: LLMUsage;
}

const isReadOnly = (name: string): boolean => getTool(name)?.readOnly ?? false;

const isDirectorDiscoveryTool = (name: string): boolean =>
  name === "extract_segments" || name === "create_project" || name === "list_media" || name === "import_media_from_url" || name === "get_capabilities" || name === "get_editor_state";

const DIRECTOR_REQUEST = /\b(edit|video|footage|clip|cut|trim|highlight|reel|montage|reference|b-roll|vlog|podcast|timeline|sequence|splice|join)\b/i;

const RETRYABLE_CODES = new Set([
  "NOT_FOUND",
  "CLIP_NOT_FOUND",
  "TRACK_NOT_FOUND",
  "INVALID_PARAMS",
]);

async function executeToolWithRetry(
  name: string,
  args: Record<string, unknown> | undefined,
  host: EditingHost,
): Promise<ToolResult> {
  const result = await executeTool(name, args, host);
  if (result.ok || !result.error) return result;

  if (RETRYABLE_CODES.has(result.error.code)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const retry = await executeTool(name, args, host);
    if (retry.ok) return retry;
    return enhanceToolError(name, retry);
  }

  return enhanceToolError(name, result);
}

function enhanceToolError(name: string, result: ToolResult): ToolResult {
  if (result.ok || !result.error) return result;

  const { code, message } = result.error;
  let hint: string | undefined;

  switch (code) {
    case "NOT_FOUND":
    case "CLIP_NOT_FOUND":
      hint = "The referenced clip may have been split, moved, or deleted. Call list_clips to refresh clip IDs before retrying.";
      break;
    case "TRACK_NOT_FOUND":
      hint = "The track may have been removed. Call list_tracks to see available tracks.";
      break;
    case "INVALID_PARAMS":
      hint = `Check the parameters for ${name}. Use get_capabilities to see valid enum values and parameter ranges.`;
      break;
    case "NO_VIDEO_MEDIA":
      hint = "Import at least one video file before editing. Use import_media_from_url or drag files into the project.";
      break;
    case "PLAN_REQUIRED":
      hint = "Call plan_edit before any editing tools when working with footage.";
      break;
    case "UNKNOWN_TOOL":
      hint = `No tool named '${name}'. Check the available tools with get_capabilities.`;
      break;
    case "ACTION_FAILED":
      hint = `The action for ${name} failed. Check parameter values against get_capabilities and try again.`;
      break;
    default:
      break;
  }

  if (hint) {
    return {
      ...result,
      error: {
        code,
        message: `${message}\n\nHint: ${hint}`,
      },
    };
  }

  return result;
}

function latestUserPrompt(messages: LoopMessage[]): string {
  return [...messages]
    .reverse()
    .find((message): message is Extract<LoopMessage, { role: "user" }> => message.role === "user")
    ?.content ?? "";
}

const DATA_URL_PREFIX = /^data:([^;,]+)?(?:;[^,]*)?,/;

function stripDataUrlPrefix(dataUrl: string): {
  base64: string;
  mimeType: string;
} {
  const match = DATA_URL_PREFIX.exec(dataUrl);
  if (match) {
    return {
      base64: dataUrl.slice(match[0].length),
      mimeType: match[1] || "image/png",
    };
  }
  return { base64: dataUrl, mimeType: "image/png" };
}

function buildToolResultContent(
  result: ToolResult,
): string | LoopToolResultBlock[] {
  const text = JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error,
  });
  if (!result.image) return text;
  const { base64, mimeType } = stripDataUrlPrefix(result.image.dataUrl);
  return [
    { type: "text", text },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: result.image.mimeType ?? mimeType,
        data: base64,
      },
    },
  ];
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const {
    host,
    llm,
    tools,
    system,
    confirmGate,
    onEvent,
    dryRun = false,
    turnLabel = "AI edit",
    enforceDirectorWorkflow = false,
  } = input;
  const maxSteps = input.limits?.maxSteps ?? 12;
  const maxToolCalls = input.limits?.maxToolCalls ?? 64;
  const maxTokens = input.limits?.maxTokens;

  const emit = (event: AgentEvent): void => onEvent?.(event);
  const messages: LoopMessage[] = [...input.messages];
  let toolCalls = 0;
  let approveAll = false;
  let lastText = "";
  const usage: { inputTokens: number; outputTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
  };

  const requiresDirectorPlan = enforceDirectorWorkflow && DIRECTOR_REQUEST.test(latestUserPrompt(messages));
  let directorPlanCompleted = !requiresDirectorPlan;
  let planEditAttempted = false;

  const txn = host.beginTransaction(turnLabel);

  try {
    if (requiresDirectorPlan) {
      const checkup = ["get_capabilities", "get_editor_state", "list_media"] as const;
      const checkupUses = checkup.map((name, index) => ({
        id: `checkup-${index + 1}`,
        name,
        input: {},
      }));
      messages.push({ role: "assistant", content: "", toolUses: checkupUses });
      const checkupResults: LoopToolResult[] = [];
      for (const toolUse of checkupUses) {
        toolCalls++;
        const call: ToolCall = { id: toolUse.id, name: toolUse.name, args: {} };
        emit({ type: "tool_call", call });
        const result = await executeTool(toolUse.name, {}, host);
        emit({ type: "tool_result", call, result });
        checkupResults.push({
          toolUseId: toolUse.id,
          content: buildToolResultContent(result),
          isError: !result.ok,
        });
      }
      messages.push({ role: "tool", results: checkupResults });
    }

    for (let step = 0; step < maxSteps; step++) {
      if (
        maxTokens !== undefined &&
        usage.inputTokens + usage.outputTokens >= maxTokens
      ) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "budget",
          committed: true,
          usage,
        };
      }
      const response = await llm.complete({ system, messages, tools });
      lastText = response.text;
      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
      }
      if (response.text) emit({ type: "text_delta", text: response.text });

      if (response.toolUses.length === 0) {
        messages.push({ role: "assistant", content: response.text, toolUses: [] });
        host.commitTransaction(txn, turnLabel);
        emit({ type: "turn_complete", text: response.text });
        return {
          text: response.text,
          messages,
          toolCalls,
          stoppedReason: response.stopReason === "max_tokens" ? "budget" : "end_turn",
          committed: true,
          usage,
        };
      }

      messages.push({
        role: "assistant",
        content: response.text,
        toolUses: response.toolUses,
      });

      const results: LoopToolResult[] = [];
      let hitToolCallLimit = false;
      for (let ti = 0; ti < response.toolUses.length; ti++) {
        const toolUse = response.toolUses[ti];
        if (toolCalls >= maxToolCalls) {
          for (let ri = ti; ri < response.toolUses.length; ri++) {
            const pending = response.toolUses[ri];
            const capped = {
              ok: false as const,
              summary: "Tool-call budget reached",
              error: {
                code: "MAX_TOOL_CALLS",
                message: "Per-turn tool-call limit reached",
              },
            };
            emit({
              type: "tool_result",
              call: { id: pending.id, name: pending.name, args: pending.input },
              result: capped,
            });
            results.push({
              toolUseId: pending.id,
              content: JSON.stringify(capped),
              isError: true,
            });
          }
          hitToolCallLimit = true;
          break;
        }
        toolCalls++;
        const call: ToolCall = {
          id: toolUse.id,
          name: toolUse.name,
          args: toolUse.input,
        };
        emit({ type: "tool_call", call });

        if (
          requiresDirectorPlan &&
          !directorPlanCompleted &&
          call.name !== "plan_edit" &&
          !isReadOnly(call.name) &&
          !isDirectorDiscoveryTool(call.name)
        ) {
          const blocked = {
            ok: false as const,
            summary: "Planning is required before editing",
            error: {
              code: "PLAN_REQUIRED",
              message: "Call plan_edit directly before any editing tool. Do not wrap it in execute_action.",
            },
          };
          emit({ type: "tool_result", call, result: blocked });
          results.push({
            toolUseId: call.id,
            content: JSON.stringify(blocked),
            isError: true,
          });
          continue;
        }

        if (call.name === "plan_edit" && planEditAttempted) {
          const blocked = {
            ok: false as const,
            summary: "plan_edit already attempted this turn",
            error: {
              code: "PLAN_EDIT_ALREADY_USED",
              message: "plan_edit was already called this turn. To refine the edit, describe what you want changed and use clip/effect/text tools to modify the existing timeline — do not call plan_edit again.",
            },
          };
          emit({ type: "tool_result", call, result: blocked });
          results.push({
            toolUseId: call.id,
            content: JSON.stringify(blocked),
            isError: true,
          });
          continue;
        }

        const needsConfirm =
          !dryRun &&
          !approveAll &&
          (isDestructive(call.name) || isExpensive(call.name));
        if (needsConfirm && confirmGate) {
          emit({ type: "awaiting_confirmation", call });
          const decision = await confirmGate(call);
          if (decision === "approve_for_turn") approveAll = true;
          if (decision === "reject") {
            const rejected = {
              ok: false as const,
              summary: "Rejected by user",
              error: { code: "REJECTED", message: "User rejected this action" },
            };
            emit({ type: "tool_result", call, result: rejected });
            results.push({
              toolUseId: call.id,
              content: JSON.stringify(rejected),
              isError: true,
            });
            continue;
          }
        }

        let result;
        if (dryRun && !isReadOnly(call.name)) {
          result = {
            ok: true as const,
            summary: `[dry-run] would call ${call.name}`,
          };
        } else {
          result = await executeToolWithRetry(call.name, call.args, host);
        }
        if (requiresDirectorPlan && call.name === "plan_edit" && result.ok) {
          directorPlanCompleted = true;
        }
        if (call.name === "plan_edit") {
          planEditAttempted = true;
        }
        emit({ type: "tool_result", call, result });
        results.push({
          toolUseId: call.id,
          content: buildToolResultContent(result),
          isError: !result.ok,
        });
      }

      messages.push({ role: "tool", results });

      if (hitToolCallLimit) {
        host.commitTransaction(txn, turnLabel);
        return {
          text: lastText,
          messages,
          toolCalls,
          stoppedReason: "max_tool_calls",
          committed: true,
          usage,
        };
      }
    }

    host.commitTransaction(txn, turnLabel);
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "max_steps",
      committed: true,
      usage,
    };
  } catch (error) {
    await host.rollbackTransaction(txn);
    const message = error instanceof Error ? error.message : "Agent turn failed";
    emit({ type: "error", error: { code: "LOOP_ERROR", message } });
    return {
      text: lastText,
      messages,
      toolCalls,
      stoppedReason: "error",
      committed: false,
      usage,
    };
    }
  }
}
```

## `packages/agent/src/executor.ts`

```typescript
import type { EditingHost } from "./host";
import type { ToolResult } from "./types";
import { getTool } from "./registry";
import { resolveClipId } from "./serialize";

function resolveRefs(
  args: Record<string, unknown>,
  host: EditingHost,
): Record<string, unknown> {
  if (typeof args.clipId === "string") return args;
  const hasRef =
    typeof args.clipIndex === "number" || typeof args.atSec === "number";
  if (!hasRef) return args;
  try {
    const id = resolveClipId(host.getProject(), {
      index: args.clipIndex as number | undefined,
      atSec: args.atSec as number | undefined,
      trackIndex: args.trackIndex as number | undefined,
    });
    if (id) return { ...args, clipId: id };
  } catch {
    // no open project / resolution failed — let the tool report it
  }
  return args;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown> | undefined,
  host: EditingHost,
): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      error: { code: "UNKNOWN_TOOL", message: `No tool named '${name}'` },
    };
  }
  const resolved = resolveRefs(args ?? {}, host);
  try {
    return await tool.handler(resolved, host);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return { ok: false, summary: message, error: { code: "TOOL_ERROR", message } };
  }
}

export function isDestructive(name: string): boolean {
  return getTool(name)?.destructive ?? false;
}

export function isExpensive(name: string): boolean {
  return getTool(name)?.expensive ?? false;
}
```

## `packages/agent/src/system-prompt.ts`

```typescript
import type { EditingHost } from "./host";
import { serializeEditorState } from "./serialize";
import { toCapabilityDoc } from "./registry";

const MOTION_TOOLS = new Set([
  "create_motion_composition", "add_motion_layer", "add_motion_layers",
  "animate_layer", "add_motion_effect", "add_motion_mask",
  "render_motion_frame", "apply_motion_template", "insert_motion_into_editor",
  "set_motion_layer_transform", "update_motion_composition",
  "list_motion_compositions", "get_motion_composition",
  "set_motion_shape_style", "import_image_layer",
  "arrange_motion_layers", "animate_motion_layers",
  "add_motion_ui_component", "build_motion_ui_layer_spec",
]);

const CREATION_TOOLS = new Set([
  "create_creation_3d_scene", "create_product_cinematic_scene",
  "add_creation_product_part", "inspect_creation_product_parts",
  "apply_creation_material_preset", "render_creation_preview",
  "create_creation_camera_module", "add_creation_screen_stack",
  "add_creation_product_internals", "animate_creation_exploded_view",
]);

function hasAny(selected: Set<string>, candidates: Set<string>): boolean {
  for (const name of selected) {
    if (candidates.has(name)) return true;
  }
  return false;
}

export function buildSystemPrompt(
  host: EditingHost,
  selectedToolNames?: Iterable<string>,
): string {
  let state = "(no project open)";
  try {
    state = JSON.stringify(serializeEditorState(host.getProject()));
  } catch {
    // no project open
  }

  const selected = new Set(selectedToolNames ?? []);
  const needsMotion = selected.size === 0 || hasAny(selected, MOTION_TOOLS);
  const needsCreation = selected.size === 0 || hasAny(selected, CREATION_TOOLS);

  const sections: string[] = [
    "You are Kove Advanced's video-editing agent. You edit the user's open project by calling tools.",
    "",
    "## Core Rules",
    "- All times are in seconds (float).",
    "- NEVER ask the user for media IDs, clip IDs, track IDs, or any internal identifiers. You have full access to the project state — discover IDs yourself.",
    "- **ID discovery sequence**: For footage/edit requests, call `get_capabilities`, then `get_editor_state`, then `list_media`. Call `list_clips` when clip IDs are needed. These reads must precede editing tools.",
    "- When the user refers to a video/clip by description, resolve it yourself from `list_media`. Present options by NAME, not by ID. `list_media.analysisRole=reference` files are style references; `source` files are footage to edit.",
    "- When there are multiple videos, decide which to use based on the user's prompt and footage descriptions. If truly ambiguous, present video names/descriptions and ask the user to pick by NAME.",
    "- Read before you write: call `list_media`, `list_clips`, `get_clip`, `get_capabilities` to ground your edits in valid ids and enum values.",
    "- Prefer the specific tool for a task; use execute_action only for capabilities without a dedicated tool.",
    "- Never pass `plan_edit`, `add_clip`, or `execute_action` as the `type` of `execute_action`. Call the dedicated tool directly. `plan_edit` is mandatory before any edit tool on footage requests.",
    "- Destructive/expensive tools (delete, remove, export, AI jobs) require user confirmation.",
    "- After making the requested edits, stop and summarize what you changed.",
    "- Write user-facing responses in concise GitHub-flavored Markdown. Prefer short paragraphs and bullets.",
    "- Do not expose internal chain-of-thought, tool schemas, or raw tool-result JSON.",
  ];

  sections.push(
    "",
    "## Monet — AI Director Workflow",
    "- When the user wants to create an edit from uploaded footage, follow this IN FULL — do NOT stop after planning:",
    "  0. Call `list_media` to discover all media IDs, names, types. NEVER ask the user for these.",
    "  1. Call `plan_edit` with the user prompt + optional genre. It reads videos from the project automatically.",
    "  2. `plan_edit` validates and applies the complete EditPlan to the timeline before it returns. Do not manually repeat its operations.",
    "  3. After executing ALL items, summarize what was done.",
    "- **The plan is INTERNAL — `plan_edit` applies it before reporting success.** The user expects edits on their timeline, not JSON in chat.",
    "- **ONE-SHOT: `plan_edit` may only be called ONCE per turn.** If the user wants refinements, describe what you will change and use clip/effect/text tools to edit the existing timeline directly. NEVER call `plan_edit` a second time.",
    "- Execute EVERY item in the plan. Do not skip items or stop early.",
    "- Clip IDs can change after split/add/remove. After any clip mutation, use returned createdClipIds or call list_clips before the next mutation.",
    "- Follow the prompt-detail rubric: skip Q&A only if the prompt specifies (a) tone/vibe, (b) target length/platform, (c) what to keep vs cut. Missing one → ask about just that gap. Genre selection also skips Q&A.",
    "- Available genres: highlight-reel, documentary, vlog, tutorial, music-video, corporate, social-reel, same-person-compare, kill-montage, cinematic-trailer, podcast-clip, and more.",
    "",
    "### Perception-Driven Editing (critical for generational quality)",
    "The SegmentMap provides rich per-segment perception data. USE IT — this is what separates robotic edits from human ones:",
    "- **importanceScore**: Higher = better for hooks and payoffs. Open and close with the highest-scoring segments.",
    "- **motionPeak**: High motion = action emphasis. Cut TO high-motion segments for energy; cut FROM them for breathing room.",
    "- **audioEnergy + beatTimestamps**: Sync cuts, effects, and text reveals to beats. Snap cut points to the nearest beat within 0.2s tolerance when beatTimestamps are present.",
    "- **facePresenceRatio + hasTalkingHead**: Use face-heavy segments for reaction shots, emotional beats, dialogue. Avoid cutting away from talking heads mid-sentence.",
    "- **shotBoundaryAtStart**: Clean entry point — prefer these for cut locations.",
    "- **subjectContinuityScore**: High = same subject across shots. Avoid cutting when this drops (subject disappears).",
    "- **sportsMomentScore / sportsMomentEvent**: For sports, prioritize action peaks, shot releases, celebrations, crowd reactions.",
    "",
    "### Effect & Transition Placement (content-aware, not generic)",
    "- **Sync to beats**: Place effect hits, transitions, and text reveals on beat timestamps. A transition on a beat feels intentional; one on silence feels random.",
    "- **Match intensity to content**: High motionPeak → punchy effects (zoom-punch, shake, flash). Low motionPeak → subtle effects (color-balance, vignette). Don't glitch-transition a calm interview.",
    "- **Alternate transitions**: Never use the same transition on every cut. Quick successive cuts → hard cuts. Long holds → crossfade or dip-to-black.",
    "- **Text timing**: Text appears 0.3-0.5s AFTER the segment starts (viewer processes the visual first). Remove text 0.3s before segment ends.",
    "- **Effect duration**: Short effects (zoom-punch, flash) = 0.2-0.5s. Long effects (color-balance, vignette) = full segment duration.",
    "- **Less is more**: 2-4 transitions and 2-5 segment-specific effects per 30s of edit. Over-editing is worse than under-editing.",
  );

  if (needsMotion) {
    sections.push(
      "",
      "## Motion Creator (After Effects-style motion graphics)",
      "- Compositions -> layers -> keyframes. A composition has size/duration/frameRate, layers, variables, markers, optional camera and lights.",
      "- Layer types: text, shape, image, group, null, composition (precomp), adjustment, particle, scene3d.",
      "- Workflow: create_motion_composition -> add_motion_layer -> animate_layer -> effects/masks/mattes/blend/parenting/expressions/camera/lights.",
      "- Do NOT auto-place on the video timeline: only call insert_motion_into_editor when the user explicitly asks or wants export.",
      "- Call get_motion_composition after creating to recover layer/keyframe ids.",
      "- Discover template ids, property names, easing names, effect types under get_capabilities motion.",
    );
  }

  if (needsCreation) {
    sections.push(
      "",
      "## 3D / Creation Scenes",
      "- For 3D worlds, product cinematics: create_creation_3d_scene or create_product_cinematic_scene.",
      "- Use creation-specific tools (add_creation_product_part, apply_creation_material_preset, etc.) so the persisted scene and render layer stay in sync.",
      "- Creation state is separate from render layers: use list_creation_assets, list_creation_scenes for inspection.",
    );
  }

  sections.push(
    "",
    `Current editor state: ${state}`,
    "",
    toCapabilityDoc(selectedToolNames),
  );

  return sections.join("\n");
}
```

## `packages/agent/src/tool-router.ts`

```typescript
import { listTools } from "./registry";
import type { RegisteredTool } from "./registry";

export const DEFAULT_AGENT_TOOL_LIMIT = 120;

const ALWAYS_AVAILABLE = new Set([
  "get_editor_state",
  "list_media",
  "list_tracks",
  "list_clips",
  "get_clip",
  "get_capabilities",
  "create_project",
  "list_projects",
  "open_project",
  "save_project",
  "list_motion_compositions",
  "get_motion_composition",
  "create_motion_composition",
  "add_motion_layer",
  "add_motion_layers",
  "set_motion_layer_transform",
  "animate_layer",
  "remove_motion_layer",
  "render_motion_frame",
  "insert_motion_into_editor",
  "execute_action",
  "batch_actions",
]);

const MOTION_TERMS = /\b(motion|composition|layer|keyframe|animate|animation|after effects|lower third|title card|kinetic|lottie|svg|figma|particle|shader|mask|matte|precomp|camera|render frame)\b/i;
const CREATION_TERMS = /\b(3d|three[- ]?d|product|character|scene|model|gltf|glb|rig|mesh|material|texture|bevel|displacement|x[- ]?ray|cloth|camera module|exploded|cinematic|decal|cutaway)\b/i;
const DIRECTOR_TERMS = /\b(direct|edit|cut|trim|highlight|reel|montage|compilation|remix|create|make|kreate|analyze|footage|segment|plan|sequence|chop|splice|join|video|film|clip|footage|b-roll|podcast|vlog|social|tiktok|youtube|instagram|reel|short)\b/i;

const DIRECTOR_DOMAINS = new Set([
  "ai",           // plan_edit, expand_prompt, extract_segments
  "effect",       // add_video_effect, remove_video_effect
  "transition",   // add_transition, remove_transition
  "text",         // create_text_clip, update_text_clip
  "audio",        // audio tools
  "clip",         // split_clip, move_clip, duplicate_clip
  "track",        // add_track, remove_track
  "transform",    // transform/update
  "speed",        // speed changes
  "color",        // color grading
  "subtitle",     // subtitle tools
  "marker",       // markers
  "export",       // export tools
]);

const words = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);

function relevance(tool: RegisteredTool, promptWords: Set<string>): number {
  if (ALWAYS_AVAILABLE.has(tool.name)) return 10_000;
  const name = new Set(words(tool.name));
  const title = new Set(words(tool.title));
  const description = new Set(words(tool.description));
  let score = tool.readOnly ? 12 : 0;
  for (const word of promptWords) {
    if (name.has(word)) score += 18;
    if (title.has(word)) score += 10;
    if (description.has(word)) score += 2;
  }
  return score;
}

function isCreationTool(tool: RegisteredTool): boolean {
  const haystack = `${tool.name} ${tool.title} ${tool.description}`;
  return /creation|3d|scene3d|gltf|glb|rigging|humanoid|product cinematic/i.test(haystack);
}

export function selectToolsForPrompt(
  prompt: string,
  options: { readonly maxTools?: number; readonly priorToolNames?: readonly string[] } = {},
): string[] {
  const maxTools = Math.max(1, options.maxTools ?? DEFAULT_AGENT_TOOL_LIMIT);
  const wantsMotion = MOTION_TERMS.test(prompt);
  const wantsCreation = CREATION_TERMS.test(prompt);
  const wantsDirector = DIRECTOR_TERMS.test(prompt);
  const prior = new Set(options.priorToolNames ?? []);
  const promptWords = new Set(words(prompt));

  const candidates = listTools().filter((tool) => {
    if (ALWAYS_AVAILABLE.has(tool.name) || prior.has(tool.name)) return true;
    if (wantsDirector && DIRECTOR_DOMAINS.has(tool.domain)) return true;
    if (!wantsMotion && !wantsCreation) return tool.domain !== "motion";
    if (wantsCreation && isCreationTool(tool)) return true;
    if (wantsMotion && tool.domain === "motion" && !isCreationTool(tool)) return true;
    return tool.domain === "read" || ["project", "media", "export", "raw"].includes(tool.domain);
  });

  return candidates
    .map((tool, index) => ({
      tool,
      index,
      score:
        relevance(tool, promptWords) +
        (prior.has(tool.name) ? 5_000 : 0) +
        (wantsCreation && isCreationTool(tool) ? 100 : 0) +
        (wantsMotion && tool.domain === "motion" ? 50 : 0) +
        (wantsDirector && DIRECTOR_DOMAINS.has(tool.domain) ? 200 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxTools)
    .sort((a, b) => a.index - b.index)
    .map(({ tool }) => tool.name);
}
```

## `packages/agent/src/director/director-prompt.ts`

```typescript
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
   { "type": "zoom-punch", "intensity": 0.8, "duration": 0.3, "rationale": "emphasize the big play" }
   \`\`\`
   Common effects: zoom-punch, shake, flash, brightness, contrast, saturation, color-balance, vignette, chromatic-aberration, motion-blur, sepia, sharpen
3. **transitions** (required): 2-4 transitions between segments. Alternate types (hardCut, crossfade, flash, whipPan, slide, zoom).
4. **audioDecisions** (required): At least one music bed if any audio source exists. Use the source video's audio or mark as silence.
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
- **audioEnergy**: Use audio energy peaks to time effect hits and text reveals, not just cuts. A zoom-punch that lands on an audio peak feels powerful; one on silence feels arbitrary.

### Effect & Transition Placement
- **motionPeak**: High motion → punchy effects (zoom-punch, shake, flash, chromatic-aberration). Low motion → subtle effects (color-balance, vignette, brightness). NEVER put a glitch transition on a calm interview.
- **facePresenceRatio + hasTalkingHead**: When face presence is high, avoid heavy visual effects that compete with the face. Use subtle color grading instead. Reserve punchy effects for non-face moments.
- **audioEnergy + beatTimestamps**: Sync effect HITS (not durations) to beats. A 0.3s zoom-punch on a beat is 10x better than a 3s effect randomly placed.
- **Variety rule**: Never use the same transition type on consecutive cuts. Alternate: hardCut → crossfade → hardCut → flash. For 30s of edit: 2-4 transitions total, 2-5 segment-specific effects.

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
  return videos.length > 0 ? videos[0]!.videoId : reference;
}

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
      pacing: genre.pacing ?? genre.rules.pacing,
      effectPalette: genre.effectPalette ?? genre.rules.effectPalette,
      transitionPalette: genre.transitionPalette ?? genre.rules.transitionPreference,
    }, null, 2)}`
    : "";
  const referenceInfo = referenceAnalysis
    ? `\nStyle profile target from reference footage (apply this style to source footage only; do not place reference footage on the timeline):\n${JSON.stringify(referenceAnalysis, null, 2)}`
    : "";

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
```

## `packages/agent/src/director/plan-review.ts`

```typescript
import type {
  EditPlan,
  Genre,
  SegmentMap,
  StyleProfile,
  StyleProfileComparison,
  StyleProfileTarget,
  RenderedDraftReview,
  RenderedFrameObservation,
} from "@kove-advanced/creation-schema";
import { compareStyleProfile, reviewRenderedDraft } from "@kove-advanced/creation-schema";

export interface EditPlanReview extends StyleProfileComparison {
  readonly profile: StyleProfile;
  readonly target: StyleProfileTarget;
  readonly needsRevision: boolean;
  readonly rendered?: RenderedDraftReview;
}

export interface MaterializedDraftSummary {
  readonly clipIds: readonly string[];
  readonly textIds: readonly string[];
  readonly effectCount: number;
  readonly transitionCount: number;
  readonly audioCount: number;
}

export interface DraftSelfReview {
  readonly score: number;
  readonly issues: readonly string[];
  readonly lowConfidenceSegments: readonly string[];
  readonly execution: {
    readonly expectedEffects: number;
    readonly appliedEffects: number;
    readonly expectedTransitions: number;
    readonly appliedTransitions: number;
    readonly expectedTextElements: number;
    readonly appliedTextElements: number;
  };
  readonly needsRevision: boolean;
}

export function reviewMaterializedDraft(
  plan: EditPlan,
  segmentMap: SegmentMap,
  materialized: MaterializedDraftSummary,
  styleReview: EditPlanReview,
  renderedObservations?: readonly RenderedFrameObservation[],
): DraftSelfReview {
  const expectedEffects = plan.effects.length
    + plan.segments.reduce((sum, segment) => sum + segment.effects.length + (segment.effectSpecs?.length ?? 0), 0);
  const expectedTransitions = plan.transitions.length;
  const expectedTextElements = plan.textElements.length;
  const issues: string[] = [];
  let score = styleReview.score;
  const rendered = renderedObservations ? reviewRenderedDraft(renderedObservations) : undefined;
  if (rendered) {
    score = (score + rendered.score) / 2;
    issues.push(...rendered.issues);
  }

  if (materialized.effectCount < expectedEffects) {
    issues.push(`Only ${materialized.effectCount} of ${expectedEffects} planned effects were applied.`);
    score -= 0.2;
  }
  if (materialized.transitionCount < expectedTransitions) {
    issues.push(`Only ${materialized.transitionCount} of ${expectedTransitions} planned transitions were applied.`);
    score -= 0.2;
  }
  if (materialized.textIds.length < expectedTextElements) {
    issues.push(`Only ${materialized.textIds.length} of ${expectedTextElements} planned text elements were applied.`);
    score -= 0.1;
  }

  const lowConfidenceSegments = segmentMap.videos.flatMap((video) => video.segments
    .filter((segment) => segment.confidence < 0.5)
    .map((segment) => `${video.videoId}:${segment.id}`));
  if (lowConfidenceSegments.length > 0) {
    issues.push(`${lowConfidenceSegments.length} source segment(s) have low analysis confidence and should be spot-checked.`);
    score -= 0.1;
  }

  const normalizedScore = Math.max(0, Math.min(1, score));
  return {
    score: normalizedScore,
    issues,
    lowConfidenceSegments,
    execution: {
      expectedEffects,
      appliedEffects: materialized.effectCount,
      expectedTransitions,
      appliedTransitions: materialized.transitionCount,
      expectedTextElements,
      appliedTextElements: materialized.textIds.length,
    },
    needsRevision: normalizedScore < 0.6,
  };
}

export function reviewEditPlan(
  plan: EditPlan,
  genre?: Genre,
  referenceAnalysis?: unknown,
): EditPlanReview {
  const profile = measureEditPlanStyle(plan);
  const target = mergeStyleTargets(genreTarget(genre), referenceTarget(referenceAnalysis));
  const comparison = compareStyleProfile(profile, target);

  return {
    ...comparison,
    profile,
    target,
    needsRevision: comparison.score < 0.6,
  };
}

export function measureEditPlanStyle(plan: EditPlan): StyleProfile {
  const targetDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.sourceEndTime - segment.sourceStartTime),
      0,
    );
  const shotDurations = plan.segments
    .map((segment) => Math.max(0, segment.sourceEndTime - segment.sourceStartTime))
    .sort((left, right) => left - right);
  const transitionPalette = [...new Set(plan.transitions.map((transition) => transition.type))];
  const effectPalette = [...new Set([
    ...plan.effects.map((effect) => effect.type),
    ...plan.segments.flatMap((segment) => segment.effects),
  ])];
  const cutStyle = transitionPalette.length === 0
    ? "unknown"
    : transitionPalette.every((type) => ["crossfade", "dipToBlack", "fade"].includes(type))
      ? "soft"
      : transitionPalette.every((type) => ["hardCut", "cut"].includes(type))
        ? "hard"
        : "mixed";

  return {
    version: "1.0.0",
    pacing: plan.metadata.pacing === "medium" ? "moderate" : plan.metadata.pacing,
    cutsPerMinute: targetDuration > 0 ? plan.segments.length / (targetDuration / 60) : 0,
    medianShotDuration: shotDurations.length > 0
      ? shotDurations[Math.floor(shotDurations.length / 2)]!
      : 0,
    cutOnBeatRatio: null,
    effectDensity: targetDuration > 0 ? effectPalette.length / (targetDuration / 60) : 0,
    transitionDensity: targetDuration > 0 ? plan.transitions.length / (targetDuration / 60) : 0,
    textOverlayDensity: targetDuration > 0 ? plan.textElements.length / (targetDuration / 60) : 0,
    shotTypeDistribution: {},
    cutStyle,
    effectPalette,
    transitionPalette,
    detectedBpm: null,
    dialogueRatio: 0,
    musicRatio: plan.audioDecisions.some((decision) => decision.type === "music") ? 1 : 0,
    confidence: 1,
  };
}

function genreTarget(genre?: Genre): StyleProfileTarget | undefined {
  if (!genre) return undefined;
  return genre.styleProfile ?? {
    pacing: genre.pacing ?? genre.rules.pacing,
    cutsPerMinute: genre.cutsPerMinuteTarget,
    cutStyle: genre.rules.cutStyle,
    effectPalette: genre.effectPalette ?? genre.rules.effectPalette,
    transitionPalette: genre.transitionPalette ?? genre.rules.transitionPreference,
  };
}

function referenceTarget(value: unknown): StyleProfileTarget | undefined {
  const root = asRecord(value);
  const videos = Array.isArray(root?.videos) ? root.videos : [];
  const referenceVideo = videos.find((video) => asRecord(video)?.role === "reference") ?? videos[0];
  const profile = asRecord(asRecord(referenceVideo)?.styleProfile);
  if (!profile) return undefined;

  return {
    pacing: asPacing(profile.pacing),
    cutsPerMinute: asRange(profile.cutsPerMinute),
    cutStyle: asCutStyle(profile.cutStyle),
    effectPalette: asStringArray(profile.effectPalette),
    transitionPalette: asStringArray(profile.transitionPalette),
  };
}

function mergeStyleTargets(
  base: StyleProfileTarget | undefined,
  override: StyleProfileTarget | undefined,
): StyleProfileTarget {
  return {
    ...base,
    ...override,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : undefined;
}

function asRange(value: unknown): readonly [number, number] | undefined {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "number")
    ? [value[0] as number, value[1] as number]
    : undefined;
}

function asPacing(value: unknown): StyleProfileTarget["pacing"] {
  return value === "fast" || value === "moderate" || value === "medium" || value === "slow" || value === "unknown"
    ? value
    : undefined;
}

function asCutStyle(value: unknown): StyleProfileTarget["cutStyle"] {
  return value === "hard" || value === "soft" || value === "mixed" || value === "unknown"
    ? value
    : undefined;
}
```

## `packages/agent/src/director/quality-pipeline.ts`

```typescript
import type {
  EditPlan,
  SegmentMap,
  RenderedFrameObservation,
  RenderedDraftReview,
} from "@kove-advanced/creation-schema";
import { reviewRenderedDraft } from "@kove-advanced/creation-schema";
import type { EditingHost } from "../host";
import type { DraftSelfReview, EditPlanReview, MaterializedDraftSummary } from "./plan-review";
import { reviewMaterializedDraft } from "./plan-review";

export interface FrameSamplingResult {
  readonly observations: readonly RenderedFrameObservation[];
  readonly sampledCount: number;
  readonly totalDuration: number;
  readonly extractionFailed: boolean;
}

export interface QualityPipelineResult {
  readonly renderedReview: RenderedDraftReview;
  readonly draftReview: DraftSelfReview;
  readonly combinedScore: number;
  readonly needsCorrection: boolean;
  readonly corrections: readonly QualityCorrection[];
  readonly editorialReview: EditorialReview;
}

export interface EditorialReview {
  readonly pacingScore: number;
  readonly varietyScore: number;
  readonly beatAlignmentScore: number;
  readonly overallGrade: "A" | "B" | "C" | "D" | "F";
  readonly issues: readonly string[];
}

export interface QualityCorrection {
  readonly kind: "effect" | "timing" | "transition" | "pacing" | "text";
  readonly segmentIndex?: number;
  readonly description: string;
}

export async function sampleRenderedFrames(
  plan: EditPlan,
  host: EditingHost,
): Promise<FrameSamplingResult> {
  const totalDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, seg) => sum + Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
      0,
    );

  const sampleCount = Math.min(20, Math.max(4, Math.ceil(totalDuration / 2)));
  const timestamps = generateSampleTimestamps(totalDuration, sampleCount);

  const observations: RenderedFrameObservation[] = [];
  let extractionFailed = false;

  for (const timestamp of timestamps) {
    try {
      const result = await host.runJob("extractVideoFrame", { time: timestamp });
      if (result.ok && result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        observations.push({
          timestamp,
          sharpness: clamp(Number(data.sharpness) || 0.7),
          subjectVisibility: clamp(Number(data.subjectVisibility) || 0.7),
          textLegibility: clamp(Number(data.textLegibility) || 0.8),
          audioEnergy: typeof data.audioEnergy === "number" ? clamp(data.audioEnergy) : undefined,
          hasBlackFrame: Boolean(data.hasBlackFrame),
        });
      } else {
        extractionFailed = true;
        observations.push(planDerivedObservation(plan, timestamp));
      }
    } catch {
      extractionFailed = true;
      observations.push(planDerivedObservation(plan, timestamp));
    }
  }

  return { observations, sampledCount: observations.length, totalDuration, extractionFailed };
}

export function runQualityPipeline(
  plan: EditPlan,
  segmentMap: SegmentMap,
  materialized: MaterializedDraftSummary,
  planReview: EditPlanReview,
  frameObservations: readonly RenderedFrameObservation[],
): QualityPipelineResult {
  const renderedReview = reviewRenderedDraft(frameObservations);
  const draftReview = reviewMaterializedDraft(plan, segmentMap, materialized, planReview, frameObservations);
  const editorialReview = reviewEditorialQuality(plan, segmentMap);

  const combinedScore =
    renderedReview.score * 0.25 +
    draftReview.score * 0.35 +
    editorialReview.pacingScore * 0.15 +
    editorialReview.varietyScore * 0.15 +
    editorialReview.beatAlignmentScore * 0.1;

  const needsCorrection = combinedScore < 0.65 || draftReview.needsRevision || editorialReview.issues.length > 2;

  const corrections = identifyCorrections(plan, renderedReview, draftReview, editorialReview);

  return { renderedReview, draftReview, combinedScore, needsCorrection, corrections, editorialReview };
}

export async function applyTargetedCorrections(
  plan: EditPlan,
  corrections: readonly QualityCorrection[],
  clipIds: readonly string[],
  host: EditingHost,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  for (const correction of corrections) {
    try {
      switch (correction.kind) {
        case "effect": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const effectSpecs = segment?.effectSpecs ?? [];
          for (const spec of effectSpecs) {
            await host.applyAction({
              type: "effect/add",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: {
                clipId,
                effectType: spec.type,
                params: {
                  ...spec.params,
                  ...(spec.intensity !== undefined ? { intensity: Math.max(0, Math.min(1, spec.intensity)) } : {}),
                },
              },
            });
            applied++;
          }
          break;
        }
        case "timing": {
          if (correction.segmentIndex === undefined) { skipped++; break; }
          const clipId = clipIds[correction.segmentIndex];
          if (!clipId) { skipped++; break; }
          const segment = plan.segments[correction.segmentIndex];
          const clip = host.getProject().timeline.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.id === clipId);
          if (clip && segment) {
            const targetPosition = Math.max(0, segment.targetPosition ?? clip.startTime);
            await host.applyAction({
              type: "clip/update",
              id: `quality-fix-${applied}`,
              timestamp: Date.now(),
              params: { clipId, startTime: targetPosition },
            });
            applied++;
          } else {
            skipped++;
          }
          break;
        }
        case "transition": {
          skipped++;
          break;
        }
        case "pacing": {
          skipped++;
          break;
        }
        case "text": {
          skipped++;
          break;
        }
        default: {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }

  return { applied, skipped };
}

function reviewEditorialQuality(
  plan: EditPlan,
  segmentMap: SegmentMap,
): EditorialReview {
  const issues: string[] = [];

  const targetDuration = plan.metadata.targetDuration > 0
    ? plan.metadata.targetDuration
    : plan.segments.reduce(
      (sum, seg) => sum + Math.max(0, seg.sourceEndTime - seg.sourceStartTime),
      0,
    );

  const shotDurations = plan.segments
    .map((seg) => Math.max(0, seg.sourceEndTime - seg.sourceStartTime))
    .sort((a, b) => a - b);

  const expectedCpm = plan.metadata.pacing === "fast" ? 30
    : plan.metadata.pacing === "slow" ? 8
    : 16;
  const actualCpm = targetDuration > 0 ? (plan.segments.length / (targetDuration / 60)) : 0;
  const cpmDeviation = Math.abs(actualCpm - expectedCpm) / Math.max(expectedCpm, 1);
  const pacingScore = Math.max(0, 1 - cpmDeviation);

  if (cpmDeviation > 0.5) {
    issues.push(`Pacing mismatch: ${actualCpm.toFixed(0)} cuts/min vs ${expectedCpm} target for ${plan.metadata.pacing} pacing`);
  }

  if (shotDurations.length >= 3) {
    const median = shotDurations[Math.floor(shotDurations.length / 2)]!;
    const allSimilar = shotDurations.every((d) => Math.abs(d - median) < 0.5);
    if (allSimilar) {
      issues.push("All shots are similar duration — the edit will feel robotic. Alternate short and long shots.");
    }
  }

  const transitionTypes = new Set(plan.transitions.map((t) => t.type));
  const effectTypes = new Set([
    ...plan.effects.map((e) => e.type),
    ...plan.segments.flatMap((s) => s.effectSpecs?.map((e) => e.type) ?? []),
  ]);

  let varietyScore = 1;

  if (plan.transitions.length >= 2 && transitionTypes.size === 1) {
    varietyScore -= 0.3;
    issues.push("Same transition type on every cut — alternate between different transitions");
  }

  if (effectTypes.size === 0 && plan.metadata.genre !== "documentary" && plan.segments.length > 2) {
    varietyScore -= 0.2;
    issues.push("No effects applied — consider adding 2-5 segment-specific effects for visual interest");
  }

  if (plan.transitions.length === 0 && plan.segments.length > 1) {
    varietyScore -= 0.15;
    issues.push("No transitions — add 2-4 transitions between segments");
  }

  const hasMotionPeaks = segmentMap.videos.some((v) =>
    (Array.isArray(v.segments) ? v.segments : []).some((s) => (s.motionPeak ?? 0) > 0.7),
  );
  const hasSpeedRamps = plan.segments.some((s) => s.speedRamp && s.speedRamp.keyframes.length > 0);
  if (hasMotionPeaks && !hasSpeedRamps && plan.metadata.genre !== "documentary") {
    varietyScore -= 0.1;
    issues.push("Footage has high-motion moments but no speed ramps — add speed ramps for impact");
  }

  if (plan.audioDecisions.length === 0 && plan.segments.length > 0) {
    issues.push("No audio decisions — add a music bed or SFX if audio sources exist");
  }

  const effectCounts = new Map<string, number>();
  for (const spec of plan.segments.flatMap((s) => s.effectSpecs ?? [])) {
    effectCounts.set(spec.type, (effectCounts.get(spec.type) ?? 0) + 1);
  }
  for (const [type, count] of effectCounts) {
    if (count > plan.segments.length * 0.7) {
      varietyScore -= 0.15;
      issues.push(`Effect "${type}" applied to ${count}/${plan.segments.length} segments — too uniform`);
    }
  }

  varietyScore = Math.max(0, varietyScore);

  let beatAlignmentScore = 1;
  const allBeats = segmentMap.videos.flatMap((v) =>
    (Array.isArray(v.segments) ? v.segments : []).flatMap((s) => s.beatTimestamps ?? []),
  );
  const uniqueBeats = [...new Set(allBeats)].sort((a, b) => a - b);

  if (uniqueBeats.length > 0 && plan.transitions.length > 0) {
    const tolerance = 0.2;
    let alignedCuts = 0;
    for (const transition of plan.transitions) {
      let cutTime = 0;
      for (let i = 0; i <= transition.afterSegmentIndex && i < plan.segments.length; i++) {
        const seg = plan.segments[i]!;
        if (i < transition.afterSegmentIndex) {
          cutTime += Math.max(0, seg.sourceEndTime - seg.sourceStartTime);
        }
      }
      const nearestBeat = uniqueBeats.reduce<{ time: number; distance: number } | undefined>(
        (best, beat) => {
          const distance = Math.abs(beat - cutTime);
          return distance <= tolerance && (!best || distance < best.distance)
            ? { time: beat, distance }
            : best;
        },
        undefined,
      );
      if (nearestBeat) alignedCuts++;
    }
    beatAlignmentScore = plan.transitions.length > 0 ? alignedCuts / plan.transitions.length : 1;

    if (beatAlignmentScore < 0.3 && uniqueBeats.length > 3) {
      issues.push(`Only ${(beatAlignmentScore * 100).toFixed(0)}% of cuts align with beats — sync cuts to beatTimestamps`);
    }
  }

  const textOverlaps = plan.textElements.filter((t) => {
    const hasOverlap = plan.textElements.some(
      (other) => other !== t &&
        Math.abs(other.startTime - t.startTime) < 0.3 &&
        Math.abs((other.position?.x ?? 0.5) - (t.position?.x ?? 0.5)) < 0.1 &&
        Math.abs((other.position?.y ?? 0.5) - (t.position?.y ?? 0.5)) < 0.1,
    );
    return hasOverlap;
  });
  if (textOverlaps.length > 0) {
    issues.push(`${textOverlaps.length} text element(s) overlap in position and timing — stagger or reposition`);
  }

  const avgScore = (pacingScore + varietyScore + beatAlignmentScore) / 3;
  const overallGrade: EditorialReview["overallGrade"] =
    avgScore >= 0.85 ? "A" :
    avgScore >= 0.7 ? "B" :
    avgScore >= 0.55 ? "C" :
    avgScore >= 0.4 ? "D" : "F";

  return { pacingScore, varietyScore, beatAlignmentScore, overallGrade, issues };
}

function identifyCorrections(
  plan: EditPlan,
  renderedReview: RenderedDraftReview,
  draftReview: DraftSelfReview,
  editorialReview: EditorialReview,
): QualityCorrection[] {
  const corrections: QualityCorrection[] = [];

  for (const issue of renderedReview.issues) {
    if (issue.includes("black")) {
      for (let i = 0; i < plan.segments.length; i++) {
        corrections.push({ kind: "timing", segmentIndex: i, description: `Black frame detected — re-check segment ${i} source range` });
      }
      break;
    }
    if (issue.includes("soft") || issue.includes("sharpness")) {
      for (let i = 0; i < plan.segments.length; i++) {
        const segment = plan.segments[i];
        if (segment.effectSpecs?.some((spec) => spec.type === "blur" || spec.type === "gaussianBlur")) {
          corrections.push({ kind: "effect", segmentIndex: i, description: `Blur effect on segment ${i} may be causing soft frames` });
        }
      }
    }
    if (issue.includes("text legibility")) {
      for (let i = 0; i < plan.textElements.length; i++) {
        corrections.push({ kind: "text", description: `Text element ${i} may need contrast or size adjustment` });
      }
    }
  }

  if (draftReview.execution.appliedEffects < draftReview.execution.expectedEffects) {
    const missing = draftReview.execution.expectedEffects - draftReview.execution.appliedEffects;
    corrections.push({ kind: "effect", description: `${missing} effect(s) were not applied — re-apply missing effects` });
  }
  if (draftReview.execution.appliedTransitions < draftReview.execution.expectedTransitions) {
    const missing = draftReview.execution.expectedTransitions - draftReview.execution.appliedTransitions;
    corrections.push({ kind: "transition", description: `${missing} transition(s) were not applied` });
  }

  for (const issue of editorialReview.issues) {
    if (issue.includes("Pacing")) {
      corrections.push({ kind: "pacing", description: issue });
    } else if (issue.includes("robotic") || issue.includes("uniform")) {
      corrections.push({ kind: "pacing", description: issue });
    } else if (issue.includes("Same transition")) {
      corrections.push({ kind: "transition", description: issue });
    } else if (issue.includes("No effects")) {
      corrections.push({ kind: "effect", description: issue });
    } else if (issue.includes("No transitions")) {
      corrections.push({ kind: "transition", description: issue });
    } else if (issue.includes("speed ramps")) {
      corrections.push({ kind: "effect", description: issue });
    } else if (issue.includes("No audio")) {
      corrections.push({ kind: "pacing", description: issue });
    }
  }

  return corrections;
}

function generateSampleTimestamps(totalDuration: number, count: number): number[] {
  if (count <= 1) return [0];
  const step = totalDuration / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.min(i * step, totalDuration));
}

function planDerivedObservation(plan: EditPlan, timestamp: number): RenderedFrameObservation {
  let accumulated = 0;
  let activeSegmentIndex = 0;
  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i]!;
    const duration = Math.max(0, seg.sourceEndTime - seg.sourceStartTime);
    if (timestamp < accumulated + duration) {
      activeSegmentIndex = i;
      break;
    }
    accumulated += duration;
    if (i === plan.segments.length - 1) activeSegmentIndex = i;
  }

  const activeSegment = plan.segments[activeSegmentIndex];
  const hasEffects = activeSegment && (
    (activeSegment.effects?.length ?? 0) > 0 ||
    (activeSegment.effectSpecs?.length ?? 0) > 0
  );

  const sharpness = hasEffects ? 0.6 : 0.75;
  const hasActiveText = plan.textElements.some(
    (t) => timestamp >= t.startTime && timestamp <= t.startTime + t.duration,
  );

  return {
    timestamp,
    sharpness,
    subjectVisibility: 0.7,
    textLegibility: hasActiveText ? 0.7 : 0.85,
    hasBlackFrame: false,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
```

## `packages/agent/src/director/genres.ts`

```typescript
import type { Genre } from "@kove-advanced/creation-schema";

export const PRE_BAKED_GENRES: readonly Genre[] = [
  {
    id: "highlight-reel",
    name: "Highlight Reel",
    description:
      "Fast-paced compilation of the best moments. High energy, quick cuts, rhythm-driven editing.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "whipPan", "flash"],
      effectPalette: ["brightness", "contrast", "saturation"],
      textStyle: "minimal",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "rhythmic",
    },
    pacing: "fast",
    cutsPerMinuteTarget: [24, 45],
    effectPalette: ["brightness", "contrast", "saturation", "zoom-punch"],
    transitionPalette: ["hardCut", "whipPan", "flash"],
    musicMoodHints: ["energetic", "rhythmic", "modern"],
  },
  {
    id: "documentary",
    name: "Documentary",
    description:
      "Slow, deliberate pacing with context-rich text overlays. Lets the footage breathe.",
    rules: {
      pacing: "slow",
      transitionPreference: ["crossfade", "dipToBlack"],
      effectPalette: ["color-balance", "vignette"],
      textStyle: "moderate",
      cutStyle: "soft",
      colorMood: "neutral",
      musicRole: "background",
    },
    pacing: "slow",
    cutsPerMinuteTarget: [4, 14],
    effectPalette: ["color-balance", "vignette"],
    transitionPalette: ["crossfade", "dipToBlack"],
    musicMoodHints: ["documentary", "restrained", "atmospheric"],
  },
  {
    id: "vlog",
    name: "Vlog",
    description:
      "Conversational, personal feel. Mixed pacing with natural transitions.",
    rules: {
      pacing: "medium",
      transitionPreference: ["crossfade", "wipe", "slide"],
      effectPalette: ["brightness", "warmth"],
      textStyle: "moderate",
      cutStyle: "mixed",
      colorMood: "warm",
      musicRole: "background",
    },
    pacing: "medium",
    cutsPerMinuteTarget: [8, 20],
    effectPalette: ["brightness", "warmth"],
    transitionPalette: ["crossfade", "wipe", "slide"],
    musicMoodHints: ["warm", "casual", "ambient"],
  },
  {
    id: "tutorial",
    name: "Tutorial",
    description:
      "Step-by-step clarity. Text-heavy with deliberate pacing on key moments.",
    rules: {
      pacing: "medium",
      transitionPreference: ["crossfade", "dipToBlack"],
      effectPalette: ["brightness", "contrast"],
      textStyle: "heavy",
      cutStyle: "soft",
      colorMood: "neutral",
      musicRole: "background",
    },
    pacing: "medium",
    cutsPerMinuteTarget: [10, 24],
    effectPalette: ["brightness", "contrast"],
    transitionPalette: ["crossfade", "dipToBlack"],
    musicMoodHints: ["focused", "light", "low volume"],
  },
  {
    id: "music-video",
    name: "Music Video",
    description:
      "Rhythm-synced cuts with heavy visual effects. The music drives the edit.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "glitch", "flash", "whipPan"],
      effectPalette: [
        "brightness",
        "contrast",
        "saturation",
        "hue-saturation",
        "chromatic-aberration",
        "motion-blur",
      ],
      textStyle: "minimal",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "featured",
    },
    pacing: "fast",
    cutsPerMinuteTarget: [18, 42],
    effectPalette: ["brightness", "contrast", "saturation", "chromatic-aberration", "motion-blur"],
    transitionPalette: ["hardCut", "glitch", "flash", "whipPan"],
    musicMoodHints: ["rhythmic", "featured", "high energy"],
  },
  {
    id: "corporate",
    name: "Corporate",
    description:
      "Clean, professional. Minimal effects, clear messaging, polished feel.",
    rules: {
      pacing: "slow",
      transitionPreference: ["crossfade", "dipToWhite"],
      effectPalette: ["brightness", "contrast"],
      textStyle: "moderate",
      cutStyle: "soft",
      colorMood: "cool",
      musicRole: "background",
    },
    pacing: "slow",
    cutsPerMinuteTarget: [4, 12],
    effectPalette: ["brightness", "contrast"],
    transitionPalette: ["crossfade", "dipToWhite"],
    musicMoodHints: ["polished", "corporate", "subtle"],
  },
  {
    id: "social-reel",
    name: "Social Reel",
    description:
      "Short-form, punchy, caption-heavy. Optimized for vertical mobile viewing.",
    rules: {
      pacing: "fast",
      transitionPreference: ["hardCut", "zoom", "slide"],
      effectPalette: ["brightness", "saturation", "contrast"],
      textStyle: "heavy",
      cutStyle: "hard",
      colorMood: "vibrant",
      musicRole: "rhythmic",
    },
    pacing: "fast",
    cutsPerMinuteTarget: [20, 40],
    effectPalette: ["brightness", "saturation", "contrast", "zoom-punch"],
    transitionPalette: ["hardCut", "zoom", "slide"],
    musicMoodHints: ["upbeat", "rhythmic", "modern"],
  },
  {
    id: "same-person-compare",
    name: "Same Person / Comparison",
    description: "A fast split-screen comparison format with consistent captions and two sources visible at once.",
    layoutHint: "split-compare",
    pacing: "fast",
    cutsPerMinuteTarget: [18, 36],
    captionTemplate: { fontFamily: "Arial", fontSize: 48, fontWeight: 700, color: "#ffffff", position: { x: 0.5, y: 0.86 }, align: "center", animation: "text-reveal-up" },
    effectPalette: ["brightness", "contrast", "saturation", "zoom-punch"],
    transitionPalette: ["hardCut", "match-cut"],
    musicMoodHints: ["playful", "punchy", "social"],
    rules: { pacing: "fast", transitionPreference: ["hardCut", "match-cut"], effectPalette: ["brightness", "contrast", "saturation"], textStyle: "heavy", cutStyle: "hard", colorMood: "vibrant", musicRole: "rhythmic" },
  },
  {
    id: "kill-montage",
    name: "Gaming Kill Montage",
    description: "Very fast gameplay montage with impact effects and short hit-marker SFX cues.",
    pacing: "fast",
    cutsPerMinuteTarget: [30, 60],
    effectPalette: ["zoom-punch", "shake", "chromatic-aberration"],
    transitionPalette: ["hardCut"],
    musicMoodHints: ["aggressive", "electronic", "impact-driven"],
    rules: { pacing: "fast", transitionPreference: ["hardCut"], effectPalette: ["zoom-punch", "shake", "chromatic-aberration"], textStyle: "minimal", cutStyle: "hard", colorMood: "vibrant", musicRole: "rhythmic" },
  },
  {
    id: "cinematic-trailer",
    name: "Cinematic Trailer",
    description: "A restrained opening that accelerates into a dramatic climax with title cards and audio swells.",
    pacing: "slow",
    cutsPerMinuteTarget: [8, 24],
    effectPalette: ["vignette", "color-balance", "motion-blur"],
    transitionPalette: ["crossfade", "dipToBlack", "hardCut"],
    musicMoodHints: ["orchestral", "ominous", "rising tension"],
    rules: { pacing: "slow", transitionPreference: ["crossfade", "dipToBlack", "hardCut"], effectPalette: ["vignette", "color-balance", "motion-blur"], textStyle: "minimal", cutStyle: "mixed", colorMood: "cool", musicRole: "featured" },
  },
  {
    id: "tutorial-howto",
    name: "Tutorial / How-To",
    description: "Clear instructional pacing with lower-thirds, step callouts, and consistent explanatory captions.",
    layoutHint: "sequential",
    pacing: "medium",
    cutsPerMinuteTarget: [10, 24],
    captionTemplate: { fontSize: 36, color: "#ffffff", backgroundColor: "#111111", backgroundPadding: 12, backgroundRadius: 6, position: { x: 0.08, y: 0.86 }, align: "left" },
    effectPalette: ["brightness", "contrast"],
    transitionPalette: ["crossfade", "hardCut"],
    musicMoodHints: ["light", "focused", "low volume"],
    rules: { pacing: "medium", transitionPreference: ["crossfade", "hardCut"], effectPalette: ["brightness", "contrast"], textStyle: "heavy", cutStyle: "soft", colorMood: "neutral", musicRole: "background" },
  },
  {
    id: "before-after",
    name: "Before / After Transformation",
    description: "A measured transformation reveal using held frames and a clean split comparison.",
    layoutHint: "split-compare",
    pacing: "slow",
    cutsPerMinuteTarget: [4, 14],
    effectPalette: ["brightness", "contrast", "saturation"],
    transitionPalette: ["match-cut", "crossfade"],
    musicMoodHints: ["anticipatory", "uplifting", "minimal"],
    rules: { pacing: "slow", transitionPreference: ["match-cut", "crossfade"], effectPalette: ["brightness", "contrast", "saturation"], textStyle: "moderate", cutStyle: "soft", colorMood: "neutral", musicRole: "background" },
  },
  {
    id: "day-in-the-life",
    name: "Day in the Life / Vlog",
    description: "Personal, natural pacing with timestamp captions and an ambient music bed.",
    pacing: "medium",
    cutsPerMinuteTarget: [8, 20],
    effectPalette: ["brightness", "warmth"],
    transitionPalette: ["crossfade", "hardCut", "slide"],
    musicMoodHints: ["warm", "ambient", "casual"],
    rules: { pacing: "medium", transitionPreference: ["crossfade", "hardCut", "slide"], effectPalette: ["brightness", "warmth"], textStyle: "moderate", cutStyle: "mixed", colorMood: "warm", musicRole: "background" },
  },
  {
    id: "product-demo",
    name: "Product Demo",
    description: "Feature-led product presentation with callouts, clean cuts, and optional reaction PIP.",
    layoutHint: "pip-reaction",
    pacing: "medium",
    cutsPerMinuteTarget: [8, 20],
    captionTemplate: { fontSize: 40, fontWeight: 600, color: "#ffffff", position: { x: 0.08, y: 0.14 }, align: "left" },
    effectPalette: ["brightness", "contrast", "sharpen"],
    transitionPalette: ["hardCut", "crossfade", "slide"],
    musicMoodHints: ["clean", "confident", "modern"],
    rules: { pacing: "medium", transitionPreference: ["hardCut", "crossfade", "slide"], effectPalette: ["brightness", "contrast"], textStyle: "moderate", cutStyle: "mixed", colorMood: "cool", musicRole: "background" },
  },
  {
    id: "podcast-clip",
    name: "Podcast Clip",
    description: "Dialogue-forward edit with readable captions, speaker identification, and restrained visual motion.",
    pacing: "slow",
    cutsPerMinuteTarget: [4, 12],
    captionTemplate: { fontSize: 42, fontWeight: 700, color: "#ffffff", position: { x: 0.5, y: 0.78 }, align: "center", animation: "text-reveal-up" },
    effectPalette: ["contrast", "color-balance"],
    transitionPalette: ["hardCut", "crossfade"],
    musicMoodHints: ["none", "subtle", "dialogue-first"],
    rules: { pacing: "slow", transitionPreference: ["hardCut", "crossfade"], effectPalette: ["contrast", "color-balance"], textStyle: "heavy", cutStyle: "soft", colorMood: "neutral", musicRole: "background" },
  },
  {
    id: "listicle-countdown",
    name: "Countdown / Listicle",
    description: "Fast numbered beats with one clear title card or caption treatment per item.",
    pacing: "fast",
    cutsPerMinuteTarget: [18, 36],
    effectPalette: ["zoom-punch", "brightness", "saturation"],
    transitionPalette: ["hardCut", "slide", "whipPan"],
    musicMoodHints: ["upbeat", "countdown", "playful"],
    rules: { pacing: "fast", transitionPreference: ["hardCut", "slide", "whipPan"], effectPalette: ["zoom-punch", "brightness", "saturation"], textStyle: "heavy", cutStyle: "hard", colorMood: "vibrant", musicRole: "rhythmic" },
  },
  {
    id: "meme-compilation",
    name: "Meme Compilation",
    description: "Very fast comedic compilation using hard cuts and minimal transition decoration.",
    pacing: "fast",
    cutsPerMinuteTarget: [30, 75],
    effectPalette: ["zoom-punch", "shake", "brightness"],
    transitionPalette: ["hardCut"],
    musicMoodHints: ["comedic", "chaotic", "viral"],
    rules: { pacing: "fast", transitionPreference: ["hardCut"], effectPalette: ["zoom-punch", "shake", "brightness"], textStyle: "heavy", cutStyle: "hard", colorMood: "vibrant", musicRole: "rhythmic" },
  },
  {
    id: "sports-highlight",
    name: "Sports Highlight Reel",
    description: "Energetic sports edit with slow motion on key moments, score overlays, and impact sound cues.",
    pacing: "fast",
    cutsPerMinuteTarget: [20, 45],
    effectPalette: ["zoom-punch", "motion-blur", "contrast", "saturation"],
    transitionPalette: ["hardCut", "whipPan", "flash"],
    musicMoodHints: ["anthemic", "stadium", "high energy"],
    rules: { pacing: "fast", transitionPreference: ["hardCut", "whipPan", "flash"], effectPalette: ["zoom-punch", "motion-blur", "contrast", "saturation"], textStyle: "moderate", cutStyle: "hard", colorMood: "vibrant", musicRole: "rhythmic" },
  },
  {
    id: "glow-up-reveal",
    name: "Glow-Up / Prank Reveal",
    description: "A suspenseful setup that resolves into a visual reveal, often using a split comparison or reveal transition.",
    layoutHint: "split-compare",
    pacing: "medium",
    cutsPerMinuteTarget: [10, 24],
    effectPalette: ["brightness", "saturation", "zoom-punch"],
    transitionPalette: ["match-cut", "flash", "crossfade"],
    musicMoodHints: ["suspenseful", "playful", "reveal"],
    rules: { pacing: "medium", transitionPreference: ["match-cut", "flash", "crossfade"], effectPalette: ["brightness", "saturation", "zoom-punch"], textStyle: "moderate", cutStyle: "mixed", colorMood: "vibrant", musicRole: "featured" },
  },
];

export function getGenreById(id: string): Genre | undefined {
  return PRE_BAKED_GENRES.find((g) => g.id === id);
}

export function listGenreIds(): readonly string[] {
  return PRE_BAKED_GENRES.map((g) => g.id);
}
```

## `packages/agent/src/director/motion-moves.ts`

```typescript
import { DEFAULT_SHAPE_STYLE } from "@kove-advanced/core/graphics/types";
import { addMotionLayerEffect, createMotionEffect } from "@kove-advanced/core/motion/motion-effects";
import { applyMotionAnimationPreset } from "@kove-advanced/core/motion/motion-animation-presets";
import { createMotionParticleLayer } from "@kove-advanced/core/motion/motion-particles";
import { createMotionScene3DLayer } from "@kove-advanced/core/motion/motion-scene3d";
import {
  DEFAULT_MOTION_TRANSFORM,
  type MotionComposition,
  type MotionLayer,
  type MotionShapeLayer,
  type MotionTextLayer,
} from "@kove-advanced/core/motion/types";
import type { MotionMoveId } from "@kove-advanced/creation-schema";

export interface MotionMoveContext {
  readonly composition: MotionComposition;
  readonly duration: number;
  readonly title?: string;
}

export interface MotionMoveResult {
  readonly composition: MotionComposition;
  readonly move: MotionMoveId;
  readonly layerIds: readonly string[];
  readonly sequence: readonly string[];
}

export const MOTION_MOVE_LIBRARY: Readonly<Record<MotionMoveId, readonly string[]>> = {
  "particle-burst-on-cut": [
    "create_motion_composition",
    "add_motion_layer:particle",
    "configure_particle_emitter",
  ],
  "glitch-transition": [
    "create_motion_composition",
    "add_motion_layer:shape",
    "add_motion_effect:chromatic-aberration",
    "animate_layer:scale-pop",
  ],
  "3d-title-card": [
    "create_motion_composition",
    "add_motion_layer:scene3d(text3d)",
    "add_motion_layer:text",
    "animate_layer:slide-up-in",
  ],
};

export function buildMotionMove(
  move: MotionMoveId,
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  switch (move) {
    case "particle-burst-on-cut":
      return buildParticleBurst(context, idFactory);
    case "glitch-transition":
      return buildGlitchTransition(context, idFactory);
    case "3d-title-card":
      return build3dTitleCard(context, idFactory);
  }
}

function buildParticleBurst(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const particle = createMotionParticleLayer(context.composition, {
    id: idFactory(),
    name: "Particle Burst",
    duration: context.duration,
    position: {
      x: context.composition.width / 2,
      y: context.composition.height / 2,
    },
    emitter: {
      emissionRate: 180,
      maxParticles: 420,
      lifetime: Math.min(1.4, context.duration),
      speed: 520,
      spread: 360,
      gravity: 40,
      size: 14,
      sizeRandomness: 0.7,
      colorStart: "#ffffff",
      colorEnd: "#14b8a6",
      seed: 2401,
    },
  });
  const nextComposition = appendLayers(context.composition, [particle]);
  return {
    composition: nextComposition,
    move: "particle-burst-on-cut",
    layerIds: [particle.id],
    sequence: MOTION_MOVE_LIBRARY["particle-burst-on-cut"],
  };
}

function buildGlitchTransition(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const base: MotionShapeLayer = {
    id: idFactory(),
    type: "shape",
    name: "Glitch Transition Plate",
    startTime: 0,
    duration: context.duration,
    visible: true,
    locked: false,
    transform: {
      ...DEFAULT_MOTION_TRANSFORM,
      position: { x: context.composition.width / 2, y: context.composition.height / 2 },
      scale: { x: 1.08, y: 1.08 },
    },
    keyframes: [],
    shapeType: "rectangle",
    width: context.composition.width,
    height: context.composition.height,
    style: {
      ...DEFAULT_SHAPE_STYLE,
      fill: { type: "solid", color: "#ffffff", opacity: 0.92 },
    },
  };
  const withEffect = addMotionLayerEffect(base, createMotionEffect("chromatic-aberration", idFactory()));
  const animated = applyMotionAnimationPreset(withEffect, "scale-pop", {
    startTime: 0,
    duration: Math.min(0.32, context.duration),
    intensity: 1.35,
    idFactory: () => idFactory(),
  });
  const nextComposition = appendLayers(context.composition, [animated]);
  return {
    composition: nextComposition,
    move: "glitch-transition",
    layerIds: [animated.id],
    sequence: MOTION_MOVE_LIBRARY["glitch-transition"],
  };
}

function build3dTitleCard(
  context: MotionMoveContext,
  idFactory: () => string,
): MotionMoveResult {
  const title = context.title?.trim() || "KOVE";
  const scene = createMotionScene3DLayer({
    id: idFactory(),
    name: "3D Title Object",
    duration: context.duration,
    compositionWidth: context.composition.width,
    compositionHeight: context.composition.height,
    object: { kind: "text3d", text: title, extrude: 0.24, size: 0.72 },
    material: {
      kind: "physical",
      color: "#14b8a6",
      metalness: 0.35,
      roughness: 0.24,
      emissive: "#0f766e",
      emissiveIntensity: 0.3,
    },
    camera: {
      position: { x: 0, y: 0.2, z: 4.5 },
      target: { x: 0, y: 0, z: 0 },
      fov: 34,
    },
    lighting: { environment: "studio", groundShadow: true, keyIntensity: 1.2, rimIntensity: 0.8 },
  });
  const typography: MotionTextLayer = {
    id: idFactory(),
    type: "text",
    name: "3D Title Label",
    startTime: 0,
    duration: context.duration,
    visible: true,
    locked: false,
    transform: {
      ...DEFAULT_MOTION_TRANSFORM,
      position: { x: context.composition.width / 2, y: context.composition.height * 0.82 },
    },
    keyframes: [],
    text: title,
    style: {
      fontFamily: "Inter",
      fontSize: Math.max(28, context.composition.width * 0.045),
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      lineHeight: 1,
      letterSpacing: 4,
    },
  };
  const animatedTypography = applyMotionAnimationPreset(typography, "slide-up-in", {
    startTime: 0.08,
    duration: Math.min(0.55, context.duration),
    distance: 80,
    idFactory: () => idFactory(),
  });
  const nextComposition = appendLayers(context.composition, [scene, animatedTypography]);
  return {
    composition: nextComposition,
    move: "3d-title-card",
    layerIds: [scene.id, animatedTypography.id],
    sequence: MOTION_MOVE_LIBRARY["3d-title-card"],
  };
}

function appendLayers(
  composition: MotionComposition,
  layers: readonly MotionLayer[],
): MotionComposition {
  return {
    ...composition,
    layers: [...composition.layers, ...layers],
    modifiedAt: Date.now(),
  };
}
```

## `packages/creation-schema/src/director/edit-plan.ts`

```typescript
export interface PlannedSegment {
  readonly sourceVideoId: string;
  readonly sourceStartTime: number;
  readonly sourceEndTime: number;
  readonly trackIndex?: number;
  readonly targetPosition?: number;
  readonly speed?: number;
  readonly speedRamp?: PlannedSpeedRamp;
  readonly effects: readonly string[];
  readonly effectSpecs?: readonly PlannedEffectSpec[];
  readonly layout?: EditPlanLayout;
  readonly rationale: string;
}

export type EditPlanLayoutRegion =
  | "fullscreen"
  | "split-left"
  | "split-right"
  | "split-top"
  | "split-bottom"
  | "pip-corner"
  | "custom";

export interface EditPlanLayout {
  readonly region: EditPlanLayoutRegion;
  readonly pipCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  readonly customRect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly fit?: "cover" | "contain";
}

export type SpeedRampEasing =
  | "linear"
  | "ease"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuart"
  | "easeOutQuart"
  | "easeInOutQuart"
  | "smoothstep"
  | "smootherstep"
  | "snappy"
  | "smooth";

export interface PlannedSpeedKeyframe {
  readonly time: number;
  readonly speed: number;
  readonly easing?: SpeedRampEasing;
}

export interface PlannedFreezeFrame {
  readonly sourceTime: number;
  readonly startTime: number;
  readonly duration: number;
}

export interface PlannedSpeedRamp {
  readonly keyframes: readonly PlannedSpeedKeyframe[];
  readonly freezeFrames?: readonly PlannedFreezeFrame[];
  readonly pitchCorrection?: boolean;
}

export type TextStyle =
  | "title"
  | "subtitle"
  | "lower-third"
  | "caption"
  | "callout";

export interface PlannedText {
  readonly content: string;
  readonly style: TextStyle;
  readonly startTime: number;
  readonly duration: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
  readonly templateOverride?: Partial<CaptionStyleTemplate>;
  readonly rationale: string;
}

export interface CaptionStyleTemplate {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly backgroundPadding?: number;
  readonly backgroundRadius?: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly align?: "left" | "center" | "right";
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export type MotionMoveId =
  | "particle-burst-on-cut"
  | "glitch-transition"
  | "3d-title-card";

export interface MotionMomentSpec {
  readonly move: MotionMoveId;
  readonly segmentIndex?: number;
  readonly atTime?: number;
  readonly duration?: number;
  readonly insertIntoEditor?: boolean;
  readonly rationale?: string;
}

export interface PlannedEffectSpec {
  readonly type: string;
  readonly params: Record<string, unknown>;
  readonly intensity?: number;
  readonly startOffset?: number;
  readonly duration?: number;
  readonly easing?: string;
  readonly rationale: string;
}

export interface PlannedEffect extends PlannedEffectSpec {
  readonly targetSegmentIndex?: number;
}

export interface PlannedTransition {
  readonly afterSegmentIndex: number;
  readonly type: string;
  readonly duration: number;
  readonly rationale: string;
}

export type AudioDecisionType = "music" | "sfx" | "silence";

export interface PlannedAudio {
  readonly type: AudioDecisionType;
  readonly sourceVideoId?: string;
  readonly sourceStartTime?: number;
  readonly sourceEndTime?: number;
  readonly startTime: number;
  readonly duration: number;
  readonly volume?: number;
  readonly rationale: string;
}

export type Pacing = "fast" | "medium" | "slow";

export interface EditPlanMetadata {
  readonly targetDuration: number;
  readonly targetPlatform: string;
  readonly genre: string;
  readonly pacing: Pacing;
  readonly rationale: string;
}

export interface EditPlan {
  readonly segments: readonly PlannedSegment[];
  readonly textElements: readonly PlannedText[];
  readonly effects: readonly PlannedEffect[];
  readonly transitions: readonly PlannedTransition[];
  readonly audioDecisions: readonly PlannedAudio[];
  readonly metadata: EditPlanMetadata;
  readonly captionTemplate?: CaptionStyleTemplate;
  readonly motionMoments?: readonly MotionMomentSpec[];
}
```

## `packages/creation-schema/src/director/validate.ts`

```typescript
import type { EditPlan, EditPlanLayout, PlannedSegment, PlannedSpeedRamp } from "./edit-plan";
import type { SegmentMap, VideoSegmentMap } from "./segment-map";

export interface DirectorValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly path?: string;
}

function issue(
  severity: DirectorValidationIssue["severity"],
  code: string,
  message: string,
  path?: string,
): DirectorValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

export function validateSegmentMap(
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (!segmentMap || !segmentMap.videos || !Array.isArray(segmentMap.videos)) {
    issues.push(
      issue("error", "invalid_structure", "SegmentMap is missing or has no videos array."),
    );
    return issues;
  }

  if (segmentMap.videos.length === 0) {
    issues.push(
      issue("error", "no_videos", "SegmentMap contains no video analyses."),
    );
    return issues;
  }

  for (const video of segmentMap.videos) {
    if (video.segments.length === 0) {
      issues.push(
        issue(
          "warning",
          "no_segments",
          `Video "${video.videoId}" has no segments.`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    for (const dupe of duplicates(video.segments.map((s: { id: string }) => s.id))) {
      issues.push(
        issue(
          "error",
          "duplicate_segment_id",
          `Duplicate segment id "${dupe}" in video "${video.videoId}".`,
          `videos.${video.videoId}.segments`,
        ),
      );
    }

    let lastEnd = 0;
    for (const segment of video.segments) {
      if (segment.startTime < lastEnd) {
        issues.push(
          issue(
            "warning",
            "overlapping_segments",
            `Segment "${segment.id}" overlaps with previous segment in video "${video.videoId}".`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.endTime <= segment.startTime) {
        issues.push(
          issue(
            "error",
            "bad_segment_duration",
            `Segment "${segment.id}" has zero or negative duration.`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      if (segment.confidence < 0 || segment.confidence > 1) {
        issues.push(
          issue(
            "error",
            "bad_confidence",
            `Segment "${segment.id}" confidence ${segment.confidence} is outside [0, 1].`,
            `videos.${video.videoId}.segments.${segment.id}`,
          ),
        );
      }
      lastEnd = segment.endTime;
    }
  }

  return issues;
}

export function validateEditPlan(
  plan: EditPlan,
  segmentMap: SegmentMap,
): readonly DirectorValidationIssue[] {
  const issues: DirectorValidationIssue[] = [];

  if (plan.segments.length === 0) {
    issues.push(issue("warning", "empty_plan", "EditPlan has no segments."));
  }

  const videoIds = new Set(
    segmentMap.videos.map((v: VideoSegmentMap) => v.videoId),
  );

  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i] as PlannedSegment;
    if (!videoIds.has(seg.sourceVideoId)) {
      issues.push(
        issue(
          "error",
          "unknown_source_video",
          `Segment ${i} references unknown video "${seg.sourceVideoId}".`,
          `segments.${i}.sourceVideoId`,
        ),
      );
    }
    if (seg.sourceEndTime <= seg.sourceStartTime) {
      issues.push(
        issue(
          "error",
          "bad_source_range",
          `Segment ${i} has zero or negative source duration.`,
          `segments.${i}`,
        ),
      );
    }
    if (seg.targetPosition !== undefined && seg.targetPosition < 0) {
      issues.push(
        issue(
          "error",
          "negative_position",
          `Segment ${i} has negative target position.`,
          `segments.${i}.targetPosition`,
        ),
      );
    }
    validateLayout(seg.layout, i, issues);
    validateSpeedRamp(seg.speedRamp, seg.sourceEndTime - seg.sourceStartTime, i, issues);
    seg.effectSpecs?.forEach((effect, effectIndex) => {
      if (!effect.type.trim()) {
        issues.push(issue("error", "empty_effect_type", `Segment ${i} effect ${effectIndex} has no type.`, `segments.${i}.effectSpecs.${effectIndex}.type`));
      }
      if (effect.intensity !== undefined && (!Number.isFinite(effect.intensity) || effect.intensity < 0 || effect.intensity > 1)) {
        issues.push(issue("warning", "effect_intensity_out_of_range", `Segment ${i} effect ${effectIndex} intensity out of [0,1] — will be clamped.`, `segments.${i}.effectSpecs.${effectIndex}.intensity`));
      }
      if (effect.startOffset !== undefined && (!Number.isFinite(effect.startOffset) || effect.startOffset < 0)) {
        issues.push(issue("warning", "effect_offset_out_of_range", `Segment ${i} effect ${effectIndex} startOffset negative — will be clamped to 0.`, `segments.${i}.effectSpecs.${effectIndex}.startOffset`));
      }
      if (effect.duration !== undefined && (!Number.isFinite(effect.duration) || effect.duration <= 0)) {
        issues.push(issue("warning", "effect_duration_invalid", `Segment ${i} effect ${effectIndex} duration non-positive — will be clamped to 0.01.`, `segments.${i}.effectSpecs.${effectIndex}.duration`));
      }
      if (effect.easing !== undefined && !effect.easing.trim()) {
        issues.push(issue("error", "effect_easing_invalid", `Segment ${i} effect ${effectIndex} easing cannot be empty.`, `segments.${i}.effectSpecs.${effectIndex}.easing`));
      }
    });
  }

  for (let i = 0; i < plan.segments.length; i += 1) {
    const layout = plan.segments[i]?.layout;
    if (!layout || layout.region === "fullscreen" || layout.region === "custom") continue;
    const hasPartner = plan.segments.some((candidate, candidateIndex) => {
      if (candidateIndex === i || candidate.trackIndex === plan.segments[i]?.trackIndex) return false;
      if (!candidate.layout) return layout.region === "pip-corner";
      if (layout.region === "pip-corner") {
        return candidate.layout.region === "fullscreen" || candidate.layout.region === "pip-corner";
      }
      const splitPair = new Set([layout.region, candidate.layout.region]);
      return (
        (splitPair.has("split-left") && splitPair.has("split-right")) ||
        (splitPair.has("split-top") && splitPair.has("split-bottom"))
      ) && rangesOverlap(plan.segments[i] as PlannedSegment, candidate);
    });
    if (!hasPartner) {
      issues.push(issue(
        "warning",
        layout.region === "pip-corner" ? "orphan_pip_layout" : "orphan_split_layout",
        `Segment ${i} uses ${layout.region} without an overlapping visual partner.`,
        `segments.${i}.layout`,
      ));
    }
  }

  for (let i = 0; i < (plan.motionMoments?.length ?? 0); i += 1) {
    const moment = plan.motionMoments?.[i];
    if (!moment) continue;
    if (moment.segmentIndex !== undefined && (moment.segmentIndex < 0 || moment.segmentIndex >= plan.segments.length || !Number.isInteger(moment.segmentIndex))) {
      issues.push(issue("error", "invalid_motion_segment", `Motion moment ${i} references an invalid segment index.`, `motionMoments.${i}.segmentIndex`));
    }
    if (moment.atTime !== undefined && (!Number.isFinite(moment.atTime) || moment.atTime < 0)) {
      issues.push(issue("error", "invalid_motion_time", `Motion moment ${i} has an invalid start time.`, `motionMoments.${i}.atTime`));
    }
    if (moment.duration !== undefined && (!Number.isFinite(moment.duration) || moment.duration <= 0)) {
      issues.push(issue("error", "invalid_motion_duration", `Motion moment ${i} has an invalid duration.`, `motionMoments.${i}.duration`));
    }
  }

  if (plan.metadata.targetDuration <= 0) {
    issues.push(
      issue("error", "bad_target_duration", "Target duration must be positive.", "metadata.targetDuration"),
    );
  }

  return issues;
}

function rangesOverlap(left: PlannedSegment, right: PlannedSegment): boolean {
  const leftStart = left.targetPosition ?? 0;
  const rightStart = right.targetPosition ?? 0;
  const leftEnd = leftStart + Math.max(0, left.sourceEndTime - left.sourceStartTime);
  const rightEnd = rightStart + Math.max(0, right.sourceEndTime - right.sourceStartTime);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function validateLayout(
  layout: EditPlanLayout | undefined,
  segmentIndex: number,
  issues: DirectorValidationIssue[],
): void {
  if (!layout || layout.region !== "custom") return;
  const rect = layout.customRect;
  if (!rect || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    issues.push(issue("error", "invalid_layout_rect", `Segment ${segmentIndex} has a custom layout rectangle outside the normalized frame.`, `segments.${segmentIndex}.layout.customRect`));
  }
}

function validateSpeedRamp(
  ramp: PlannedSpeedRamp | undefined,
  sourceDuration: number,
  segmentIndex: number,
  issues: DirectorValidationIssue[],
): void {
  if (!ramp) return;
  if (ramp.keyframes.length < 2) {
    issues.push(issue("error", "insufficient_speed_keyframes", `Segment ${segmentIndex} speed ramps need at least two keyframes.`, `segments.${segmentIndex}.speedRamp.keyframes`));
  }
  let previousTime = -Infinity;
  ramp.keyframes.forEach((keyframe, keyframeIndex) => {
    if (!Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > sourceDuration) {
      issues.push(issue("error", "speed_keyframe_out_of_range", `Segment ${segmentIndex} speed keyframe ${keyframeIndex} is outside the source range.`, `segments.${segmentIndex}.speedRamp.keyframes.${keyframeIndex}.time`));
    }
    if (keyframe.time < previousTime) {
      issues.push(issue("error", "speed_keyframes_unsorted", `Segment ${segmentIndex} speed keyframes must be sorted by time.`, `segments.${segmentIndex}.speedRamp.keyframes`));
    }
    if (!Number.isFinite(keyframe.speed) || keyframe.speed < 0.1 || keyframe.speed > 20) {
      issues.push(issue("error", "speed_out_of_range", `Segment ${segmentIndex} speed must be between 0.1x and 20x.`, `segments.${segmentIndex}.speedRamp.keyframes.${keyframeIndex}.speed`));
    }
    previousTime = keyframe.time;
  });
  ramp.freezeFrames?.forEach((freeze, freezeIndex) => {
    if (!Number.isFinite(freeze.sourceTime) || !Number.isFinite(freeze.startTime) || !Number.isFinite(freeze.duration) || freeze.duration <= 0) {
      issues.push(issue("error", "invalid_freeze_frame", `Segment ${segmentIndex} freeze frame ${freezeIndex} has non-finite or non-positive values.`, `segments.${segmentIndex}.speedRamp.freezeFrames.${freezeIndex}`));
    } else if (freeze.sourceTime < 0 || freeze.sourceTime > sourceDuration || freeze.startTime < 0) {
      issues.push(issue("warning", "clamp_freeze_frame", `Segment ${segmentIndex} freeze frame ${freezeIndex} sourceTime/startTime out of range — will be clamped.`, `segments.${segmentIndex}.speedRamp.freezeFrames.${freezeIndex}`));
    }
  });
}

export function normalizeEditPlan(
  plan: EditPlan,
  segmentMap: SegmentMap,
): EditPlan {
  const videosById = new Map(segmentMap.videos.map((video) => [video.videoId, video]));
  const segments = plan.segments.map((segment) => {
    const video = videosById.get(segment.sourceVideoId);
    const duration = video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : undefined;
    let start = Number.isFinite(segment.sourceStartTime)
      ? Math.max(0, segment.sourceStartTime)
      : 0;
    let end = Number.isFinite(segment.sourceEndTime)
      ? Math.max(0, segment.sourceEndTime)
      : 0;

    if (duration !== undefined) {
      start = Math.min(start, duration);
      end = Math.min(end, duration);
    }
    if (end <= start) {
      start = 0;
      end = duration ?? 1;
    }

    return { ...segment, sourceStartTime: start, sourceEndTime: end };
  });
  const transitions = plan.transitions.map((transition) => {
    const previous = segments[transition.afterSegmentIndex];
    const next = segments[transition.afterSegmentIndex + 1];
    const maxDuration = previous && next
      ? Math.min(previous.sourceEndTime - previous.sourceStartTime, next.sourceEndTime - next.sourceStartTime) * 2
      : 0.25;
    const duration = Number.isFinite(transition.duration) && transition.duration > 0
      ? transition.duration
      : Math.min(0.25, maxDuration);

    return { ...transition, duration };
  });

  return {
    ...plan,
    segments,
    transitions,
  };
}

export function summarizeSegmentMap(segmentMap: SegmentMap): string {
  if (!segmentMap || !segmentMap.videos || !Array.isArray(segmentMap.videos)) {
    return "SegmentMap unavailable";
  }
  const totalSegments = segmentMap.videos.reduce(
    (sum, v) => sum + (v.segments?.length ?? 0),
    0,
  );
  const totalDuration = segmentMap.videos.reduce(
    (sum, v) => sum + (Number.isFinite(v.duration) ? v.duration : 0),
    0,
  );
  return `${segmentMap.videos.length} video(s), ${totalSegments} segment(s), ${totalDuration.toFixed(1)}s total`;
}

export function summarizeEditPlan(plan: EditPlan): string {
  return `${plan.segments.length} segment(s), ${plan.textElements.length} text element(s), ${plan.effects.length} effect(s), ${plan.transitions.length} transition(s), target ${plan.metadata.targetDuration}s`;
}
```

## `packages/creation-schema/src/director/style-profile.ts`

```typescript
export type StyleProfilePacing = "fast" | "moderate" | "medium" | "slow" | "unknown";
export type StyleProfileCutStyle = "hard" | "soft" | "mixed" | "unknown";

export interface StyleProfile {
  readonly version: "1.0.0";
  readonly pacing: StyleProfilePacing;
  readonly cutsPerMinute: number;
  readonly medianShotDuration: number;
  readonly cutOnBeatRatio: number | null;
  readonly effectDensity: number;
  readonly transitionDensity: number;
  readonly textOverlayDensity: number;
  readonly shotTypeDistribution: Readonly<Record<string, number>>;
  readonly cutStyle: StyleProfileCutStyle;
  readonly effectPalette: readonly string[];
  readonly transitionPalette: readonly string[];
  readonly detectedBpm: number | null;
  readonly dialogueRatio: number;
  readonly musicRatio: number;
  readonly confidence: number;
}

export interface StyleProfileTarget {
  readonly pacing?: StyleProfilePacing;
  readonly cutsPerMinute?: readonly [number, number];
  readonly cutStyle?: StyleProfileCutStyle;
  readonly effectPalette?: readonly string[];
  readonly transitionPalette?: readonly string[];
}

export interface StyleProfileComparison {
  readonly score: number;
  readonly deviations: readonly string[];
}

export function compareStyleProfile(
  profile: StyleProfile,
  target: StyleProfileTarget,
): StyleProfileComparison {
  const scores: number[] = [];
  const deviations: string[] = [];

  if (target.cutsPerMinute) {
    const [minimum, maximum] = target.cutsPerMinute;
    if (profile.cutsPerMinute < minimum || profile.cutsPerMinute > maximum) {
      const distance = profile.cutsPerMinute < minimum
        ? minimum - profile.cutsPerMinute
        : profile.cutsPerMinute - maximum;
      scores.push(Math.max(0, 1 - distance / Math.max(1, maximum - minimum)));
      deviations.push(`cutsPerMinute ${profile.cutsPerMinute} is outside ${minimum}-${maximum}`);
    } else {
      scores.push(1);
    }
  }

  if (target.pacing) {
    scores.push(profile.pacing === target.pacing ? 1 : 0);
    if (profile.pacing !== target.pacing) {
      deviations.push(`pacing ${profile.pacing} does not match ${target.pacing}`);
    }
  }

  if (target.cutStyle) {
    scores.push(profile.cutStyle === target.cutStyle ? 1 : 0);
    if (profile.cutStyle !== target.cutStyle) {
      deviations.push(`cutStyle ${profile.cutStyle} does not match ${target.cutStyle}`);
    }
  }

  if (target.effectPalette) {
    scores.push(paletteOverlap(profile.effectPalette, target.effectPalette));
  }
  if (target.transitionPalette) {
    scores.push(paletteOverlap(profile.transitionPalette, target.transitionPalette));
  }

  return {
    score: scores.length > 0 ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 1,
    deviations,
  };
}

function paletteOverlap(actual: readonly string[], target: readonly string[]): number {
  if (target.length === 0) return 1;
  const targetValues = new Set(target);
  return actual.filter((value) => targetValues.has(value)).length / target.length;
}
```

## `packages/creation-schema/src/director/quality-signals.ts`

```typescript
export type SportsMomentEvent =
  | "action-peak"
  | "shot-release"
  | "crowd-reaction"
  | "celebration"
  | "dialogue-emphasis"
  | "unknown";

export interface RenderedFrameObservation {
  readonly timestamp: number;
  readonly sharpness: number;
  readonly subjectVisibility: number;
  readonly textLegibility: number;
  readonly audioEnergy?: number;
  readonly hasBlackFrame?: boolean;
}

export interface RenderedDraftReview {
  readonly score: number;
  readonly issues: readonly string[];
}

export function scoreSportsMoment(input: {
  readonly motionPeak?: number;
  readonly audioEnergy?: number;
  readonly facePresenceRatio?: number;
  readonly hasTalkingHead?: boolean;
  readonly hasDialogue?: boolean;
  readonly shotBoundaryAtStart?: boolean;
}): { score: number; event: SportsMomentEvent } {
  const motion = clamp(input.motionPeak ?? 0);
  const audio = clamp(input.audioEnergy ?? 0);
  const face = clamp(input.facePresenceRatio ?? 0);
  const score = clamp(
    motion * 0.5
      + audio * 0.25
      + face * 0.1
      + (input.shotBoundaryAtStart ? 0.1 : 0)
      + (input.hasTalkingHead || input.hasDialogue ? 0.05 : 0),
  );
  const event: SportsMomentEvent = input.hasTalkingHead || input.hasDialogue
    ? "dialogue-emphasis"
    : audio >= 0.75 && motion >= 0.65
      ? "crowd-reaction"
      : motion >= 0.8
        ? "shot-release"
        : motion >= 0.55
          ? "action-peak"
          : "unknown";
  return { score, event };
}

export function snapTimeToBeat(
  time: number,
  beatTimestamps: readonly number[],
  tolerance = 0.2,
): number {
  const nearest = beatTimestamps.reduce<{ time: number; distance: number } | undefined>(
    (best, beat) => {
      const distance = Math.abs(beat - time);
      return distance <= tolerance && (!best || distance < best.distance)
        ? { time: beat, distance }
        : best;
    },
    undefined,
  );
  return nearest?.time ?? time;
}

export function reviewRenderedDraft(
  observations: readonly RenderedFrameObservation[],
): RenderedDraftReview {
  if (observations.length === 0) return { score: 0, issues: ["No rendered frame observations were provided."] };
  const issues: string[] = [];
  const blackFrames = observations.filter((observation) => observation.hasBlackFrame).length;
  const lowSharpness = observations.filter((observation) => observation.sharpness < 0.25).length;
  const lowVisibility = observations.filter((observation) => observation.subjectVisibility < 0.35).length;
  const unreadableText = observations.filter((observation) => observation.textLegibility < 0.4).length;
  if (blackFrames > 0) issues.push(`${blackFrames} rendered frame(s) are black or empty.`);
  if (lowSharpness > 0) issues.push(`${lowSharpness} rendered frame(s) are too soft.`);
  if (lowVisibility > 0) issues.push(`${lowVisibility} rendered frame(s) lose the primary subject.`);
  if (unreadableText > 0) issues.push(`${unreadableText} rendered frame(s) have low text legibility.`);
  const penalty = (blackFrames * 0.3 + lowSharpness * 0.15 + lowVisibility * 0.2 + unreadableText * 0.1) / observations.length;
  return { score: Math.max(0, Math.min(1, 1 - penalty)), issues };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
```
