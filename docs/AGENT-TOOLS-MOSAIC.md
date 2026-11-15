# K.O.V.E Agent Tools — The Mosaic

_Measured 2026-11-15 on `arena/3feee4cb-k-o-v-e` (main @ `88205ec`, post-PR #19)._

Every tool the AI director can call, what it is for, and whether it actually works today.
336 tools are registered. **All of them pass the registry-wide invariants**
(`schema-conformance.test.ts` — every schema is a well-formed object schema the gate
understands; every new tool is `strict` and closed; `tool-reachability.test.ts` — every
public tool is discoverable via `search_tools`/`run_tool`; wiring/fingerprint/action-catalog
tests). The differentiator below is **behavioral** proof, not registration.

## How to read the status column

| Status | Meaning |
| --- | --- |
| 🖥️ | **E2E-proven** — executed through the real editor in a real browser (Playwright). 8 tools: 6 via stubbed-LLM turns where the tool itself ran for real; `set_clip_keyframes` and `create_text_clip` via direct `executeTool` in the browser host (`e2e/vision.spec.ts`). |
| ✅ | **Unit-proven** — a test in `packages/agent`/`packages/core`/`apps/web` names and exercises this tool. 290 more (298 unit-referenced incl. the 8 e2e). |
| 🟡 | **Implemented, unverified** — registered, schema-gated (every new tool is `strict` and closed), reachable via discovery, but **no test names the tool directly**. Assume it works; verify before relying on it. 38 tools. |

Flags: ◐ read-only · 🧨 destructive · ⚡ expensive (needs confirmation) · ⚲ needs a live service / model / binary / network · 🔒 internal-only (never shown to the model).

**Read this honestly.** ✅ means "a test called this and the assertions held", not "flawless".
All effect/transition rendering paths are pixel-goldened (63 goldens); shader effects
additionally depend on WebGL2 — with SwiftShader present they render for real; without
it they render via the deterministic 2D approximation and log a loud diagnostic.
Export tools produce real files only where an encoder is available. Director tools that
require footage analysis refuse honestly (`ANALYSIS_REQUIRED`) instead of planning from guesses.

## At a glance

- **336 tools** registered across **23 domains**
- 🖥️ 8 e2e-proven · ✅ 298 with direct unit-test references (incl. the 8) · 🟡 38 without any direct test reference
- 47 read-only · 39 destructive · 20 expensive · 1 internal (`submit_edit_plan`)
- MCP exposure: the whole registry is exposed via `toMcpTools()`; discovery pair `search_tools` + `run_tool` makes every public tool callable even when the router did not select it

### The 8 e2e-proven tools

`add_video_effect`, `create_text_clip`, `extract_segments`, `plan_edit`, `set_clip_keyframes`, `submit_edit_plan`, `toggle_video_effect`, `update_text_clip`

## Domain index

| Domain | Tools | ✅ | 🖥️ | 🟡 |
| --- | ---: | ---: | ---: | ---: |
| `ai` | 12 | 8 | 2 | 2 |
| `clip` | 11 | 8 | 0 | 3 |
| `track` | 10 | 7 | 0 | 3 |
| `media` | 3 | 2 | 0 | 1 |
| `project` | 7 | 5 | 0 | 2 |
| `text` | 4 | 2 | 2 | 0 |
| `subtitle` | 5 | 4 | 0 | 1 |
| `graphics` | 9 | 9 | 0 | 0 |
| `effect` | 5 | 3 | 2 | 0 |
| `color` | 1 | 1 | 0 | 0 |
| `keyframe` | 3 | 1 | 1 | 1 |
| `transform` | 3 | 3 | 0 | 0 |
| `transition` | 3 | 3 | 0 | 0 |
| `marker` | 3 | 2 | 0 | 1 |
| `speed` | 6 | 6 | 0 | 0 |
| `audio` | 8 | 5 | 0 | 3 |
| `export` | 8 | 6 | 0 | 2 |
| `history` | 5 | 3 | 0 | 2 |
| `multicam` | 8 | 8 | 0 | 0 |
| `raw` | 3 | 3 | 0 | 0 |
| `read` | 28 | 26 | 0 | 2 |
| `internal` | 1 | 0 | 1 | 0 |
| `motion` | 190 | 167 | 0 | 23 |

---

## `ai` — 12 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `apply_subject_matte` | Analyze the subject and write the tracked matte onto a clip as normalized mask keyframes (creating a mask, or extending maskId), in ONE undo… | ✅ | 🧨 ⚡ ⚲ |
| `auto_reframe_clip` | Reframe one clip for a different aspect ratio (16:9 → 9:16 and so… | ✅ | 🧨 ⚡ ⚲ |
| `delegate_tasks` | Fan work out to specialist subagents instead of doing it all in your own… | ✅ | 🧨 ⚡ ⚲ |
| `detect_faces` | Sample a video clip or media item and detect faces with the local face model, then associate detections into stable tracks across frames (IoU tracking with EMA smoothing… | ✅ | ◐ ⚡ ⚲ |
| `expand_prompt` | Expand a vague or incomplete user prompt into a rich director's… | 🟡 | ◐ ⚲ |
| `expand_prompt_result` | Structured output for prompt… | 🟡 | ◐ |
| `extract_segments` | Analyze uploaded video(s) via real frame sampling, scene-cut detection, and vision analysis to build a SegmentMap describing what's actually happening in the… | 🖥️ | ⚡ ⚲ |
| `mirror_reference_1to1` | Compile locally extracted reference DNA into editable timeline clips, camera keyframes and optional per-shot grade… | ✅ | ⚡ ⚲ |
| `mirror_refine` | Sample actual decoded reference and composited timeline frames on the EditDNA rational clock, optimize motion/grade with grayscale SSIM and… | ✅ | ⚡ ⚲ |
| `plan_edit` | Given the user's prompt, have the director produce a structured EditPlan and commit it as ONE timeline… | 🖥️ | ⚡ ⚲ |
| `refine_matte_edges` | Re-cut the edge of a rotoscoped matte that is already on a mask: feather, expansion, invert and opacity, written per keyframe so the edge can vary over… | ✅ | 🧨 ⚲ |
| `rotoscope_subject` | Segment the main subject across sampled frames and reduce each matte to a simplified, normalized contour… | ✅ | ◐ ⚡ ⚲ |

---

## `clip` — 11 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_clip` | Add a media clip to a track at a time. | ✅ |  |
| `close_gap` | Close the gap before a clip. | 🟡 |  |
| `move_clip` | Move a clip to a new start time / track. | ✅ |  |
| `remove_clip` | Remove a clip. | ✅ | 🧨 |
| `ripple_delete_clip` | Delete a clip and close the gap. | 🟡 | 🧨 |
| `roll_edit` | Roll the edit point between two clips. | ✅ |  |
| `slide_clip` | Slide a clip by delta. | ✅ |  |
| `slip_clip` | Slip a clip's source by delta. | ✅ |  |
| `split_clip` | Split a clip at a time. | ✅ |  |
| `trim_clip` | Set a clip's in/out points (seconds). | ✅ |  |
| `trim_to_playhead` | Trim a clip's start/end to a time. | 🟡 |  |

---

## `track` — 10 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_track` | Add a track (video\|audio\|image\|text\|graphics). | ✅ |  |
| `consolidate_track` | Close gaps on a track. | ✅ |  |
| `duplicate_track` | Duplicate a timeline-backed video, image, or audio track with fresh track, clip, and transition… | ✅ |  |
| `hide_track` | Show/hide a track. | 🟡 |  |
| `lock_track` | Lock/unlock a track. | ✅ |  |
| `mute_track` | Mute/unmute a track. | 🟡 |  |
| `remove_track` | Remove a track and its clips. | ✅ | 🧨 |
| `rename_track` | Rename a track. | ✅ |  |
| `reorder_track` | Move a track to a new stacking position (0 = top of the timeline / front-most). | ✅ |  |
| `solo_track` | Solo/unsolo a track. | 🟡 |  |

---

## `media` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `delete_media` | Delete a media library item. | ✅ | 🧨 |
| `import_media_from_url` | Download an image, video, or audio file from a public http(s) URL… | ✅ | ⚲ |
| `rename_media` | Rename a media item. | 🟡 |  |

---

## `project` — 7 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `create_project` | Create a new blank project and make it… | ✅ |  |
| `list_projects` | List saved projects (id + name +… | ✅ | ◐ |
| `open_project` | Open a saved project by id and make it active. | ✅ |  |
| `rename_project` | Rename the project. | ✅ |  |
| `save_project` | Persist the active project so it can be reopened later. | ✅ |  |
| `set_canvas_background` | Set background fill mode/color. | 🟡 |  |
| `update_project_settings` | Update resolution/fps/etc. | 🟡 |  |

---

## `text` — 4 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `create_text_clip` | Create one text overlay. For multiple separate overlays, prefer create_text_clips so they are added in one tool… | 🖥️ |  |
| `create_text_clips` | Create a batch of 1-24 text overlays in one tool… | ✅ |  |
| `remove_text_clip` | Remove a text overlay clip. Engine-aware so the preview and export stop rendering it. | ✅ | 🧨 |
| `update_text_clip` | Update a text overlay clip's… | 🖥️ |  |

---

## `subtitle` — 5 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_subtitle` | Add a subtitle (text, start, end seconds). | ✅ |  |
| `import_srt` | Import subtitles from SRT content. | ✅ |  |
| `remove_subtitle` | Remove a subtitle. | 🟡 | 🧨 |
| `set_subtitle_style` | Set the global subtitle style. | ✅ |  |
| `update_subtitle` | Update a subtitle's text and/or timing (text, startTime, endTime seconds). | ✅ |  |

---

## `graphics` — 9 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `create_shape_clip` | Create a graphic/shape overlay that renders above the video and image tracks… | ✅ |  |
| `create_sticker_clip` | Create a sticker/emoji overlay that renders above the video… | ✅ |  |
| `create_svg_clip` | Create an SVG/vector graphic overlay from raw SVG… | ✅ |  |
| `remove_shape_clip` | Remove a shape overlay clip. Engine-aware so the preview and export stop rendering it. | ✅ | 🧨 |
| `remove_sticker_clip` | Remove a sticker overlay clip. Engine-aware so the preview and export stop rendering it. | ✅ | 🧨 |
| `remove_svg_clip` | Remove a svg overlay clip. Engine-aware so the preview and export stop rendering it. | ✅ | 🧨 |
| `update_shape_clip` | Update a shape overlay's… | ✅ |  |
| `update_sticker_clip` | Update a sticker overlay's transform… | ✅ |  |
| `update_svg_clip` | Update an SVG overlay's fields (transform, color style… | ✅ |  |

---

## `effect` — 5 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_video_effect` | Add a video effect to a clip. Standard effectType values include brightness, contrast, saturation, blur, sharpen, vignette, grain, temperature, tint, shadow, glow… | 🖥️ |  |
| `remove_video_effect` | Remove a clip's video effect. | ✅ |  |
| `set_effect_order` | Set the full effect order for a clip. | ✅ |  |
| `toggle_video_effect` | Enable/disable a video effect. | 🖥️ |  |
| `update_video_effect` | Update a video effect's… | ✅ |  |

---

## `color` — 1 tool

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `set_color_grading` | Set a clip's color grading (wheels/curves/lut/hsl/temp/tint). | ✅ |  |

---

## `keyframe` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_keyframe` | Add a keyframe for a clip property. | ✅ |  |
| `remove_keyframe` | Remove a keyframe. | 🟡 |  |
| `set_clip_keyframes` | Replace all keyframes on a clip. | 🖥️ |  |

---

## `transform` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `set_clip_blend_mode` | Set a clip's blend mode. | ✅ |  |
| `set_clip_blend_opacity` | Set a clip's blend opacity (0..1). | ✅ |  |
| `set_clip_transform` | Set position/scale/rotation/opacity/crop/fitMode. | ✅ |  |

---

## `transition` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_transition` | Add a transition between two… | ✅ |  |
| `remove_transition` | Remove a transition. | ✅ |  |
| `update_transition` | Update a transition. | ✅ |  |

---

## `marker` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_marker` | Add a timeline marker. | ✅ |  |
| `remove_marker` | Remove a marker. | 🟡 |  |
| `update_marker` | Update a marker. | ✅ |  |

---

## `speed` — 6 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `set_clip_chroma_key` | Set green-screen / chroma-key settings. | ✅ |  |
| `set_clip_pitch_correction` | Toggle pitch correction on speed changes. | ✅ |  |
| `set_clip_reverse` | Toggle clip reverse. | ✅ |  |
| `set_clip_speed` | Set clip playback speed (recomputes duration). | ✅ |  |
| `set_clip_stabilization` | Set clip stabilization settings. | ✅ |  |
| `set_speed_ramp` | Set speed keyframes / freeze frames / pitch. | ✅ |  |

---

## `audio` — 8 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_audio_automation` | Add audio automation points. | ✅ |  |
| `add_audio_effect` | Add an audio effect to a clip. | ✅ |  |
| `measure_loudness` | Measure programme loudness of a clip's or media item's SOURCE audio per ITU-R BS.1770-4 / EBU R128: integrated LUFS (gated), loudness range (LU, EBU Tech 3342)… | ✅ | ◐ ⚡ |
| `remove_audio_effect` | Remove an audio effect. | 🟡 |  |
| `set_clip_fade` | Set audio fade in/out seconds. | ✅ |  |
| `set_clip_volume` | Set a clip's volume (0..1+). | ✅ |  |
| `toggle_audio_effect` | Enable/disable an audio effect. | 🟡 |  |
| `update_audio_effect` | Update an audio effect's params. | 🟡 |  |

---

## `export` — 8 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `cancel_motion_render_item` | Cancel a queued or in-progress motion render queue item by… | ✅ |  |
| `export_audio` | Render the project audio to a local file (format: mp3\|wav\|aac\|flac\|ogg, default wav) and return its local result… | 🟡 | ⚡ ⚲ |
| `export_motion_video` | Render a motion composition to a finished video file and return the filename plus width/height/duration/framesRendered and the format actually… | ✅ | ⚡ ⚲ |
| `export_video` | Render the whole project to a local video file (format: mp4\|webm\|mov, default mp4) and return its local result… | 🟡 | ⚡ ⚲ |
| `list_motion_render_queue` | List the current motion render queue items (data.items with itemId, compositionId, format, status, progress, and any range/resolutionScale/filename/error). | ✅ | ◐ |
| `measure_export` | Run ffmpeg/ffprobe QC on an exported media FILE (path): integrated loudness + true peak (EBU R128), black-frame / silence / freeze detection, and container-duration… | ✅ | ◐ ⚲ |
| `queue_motion_render` | Add a motion composition to the render queue for later batch… | ✅ |  |
| `run_motion_render_queue` | Render every queued (or previously failed) item in the motion render queue sequentially and return per-item outcomes (data.outcomes: itemId, status, encodedFormat… | ✅ | ⚡ ⚲ |

---

## `history` — 5 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `create_checkpoint` | Mark the current project state so you can return to it with… | ✅ |  |
| `list_checkpoints` | List checkpoints that can still be restored (oldest… | 🟡 | ◐ |
| `redo` | Re-apply the step you most recently undid (with undo or… | ✅ |  |
| `restore_checkpoint` | Revert the project to a checkpoint created earlier with create_checkpoint, undoing everything done after… | 🟡 |  |
| `undo` | Undo your own most recent… | ✅ |  |

---

## `multicam` — 8 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `annotate_segment` | Attach a concise planning note to a bounded multicam time range (startTime/endTime in SECONDS) without modifying cached… | ✅ |  |
| `get_activity_map` | Read the reusable .orma speech activity map for an optional range in SECONDS… | ✅ | ◐ |
| `get_edit_summary` | Summarize shots, layouts, pending cut review, annotations, and top deterministic social… | ✅ | ◐ |
| `get_project_manifest` | Return the exact kove-advanced-multicam/v1 manifest for a camera group, including participants, camera subjects, sync reference, and hard constraints. | ✅ | ◐ |
| `get_transcript` | Read optional per-participant local Whisper transcript segments from the separate .orma artifact, for an optional range in SECONDS… | ✅ | ◐ |
| `override_cut` | Accept, reject, nudge by at most 2 seconds (delta, in SECONDS), or assign a valid manifest camera to one generated… | ✅ | 🧨 |
| `preview_frame` | Render a frame at a bounded time (time, in SECONDS; timeMs is a deprecated milliseconds alias) for visual inspection of the current multicam… | ✅ | ◐ ⚡ |
| `set_edit_policy` | Re-plan the automatic multicam edit from cached… | ✅ | 🧨 |

---

## `raw` — 3 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `batch_actions` | Dispatch a sequence of raw actions in order; stops on first failure. | ✅ | 🧨 |
| `execute_action` | Escape hatch: dispatch any underlying editor action by type +… | ✅ | 🧨 |
| `run_tool` | Call a tool that is not in this turn's tool list — look it up with search_tools… | ✅ |  |

---

## `read` — 28 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `critique_creation_scene` | Analyze a persisted creation scene and return warnings plus suggested next tools: empty scenes, objects missing assets/materials, missing/stale/partial render bindings… | ✅ | ◐ |
| `evaluate_creation_material_graph` | Evaluate a node-based material graph (color/scalar/mix/multiply/output nodes) with the CPU material engine to a final PBR descriptor (baseColor, metallic, roughness… | ✅ | ◐ |
| `export_creation_scene_gltf` | Bake an entire persisted creation scene into one merged CPU-generated triangle mesh and return scene poly stats, per-object stats, and (by default) a glTF 2.0 export… | ✅ | ◐ |
| `get_capabilities` | Valid enums + parameter ranges, plus `host`: what this host can actually do (renderMotionFrame, renderTimelineFrame, renderMulticamPreview, exportVideo… | ✅ | ◐ |
| `get_clip` | Full detail for one clip by id. | ✅ | ◐ |
| `get_creation_asset` | Full persisted creation asset recipe by assetId, including recipe nodes, materials, dependencies, and cache refs. | 🟡 | ◐ |
| `get_creation_capabilities` | Agent-native creation vocabulary, supported editable 3D object/material/environment kinds, and the preferred create/sync/preview/edit workflow. | ✅ | ◐ |
| `get_creation_history` | List recent persisted creation operations (asset/scene/camera/scene-object/animation upserts and removals) with their source, label, and target ids — for agent review… | ✅ | ◐ |
| `get_creation_scene` | Full persisted semantic creation scene by… | ✅ | ◐ |
| `get_editor_state` | Project settings, durations, and counts. | ✅ | ◐ |
| `get_motion_composition` | Full detail for one Motion Creator composition: every layer with its id, type, transform, keyframes, and type-specific fields, plus variables, markers, beat markers… | ✅ | ◐ |
| `inspect_3d_model` | Load and inspect a GLB/glTF model before rigging, retargeting, animation binding, cleanup, or scene… | ✅ | ◐ |
| `inspect_creation_product_parts` | Compact edit map for semantic product/creation scene parts: object ids, part ids, asset/material ids, render bindings, recipe features, cache status, and animation… | ✅ | ◐ |
| `list_action_types` | Every editor action type this build can dispatch, plus the action domains the executor routes by… | ✅ | ◐ |
| `list_clips` | Compact clip list. Optional filters: trackIndex, fromSec, toSec; paginate huge timelines with offset/limit. | ✅ | ◐ |
| `list_creation_assets` | Compact list of persisted Kove Advanced creation assets/recipes generated or edited by agents. | ✅ | ◐ |
| `list_creation_scenes` | Compact list of persisted semantic 3D creation scenes, including object/camera/light/animation counts. | ✅ | ◐ |
| `list_media` | Media library items (blob-free), including whether each video is source footage or a marked… | ✅ | ◐ |
| `list_motion_animatable_properties` | List the animatable properties of a motion layer (Transform always; Shape/Particle/Precomp by type; plus this layer's masks, effects, shape modifiers, and puppet pins)… | ✅ | ◐ |
| `list_motion_compositions` | Compact list of Motion Creator scenes, layers, variables, and editor instances. | ✅ | ◐ |
| `list_tracks` | All timeline tracks. | 🟡 | ◐ |
| `probe_rigging_backend` | Check whether the desktop Blender rigging backend is available before attempting character rigging, animation retargeting, or GLB cleanup jobs. | ✅ | ◐ |
| `render_creation_scene_image` | Render a persisted creation scene to a real image with the built-in deterministic CPU renderer: bakes the scene mesh, projects it through the scene camera, and returns… | ✅ | ◐ |
| `render_timeline_frame` | Render the composited main timeline (all tracks, effects, text, transitions) at one instant and return it as an image you can look… | ✅ | ◐ ⚡ |
| `search_tools` | Find tools by keyword. The per-turn tool list only carries a relevant subset of the registry, so use this when nothing you were given matches what the user asked for — a… | ✅ | ◐ |
| `simulate_creation_cloth` | Run the CPU mass-spring cloth solver for a flag/sheet and return the simulated mesh statistics (vertex/triangle counts… | ✅ | ◐ |
| `solve_creation_ik` | Compute two-bone (upper + lower limb) inverse kinematics with the CPU rig solver: given a root/shoulder position, a target/hand position, and bone lengths, returns the… | ✅ | ◐ |
| `validate_creation_state` | Validate persisted creation assets/scenes for broken references, invalid active scene/camera ids, and animation target issues. | ✅ | ◐ |

---

## `internal` — 1 tool

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `submit_edit_plan` | Internal-only: used by the director sub-call to return a structured EditPlan. | 🖥️ | ◐ 🔒 |

---

## `motion` — 190 tools

| Tool | What it does | St | Flags |
| --- | --- | :-: | --- |
| `add_creation_camera_module` | Add an editable semantic camera module assembly to an existing creation scene and sync every component into the bound scene3d… | ✅ |  |
| `add_creation_character` | Build an editable recipe-driven humanoid character (pelvis, torso, neck, head, two arms with forearms and hands, two legs with feet, plus optional helmet, visor, and… | ✅ |  |
| `add_creation_cutaway_plane` | Add an editable semantic cutaway plane to a creation/product scene and sync it as a translucent scene3d plane… | ✅ |  |
| `add_creation_decal` | Add an editable semantic decal/logo/marking to a creation scene surface and sync it as a scene3d plane or text3d… | ✅ |  |
| `add_creation_light_sweep` | Add an editable animated highlight/light sweep to an existing creation scene and sync it into the bound scene3d… | ✅ |  |
| `add_creation_particle_system` | Add an editable procedural particle system (stars, dust, sparks, embers, snow, confetti, bokeh) to a creation scene and sync every particle into the bound scene3d… | ✅ |  |
| `add_creation_procedural_texture` | Apply an editable procedural base texture/pattern (noise, voronoi, fbm, marble, circuit, fabric-weave, lunar-dust, hex-grid, gradient, brushed) to selected creation… | ✅ |  |
| `add_creation_product_callout` | Add an editable Motion text callout to a semantic product/creation scene and record it in the scene's motion-scene3d render… | ✅ |  |
| `add_creation_product_internals` | Add an editable semantic internal product layout to an existing creation scene and sync every component into the bound scene3d… | ✅ |  |
| `add_creation_product_part` | Add one editable semantic product part to an existing creation scene and sync it into the bound scene3d… | ✅ |  |
| `add_creation_scene_object` | Append one editable semantic object to an existing Kove Advanced creation scene and sync the bound Motion Creator scene3d layer when a render binding… | ✅ |  |
| `add_creation_screen_stack` | Add an editable layered product display stack to an existing creation scene and sync every layer into the bound scene3d… | ✅ |  |
| `add_creation_ui_panel` | Add an editable 3D UI/screen/holographic panel to a creation scene and sync it as a scene3d plane with editable text3d child… | ✅ |  |
| `add_motion_3d_object` | Add a TRUE 3D object (WebGL/Three.js under the hood) to a composition — it renders with real depth and rotates so every side is visible (unlike the 2.5D… | ✅ |  |
| `add_motion_3d_scene` | Create ONE scene3d layer that is a FULL 3D WORLD — many objects sharing a camera, lights, and an optional room — instead of a single… | ✅ |  |
| `add_motion_component_instance` | Stamp another instance of a component: duplicate an existing precomp (composition) layer so it references the same master… | ✅ |  |
| `add_motion_cursor_click` | Drop an animated mouse cursor that travels to a target layer, click-presses on arrival, and makes the target react (a Click Press pulse) — the classic UI-demo 'a hand… | ✅ |  |
| `add_motion_effect` | Add an effect (blur\|drop-shadow\|glow\|color-adjust\|invert\|grayscale\|sepia\|levels\|sharpen\|posterize\|directional-blur\|noise\|radial-blur\|displace\|backdrop-blur) to a layer… | ✅ |  |
| `add_motion_expression_control` | Add an expression-control effect (Slider/Checkbox/Angle) to a… | ✅ |  |
| `add_motion_guide` | Add a ruler guide to the composition… | ✅ |  |
| `add_motion_keyframe` | Add or update a single keyframe at a time on a motion layer property (the AE 'stopwatch + set value at playhead'… | ✅ |  |
| `add_motion_layer` | Add a layer to a Motion Creator… | ✅ |  |
| `add_motion_layers` | Create MANY layers in ONE call to reconstruct a full UI… | ✅ |  |
| `add_motion_light` | Add a light (ambient\|point\|directional) to the… | ✅ |  |
| `add_motion_marker` | Add a composition marker (a labelled timeline cue) at `time`… | ✅ |  |
| `add_motion_mask` | Add a rectangle, ellipse, polygon, or path (bezier) mask to a… | ✅ |  |
| `add_motion_mask_path_keyframe` | Add or replace a mask-path keyframe (rotoscoping) at a time on a path… | ✅ |  |
| `add_motion_shader_effect` | Add a GPU post-process shader effect to any visual… | ✅ |  |
| `add_motion_shape_group` | Add an intra-layer shape group to a shape layer's contents tree (the AE "Group (Shift+Cmd+G)" / compound-path… | ✅ |  |
| `add_motion_shape_group_operator` | Append an operator to a shape group's ordered operator stack (applied left-to-right after the group's… | ✅ |  |
| `add_motion_shape_modifier` | Add a shape modifier (trim-paths\|repeater\|zig-zag\|round-corners\|wiggle-paths\|offset-paths\|pucker-bloat\|twist) to a shape… | ✅ |  |
| `add_motion_shape_path_keyframe` | Add or replace a shape.pathData keyframe at a time on a bezier PEN shape layer (shapeType 'path') so its outline animates/morphs over… | ✅ |  |
| `add_motion_shape_to_group` | Add a path/shape item to a shape layer's contents… | ✅ |  |
| `add_motion_text_animator` | Add a per-glyph text animator preset… | ✅ |  |
| `add_motion_text_shader_animator` | Add a per-glyph GPU shader animator (glyph-dissolve\|glyph-glow-wave\|chromatic-cascade\|scanline-materialize) to a text… | ✅ |  |
| `add_motion_ui_component` | Add a high-level UI component built from native shape/text layers and grouped… | ✅ |  |
| `add_scene_object` | Append one object to an existing scene3d layer (created by… | ✅ |  |
| `align_motion_layers` | Align layers by edge or… | ✅ |  |
| `animate_creation_camera` | Create or replace semantic animation tracks for a creation scene camera and sync the bound Motion Creator scene3d camera… | ✅ |  |
| `animate_creation_exploded_view` | Create or replace a semantic multi-object exploded-view animation for agent-native product parts or arbitrary creation objects, store per-object exploded-view recipe… | ✅ |  |
| `animate_creation_object` | Create or replace semantic animation tracks for a creation scene object and sync the bound Motion Creator scene3d render object when a render binding… | ✅ |  |
| `animate_layer` | Author keyframes on a layer property… | ✅ |  |
| `animate_motion_camera` | Keyframe the composition camera over time — comp-level push-in, dolly, orbit, or… | ✅ |  |
| `animate_motion_layers` | Apply an animation preset to MANY layers at once with a per-layer stagger … | ✅ |  |
| `animate_motion_light` | Keyframe a composition light property over time by… | ✅ |  |
| `animate_scene_camera` | Keyframe the cinematic camera of a scene3d layer — the 'camera at this angle at this time, move this way, orbit this point'… | ✅ |  |
| `animate_scene_object` | Keyframe one object inside a scene3d layer in TRUE 3D over time — shake, spin, lift… | ✅ |  |
| `apply_creation_array` | Repeat a semantic creation object's geometry into an editable row/grid of evenly-offset copies merged into one mesh, baked into the bound scene3d… | ✅ |  |
| `apply_creation_bevel` | Apply an editable bevel/chamfer recipe node to selected semantic creation objects and sync a rounded preview into bound scene3d render… | ✅ |  |
| `apply_creation_boolean` | Carve, fuse, intersect, or smooth-blend a semantic creation object's geometry with a procedural tool shape (sphere/box) using robust signed-distance-field CSG, then bake… | ✅ |  |
| `apply_creation_cloth_wave` | Add a first-pass procedural cloth/flag wave to a semantic creation… | ✅ |  |
| `apply_creation_displacement` | Apply editable procedural displacement metadata to selected semantic creation objects and sync a terrain/relief preview into bound scene3d… | ✅ |  |
| `apply_creation_material_graph` | Evaluate a node-based material graph (color/scalar/mix/multiply/output nodes) and apply the resolved PBR descriptor (base color, metallic, roughness, emissive) to… | ✅ |  |
| `apply_creation_material_preset` | Apply a production-friendly semantic material preset to a creation scene object and sync the bound scene3d render… | ✅ |  |
| `apply_creation_surface_detail` | Add editable procedural surface detail such as scratches, dust, fingerprints, smudges, edge wear, or grime to selected creation scene… | ✅ |  |
| `apply_creation_texture_map` | Bake a procedural texture (noise, voronoi, fbm, marble, circuit, fabric-weave, lunar-dust, hex-grid, gradient, brushed, checker) into a real image and apply it as the… | ✅ |  |
| `apply_creation_xray_material` | Make selected semantic creation objects render as editable X-ray/ghosted materials so product internals, cutaways, and exploded assemblies are… | ✅ |  |
| `apply_motion_preset_to_beats` | Apply an animation preset to a layer at every detected beat (run sync_motion_to_audio or set_motion_beat_markers… | ✅ |  |
| `apply_motion_template` | Create a new Motion Creator composition from a built-in motion template/preset. | ✅ |  |
| `arrange_motion_layers` | Lay out layers precisely. mode is stack-vertical, stack-horizontal, or… | ✅ |  |
| `attach_motion_expression` | Attach an expression to an animatable layer… | ✅ |  |
| `bake_creation_asset` | Bake a persisted creation asset's procedural recipe into a real CPU-generated triangle mesh, update its mesh cache to ready with bounds and vertex/triangle stats, and… | ✅ |  |
| `bake_creation_cloth` | Bake a deterministic mass-spring (Verlet) cloth simulation onto a selected creation surface (a plane/panel) — pinned edges, gravity, damping, and wind — into a per-frame… | ✅ |  |
| `bake_creation_humanoid` | Turn a selected creation object into a SKINNED humanoid character (pelvis/spine/chest/neck/head, two arms, two legs as one bone-rigged mesh) animated with a chosen… | ✅ |  |
| `bake_creation_particles` | Turn a selected creation object into a deterministic particle burst (stars, sparks, embers, confetti, dust, snow, debris) simulated under gravity, drag, and wind, baked… | ✅ |  |
| `bake_creation_skinned_limb` | Turn a selected creation object into a smoothly-deforming skinned limb (a bone chain + linear-blend skinning) animated with a traveling-wave curl, baked into a per-frame… | ✅ |  |
| `bake_creation_texture` | Bake a procedural texture for a creation object's material into a real CPU-generated image: compute its average color, mark a ready texture cache, optionally drive the… | ✅ |  |
| `bind_motion_variable` | Bind a composition variable to a compatible layer target… | 🟡 |  |
| `clear_motion_shader_fill` | Remove a procedural GPU fill shader previously applied with… | ✅ |  |
| `copy_motion_keyframes` | Read a motion layer property's keyframes into a portable clipboard payload (relative time offsets, values, and easings) for inspection or for feeding… | ✅ | ◐ |
| `create_ai_shader` | Register a new AI-authored GPU shader (GLSL + params) into the project's shader library so it can be used like a built-in via set_motion_shader_fill / add_motion_effect… | ✅ |  |
| `create_creation_3d_scene` | Create a semantic Kove Advanced creation scene and a renderable Motion Creator scene3d composition in one… | ✅ |  |
| `create_motion_composition` | Create a standalone Motion Creator composition with starter… | ✅ |  |
| `create_motion_null_controller` | Create a null layer positioned at the average of the given layers and parent all of them to it, so transforming the null drives them together (AE null-object… | ✅ |  |
| `create_motion_variable` | Create a composition variable… | 🟡 |  |
| `create_product_cinematic_scene` | Create an editable high-detail product cinematic inside Motion Creator: a semantic multi-object 3D product assembly with materials, exploded-view animation, camera… | ✅ |  |
| `delete_motion_composition` | Delete a Motion Creator composition by… | ✅ | 🧨 |
| `delete_motion_variable` | Delete a composition variable by… | ✅ | 🧨 |
| `disintegrate_motion_layer` | After-Effects-style disintegration: fade the target layer out while spawning a matching particle burst from its position (colored from its fill/text color), so it… | ✅ |  |
| `distribute_motion_layers` | Evenly distribute 3+ layers along an axis (horizontal\|vertical) so spacing between centers is equal. | ✅ |  |
| `duplicate_creation_object` | Duplicate one semantic creation object into an independent editable variant (its own asset and material) and sync it into the bound scene3d… | ✅ |  |
| `duplicate_motion_composition` | Deep-clone a Motion Creator composition into a new standalone composition with fresh ids for every layer, keyframe, mask, effect, text animator, expression, marker… | ✅ |  |
| `duplicate_motion_layer` | Duplicate one or more layers (with their keyframes, effects, masks, and… | ✅ |  |
| `edit_motion_shape_path_point` | Edit a single vertex (by index, 0-based) of a bezier PEN shape layer (shapeType… | ✅ |  |
| `generate_ad_scene` | Create a practical SaaS/product ad motion scene from headline/subheadline/brand color fields. | ✅ |  |
| `group_motion_layers` | Wrap layers into a new group layer (Figma-style), reparenting them while preserving their stage… | ✅ |  |
| `import_figma_composition` | Import a Figma frame JSON export as a new Motion Creator… | 🟡 |  |
| `import_image_layer` | Add a real image (logo/screenshot/icon) into a composition from a public URL or a data… | ✅ |  |
| `import_lottie_composition` | Import a Lottie animation JSON object as a new Motion Creator… | 🟡 |  |
| `import_motion_font` | Register a custom font on a composition so text layers can use… | ✅ |  |
| `import_svg_composition` | Import raw SVG markup as a new Motion Creator composition (shapes/text become native motion… | ✅ |  |
| `insert_motion_into_editor` | Place a motion composition into the normal video-editor timeline as a reusable rendered scene. | ✅ |  |
| `insert_motion_shape_path_point` | Insert a vertex into a bezier PEN shape layer (shapeType 'path') AFTER the given index… | ✅ |  |
| `list_ai_shaders` | List the AI-authored (generated) shaders registered in the current project, each with its id, name, category, and… | ✅ | ◐ |
| `list_motion_expression_errors` | Evaluate every enabled expression in a composition and return the compile/cycle/runtime errors, one entry per failing expression: { layerId, property, expressionId… | ✅ | ◐ |
| `list_motion_shaders` | Enumerate the built-in GPU shader library for Motion… | ✅ | ◐ |
| `merge_motion_shape_layers` | Collapse >=2 shape layers into one grouped shape layer with a Merge Paths mode (the AE compound-icon… | ✅ | 🧨 |
| `morph_motion_layers` | Morph one whole layer/view INTO another (After-Effects crossfade + transform tween): layer A fades out while layer B fades in starting from A's position/scale/rotation… | ✅ |  |
| `morph_motion_shape` | Animate a shape MORPHING into a different shape (After Effects-style path morph): the outline smoothly transforms, point-by-point, from one form to… | 🟡 |  |
| `move_motion_guide` | Move an existing composition guide to a new position (pixels along its… | ✅ |  |
| `move_motion_keyframe` | Retime a single existing keyframe (by keyframeId) to a new time on a motion layer — like dragging a key in the AE… | ✅ |  |
| `move_motion_shape_item` | Reorder a shape contents item within its parent (direction… | ✅ |  |
| `paste_motion_keyframes` | Copy every keyframe from fromProperty and paste them onto toProperty of the SAME layer, preserving relative spacing and easing, shifted so the run starts at… | ✅ |  |
| `pose_creation_character` | Apply an editable pose/gesture animation (wave, idle, point, cheer, t-pose, a-pose) to a creation character's arm/torso/head parts and sync the bound scene3d rotation… | ✅ |  |
| `precompose_motion_layers` | Pull the given layers into a new nested composition (a reusable 'component' / precomp) and replace them in place with a single composition layer that references… | ✅ |  |
| `recover_motion_scene3d_to_creation` | Convert an existing multi-object Motion Creator scene3d layer into editable semantic creation assets/objects and a motion-scene3d render… | ✅ |  |
| `remove_ai_shader` | Remove an AI-authored (generated) shader from the project's shader library by its shaderId (as returned by create_ai_shader /… | ✅ | 🧨 |
| `remove_creation_scene_object` | Remove a semantic creation scene object and sync any bound Motion Creator scene3d render… | ✅ | 🧨 |
| `remove_motion_beat_marker` | Remove a single beat marker from the composition by its `index` (0-based position in the beat marker… | ✅ | 🧨 |
| `remove_motion_effect` | Remove an effect from a layer by effectId. | ✅ | 🧨 |
| `remove_motion_expression` | Remove an expression from a layer by expressionId. | 🟡 | 🧨 |
| `remove_motion_guide` | Remove a ruler guide from the composition canvas by guideId. | ✅ | 🧨 |
| `remove_motion_keyframe` | Delete a single keyframe (by keyframeId) from a motion layer, or pass property to clear ALL keyframes on that property (turn the property back into a static… | ✅ | 🧨 |
| `remove_motion_layer` | Delete one or more layers from a… | ✅ | 🧨 |
| `remove_motion_light` | Remove a light from the composition by lightId. | 🟡 | 🧨 |
| `remove_motion_marker` | Remove a composition marker by markerId. | ✅ | 🧨 |
| `remove_motion_mask` | Remove a mask from a layer by maskId. | 🟡 | 🧨 |
| `remove_motion_scene_object` | Remove one object from a multi-object scene3d layer by… | ✅ | 🧨 |
| `remove_motion_shape_group_operator` | Remove an operator from a shape group's operator stack by… | ✅ | 🧨 |
| `remove_motion_shape_item` | Remove a shape contents item (group or path) by itemId from a shape layer, pruning it from wherever it is… | ✅ | 🧨 |
| `remove_motion_shape_modifier` | Remove a shape modifier from a shape layer by modifierId. | 🟡 | 🧨 |
| `remove_motion_shape_path_point` | Remove the vertex at index (0-based) from a bezier PEN shape layer (shapeType… | ✅ |  |
| `remove_motion_text_animator` | Remove a text animator from a text layer by animatorId. | 🟡 | 🧨 |
| `render_creation_preview` | Render a still preview image for a semantic Kove Advanced creation scene by resolving its bound Motion Creator scene3d… | ✅ | ⚡ |
| `render_motion_frame` | Render a Motion Creator composition to a still image at a given time so YOU can SEE the current result and self-correct (layout, z-order, color, text… | ✅ | ⚡ |
| `reorder_motion_effect` | Move an effect one slot within a layer's effect… | ✅ |  |
| `reorder_motion_layer` | Change a layer's stacking order in the… | ✅ |  |
| `rig_humanoid_model` | Run the desktop Blender rigging backend to create or repair a humanoid armature for a GLB/glTF model and export a rigged… | ✅ | ⚡ |
| `ripple_delete_motion_layer` | Delete a layer and pull every later layer earlier by the deleted layer's duration, closing the gap it left (AE ripple… | ✅ | 🧨 |
| `ripple_motion_layers` | Shift every layer whose startTime is at or after fromTime (seconds) later or earlier by delta seconds, opening or closing time as a block (AE ripple… | ✅ |  |
| `scatter_creation_objects` | Duplicate one semantic creation object into many editable scene instances using deterministic grid, line, ring, or seeded-random patterns, then sync the new instances… | ✅ |  |
| `set_creation_camera` | Update a semantic creation scene camera and sync the bound Motion Creator scene3d… | ✅ |  |
| `set_creation_object_geometry` | Update what a semantic creation scene object is, then sync the bound Motion Creator scene3d render object when a render binding… | ✅ |  |
| `set_creation_object_material` | Assign and/or edit the material for a semantic creation scene object, then sync the bound Motion Creator scene3d render object when a render binding… | ✅ |  |
| `set_creation_object_transform` | Update a semantic creation scene object's 3D transform and sync the bound Motion Creator scene3d render object when a render binding… | ✅ |  |
| `set_creation_scene_environment` | Update a semantic creation scene's environment, light rig, room/floor colors, and realtime scene3d… | ✅ |  |
| `set_model_animation` | Bind a GLB/glTF animation clip to a model inside a scene3d layer so Motion Creator renders the rigged model over time instead of as a static… | ✅ |  |
| `set_motion_beat_markers` | Set the composition's beat markers explicitly from an array of `times`… | ✅ |  |
| `set_motion_blur` | Configure composition-wide motion… | ✅ |  |
| `set_motion_camera` | Enable and configure the composition… | 🟡 |  |
| `set_motion_group_auto_layout` | Turn a group into a Figma-style auto-layout frame: its children pack into a centered row (horizontal) or column (vertical) with a fixed gap, and re-pack automatically… | ✅ |  |
| `set_motion_instance_overrides` | Override text and/or color on individual child layers of a component INSTANCE, without touching the master component or its other… | ✅ |  |
| `set_motion_layer_3d` | Toggle a 2D layer's 3D container… | ✅ |  |
| `set_motion_layer_blend_mode` | Set a layer's blend mode (see get_capabilities motion.blendModes / blendModes). | ✅ |  |
| `set_motion_layer_guide` | Toggle a layer's guideLayer… | ✅ |  |
| `set_motion_layer_lock` | Lock or unlock a motion layer. | 🟡 |  |
| `set_motion_layer_motion_blur` | Enable or disable motion blur for a single layer by layerId (per-layer… | ✅ |  |
| `set_motion_layer_name` | Rename any layer in a… | ✅ |  |
| `set_motion_layer_parent` | Parent one layer to another so it inherits the parent's… | ✅ |  |
| `set_motion_layer_solo` | Toggle a layer's solo flag. solo=true isolates soloed layers in preview/render (all non-soloed, non-guide layers are… | ✅ |  |
| `set_motion_layer_timing` | Move a layer on the timeline by setting its startTime and/or duration… | ✅ |  |
| `set_motion_layer_transform` | Set a layer's static transform without… | ✅ |  |
| `set_motion_layer_visibility` | Show or hide a motion layer. | ✅ |  |
| `set_motion_light_style` | Update a light's non-numeric style by… | ✅ |  |
| `set_motion_mask_path` | Replace a path mask's bezier… | ✅ |  |
| `set_motion_scene3d_lighting` | Set lighting + image-based environment on a scene3d layer (EEVEE-class Three.js… | ✅ |  |
| `set_motion_scene_camera` | Set the static (non-animated) cinematic camera on a scene3d… | ✅ |  |
| `set_motion_scene_object` | Statically edit one object inside a multi-object scene3d layer (created by… | ✅ |  |
| `set_motion_shader_fill` | Paint a shape or text layer with a procedural GPU fill… | ✅ |  |
| `set_motion_shape_path` | Replace the whole outline of a bezier PEN shape layer (shapeType… | ✅ |  |
| `set_motion_shape_style` | Set the full visual style of a shape layer so any card/button/panel look is… | ✅ |  |
| `set_motion_text_content` | Replace the source text string of an existing text… | ✅ |  |
| `set_motion_text_style` | Set the full visual style of a text… | ✅ |  |
| `set_motion_time_remap` | Time-remap a precomp (composition) layer — retime, freeze, reverse, or hand-key its source… | ✅ |  |
| `set_motion_track_matte` | Set, toggle, or clear a track matte on a layer, using another layer as the matte… | ✅ |  |
| `simulate_creation_rigid_bodies` | Bake a deterministic rigid-body physics simulation onto creation objects: each object drops from an optional height under gravity and collides with the ground AND with… | ✅ |  |
| `simulate_creation_rigid_drop` | Bake a deterministic rigid-body drop-and-settle simulation onto creation objects: each object falls under gravity from a drop height and bounces to rest, baked to… | ✅ |  |
| `slip_motion_layer` | Slip a layer's source content by delta seconds while holding its timeline startTime and duration fixed (shifts the layer's timeOffset by delta scaled by… | ✅ |  |
| `split_motion_layer` | Split a layer into two at a composition-time… | ✅ |  |
| `sync_creation_scene_to_motion` | Create, repair, or refresh the Motion Creator scene3d composition/layer for a persisted semantic Kove Advanced creation… | ✅ |  |
| `sync_motion_to_audio` | Sync a motion composition to… | ✅ | ⚡ |
| `toggle_motion_effect` | Enable or disable an effect on a layer by effectId. | ✅ |  |
| `toggle_motion_expression` | Enable or disable an expression on a layer by expressionId without removing… | ✅ |  |
| `transfer_motion_effect_stack` | Copy a source layer's complete ordered effect stack, including animated parameters and expressions, to one or more target… | ✅ |  |
| `transfer_motion_mask_stack` | Copy a source layer's complete mask stack, including animated mask properties, path keyframes, and expressions, to one or more target… | ✅ |  |
| `transform_motion_keyframes` | Batch-transform ALL keyframes of one property on a motion layer (the AE graph-editor keyframe… | ✅ |  |
| `trim_motion_layer` | Trim a layer's in or out point to a composition-time… | ✅ |  |
| `unbind_motion_variable` | Remove a variable binding from a layer by bindingId. | 🟡 | 🧨 |
| `ungroup_motion_layers` | Dissolve one or more group layers, re-parenting their children to the group's parent (or the composition root) while preserving stage… | ✅ | 🧨 |
| `update_motion_composition` | Update a composition's top-level… | ✅ |  |
| `update_motion_effect` | Update a numeric effect parameter (radius\|opacity\|blur\|offsetX\|offsetY\|intensity\|brightness\|contrast\|saturation\|hue\|value\|...) by… | ✅ |  |
| `update_motion_expression` | Patch an existing expression in place (keeps its id, property, and enabled… | ✅ |  |
| `update_motion_light` | Update a light's numeric property by… | 🟡 |  |
| `update_motion_marker` | Update a composition marker by… | ✅ |  |
| `update_motion_mask` | Update a mask's geometry/options by… | 🟡 |  |
| `update_motion_shape_group_operator` | Update a group operator's numeric fields… | ✅ |  |
| `update_motion_shape_item` | Patch a shape contents item (group or path) by… | ✅ |  |
| `update_motion_shape_modifier` | Update numeric fields on a shape modifier by modifierId… | ✅ |  |
| `update_motion_text_animator` | Update an existing per-glyph text animator on a text layer by… | ✅ |  |
| `update_motion_variable` | Update a composition variable by… | ✅ |  |

---

## Missing but necessary — the tools that do not exist yet

Measured against the audit gap list (`docs/AGENT-PARITY-AUDIT.md` §5). "Would-be tool"
is a proposed name/shape, not a commitment. Nothing in this section is registered today.

### P0 — professionals cannot adopt Kove without these

| Would-be tool(s) | What it must do | Why it is needed |
| --- | --- | --- |
| `import_timeline` | Read OTIO `.otio`: tracks, clips, gaps, markers, transitions, speed, source ranges | Openflow Interchange is the interchange baseline (Resolve ≥18, Avid 2026.8, Kdenlive, Olive). Without it, every Resolve/Premiere-shop eval dies at ingest. |
| `export_timeline` | Write OTIO from the project model | The reverse path; must round-trip without drift. |
| `export_fcpxml` | Final Cut XML export | Final Cut users are unreachable without it. |
| `export_edl` | CMX3600 EDL for conform | The finishing/conform path for broadcast. |
| `import_edl` | CMX3600 read + relink against current media | Re-conforming old sessions. |
| `create_review_link` | Mint a share-link to an exported cut with timestamped comments | Frame.io parity; `SharePage` already exists in `App.tsx` — this is the backend half. |
| `add_review_comment` / `list_review_comments` / `resolve_review_comment` / `set_review_approval` | Timestamped comments + approval state (`approved` / `changes-requested`) on a review | Resolve Studio, Premiere, CapCut all ship this; remote teams cannot work without it. |
| `set_color_space` | Declare input/output spaces with explicit matrix/transfer (at least correct Rec.709 both ways) | Wrong gamma on export is invisible until a client complains. |
| `set_hdr_passthrough` | HLG/PQ handling end-to-end; warn when HDR footage is misdetected | Premiere/Resolve/Final Cut all ship HDR; Kove has no HDR path at all. |
| `set_working_space` (+ tone mapping) | A scene-linear (or documented) working space with tone mapping into the display space | Half of "color management" — the other half is the two tools above. |

### P1 — serious users expect within weeks

| Would-be tool(s) / surface | What it is | Notes |
| --- | --- | --- |
| Transcript-first dock | Edit-the-text cuts audio/video (Descript-style) | **Surface gap, not a tool family gap** — transcript plumbing exists (auto-caption, `ScriptViewDialog`, silence removal); wire it into the default shell. |
| `publish_to_youtube` | OAuth upload (resumable), title/description/visibility | CapCut wins creators on "one click to published"; Kove exports files and stops. |
| `publish_to_tiktok` / `publish_to_shorts` | Same shape where APIs allow | Same. |
| `schedule_post` | Queue a publish for a later time | Pairs with the above. |
| `search_stock_media` / `import_stock_media` | Catalog search + ingest (Openverse/CC free tier at minimum) | `import_media_from_url` exists (fetch a URL you already have) but there is no catalog — "start from nothing" is impossible today. |
| Loudness meter UI | Real-time BS.1770-4 integrated LUFS + true-peak metering in the audio panel | The measurement engine and the `measure_export` tool already exist — **surface, not engine**. |
| Proxy toggle UI + generation indicator | "Working with proxies" state, background progress, re-link affordance | `media-import-service.generateProxy` exists — no UI state anywhere. |
| Version history UX | Named versions / branches ("Final v3 for client") on top of undo + checkpoints | `create_checkpoint` works for the agent; there is no human-facing version model. |

### P2 — ecosystem depth

| Would-be tool(s) | Notes |
| --- | --- |
| `browse_fxpkg` / `install_fxpkg` / `publish_fxpkg` | The fxpkg format, validator and compiler exist; there is no catalog, signing UX, or in-app browser. Ecosystems are the moat (OFX, .mogrt). |
| `export_aaf` / `import_aaf` | After OTIO for Avid shops. |
| `list_members` / `invite_member` / `set_member_role` | Roles/permissions on shared projects — lands after collaborative review. |
| `set_display_color_space` / `get_icc_profile` | DCI-P3/Rec.2020 previews, ICC-aware preview. |
| `find_missing_media` / `relink_media` | Premiere-grade guided "locate missing files"; today it is a dead end with a reconnect string. |
| First-class command palette | `SearchModal` exists; make bindings searchable/remappable (⌘K). |

---

## The 38 implemented-but-unverified tools (🟡)

Every one of these is registered, schema-gated (`strict`, closed object), reachable through
`search_tools` + `run_tool`, and covered by the registry-wide invariants — but **no test names
the tool directly**. They are not known-broken; they are unproven. First action for each should
be one behavioral test in the style of `executor.test.ts` (registry → host → store), then this
table gets its icon upgraded.

**motion (15):** `bind_motion_variable` · `create_motion_variable` ·
`import_figma_composition` · `import_lottie_composition` · `morph_motion_shape` ·
`remove_motion_expression` · `remove_motion_light` · `remove_motion_mask` ·
`remove_motion_shape_modifier` · `remove_motion_text_animator` · `set_motion_camera` ·
`set_motion_layer_lock` · `unbind_motion_variable` · `update_motion_light` ·
`update_motion_mask`

**clip (3):** `close_gap` · `ripple_delete_clip` · `trim_to_playhead`

**track (3):** `hide_track` · `mute_track` · `solo_track`

**audio (3):** `remove_audio_effect` · `toggle_audio_effect` · `update_audio_effect`

**export (2):** `export_audio` · `export_video`

**history (2):** `list_checkpoints` · `restore_checkpoint`

**project (2):** `set_canvas_background` · `update_project_settings`

**AI (2):** `expand_prompt` · `expand_prompt_result`

**read (2):** `get_creation_asset` · `list_tracks`

**media (1):** `rename_media`

**marker (1):** `remove_marker`

**subtitle (1):** `remove_subtitle`

**keyframe (1):** `remove_keyframe`

**text (0, both text tools are covered)** · **effect (0)** · **color (0)** · **graphics (0)** ·
**transform (0)** · **transition (0)** · **multicam (0)** · **speed (0)** · **raw (0)** · **internal (0)**

---

## Where the sharp edges are (tuning notes)

- **Scale semantics are load-bearing.** `add_video_effect` carries the one true param table in
  its own description (contrast/saturation are multipliers — never percent; blur ≤10 px clamped
  on GPU). The model is told "numeric params outside these ranges are clamped" — but clamping is
  silent for the model's intent, so treat param-scale regressions as director bugs
  (`effect-param-scale.test.ts` exists for this reason).
- **Shaders have two quality tiers.** WebGL2 present → real GLSL. WebGL2 absent → deterministic
  2D material approximation (alpha preserved) + loud diagnostic via
  `MotionShaderRenderer.getFallbackDiagnostics()`. A shader look in a client's final render on a
  WebGPU-less machine will *look* different from the GPU render — say so.
- **The director gates itself.** Fresh footage timelines: `plan_edit` refuses without
  `extract_segments` evidence (`ANALYSIS_REQUIRED`). Targeted tweaks on an existing timeline
  ("turn off the brightness") bypass the gate by design (`TARGETED_EDIT_HINT`). Both behaviors
  are e2e-verified.
- **`undo` refuses on human edits.** `HUMAN_EDITS_PRESENT` — only reverts agent steps;
  `restore_checkpoint` rolls back farther but wholesale.
- **`delegate_tasks`** fans work to specialist subagents with the same registry; marked
  destructive + expensive by convention even though the work items are scoped. Budget tool calls
  accordingly.
- **`measure_export`** runs real ffmpeg/ffprobe QC (EBU R128 integrated loudness, true peak,
  black frames) on exported files; **`export_video`/`export_audio`** need an encoder; a missing
  encoder is an environment limit, not a bug.
- **Vision tools need their stack.** `extract_segments` (analyzer HTTP + Whisper download on first
  use, ~100 MB, cached), `detect_faces` / `rotoscope_subject` / `auto_reframe_clip` /
  `apply_subject_matte` / `refine_matte_edges` (local face/segmentation models). No model → clean
  refusal, not a fake answer. `expand_prompt` needs an LLM call.
- **`execute_action` / `batch_actions`** (raw) can bypass nothing — they go through the same
  action executor, undo ledger, and gates. Prefer a typed tool when one exists.
- **`expand_prompt_result` is not a tool call** — it is the structured-output sink for the
  director's nested expansion; the stub/e2e relies on it and the loop treats it specially.

## Verification appendix

Snapshot at measurement (2026-11-15, branch `arena/3feee4cb-k-o-v-e`, `main` @ `88205ec`):

- `packages/agent` vitest: **1029 passed / 11 skipped / 0 red**
- `packages/core` vitest: **1800 passed / 20 skipped / 0 red** (63 pixel goldens incl. `shader` at 36.00% changed)
- `tsc --noEmit`: clean in `packages/agent`, `packages/core`, `apps/web`
- Playwright e2e: `manual-edit-ai-handoff` 5/5, `director-empty-timeline` 2/2, `vision` (tool host path) green
- Environment note: this sandbox needs SwiftShader libraries placed next to the chromium binary
  for WebGL2 (see `apps/web/e2e/README.md`). The 2026-11-15 sandbox reset removed the browser,
  ffmpeg and the SwiftShader stack; it was fully restored by (a) `npm install @sparticuz/chromium`
  (extract `chromium` + `*.tar.br` → `~/.tmp-chromium/chromium-runtime/`, recreate the
  `~/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`
  symlink), and (b) `pip download imageio-ffmpeg` for a real `ffmpeg` binary on `PATH`
  (`imageio-ffmpeg` wheels carry `ffmpeg-linux-x86_64`). Without this, the 63 effect-goldens skip.
- Counting method: `listTools()` at runtime (336), test reference scan across
  `packages/agent/src`, `packages/core/src`, `apps/web/src`, `apps/web/e2e` test files with word-boundary
  matching; e2e references verified by hand against the specs (6 stubbed-LLM + 2 direct).
  `schema-conformance.test.ts` covers every tool for schema well-formedness/strictness regardless of the table above.

## Maintaining this document

1. Re-dump the registry (`listTools()`), re-scan test files for each tool name.
2. Upgrade 🟡 → ✅ one test at a time; add 🖥️ when a tool is driven in an e2e spec.
3. Strike missing-tool rows only when the tool lands in the registry.
4. Keep `docs/AGENT-*.md` naming (`docs/*` is gitignored except whitelisted prefixes).
