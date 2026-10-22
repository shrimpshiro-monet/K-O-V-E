# K.O.V.E — Director prompt v2 + code hardening: execution brief

Repo: github.com/shrimpshiro-monet/K-O-V-E · Branch: `fix/prompts` (exists, pushed).
Work directly on it. Commit early, commit small, push as you go.

## 1. Understand first (do not code before this)

Read, in order — they are the spec for this task:
1. `DIRECTOR-V2-HANDOFF.md` — **primary spec**: the full v2 director prompt and
   required code changes C1-C6, in dependency order, plus the landing checklist
   and the baseline numbers each change must move.
2. `PROMPTS.md` — every AI prompt surface, the 7 verified contradictions
   (line-anchored), and why each defect matters.
3. `PROMPTS-CONTENT.md` — current verbatim text of every prompt (what you're
   replacing; use it to find duplication you must delete, not copy).

Context you must internalize:
- A 37-run real-corpus eval (`evaluation-files/baseline-v0.json`, read-only)
  measured: 1-in-3 runs die with stacked same-timestamp segments; zero
  rendered transitions in 36/36; one 2757s timeline from a 30s request;
  quality vs real human edits = 0.63 (craft 0.53). These are THE failures.
- An external audit proved the current prompt contradicts itself (density
  rules, effect-param scales, phantom workflow, impossible hook-text timing).
  Verdicts and exact lines are in PROMPTS.md — trust it over your first
  reading of the old prompt.
- Prompt wording alone will NOT fix the stacking failure. C2/C3 (code) are
  the load-bearing changes. Do not quietly drop them.

## 2. Execute — order is a dependency graph

C1 → C6 exactly as specified in DIRECTOR-V2-HANDOFF.md:
- **C1** effect-param scale: trace tool → materializer → renderer
  (registry.ts:16569 → video-engine.ts:4040-4045), pick the ONE true scale,
  build `EFFECT_PARAM_BLOCK` from that table, align prompts + manifest,
  regenerate with `pnpm --filter @kove-advanced/agent gen:docs`.
  C1 before any A/B or you're measuring a broken pipeline.
- **C2** repair-once (registry.ts:33834-33850) sends an auto-relaid,
  sequential corrected plan — not a restated rule.
- **C3** deterministic length clamp: summed sequence vs contract target
  (from `inferTargetDuration`, NOT the model's metadata), reject >±10%
  before repair.
- **C4** dedupe `buildSystemPrompt` (system-prompt.ts Monet section, incl.
  :138 "Less is more"); keep the reference-intent directive path intact.
- **C5** land v2 (director-prompt.ts:44) — keep `buildDirectorPrompt`
  contract+graph appends; remove phantom workflow (:194-195).
- **C6** plan-JSON dump in `runBaselineCase` → `evaluation-files/plans/`
  (untracked) so failures are diagnosable.

## 3. Iterate — verify every step, don't batch blind

After EACH of C1-C6:

```bash
pnpm --filter @kove-advanced/agent test:run        # 893 must stay green
cd packages/agent && node_modules/.bin/tsc --noEmit
```

- `director-prompt.test.ts` / `plan-edit-integrity.test.ts` assert against the
  OLD prompt. Update expectations to v2's actual content — strengthen, never
  delete or weaken coverage. If a test encodes an audit-proven defect,
  say so in the commit message when you change it.
- Strict TS, no `any`, no comments unless asked, mimic existing style.
- If you must deviate from the handoff: deviate, commit, and record
  *what/why* in the final report. Silent deviations are failures.
- Sanity-check claims against source (`rg`) before "fixing" them.

## 4. Hard rules (violating = task failed)

- NEVER commit: `evaluation-files/`, any media files, `session-*.md`,
  `.venv/`, or frozen eval files (`packages/agent-runner/src/evals/{cases,rubric}.ts`,
  `packages/agent/src/eval/corpus.ts`).
- Conventional commits (`feat:`/`fix:`/`docs:`/`refactor:`). No force-push,
  no history rewrites, no drive-by refactors outside this task's files.
- Run from repo root unless stated; pnpm workspace, not npm.

## 5. Validate the result

Local (always):

```bash
pnpm typecheck && pnpm test:run && pnpm lint
```

Live (when Cloudflare quota resets — both free accounts exhaust daily;
creds in `.dev.vars`, override with `KOVE_EVAL_CLOUDFLARE_*`):

```bash
cd packages/agent && KOVE_EVAL_BASELINE=1 node_modules/.bin/vitest run src/eval/baseline.test.ts
```

Compare vs `evaluation-files/baseline-v0.json`:
- `gateRates.allGates.mean` 0.639 → up
- `INVALID_EDIT_PLAN` share of failures → down (C2)
- max `timelineDuration` 2757 → clamped (C3)
- runs with `transitionCount > 0`: 0/36 → most (v2)
- `quality` craft 0.53 → up

If quota is out, say so and leave the rerun as an explicit next step —
do not fake or skip reporting it.

## 6. Done =

1. C1-C6 landed (or each gap explicitly justified), v2 active,
2. all suites green, typecheck+lint clean, manifest regenerated,
3. pushed to `fix/prompts`,
4. final report: table of change → defect targeted → evidence it works
   (test or baseline number), plus anything deferred (thumbnails/two-call/
   reviewer rationale-gate are follow-ups, not blockers).

---

# Section 6 — Final report (2026-10-22, branch `arena/62b7f22b-k-o-v-e`, PR #14)

## Change → defect targeted → evidence

| Change | Audit defect targeted | Evidence it works |
|---|---|---|
| **C1** one true effect-param scale (`types/clip-effect-params.ts` table + `clampClipEffectParams`; `effect-filter-css.ts` `cssFilterForEffect` as the single CSS interpreter; GLSL/WGSL uniform scales ÷100; clamps at `add_video_effect`, `update_video_effect`, plan materializer; `EFFECT_PARAM_BLOCK` generated from the manifest and injected into `DIRECTOR_SYSTEM_PROMPT`, `plan_edit`/`add_video_effect`/`update_video_effect` descriptions; manifest regenerated) | PROMPTS.md #2: contrast/saturation specified 0..2 vs −100..100 vs renderer multipliers; brightness with 4 interpretations; falsy `\|\|1` no-ops; blown-frame risk | `clip-effect-params.test.ts` (6), `effect-filter-css.test.ts` (6 incl. cross-engine agreement for canvas2d + VideoEffectsEngine), `effect-param-scale.test.ts` (7 incl. clamp 50→2, 0 preserved, string coercion); `canvas2d-fallback-renderer.test.ts` pins `brightness(20)→brightness(1.2)`; `gen-docs.test.ts` (manifest freshness); golden tests still pin the settled storage scale |
| **C2** repair shows the corrected plan (`relayPlanSegmentsSequentially` in `creation-schema/director/validate.ts`; `preparePlan` relays before validation; repair turn receives the relayed plan JSON; `placementRepairs` reported) | PROMPTS.md #5 priority-1 defect (a): 1-in-3 runs stack shots at one timestamp, the repair re-states the rule and the model repeats the error | `validate.test.ts` +5 relay unit tests (push-forward, gaps kept, overlay pairs safe, transition pins frozen, explicit positions written); `plan-edit-integrity.test.ts` "relays stacked … no repair round-trip", "shows the repair the relayed plan" (asserts `Corrected plan:` + `"targetPosition":4` in the repair turn), "rejects a stacked plan that still fails …" (overlap never in final issues) |
| **C3** deterministic length clamp (target = `buildDensityContract(prompt, genre).targetDuration`, never `metadata.targetDuration`; span via `computePlanPlacement` after relay; reject >+10% always, <−10% only when footage could cover it; `durationCheck {targetSeconds, planSeconds, availableVideoSeconds}` in the payload) | PROMPTS.md GAP 3 / behavior axis "user expects 30s, gets 12s"; the 220s-for-30s-request runaway | `plan-edit-integrity.test.ts` over +10% rejected even when metadata agrees (204s vs 30s), under −10% rejected with 60s of footage, footage-short exemption (10s footage, 30s request → commits) |
| **C4** `buildSystemPrompt` Monet section deduped to routing only (perception / effect-placement / audio blocks and "Less is more" deleted; Reference Intent path kept verbatim) | PROMPTS.md #1+#7: 6-15 effect-hits floor vs "Less is more 2-5" vs "over-editing is worse" — the model got two opposite density signals per turn | `system-prompt.test.ts` (4): routing kept, reference-intent kept, duplicate blocks pinned ABSENT |
| **C5** `DIRECTOR_SYSTEM_PROMPT` v2 landed (verbatim from the handoff's embedded block; generated-block interpolations live; phantom "IMMEDIATELY EXECUTE … split_clip" workflow gone; `buildDirectorPrompt` contract+graph appends kept) | PROMPTS.md #3 (director told to execute tools it never receives), #4 (text timing impossible on 0.4–1.0s hooks), transitions emitted 0/36 runs | `director-prompt.test.ts` updated to v2 (stronger: transitions now REQUIRED — "a plan with ZERO rendered transitions is incomplete") + new v2-contract test (plan-only job, sequential `targetPosition` chaining, length = contract within 5%, "No signal means no shot", generated param table present, `split_clip`/`IMMEDIATELY EXECUTE` absent) |
| **C6** plan-JSON dumps in `runBaselineCase` → `evaluation-files/plans/<entry>/<prompt>-run<n>.json` (accepted **and** rejected plans; untracked via `.gitignore`) | Decisive experiment #1's prerequisite: without plan dumps nobody can inspect emitted contrast/saturation values | `plan-dump.test.ts` (path + round-trip contract); dumps are best-effort and never fail a case |

## Cracks found and closed during the pass

1. **C1 clamp was a silent no-op** — `add_video_effect` forwarded raw `args` to the action and only used the processed params for the shader check; adversarial test caught value 50 stored unclamped. Fixed (`params: { ...args, params }`).
2. **String-typed params** (`"value": "50"`) bypassed both `clampClipEffectParams` and `readNumber` — coerced numerics now clamp/render instead of blowing or no-opping.
3. **Falsy `value || 1` traps** — legal `contrast(0)`/`saturate(0)` rendered as identity; `cssFilterForEffect` reads finite values (incl. 0) explicitly; pinned in tests.
4. **Repair path re-stacking** — a resubmitted stacked plan could ship overlap; `preparePlan` now relays every accepted plan (initial, repair, revision), so overlap never appears in a final rejection.
5. **Transition-pinned segments** — a naive relay would break butt-joined cuts; the walk freezes segments that follow a transition (unit-pinned).
6. **Length gate ordering** — stacked plans measure their true length only after relay; gate runs on the relayed span. Under-length rejection is exempt when the footage genuinely cannot cover the target (else 15s of clips for a 30s request becomes a dead end).
7. **Strict-TSC unused imports** (workspace `noUnusedLocals`) caught in two new test files — fixed.

## Tests changed because they encoded audit-proven defects (not weakened)

- `plan-edit-integrity.test.ts` "rejects overlapping primary-video segments" — expected stacked plans to **die** (the GAP-4 failure mode); now asserts relay + direct commit.
- Two `plan-edit-integrity.test.ts` fixtures produced 6.1s plans for "8s" targets (the GAP-3 drift); now sum to exactly 8s.
- `director-prompt.test.ts` pinned "Most junctions should stay hard cuts" (the restraint rule behind 0/36 transitions); replaced by v2's stronger requirement.

## Verification

- **Workspace**: `pnpm typecheck` clean (all 16 projects); `pnpm test` green everywhere except `apps/desktop` (Electron binary cannot download in this sandbox — 13 suites fail at `Electron failed to install correctly`; the 76 tests that could run passed). `pnpm lint`: 0 errors (112 pre-existing warnings in untouched `apps/web` code; the touched packages have no lint script).
- **Agent suite**: 841 passed | 74 skipped (915) — baseline at `01e43668` was 823 | 74 (897).
- **Core suite**: 1728 passed | 20 skipped (1748). **creation-schema**: 46 passed.
- **Manifest**: `gen:docs` regenerated (committed in C1); `gen-docs.test.ts` guards freshness.
- **Live A/B eval (KOVE_EVAL_BASELINE=1)**: **NOT RUN — cannot run in this environment.** `evaluation-files/projects.json` (corpus), the media assets, and `.dev.vars` (Workers AI credentials) are absent from the checkout (ENOENT on `projects.json`). Baseline metrics from the audit (allGates.mean 0.639, craft 0.53, INVALID_EDIT_PLAN share, max timelineDuration 2757, transitionCount>0 0/36) therefore **could not be re-measured**; C1–C6 evidence is unit/integration-level. Do not treat the target improvements as measured.

## Deviations from the handoff (recorded per hard rules)

1. Work is on `arena/62b7f22b-k-o-v-e` (platform constraint), PR #14 to `main` — not `fix/prompts` (user accepted).
2. `DIRECTOR-V2-PROMPT.md` was never committed to the repo; v2 was pasted verbatim from the handoff's embedded `## The prompt` block (with `\${…}` escapes switched back to live interpolations).
3. C2+C3 share one commit (both normalize inside `preparePlan`; their tests are interdependent).
4. v2's "Otherwise overlapping segments are a rejected plan" is kept verbatim while code relays stacking (C2) — the prompt prevents, code corrects; consistent with v2's "code wins" preamble. Likewise v2's ±5% length guidance vs C3's ±10% hard gate (prompt aims tighter; the gate enforces the spec tolerance).
5. The C3 rejection payload carries `plan` and `durationCheck` beyond the handoff's minimum (informative rejection requirement).

## Deferred follow-ups (recorded, not blockers — per handoff)

- Reviewer gate: reject effectSpec/transition/speedRamp without a rationale citing a signal (beat@t, motionPeak, importance, boundary) — v2 prompt now *demands* signals ("No signal means no shot") but nothing mechanically rejects signal-less rationales yet.
- Pass 4–6 thumbnails per segment to the planner (biggest craft win; text-only planning is the ceiling).
- Optional two-call split (cut list → treatment).
- Live A/B re-run once corpus + credentials are available; the C6 plan dumps make the audit's "inspect 20 plans' contrast values" check possible on the first run.
