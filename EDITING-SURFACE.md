# What we have — the editing surface, with proof

Every number below was produced by running the command shown next to it, in this
checkout, at commit `697a8a7`. Nothing here is inferred from reading code.

**Per-item evidence lives in [`evidence/`](evidence/README.md)** — every tool,
action type, transition, shader, text animation and genre, with its parameters
and the file that implements it. This document is the summary; that directory is
the inventory.

Branch `arena/01a0edb9-k-o-v-e`:

```
697a8a7 fix(transitions): refuse an unknown transition type instead of silently crossfading
8fb1dd3 fix: make silent failures loud across the action dispatcher and tool boundary
2c00070 feat(effects): grow the shader look library from 15 to 20
b50fa61 feat(transitions): expand the rendered transition library from 24 to 38
861a218 feat(director): signature effects, camera vocabulary, density contract
```

---

## 1. Verification status

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `tsc --noEmit` per workspace (14 configs) | **0 errors** |
| ESLint | `eslint src` per app (repo's own flat configs) | **0 errors**, 120 warnings |
| Tests (JS/TS) | `vitest run` over the whole suite | **931 passed** \| 3 failed \| 10 skipped (1007) |
| Tests (Python) | `pytest tests` in `packages/python-engine` | **36 passed** |
| Python syntax | `python3 -m py_compile` on all 42 `.py` files | **all compile** |
| GLSL | `@shaderfrog/glsl-parser` over all 20 effect shaders | **20/20 parse** |

### About the 3 failing tests

They are `eval/corpus.test.ts`, `eval/effect-goldens.test.ts` and three cases in
`eval/baseline.test.ts`. They are **datasets and binaries that are not in the
repository**, not product failures:

- `evaluation-files/projects.json` — the eval corpus. The directory does not
  exist in the checkout; only `evaluation-files/baseline-*.json` is gitignored,
  so the corpus is simply a local fixture that was never committed.
- `ffmpeg` — not installed in this sandbox, and `effect-goldens` needs it to
  synthesise reference footage.

I ran the same files against the **base commit** (`2089356`, before any of this
work) and they fail identically:

```
$ git archive 2089356 | tar -x -C /tmp/base && cd /tmp/base
$ vitest run --config vitest.local.config.ts packages/agent/src/eval/
 Test Files  3 failed | 1 passed (4)
      Tests  3 failed | 13 passed | 1 skipped (66)
```

### About the 120 lint warnings

`eslint.config.js` sets every one of these to `"warn"` deliberately:
`react-hooks/exhaustive-deps` (71), `no-explicit-any` (12),
`no-case-declarations` (10), `no-empty` (8), `no-console` (4),
`prefer-const` (3), `no-unused-vars` (3). I verified the files I changed add
**zero** new ones by stashing them and re-linting HEAD — identical three
warnings, just at shifted line numbers.

---

## 2. Bugs this audit found and fixed

The point of the exercise was to prove things work rather than assume it. It
turned up **seven** defects: five that failed silently or produced the wrong
result, one that escaped the executor's error handling entirely, and one that
did not compile:

### 2.1 Unknown action types silently "succeeded"

`ActionExecutor` routes actions by string prefix (`clip/…` → `applyClipAction`)
and none of its ten domain switches had a `default:` case. So:

```
execute_action { type: "clip/addd", params: {…} }
→ { ok: true, summary: "executed clip/addd" }     // nothing happened
```

Fixed: every domain switch now refuses an unknown type, and the prefix router
throws for an unknown domain. Same call now:

```
→ { ok: false, code: "INVALID_PARAMS",
    message: "Unknown clip action type: clip/addd" }   // project untouched
```

### 2.2 Two cases were wired into the wrong switch (dead code)

The dispatcher had `case "track/consolidate"` and `case "track/restorePositions"`
sitting inside `applyClipAction`. Prefix routing sends `track/…` to
`applyTrackAction`, so **neither case could ever run**. `consolidate_track` was a
no-op that returned `ok: true`.

Fixed by moving both into `applyTrackAction`, and pinned by a source-scanning
test that fails if a case label ever lands in a switch for another domain again.

### 2.3 Inverse-action generation ran outside the error guard

`execute()` called `inverseGenerator.generate(...)` before its `try` block, so a
malformed action (a restore with no payload) threw straight past the executor's
own error handling instead of coming back as a failed result. Moved inside.

### 2.4 `add_transition` rejected the aliases the prompt promises

The director prompt says `whip-zoom` → `crossZoom` and `datamosh` → `pixelSort`.
The plan path honoured that; the direct tool boundary did not:

```
add_transition { transitionType: "whip-zoom" }
→ { ok: false, code: "UNSUPPORTED_TRANSITION" }
```

Fixed: the tool canonicalizes before validating, stores the canonical type, and
answers a hard cut with an explanation instead of a confusing rejection.

### 2.5 The transition renderer silently substituted a crossfade

`renderTransitionToCanvas` ended its dispatch with a bare

```ts
default:
  await this.renderCrossfade(outgoing, incoming, easedProgress);
```

and `getDefaultParams` returned `{}` for anything unrecognised. So a project
carrying a bad or outdated transition type rendered a *crossfade* — a blend the
user never asked for — with nothing logged. Both now refuse by name:

```
Unknown transition type: quantumSmear. Supported: crossfade, dipToBlack, …
```

`createTransition` / `createClipEdgeTransition` keep their `Transition | null`
contract and return `null` rather than throwing, so the existing null-checks at
the call sites are unaffected. The two production call sites (`video-engine`,
`render-bridge`) already wrap rendering in `try`/`catch` and log, so a bad type
now surfaces as a logged error and a hard cut instead of a wrong blend.

### 2.6 The transform domain accepted any action type

`applyTransformAction` has no switch — it merges `params.transform` into the
clip unconditionally — and the router sends *every* `transform/…` string there.
So an invented type was applied and reported success:

```
execute_action { type: "transform/deleteEverything", params: { clipId, transform } }
→ { ok: true }        // clip rotated
```

It now refuses anything but `transform/update`, and a runtime test walks all 21
routed domains asserting that an invented type is refused and the project is
left byte-identical (`action-dispatch.test.ts`).

### 2.7 A preview referenced an undefined binding

`TransitionInspector.tsx` referenced an undefined `jump` binding in the
`lumaWipe` / `inkBleed` / `paperBurn` preview code — a real compile error in a
file the whole app imports. The preview never needed it; removed.

Two further pre-existing type errors were cleared along the way:
`executor.test.ts` passed `structuredClone(...)` (typed `unknown`) into
`LLMToolUse.input`, and `apps/desktop`'s IPC contract declared object-typed
headers where `cloudFetch` needs `Record<string, string>` (also a zod v4
signature error).

### How these are prevented from coming back

Five new regression files, all passing:

| File | What it pins |
| --- | --- |
| `packages/core/src/actions/action-dispatch.test.ts` | Scans the dispatcher source: no case in the wrong domain switch, no switch without a `default`, no declared case unreachable, and a real `track/consolidate` run that moves a clip. |
| `packages/agent/src/registry.wiring.test.ts` | Walks **all 316 tools**: unique names, valid schemas, three provider projections in sync, every read tool callable, and **every action-backed tool reaches a live executor branch**. |
| `packages/agent/src/editing-surface.test.ts` | 23 tests pressing every editing capability through the tool boundary, asserted on project state. |
| `packages/core/src/video/transition-library.test.ts` | Walks the whole chain for all 38 transitions at runtime: schema list, engine dispatch, default-parameter table, available-types list — plus the 20 shaders' uniforms. |
| `packages/agent/src/evidence/generate-evidence.test.ts` | Recomputes every figure in `evidence/` and asserts it: tool surface, action wiring against the runtime handler registry, transition/shader/text libraries, alias targets, genre density contracts. |

The wiring test is the one that matters most: it calls every action-backed tool
and fails if any of them comes back "Unknown … action type". A renamed executor
branch or a typo'd `actionType` now breaks the build instead of silently
no-op'ing in front of a user.

---

## 3. The editing surface: 316 tools across 22 domains

From `listTools()` in `packages/agent/src/registry.ts`.

| Domain | Tools | What it covers |
| --- | --- | --- |
| `motion` | 190 | Motion-graphics canvas + 3D/scene authoring |
| `read` | 25 | State inspection, capabilities, validation |
| `clip` | 11 | Add, split, move, trim, slip, slide, roll, ripple, gaps |
| `track` | 10 | Add, duplicate, reorder, lock, hide, mute, solo, consolidate |
| `graphics` | 9 | Shapes, SVG, stickers |
| `multicam` | 8 | Activity map, transcripts, cut overrides, policy |
| `audio` | 7 | Volume, fades, effects, automation |
| `export` | 7 | Video/audio export, motion render queue |
| `project` | 7 | Create, open, save, rename, settings, background |
| `speed` | 6 | Speed, ramps, reverse, pitch, stabilization, chroma key |
| `effect` | 5 | Add/update/remove/toggle/reorder video effects |
| `subtitle` | 5 | Add, update, style, SRT import |
| `ai` | 4 | `plan_edit`, `extract_segments`, prompt expansion |
| `text` | 3 | Create, update, remove text overlays |
| `transition` | 3 | Add, update, remove transitions |
| `marker` | 3 | Add, update, remove timeline markers |
| `media` | 3 | Rename, delete, import from URL |
| `transform` | 3 | Transform, blend mode, blend opacity |
| `keyframe` | 3 | Add, remove, set all |
| `color` | 1 | Colour grading (wheels/curves/LUT/HSL) |
| `raw` | 2 | `execute_action`, `batch_actions` escape hatches |
| `internal` | 1 | `submit_edit_plan` |
| **total** | **316** | |


## 4. Full tool inventory

`wiring` legend: `read` = read-only, `action` = dispatches through the action
executor, `destructive` = needs confirmation, `expensive` = long-running,
`internal` = hidden from the model.


### read — 25 tools

| tool | wiring | required params |
| --- | --- | --- |
| `critique_creation_scene` | read | — |
| `evaluate_creation_material_graph` | read | graph |
| `export_creation_scene_gltf` | read | — |
| `get_capabilities` | read | — |
| `get_clip` | read | clipId |
| `get_creation_asset` | read | assetId |
| `get_creation_capabilities` | read | — |
| `get_creation_history` | read | — |
| `get_creation_scene` | read | — |
| `get_editor_state` | read | — |
| `get_motion_composition` | read | compositionId |
| `inspect_3d_model` | read | — |
| `inspect_creation_product_parts` | read | — |
| `list_clips` | read | — |
| `list_creation_assets` | read | — |
| `list_creation_scenes` | read | — |
| `list_media` | read | — |
| `list_motion_animatable_properties` | read | compositionId, layerId |
| `list_motion_compositions` | read | — |
| `list_tracks` | read | — |
| `probe_rigging_backend` | read | — |
| `render_creation_scene_image` | read | — |
| `simulate_creation_cloth` | read | — |
| `solve_creation_ik` | read | target |
| `validate_creation_state` | read | — |

### clip — 11 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_clip` | action | trackId, mediaId, startTime |
| `close_gap` | action | clipId |
| `move_clip` | action | clipId, startTime |
| `remove_clip` | destructive,action | clipId |
| `ripple_delete_clip` | destructive,action | clipId |
| `roll_edit` | action | leftClipId, rightClipId, delta |
| `slide_clip` | action | clipId, delta |
| `slip_clip` | action | clipId, delta |
| `split_clip` | action | clipId, time |
| `trim_clip` | action | clipId |
| `trim_to_playhead` | action | clipId, playheadTime, trimStart |

### track — 10 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_track` | action | trackType |
| `consolidate_track` | action | trackId |
| `duplicate_track` | action | sourceTrackId |
| `hide_track` | action | trackId, hidden |
| `lock_track` | action | trackId, locked |
| `mute_track` | action | trackId, muted |
| `remove_track` | destructive,action | trackId |
| `rename_track` | action | trackId, name |
| `reorder_track` | action | trackId, newPosition |
| `solo_track` | action | trackId, solo |

### graphics — 9 tools

| tool | wiring | required params |
| --- | --- | --- |
| `create_shape_clip` | - | clip |
| `create_sticker_clip` | - | clip |
| `create_svg_clip` | - | clip |
| `remove_shape_clip` | destructive | clipId |
| `remove_sticker_clip` | destructive | clipId |
| `remove_svg_clip` | destructive | clipId |
| `update_shape_clip` | - | clipId, updates |
| `update_sticker_clip` | - | clipId, updates |
| `update_svg_clip` | - | clipId, updates |

### multicam — 8 tools

| tool | wiring | required params |
| --- | --- | --- |
| `annotate_segment` | - | groupId, startMs, endMs, note |
| `get_activity_map` | read | — |
| `get_edit_summary` | read | — |
| `get_project_manifest` | read | — |
| `get_transcript` | read | — |
| `override_cut` | destructive | groupId, switchId, operation |
| `preview_frame` | read,expensive | groupId, timeMs |
| `set_edit_policy` | destructive | groupId |

### project — 7 tools

| tool | wiring | required params |
| --- | --- | --- |
| `create_project` | - | — |
| `list_projects` | read | — |
| `open_project` | - | id |
| `rename_project` | action | name |
| `save_project` | - | — |
| `set_canvas_background` | action | — |
| `update_project_settings` | action | — |

### audio — 7 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_audio_automation` | action | clipId, points |
| `add_audio_effect` | action | clipId, effect |
| `remove_audio_effect` | action | clipId, effectId |
| `set_clip_fade` | action | clipId |
| `set_clip_volume` | action | clipId, volume |
| `toggle_audio_effect` | action | clipId, effectId, enabled |
| `update_audio_effect` | action | clipId, effectId, params |

### export — 7 tools

| tool | wiring | required params |
| --- | --- | --- |
| `cancel_motion_render_item` | - | itemId |
| `export_audio` | expensive | — |
| `export_motion_video` | expensive | compositionId |
| `export_video` | expensive | — |
| `list_motion_render_queue` | read | — |
| `queue_motion_render` | - | compositionId |
| `run_motion_render_queue` | expensive | — |

### speed — 6 tools

| tool | wiring | required params |
| --- | --- | --- |
| `set_clip_chroma_key` | action | clipId |
| `set_clip_pitch_correction` | action | clipId, pitchCorrection |
| `set_clip_reverse` | action | clipId, reversed |
| `set_clip_speed` | action | clipId, speed |
| `set_clip_stabilization` | action | clipId |
| `set_speed_ramp` | action | clipId |

### effect — 5 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_video_effect` | - | clipId, effectType |
| `remove_video_effect` | action | clipId, effectId |
| `set_effect_order` | action | clipId, effectIds |
| `toggle_video_effect` | action | clipId, effectId, enabled |
| `update_video_effect` | action | clipId, effectId, params |

### subtitle — 5 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_subtitle` | action | text, startTime, endTime |
| `import_srt` | action | srtContent |
| `remove_subtitle` | destructive,action | subtitleId |
| `set_subtitle_style` | action | style |
| `update_subtitle` | action | subtitleId |

### ai — 4 tools

| tool | wiring | required params |
| --- | --- | --- |
| `expand_prompt` | read | prompt |
| `expand_prompt_result` | read | expandedPrompt, rationale |
| `extract_segments` | expensive | — |
| `plan_edit` | expensive | prompt |

### media — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `delete_media` | destructive,action | mediaId |
| `import_media_from_url` | - | url |
| `rename_media` | action | mediaId, name |

### transform — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `set_clip_blend_mode` | action | clipId, blendMode |
| `set_clip_blend_opacity` | action | clipId, opacity |
| `set_clip_transform` | action | clipId, transform |

### keyframe — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_keyframe` | action | clipId, property, time |
| `remove_keyframe` | action | clipId, property, time |
| `set_clip_keyframes` | action | clipId, keyframes |

### transition — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_transition` | action | clipAId, clipBId, transitionType, duration |
| `remove_transition` | action | transitionId |
| `update_transition` | action | transitionId |

### marker — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_marker` | action | time, label, color |
| `remove_marker` | action | markerId |
| `update_marker` | action | markerId, updates |

### text — 3 tools

| tool | wiring | required params |
| --- | --- | --- |
| `create_text_clip` | - | clip |
| `remove_text_clip` | destructive | clipId |
| `update_text_clip` | - | clipId, updates |

### raw — 2 tools

| tool | wiring | required params |
| --- | --- | --- |
| `batch_actions` | destructive | actions |
| `execute_action` | destructive | type |

### color — 1 tools

| tool | wiring | required params |
| --- | --- | --- |
| `set_color_grading` | action | clipId |

### internal — 1 tools

| tool | wiring | required params |
| --- | --- | --- |
| `submit_edit_plan` | read,internal | — |

### motion — 190 tools

| tool | wiring | required params |
| --- | --- | --- |
| `add_creation_camera_module` | - | — |
| `add_creation_character` | - | — |
| `add_creation_cutaway_plane` | - | — |
| `add_creation_decal` | - | — |
| `add_creation_light_sweep` | - | — |
| `add_creation_particle_system` | - | — |
| `add_creation_procedural_texture` | - | sceneId |
| `add_creation_product_callout` | - | label |
| `add_creation_product_internals` | - | — |
| `add_creation_product_part` | - | role |
| `add_creation_scene_object` | - | kind |
| `add_creation_screen_stack` | - | — |
| `add_creation_ui_panel` | - | — |
| `add_motion_3d_object` | - | compositionId, object |
| `add_motion_3d_scene` | - | compositionId, objects |
| `add_motion_component_instance` | - | compositionId, instanceLayerId |
| `add_motion_cursor_click` | - | compositionId, targetLayerId |
| `add_motion_effect` | - | compositionId, layerId, effectType |
| `add_motion_expression_control` | - | compositionId, layerId, controlType |
| `add_motion_guide` | - | compositionId, orientation, position |
| `add_motion_keyframe` | - | compositionId, layerId, property, time |
| `add_motion_layer` | - | compositionId |
| `add_motion_layers` | - | compositionId, layers |
| `add_motion_light` | - | compositionId, lightType |
| `add_motion_marker` | - | compositionId, time |
| `add_motion_mask` | - | compositionId, layerId, shape |
| `add_motion_mask_path_keyframe` | - | compositionId, layerId, maskId, time |
| `add_motion_shader_effect` | - | compositionId, layerId, shaderId |
| `add_motion_shape_group` | - | compositionId, layerId |
| `add_motion_shape_group_operator` | - | compositionId, layerId, groupId, operatorType |
| `add_motion_shape_modifier` | - | compositionId, layerId, modifierType |
| `add_motion_shape_path_keyframe` | - | compositionId, layerId, time |
| `add_motion_shape_to_group` | - | compositionId, layerId, shapeType |
| `add_motion_text_animator` | - | compositionId, layerId |
| `add_motion_text_shader_animator` | - | compositionId, layerId, shaderId |
| `add_motion_ui_component` | - | compositionId, componentType |
| `add_scene_object` | - | compositionId, layerId, kind |
| `align_motion_layers` | - | compositionId, layerIds, alignment |
| `animate_creation_camera` | - | — |
| `animate_creation_exploded_view` | - | — |
| `animate_creation_object` | - | objectId |
| `animate_layer` | - | compositionId, layerId, property |
| `animate_motion_camera` | - | compositionId |
| `animate_motion_layers` | - | compositionId, layerIds, presetId |
| `animate_motion_light` | - | compositionId, lightId, property, keyframes |
| `animate_scene_camera` | - | compositionId, layerId |
| `animate_scene_object` | - | compositionId, layerId, objectId |
| `apply_creation_array` | - | sceneId |
| `apply_creation_bevel` | - | — |
| `apply_creation_boolean` | - | — |
| `apply_creation_cloth_wave` | - | objectId |
| `apply_creation_displacement` | - | — |
| `apply_creation_material_graph` | - | graph |
| `apply_creation_material_preset` | - | objectId |
| `apply_creation_surface_detail` | - | — |
| `apply_creation_texture_map` | - | sceneId |
| `apply_creation_xray_material` | - | — |
| `apply_motion_preset_to_beats` | - | compositionId, layerId, presetId |
| `apply_motion_template` | - | templateId |
| `arrange_motion_layers` | - | compositionId, layerIds, mode |
| `attach_motion_expression` | - | compositionId, layerId, property, expressionType |
| `bake_creation_asset` | - | — |
| `bake_creation_cloth` | - | sceneId |
| `bake_creation_humanoid` | - | sceneId |
| `bake_creation_particles` | - | sceneId |
| `bake_creation_skinned_limb` | - | sceneId |
| `bake_creation_texture` | - | — |
| `bind_motion_variable` | - | compositionId, layerId, variableId, target |
| `clear_motion_shader_fill` | - | compositionId, layerId |
| `copy_motion_keyframes` | read | compositionId, layerId, property |
| `create_ai_shader` | - | name, category, glsl |
| `create_creation_3d_scene` | - | objects |
| `create_motion_composition` | - | — |
| `create_motion_null_controller` | - | compositionId, layerIds |
| `create_motion_variable` | - | compositionId, variableType |
| `create_product_cinematic_scene` | - | — |
| `delete_motion_composition` | destructive | compositionId |
| `delete_motion_variable` | destructive | compositionId, variableId |
| `disintegrate_motion_layer` | - | compositionId, layerId |
| `distribute_motion_layers` | - | compositionId, layerIds, axis |
| `duplicate_creation_object` | - | sceneId |
| `duplicate_motion_composition` | - | compositionId |
| `duplicate_motion_layer` | - | compositionId |
| `edit_motion_shape_path_point` | - | compositionId, layerId, index |
| `generate_ad_scene` | - | — |
| `group_motion_layers` | - | compositionId, layerIds |
| `import_figma_composition` | - | figma |
| `import_image_layer` | - | compositionId, url |
| `import_lottie_composition` | - | lottie |
| `import_motion_font` | - | compositionId, family, source |
| `import_svg_composition` | - | svgContent |
| `insert_motion_into_editor` | - | compositionId |
| `insert_motion_shape_path_point` | - | compositionId, layerId, afterIndex |
| `list_ai_shaders` | read | — |
| `list_motion_expression_errors` | read | compositionId |
| `list_motion_shaders` | read | — |
| `merge_motion_shape_layers` | destructive | compositionId, layerIds, mode |
| `morph_motion_layers` | - | compositionId, fromLayerId, toLayerId |
| `morph_motion_shape` | - | compositionId, layerId, toTime |
| `move_motion_guide` | - | compositionId, guideId, position |
| `move_motion_keyframe` | - | compositionId, layerId, keyframeId, time |
| `move_motion_shape_item` | - | compositionId, layerId, itemId, direction |
| `paste_motion_keyframes` | - | compositionId, layerId, fromProperty, toProperty |
| `pose_creation_character` | - | sceneId |
| `precompose_motion_layers` | - | compositionId, layerIds |
| `recover_motion_scene3d_to_creation` | - | compositionId, layerId |
| `remove_ai_shader` | destructive | shaderId |
| `remove_creation_scene_object` | destructive | objectId |
| `remove_motion_beat_marker` | destructive | compositionId, index |
| `remove_motion_effect` | destructive | compositionId, layerId, effectId |
| `remove_motion_expression` | destructive | compositionId, layerId, expressionId |
| `remove_motion_guide` | destructive | compositionId, guideId |
| `remove_motion_keyframe` | destructive | compositionId, layerId |
| `remove_motion_layer` | destructive | compositionId |
| `remove_motion_light` | destructive | compositionId, lightId |
| `remove_motion_marker` | destructive | compositionId, markerId |
| `remove_motion_mask` | destructive | compositionId, layerId, maskId |
| `remove_motion_scene_object` | destructive | compositionId, layerId, objectId |
| `remove_motion_shape_group_operator` | destructive | compositionId, layerId, groupId, operatorId |
| `remove_motion_shape_item` | destructive | compositionId, layerId, itemId |
| `remove_motion_shape_modifier` | destructive | compositionId, layerId, modifierId |
| `remove_motion_shape_path_point` | - | compositionId, layerId, index |
| `remove_motion_text_animator` | destructive | compositionId, layerId, animatorId |
| `render_creation_preview` | expensive | — |
| `render_motion_frame` | expensive | compositionId |
| `reorder_motion_effect` | - | compositionId, layerId, effectId, direction |
| `reorder_motion_layer` | - | compositionId, layerId, mode |
| `rig_humanoid_model` | expensive | — |
| `ripple_delete_motion_layer` | destructive | compositionId, layerId |
| `ripple_motion_layers` | - | compositionId, fromTime, delta |
| `scatter_creation_objects` | - | — |
| `set_creation_camera` | - | — |
| `set_creation_object_geometry` | - | objectId |
| `set_creation_object_material` | - | objectId |
| `set_creation_object_transform` | - | objectId |
| `set_creation_scene_environment` | - | — |
| `set_model_animation` | - | compositionId, layerId |
| `set_motion_beat_markers` | - | compositionId, times |
| `set_motion_blur` | - | compositionId |
| `set_motion_camera` | - | compositionId |
| `set_motion_group_auto_layout` | - | compositionId, groupId |
| `set_motion_instance_overrides` | - | compositionId, instanceLayerId |
| `set_motion_layer_3d` | - | compositionId, layerId, preserve3d |
| `set_motion_layer_blend_mode` | - | compositionId, layerId, blendMode |
| `set_motion_layer_guide` | - | compositionId, layerId, guideLayer |
| `set_motion_layer_lock` | - | compositionId, layerId, locked |
| `set_motion_layer_motion_blur` | - | compositionId, layerId, enabled |
| `set_motion_layer_name` | - | compositionId, layerId, name |
| `set_motion_layer_parent` | - | compositionId, layerId |
| `set_motion_layer_solo` | - | compositionId, layerId, solo |
| `set_motion_layer_timing` | - | compositionId, layerId |
| `set_motion_layer_transform` | - | compositionId, layerId |
| `set_motion_layer_visibility` | - | compositionId, layerId, visible |
| `set_motion_light_style` | - | compositionId, lightId |
| `set_motion_mask_path` | - | compositionId, layerId, maskId, pathPoints |
| `set_motion_scene3d_lighting` | - | compositionId, layerId |
| `set_motion_scene_camera` | - | compositionId, layerId |
| `set_motion_scene_object` | - | compositionId, layerId, objectId |
| `set_motion_shader_fill` | - | compositionId, layerId, shaderId |
| `set_motion_shape_path` | - | compositionId, layerId, points |
| `set_motion_shape_style` | - | compositionId, layerId |
| `set_motion_text_content` | - | compositionId, layerId, text |
| `set_motion_text_style` | - | compositionId, layerId |
| `set_motion_time_remap` | - | compositionId, compositionLayerId |
| `set_motion_track_matte` | - | compositionId, layerId |
| `simulate_creation_rigid_bodies` | - | sceneId |
| `simulate_creation_rigid_drop` | - | sceneId |
| `slip_motion_layer` | - | compositionId, layerId, delta |
| `split_motion_layer` | - | compositionId, layerId, time |
| `sync_creation_scene_to_motion` | - | — |
| `sync_motion_to_audio` | expensive | compositionId |
| `toggle_motion_effect` | - | compositionId, layerId, effectId, enabled |
| `toggle_motion_expression` | - | compositionId, layerId, expressionId, enabled |
| `transfer_motion_effect_stack` | - | compositionId, sourceLayerId, targetLayerIds |
| `transfer_motion_mask_stack` | - | compositionId, sourceLayerId, targetLayerIds |
| `transform_motion_keyframes` | - | compositionId, layerId, property, op |
| `trim_motion_layer` | - | compositionId, layerId, edge, time |
| `unbind_motion_variable` | destructive | compositionId, layerId, bindingId |
| `ungroup_motion_layers` | destructive | compositionId, groupLayerIds |
| `update_motion_composition` | - | compositionId |
| `update_motion_effect` | - | compositionId, layerId, effectId, parameter, value |
| `update_motion_expression` | - | compositionId, layerId, expressionId |
| `update_motion_light` | - | compositionId, lightId, property, value |
| `update_motion_marker` | - | compositionId, markerId |
| `update_motion_mask` | - | compositionId, layerId, maskId |
| `update_motion_shape_group_operator` | - | compositionId, layerId, groupId, operatorId |
| `update_motion_shape_item` | - | compositionId, layerId, itemId, patch |
| `update_motion_shape_modifier` | - | compositionId, layerId, modifierId |
| `update_motion_text_animator` | - | compositionId, layerId, animatorId |
| `update_motion_variable` | - | compositionId, variableId |

---

## 5. The shot-making vocabulary

There are **113 action types** across 22 domains: 74 switch cases in the
monolithic executor, 1 type-guarded method, and 38 handler modules that register
themselves at import. [`evidence/actions.md`](evidence/actions.md) lists each one
with the properties it reads and the tool that produces it.

The director speaks in closed vocabularies, all derived from the schema at
module load, so the prompt cannot advertise something the renderer would drop.

### 5.1 Transitions — 38 rendered blends

`packages/core/src/types/effects.ts` (`TRANSITION_TYPES`) → renderer →
`SUPPORTED_TRANSITION_TYPES` → agent prompt → editor.

**Original 24:** `crossfade`, `dipToBlack`, `dipToWhite`, `wipe`, `slide`,
`zoom`, `push`, `circleReveal`, `blur`, `whipPan`, `radialWipe`, `pixelate`,
`glitch`, `blinds`, `diamondReveal`, `spin`, `flip`, `splitReveal`, `flash`,
`filmBurn`, `mosaic`, `ripple`, `pageTurn`, `colorSplit`

**Second wave 14:** `crossZoom`, `zoomBlur`, `motionSmear`, `strobeCut`,
`impactShake`, `lumaWipe`, `inkBleed`, `tileFlip`, `sliceSlide`, `lightLeak`,
`vhsScan`, `paperBurn`, `pixelSort`, `filmRoll`

Every one has a render path, a `getDefaultParams` entry, an editor preview and a
parameter panel. Verified at **runtime**, not by reading code — `transition-library.test.ts`
constructs an engine and walks all 38:

```
getAvailableTransitionTypes() == TRANSITION_TYPES   →  38/38, no extras
getDefaultParams(type) non-empty for every type     →  38/38
createTransition(a, b, type, 0.5) returns the type  →  38/38, defaults attached
getDefaultParams("quantumSmear")                    →  throws, named
renderTransitionToCanvas("quantumSmear")            →  throws, named
```

and verified in source for the UI layer:

```
core TRANSITION_TYPES                               →  38
engine dispatch cases with no default fallback      →  38 present, 0 missing
TransitionInspector preview switch                  →  38 present, 0 missing
EffectsTransitionsPanel presets                     →  45 buttons over 38 types
                                                       (7 are curve/direction variants)
```

The panel's 45 entries are 38 transition types plus seven parameter presets —
three crossfade curves (linear / ease-in / ease-out) and four whip directions.
Each carries a unique React key (`id ?? \`${type}-${label}\``), so nothing
collides; they exist so a user can pick "Slow In Dissolve" or "Whip Left"
directly rather than picking a transition and then editing a parameter.

46 aliases are folded onto them, matched case-, space- and underscore-
insensitively, so "Whip Zoom", `whip_zoom` and `whip-zoom` all reach `crossZoom`.

### 5.2 Effect shaders — 20 looks

`packages/core/src/motion/shaders/effect-shaders.ts`. All 20 parse as GLSL ES
3.00; the structural test asserts `#version 300 es`, no `gl_FragColor`, a
`uniform <type> u_<param>` per parameter, and defaults inside their ranges.

dither, gradient-map, pixelate, halftone, vhs, posterize, duotone, prism,
fisheye, wave-warp, scanlines, edge-glow, speed-lines, glitch-blocks,
light-leak, kaleidoscope, mirror-tiles, swirl, crt-curve, echo

Each is also a *named look* a plan can request by intent (`{ type: "vhs",
intensity: 0.8 }`), with an intensity mapping and its own alias set.

### 5.3 Everything else the director can specify

| Vocabulary | Size | Source |
| --- | --- | --- |
| Clip effect types | 21 | `SUPPORTED_CLIP_EFFECT_TYPES` |
| Signature shader looks | 20 | `SIGNATURE_EFFECT_DEFS` |
| Camera moves | 14 | `CAMERA_MOVE_IDS` / `CAMERA_MOVE_ATLAS` |
| Text animations | 25 | `SUPPORTED_TEXT_ANIMATIONS` |
| Genres | 19 | `packages/agent/src/director/genres.ts` |
| Motion moves | 3 | particle-burst-on-cut, glitch-transition, 3d-title-card |

---

## 6. Proof that the tools actually edit

`packages/agent/src/editing-surface.test.ts` — 23 tests, all passing. Each one
calls a tool through the public boundary and asserts the project changed.
Highlights:

| Capability | Assertion |
| --- | --- |
| Cut | split turns a 5s clip into two; the original keeps the first half |
| Arrange | move/slip/slide/roll change position and in-point without changing clip count |
| Consolidate | a clip parked at 8s snaps back to 5s against its neighbour |
| Track locking | edits are refused while locked, allowed after unlock |
| Speed | `speed=2` stored; ramp, reverse, pitch correction, stabilization all land |
| Colour | exposure 0.2 round-trips on the clip's grading |
| Transform | rotation 5° stored on the transform |
| Blend | `blendMode: "screen"` and `blendOpacity: 0.75` stored separately |
| Effects | `vhs` @ 0.8 stores `{ shaderId: "vhs", scanlines: 0.4, jitter: 0.48 }` |
| Look library | all five new looks (kaleidoscope, mirror-tiles, swirl, crt-curve, echo) store their own shaderId |
| Aliases | `vortex` → swirl; invented names rejected with `UNSUPPORTED_EFFECT` |
| Effect ops | toggle, update, reorder, remove all observable on the clip |
| Transitions | `crossZoom`, `whip-zoom`, `Whip Zoom`, `paperBurn`, `datamosh` all land; `datamosh` stores as `pixelSort` |
| Refusals | unknown transition → `UNSUPPORTED_TRANSITION`; `hardCut` → explained, nothing stored |
| Text | overlay created and updated |
| Graphics | shape, SVG and sticker overlays each created |
| Subtitles | manual add plus a 2-cue SRT import; style applied |
| Markers | added and relabelled |
| Audio | volume 0.4, fades, reverb effect, automation points |
| Tracks | add, rename, duplicate, reorder |
| Keyframes | add and set-all |
| Raw | `execute_action` and `batch_actions` both apply |
| Motion | composition → layer → transform → effect → shader fill → insert into editor |
| Honest failure | a headless render returns `JOB_FAILED` "no job runner configured" rather than pretending |

---

## 7. The agent pipeline

`plan_edit` turns a sentence into a committed timeline revision:

```
prompt
  → extract_segments        (segment map from media)
  → buildDirectorPrompt     (genre + density contract + closed vocabularies)
  → LLM → submit_edit_plan  (EditPlan)
  → validateEditPlan        (structured issues, repair loop)
  → reviewEditPlan          (style ≥ 0.6 AND density ≥ 0.6, one revision)
  → materializeEditPlan     (compiles to real actions)
  → ActionExecutor          (mutates the project)
```

The density contract is what pushes an edit away from "four hard cuts" toward a
heavily-edited piece: it derives concrete floors for shots, effect hits, camera
moves, treated shots, text overlays, speed ramps, SFX, hook shots and
transitions from the genre's `densityTarget` and the duration inferred from the
user's own words. A plan that fails the gate gets exactly one revision call
carrying a brief that names the missing density.

Materialization writes real actions: `clip/add`, `transform/update`,
`speed/setRampData`, `keyframe/setAll`, `effect/add`, `clip/setColorGrading`,
`clip/add` for music/SFX, `transition/add`, `host.createTextOverlay`, and motion
moments.

---

## 8. How to reproduce all of this

The repo's own scripts need pnpm and a full install. In this sandbox I used a
flat install plus three harness config files (`vitest.local.config.ts`,
`tsconfig.local.json`, `tsconfig.wholerepo.json` — untracked, deliberately).

```bash
# tests
node_modules/.bin/vitest run --config vitest.local.config.ts --reporter=basic

# the three proof files on their own
node_modules/.bin/vitest run --config vitest.local.config.ts \
  packages/agent/src/registry.wiring.test.ts \
  packages/agent/src/editing-surface.test.ts \
  packages/core/src/actions/action-dispatch.test.ts

# typecheck, per workspace (this is what the repo's `pnpm -r typecheck` does)
for cfg in packages/*/tsconfig.json apps/*/tsconfig.json; do
  node_modules/.bin/tsc -p "$cfg" --noEmit
done

# lint
(cd apps/web && ../../node_modules/.bin/eslint src)

# python
python3 -m py_compile $(find . -name '*.py' -not -path '*/node_modules/*')
(cd packages/python-engine && python3 -m pytest tests -q)
```

### Two things that bite

1. **The toolchain must match the lockfile.** `pnpm-lock.yaml` pins
   `typescript@5.9.3` and `@webgpu/types@0.1.68`. An install without them
   produces ~400 phantom errors (`GPUTexture` not found, `Uint8ClampedArray is
   not generic`). With the right versions the repo is clean.
2. **`@kove-advanced/*` must resolve.** Inside pnpm these are workspace symlinks.
   Under a flat install, `node_modules/@kove-advanced/<pkg>` has to point at
   `/home/user/K-O-V-E/packages/<pkg>` with an **absolute** path — a relative
   symlink resolves against the real path of the symlinked `node_modules`
   directory and dangles.

### Known sandbox limits (not product limits)

- No GPU and no browser, so shaders are verified structurally and through mock
  canvas assertions; the editor previews compile but cannot be rendered here.
- No `ffmpeg`, no Playwright, no `mediapipe` wheel → the eval corpus tests and
  six Python analyser modules (face/motion/visual/orchestrator/server/forensics)
  cannot be collected.
