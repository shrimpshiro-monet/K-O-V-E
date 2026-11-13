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

The original synthetic fixture was missing from the checkout, so the checked-in
replacement was generated from one second each of solid red, green and blue.
FFprobe confirms 90 H.264 frames at 320×180 and 30 fps; FFmpeg scene detection
finds cuts at 1 and 2 seconds (frames 30 and 60). Its new SHA-256 is pinned in
the corpus. To regenerate the image content with FFmpeg:

```bash
ffmpeg -y -f lavfi -i 'color=c=red:s=320x180:r=30:d=1' \
  -f lavfi -i 'color=c=green:s=320x180:r=30:d=1' \
  -f lavfi -i 'color=c=blue:s=320x180:r=30:d=1' \
  -filter_complex '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]' \
  -map '[v]' -c:v libx264 -threads 1 -preset veryfast -crf 18 -g 30 -bf 0 \
  -frames:v 90 -movflags +faststart evaluation-files/reference/synthetic-known-cuts.mp4
```

Encoder versions may produce different bytes; if regenerated, re-verify the
media clock and cut frames before updating the hash, rather than reusing labels
blindly.

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

The coarse analyzer pass now rescans shots longer than four times the
coarse-pass median at frame resolution, up to 1,800 frames total. In the
desktop app, FFmpeg scene-score candidates are checked within each outlier
shot's time window and supplement the pixel rescan; they are stored with
`ffmpeg-scene-score` provenance. Browser-only runs use the local pixel rescan
and warn that HTML seeking may be inexact. The rescan also records transient
luma flash/dip evidence that returns to baseline within three frames. One-frame
flashes are excluded from pixel-derived cut boundaries. If the pixel-rescan
budget is exceeded, FFmpeg candidates may still split the shot, but the profile
warns that cuts or effects may remain unmeasured. These are detection
candidates, not human-verified scene labels.

## Captain Price machine-derived regression fixture

`captain-price-ground-truth.json` records the supplied FFmpeg scene-score
candidate events, approximate end-card boundary, and expected regression
counts. The source video is available locally as `captain price (2nd
priority).MP4`; its SHA-256 matches the Captain Price candidate entry in
`known-cut-corpus.json`. Its video stream starts at 0.161003 seconds, so
container timestamps must be shifted to the video-relative 30 fps clock before
comparing frames.

The analyzer tests exercise production timestamp conversion and event merging,
then run a mocked frame-analysis integration case that checks at least 20
events before frame 515, 12 events in frames 270–460, each supplied event
within one frame, and end-card trimming within five frames of the approximate
frame-515 endpoint. The fixture labels are generated from FFmpeg scene scores;
they can include cuts, flashes, and dips and are not human-verified. Passing
these tests verifies the detector data path and the supplied candidate
expectations, not perceptual accuracy on the reference video.

An independent local FFmpeg scan of the hash-matched source with
`select='gt(scene,0.08)'`, adjacent-frame merging, and the 0.161003-second
stream offset produced 24 candidate groups: 22 before frame 515 and 12 in
frames 270–460. This reproduces the fixture's coarse count gates but does not
make the scene-score candidates human-verified cuts.

Reference corner regions are masked in pixel measurements. OCR and use of
creator-added text are disabled by default; analysis requires explicit user
opt-in. Recognized wording remains redacted from director prompts unless the
user explicitly asks to copy, include, or reproduce reference text. Platform
watermarks and end cards should not be reproduced as edit content by default.

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

Effects other than the targeted transient luma flash/dip remain unmeasured by
the local analyzer. An empty effect list means “not measured,” not
“effect-free.” Browser latency, peak memory, and device coverage are also
separate measurements and are not established by the synthetic cut test.
