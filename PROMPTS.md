# K.O.V.E — AI Prompt Inventory

Every place text is sent to a model (or shapes what the model receives), for the
**prompt-fixing effort**. Ordered by impact. Line numbers are anchors as of
`87f937af` — they drift; search the symbol, not just the line.

**Why we're here:** the baseline eval (37 real case-runs, `evaluation-files/baseline-v0.json`)
shows the director model failing **1-in-3 runs** with stacked overlapping segments,
emitting **zero transitions in 36/36 runs**, and once producing a 46-minute timeline
for a 30-second request. Quality scoring vs real references averages **0.63 overall
(granularity 0.74 / craft 0.53)**. Prompt fixes are the first lever; model swap is second.

**Verification:** `pnpm --filter @kove-advanced/agent test:run` (director-prompt,
mirror-intent, plan-edit-integrity, quality tests must stay green).
Rerun the live eval when quota resets:
`cd packages/agent && KOVE_EVAL_BASELINE=1 node_modules/.bin/vitest run src/eval/baseline.test.ts`
Compare `gateRates.allGates.mean` + the new `quality` section against the current report.

---

## Verified contradictions (external audit — proven against source)

Each claim below was checked line-by-line against the repo; verdicts are what a
fix must actually reconcile.

1. **Two opposite density rules — CONFIRMED.** The density contract is "a floor,
   not a ceiling" for "12-24 shots, 6-15 effect hits" (`director-prompt.ts:62`,
   `:264`), while the same prompt's Variety rule says "For 30s of edit: 2-4
   transitions total, 2-5 segment-specific effects" (`:137`), and the main agent
   prompt repeats the restraint side: "Less is more… Over-editing is worse than
   under-editing" (`system-prompt.ts:138`). 6-15 vs 2-5 is unsatisfiable — the
   model picks per sample, which is exactly the inconsistent craft we score at 0.53.
2. **Contrast/saturation specified three incompatible ways — CONFIRMED.**
   Director: `value 0..2` CSS multipliers, "Never pass percent offsets"
   (`director-prompt.ts:90`). Main prompt: `-100..100` for brightness/contrast/
   saturation (`system-prompt.ts:120`). Auto-generated manifest: `min -100,
   max 100, unit "%", default 0` (`docs/AGENT-CAPABILITIES.md` capability
   manifest). Renderer truth: `video-engine.ts:4040-4045` builds raw CSS
   (`brightness(1+value)`, `contrast(value || 1)`, `saturate(value || 1)`) and
   core presets use multiplier-scale values (contrast 1.15-1.4, brightness ±5).
   **Note:** the audit's specific "1.2 → +1.2% no-op" mechanism is *not* what
   the renderer does (1.2 → +20% there); the proven fact is the three-way
   contradiction, and the likely real failure modes are blown frames (a model
   following `-100..100` sends 20-50 → 20-50×) or falsy no-ops (`0 || 1`).
   Where (if anywhere) params get normalized on the `add_video_effect` path must
   be traced during the fix — the fix must end with **one documented scale** and
   the manifest regenerated (`pnpm --filter @kove-advanced/agent gen:docs`).
3. **Director told to execute work it can't do — CONFIRMED.** Workflow step 4
   says "IMMEDIATELY EXECUTE the accepted plan by calling editing tools
   (split_clip, move_clip…)" and step 5 "respond with ONLY a brief summary"
   (`director-prompt.ts:194-195`), but the director call receives **only**
   `submit_edit_plan` (`registry.ts:33769-33770`) and is explicitly told "do
   not respond with plain text" (`:33781`). ~15% of the prompt is instructions
   for the main agent, not this call.
4. **Text timing impossible on hook shots — CONFIRMED (arithmetic).** Text must
   start 0.3-0.5s after a segment starts and end 0.3s before it ends
   (`director-prompt.ts:140-141`), while hook shots are 0.4-1.0s (`:146`).
   Every hook shorter than ~0.8s yields zero/negative text duration — and
   textElements are *required* for social/short-form (`:115`), i.e. the prompt
   forbids text on the shot it says is most important.
5. **Craft graded via counts — CONFIRMED structurally.** The pre-submit
   self-check is 9 items where 1-8 are count/structure checks and only item 9
   is qualitative ("Would a human editor recognise this…") (`director-prompt.ts:178-187`);
   the review gate "read[s] the plan you submit — not your rationale" (`:193`)
   and forces revision when counts fall short (`creation-schema/src/director/density.ts`).
   The model is paid in counts → confetti.
6. **Beat-snapping targets source audio, not the music track — CONFIRMED at
   schema level.** `beatTimestamps` exist only on source segments
   (`creation-schema/src/director/segment-map.ts:25`); nothing analyzes beats of
   a separately-uploaded music file in the plan_edit flow (the only waveform beat
   tool, `registry.ts:24540`, drives motion compositions, not cuts). Music-driven
   prompts snap cuts to the VOD's audio, not the track's.
7. **Rules copy-pasted across 3-4 surfaces — CONFIRMED**; it is the root cause
   of #1 and #2 and will keep producing drift until one source owns each rule.

**Not the prompt (don't spend prompt effort here):** the planner has no visual
feedback (text + numbers only; repair catches schema errors/counts, never "looks
wrong"), and renderer quality of an effect/transition is independent of wording.

### Decisive experiments (in priority order)
1. **Code-trace first (free):** settle the effect-param scale end-to-end
   (tool → materializer → renderer) and fix to one scale. Already half-done —
   see #2 above.
2. **Baseline A/B (needs quota):** run the existing harness on the current
   prompt, then again after fixes #1-#4; compare `gateRates.allGates.mean`
   (now 0.639), craft (0.53), and `quality.meanOverall`.
3. **Arms B/C + blind export rating** (from the audit): B = fixes above,
   C = a minimal ~600-token prompt (role, schema, vocabulary, "every cut needs
   a reason"). If C beats B, the density contract itself is the problem; if
   all arms tie, the cause is missing visual feedback/renderer, not wording.
   Note: plans aren't persisted by the harness today — if the "inspect 20 real
   plans' contrast values" check is wanted, add plan JSON dumps to
   `runBaselineCase` first (small, additive).

---

## Priority 1 — The director (makes the EditPlans that are failing)

| # | What | Where |
|---|------|-------|
| 1 | **`DIRECTOR_SYSTEM_PROMPT`** — "You are Monet, an AI film director…" The system prompt for every `plan_edit`. ~180 lines of rules, move vocabulary, cut guidance, density/style contract. | `packages/agent/src/director/director-prompt.ts:44` |
| 2 | **`buildDirectorPrompt`** — builds the per-call user turn: segment-map summary + density contract + prompt. | `packages/agent/src/director/director-prompt.ts:409`; called from `packages/agent/src/registry.ts:33765` |
| 3 | **Density / target-duration logic** — `inferTargetDuration` (`:227`), `buildDensityContract` (`:268`), `formatDensityContract` (`:289`). Feeds the length instruction. **Length runaways trace here + #1.** | same file |
| 4 | **`plan_edit` tool description** — shipped in the tool schema on every turn. | `packages/agent/src/registry.ts:33629` (description at `:33632`) |
| 5 | **Repair-once messages** — the one retry after `INVALID_EDIT_PLAN`: system append `registry.ts:33840`, user message with rejected plan `:33844`. **This is what fails on the 1-in-3 stacked-segment runs — the repair restates the rule and the model repeats the same error.** | `packages/agent/src/registry.ts` |
| 6 | **Style/density revision** — `reviewEditPlan` produces `revisionBrief` (`packages/agent/src/director/plan-review.ts:166`), sent with system append + user message. | `registry.ts:33878–33897` |
| 7 | **`EXPANSION_SYSTEM_PROMPT` + `buildExpansionPrompt`** — expands a user prompt into a director's brief before directing. | `director-prompt.ts:531` / `:558`; invoked `registry.ts:33577` |
| 8 | **Genre descriptions** — pre-baked genres injected as prompt context (custom genres are user-saved). | `packages/agent/src/director/genres.ts` (description fields) |

**Known defects to fix here:** (a) stacked same-timestamp segments survive the
system prompt AND the repair — consider making the instructions structural
(sequential slots / explicit anti-overlap example) rather than restated rules;
(b) transitions are never emitted — if #1/#4 don't explicitly value them per
genre, add it; (c) length target lost mid-plan — state target duration in one
canonical place in #1 and cross-check in #5's repair text.

---

## Priority 2 — Main chat agent (every user turn)

| # | What | Where |
|---|------|-------|
| 9 | **`buildSystemPrompt`** — context-aware section assembly: core editor agent (`:58`), **Monet Director section (`:76`)**, Motion/Creation sections (conditional). Determines when the model reaches for `plan_edit`. | `packages/agent/src/system-prompt.ts:42` |
| 10 | **`referenceIntentDirective`** — template appended to the user message for replicate/recreate/reference intents: `Measured: …shots/duration/beats`, warnings, `Do NOT call plan_edit…` rules. | `packages/agent/src/mirror-intent.ts:106` (directive lines `:125–137`) |
| 11 | **Intent detection** — regex/keyword classifier (not an LLM) that decides which directive (if any) applies. | `packages/agent/src/mirror-intent.ts:48–61` |
| 12 | **Call sites for #9/#10** — web chat: `apps/web/src/stores/chat-store.ts:210`, `:256`, `:636`; headless: `packages/agent-runner/src/run.ts:90` (directive), `:148` (system). | — |

---

## Priority 3 — Subagents (own system prompts + tool sets)

Seven subagent system prompts, each a full "You are X" role with a done-checklist:
`packages/agent/src/tools-subagents.ts` — inventory scout `:60`, footage analyst `:81`,
cutter `:100`, stylist `:121`, words agent `:142`, reviewer `:163` (+ brief-checking
reviewer text `:164`). Wired through `packages/agent/src/subagents.ts:42/:170`.

---

## Priority 4 — Tool descriptions (de-facto prompts, sent every turn)

Every tool description is prompt surface. Total inventory:

- **`packages/agent/src/registry.ts`** — ~285 tools (editor + AI + mirror + render
  + creation + export). `plan_edit` is the one that matters most (#4).
- `packages/agent/src/tools-vision.ts` (46 descriptions) — frame/vision tools
- `packages/agent/src/tools-discovery.ts` (8), `tools-history.ts` (7),
  `tools-audio-analysis.ts` (7), `tools-render.ts` (4)
- `packages/agent/src/tools-subagents.ts` (12 — subagent tool specs)
- `packages/creation-agent/src/tools.ts` (4 — creation-engine tools)
- Mirror tools: `packages/agent/src/director/mirror/*-tool.ts` (register into the registry)

Tool-schema shape itself (`schema-conformance.ts` / `registry.ts` `inputSchema`) is
also prompt surface: confusing schemas cause malformed calls regardless of wording.

---

## Priority 5 — Specialty models

| # | What | Where |
|---|------|-------|
| 13 | **AI shader generation (GLSL)** — `COMMON_CONTRACT` + per-category contracts (`fill`/`effect`/…) as an LLM prompt; compiler enforces hard requirements. | `apps/web/src/services/ai-shader-prompt.ts` |
| 14 | **TTS script enhancement (ElevenLabs)** — `ENHANCE_SYSTEM_PROMPT` "professional voice director…"; sent as system with user narration text. | `apps/web/src/components/editor/inspector/tts-constants.ts:7`; call sites `apps/web/src/components/editor/inspector/hooks/useElevenLabsApi.ts:215` and `:244` |

---

## Non-LLM but prompt-shaping (treat as rubric, not prose)

- `packages/creation-schema/src/director/prompt-expansion.ts` — `scorePromptCompleteness`
  (the vague-prompt → clarifying-questions rubric; deterministic, not a model call).
- `packages/agent/src/director/plan-review.ts`, `plan-optimizer.ts`, `taste-engine.ts`,
  `edit-quality-score.ts`, `adaptive-director.ts` — heuristic scoring that *produces*
  prompt text (`revisionBrief`) but makes no LLM calls.
- `apps/web/src/stores/chat-store.ts` reference-intent directive facts (`durationSeconds`,
  `warnings`) — data shaping #10.

## Eval-only prompts (FROZEN — do not edit)

- `packages/agent-runner/src/evals/{cases,rubric}.ts` — frozen eval prompts.
- `packages/agent/src/eval/corpus.ts` — the 27 real corpus prompt strings.
  (The harness passes these through untouched; to change what's tested, add cases
  in a follow-up rather than editing frozen files.)

---

## Suggested fix order

1. **Stop the bleeding (Priority 1 #1 + #5):** anti-overlap structurally unmissable
   (show correct sequential placement; repair shows the fixed plan, not the rule again).
2. **Reconcile audit #1 (density):** one density number set across
   `DIRECTOR_SYSTEM_PROMPT` (:62/:137/:264) and `system-prompt.ts:138` — decide
   floor-vs-restraint once (or make it genre-conditional) and delete the copies.
3. **Reconcile audit #2 (effect scales):** one documented scale for contrast/
   saturation/brightness across director prompt, main prompt, and manifest;
   trace `add_video_effect` → renderer to confirm, then regenerate the manifest.
4. **Delete audit #3:** remove the execute-with-editing-tools Workflow steps
   (194-195) from `DIRECTOR_SYSTEM_PROMPT` — that text belongs (if anywhere) in
   `buildSystemPrompt`, which already says plan_edit applies the plan itself.
5. **Fix audit #4 math:** text timing rule vs hook length — either exempt hook
   shots or shrink margins for segments < ~1.5s.
6. **Craft balance (Priority 1 #1 + #4):** value transitions/craft per genre;
   consider demoting some of self-check items 1-8 so counts stop being the whole
   scoreboard. Verify via the `craft` quality component (0.53 → should rise).
7. **Length (Priority 1 #3):** one canonical target-duration statement; repair
   re-checks it.
8. Rerun baseline → compare `gateRates.allGates.mean` (now 0.639), craft, and
   `quality.meanOverall` before considering a model swap. Then the audit's
   A/B/C arms if deeper evidence is needed.
