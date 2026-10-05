# K.O.V.E. — Complete Architecture Reference

> KREATE. ORKESTRATE. VISUALIZE. EXPORT.
> Browser-based professional video editor. MIT licensed. Monorepo managed with pnpm workspaces.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Package Map](#3-package-map)
4. [Apps](#4-apps)
5. [Routing](#5-routing)
6. [Editor Layout](#6-editor-layout)
7. [Component Hierarchy](#7-component-hierarchy)
8. [Inspector Panel — All Properties](#8-inspector-panel--all-properties)
9. [Assets Panel — All Tabs](#9-assets-panel--all-tabs)
10. [Timeline Structure](#10-timeline-structure)
11. [All Zustand Stores](#11-all-zustand-stores)
12. [All Core Types](#12-all-core-types)
13. [Agent System (Monet AI Director)](#13-agent-system-monet-ai-director)
14. [Desktop Bridge (`window["kove-advanced"]`)](#14-desktop-bridge)
15. [Services Layer](#15-services-layer)
16. [Data Flow](#16-data-flow)
17. [Engine Architecture](#17-engine-architecture)
18. [File Path Quick Reference](#18-file-path-quick-reference)

---

## 1. Product Overview

K.O.V.E. is a split-surface application:

- **Video Editor** — Full-power timeline editor with 223+ AI agent tools
- **Monet** — Chat-first AI director that can fully author an edit on its own, sitting on top of the editor
- **Motion Creator** — After Effects-style motion graphics tool (separate surface)
- **Desktop App** — Electron wrapper with native FFmpeg, Aurora 3D renderer, keychain, MCP bridge

The user flow: upload footage → chat with Monet → Monet analyzes footage and authors an EDL → renders in the editor → user accepts or takes manual control.

---

## 2. Monorepo Structure

```
k.o.v.e/
├── apps/
│   ├── web/                    # Main React frontend (Vite, Cloudflare Pages)
│   ├── desktop/                # Electron desktop app (CJS main process)
│   ├── studio/                 # Separate React app (Vite + Playwright E2E)
│   └── image/                  # Image editing app (Vite, Cloudflare Pages)
├── packages/
│   ├── agent/                  # AI agent tool definitions + loop
│   ├── agent-runner/           # Headless CLI for automated edits
│   ├── core/                   # All processing engines (video, audio, graphics, etc.)
│   ├── creation-schema/        # Zod schemas for creation engine + director
│   ├── creation-bindings/      # Native addon / WASM bindings with CPU fallback
│   ├── creation-agent/         # Agent-native creation tool definitions
│   ├── creation-core/          # C++20 native core (CMake, separate build)
│   ├── fxpkg/                  # Effect preset packages
│   ├── image-core/             # Image processing core
│   ├── frame-worker/           # Cloudflare Worker for frame extraction + vision
│   └── ui/                     # Shared Radix-based component library
├── patches/                    # Patched dependencies (@ffmpeg/core, @ffmpeg/core-mt)
├── AGENTS.md                   # Agent instructions
├── ARCHITECTURE.md             # This file
└── monet-kove-flow-spec.md     # Full flow spec for Monet integration
```

---

## 3. Package Map

### `packages/agent` — AI Agent Tool Definitions & Loop

The brain of the AI system. Contains every tool the agent can call.

| File | Purpose |
|---|---|
| `src/index.ts` | Barrel exports |
| `src/types.ts` | `ToolDomain`, `ToolDef`, `ToolCall`, `ToolResult`, `AgentMessage`, `AgentEvent`, `ConfirmDecision` |
| `src/host.ts` | `EditingHost` interface — the seam tools execute through |
| `src/registry.ts` | **~32K lines**. Every tool registration, handler, and JSON schema. Exports `toAnthropicTools()`, `toOpenAITools()`, `toMcpTools()`, `toCapabilityDoc()` |
| `src/tool-router.ts` | `selectToolsForPrompt()` — routes prompts to tool subsets via keyword detection + scoring |
| `src/system-prompt.ts` | `buildSystemPrompt()` — assembles full system prompt with guidelines, Monet instructions, Motion instructions, editor state |
| `src/executor.ts` | `executeTool()` — resolves clip refs, dispatches to handlers. `isDestructive()`, `isExpensive()` |
| `src/loop.ts` | `runTurn()` — the agentic loop: send to LLM → execute tools → handle confirmations → budget limits → transactions → dry-run |
| `src/llm.ts` | LLM client abstraction: `AnthropicClient`, `OpenAIClient`, `MockLLMClient`. `withRetry()` backoff |
| `src/serialize.ts` | `serializeEditorState()`, `listMedia()`, `listTracks()`, `listClips()`, `getClipDetail()` |
| `src/headless-host.ts` | `HeadlessHost` — minimal `EditingHost` for Node.js |
| `src/observability.ts` | Event logging |
| `src/gen-docs.ts` | Capability markdown generation |
| `src/creation-product-motion.ts` | Creates Motion Creator compositions from creation scenes |

**Director subsystem (`src/director/`):**

| File | Purpose |
|---|---|
| `index.ts` | Exports all director APIs |
| `genres.ts` | 7 pre-baked genres: highlight-reel, documentary, vlog, tutorial, music-video, corporate, social-reel |
| `director-prompt.ts` | `DIRECTOR_SYSTEM_PROMPT` — the Monet system prompt + `buildDirectorPrompt()` |

### `packages/agent-runner` — Headless CLI & Eval System

| File | Purpose |
|---|---|
| `src/cli.ts` | CLI entry (`kove-advanced-agent` binary). Parses --project, --prompt, --provider, --model |
| `src/run.ts` | `runHeadlessEdit()` — runs one agent turn against in-memory project |
| `src/node-llm.ts` | `makeNodeLLMClient()` — LLM client for Node.js |
| `src/project-io.ts` | JSON project I/O |
| `src/evals/harness.ts` | Eval framework: `EvalCase`, `runEvalCase()`, `runEvals()` |
| `src/evals/cases.ts` | 7 scripted test cases including director tools |

### `packages/core` — All Processing Engines

```
packages/core/src/
├── actions/         # Action system: dispatch, undo/redo, serialization, validation
├── ai/              # Auto-reframe, background removal, person segmentation,
│                    # face detection/tracking, subject rotoscope, separation
├── animation/       # Easing, keyframes, GSAP, composition rendering
├── audio/           # Playback, effects, beat detection, FFT, noise reduction, automation
├── capabilities/    # Machine-readable capability manifest
├── creation/        # Agent-native 3D engine (geometry, materials, rigging, simulation, rendering)
├── device/          # GPU detection, export estimation, native profiles
├── editing-templates/ # Built-in editing template system
├── effects/         # Blend modes, expression engine, particle system
├── export/          # WebCodecs encoding, compression, export workers
├── graphics/        # Shapes, stickers, SVG animation presets
├── media/           # Import, extraction, GIF decode, waveform, FFmpeg fallback
├── motion/          # 136 files — After Effects-style engine (compositions, layers, keyframes, effects, masks, shaders, 3D, particles, cameras, lights)
├── multicam/        # Automatic editing, shot planning, VAD, OTIO export
├── photo/           # Photo editing, adjustments, retouching
├── playback/        # Master clock, playback controller
├── storage/         # Project serialization, caching, IndexedDB
├── template/        # Template engine
├── text/            # Titles, subtitles, text animations, speech-to-text
├── timeline/        # Clip management, track management, placement, nested sequences
├── types/           # All shared TypeScript types
├── utils/           # Shared utilities
├── video/           # 52 files — composite, decode, render, effects, GPU compositor, WebGPU
└── wasm/            # AssemblyScript WASM modules (FFT, WAV, beat detection)
```

### `packages/creation-schema` — Zod Schemas + Director Types

| File | Purpose |
|---|---|
| `src/types.ts` | Core creation types: `CreationAssetKind`, `SceneObject`, `CreationCamera`, `CreationScene` |
| `src/primitives.ts` | `vec3()`, `transform3d()` helpers |
| `src/product-cinematic.ts` | `ProductCinematicSpec` + `createPhoneProductCinematicScene()` |
| `src/validate.ts` | `validateCreationScene()`, `summarizeCreationScene()` |
| `src/director/segment-map.ts` | `SceneType`, `MotionLevel`, `VideoSegment`, `SegmentMap` |
| `src/director/edit-plan.ts` | `PlannedSegment`, `PlannedEffect`, `PlannedTransition`, `PlannedAudio`, `EditPlan` |
| `src/director/genre.ts` | `CutStyle`, `MusicRole`, `ColorMood`, `GenreRules`, `Genre` |
| `src/director/validate.ts` | `validateSegmentMap()`, `validateEditPlan()` |

### `packages/creation-agent` — Creation Tool Definitions

| File | Purpose |
|---|---|
| `src/types.ts` | `CreationToolDomain`, `CreationToolDef`, `CreationToolResult` |
| `src/tools.ts` | 2 tools: `create_product_cinematic_scene`, `validate_creation_scene` |

### `packages/creation-core` — C++20 Native Core

CMake project that builds to native addon or WASM. Mirrors the TypeScript reference in `packages/core/creation`.

### `packages/creation-bindings` — Native / WASM Bindings

| File | Purpose |
|---|---|
| `src/index.ts` | `CreationBackend` interface — loads native addon or WASM, falls back to CPU reference |
| `src/wasm.ts` | WASM module loader |

### `packages/fxpkg` — Effect Preset Packages

| File | Purpose |
|---|---|
| `src/types.ts` | `AssetKind`, `PortType`, `ParamDecl`, `GraphNode`, `Graph`, `AssetRequirements` |
| `src/blueprints.ts` | Blueprint engine for beginner-mode graph generation |
| `src/compiler/filter.ts` | `compileFilter()` — compiles filter graph to render pipeline |
| `src/compiler/template.ts` | `compileTemplate()` — compiles editing templates |

### `packages/image-core` — Image Processing Core

| File | Purpose |
|---|---|
| `src/schema.ts` | Zod schemas: `Transform`, `BlendMode`, `Shadow`, `Filter`, layers, image project |
| `src/operations.ts` | Resize, crop, rotate, flip |
| `src/adjustments.ts` | Levels, curves |
| `src/mask.ts` | Mask operations |

### `packages/frame-worker` — Frame Extraction Worker

| File | Purpose |
|---|---|
| `src/index.ts` | `extractSegments()` — orchestrator: scene detection → adaptive timestamps → batch frames → vision → SegmentMap |
| `src/frame-extraction.ts` | `detectSceneBoundaries()` (histogram diff), `computeAdaptiveTimestamps()` (baseline 1.5fps, burst 10fps around cuts), `batchFrames()`, `descriptionsToSegmentMap()` |
| `src/worker.ts` | Cloudflare Worker: calls `@cf/meta/llama-3.2-11b-vision-instruct` for frame analysis |

### `packages/ui` — Shared Component Library

51 Radix-based components: `Button`, `Dialog`, `DropdownMenu`, `ContextMenu`, `Tooltip`, `Popover`, `Slider`, `Switch`, `Tabs`, `Toggle`, `ColorPicker`, `ScrollArea`, plus 28 Toolcraft design system components.

---

## 4. Apps

### `apps/web` — Main Frontend

The primary React application. Vite dev server on `http://localhost:5173/`.

**Entry:** `src/main.tsx` → `src/App.tsx`

### `apps/desktop` — Electron App

- Main process: CJS, bundled via tsup
- Renderer: built from `apps/web` with `KOVE_ADVANCED_DESKTOP=1`
- Provides: native FFmpeg, Aurora 3D renderer, keychain, MCP bridge, window controls, updater

### `apps/studio` — Separate React App

Vite + Playwright E2E testing.

### `apps/image` — Image Editing App

Vite, deployed to Cloudflare Pages.

---

## 5. Routing

**Type:** Custom hash router (NOT file-based, NOT react-router).

**File:** `apps/web/src/hooks/use-router.ts`

```
type AppRoute = "welcome" | "editor" | "new" | "templates" | "recent" | "share" | "motion";
```

| Route | Hash | Renders | Notes |
|---|---|---|---|
| `welcome` | `#/welcome` | `<WelcomeScreen />` | Default fallback |
| `templates` | `#/templates` | `<WelcomeScreen initialTab="templates" />` | Template gallery |
| `recent` | `#/recent` | `<WelcomeScreen initialTab="recent" />` | Recent projects |
| `new` | `#/new?preset=tiktok` | Creates project → `navigate("editor")` | Preset or custom dimensions |
| `editor` | `#/editor` | `<EditorInterface />` | Main editor |
| `share` | `#/share/{shareId}` | `<SharePage />` | Public share/download |
| `motion` | `#/motion` | `<MotionCreatorApp />` | Also `motion.*` subdomain |

---

## 6. Editor Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                        Toolbar (60px)                            │
│  [Home] [WorkspaceModeTabs] [ProjectName] [Export] [Settings]  │
├────┬──────────────────────────────────────┬──────────┬──────────┤
│    │                                      │          │          │
│ A  │         Preview (Canvas)             │Inspector │  Chat    │
│ c  │         [1fr]                        │ [360px]  │ [380px]  │
│ t  │                                      │          │(hidden)  │
│ i  │                                      │          │          │
│ o  │                                      │          │          │
│ n  │                                      │          │          │
│    │                                      │          │          │
│ R  │                                      │          │          │
│ a  │                                      │          │          │
│ i  │                                      │          │          │
│ l  │                                      │          │          │
│    │                                      │          │          │
│48px├──────────────────────────────────────┴──────────┴──────────┤
│    │                     Timeline (42vh)                        │
│    │  [AudioMixer] [TrackHeaders] [TrackViewport] [Keyframes]  │
└────┴────────────────────────────────────────────────────────────┘
```

**CSS Grid areas:**
- `media` — AssetsPanel (460px default)
- `stage` — Preview (1fr)
- `inspector` — InspectorPanel (360px default)
- `chat` — ChatPanel (380px, conditional)
- `timeline` — Timeline (42vh)

All panels are resizable. Chat panel appears when toggled from the action rail.

---

## 7. Component Hierarchy

```
App
├── MobileBlocker
├── [Route-based top-level]:
│   ├── MotionCreatorApp          (motion route)
│   ├── SharePage                 (share route)
│   ├── WelcomeScreen             (welcome/templates/recent)
│   └── EditorInterface           (editor route)
├── ToastContainer
├── ScriptViewDialog
├── SearchModal
└── RecoveryDialog

EditorInterface
├── Toolbar
│   ├── WorkspaceModeTabs (Video / Motion)
│   ├── Project name input
│   ├── ExportDialog
│   ├── ScreenRecorder
│   └── SettingsDialog
├── EditorActionRail (48px left rail)
│   ├── Home → navigate("welcome")
│   ├── Search (Cmd+K)
│   ├── Undo / Redo
│   ├── Create Motion Scene
│   ├── Action History
│   ├── Keyframe Editor toggle
│   ├── Audio Mixer toggle
│   ├── AI Editor Chat toggle
│   ├── Theme toggle
│   └── More menu
├── AssetsPanel (left, 8 tabs)
├── Preview (center canvas)
├── InspectorPanel (right, context-sensitive tabs)
├── ChatPanel (right, conditional)
├── AudioMixer (optional)
├── Timeline (bottom, multi-track)
└── KeyframeEditorPanel (optional)
```

---

## 8. Inspector Panel — All Properties

### Video Clip

**Transform Tab:**
- position.x, position.y (normalized 0-1)
- scale.x, scale.y (factor)
- rotation (degrees)
- anchor.x, anchor.y (normalized)
- opacity (0-1)
- borderRadius (px)
- fitMode: `contain | cover | stretch | none`
- 3D rotate X/Y/Z (degrees)
- perspective (CSS value)
- transformStyle: `flat | preserve-3d`
- crop: x, y, width, height (normalized)
- blendMode: `normal | multiply | screen | overlay | darken | lighten | color-dodge | color-burn | hard-light | soft-light | difference | exclusion | hue | saturation | color | luminosity`
- blendOpacity (0-1)

**Color Tab:**
- Temperature [-100, 100]
- Tint [-100, 100]
- Color Wheels: lift/gamma/gain
- Curves: RGB, Red, Green, Blue
- HSL: per-hue hue shift, saturation, lightness
- LUT: load .cube file (data, size, intensity)

**Effects Tab:**
- Applied Effects stack (toggle, reorder, remove)
- Background Removal: mode (blur/solid/image/transparent), blur strength, replacement color, replacement image
- Particle Effects: presets (sparkle/fire/snow/rain/confetti/bubbles/smoke/firefly/stars/embers/leaves/petals), count (1-500), size (1-50), color, lifetime (0.1-5s), speed (0-200), spread (1-360°), timing
- Chroma Key: enable, key color, tolerance (0-100%)
- Green Screen: keyColor {r,g,b}, similarity, smoothness, spill, edge clean
- Motion Tracking: algorithm, tracked region, apply to (position/scale/rotation)
- Video Effects: blur, brightness, contrast, saturation, hue, sharpen, vignette, grain, temperature, tint, motion-blur, radial-blur, chromatic-aberration, shadow, glow, shader
- Picture-in-Picture: presets + custom position/scale
- Masking: shapes (rectangle/ellipse/triangle/star/heart/path), invert, feather, opacity, stacked masks
- Nested Sequences, Adjustment Layers
- Behind Subject toggle

**Audio Tab:**
- Volume (dB)
- Fade In/Out: duration (seconds), curve (linear/exponential/logarithmic/s-curve)
- Audio Track Index
- Noise Reduction: threshold (-60 to 0 dB), reduction (0-1), attack/release, focus preset, noise profile
- EQ: multi-band parametric (frequency, gain, Q per band)
- Compressor: threshold, ratio, attack, release, knee, makeupGain
- Reverb: roomSize, damping, wetLevel, dryLevel, preDelay
- Delay: time, feedback, wetLevel, sync to tempo
- Audio Ducking: threshold, reduction, attack, release, hold, source track
- Auto Cut Silence: threshold, min duration, fade in/out
- Pitch Correction toggle

**Speed Tab:**
- Speed multiplier (0.5, 2x, etc.)
- Reversed toggle
- Smooth Slow-Mo (frame interpolation)
- Interpolation Quality: low/medium/high
- Stabilization: enabled, strength, cropMode, profile
- Speed Keyframes: time/speed/easing (variable-speed animation)
- Freeze Frames: sourceTime, startTime, duration

**Animate Tab:**
- Keyframes: property, time, value, easing (30+ types)
- Transitions: crossfade, dip-to-black, dip-to-white, wipe, slide, zoom
- Motion Presets
- Motion Path: bezier points
- Emphasis Animation: pulse/shake/bounce/float/spin/flash/heartbeat/swing/wobble/jello/rubber-band/tada/vibrate/flicker/glow/breathe/wave/tilt/zoom-pulse/focus-zoom/pan/ken-burns + speed/intensity/loop/focusPoint/zoomScale

**AI Tab:**
- Auto Captions (local speech recognition)
- SRT/VTT Import
- Auto Reframe (AI aspect ratio reframing)
- Beat-Synced Auto-Edit
- Local Highlights
- Quick Actions: Remove Background, Auto-Color

### Image Clip
Same Transform/Color/Effects/Animate as Video. No Audio tab. Speed: speed/reversed/stabilization. AI: auto reframe, auto-color.

### Text Clip

**Style Tab:**
- Content (multiline string)
- fontFamily, fontSize, fontWeight, fontStyle
- color (hex)
- textAlign: left/center/right/justify
- lineHeight, letterSpacing
- textTransform: none/uppercase/lowercase/capitalize
- textDecoration: none/underline/line-through/overline
- strokeColor, strokeWidth
- Shadow: color, blur, offsetX, offsetY, spread, inset
- maxWidth, autoSize
- shaderFill (animated shader)

**Effects Tab:** Same as video (particles, video effects, behind-subject)

**Animate Tab:** Same as video + **Text Animation**:
- preset: fade-in/typewriter/scale-up/bounce-in/slide/rotate-in/blur-in/wave/scramble/drop-in/unfold/pop/flicker/glitch
- duration (0.1-5s), delay (0-10s), stagger (0-2s per character/word/line)
- target: characters/words/lines/all

### Shape Clip

**Style Tab:**
- shapeType: `rectangle | circle | ellipse | triangle | arrow | line | polygon | path | star | mesh-cube | mesh-sphere | mesh-torus | mesh-cone | mesh-cylinder | mesh-icosahedron`
- fillType: `solid | gradient | none | shader`
- fillColor, fillOpacity
- gradientType/angle/stops
- strokeColor/width/opacity/gradient
- lineCap: butt/round/square
- lineJoin: miter/round/bevel
- dashArray, dashOffset
- Shadow/Shadows (layered)
- cornerRadius / cornerRadii (per-corner)
- points (star/polygon), innerRadius
- material3D: metalness/roughness (for mesh primitives)

### SVG Clip

**Style Tab:**
- SVG content (raw markup)
- viewBox: minX, minY, width, height
- preserveAspectRatio
- colorMode: none/tint/replace
- tintColor, tintOpacity
- Entry/Exit Animations: fade/slide/scale/rotate/bounce/pop/draw/wipe/reveal/elastic/flip

### Sticker Clip
No style tab. Transform + Effects + Animate (keyframes, transitions, motion path, emphasis).

### All Easing Types
`linear, ease, ease-in, ease-out, ease-in-out, hold, bezier, smoothstep, smootherstep, snappy, smooth, easeInQuad, easeOutQuad, easeInOutQuad, easeInCubic, easeOutCubic, easeInOutCubic, easeInQuart, easeOutQuart, easeInOutQuart, easeInQuint, easeOutQuint, easeInOutQuint, easeInSine, easeOutSine, easeInOutSine, easeInExpo, easeOutExpo, easeInOutExpo, easeInCirc, easeOutCirc, easeInOutCirc, easeInBack, easeOutBack, easeInOutBack, easeInElastic, easeOutElastic, easeInOutElastic, easeInBounce, easeOutBounce, easeInOutBounce`

---

## 9. Assets Panel — All Tabs

```
┌──────────────────────────────┐
│  [Media] [Text] [Graphics]   │
│  [Effects] [Transitions]     │
│  [AI] [Recipes] [Templates]  │
├──────────────────────────────┤
│                              │
│       Tab Content            │
│                              │
└──────────────────────────────┘
```

| Tab | Icon | Content |
|---|---|---|
| `media` | Video | Import/Record buttons, sort, missing asset filter, thumbnail grid (draggable), drag-and-drop zone |
| `text` | Type | Title presets: Heading, Subtitle, Lower Third, Caption, Hero, Quote, Outline, Badge |
| `graphics` | Shapes | Backgrounds (solid/gradient/mesh/pattern), Shapes (rect/circle/triangle/star/arrow/polygon), 3D Objects (cube/sphere/torus/cone/cylinder/icosahedron) |
| `effects` | Zap | Drag effects onto clips |
| `transitions` | Shuffle | Drag transitions onto clip edges |
| `ai` | Sparkles | AI generation tools (KieAI) |
| `recipes` | Wand2 | Clip-scoped looks, overlays, text stacks |
| `templates` | LayoutTemplate | Full-project starter layouts |

---

## 10. Timeline Structure

```
┌─────────────────────────────────────────────────────────────┐
│ Timeline Toolbar                                             │
│ [Undo][Redo] | [Split][Trim][Delete][Duplicate] | [AddTrack]│
│ [TrackLayers] | [Zoom Slider] | [Snap] | [Height] | [Max]  │
├───────────┬─────────────────────────────────────────────────┤
│  Track    │  Track Viewport (scrollable, both axes)         │
│  Headers  │                                                 │
│  (170px)  │  TrackLane 0: [Clip] [Clip] [Clip]             │
│           │  TrackLane 1: [TextClip] [ShapeClip]            │
│           │  TrackLane 2: [AudioClip]                       │
│           │  TrackLane 3: [AdjustmentLayer]                 │
│           │                                                 │
│           │  ─── Playhead (red line) ───                    │
│           │                                                 │
│           │  MarkerIndicator[]                               │
└───────────┴─────────────────────────────────────────────────┘
```

**Timeline sub-components (17 files):**

| Component | Purpose |
|---|---|
| `Playhead` | Vertical red line at current position |
| `TimeRuler` | Ruler with tick marks, snap points, click-to-seek |
| `TrackHeader` | Track name, icon, visibility/mute/lock, drag reorder |
| `TrackLane` | Horizontal lane for a single track |
| `ClipComponent` | Video/audio clip with trim handles |
| `TextClipComponent` | Text overlay clip |
| `ShapeClipComponent` | Shape/SVG/sticker overlay |
| `AdjustmentLayerTimelineItem` | Adjustment layer |
| `TransitionHandle` | Drag handle between clips |
| `KeyframeMarker` | Diamond marker for keyframes |
| `BeatMarkerOverlay` | Beat detection markers |
| `MarkerIndicator` | User-set markers |
| `CaptionBatchSelectButton` | Batch select captions |
| `ClipContextMenu` | Right-click menu |
| `EasingCurve` | Easing visualization |

---

## 11. All Zustand Stores

### `useProjectStore` — The Core Data Store

**File:** `apps/web/src/stores/project-store.ts`
**Middleware:** `subscribeWithSelector`
**Composed from 8 slices:** ClipSlice, TrackSlice, MediaSlice, TextGraphicsSlice, HistorySlice, SubtitleSlice, MarkerSlice, TimelineItemSlice

**Key state:**
- `project: Project` — the entire project state
- `hasOpenProject: boolean`
- `clipboard: TimelineClipboardItem[]`
- `copiedEffects: Effect[]`
- `clipUndoStack / clipRedoStack`
- `isLoading, error`

**Key actions:**
- Project: `createNewProject`, `loadProject`, `renameProject`, `updateSettings`
- Media: `importMedia`, `deleteMedia`, `replaceMediaAsset`, `renameMedia`
- Track: `addTrack`, `duplicateTrack`, `removeTrack`, `reorderTrack`, `lockTrack`, `hideTrack`, `muteTrack`, `soloTrack`, `groupTracks`, `consolidateTrack`
- Clip: `addClip`, `removeClip`, `moveClip`, `moveClips`, `trimClip`, `splitClip`, `rippleDeleteClip`, `slipClip`, `slideClip`, `rollEdit`
- Text: `createTextClip`, `updateTextContent`, `updateTextStyle`, `updateTextAnimation`, `applyTextAnimationPreset`
- Graphics: `createShapeClip`, `importSVG`, `createStickerClip`
- Effects: `addVideoEffect`, `updateVideoEffect`, `removeVideoEffect`, `reorderVideoEffects`
- Color: `updateColorGrading`, `resetColorGrading`
- Audio: `addAudioEffect`, `updateAudioEffect`, `removeAudioEffect`, `setClipAudioDucking`
- Transitions: `addClipTransition`, `updateClipTransition`, `removeClipTransition`
- Keyframes: `updateClipKeyframes`
- Subtitles: `addSubtitle`, `removeSubtitle`, `importSRT`, `exportSRT`
- Markers: `addMarker`, `removeMarker`, `updateMarker`
- Motion: `createMotionComposition`, `insertMotionInstance`, `updateCreationObject`
- Undo/Redo: `undo`, `redo`, `canUndo`, `canRedo`
- Auto-save: `initializeAutoSave`, `checkForRecovery`, `recoverFromAutoSave`, `forceSave`

### `useUIStore` — UI State

**File:** `apps/web/src/stores/ui-store.ts`
**Middleware:** `subscribeWithSelector`, `persist` (key: `kove-advanced-ui-preferences`)

**Key state:**
- `selectedItems: SelectionItem[]`
- `panels: Record<PanelId, PanelState>` — visibility and width for: mediaLibrary, inspector, effects, audioMixer, colorGrading, subtitles, agentChat
- `shortcuts: KeyboardShortcuts`
- `theme: "light" | "dark" | "system"`
- `showWaveforms, showThumbnails, showKeyframes, autoScroll`
- `playbackQuality: PreviewQuality`
- `activeModal: string | null`
- `contextMenu, isDragging, dragType, dragData`
- `cropMode, cropClipId`
- `inspectorActiveTab: string`
- `exportState: { isExporting, progress, phase }`

### `useTimelineStore` — Timeline State

**File:** `apps/web/src/stores/timeline-store.ts`
**Middleware:** `subscribeWithSelector`, `persist` (key: `kove-advanced-timeline-workspace`)

**Key state:**
- `playheadPosition: number`
- `playbackState: "stopped" | "playing" | "paused"`
- `playbackRate: number`
- `pixelsPerSecond: number` (zoom level)
- `scrollX, scrollY, viewportWidth, viewportHeight`
- `trackHeight: number`
- `loopEnabled, loopStart, loopEnd`
- `expandedTracks: Set<string>`

### `useChatStore` — AI Chat State

**File:** `apps/web/src/stores/chat-store.ts`

**Key state:**
- `messages: ChatMessage[]`
- `status: "idle" | "running" | "awaiting_confirm" | "error"`
- `conversation: LoopMessage[]`
- `pendingConfirm: { call, resolve } | null`
- `usage: { inputTokens, outputTokens }`
- `projectId, currentConversationId`

**Key actions:** `send`, `resolveConfirm`, `stop`, `undoLastTurn`, `newChat`, `openConversation`

### `useSettingsStore` — Settings

**File:** `apps/web/src/stores/settings-store.ts`
**Middleware:** `persist` (key: `kove-advanced-settings`, version 7)

**Key state:**
- `autoSave, autoSaveInterval, language`
- `defaultLlmProvider: LlmProvider | null`
- `llmBaseUrl, llmModel`
- `defaultAggregator: "kie-ai"`
- `elevenLabsModel, favoriteVoices, favoriteModels`
- `configuredServices: string[]`
- `mcpAutoAllowTrustedLocal, agentAutoConfirm, agentDryRun`

### `useThemeStore` — Theme

**File:** `apps/web/src/stores/theme-store.ts`
**Middleware:** `persist` (key: `kove-advanced-theme`)

**Key state:** `mode: "light" | "dark" | "auto"`, `isDark: boolean`

### `useEngineStore` — Engine Singletons

**File:** `apps/web/src/stores/engine-store.ts`

**Key state:**
- `videoEngine, audioEngine, playbackController, titleEngine, subtitleEngine`
- `graphicsEngine, photoEngine, exportEngine`
- `speechToTextEngine, templateEngine, soundLibraryEngine`
- `chromaKeyEngine, multiCamEngine, maskEngine`
- `nestedSequenceEngine, adjustmentLayerEngine`
- `currentFrame: RenderedFrame | null`
- `playbackStats, audioLevels`

### Other Stores

| Store | File | Key State |
|---|---|---|
| `useNotificationStore` | `notification-store.ts` | `notifications[]` (toast queue) |
| `useChatHistoryStore` | `chat-history-store.ts` | `conversations[]` (saved, max 30) |
| `useKieAIStore` | `kieai-store.ts` | `tasks[]` (pending AI generations) |
| `useRecorderStore` | `recorder-store.ts` | `status, duration, screenStream, webcamStream, result` |
| `useTtsAudioStore` | `tts-store.ts` | `generatedAudio, audioUrl` |

### Store Dependency Graph

```
useChatStore
  ├── useChatHistoryStore
  ├── useSettingsStore
  └── useProjectStore

useProjectStore
  └── useEngineStore (titleEngine, graphicsEngine)

All others: standalone
```

---

## 12. All Core Types

### Project (`packages/core/src/types/project.ts`)
`Project`, `ProjectSettings`, `MediaLibrary`, `MediaItem`, `MediaMetadata`

### Timeline (`packages/core/src/types/timeline.ts`)
`Timeline`, `Track`, `Clip`, `Effect`, `Transform`, `Keyframe`, `Marker`, `Transition`, `Subtitle`, `SubtitleStyle`, `SpeedKeyframe`, `FreezeFrame`, `ClipMetadata`, `EditingTemplate`

### Effects (`packages/core/src/types/effects.ts`)
`LayerEffectType`, `VideoFilterType`, `AudioEffectType`, `TransitionType`, `VideoFilterParams`, `AudioEffectParams`, `EQBand`, `CurvePoint`

### Actions (`packages/core/src/types/actions.ts`)
`Action`, `ActionResult`, `ProjectAction`, `MediaAction`, `TrackAction`, `ClipAction`, `EffectAction`, `TransformAction`, `TransitionAction`, `AudioAction`, `SubtitleAction`, `MarkerAction`, `OverlayAction`, `MotionAction`

### Composition (`packages/core/src/types/composition.ts`)
`Composition`, `Layer`, `ShapeLayer`, `TextLayer`, `ImageLayer`, `VideoLayer`, `AudioLayer`, `GroupLayer`, `BlendMode`, `Vector2D/3D`, `BezierPath`, `FillStyle`, `StrokeStyle`, `TextStyle`, `TextAnimation`

### 3D (`packages/core/src/types/transform-3d.ts`)
`Transform3D`, `Camera`, `DepthOfFieldConfig`, `Layer3DConfig`, `AutoOrientMode`

### Templates (`packages/core/src/types/template.ts` + `scriptable-template.ts`)
`Template`, `ScriptableTemplate`, `SocialMediaPreset`, `TemplateScene`, `PlaceholderType`

### Sound (`packages/core/src/types/sound-library.ts`)
`SoundItem`, `SoundCategory`, `BeatMarker`, `SoundAnalysis`

### Director (`packages/creation-schema/src/director/`)
`SegmentMap`, `VideoSegment`, `SceneType`, `MotionLevel`, `EditPlan`, `PlannedSegment`, `PlannedEffect`, `PlannedTransition`, `Genre`, `GenreRules`

### Result (`packages/core/src/types/result.ts`)
`Result<T, E>`, `ok()`, `err()`, `isOk()`, `isErr()`, `unwrap()`, `map()`, `flatMap()`

---

## 13. Agent System (Monet AI Director)

### Complete Tool List (223+ tools)

**Read (14):** `get_editor_state`, `list_media`, `list_tracks`, `list_clips`, `get_clip`, `get_capabilities`, `list_motion_compositions`, `get_motion_composition`, `get_creation_capabilities`, `list_creation_assets`, `list_creation_scenes`, `get_creation_asset`, `get_creation_scene`, `inspect_creation_product_parts`

**Project (7):** `create_project`, `list_projects`, `open_project`, `save_project`, `update_project_settings`, `rename_project`, `set_canvas_background`

**Track (10):** `add_track`, `duplicate_track`, `remove_track`, `rename_track`, `reorder_track`, `lock_track`, `hide_track`, `mute_track`, `solo_track`, `consolidate_track`

**Media (3):** `import_media_from_url`, `delete_media`, `rename_media`

**Clip (11):** `add_clip`, `remove_clip`, `move_clip`, `trim_clip`, `split_clip`, `ripple_delete_clip`, `slip_clip`, `slide_clip`, `roll_edit`, `trim_to_playhead`, `close_gap`

**Speed (6):** `set_clip_speed`, `set_clip_reverse`, `set_clip_pitch_correction`, `set_speed_ramp`, `set_clip_stabilization`, `set_clip_chroma_key`

**Transform (3):** `set_clip_transform`, `set_clip_blend_mode`, `set_clip_blend_opacity`

**Effect (6):** `add_video_effect`, `remove_video_effect`, `update_video_effect`, `toggle_video_effect`, `set_effect_order`, `transfer_video_effect_stack`

**Color (1):** `set_color_grading`

**Audio (8):** `set_clip_volume`, `set_clip_fade`, `add_audio_automation`, `add_audio_effect`, `remove_audio_effect`, `update_audio_effect`, `toggle_audio_effect`, `transfer_audio_effect_stack`

**Subtitle (5):** `add_subtitle`, `remove_subtitle`, `update_subtitle`, `import_srt`, `set_subtitle_style`

**Keyframe (3):** `add_keyframe`, `remove_keyframe`, `set_clip_keyframes`

**Transition (3):** `add_transition`, `update_transition`, `remove_transition`

**Marker (3):** `add_marker`, `remove_marker`, `update_marker`

**Graphics/Text (8):** `create_text_clip`, `update_text_clip`, `create_shape_clip`, `update_shape_clip`, `create_sticker_clip`, `update_sticker_clip`, `create_svg_clip`, `update_svg_clip`

**Motion (70+):** `create_motion_composition`, `delete_motion_composition`, `duplicate_motion_composition`, `update_motion_composition`, `add_motion_layer`, `add_motion_layers`, `set_motion_layer_transform`, `animate_layer`, `add_motion_keyframe`, `move_motion_keyframe`, `remove_motion_keyframe`, `apply_motion_template`, `generate_ad_scene`, `apply_motion_animation_preset`, `animate_motion_layers`, `insert_motion_into_editor`, `render_motion_frame`, `set_motion_shape_style`, `add_motion_ui_component`, `arrange_motion_layers`, `align_motion_layers`, `group_motion_layers`, `precompose_motion_layers`, `add_motion_text_animator`, `add_motion_effect`, `add_motion_mask`, `set_motion_track_matte`, `set_motion_camera`, `add_motion_light`, `set_motion_blur`, `create_motion_variable`, `import_svg_composition`, `import_lottie_composition`, `import_figma_composition`, shape contents (14 tools), shape path (5 tools), Scene3D (8 tools), and more

**3D Model (3):** `probe_rigging_backend`, `inspect_3d_model`, `rig_humanoid_model`

**Creation (40+):** `create_creation_3d_scene`, `add_creation_scene_object`, `add_creation_product_part`, `add_creation_screen_stack`, `add_creation_camera_module`, `add_creation_character`, `pose_creation_character`, `add_creation_particle_system`, `simulate_creation_rigid_drop`, `bake_creation_cloth`, `scatter_creation_objects`, `add_creation_decal`, `add_creation_ui_panel`, `create_product_cinematic_scene`, `render_creation_preview`, and more

**Export (4):** `export_motion_video`, `queue_motion_render`, `run_motion_render_queue`, `cancel_motion_render_item`

**Raw (2):** `execute_action`, `batch_actions`

**Multicam (8):** `get_project_manifest`, `get_activity_map`, `get_transcript`, `set_edit_policy`, `annotate_segment`, `get_edit_summary`, `override_cut`, `preview_frame`

**Director (2):** `extract_segments`, `plan_edit`

### Agent Loop Flow

```
User types message in ChatComposer
  → chatStore.send(text)
    → construct messages array
    → makeBYOKClient() (llm-transport.ts)
    → runTurn() from @kove-advanced/agent (loop.ts)
      → send to LLM (Anthropic or OpenAI)
      → LLM returns tool calls
      → executeTool() for each (executor.ts)
        → LiveEditorHost methods (live-host.ts)
          → useProjectStore actions (Zustand)
      → if destructive: InlineConfirmCard (UI gate)
      → repeat until done or budget hit
      → commitTransaction (single undo group)
```

### Tool Router

`selectToolsForPrompt()` in `tool-router.ts`:
- **Always available:** 20 core tools (read state, project CRUD, motion basics)
- Detects keywords: `MOTION_TERMS`, `CREATION_TERMS`, `DIRECTOR_TERMS`
- Scores tools by word overlap + domain match
- Caps at 120 tools (provider limit headroom)

---

## 14. Desktop Bridge

**Type declaration:** `apps/web/src/types/global.d.ts`

```typescript
window["kove-advanced"]?: KoveAdvancedBridge
```

| Namespace | Methods |
|---|---|
| `platform` | `"desktop"` |
| `publicOrigin` | string |
| `probeHardware()` | CPU, memory, GPUs, encoders, platform, arch |
| `onMenuAction(cb)` | Subscribe to menu actions |
| `fs` | `showSaveDialog`, `showOpenDialog`, `readFile`, `readFileBytes`, `tempFilePath`, `writeFile`, `openWrite`, `writeChunk`, `closeWrite`, `abortWrite`, `revealInFolder` |
| `keychain` | `get`, `set`, `delete` |
| `export` | `start`, `writeAudioWav`, `writeAudioChunk`, `finishAudio`, `cancel` |
| `aurora` | `renderPreview`, `startPreviewSession`, `cancelPreviewSession`, `onPreviewEvent`, `startSequenceSession`, `cancelSequenceSession`, `onSequenceEvent` |
| `cloud` | `fetch(service, path, options)` |
| `win` | `minimize`, `toggleMaximize`, `close`, `isMaximized` |
| `lifecycle` | `onQueryUnsaved`, `onFlush` |
| `updater` | `onStatus`, `download`, `install` |
| `crash` | `report` |
| `mcp` | `onRequest`, `getStatus`, `rotateToken`, `testConnection` |
| `media` | `generateProxy`, `transcode`, `extractAudioWav`, `probeAudioStreams`, `fetchUrl` |
| `rigging` | `probeBackend`, `rigHumanoidModel` |

---

## 15. Services Layer

### Agent Services (`apps/web/src/services/agent/`)

| File | Purpose |
|---|---|
| `live-host.ts` | `LiveEditorHost` — bridges agent tools to Zustand store. Transactional editing, media import from URL, overlay CRUD, motion export, rigging |
| `host-singleton.ts` | Singleton + mutex (`runExclusive`) for serialized access |
| `llm-transport.ts` | `makeBYOKClient()` — builds LLM client routing through API proxy |
| `models.ts` | Model registry (empty by design — user-provided endpoints) |
| `model-discovery.ts` | `discoverCompatibleModels()` — GET /models discovery |
| `mcp-listener.ts` | Desktop MCP bridge — forwards external tool calls to shared host |
| `export-job-runner.ts` | Export pipeline: WebCodecs or NativeFFmpeg, video/audio/frame |
| `multicam-bridge.ts` | Multicam host bridge for multi-camera workflows |

### Other Services

| File | Purpose |
|---|---|
| `project-manager.ts` | File-based save/load (File System Access API, desktop fs, download fallback) |
| `auto-save.ts` | Periodic auto-save to IndexedDB with crash recovery |
| `api-proxy.ts` | Unified API proxy: desktop native, compatible endpoints, dev mode, production proxy |
| `share-service.ts` | Cloud file sharing (upload, generate URLs) |
| `export-runner.ts` | UI-side export runner with writable stream management |
| `export-presets.ts` | ~25 platform-specific export presets (YouTube, TikTok, Instagram, ProRes, etc.) |
| `media-storage.ts` | IndexedDB media blob storage |
| `secure-storage.ts` | PBKDF2 + AES-GCM encrypted API key storage |
| `keyboard-shortcuts.ts` | 33 shortcuts across 7 categories, 5 presets (Premiere, FCP, DaVinci) |
| `screen-recorder.ts` | Browser screen recording via getDisplayMedia |
| `ai-shader.ts` | AI GLSL shader generation via LLM |
| `background-generator.ts` | ~30 canvas background presets |
| `motion-presets.ts` | ~25 keyframe animation presets |
| `kieai/` | KieAI client (file upload, image generation, 6 models) |

### Hooks

| File | Purpose |
|---|---|
| `use-router.ts` | Hash-based SPA router |
| `useKeyboardShortcuts.ts` | Global keyboard shortcut registration |
| `useAnalytics.ts` | PostHog analytics |
| `useEditorPreload.ts` | Editor code-splitting preload |
| `useKieAIPoller.ts` | Background KieAI task polling |
| `useProjectRecovery.ts` | Crash recovery dialog |

---

## 16. Data Flow

### Editor → Agent → Editor (round-trip)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  ChatPanel   │────▶│  chatStore   │────▶│  @kove-advanced/ │
│  (UI input)  │     │  .send(text) │     │  agent/loop.ts   │
└─────────────┘     └──────────────┘     │  runTurn()       │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  LLM Provider   │
                                          │  (Anthropic/     │
                                          │   OpenAI)        │
                                          └────────┬────────┘
                                                   │ tool calls
                                          ┌────────▼────────┐
                                          │  executor.ts    │
                                          │  executeTool()  │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  live-host.ts   │
                                          │  LiveEditorHost │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  useProjectStore│
                                          │  (Zustand)      │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  Editor UI      │
                                          │  (reactive)     │
                                          └─────────────────┘
```

### Project State Persistence

```
Memory (Zustand)
  ↔ Auto-save (IndexedDB, 30s interval)
  ↔ File System (.oreel JSON files)
  ↔ Cloud (optional share/upload)
```

### Export Pipeline

```
Project State
  → ExportEngine.exportVideo()
  → WebCodecs (browser) or NativeFFmpeg (desktop)
  → Frame-by-frame rendering through video/audio/composite engines
  → Writable stream (File System Access API or OPFS fallback)
  → Output file (mp4/webm/mov)
```

---

## 17. Engine Architecture

All engines live in `packages/core/src/` and are singletons accessed via `useEngineStore`.

| Engine | Directory | Purpose |
|---|---|---|
| VideoEngine | `video/` (52 files) | Composite, decode, render, effects, GPU compositor, WebGPU |
| AudioEngine | `audio/` | Playback, effects, beat detection, FFT, noise reduction |
| PlaybackController | `playback/` | Master clock, transport control |
| TitleEngine | `text/` | Text clip rendering, text animations |
| SubtitleEngine | `text/` | Subtitle rendering, caption animation |
| GraphicsEngine | `graphics/` | Shape, sticker, SVG rendering |
| ExportEngine | `export/` | WebCodecs encoding, compression |
| PhotoEngine | `photo/` | Photo editing, adjustments |
| SpeechToTextEngine | `text/` | Local speech recognition |
| TemplateEngine | `template/` | Editing template system |
| SoundLibraryEngine | `audio/` | Sound library browsing |
| ChromaKeyEngine | `video/` | Green screen keying |
| MultiCamEngine | `multicam/` | Multi-camera editing |
| MaskEngine | `video/` | Shape masking |
| NestedSequenceEngine | `timeline/` | Nested timeline sequences |
| AdjustmentLayerEngine | `video/` | Adjustment layers |
| MotionEngine | `motion/` (136 files) | After Effects-style compositions |
| CreationEngine | `creation/` | Agent-native 3D creation |

### WASM Modules (`packages/core/src/wasm/`)

| Module | Purpose |
|---|---|
| `fft/` | Fast Fourier Transform (AssemblyScript) |
| `wav/` | WAV encoding/decoding |
| `beat-detection/` | Audio beat detection |

---

## 18. File Path Quick Reference

### Core Application
```
apps/web/src/main.tsx                          — Entry point
apps/web/src/App.tsx                           — Root component, routing
apps/web/src/hooks/use-router.ts               — Hash router
apps/web/src/index.css                         — Design tokens (light/dark themes)
apps/web/vite.config.ts                        — Vite config
```

### Editor
```
apps/web/src/components/editor/EditorInterface.tsx  — Main editor layout
apps/web/src/components/editor/Toolbar.tsx          — Top bar
apps/web/src/components/editor/EditorActionRail.tsx — Left tool rail
apps/web/src/components/editor/AssetsPanel.tsx      — Left panel (8 tabs)
apps/web/src/components/editor/Preview.tsx          — Canvas preview (~3000 lines)
apps/web/src/components/editor/InspectorPanel.tsx   — Right panel
apps/web/src/components/editor/Timeline.tsx         — Bottom timeline
apps/web/src/components/editor/KeyframeEditorPanel.tsx — Keyframe editor
```

### Inspector Tabs
```
apps/web/src/components/editor/inspector/tabs/TransformTab.tsx
apps/web/src/components/editor/inspector/tabs/StyleTab.tsx
apps/web/src/components/editor/inspector/tabs/ColorTab.tsx
apps/web/src/components/editor/inspector/tabs/EffectsTab.tsx
apps/web/src/components/editor/inspector/tabs/AudioTab.tsx
apps/web/src/components/editor/inspector/tabs/SpeedTab.tsx
apps/web/src/components/editor/inspector/tabs/AnimateTab.tsx
apps/web/src/components/editor/inspector/tabs/AiTab.tsx
```

### Inspector Sections
```
apps/web/src/components/editor/inspector/TransformSection.tsx
apps/web/src/components/editor/inspector/VideoEffectsSection.tsx
apps/web/src/components/editor/inspector/TextSection.tsx
apps/web/src/components/editor/inspector/TextAnimationSection.tsx
apps/web/src/components/editor/inspector/ShapeSection.tsx
apps/web/src/components/editor/inspector/AudioSection.tsx
apps/web/src/components/editor/inspector/BackgroundRemovalSection.tsx
apps/web/src/components/editor/inspector/ParticleEffectsSection.tsx
apps/web/src/components/editor/inspector/ShaderControls.tsx
apps/web/src/components/editor/inspector/MultiCameraPanel.tsx
```

### Chat / Agent
```
apps/web/src/components/editor/chat/ChatPanel.tsx
apps/web/src/components/editor/chat/ChatComposer.tsx
apps/web/src/components/editor/chat/ChatMessage.tsx
apps/web/src/components/editor/chat/ChatHistoryPanel.tsx
apps/web/src/components/editor/chat/ChatErrorCard.tsx
apps/web/src/components/editor/chat/ToolCallCard.tsx
apps/web/src/components/editor/chat/InlineConfirmCard.tsx
apps/web/src/components/editor/chat/MarkdownMessage.tsx
apps/web/src/components/editor/chat/ProviderModelPicker.tsx
```

### Agent Runtime
```
packages/agent/src/registry.ts               — All 223+ tool definitions
packages/agent/src/system-prompt.ts          — System prompt builder
packages/agent/src/loop.ts                   — Agentic loop (runTurn)
packages/agent/src/executor.ts               — Tool execution
packages/agent/src/tool-router.ts            — Prompt → tool selection
packages/agent/src/llm.ts                    — LLM client abstraction
packages/agent/src/serialize.ts              — Editor state serialization
packages/agent/src/director/genres.ts        — 7 pre-baked genres
packages/agent/src/director/director-prompt.ts — Monet system prompt
```

### Director Types
```
packages/creation-schema/src/director/segment-map.ts   — SegmentMap
packages/creation-schema/src/director/edit-plan.ts     — EditPlan
packages/creation-schema/src/director/genre.ts         — Genre
packages/creation-schema/src/director/validate.ts      — Validation
```

### Desktop Bridge
```
apps/web/src/types/global.d.ts               — KoveAdvancedBridge type
apps/web/src/services/native-ffmpeg-backend.ts — Native FFmpeg encoder
apps/web/src/services/native-media-bridge.ts  — Native media bridge
apps/web/src/services/native-aurora-bridge.ts — Aurora 3D bridge
apps/web/src/desktop/DesktopApp.tsx           — Desktop shell
```

### Services
```
apps/web/src/services/agent/live-host.ts      — Agent ↔ editor bridge
apps/web/src/services/agent/host-singleton.ts — Singleton + mutex
apps/web/src/services/agent/llm-transport.ts  — LLM HTTP transport
apps/web/src/services/agent/export-job-runner.ts — Export pipeline
apps/web/src/services/agent/mcp-listener.ts   — MCP bridge listener
apps/web/src/services/project-manager.ts      — Save/load
apps/web/src/services/auto-save.ts            — Auto-save + recovery
apps/web/src/services/api-proxy.ts            — API proxy
apps/web/src/services/secure-storage.ts       — Encrypted key storage
```

### Stores
```
apps/web/src/stores/project-store.ts         — Core project data
apps/web/src/stores/ui-store.ts              — UI state
apps/web/src/stores/timeline-store.ts        — Timeline state
apps/web/src/stores/chat-store.ts            — AI chat state
apps/web/src/stores/settings-store.ts        — Settings
apps/web/src/stores/theme-store.ts           — Theme
apps/web/src/stores/engine-store.ts          — Engine singletons
apps/web/src/stores/chat-history-store.ts    — Conversation history
apps/web/src/stores/notification-store.ts    — Toast notifications
apps/web/src/stores/kieai-store.ts           — AI generation tasks
apps/web/src/stores/recorder-store.ts        — Screen recording
apps/web/src/stores/tts-store.ts             — TTS audio
```

### Core Types
```
packages/core/src/types/project.ts           — Project, MediaItem
packages/core/src/types/timeline.ts          — Track, Clip, Effect, Keyframe
packages/core/src/types/effects.ts           — Effect types, params
packages/core/src/types/actions.ts           — Action system
packages/core/src/types/composition.ts       — Motion composition types
packages/core/src/types/transform-3d.ts      — 3D transforms
packages/core/src/types/template.ts          — Templates
packages/core/src/types/sound-library.ts     — Sound library
packages/core/src/types/result.ts            — Result<T,E>
packages/core/src/types/transitions.ts       — Transitions
```

### Welcome Screen
```
apps/web/src/components/welcome/WelcomeScreen.tsx
apps/web/src/components/welcome/TemplateGallery.tsx
apps/web/src/components/welcome/RecentProjects.tsx
apps/web/src/components/welcome/RecoveryDialog.tsx
```

### Motion Creator
```
apps/web/src/motion/MotionCreatorApp.tsx
apps/web/src/motion/MotionCreatorShell.tsx
apps/web/src/motion/components/              — 30+ motion-specific components
```

### Frame Worker (Cloudflare)
```
packages/frame-worker/src/index.ts           — Orchestrator
packages/frame-worker/src/frame-extraction.ts — Scene detection + adaptive sampling
packages/frame-worker/src/worker.ts          — Vision API calls
```
