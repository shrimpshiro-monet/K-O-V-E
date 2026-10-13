# Craft log

What was tried, what the score was before and after, what the contact sheet showed,
and what failed or surprised. The point of this file is that the next session does
not repeat a mistake it cannot see.

Rules this log is held to:

- Every number is a measurement. Where something is an **observation** — a human
  looking at frames — it says so and names the measurement that would confirm it.
- Negative results are recorded as loudly as positive ones. A metric that cannot
  separate good from bad is written down as such and does not get a gate.
- Nothing here is a claim about the product's browser renderer unless it was
  actually run through it. It has not been (no browser in this environment).

---

## Step 0 — the scorecard (in progress)

### What exists now

`tools/kove-eval` — a Python package with a CLI (`kove-eval`) that:

1. **Builds a golden set**: 3 footage packs, 3 tracks, 5 references across style
   families (`build`, `goldens.py`).
2. **Plans and snaps**: measures a reference with the engine's own analyzers
   (`kove_engine.analyzers.scene_detector`, `kove_engine.beat_grid`), builds an
   `EditPlan`, and runs the **production** beat snapper over it through a vitest
   bridge — not a reimplementation (`pipeline.py`, `bridge.py`).
3. **Renders**: composes the plan to an mp4 with real ffmpeg, including camera
   moves, grade, captions, transitions and a mixed audio track (`compositor.py`).
4. **Re-analyzes the export** with the same analyzers and compares to the
   reference (`scorecard.py`), writing `scorecard.json` plus a contact sheet per
   reference (`contact_sheet.py`).
5. **Proves the metrics work** (`selftest`): each metric is applied to a fixture
   pair that differs only in the property the metric claims to measure.

### Deliberate deviations from the spec, and why

| Spec | What was built | Why |
| --- | --- | --- |
| "runs the real director" | The director needs an LLM API key this environment does not have. The harness takes an `EditPlan`, which is the director's output type, and `plan_from_style` produces one deterministically. | The director is swappable without touching a single measurement. A neutral planner is also the *better* baseline: a baseline that showed a gap because a feature was switched off would make the later deltas meaningless. |
| "renders through the real engine headless" | The product renderer is the browser compositor (WebGPU/WebCodecs + mediabunny). There is no browser here and Playwright's download is outside the network allowlist (`docs/AGENT-RENDER.md` already says so). Output is rendered by `kove-eval`'s Python compositor from the same `EditPlan`. | Something has to rasterise frames. Every scorecard carries a `provenance` block stating this, and "rendered vs planned" checks measure what *this* renderer produced. |
| "reference video + raw footage + music" | The references are synthesised by the same compositor. | Real footage cannot be fetched from here, and a real reference film is not something to vendor into a repo. See "The synthetic-fixture limitation" below — it is the single biggest caveat on every number in this file. |

### The synthetic-fixture limitation (read before quoting a number)

The 5 references are procedurally generated. That buys control: cut times are on a
known beat grid, the grade is a known Lab offset, motion events have known
magnitudes, captions have known windows, and `selftest` can check the analysers
recover the construction. It costs realism: no faces, no grain, no motion blur, no
compression history.

**A metric that separates good from bad on these fixtures has not been shown to
separate them on a real shoot.** The fixtures validate the *instrument*; only real
reference material can validate the *result*.

### Real reference material — observed, not yet measured

Three frame grids from a real reference edit were supplied. They are visible in the
conversation but **were not written to disk** (`/home/user/uploads/` does not
exist), so nothing below is a measurement. Each item names the measurement that
would turn it into one. Treated strictly as hypotheses to test.

| # | Observation from the frames | Measurement that would confirm it | Harness support |
| --- | --- | --- | --- |
| R1 | Captions sit in the **upper third**, roughly y≈0.25, white sans-serif, persistent across several shots | `refstills` text-band energies: `upper` count ≫ `lower` count | Ready (`refstills.py`) |
| R2 | **Split-screen comparisons** — two subjects side by side in one frame | `classify_layout` → `split-horizontal` on those frames | Ready |
| R3 | Heavy **teal-and-orange grade with crushed blacks** — large fraction of pixels below L≈20 | `lab.fraction_L_under_20` compared against the output's | Ready |
| R4 | **Title cards** with custom display typography (a graffiti-style name over a dark frame) | Needs a text-presence signal plus a style match; closest current proxy is band energy + `layout` | Partial |
| R5 | Frames that appear to be **motion-blurred / double-exposed** — a transition or effect, not a cut | Needs inter-frame analysis; stills cannot distinguish a blur effect from motion blur in the source | **Needs the video** |
| R6 | Pacing looks fast (roughly 0.5–1.5 s per shot) | Needs the frame interval; stills alone give no timing | **Needs the interval or the video** |
| R7 | Platform watermark (a TikTok handle) burned into every frame | Should be *excluded* from craft scoring — it is a platform artefact, not an editorial choice | Policy note, not a metric |

**The gap this exposes immediately:** R1 is a caption position the pipeline can
render (`position: "top"`) but no preset uses, and R2 is a layout vocabulary the
product **does** compile (`resolveLayoutTransform` in `packages/agent/src/registry.ts:2310`)
while `kove-eval`'s renderer **cannot render at all** (`grep -c split compositor.py` → 0).
Any plan using split layouts is therefore scored unfairly by this harness today.
That is a defect in the instrument, logged here so it is not mistaken for a product
defect.

To convert the table into numbers, either re-attach the frame grids as files, or
supply the reference video. `kove-eval refstills <grid.png|frames-dir/>` measures a
grid; a folder of stills is the reliable input.

---

## Failures and surprises

### F1 — `ffmpeg-static` cannot be installed; the wheel works instead

`npm i ffmpeg-static` fails: its postinstall downloads the binary from
`release-assets.githubusercontent.com`, outside the network allowlist. `docs/AGENT-RENDER.md`
had already recorded that this sandbox cannot run the browser renderer; this is the
same class of problem for the video tooling.

**Resolution:** `pip install imageio-ffmpeg` ships a **static ffmpeg 7.0.2** inside
the wheel from PyPI, which is allowed. Verified `ebur128`, `loudnorm` filters
present. `kove_eval.ffmpeg` prefers `KOVE_FFMPEG`, then `PATH`, then the wheel, so a
developer machine uses the system one.

**Consequence to remember:** every "measured with ffmpeg" claim in this repo's craft
work is ffmpeg 7.0.2 static, not the system build the product uses.

### F2 — the real renderer is unreachable, so the harness ships its own

No browser, no Playwright download. The harness therefore measures *plan + Python
renderer*. The honest consequence, stated in every scorecard: **a craft gap visible
in this harness's output is a real gap in a real render, but the reverse does not
follow** — a gap that the browser renderer has would be invisible here if the Python
renderer does not share it. Recorded because it is the assumption most likely to be
forgotten when reading a scorecard in six months.

### F3 — `vite-node` module loading does not work from a script; a vitest config does

Goal: call the **production** `snapPlanToBeatGrid` from Python, rather than
reimplementing beat snapping (which would measure a different algorithm than the one
that ships).

- `node --experimental-strip-types`: works for a trivial file, fails on the real
  module — extensionless relative imports (`./edit-plan`) are not resolvable by
  Node's ESM loader.
- `import { createServer } from "vite-node/dist/server.mjs"`: that entry does not
  export `createServer` (it exports `ViteNodeServer`).
- A vitest config **inside `tools/kove-eval`**: fails, `vitest/config` is not
  resolvable from outside a package that depends on vitest.
- **What works:** `packages/creation-schema/vitest.craft.config.ts`, whose `root` is
  the repository root, running `tools/kove-eval/bridge/beat-snap.test.ts`. The
  bridge reads a JSON job from `KOVE_CRAFT_JOB` and writes the answer to
  `KOVE_CRAFT_OUT`.

**Consequence:** the harness depends on `pnpm install` having run in the workspace,
because it shells out to that package's vitest. `kove-eval doctor` reports the
binary it found.

### F4 — contact-sheet grid splitting is genuinely ambiguous, and that is not fixable by a better heuristic

Three approaches were tried on a grid of frames cut from one video, and all three
failed in instructive ways:

| Approach | Result |
| --- | --- |
| Gutter detection (uniform rows/columns) | Works only when the sheet has gutters. Edge-to-edge grids — the common case — have none. |
| Peak-spacing / autocorrelation on the row-averaged profile | Predicted a period of 240 for a 480px grid: one hard cut *inside* a tile contributes as strongly as a tile seam and flattens the correlation. |
| Percentile thresholding of local maxima | At the 96th percentile, 5% of a 1920px profile is 96 candidates; most were content edges, not seams. |
| Differencing the row-*averaged* profile | Scored the true boundaries **below the median seam energy**, i.e. anti-correlated with the truth. |
| **Adjacent-line difference averaged over the other axis** (kept) | Correctly separates a seam (differs on every row) from an edge (differs on some rows). |

Final method: seam energy + a lattice-coverage score (what fraction of the *expected*
internal seams actually show a peak) — this correctly rejects submultiples of the
true tile size, which a count-based score does not.

**Remaining limitation, honestly:** when adjacent tiles are near-identical frames
(consecutive frames of one shot), the tile count is genuinely ambiguous — a real
boundary and an ordinary transition look the same. The splitter returns the coarser
grid in that case. A **folder of frames is the reliable input**; a grid image is
best-effort and the profile says which was used. This cost significant time and the
lesson is: do not try to make grid splitting robust, make the folder path easy.

### F5 — a synthetic reference can contain cuts the reference did not intend

The first packs used 4.0 s sub-shots while `cinematic-slow` asks for 12-beat takes
(7.2 s at 100 BPM). A shot longer than its sub-shot must span two sub-shots, and the
boundary between them is a real content change, so the scene detector reports a cut
**inside** a shot. The reference would then not have the structure its own ground
truth claims, and every shot-length metric would be measured against a lie.

**Resolution:** sub-shots are now 8.0 s (`SUB_SHOT_SECONDS`), longer than the longest
shot any family requests, and a long shot is placed so it stays inside one look.

**Lesson worth keeping:** when a fixture's ground truth is *constructed*, check the
construction is reachable before believing any measurement of it.

### F6 — a reference family claiming "no captions" crashed the build

`caption_density: 0.0` → `int(round(1 / 0))` → `ZeroDivisionError`, which took down
the entire golden-set build before writing a single reference. The smoke test had
only exercised the one family with captions, so it passed.

**Lesson:** build the *whole* set in a smoke test, not one member. A fixture builder
that fails on a valid input has not been tested.

### F7 — the Python compositor cannot render layouts the product can

`EditPlanLayout` offers `split-left`/`split-right`/`split-top`/`split-bottom`/`pip-corner`,
and the agent compiles them (`packages/agent/src/registry.ts:2310`, via
`resolveLayoutTransform`). `kove-eval`'s compositor has no layout support at all
(`grep -c split` → 0). Any plan using a split or PiP therefore renders as a plain
fullscreen clip in the harness, and the scorecard would report a caption/colour/motion
difference that is really an unrendered layout.

**Status:** open. Listed as an instrument defect, not a product defect. Until it is
fixed, plans from references that use split layouts (R2 above) cannot be scored
fairly, and the scorecard's provenance block should be read with that in mind.

---

### F8 — the scorecard read the engine's shot contract backwards (found by looking, not by testing)

`SceneDetector.detect` returns **`(start_time, duration)`** — its docstring says so.
The harness read the second element as an **end time**, computing `end - start`.
On the first reference that produced:

```
shot_length_median_beats: ref -26.923 vs out -27.356
```

A *negative* median shot length, printed without complaint.

Why it survived: every intermediate number looked plausible. Spans summed to
something, quartiles were computed, nothing raised. The only reason it was caught
is that the contact sheet prints its caption line and `-26.9 beats` is obviously
absurd to a human. `python -m pytest` on 13 new unit tests did not exist yet, and
no assertion anywhere stated the contract.

**Fixed:** `metrics.spans_as_ranges()` is now the single conversion point from the
engine's `(start, duration)` to `(start, end)`; `shot_lengths()` reads the duration
directly and cannot go negative (`max(0.0, duration)`). `tests/test_metrics.py`
pins the contract — including an assertion against the engine's own docstring, so a
future change to `detect()` fails a test instead of silently corrupting the
scorecard.

**Lesson:** an instrument needs its own tests. The first version of this harness
had none, on the theory that the scorecard *is* a test. It is not: a test asserts a
contract, and this harness had contracts it never wrote down.

### F9 — the beat tracker's tempo bias makes the on-beat metric measure the tracker, not the edit

The reference tracks are click-accurate by construction (`pulse-140` is 140 BPM,
kick exactly on the beat). The engine's beat tracker reports:

| Track | Constructed | Tracked | Error |
| --- | --- | --- | --- |
| `pulse-140` | 140.00 BPM | 144.23 BPM | **+3.0%** |

At 140 BPM the true beat is 428.6 ms and the tracked one is 416.0 ms. Over a 24 s
reference that is a phase drift of well over 100 ms — three times the 40 ms
tolerance. The first scorecard therefore reported `on_beat_ratio_40ms: ref 0.000`
for a reference that is on the beat *by definition*.

**This is a metric-definition problem, not a tracker-quality complaint.** Two
things follow, and both are now open work rather than silent fudges:

1. Comparing an output's absolute cut times against a *mis-measured* grid fails a
   correct edit. The fix is to compare **relative phase**: the reference's own cuts
   against the tracked grid give the reference's phase error, and the output is
   judged against that same grid. Both sides then share the tracker's bias and it
   cancels. That is how the metric should be defined and it is not yet.
2. A 3% tempo error also breaks beat *snapping* itself, since the snap targets a
   grid that is drifting 3% off the music. Worth investigating separately — it may
   be the single largest source of unquantified error in the whole pipeline.

Do not "fix" this by loosening the tolerance. A loose tolerance makes the metric
unable to distinguish a beat-locked edit from a random one, which is the exact
failure the original 0.2 s tolerance had (§16.4 item 1).

### First contact sheet: reference vs pipeline output (`pulse-fast`)

Looked at directly. Reference frames on top, output underneath, same timestamps.
What is visibly off, with the measurement that confirms each:

| # | Visible in the sheet | Measurement |
| --- | --- | --- |
| V1 | **Colour is nowhere near.** The reference is warm and saturated (punchy greens, city dusk with a blue sky); the output is washed-out grey-pink on every frame. | `color_delta_e_mean` **29.5** (≈30× the threshold of noticing); visible on every tile |
| V2 | **The output has no captions at all** where the reference shows "cut on the beat", "colour settles", "closer now". | `caption_missing` = 3 in the sheet region; the pipeline plans none because the baseline deliberately omits captions |
| V3 | **The wrong material is on screen.** The reference is canopy at 3 s and 5 s; the output shows the portrait. Shot-for-shot the output is picking different packs. | not yet measurable — needs a per-timestamp "which source is showing" metric |
| V4 | **Framing differs**: output city frames carry a large black band across the bottom third that the reference's city frames do not. | would show up in a per-shot L-histogram comparison; not currently isolated |
| V5 | **Motion reads differently** — the reference's punch-ins are visible as a scale change between neighbouring canopy tiles; the output's static portrait tiles sit at one scale. | `motion_event_f1` (sheet header) — output detects no events where the reference has 17 |

V1, V2 and V5 are exactly steps 2, 5 and 3 of the work plan, so the ordering is
confirmed by observation rather than assumed. V3 and V4 are new: they are *planner*
problems (which footage, how it is framed), not effect problems, and neither has a
metric yet. Recorded so they are not lost.

### F10 — every loudness number was ebur128's silence floor (and the check that "proved" it worked could not fail)

ffmpeg's `ebur128` filter emits a progress line every 100 ms, and the line at
`t: 0` reports `I: -70.0 LUFS` — its floor, because no audio has been measured yet.
`re.search` takes the **first** match, so every file scored exactly −70.0:

```
lufs   ref -70.0000   out -70.0000   distance 0.0000
```

Reference and output "agreed" perfectly, on the floor value, for all five
references. The real measurement is at the end of the output, in the summary block:

```
I: -16.2 LUFS        LRA: 0.0 LU        Peak: -0.1 dBFS
```

**Fixed:** take the *last* match. Output and reference now differ meaningfully
(pulse-fast: reference −16.2 LUFS / −0.1 dBFS, output −16.7 / −0.5).

**And the check that was supposed to catch this could not fail.** It rendered a
"quiet" fixture that varied only a *colour grade* — the audio was byte-identical —
then asserted `loud_lufs is not None and quiet_lufs is not None`. Two identical
inputs passed. It is now a real perturbation: −12 dB on the music bed, with the
response required to land in 8–16 LU, because a check that cannot fail is not
evidence.

### F11 — the beat detector's `bpm` disagrees with its own beats by 3%, and the grid's phase is ~200 ms off

Two separate defects, both found by measuring the tracker against a track whose
pulse is known exactly.

**The track.** `synth_track` puts a kick at exact multiples of `60/bpm` from 0.000
(`pulse-140`: period 0.428571 s), plus a hi-hat at the half-beat.

**Defect 1 — `bpm` is not derived from `beats`.** For that track the tracker
returns 62 beats spanning 0.672 → 26.816 s. Mean interval **0.428590 s =
139.994 BPM** against a constructed 140.000 — the *positions are right*. But
`BeatGrid.bpm` reports **144.231**, because it comes from librosa's independent
tempo estimate rather than from the beats it returns. The interval histogram
explains the gap: intervals alternate 0.416 / 0.448 s around the true 0.4286,
quantised to the analysis hop (512/22050 ≈ 23.2 ms); the *median* is 0.416 and
the *mean* is 0.4286. Anything that reads `bpm` — or takes the median interval —
inherits a 3% tempo error, i.e. a grid that drifts ~0.75 s over a 24 s edit.

**Defect 2 — the phase is wrong.** Against the same track:

| Grid | Offset from the true kicks |
| --- | --- |
| Tracked beat positions | ~243 ms |
| Mean-fit lattice through those beats | ~243 ms |

Both the tracked positions and a lattice fitted through them sit about a quarter
of a second off the actual kicks, so it is a phase error, not drift. On a
synthetic click track with a perfectly regular pulse that is the worst case to be
wrong in: real music will not be better.

**Consequence for the baseline, and why the metric is right to report it.**
`on_beat_ratio_40ms` reads **0.0000 for the reference** and **0.5556 for the
output** on `pulse-fast`. That looks backwards until you read it correctly: the
output is snapped to *the product's grid*, so it agrees with the product's grid by
construction; the reference is cut on the *true* beat. The scorecard is telling the
truth — the product's grid is about 200 ms away from the music, and the output is
faithfully locked to the wrong grid. `median_cut_offset_ms` shows it plainly:

```
median_cut_offset_ms   ref 196.0   out -8.0   distance 204.0
```

**This is step 1's work and it is now the single biggest measured craft defect.**
The metric is not changed to make the number look better; it is defined as
"agreement with the grid the product actually snaps to", which is the thing that
has to become correct.

**Which tracker matters.** The product does not use the Python tracker: it has its
own detector in `packages/core/src/audio/beat-detection-engine.ts`, which fits a
phase over one beat period and walks a fixed lattice — a better design than
median-interval snapping, and not yet measured. `beat-snap.ts:174` and
`reference-beats.ts:71` both take the **median** interval from beat times, which is
the biased estimator from defect 1. The next measurement is the product's own
detector against these ground-truth tracks through the bridge, before any of it is
rewritten.

### F12 — the product's own beat detector is accurate, but locks to half tempo on a 140 BPM track

`beat-snap.ts` takes its beats from the analysis, so "which tracker" is not a
detail. The scorecard's numbers come from the Python engine's librosa tracker
(F11: ~243 ms phase error). The product uses `BeatDetectionEngine`
(`packages/core/src/audio/beat-detection-engine.ts`), which until now had never
been measured against a pulse that is known exactly. The bridge grew a
`detect-beats` op that runs the real class over a wav and reports its beats,
intervals, and offset from constructed truth:

| track | true BPM | detected BPM | median offset from the true kick | beats within 40 ms | confidence |
| --- | --- | --- | --- | --- | --- |
| `pulse-140` | 140.000 | **69.824** | −6.9 ms | 0.971 | **0.096** |
| `driving-120` | 120.000 | 120.000 | −8.4 ms | 0.961 | 0.940 |
| `warm-100` | 100.000 | 101.695 | −6.4 ms | 0.976 | 0.920 |

**The good news is large and was not previously known:** phase error is under
10 ms and ≥96% of beats land on the true kick. That is a genuinely good detector,
and it means the 243 ms error in F11 is the *librosa* path, not the product's.

**The defect:** on `pulse-140` it reports 69.8 BPM — half tempo — at confidence
0.096. The 140 BPM period is 0.4286 s; at half tempo it is 0.857 s, so every
second kick is treated as a beat. Cuts snapped to that grid still land *on* kicks
(which is why `on-true-beat` stays 0.97) but at **half the density**, and the
"fast beat-locked cutting" style is precisely the one that asks for a cut per
beat. The engine's own comment already names the hazard — half/double tempo are
equally correlated — and the confidence collapsing to 0.096 is the signal that a
fallback should have fired.

**This is step 1's work**, and it has an unusually clean shape: the phase is fine,
the octave is not, and the confidence already knows.

### Where the baseline stands, and what it is still missing

The first baseline was recorded and then discarded: its loudness numbers were the
silence floor (F10) and its LUFS check could not fail. The instrument was fixed
before the baseline that counts, which is the correct order — a baseline measured
by a broken instrument would have every later delta measured against a bug.

What the scorecard now shows, reference versus output, across the five references:

- **Colour is the largest single gap.** ΔE mean 21–35 on every reference — 20 to 35
  times the threshold of noticing. The output has no grade at all.
- **Motion events are almost entirely absent.** `motion_event_f1` 0.00–0.33 against
  a reference of 1.00, with 13–39 events missing and 11–43 spurious.
- **Ducking is absent**: reference 5.3–10.9 dB, output ≈ 0 dB (and slightly
  negative twice, which is measurement noise around no ducking at all).
- **Captions are wrong in count and timing**: up to 8 too many or 2 missing, start
  errors 100–700 ms, end errors up to 2200 ms.
- **Cut counts are off by 1–10** and shot lengths are consistently short
  (e.g. 2.02 → 1.78 beats; 7.89 → 6.25), which is the half-tempo and grid-phase
  problem showing up structurally.
- **`shot_length_emd_beats` reads `output 0.0000` on all five.** A
  reference-versus-output EMD of exactly zero for five different pairs is not
  credible; it is a defect in how the row is populated, and it is on the list.

Two sensitivity checks **fail**, and per the mission's rule that means no gate:
`motion_events` (a 0.18 punch-in produces no additional event; the detector reports
`['pull-out', 'punch-out', 'pull-out', 'punch-out']` — it is misreading shot
boundaries as motion) and `motion_event_magnitude` (0.3337 for both a 0.06 and a
0.30 punch). **The motion metric cannot currently separate good from bad, so step 3
cannot start until the metric itself is fixed.** That is a finding, not a delay.

### F13 — the renderer loudness-normalises, so the loudness gate has to be measured on the file

The repaired LUFS check then failed, correctly: −12 dB of music gain produced
0.20 LU of movement. The cause is not the metric — the renderer normalises its mix,
and every output in the baseline reads **exactly −16.7 LUFS** while the references
range −15.8 to −17.5. A gain change upstream is simply undone downstream.

That is right for a product and wrong for an experiment about a metric. The check
now applies its gain to the **decoded audio** instead of the renderer, which asks
only the question the scorecard depends on — does ebur128 read 12 dB as 12 LU — and
it answers **12.00 LU**. It separates.

**A finding that falls out of it, for step 6:** because the renderer normalises,
output loudness is already within ~0.9 LU of every reference without any per-project
work. The loudness half of step 6 may already be satisfied; the ducking half
definitely is not (reference 5.3–10.9 dB, output ≈ 0).

### Second contact sheet (`cinematic-slow`) — looked at directly

| # | Visible in the sheet | Measurement |
| --- | --- | --- |
| V6 | **The material is shuffled relative to the reference.** At 18.7 s and 20.9 s the reference shows canopy and the output shows the skyline; at 25.3 s it is the other way round. The two edits contain the same shots but not in the same order or at the same times. | no metric yet — needs a per-timestamp source-match score |
| V7 | **Colour is washed out and hue-shifted, and not uniformly.** The reference's night skyline is deep navy with a near-black silhouette; the output's is mid-daylight blue. The reference's portrait backgrounds are mauve at 9.9–14.3 s and near-black at 16.5 s; the output's are pink-olive and olive. | `color_delta_e_mean` 26.0; visible per tile |
| V8 | **The reference's darkest shot has no counterpart.** At 16.5 s the reference is a near-black vignette with the subject lit; the output is a flat olive frame at normal exposure. | would appear in a per-shot L-histogram comparison |
| V9 | **The output cuts more often than the reference at this pacing** — 9 cuts to 7, and the sheet's later tiles drift out of phase with the reference's shots. | `shot_length_median_beats` 7.895 → 6.250 |
| V10 | Contact-sheet header prints `ref ???` for rows whose ideal is zero (ΔE and friends). It is the `_error_row` convention showing through and reads as a missing value; the header should say `target 0` instead. | cosmetic, but it made the first read of this sheet slower than it needed to be |

V6 is the most important thing on this sheet and it is currently **unmeasurable**,
which puts it in the same class as V3 from the first sheet. Two contact sheets,
two sightings of the same defect, no metric for it. That makes "which source is on
screen at time t" a prerequisite for evaluating the planner at all, ahead of several
items that already have metrics.

### F14 — the tile splitter was silently wrong three ways, and the tests found all three

`refstills` existed but had no tests, which is how a splitter that returned one
whole sheet as "one frame of aspect 3.556" shipped. Writing the tests found three
separate defects, each of which produced plausible output rather than an error:

1. **An off-by-one on the seam index.** `_seam_energy` is a `diff`, so the seam
   between tile k-1 and tile k is at `k*extent/tiles - 1`. Sampling at
   `k*extent/tiles` reads the first step *inside* the next tile — an ordinary line.
   Every ratio collapsed to ≈1.0, so **no grid ever split**, and the "no split
   found" path returned the sheet whole with no complaint.
2. **The wrong statistic.** With the index fixed, a count-based score and then a
   *median* boundary ratio both failed. The median is not just weak here, it
   genuinely overlaps: on a 4-tile grid only two of three seams were strong (1.56,
   1.67, 17.6 → median 1.67), while a single frame split three ways scored **1.70**
   by landing one boundary on a shape edge. 1.67 against a false positive of 1.70
   is not a margin. The *minimum* boundary ratio does not overlap, because a false
   positive would need every boundary to land on real structure.
3. **Gutter detection rejected the case it exists for.** It required a flat line
   *and* a level near the sheet's median level, so a black gutter between bright
   tiles (level 0 against a content median of 130) was rejected. Flatness alone
   carries the decision: content lines are almost never flat over their full length.

The threshold was then **placed by measurement** rather than taste — both
distributions over 8 generated layouts and single frames:

| | weakest / worst | typical |
| --- | --- | --- |
| genuine grid axis | 1.59 | median 17.62 |
| single frame | **max 1.22** | median 1.02 |

`SEAM_RATIO_THRESHOLD = 1.4` sits in that gap, 0.18 clear of the worst false
positive and 0.19 below the weakest true seam. A floor of 64px per tile closes the
one remaining hole (a 120px image split three ways scored 1.70 on shape edges
alone), since a 40-pixel "tile" is a fragment, not a frame.

**Result: 48/48 generated grids split correctly, single frames stay whole, and 33
tests pass.** Two limits are real and now pinned by tests rather than hidden: a
seam thicker than ~0.4% of the frame is not seen as a seam, and adjacent frames
that are near-identical genuinely cannot be separated by content. A folder of
frames remains the reliable input; a grid image is best-effort and the profile says
which was used.

**The lesson is the same one F8 taught, one layer down:** the first version of this
file had no test, because it looked like a utility rather than a measurement. It is
a measurement, and its failures were silent and plausible in exactly the way a
scorecard's must not be.

## Baseline

`evaluation-files/craft/baseline.json`, run `baseline`, recorded 2026-10-13 15:25:35
UTC. Five references, eight sensitivity checks, two of them failing.

| reference | shot len (ref→out) | cuts | on-beat (ref→out) | cut offset ms | ΔE | motion F1 | caption err |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pulse-fast | 2.02 → 1.78 | 39 → 38 | 0.00 → 0.56 | 196 → −8 | 30.9 | 1.00 → 0.33 | 8 |
| cinematic-slow | 7.89 → 6.25 | 7 → 9 | 0.33 → 0.57 | 256 → −8 | 26.0 | 1.00 → 0.33 | 1 |
| doc-natural | 5.21 → 4.25 | 10 → 13 | 0.11 → 0.00 | 184 → 192 | 21.3 | 1.00 → 0.24 | 2 |
| social-vertical | 0.96 → 1.06 | 60 → 50 | 0.00 → 0.48 | 192 → −4 | 35.1 | 1.00 → 0.00 | 5 |
| text-forward | 2.50 → 2.00 | 20 → 21 | 0.05 → 0.11 | 136 → −96 | 31.5 | 1.00 → 0.07 | 3 |

Also measured: `lufs` reference −15.8…−17.5 against output −16.7 everywhere (the
renderer normalises, F13); `true_peak_dbfs` −0.1…−0.4 → −0.5;
`lab_histogram_distance` 0.083–0.148; `transition_mix_tv_distance` 0.026 on
`pulse-fast` and 0.000 on the other four; `caption_missing` 0–2 with end errors up
to 2200 ms; `ducking_depth_db` 5.3–10.9 → ≈0 (F13).

**Read the on-beat column knowing what F11 established:** the scorecard's grid comes
from the Python tracker, which is 179–264 ms out of phase with the actual music. The
reference scores *lower* than the output because the reference is cut on the true
beat and the output is snapped to the product's grid. The number is measuring the
gap correctly; it just needs reading in that direction.

### What has to be true before each step can start

The mission's rule is to stop a step when it stops moving the score, and not to ship
a gate that cannot separate. Two of the eight sensitivity checks fail, which rules
out one step until the metric is repaired:

| Step | Ready? |
| --- | --- |
| 1. rhythm on the rendered output | yes — and it is the largest measured defect (F11, F12) |
| 2. colour | yes — `color_delta_e_mean` separates (12.74 vs 0) and the gap is 21–35 ΔE |
| 3. motion | **no** — both motion checks fail. A punch-in produces no event and magnitude does not scale. Fix the metric first; do not ship a motion gate |
| 4. transitions and effects | yes — `transition_mix_tv_distance` separates, though four of five references are already 0.000 |
| 5. captions | yes — `caption_windows` separates (3 vs 2) |
| 6. audio | partially — `lufs` separates and is already within ~0.9 LU; `ducking_depth_db` separates (9.868 vs −0.065) and the gap is the whole 5–11 dB |
| 7. StyleProfile 2.0 | grows from the above |

### Known instrument gaps, restated so they are not mistaken for product gaps

- The compositor **cannot render split/PiP layouts** the product compiles (F7), so a
  plan using them scores unfairly. Not yet triggered by a golden reference.
- **"Which source is on screen at time t" has no metric** (V3, V6) — two contact
  sheets have now shown material in the wrong place, and nothing measures it. This
  is a prerequisite for judging the planner at all.
- The renderer is the Python compositor, not the browser one (F2).
