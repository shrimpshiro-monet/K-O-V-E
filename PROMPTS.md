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

1. **#1 + #5 together** — anti-overlap must be structurally unmissable (example of
   correct sequential placement; repair text should show the fixed plan, not the rule again).
2. **#1 + #4** — require/encourage transitions and craft per genre; verify via the
   `craft` quality component (currently 0.53 → should rise).
3. **#3 + #5** — single canonical target-duration statement; repair checks length.
4. Rerun baseline → compare `gateRates.allGates.mean` (now 0.639) and `quality.meanOverall`
   (to be established on the next full run) before considering a model swap.
