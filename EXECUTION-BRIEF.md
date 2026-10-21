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
