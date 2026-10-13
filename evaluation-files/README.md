# Evaluation corpus for the director eval harness

`projects.json` is the corpus consumed by `packages/agent/src/eval/`
(`corpus.ts`, `baseline.ts`). It is entirely synthetic — committed to git so a
clean clone can run the harness without any external footage.

## Layout

- `projects.json` — 9 projects × 3 prompts (one `detailed`, one `vague`, one
  `genre` each), spanning the five categories: `game`, `multi`, `speech`,
  `sport`, `stream`. Asset paths are corpus-relative; several `detailed`
  prompts name their music bed by this exact corpus-relative path because the
  materializer resolves audio decisions by media name.
- `media/` — source footage (synthetic ffmpeg lavfi renders, 640×360 @ 24 fps
  with a quiet sine bed so every clip has a probed audio stream).
- `music/` — two 30s music beds (`synth-loop.mp3`, `piano-bed.mp3`).
- `reference/` — short reels that prompts point at for pacing imitation. They
  are marked `analysisRole: "reference"` by the harness and must never be
  treated as cuttable footage.

Project invariants the tests pin down:

- `game-01` is exactly one source video plus a reference video (no music), so
  its baseline segment map contains only `video-1`.
- `pod-02` is exactly one talking-head source video.
- `multi-03` references four assets (2 media + music + reference).

## Regenerating the media

```
node evaluation-files/generate-assets.mjs   # needs ffmpeg + ffprobe on PATH
```

The script overwrites every file listed in `projects.json` and probes each
result with ffprobe. Byte-identical output is not promised (encoder versions
vary), but durations, dimensions and stream layout must stay constant.

## Reports

`baseline-*.json` reports written by live runs (`KOVE_EVAL_BASELINE=1`) are
gitignored on purpose — they are measurements, not corpus.

## Local corpus overlays (`KOVE_EVAL_ROOT`)

You can keep a second, **local-only** corpus — e.g. real footage with real
durations and music — and point both live specs at it without committing
anything:

```
KOVE_EVAL_ROOT=/abs/path/to/corpus-dir \
  KOVE_EVAL_BASELINE=1 pnpm vitest run src/eval/baseline.test.ts
KOVE_EVAL_ROOT=/abs/path/to/corpus-dir \
  KOVE_EVAL_LIVE_STUB=1 pnpm vitest run src/eval/live-stub.test.ts
```

The root directory must contain `projects.json` plus every media path the
corpus references (the runner's asset gate fails fast on missing files, and
`probeMedia` throws for unreadable assets). Conventions:

- Keep real media and the overlay `projects.json` **out of git** — footage is
  copyrighted and large; the `.gitignore` already covers top-level
  `evaluation-files/*.mp4`, `evaluation-files/audio/`, and
  `*.local.json` for a reason.
- Corpus shape is the same as this directory's `projects.json`; prompt `type`
  (`detailed` | `vague` | `genre`) drives analysis, not the prompt **id**, so
  ids like `pod-01-genre` are fine.
- Media ids are assigned positionally (`video-1…`, `audio-1…`,
  `reference-1…`), matching what the director prompt advertises.
