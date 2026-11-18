# Curry subject swap — B2 follow-up

Same `spreadLayout()` as stage 1.5, swapped to the user's Curry batch. Three
3-second pages are exported separately and hard-cut together into a **9-second
motion clip**. No layout code changed: only content, palette and grid values
differ between pages.

| Page | Headline | Palette | Cards |
|---|---|---|---|
| 1 | CURRY | cream page / navy column / gold type | celebration, short-clip highlight, trophies |
| 2 | 30 | navy page / cream column / navy type | shooting, game-clip highlight, award |
| 3 | FOUR | sand page / deep-navy column / gold type | jersey, trophies, award |

## Outputs

- `out/curry-scrapbook.mp4` — 9.00s, 1024×576, 30fps, H.264, **silent**
- `out/scene-{1,2,3}.mp4` and `*-project.json` — individual pages
- `out/scenes.png` — the three settled stills
- `out/sequence-strip.png` — 12 frames across the whole cut
- `out/video-strip.png` — close-ups from the exported video cards (both pages)
- `out/scene-*.png`, `out/seq-*.png` — raw review frames

## Rebuild

```bash
# assets: crops, accents, avatar, textures
packages/python-engine/.venv/bin/python evaluation-files/test-b/curry/prep-subject.py
packages/python-engine/.venv/bin/python evaluation-files/test-b/curry/prep-textures.py

# video cards: 3:4, 3.2s (2.2s action + 1s hold), silent
# card-2.mp4 from "High Quality Steph Curry Clips..." t=4.4, crop 540:720:305:0
# card-5.mp4 from the 56-PTS game t=357, crop 540:720:440:0

# render + concat + frame extraction
KOVE_TEST_B2_CURRY=1 pnpm --filter @kove-advanced/agent-runner test:run src/test-b2-curry.tmp.test.ts
packages/python-engine/.venv/bin/python evaluation-files/test-b/curry/sheet.py
```

`headlineBleed: 0.86` is a grid value on pages 1 and 3 so the proper names read
in full; the short word "30" is band-height-constrained by the shared function.
The headline assertion accepts width-fill **or** height-fill, so it works for
both cases without a per-scene branch.

## Status

Private capability test only. The Curry photos and videos are third-party
material; rights must be confirmed before any public demo. The cut is silent —
an owned music bed is still required.
