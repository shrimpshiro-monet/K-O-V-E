# Magazine edit / motion-graphics gap analysis

Status: P0 complete. P1 complete and verified. P1.5 harness complete; human review rejected the render as not matching the reference. P2-P7 paused pending a rebuilt static beat. Doc-only reconciliation against `kove.mirror.v4`.

Source pair: `magazine edit, motion graphics.MP4` (reference) and `curry56_scrapbook.mp4` (before).
P0 baseline is frozen at `evaluation-files/mograph-baseline/`.

## P0 measured state

| Check | Reference | Before output |
|---|---:|---:|
| Mean motion | 36.92 | 7.94 |
| First-4s mean motion | 27.51 | 3.68 |
| First-4s hard cuts | 0 | 1 |
| Cut burst | 9.5s at 2+ cuts/s | none |
| Max static outside hold | 1.67s | 4.0s |
| Holds | 1 (1.67s) | 0 |

Before output also has 6 cuts over 28s (0.21 cuts/s), versus 28 cuts over 18.8s (1.49 cuts/s) for the reference. Reference self-check passes 6/6; the before output passes 0/6.

## P1 measured state

New render: `evaluation-files/mograph-p1/curry56-magazine-p1.mp4` (1024x576@30fps, 28s). New metrics: `evaluation-files/mograph-p1/comparison.json`.

| Check | Reference | P1 output |
|---|---:|---:|
| Mean motion | 36.92 | 45.78 |
| First-4s mean motion | 27.51 | 35.77 |
| First-4s hard cuts | 0 | 0 |
| Cut burst | 9.5s at 2+ cuts/s | 11.4s at 2+ cuts/s |
| Max static outside hold | 1.67s | 0.0s |
| Holds | 1 (1.67s) | 1 (2.0s measured) |

P1 output also has 56 cuts over 28s (2.0 cuts/s), versus the reference's 28 cuts over 18.8s (1.49 cuts/s). All six checks pass; the reference self-check passes 6/6.

Proof scope: the after render is a contract proof, not a full magazine style transfer. It uses the broadcast 56-point source for a clean 7s hook (the contract requires at least 4s, not exactly 4s), the highlights source for the cut burst, a jersey still for the hold, and cutout/text overlays for the magazine look. Object transitions, text grammar, and page/object-wall templates remain P2-P4. The extra hook length intentionally gives the burst window a cut-free start after 7s so the burst qualifies inside 25-80% of the runtime.

## P1.5 measured state (harness complete; visual acceptance rejected)

New render: `evaluation-files/mograph-p1.5/curry56-magazine-p1.5.mp4` (1080x1920@30fps, 28s). New metrics: `evaluation-files/mograph-p1.5/comparison.json`, timeline at `evaluation-files/mograph-p1.5/timeline.json`.

| Check | Reference | P1.5 output |
|---|---:|---:|
| Mean motion | 36.92 | 35.31 |
| First-4s mean motion | 27.51 | 30.53 |
| First-4s hard cuts | 0 | 0 |
| Cut burst | 9.5s at 2+ cuts/s | 14.3s at 2+ cuts/s |
| Max static outside hold | 1.67s | 0.0s |
| Holds | 1 (1.67s) | 1 (2.0s measured) |
| Composed scene coverage | n/a | 100.0% (28s) |
| Shots under 0.25s | 15/29 (51.7%) | 0/44 (0.0%) |
| Freeze-test layer motion | n/a | 258/258 layers (100.0%) |

Reproduce with `KOVE_P15_RENDER=1 pnpm --filter @kove-advanced/agent-runner exec vitest run src/p15-render.tmp.test.ts`; measure with `PYTHONPATH=packages/python-engine/src packages/python-engine/.venv/bin/python -m kove_engine.mograph_metrics --config evaluation-files/mograph-p1.5/config.json --root . --check`.

All nine thresholds pass; the reference self-check passes 6/6. The P1.5 artifact is a 3-up triptych page proof built from two code-defined templates (`headline-column-3up`, `avatar-body-3up`), three new text presets (`stacked-slam`, `vertical-headline`, `scatter-settle`), full-bleed photo slots, a 2.5s still hold, and a 108px paper register shift on alternating fast scenes. Footage only appears inside photo slots; the hold uses stills. The hook uses a clean high-motion celebration window with no source cut, and the bottom panel is offset 0.8s to avoid identical panels.

Known review risks: two panels share the same celebration source, some type sits over faces/scoreboards despite cream text cards, and this is a motion proof rather than a final style transfer. The first render was watched and rejected for visual fidelity; do not call P1.5 accepted.

## v4 reconciliation

`kove.mirror.v4` is the structural reference graph: shots, scenes, layers, transforms, masks, slots, retained v3 evidence, and coverage provenance. It deliberately excludes content payloads (text strings, font choices, animation presets, effect params). Do not create a second top-level DNA schema.

`MotionGraphicsDNA` is a typed mograph **reading** of `LayeredEditDNA` (`kove.mograph.v1`), not a persisted replacement. It is produced by a derivation function and consumed by the director/compiler.

| Proposed field | v4 home | Decision |
|---|---|---|
| `effective.start/end` | `structure.editRange`, `shots[]` | Derive; do not duplicate. |
| `arc.phases` | `structure.energyCurve`, `structure.density` | Derive for analysis and the director contract; not a v4 field. |
| `arc.motionPerSec` | measured motion, not v4 | Analysis output only; keep in harness/metrics. |
| `cuts.times` | `structure.events[type=hard-cut]` | Derive from events. |
| `cuts.burstWindows` | derived from `structure.events` | Derive; do not persist a second cut timeline. |
| `scenes[].kind` | new optional `LayeredScene.kind` | Add only as an optional mograph classification: `object-wall`, `page`, `collage`, `full-bleed`, `newspaper`, `interstitial-clip`. |
| `scenes[].layout.templateId` | new optional `LayeredScene.layoutTemplateId` | Template identity belongs to the mograph layer, not the generic plan. |
| `scenes[].layout.slots` | existing `LayeredScene.slots[]` / `ContentSlot` | Reuse. `SlotRole` already covers hero, b-roll, cutout, background, logo, text. |
| `scenes[].camera.move` | `ShotProfile.cameraMotion` + `StyleLayer.transform` | Reuse measured camera; compile semantic moves to transform keyframes. Do not add a parallel camera model. |
| `scenes[].entry/exit` | `structure.events`, `styleEvidence.transitions` | Persist optional `LayeredScene.entry` / `.exit` semantic transition kinds; rendered type mapping stays in the compiler. |
| `type[].preset` | `StyleLayer[kind=text]` + `styleEvidence.textOverlays` | Text content and animation presets are out of v4. Keep the type grammar in the plan/compiler; use v4 only for geometry and evidence. |

Transition-kind vocabulary for the mograph layer: `cut`, `wall-scroll`, `push-through`, `whip-pan`, `flare-out`, `fade`. Measured v4 transition evidence remains `hard-cut | dissolve | fade | wipe | unknown`; the compiler maps semantic kinds to renderer-backed types.

## Current gaps

1. **Motion floor** — the before output averages 7.9 motion vs 36.9 reference, has no cut burst, and no hold. P1 adds the arc/cadence contract, default idle motion on non-hold layers, and one flagged hold.
2. **Hook** — the before output cuts inside the first 4s. P1 requires one continuous hook shot for 4s, with no hard cut.
3. **Object transitions** — `applyEditDNA` already compiles measured `styleEvidence` transitions (`flash`, `crossfade`, `whipPan`, `impactShake`, `crossZoom`, `colorSplit`) and OCR text. The missing part is semantic object transitions (`wall-scroll`, `push-through`, `whip-pan`, `flare-out`) and a transition-type harness check.
4. **Text grammar** — 28 presets exist, including scatter-settle, stacked-slam, and vertical headline; edge-crop slide, echo-stutter, and type-behind-subject remain P3.
5. **Layout templates** — two code-defined page templates exist (`headline-column-3up`, `avatar-body-3up`) with a 3-up triptych layout and P1 layer motion; object-wall/collage templates remain P4.
6. **Identity and narrative** — no source-to-slot identity matching or narrative progression scoring. P5-P6.
7. **Evaluation** — `reference-fidelity.ts` scores shot boundaries, cut timing, camera curve, and text windows; it does not score motion energy, cut-density correlation, transition type, text style, template match, or identity. Add the transition-type metric with P2.

## P1 contract (code names)

- `DirectorDensityContract.mograph`: per-phase arc (`hook`, `build`, `peak`, `hold`, `exit`), `hookNoHardCutSeconds: 4`, `idleMotion: "default"`, and one hold (`1.5-2.5s`, starts after 75%).
- `PlannedSegment.hold`: exactly one segment is the still hold; all other visual segments default to a subtle idle camera move.
- `applyMographContract(plan)`: deterministic enforcement of the hold and idle-motion floor.
- `validateMographPlan(plan)`: rejects a hook cut before 4s, missing/multiple holds, and a moving hold.
- Activation is explicit: prompt/ genre/ reference must read as mograph (`magazine`, `editorial`, `collage`, `scrapbook`, `motion graphics`, `object wall`, `photo wall`) so standard genres keep the existing optional-camera behavior.

## Acceptance

- P1 is accepted (2026-11-17): a new Curry render exists in `evaluation-files/mograph-p1/`, and all six P0 checks pass with the before/after table above.
- P1.5 harness checks pass (2026-11-17) for `evaluation-files/mograph-p1.5/curry56-magazine-p1.5.mp4`; visual acceptance was rejected on 2026-11-17 because the render does not match the reference. P1.5 remains unaccepted. The next fixed target is a single reference beat (source 10-12.5s) rebuilt as a static frame before any more motion work.
- Thresholds are per style. Do not run SPIDERMAN or captain-price references against the magazine config.
- Motion scores can be gamed by jitter. Review the rendered frames alongside the numbers.
