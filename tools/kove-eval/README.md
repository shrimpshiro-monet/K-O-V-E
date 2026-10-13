# kove-eval

A craft scorecard. It answers one question with numbers: **how far is an edit this
pipeline generates from a professionally edited reference, and is it getting
closer?**

`docs/CRAFT_LOG.md` is the other half of this tool — the failure log. Read it before
trusting anything here, and add to it after every attempt.

```bash
export PYTHONPATH=tools/kove-eval
/home/user/.venv/bin/python -m kove_eval.cli doctor   # is the environment ready?
```

## Commands

| Command | What it does |
| --- | --- |
| `build` | Generate the golden set: 3 footage packs, 3 tracks, 5 references. Deterministic, from seeds. |
| `baseline --run-id baseline` | Score every reference and store `evaluation-files/craft/baseline.json`. |
| `score [--only ids] [--run-id ID] [--no-snap]` | Score one run. Writes `runs/<id>/scorecard.json` + a contact sheet per reference. |
| `compare --run-id ID` | Per-metric diff against the stored baseline; lists improved and regressed. |
| `beats [--track NAME BPM]` | Measure the **product's** beat detector against tracks with a known pulse. |
| `selftest` | Prove each metric separates good from bad, on fixtures that differ only in the thing being measured. |
| `analyze FILE` | Ad-hoc measurement of one video. |
| `refstills SRC` | Measure a reference given as a frame grid or a folder of stills. |
| `doctor` | Report the ffmpeg, engine and bridge this harness will actually use. |

## What it measures

Per reference, reference value versus output value, plus a distance:
shot length (EMD, median, p90, cut count), beat alignment (`on_beat_ratio_40ms`,
`median_cut_offset_ms`), colour (`delta_e_mean/p95/non_skin`, `lab_histogram_distance`),
motion (`motion_event_f1`, missing, spurious), transitions (TV distance),
captions (count error, missing, start/end timing), audio (`lufs`, `true_peak_dbfs`,
`ducking_depth_db`). Rows whose ideal is zero show `-` in the reference column —
the unit says what zero means.

A contact sheet per reference puts reference frames above output frames at the same
timestamps. **Look at it.** Three of the first five defects found here were first
seen by eye and only afterwards turned into measurements.

## Provenance — read before quoting a number

Every scorecard carries a `provenance` block, because two substitutions were made
and both matter:

1. **The LLM director is replaced by a deterministic planner.** The director needs
   an API key this environment does not have. The harness consumes an `EditPlan` —
   the director's output type — so swapping the director in changes no measurement.
   A neutral planner is also the better baseline: a baseline that scored badly
   because a feature was off would make every later delta meaningless.
2. **The browser renderer is replaced by a Python compositor.** The product renders
   in the browser (WebGPU/WebCodecs + mediabunny) and no browser is available here.
   Rendered-versus-planned checks measure what *this* renderer produced.

Beat snapping is **not** substituted: `snapPlanToBeatGrid` — the shipped algorithm —
runs through the vitest bridge, and the shipped 40 ms tolerance is read from the
same module so the two cannot drift apart.

**Consequence:** a craft gap visible here is a real gap in a real render. The
reverse does not hold — a gap that only the browser renderer has will be invisible.

The references are synthetic, generated from seeds. That buys exact ground truth and
costs realism: no faces, no grain, no motion blur, no compression history. These
fixtures validate the *instrument*; only real reference footage can validate the
*result*.

## Adding a metric

Only if it can separate good from bad. Write the fixture pair first — two clips
differing only in the property the metric claims to measure — add it to
`sensitivity()`, and record the outcome in the craft log. If it cannot separate,
say so there and **do not ship a gate**. Two motion metrics are in exactly that
state right now; see F-numbers in the log.

## Golden set

5 references across style families (`pulse-fast`, `cinematic-slow`, `doc-natural`,
`social-vertical`, `text-forward`), 3 packs, 3 tracks. Media is generated
(~100 MB) and gitignored; `golden-set.json` and the `groundtruth.json` files are
committed, because they record what each fixture was constructed to contain.

Ground truth is checked, not assumed: `selftest` measures the construction back.
That is how F5 was found — a sub-shot shorter than a requested shot put a real cut
inside a shot, so the reference did not contain the structure its own ground truth
claimed, and every shot-length metric was being measured against a lie.

## Environment limits

- **No browser, no Playwright download, no npm binary hosts.** `ffmpeg-static`
  cannot be installed; `pip install imageio-ffmpeg` ships a static ffmpeg 7.0.2
  inside the wheel, which is allowed. `kove_eval.ffmpeg` prefers `KOVE_FFMPEG`,
  then `PATH`, then the wheel.
- The bridge runs through `packages/creation-schema/vitest.craft.config.ts`, so the
  workspace needs `pnpm install` to have run.
- `kove_engine.beat_grid.extract_audio_track` shells out to a bare `ffmpeg`;
  `ensure_tools_on_path()` links one onto `PATH` for it. Without that, the engine
  logs one warning, reports "no beat grid", and every rhythm metric quietly reads
  `None` — a missing tool looks exactly like a track with no pulse.
