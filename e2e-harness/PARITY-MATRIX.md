# Export Parity Matrix — complex features, proven per-pixel on the exported MP4

Evidence rule: every claim is computed from decoded frames / ffprobe of the
exported file itself (`$HARNESS_HOME/export-motion/motion-export.mp4`, produced
by a full chat→plan→timeline→export run against the llm-stub director). No
structural reasoning, no store introspection. Each check carries a no-op
CONTROL sampled from the raw media through the same decode path, so a metric
that always passes counts for nothing.

- Full run: `sh e2e-harness/bootstrap.sh`, start llm-stub + vite, then
  `NODE_PATH=$HARNESS/tools/node_modules node $H/export-verify-motion.cjs` (~8 min).
- Analysis-only on the cached file: `SKIP_EXPORT=1` with the same env.

Latest full-flow verification (fresh sandbox rebuild): **6/6 PASS**,
14.02 s h264 1920×1080, 7.3 MB.

## Verified in the exported file (export-verify-motion.cjs)

| # | Feature | Metric on exported MP4 | Result |
|---|---------|------------------------|--------|
| 1 | Container / format | h264, 1920×1080, duration=14.02 s | PASS |
| 2 | Signature GLSL shader `duotone` | Outro pixels within 60 of the #11133f→#ffca6b ramp line: **100.0%** vs raw media control 37.5% | PASS |
| 3 | Camera move `slow-push` (scale 1→1.08) | Centre-crop dark-region area: export **0.848×** (|Δ|=15.2% ≈ 1/1.08²) vs source control 1.003× | PASS |
| 4 | `speedRamp` keyframes 1→8× | Median frame-diff in 1× window (pb 5.3–6.7) = 3.4 → ramp peak 15.3 @ t=8.03 (**4.51×**) | PASS |
| 5 | `freezeFrames` hold | 5th-percentile frame-diff trough **0.00** vs median 2.12 | PASS |
| 6 | Motion moment `particle-burst-on-cut` | Near-black plate lum 9.6 vs ambient 48.7/125.6; white/teal specks 13,199 inside | PASS |

## Verified in the earlier classic run (export-verify.cjs, separate file)

hue-140° (139.5° measured histogram shift) · crossfade (50/50 mid-blend vs
endpoint controls) · dipToBlack (lum trough 3.1 between plates 48/126) ·
title overlay glyph cluster at planned position/colour · lower-third band ·
audio mix/ducking (RMS envelopes) · container/format.

## Vocabulary inventory (what exists → what's proven)

- Transitions: 38 types (`SUPPORTED_TRANSITION_TYPES`); proven in file: crossfade, dipToBlack.
- Clip filter effects: 21 (`SUPPORTED_CLIP_EFFECT_TYPES`); proven: hue.
- Signature shaders: 20 (`SIGNATURE_EFFECT_NAMES`); proven: duotone.
- Camera moves: 15 ids; proven: slow-push.
- Speed/time: `speedRamp` ✓, `freezeFrames` ✓ (needs the executeAction sync fix, below).
- Motion moments: 3 ids; proven: particle-burst-on-cut.
- Masks: NOT a plan-vocabulary feature (engine-internal only) — nothing to verify.

## Bugs found by these proofs

1. `plan_apply` partial-failure rolled back wrong clip ids.
2. `timeline/setClipEffects` ignored by the `executeAction` dispatcher.
3. `executeAction`/`resyncRenderBridges` never called
   `syncOverlayEnginesFromProject()` — plan-materialized ramps/freezes reached
   clips but never the SpeedEngine; export rendered 1× straight-through
   (motion curve flat ~6, no 8× spike, no trough). Fix in
   `apps/web/src/stores/project-store.ts` (+ `resyncRenderBridges`), regression
   test `project-store.executeAction-bridge-sync.test.ts`.

## Metric design notes (for future harness authors)

- Source controls: every check compares the exported sample against the RAW
  media decoded identically (`rawFrame` shares the decode path).
- Camera-move deltas are anchored absolute (BASE 1.0 + delta); slow-push is
  only 8% — under encode noise for naive metrics. Centre-crop dark-region
  ratio 0.848× ≈ 1/1.08² is the disciplined probe; the 1.003× source control
  pins the baseline.
- rgbtestsrc-derived media with `hue=240*t` poisons fixed colour thresholds —
  "white" boxes rotate through saturated colours. Use structure, motion, or
  post-effect whiteness (particles render AFTER clip effects) instead.
- Hard cuts create frame-diff spikes ~30× baseline; baselines must exclude
  ±0.5 s around planned cuts, peaks must window to the ramp span.
