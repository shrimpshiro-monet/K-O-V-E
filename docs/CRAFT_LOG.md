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

## Baseline

_Recorded once the golden set finishes building. The rule for every later step is
that its scorecard delta is written here before the next step starts._
