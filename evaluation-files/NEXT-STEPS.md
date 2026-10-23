# NEXT-STEPS — zero-knowledge handoff for the K.O.V.E. director eval campaign

Assume you know nothing. This file is the complete action plan. The deep context (evidence,
provider matrix, source excerpts) is in `HANDOFF-EVAL-DEFECTS.md` — read the sections this
file cites when you need them.

## What this project is (one paragraph)

K.O.V.E. is a browser-based video editor. The AI director "Monet" authors an edit (called
an EditPlan: clips, transitions, effects, camera moves, text, motion overlays) in a single
tool call, which the system then materializes onto the timeline. We are running a
**live corpus eval**: 9 sample projects × 3 prompt styles (detailed / vague / genre) × k=3
sampled runs = **81 case-runs** through the real code path (not a simulation), gated on
plan validity, materialization, and clip-overlap correctness, with craft counters
(transitions, effects) reported. The "perfect set" = all 81 pass all gates with visible
craft.

## Current state (as of commit `874ce10b`, 2026-10-23)

- **Everything is landed, tested, and pushed.** `main` == `fix/prompts` ==
  `arena/62b7f22b-k-o-v-e` at `874ce10b`. Nothing is half-finished in the working tree
  (only untracked junk at repo root — session notes, etc.).
- **The headline bug is fixed.** Inserted motion moments (`motionMoments[].insertIntoEditor:
  true`) used to land on the primary video track and fail the overlap gate 100% of the
  time. Now they go to a dedicated "Motion" graphics track, the gate skips overlay tracks,
  overlays are clamped to the footage extent, and a regression test pins it. Evidence and
  mechanism: `HANDOFF-EVAL-DEFECTS.md` §8.1.
- **The harness survives long runs now.** Per-row JSONL journal (`<report>.rows.jsonl`),
  12h live-test timeout, transport abort + 120s SSE-idle watchdogs, infra-failure rows
  excluded from rates and re-run on resume, model-mismatch guard (one model per report),
  craft counters read back from the materialized project (not the tool's self-report).
- **The last live qwen k=3 run was deliberately killed** (before the D1 fix). **No current
  live report exists.** 7 historical rows from that run are in the handoff doc §7 — they
  prove the D1 bug, nothing more. `baseline-v0.json` is absent until the next run finishes.
- **Model choice is settled:** the only working tool-capable route is the user's
  self-hosted OmniRoute gateway on `alibaba/qwen3.8-max`. Workers AI gemma is measured too
  slow for k=3 (~6 days) and passes gates by doing less (timid craft). Details:
  handoff §5 (provider matrix) and §5.2 (credentials — key is in `.dev.vars`, gitignored).
- **Gaps that remain are deliberate deferrals**, listed below in priority order. They are
  the actual remaining work.

## Your job (in order)

### 0. Orient yourself (15 min)

```bash
cd /Users/hamza/Desktop/k.o.v.e
git log --oneline -5          # should show 874ce10b as tip
git status                    # expect clean except untracked root junk
pnpm --filter @kove-advanced/agent exec tsc --noEmit   # must be clean
pnpm --filter @kove-advanced/agent test:run src/eval/baseline.test.ts src/eval/resume.test.ts src/eval/quality.test.ts
```

Expect: tsc clean, ~32 passed | 1 skipped on the eval tests. If anything fails here, stop
and read the failure — the baseline should be green.

Read (in this order): `AGENTS.md` (repo conventions), this file, `HANDOFF-EVAL-DEFECTS.md`
§0-§4 (mission, timeline, eval infra) and §8 (defects). Skip §5-§6 until you need the
gateway. Skip Appendix §13 unless you need verbatim source — and remember it is a
point-in-time snapshot at `b80c501f`, *before* the D1 fix; the header of the handoff wins
over the appendix when they disagree.

### 1. Add the missing gates (the real remaining eval work)

Right now the eval only hard-gates: plan valid, plan materializes, no clip overlap on
video/image/audio tracks. Craft (transitions, effects, camera moves) is only *reported*,
never *gated*. The v2 director prompt asks for specific craft behavior that is currently
unenforced by the harness. Implement, in `packages/agent/src/eval/baseline.ts` (gates run
in `gateRow` / wherever `plan_validates` etc. are computed — find them, they are adjacent):

1. **Gap gate** (`no_timeline_gaps`): the placed footage must cover the timeline without
   dead air — i.e. no gap > some epsilon (suggest 0.25s) between consecutive clips on the
   primary video track. A gap means black frames.
2. **Transition minimum** (`meets_transition_minimum`): if the plan is not a pure talking-
   head (heuristic: prompt style is vague/genre, or project is not a podcast — use your
   judgment, document it), require `transitionCount >= 1` on the materialized project.
   Detailed podcast-style rows may legitimately have 0.
3. **Camera-move cap** (`camera_move_density_ok`): max ~70% of eligible clips should carry
   a camera move (a "cap" — not a minimum; overuse is the failure mode, see D4). Read back
   from the project: a clip "has a camera move" iff its keyframes include a position/scale
   track authored by `compileCameraMoves` (check the keyframe structure, not the tool
   report).
4. **No consecutive identical accents**: adjacent cuts must not use the same transition
   type AND the same effect preset back-to-back (the v2 prompt forbids this; gate it).
5. **Duration tolerance** (`duration_within_tolerance`): materialized timeline length must
   be within ±10% of the plan's declared `targetDurationSeconds` (or the sum of planned
   segments — pick one definition and stick to it).
6. **Rename the k-agreement column** from "determinism" to `spread` (or `pass@k`): the
   provider ignores T=0/seed pins (three vague runs produced 0, 2, 1 motion moments —
   handoff §7). Report `all_pass` / `all_fail` / `mixed` per combination. Do not claim
   determinism anywhere in code, tests, or reports.

Each new gate: a clear `GateResult` with a human-readable reason (the existing gates have
this pattern — copy it). Update `baseline.test.ts` / `quality.test.ts` to cover the new
gates with synthetic plans (no LLM needed — the unit tests build plans in-memory).

Verify: `pnpm --filter @kove-advanced/agent exec tsc --noEmit` clean;
`pnpm --filter @kove-advanced/agent test:run src/eval/` all green. Commit as
`feat(eval): add craft + gap gates to baseline director eval` and push.

### 2. Verify the gateway is alive (or bring it up)

The gateway is a local Node process on the user's Mac — **not a daemon**, dies on reboot.

```bash
curl -s http://localhost:20128/api/health
```

If dead or you need a fresh start:

```bash
nohup npx -y -p node@22.22.2 node ~/.npm-global/lib/node_modules/omniroute/bin/omniroute.mjs \
  serve --no-open > /var/folders/xg/79c6mh7n3jl31j6s_j41yl6r0000gp/T/opencode/omni-3852.log 2>&1 &
```

Then canary-probe (never trust `/v1/models` — it lies, handoff §5.1):

```bash
set -a; source .dev.vars; set +a
curl -s -m 90 "$OMNIROUTE_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OMNIROUTE_KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$OMNIROUTE_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}"
```

Expect `"choices"` in the body. DATA_DIR must stay `~/.omniroute` (a subdir orphans the
provider DB). Full ops manual: handoff §5.

### 3. Run the full k=3 qwen eval on the fixed build

The self-healing runner is committed at `evaluation-files/run-until-complete.sh`. It
probes the gateway, falls back to Workers AI only if the gateway is down (`ran -eq 0`
guard), resumes via the JSONL journal, and appends to `evaluation-files/runner.log`.

```bash
pgrep -f run-until-complete || \
  (nohup zsh evaluation-files/run-until-complete.sh >/dev/null 2>&1 & echo "runner launched")
```

- **Never edit the script while it is running** (zsh re-read hazard): `pkill -f
  run-until-complete`, edit, relaunch.
- Wall clock: qwen cases take 8-17 min each; concurrency 3; 81 cases → plan for **~4-6
  hours**. The runner is patient (90 idle cycles × 600s); the transport watchdog kills
  individual requests that go silent for 120s, and the live test has a 12h cap.
- Report lands at `evaluation-files/baseline-v0.json` **only when the run ends**; per-row
  rows stream to `evaluation-files/baseline-v0.rows.jsonl` the whole time. Tail the JSONL
  to watch progress. A model-mismatch guard refuses to resume a report measured on a
  different model — keep `OMNIROUTE_MODEL` fixed for the whole report.
- Mid-course: if the gateway process dies, §2 brings it back; the runner's next cycle
  will pick up via `RESUME=1`. If you need to change code, kill the runner first, land
  the commit, relaunch — resume is safe across commits as long as you do not change
  *eval semantics* mid-report (if you do, archive the old report and start fresh so
  before/after stays measurable).

While the run goes, there is nothing to babysit. Do step 4's deferred items if you want
to stay busy — but do not touch `baseline.ts` gate semantics until the report is done.

### 4. When the 81-row report lands: analyze and summarize

1. Open `evaluation-files/baseline-v0.json`. Check `summary`: rates for each gate
   (including the new ones from step 1), `infraExcluded` count, per-combination `spread`.
2. Compare against the frozen gemma partial
   (`baseline-v0-gemma-k3-partial.json`): plan/materialize was 85.6% ± 6.8%, allThree
   85.6%, craft timid (0-4 transitions). The question for qwen: does it beat gemma on
   allThree *and* on craft counts, now that the D1 trap is removed?
3. Specifically check the **vague and genre rows** — they are where qwen used motion
   moments (0/2/1 in the killed run). Do they now pass with real craft?
4. Check the **detailed podcast rows** — they had 0 transitions in the killed run. Is the
   new transition-minimum gate (step 1.2) passing them by the podcast exemption, or
   failing them because the density contract is suppressing transitions (the D4
   corollary)? If the latter, a small prompt nudge in
   `packages/agent/src/director/director-prompt.ts` + re-measure.
5. Write the campaign summary for the user: allThree rate, per-gate rates, spread, craft
   counts vs gemma, and any rows that still fail with the *reason* from the gate result.

### 5. Deferred work (not blocking the eval — pick up after step 4)

Ordered by value:

1. **Motion-overlay render order (product bug).** `renderMotionInstancesToCanvasCtx` in
   `packages/core/src/video/video-engine.ts` paints motion instances *before* the main
   track loop, so the overlay is composited first and the video over it wins — overlays
   may currently render *under* the video on the final export even though they sit
   correctly on the timeline. Fix the paint order (motion instances should composite after
   / above the tracks they overlay). Verify with a hand-built project containing an
   inserted motion moment over a clip.
2. **Two-call split for latency.** A single `submit_edit_plan` call takes 8-17 min because
   the model plans and writes the entire schema in one shot. Split into (a) a cheap
   structure pass (segments, rough placement) then (b) a detail pass (effects, text,
   motion moments) — or stream+validate incrementally. Product goal: first usable draft in
   <90s. This is the biggest UX lever and is deliberately deferred so the eval harness
   was not disturbed mid-campaign.
3. **Thumbnail/first-frame planning.** The director currently has no notion of picking a
   representative frame per segment for previews/storyboards. Add to the plan schema if
   the product wants it.
4. **Reference-style eval case.** The corpus has no case that tests "edit in the style of
   X" (feed a reference clip/fingerprint and ask for a matching edit). The reference
   fingerprints in `evaluation-files/reference/` exist but no prompt exercises them.
5. **`speed` placement math (D2, handoff §8.2).** Speed-ramp relativize landed for plan
   normalization (`d8ab41a9`) but relay/validate placement still ignores `speed`. Low
   priority; not currently causing gate failures.
6. **Camera-move cap in the validator (not just the prompt).** The v2 prompt asks for
   restraint on camera moves; step 1.3 gates it at eval time, but the schema validator
   (`packages/creation-schema/src/director/validate.ts`) could also soft-warn or clamp
   during authoring.
7. **Security follow-up for the operator (tell the user, do not do it yourself without
   asking):** the gateway API key previously leaked into an uncommitted handoff draft
   (scrubbed before commit — verify with `git log -p | grep sk-`); recommend rotating the
   key and changing the omniroute dashboard password (currently the default).

## Quick command reference

```bash
# typecheck + tests (agent package)
pnpm --filter @kove-advanced/agent exec tsc --noEmit
pnpm --filter @kove-advanced/agent test:run src/eval/baseline.test.ts

# smoke the live path (3 cases, k=1, ~15+ min — do not use a short tool timeout)
set -a; source .dev.vars; set +a
env KOVE_EVAL_LLM_PROVIDER=omni KOVE_EVAL_BASELINE=1 KOVE_EVAL_LIMIT=3 KOVE_EVAL_RUNS=1 \
  pnpm --filter @kove-advanced/agent test:run src/eval/baseline.test.ts

# full run
zsh evaluation-files/run-until-complete.sh

# watch progress
tail -f evaluation-files/baseline-v0.rows.jsonl | jq -r '[.id,.run,.gates[]?] | @tsv'

# gateway
curl -s http://localhost:20128/api/health
```

Env knobs (full table: handoff §4): `KOVE_EVAL_BASELINE=1`,
`KOVE_EVAL_LIMIT`, `KOVE_EVAL_RUNS`, `KOVE_EVAL_RESUME=1`,
`KOVE_EVAL_LLM_PROVIDER=omni|workers`,
`KOVE_EVAL_OMNIROUTE_{BASE_URL,KEY,MODEL}` > `OMNIROUTE_*` > `.dev.vars`.

## What NOT to do

- Do not re-litigate prompt style or re-run pre-v2 baselines.
- Do not touch Workers AI quota logic unless asked.
- Do not revert the streaming transport to non-stream (Alibaba kills non-streaming at
  ~15 min; tests pin the SSE folding, handoff §6).
- Do not commit keys: `.dev.vars` is gitignored; never paste a key into a doc.
- Do not edit `run-until-complete.sh` while it is running.
- Do not chase kimi-web/zai-web for the eval route — they cannot carry OpenAI tools
  (handoff §5.3). Viable paths only: alibaba (primary), or an API-key kimi provider the
  user connects.
- Do not "fix" a craft-feature gate failure by telling the model to stop using the
  feature — fix the system (that was the D1 lesson).
