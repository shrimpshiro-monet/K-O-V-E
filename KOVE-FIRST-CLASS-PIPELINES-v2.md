# K.O.V.E — First-class pipelines, v2 (branch-verified)

_2026-11-15. Supersedes v1. v1 was written against `main`; this version is corrected against `next/48h-mirror-dna-sprint` using a Copilot repo review, and it adopts Copilot's phased issue list with additions marked **[added]**. Same-day re-check against this branch's code verified: `textOverlays` not compiled in `apply-editdna.ts`, dual compile paths (`materializeEditPlan` + `apply-editdna`), Motion bridge re-editability, `SegmentMap` threading, and the shots-tiling validator (`packages/core/src/mirror/reference-profile.ts:189`). The 13-file reference pool was contact-sheeted for issue 1 selection (media in temp, not committed)._

---

## 0. What changed from v1

**Corrections (v1 was wrong or overstated):**

| v1 claim | Reality on this branch |
| --- | --- |
| `applyEditDNA` never reads `styleEvidence` | It uses flash/dip effects as a fallback, and extraction builds `structure.events` from style evidence that can produce transitions and accents. **Text overlays are still not compiled.** |
| Director has no first-class layout | Plan layout exists: fullscreen, split, PiP, custom regions. `motionMoments` also exist. Missing: arbitrary layered scenes, collages, cut-out stacks, 3D surfaces. |
| Director isn't conditioned on references | `plan_edit` already passes reference analysis into the prompt and review. The gap is turning measured evidence into a richer, **validated** style target. |
| Motion bridge may be a baked dead end | `insert_motion_into_editor` creates a linked instance; the timeline UI exposes the scene and navigates back to Motion Creator. Re-editable. Performance is still unmeasured. |
| "No review links" | Share infrastructure exists; the gap is timestamped comments and approval. |
| Need a new ContentGraph | `SegmentMap` already holds segments, transcripts, beats/audio features, faces, subject continuity. **Reuse it.** |
| StyleGraph replaces DNA | It should **extend/migrate Mirror v3** (rational clock, events, density, beats, evidence provenance, media-free rule). |

**Still true (the core thesis):**

1. `ReferenceProfile.shots` must tile the reference end to end. A scene with several things on screen at once cannot be expressed. (Code-verified: the validator throws `Shots must tile the reference in positive, contiguous, half-open frame intervals` at `packages/core/src/mirror/reference-profile.ts:189`. Issue 1c pins it with a two-element fixture.)
2. Evidence (text, effects) is observation, not renderable layers with parents, mattes, tracks or content slots.
3. Perception is sparse; semantic effect identification is disabled (empty list = unmeasured).
4. Fidelity scoring covers boundaries, camera, text-window timing, SSIM and rhythm. No per-layer, layout or transition fidelity. Refine knobs are essentially motion scale and grade strength.
5. Two timeline compilers (`apply-editdna.ts`, `materializeEditPlan`) duplicate clip/transform/keyframe/effect/transition logic.

---

## 1. Design decisions (locked)

- **D1. Extend, don't replace.** New format = Mirror v3 + scenes/layers/slots/coverage. v3 parsing keeps working. One-way, lossless migration v3 → new.
- **D2. Content source = `SegmentMap`.** Add a deterministic adapter from `SegmentMap` to slot candidates. No parallel ContentGraph schema.
- **D3. `EditPlan` layout becomes a constrained adapter** into scenes, not a second IR.
- **D4. One compile path.** Shared deterministic primitives under both Mirror and Director compilers; each keeps its unique behavior (Mirror: measured source allocation, transaction/rollback; Director: audio, speed ramps, text, plan layout).
- **D5. Multi-layer scenes compile to linked Motion compositions**, reopenable via the existing bridge. Never baked.
- **D6. Honest reporting everywhere.** Every graph node carries provenance (`measured | inferred | defaulted | unknown`); a coverage report says what was captured and what wasn't; unavailable metrics are labeled, never estimated.
- **D7. Reference media stays out of the repo and out of EditDNA** (existing rule). Commit only metadata and score reports.

---

## 2. Phased issue list

### Phase 0 — Baseline and quick win

| # | Title | Files | Acceptance | Depends | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | **10-reference Mirror baseline** | new runner + report in `packages/agent/src/eval/`, `evaluation-files/`; reuse `reference-fidelity.ts`, `apply-editdna.ts` | Run current extract → compile → available render-backed refine on 10 references spanning style families (include the football collage edit, kinetic type, comic-panel glitch, talking-head captions, interview intercut; no product ad exists in the current pool — log the gap). Record per-reference boundary, camera, text-window, rhythm, render metrics; unavailable scores labeled, not estimated. HEVC sources are decoded from local H.264 proxies and the decode path is recorded per file with provenance. Media external/local; commit metadata + reports only. | none | M |
| 1a **[added]** | **Compile `textOverlays` in `applyEditDNA`** | `apply-editdna.ts`, `reference-profile.ts` evidence, tests | Detected text overlays (text, bounds, window, style estimate) become editable text clips with the closest supported animation preset; low-confidence overlays are skipped and listed in a warning. Watermark/end-card regions excluded from text evidence, with provenance (9 of the pool's 13 files carry TikTok UI; unmasked, the watermark compiles into a garbage text clip). Rerun issue 1 corpus and report the delta. Small, visible win, and it measures how far the existing evidence goes. | none (run after 1 for the delta) | S |
| 1b **[added]** | **Coverage report v0 on current pipeline** | `mirror-reference-tool.ts`, `MirrorReferencePanel.tsx` | Tool output and panel state what was measured (cuts, camera, color, text, transitions) and what was not attempted (layers, fonts, semantic effects). Plain language. States whether watermark masking was applied. | none | S |
| 1c **[added]** | **Two-element scene fixture (proves the thesis)** | reference-profile validator test | Ten-line test: an authored scene with two simultaneous on-screen elements (e.g., text over footage) fails validation with the shots-tiling error at `packages/core/src/mirror/reference-profile.ts:189`, pinning thesis #1 in code. Written first; unblocks issue 2's schema work. | none | S |
| 15a **[added]** | **Portable OCR backend for text evidence** | `apps/web/src/services/mirror/reference-text.ts`, OCR worker + local assets, `packages/agent-runner` headless fallback | Native `TextDetector` → WASM OCR in a worker (tesseract.js) → headless-runner fallback. Rerun the 10-reference corpus: text overlays measured on the collage/typography references, issue 1a compiles >0 text clips, watermark/end-card exclusion still applies. | none (run before 5) | M |

### Phase 1 — Shared data contracts

| # | Title | Files | Acceptance | Depends | Size |
| --- | --- | --- | --- | --- | --- |
| 2 | **Extend Mirror v3 with a layered style graph** | `reference-profile.ts`, tests, `EDITOR-DNA-PIPELINE-CONTENTS.md` | Versioned scenes (may overlap), layers (z-order, transform tracks, masks/mattes, parents), slots, coverage/provenance. Retains v3 clock, shots/events, rhythm, evidence. Validated lossless v3 → new migration. v3 behavior unchanged during migration. | 1 | M |
| 3 | **Adapt `SegmentMap` as content source** | `segment-map.ts`, `edit-plan.ts`, director validation/review tests | Deterministic adapter from `SegmentMap` to slot candidates preserving IDs, timing, transcripts, beats, faces, subject continuity. Document/test how `EditPlan` layout maps to scenes. | 2 | M |

### Phase 2 — Vertical slice

| # | Title | Files | Acceptance | Depends | Size |
| --- | --- | --- | --- | --- | --- |
| 4 | **Compile style-graph scenes via shared primitives** | `apply-editdna.ts`, `registry.ts`, new compiler module under `packages/agent/src/director/` | Graph fixture → editable footage, transforms, text, effects, transitions. Shared logic consolidated with `materializeEditPlan`; unique responsibilities, transactions/rollback and error reporting retained. Same graph + project → byte-identical output. | 2, 3 | L |
| 5 | **Perception → layered graph evidence** | `extract-reference.ts`, `reference-profile.ts`, extraction tests | Migrate current cut/text/effect/motion/color observations into the graph without inventing evidence. First layer-detection slice (see 5a). Report measured / inferred / not attempted. Tests for overlapping scenes and migration. | 1, 2 | L |
| 6 | **Layered scenes → linked Motion compositions** | `edit-plan.ts`, `registry.ts`, Motion insertion/editor tests | Multi-layer scenes compile to linked compositions that reopen through the timeline-to-Motion UI. Structure, timing and references survive insertion and reload. No baked clips. | 4, 5 | L |
| 5a **[added]** | **First layer-detection slice: rectangular photo cards + text + static texture bed** | `extract-reference.ts`, new detectors | Scoped to the magazine edit (the pool's only collage reference): recover ≥70% of visible photo cards as separate layers with a position/scale track. Proposed target; adjust after baseline. Calibration on a single video is not meaningful — add 2–3 more collage references before this starts, or treat the ≥70% figure as provisional until the corpus covers them; do not build 6–7 on a single-video calibration. | 1, 2 | L |

### Phase 3 — Fidelity and repair

| # | Title | Files | Acceptance | Depends | Size |
| --- | --- | --- | --- | --- | --- |
| 7 | **Layered fidelity metrics + scene-local repair** | `reference-fidelity.ts`, `refine-mirror.ts`, `mirror-refine-tool.ts`, Phase 0 runner | Per-layer / layout / text / transition metrics added to the report. Scene-local repair preserves passing scenes; unavailable metrics reported honestly. Rerun the same corpus for a comparable before/after. | 1, 4, 5, 6 | L |

### Phase 4 **[added]** — What Copilot's list left out

The list above is the StyleGraph dependency path. These are needed to make it a product.

| # | Title | Files / area | Acceptance | Depends | Size |
| --- | --- | --- | --- | --- | --- |
| 8 | **Vision-model "art director" pass with coverage** | new perception stage; VLM provider ladder | Per scene, VLM **chooses** from closed vocabularies (layout, animation preset, signature look, transition) imported from `creation-schema` (issue 9's `vocab.ts` — not redefined locally) and cites frames; measured evidence beats VLM claims; conflicts become `unknown`. Coverage calibrated against hand labels (error <10 pts on 10 refs). | 5 | L |
| 9 | **Director vocab for layouts/textures/type systems** | `packages/creation-schema/src/director/` (`vocab.ts`, `edit-plan.ts`, `validate.ts`), `director-prompt.ts`, `plan-review.ts` | New closed vocabularies (collage-grid, card-stack, cut-out treatments, paper/texture beds, type roles) with schema-derived prompt blocks and density-contract floors. Unknown ids surface as validation errors. This file is the single vocabulary source for both the planner and issue 8's VLM pass; drift between them is a defect, not a convention. | 2, 4 | M |
| 10 | **Style as input to `plan_edit`** | `registry.ts` (`plan_edit`), `mirror-intent.ts`, `expand_prompt` | `plan_edit({ prompt, footage, style? })`. A reference clone and a prompt-only edit both produce a style object; the validated style, not just prompt text, constrains the plan. | 2, 9 | M |
| 11 | **Slot filling + missing-content messages** | planner/compiler | Ranked assignment from `SegmentMap` candidates to slots with constraints; shortages produce an explicit "needs N more portraits" message, not silent reuse. | 3, 4 | M |
| 12 | **Style Library (save/name/apply/preview)** | web UI + tools (`apply_style`, `list_styles`, `export_style`) | Save a graph, auto-render a preview on a sample clip, apply to user footage. 5–10 high-level knobs per style. | 4, 6 | M |
| 13 | **Assets: textures, fonts, cut-outs** | `packages/core/src/motion/shaders/`, font registry | Procedural paper/newsprint/grain beds (halftone, fisheye, mirror-tiles shaders already exist); open-font library with nearest-match + license flag; reuse `rotoscope_subject`/`refine_matte_edges` for cut-outs. | 5a | M |
| 14 | **Verify the 🟡 tools the compiler depends on** | `registry.*.test.ts` | One behavioral test each for `apply_motion_template`, `add_motion_3d_object`, `align/distribute_motion_layers`, `set_motion_layer_visibility`, `set_motion_layer_blend_mode`, `remove_motion_effect`, `toggle_motion_effect`; icons flip to ✅. | none | S–M |
| 15 | **Motion ⇄ timeline performance budget** | perf tests | Define and measure preview fps/latency for ≤6-layer scenes at 1080p; document auto-proxy fallback. Nothing measures this today. | 6 | M |
| 16 | **Eval corpus to 60 references + blind A/B** | `evaluation-files/`, rater workflow | ≥12 style families, hand-labeled; CI regression job; blind A/B vs human-made CapCut templates. Proposed targets: ≥40% preferred-or-tie at end of Phase 2 slice, ≥60% after Phase 4. | 1, 7 | L |

### Parallel track — product gaps (orthogonal to the StyleGraph path)

OTIO/FCPXML/EDL interchange · timestamped review comments + approval · color space correctness / HDR handling or explicit refusal · publish (YouTube/TikTok/Shorts) · stock + licensed music · reliability (autosave, recovery, relink) · proxy UI · named versions. Priorities and rationale as in `docs/AGENT-PARITY-AUDIT.md` §5. Schedule these as their own PRs; do not block the graph work on them.

---

## 3. Sequencing

```
1 ─┬─ 1a (quick win, rerun corpus)
   ├─ 1b
   ├─ 1c (fixture; gates issue 2's schema freeze)
   └─ 2 ─┬─ 3 ──┐
         ├─ 5 ──┼─ 4 ── 6 ── 7
         └─ 5a ─┘         └─ 15
                  4 ─ 9 ─ 10 ; 3,4 ─ 11 ; 4,6 ─ 12 ; 5a ─ 13 ; 5 ─ 8 ; 1,7 ─ 16
1c runs before 2's schema draft. 15a runs after 1 and before 5 so text evidence exists on desktop Chrome without relying on the retired Shape Detection API. 14 runs any time, ideally before 4.
```

- Issues 4 and 5 can run in parallel once issue 2's schema is stable, using authored graph fixtures to unblock the compiler.
- Issue 6 waits for both 4 and 5.
- Do 14 early; the compiler leans on those tools.

---

## 4. Exit criteria (proposed; revise after issue 1)

| Milestone | Exit |
| --- | --- |
| After Phase 0 | Baseline dashboard published; coverage report visible in Mirror; text overlays compile (watermark/end-card regions excluded); delta from 1a recorded; 1c fixture proves the tiling constraint. |
| After Phase 2 | On the collage/typography slice, every compiled scene is editable (reopens in Motion); compile is deterministic; layer recovery at target (5a) on the magazine-edit reference, with the 2–3 additional collage references in the corpus. |
| After Phase 3 | Per-layer metrics in the report; scene-local repair improves failing scenes without regressing passing ones, shown on the same corpus. |
| After Phase 4 | "Reference + my footage → 3 variants" works end to end; Style Library ships; blind A/B at target. |

## 5. Risks and kill criteria

1. **Schema churn.** Freeze issue 2's schema behind fixtures (including 1c's tiling fixture) before 4 and 5 start; migrations are lossless and one-way.
2. **Perception quality is the long pole** (5, 5a, 8). If 5a can't reach its target on the magazine edit after one iteration, stop and reassess detector choices before building 6–7 on top. The target is provisional until the corpus includes 2–3 collage references, not just the one.
3. **VLM hallucination.** Closed vocabularies, grounding in measurements, `unknown` allowed, coverage calibration (issue 8).
4. **Two compilers drifting.** Land the shared primitives in issue 4; delete duplicated paths rather than keeping both.
5. **Vocabulary drift.** Issue 8's VLM choice vocabularies and issue 9's Director vocabularies come from one source (`packages/creation-schema/src/director/vocab.ts`). If they drift, the art-director emits ids the planner rejects — treat 8's dependence on 9 as a schema dependency, not a convention.
6. **Moat check.** If blind A/B (issue 16) can't beat human-made templates by the end of Phase 4, stop before building any marketplace.
7. **IP.** Styles are not assets: fonts, music, logos and player likenesses carry their own rights. Keep references local, track asset/font/music licenses, and get counsel's view before any marketplace of player-edit styles.

## 6. First week

1. Issue 1c: write the two-element fixture (ten lines; proves the thesis, unblocks the schema).
2. Issue 1: pick the 10 references and write the runner (HEVC sources get local H.264 proxies; decode path recorded per file).
3. Issue 14: write the missing tests for the compiler-critical Motion tools.
4. Issue 1a + 1b: ship text-overlay compilation (watermark/end-card regions excluded, with provenance) and the coverage report, then rerun the corpus.
5. Draft issue 2's schema as TypeScript types + fixtures (no behavior change yet) and review it before anything else starts.
