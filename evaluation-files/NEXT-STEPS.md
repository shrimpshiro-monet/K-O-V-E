# NEXT-STEPS — zero-knowledge handoff for the K.O.V.E. director eval campaign

Assume you know nothing. This file is the complete action plan. The deep context (evidence,
provider matrix, source excerpts) is in `HANDOFF-EVAL-DEFECTS.md` — read the sections this
file cites when you need them.

## What this project is (one paragraph)

K.O.V.E. is a browser-based video editor. The AI director "Monet" authors an edit (called
an EditPlan: clips, transitions, effects, camera moves, text, motion overlays) in a single
tool call, which the system then materializes onto the timeline. The **live corpus eval**
uses 9 sample projects × 3 prompt styles (detailed / vague / genre) × k=3 sampled runs =
**81 case-runs** through the real code path (not a simulation). Each case is gated on plan
validity, materialization, clip overlaps, primary-footage gaps, a context-sensitive
transition minimum, camera-move density, repeated transition/effect accents, and target
duration. Craft evidence is read back from the materialized project. The "perfect set" =
all 81 pass every gate; this does not substitute raw counts for edit quality or restraint.

## Current state (2026-10-23)

- This Arena branch is based on `9100a2c`; step 1 below is implemented and verified on
  `arena/905775ed-k-o-v-e`. Do not switch branches; use `git log` for its commit state.
- **The headline D1 bug is fixed** (original fix `874ce10b`). Inserted motion moments
  (`motionMoments[].insertIntoEditor: true`) now go to a dedicated "Motion" graphics track;
  overlap checks skip overlay tracks and overlays are clamped to footage extent. Evidence:
  `HANDOFF-EVAL-DEFECTS.md` §8.1.
- **The harness survives long runs:** per-row JSONL journal, 12h live-test timeout,
  transport abort + 120s SSE-idle watchdogs, infra-failure rows excluded from rates and
  rerun on resume, and a one-model-per-report guard. Current reports include materialized
  craft gates and gate-semantics version 2; pre-v2 reports/journals must not be resumed.
- **No live report exists for the new semantics.** Seven historical rows from the stopped
  run predate the D1 fix. No gateway check or k=3 run has been done from this workspace;
  the gateway is on the user's Mac.
- The gate implementation and synthetic tests are complete, and the full `src/eval/`
  verification is recorded under step 1. The next campaign actions are the later Mac-local
  gateway check and fresh k=3 campaign. Product-side rendering/latency work remains deferred.

## Your job (in order)

### 0. Orient yourself (15 min)

```bash
cd /Users/hamza/Desktop/k.o.v.e
git branch --show-current    # stay on arena/905775ed-k-o-v-e for this task
git status                    # inspect any local changes before continuing
pnpm --filter @kove-advanced/agent exec tsc --noEmit
pnpm --filter @kove-advanced/agent test:run src/eval/
```

In this workspace, tsc is clean and `src/eval/` is 42 passed with media-dependent tests
skipped because corpus assets are absent (see `corpus.test.ts`); run with the user's full
media set before the live campaign. Stop and inspect any unexpected failure.

Read (in this order): `AGENTS.md` (repo conventions), this file, `HANDOFF-EVAL-DEFECTS.md`
§0-§4 (mission, timeline, eval infra) and §8 (defects). Skip §5-§6 until you need the
gateway. Skip Appendix §13 unless you need verbatim source — it is a point-in-time snapshot
at `b80c501f`, before D1 and the current craft gates; current implementation and decisions
in this file and the top of the handoff take precedence.

### 1. Add the missing gates — implementation complete in this branch

The implementation is in `packages/agent/src/eval/baseline.ts`; it reads craft evidence
from the materialized project, not the tool's self-report:

1. **Gap gate** (`no_timeline_gaps`): no uncovered gap over **0.25s** between clips on the
   selected primary footage track. Overlay tracks and `metadata.motionClip === true` clips
   are not treated as primary footage.
2. **Transition minimum** (`meets_transition_minimum`): at least one materialized transition
   for vague/genre rows and other non-exempt projects. An explicit hard-cuts/no-transitions
   request waives it; detailed podcast-style rows may also legitimately have zero.
3. **Camera-move cap** (`camera_move_density_ok`): compiler-authored camera keyframes on no
   more than **70%** of eligible primary-footage clips. It is a cap, not a minimum.
4. **No consecutive identical accents**: consecutive materialized cuts fail only when both
   transition type and outgoing effect preset repeat.
5. **Duration tolerance** (`duration_within_tolerance`): materialized timeline extent is
   within **±10%** of `EditPlan.metadata.targetDuration` (seconds).
6. **Spread report**: per-combination `all_pass` / `all_fail` / `mixed` / `incomplete`, with
   expected combination IDs supplied by the runner. No report claims determinism.

Each craft gate retains a boolean in `gates` and a report-ready `GateResult` reason in
`gateResults`. Per-gate rates are in the summary. Reports carry gate-semantics version 2;
resume rejects older reports and rows without craft-gate results. Archive prior report and
JSONL files before starting this campaign so old and new gate semantics are never mixed.

The gate logic has synthetic no-LLM tests. Verification in this branch: agent TypeScript
check passed; full `src/eval/` suite passed (**42 passed, 71 skipped**). The skips are the
63 effect-golden tests (disabled by default), corpus-backed checks because evaluation media
are absent from this checkout, and the live baseline (not enabled). Commit as
`feat(eval): add craft + gap gates to baseline director eval` and push this branch.
No live report has been run. Gateway verification and the full k=3 campaign remain later
steps; the gateway is a Mac-local process and is not reachable from this workspace.

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

1. Open `evaluation-files/baseline-v0.json`. Check the per-gate rates, `infraExcluded`,
   materialized-project gate reasons, and per-combination `spread`.
2. Use the frozen gemma partial (`baseline-v0-gemma-k3-partial.json`) as historical context
   only: it predates the craft gates, so its 85.6% plan/materialize rate and 85.6% old
   all-three rate are not directly comparable to the new all-gates result. Its transition
   counts (0–4) are descriptive, not a quality score; do not reward quantity over restraint.
3. Specifically inspect the **vague and genre rows** — they are where qwen used motion
   moments (0/2/1 in the killed run). Check whether materialized craft is appropriate and
   whether the new gates pass; counts alone do not establish edit quality.
4. Check the **detailed podcast rows** — they had 0 transitions in the killed run. The
   corpus prompts explicitly request hard cuts/no transitions, so those rows should pass
   the minimum via the explicit prompt exemption (the detailed-podcast exemption is a
   separate safeguard). Check the recorded gate reason; do not weaken prompt behavior to
   game a gate.
5. Write the campaign summary for the user: all-gates and per-gate rates, spread, useful
   materialized craft evidence (not raw counts as a proxy for quality), and rows that fail
   with the gate's *reason*.

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
