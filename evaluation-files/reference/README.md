# Reference-analysis benchmark

This corpus has two different jobs:

1. The synthetic H.264 fixture is a deterministic integration test for the
   **real browser decoder and EditDNA extractor**. Its three flat-color shots
   have known cuts at frames 30 and 60.
2. The supplied real-world reference videos are candidates for a future
   accuracy benchmark. They do not have independent human annotations yet, so
   they must not be used to claim real-world accuracy.

`known-cut-corpus.json` records source SHA-256 hashes, media clocks and label
status. Keep reference labels tied to the exact source hash; never silently
reuse labels after replacing a media file. The two existing
`real-*-profile.json` files are analyzer outputs, **not ground truth**. Their
comparison against themselves only checks metric invariants.

## Run the known-cut browser test

With a local Chrome installed:

```bash
KOVE_E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm --filter @kove-advanced/web exec playwright test e2e/reference-analysis.spec.ts
```

Or install Playwright's Chromium and omit `KOVE_E2E_CHROMIUM`. The test checks
the fixture hash, decodes the MP4 in Chromium, runs `extractReference`, and
requires exact recovery of both cut frames plus high-confidence hard-cut
evidence. It does not mock the decoder or pixel analysis. The known-cut test
passed in local Chrome; this validates the synthetic path only, not accuracy
on edited footage.

## Promote real references to ground truth

The candidate source paths and hashes are already listed in the corpus. Before
scoring either candidate:

1. Confirm which exact source file produced the saved profile. A matching
   resolution or filename is not enough; the profile files predate source
   hashing. The Captain Price candidate is especially not clock-identical:
   its saved profile has 615 frames at 30 fps, while the current source
   container reports 605 video frames and 20.486654 seconds.
2. Have a human annotator label every hard cut by scrubbing the exact source
   frame-by-frame. Record cut frame numbers on the profile's stated rational
   clock, plus text-overlay start/end frames and normalized bounding boxes.
   For camera motion, use synthetic transforms with known parameters; motion
   observed in real footage may be camera movement already present in the
   source.
3. Have a second annotator review the labels and resolve disagreements.
   Record the annotator/date and any ambiguous intervals in the annotation
   record. Do not copy the existing profile's predictions into the label file.
4. Only then change that case's `labels.status` to
   `human-reviewed-ground-truth` and fill in the labels. Compare extractor
   output against those labels with the fidelity metrics; report each feature
   separately and include the corpus size.

Semantic effects remain unmeasured by the local analyzer. An empty effect list
means “not measured,” not “effect-free.” Browser latency, peak memory, and
device coverage are also separate measurements and are not established by the
synthetic cut test.
