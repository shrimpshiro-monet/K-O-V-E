# B2 motion — native-rate capture

The B2 pass before this one sampled the reference once per second and authored
motion by eye. This directory changes what the analyzer looks at: every decoded
frame, a measured curve, and a renderer that plays that curve.

Scope of this step: **one card entrance**, extracted and played back, with a
side-by-side strip. Camera pushes, page wipes, speed ramps, audio and the full
cut are not captured yet.

---

## What the reference actually does

Measured from `reference_videos_to_select/magazine edit, motion graphics.MP4`
(1024×576, 18fps, 437 frames, 24.28s, AAC audio).

`scan` decodes all 437 frames and diffs each against the previous one:

| Property | Measured |
|---|---|
| Frame rate | 18fps native |
| Zero-diff transitions | 26 |
| Hold fraction (consecutive diff < 0.5) | 0.328 |
| Duplicate runs (1-based, second frame of pair) | 301; 325–326; 329–330; 333–334; 337–338; 340–347; 356–364 |
| Shot-boundary candidates | 25 |

The cadence is **irregular stop-motion**, not a uniform "on twos" grid, and the
reference does **not** contain an independent eased card landing. Its cards sit
on a physical spread; the motion is camera pans/pushes, hard cuts, band/line
wipes and type reveals. The clean card-level entrance is the horizontal band
reveal at **f274–f282** (15.22–15.56s).

### The measured entrance

The band opens symmetrically about y≈287 (frame center is 288), from a 9px slit
to 352px — 61.1% of frame height — and decelerates into the hold:

| Sample | Frame | Time | Height | Fraction | DNA value |
|---|---|---|---|---|---|
| 0 | 274 | 15.22s | 9px | 0.0156 | 0.0000 |
| 1 | 275 | 15.28s | 42px | 0.0729 | 0.0962 |
| 2 | 276 | 15.33s | 42px | 0.0729 | 0.0962 |
| 3 | 277 | 15.39s | 128px | 0.2222 | 0.3469 |
| 4 | 278 | 15.44s | 269px | 0.4670 | 0.7580 |
| 5 | 279 | 15.50s | 299px | 0.5191 | 0.8455 |
| 6 | 280 | 15.56s | 318px | 0.5521 | 0.9009 |
| 7 | 281 | 15.61s | 334px | 0.5799 | 0.9476 |
| 8 | 282 | 15.67s | 352px | 0.6111 | 1.0000 |

The DNA value column is normalized to the measured range (0 at f274, 1 at
f282); playback maps it onto a card that starts at `from = 0.0255` (the 9px slit
relative to the 352px final band), not at zero.

Frames 283–286 complete the wipe from 352px to the full 576px frame. That is the
wipe **finishing**, not the card landing, so it is excluded from the entrance
DNA. Fitting the full 274–286 window is worse: the best shape-valid family is
linear (RMSE 0.0871), and the lower-RMSE free bezier (0.0539) overshoots and is
rejected by the shape guard.

### The fit

The fitter searches named easing families, a fixed `outBack`, a spring and a
free cubic bezier, then ranks by BIC and rejects candidates whose curve is not
monotonic (except `outBack`/`spring`, where overshoot is the shape).

| Fit | Value |
|---|---|
| Family | cubic bezier |
| Control points | `x1=0.7368, y1=0.2366, x2=0.0, y2=0.7419` |
| RMSE on 9 samples | **0.0215** |
| BIC | −60.3 |
| Shape | monotonic; x(s) monotonic |
| Profile | `smooth` |
| Runners-up | easeInOutCubic 0.1057, linear 0.1368 |

`selftest` feeds synthetic ground-truth curves through the same fitter before
real data is trusted; all five families round-trip, and a curve with injected
holds keeps its raw samples.

The synthetic self-test is a gate, not a demo: run it before `fit` and fail the
build if any known curve is misidentified.

---

## Renderer mapping

The DNA channel is **visible height**. The clip model has a `transform.crop`
field but no keyframable crop, so a true slit reveal is not available on the
timeline. The measured height curve drives **uniform `scale.x` and `scale.y`**
instead. The band's center (y≈287) matches the frame center (288), so a centered
scale reproduces the band's centerline; the silhouette is a growing card, not a
full-width band. That difference is a renderer primitive still to add, not an
animation value to tune.

Playback (`packages/agent-runner/src/motion-dna.ts`):

- `fittedCardKeyframes` samples the fitted bezier at the 9 measured source
  instants and writes `hold` keyframes at exactly `i / 18` seconds. At 30fps
  each source step spans 1.667 render frames; the held value changes on the
  first render frame at or after the source boundary. This keeps the reference's
  stop-motion cadence instead of smoothing it away.
- `steppedCardKeyframes` plays the raw measured samples, one keyframe each. It
  is exact by construction and is kept for verification; the fitted adapter is
  the retimeable curve used for the render.
- The first source sample is a 2.6% slit, not a closed frame, so the DNA starts
  at `from = 0.0255` (the measured 9px relative to the 352px final band) and
  ends at `to = 1.0`. The renderer does not invent a fully closed frame.

The test project is 1024×576@30, 1.4s (42 frames), card 384px wide, full card
height 512px. A second export with no card is the clean plate used to measure
the card back out.

---

## Verification

Gated test:

```sh
KOVE_TEST_B2_MOTION=1 pnpm --filter @kove-advanced/agent-runner test:run \
  src/test-b2-motion.tmp.test.ts
```

Then measure the render against the clean plate and compare:

```sh
python=evaluation-files/test-b/motion/analyze_reference.py
venv=packages/python-engine/.venv/bin/python

$venv $python diffband \
  --dir evaluation-files/test-b/motion/out/render/frames \
  --plate evaluation-files/test-b/motion/out/render/plate/0001.png \
  --end 42 --fps 30

$venv $python compare
```

`compare` aligns each 18fps sample to the first 30fps render frame that has
adopted it (`ceil(i * 30 / 18) + 1`), normalizes both curves by their final
height, and scores the render **against the reference** and **against the DNA
playback curve**. The second number separates playback error from the fit's own
model error.

| Measure | RMSE | Max | Mean |
|---|---|---|---|
| Render vs DNA playback | 0.0034 | 0.0052 | 0.0030 |
| Render vs reference (end-to-end) | 0.0214 | 0.0431 | 0.0153 |
| Fit model vs measured samples | 0.0215 | 0.0472 | — |

The end-to-end error is the fit's residual, not a playback defect: the render
reproduces the curve it was given within ~0.5%, and the largest end-to-end miss
is the source's first hold (f275–276), which the parametric bezier passes
through instead of flattening. The raw-sample adapter would reproduce that hold
exactly; it is not the shipped path because it cannot be retimed.

Artifacts (gitignored, in `out/`):

- `motion-strip.png` — reference (top) vs render (bottom) at the 9 source
  samples, labelled with normalized heights.
- `motion-curves.png` — the two curves overlaid, per-sample error in the header.
- `band-strip.png` — the measured band with its detected top/bottom drawn on
  each source frame.
- `band-fit.png` — measured samples vs the fitted bezier.
- `roundtrip.json` — full per-sample report, including the DNA model column.

---

## Commands

```sh
venv=packages/python-engine/.venv/bin/python
tool=evaluation-files/test-b/motion/analyze_reference.py

# decode every frame, find holds and cut candidates
$venv $tool scan --force

# measure the band on the 8-frame entrance
$venv $tool band --start 274 --end 282

# fitter self-test, then fit -> dna/band-reveal.json
$venv $tool selftest
$venv $tool fit

# render (gated), then measure and compare
KOVE_TEST_B2_MOTION=1 pnpm --filter @kove-advanced/agent-runner test:run \
  src/test-b2-motion.tmp.test.ts
$venv $tool diffband --dir evaluation-files/test-b/motion/out/render/frames \
  --plate evaluation-files/test-b/motion/out/render/plate/0001.png --end 42 --fps 30
$venv $tool compare
```

---

## What was rejected

- **High-diff burst 115–145 (6.39–8.06s):** a flash/zoom montage, not a clean
  entrance. Not usable as a card landing.
- **Frames 283–286:** the wipe completing to full frame. Including them makes
  the fit worse and mixes two shapes.
- **Homography on 235–257 (`TEXAN`):** inliers fell to ~40% and scale bounced;
  motion blur and the non-planar magazine break the planar model. Not used.
- **Pull-back at 11.72–12.33s:** stable homography, but linear (scale
  1.0→0.909), not an entrance. Left for the camera-move DNA, not this curve.

## Next

1. Keyframable crop or rectangular mask for the true slit/shape reveal.
2. Camera-move DNA from the stable 11.72–12.33s pull-back (linear today).
3. Page wipes, speed ramps, audio, then the full cut.
4. Public release still requires confirmed Curry rights and an owned music bed.

## Copyright

The reference photos and text belong to the reference creator; this is a private
capability test. The Curry photos/videos used by the render test are third-party
material: **private capability test only** until rights are confirmed. The test
render is silent; an owned music bed is required before public release.
