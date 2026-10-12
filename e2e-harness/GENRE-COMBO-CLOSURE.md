# Genre-Combo Hypothesis Closure (pipeline-controlled live rerun)

## Question

The production live spec (`packages/agent/src/eval/baseline.test.ts`,
`KOVE_EVAL_BASELINE=1`, pin-merged onto `main`) runs the 27-combo corpus
through the director against Cloudflare Workers AI and showed genre combos
failing where custom prompts passed. Two hypotheses:

- **H1 (model output)**: the LLM writes bad plans for genre briefs — fails
  gate A (`plan_validates`, e.g. `unknown_audio_media`, bad durations).
- **H2 (pipeline)**: the genre branch (`genreId` merge, palette/scaffold,
  director-prompt builder) corrupts otherwise valid plans for some project
  shapes.

## Why not the real Workers AI rerun here

Impossible in this sandbox, proved twice:

1. No credentials exist (no `.dev.vars`, no `CLOUDFLARE_*` /
   `KOVE_EVAL_CLOUDFLARE_*` env) → the live spec would skip (no
   `KOVE_EVAL_BASELINE=1`) or error-load config.
2. Supplying fake creds to force the send path
   (`KOVE_EVAL_BASELINE=1 KOVE_EVAL_INCLUDE=game-01/genre KOVE_EVAL_RUNS=1
   KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID=… KOVE_EVAL_CLOUDFLARE_API_TOKEN=…`)
   → every case fails `plan_edit failed [TOOL_ERROR]: fetch failed`:
   `api.cloudflare.com` is outside this sandbox's network allowlist.
   (Logged in a real vitest run; the 21 offline tests in the same file
   stayed green.)

## The controlled experiment instead

`packages/agent/src/eval/live-stub.test.ts` — same baseline harness, same
corpus (27 combos), same gates and reporting, but the LLM client is bound to
the local OpenAI-compatible stub (`e2e-harness/llm-stub.mjs`). The stub's
eval branch answers each director turn with a structurally VALID plan named
in that project's own canonical ids (detected by `video-N` ids in the system
prompt; music decision included only when an `audio-N` id actually exists —
so the re-keying canonicalizer's near-miss/collision cases don't arise).
With the model controlled, anything that still fails is a *pipeline* bug,
localized by project shape × prompt type.

Run: `KOVE_EVAL_LIVE_STUB=1 [KOVE_EVAL_K=3] pnpm vitest run src/eval/live-stub.test.ts`
(llm-stub must be listening on 127.0.0.1:8799).

## Result — k=3 (81 case-runs)

| Gate | mean | stdev | per-run |
|---|---|---|---|
| plan_validates | **100.0%** | 0.0% | 100/100/100 |
| materializes | **100.0%** | 0.0% | 100/100/100 |
| no_clip_overlaps | **100.0%** | 0.0% | 100/100/100 |
| all_three | **100.0%** | 0.0% | 100/100/100 |

Determinism across k=3: **stable pass 27 / stable fail 0 / mixed 0**.
All 9 `/genre` combos green (game-01, game-02, multi-01, multi-02, multi-03,
pod-02, speech-01, sport-01, stream-01).

**Conclusion → H1.** With the models' plans controlled, no project shape or
genre branch leaks an overlap/validation/materialization failure. The live
genre-combo failures are model-output failures (hallucinated / mismatched
plans), exactly the class the purge's `unknown_audio_media` rejection + audio
re-keying canonicalizer addresses. The pipeline needs no genre-combo fix.

## Incidental findings from the experiment (worth follow-up)

1. **Stub detection bug (fixed)**: the stub's first eval-detection keyed on
   harness media *file names* (`gameplay-a.` …), which collide with the
   corpus' actual media file names — so the harness' MOTION_PLAN was served
   into eval runs. Fix: key the eval branch on canonical `video-N` ids only.
2. **Silent video id coercion, by design but gate-relevant**:
   `resolveDirectorVideoId` (packages/agent/src/director/director-prompt.ts)
   falls back to the *first* video on an unmatched reference. A hallucinated
   `sourceVideoId` therefore edits `video-1` rather than failing gate A's
   `unknown_source_video` — i.e. that error code is largely unreachable for
   segments. Compare the purge's audio treatment (`unknown_audio_media`
   error + deterministic re-key): the video side is softer. If the live
   baseline ever shows collections of "wrong clip" plans, this is the lever.
3. **Empty-run-group phantom zeros** — fixed during the purge
   (`rate()` now skips run groups with no valid cases), did not bind here
   because the stub never quota-aborts.

## Artifacts

- Spec: `packages/agent/src/eval/live-stub.test.ts` (env-gated, safe in CI).
- Stub: `e2e-harness/llm-stub.mjs` (eval branch + browser-harness branches).
- Live-stub report: written by the spec to
  `$KOVE_EVAL_STUB_REPORT` (default `/home/user/kove-e2e-harness/eval-live-stub-report.json`).
