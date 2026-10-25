# Rendered watchability evaluation

The baseline report checks plan and timeline correctness. This companion
evaluation exports selected passing cases through the same browser-based
`ExportEngine` used by K.O.V.E., including timeline effects, transitions, text,
and audio. It does not change the running baseline campaign.

## Run

After a baseline report is complete:

```bash
pnpm --filter @kove-advanced/agent-runner wow-eval
```

To review one settled case while the baseline campaign is still running:

```bash
pnpm --filter @kove-advanced/agent-runner wow-eval \
  --case game-01/game-01-detailed --run 0
```

By default, the runner renders every case with passing core timeline gates,
extracts chronological review frames from the rendered MP4 and a category-matched
reference, and sends those stills plus the prompt to the configured OmniRoute
vision model. `game` uses the Spider-Man reference, `sport` uses Steph Curry,
and other categories use Captain Price. A model score of 8.5/10 or higher with
no dimension below 7/10 passes the visual *screening* bar; it is not an
acceptance verdict.

For an entirely local render without sending frames to a model:

```bash
pnpm --filter @kove-advanced/agent-runner wow-eval \
  --case game-01/game-01-detailed --run 0 --skip-vision
```

The optional `--report`, `--out`, and `--max-dimension` flags override the
baseline report, output directory, and render edge (64-1920px). `ffmpeg`,
`ffprobe`, and Playwright Chromium must be available.

## Human confirmation

Each output directory contains `candidate.mp4`, `wow-report.json`, extracted
review frames, and `index.html`. Open the review page, watch the candidate and
reference with sound, then download the human verdict. The vision screen judges
visual story, selection, pacing, composition, coherence, editing craft,
typography, and impact from stills; it deliberately does **not** claim to hear
the music, dialogue, or mix. A candidate is not "amazing" until a human confirms
it.

Generated renders and review bundles live under `evaluation-files/wow-reviews/`
and are gitignored. Reference and source media remain local; when vision
scoring is enabled, the prompt, category, and sampled JPEG frames are sent to
OmniRoute, not the full videos.

Each run creates a new `candidate.mp4` and refuses to overwrite an existing
candidate. Choose a fresh `--out` directory when rerunning a case.
