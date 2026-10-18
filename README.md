# Kove Advanced Video

A professional video editor that runs entirely client-side in the browser and
desktop, with an AI director that plans and applies multi-track edits from a
plain-language brief. Built with React, TypeScript, WebCodecs, and WebGPU.

**Live:** https://kove-advanced.video · **Docs:** [CONTRIBUTING.md](CONTRIBUTING.md)

> This repository is the source of record for the Kove Advanced product. It is
> proprietary — see [SECURITY-ROTATION.md](SECURITY-ROTATION.md) for the
> credential and rotation model that applies to production deployments.

---

## Why Kove Advanced?

- **Client-first** - Media is processed on your device. No uploads to a
  general-purpose cloud, no installs.
- **Professional features** - Multi-track timeline, keyframe animation, color
  grading, audio effects, and more.
- **GPU accelerated** - WebCodecs and WebGPU for smooth 4K editing and fast
  export.
- **AI director** - The `plan_edit` pipeline turns a written brief into a
  structured, validated edit plan and applies it to the timeline.

---

## Features

### Video Editing
- **Multi-track timeline** - Unlimited video, audio, image, text, and graphics tracks
- **Real-time preview** - Smooth playback with GPU acceleration
- **Precision editing** - Frame-accurate scrubbing, cut, trim, split, ripple delete
- **Transitions** - Crossfade, dip to black/white, wipe, slide effects
- **Video effects** - Brightness, contrast, saturation, blur, sharpen, glow, vignette, chroma key
- **Blend modes** - Multiply, screen, overlay, add, subtract, and more
- **Speed control** - 0.25x to 4x with audio pitch preservation
- **Crop & transform** - Position, scale, rotation with 3D perspective

### Graphics & Text
- **Professional text editor** - Rich styling, shadows, outlines, gradients
- **20+ text animations** - Typewriter, fade, slide, bounce, pop, elastic, glitch
- **Karaoke-style subtitles** - Word-by-word highlighting synced to audio
- **Shape tools** - Rectangle, circle, arrow, polygon, star with fill/stroke
- **SVG support** - Import SVGs with color tinting and animations
- **Stickers & emoji** - Built-in library
- **Background generator** - Solid colors, gradients, mesh gradients, patterns
- **Keyframe animations** - Animate any property over time with 20+ easing curves

### Audio
- **Multi-track mixing** - Unlimited audio tracks with real-time mixing
- **Waveform visualization** - Visual audio editing
- **Audio effects** - EQ, compressor, reverb, delay, chorus, flanger, distortion
- **Volume & panning** - Per-clip controls with fade in/out
- **Beat detection** - Auto-generate markers synced to music
- **Audio ducking** - Auto-reduce music when dialog plays
- **Noise reduction** - 3-pass noise removal (tonal, broadband, rumble)

### Color Grading
- **Color wheels** - Lift, gamma, gain controls
- **HSL adjustments** - Hue, saturation, lightness fine-tuning
- **Curves editor** - RGB and individual channel curves
- **LUT support** - Import and apply 3D LUTs
- **Built-in presets** - One-click color grading

### Export
- **MP4 (H.264/H.265)** - Universal compatibility
- **WebM (VP8/VP9/AV1)** - Web-optimized format
- **ProRes** - Professional intermediate format (Proxy, LT, Standard, HQ, 4444)
- **Quality presets** - 4K @ 60fps, 1080p, 720p, 480p
- **Custom settings** - Bitrate, frame rate, codec options, color depth
- **Hardware encoding** - WebCodecs for fast export
- **AI upscaling** - Enhance resolution with WebGPU shaders
- **Audio export** - MP3, WAV, AAC, FLAC, OGG
- **Image sequences** - JPG, PNG, WebP frame export
- **Progress tracking** - Real-time progress with cancel support

### Professional Tools
- **Unlimited undo/redo** - Full history with recovery
- **Auto-save** - Never lose work (IndexedDB storage)
- **Keyboard shortcuts** - Professional workflow
- **Snap to grid** - Magnetic alignment
- **Track management** - Show/hide, lock/unlock, reorder
- **Subtitle support** - SRT import with customizable styling
- **Screen recording** - Record screen, camera, or both
- **Project sharing** - Export/import project files

### Performance
- **WebGPU rendering** - GPU-accelerated compositing
- **WebCodecs API** - Hardware video decoding/encoding
- **Frame caching** - LRU cache for smooth playback
- **Web Workers** - Background processing
- **4K support** - Edit and export in 4K resolution

---

## Quick Start

### Try Online
Visit **https://kove-advanced.video** to start editing immediately.

### Run Locally

```bash
# Install dependencies (requires Node.js 22+)
pnpm install

# Start the development server
pnpm dev

# Open http://localhost:5173
```

### Build for Production

```bash
pnpm build
pnpm preview
```

> **Credentials.** The dev server reads Cloudflare Workers AI credentials from
> the repository-root `.dev.vars` (never from `VITE_*` variables — a CI gate
> fails the build on any secret-looking `VITE_*` name). Production deployments
> use Cloudflare Pages secrets. See [SECURITY-ROTATION.md](SECURITY-ROTATION.md)
> and [apps/web/.env.example](apps/web/.env.example).

---

## Browser Requirements

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 94+ | Full support |
| Edge | 94+ | Full support |
| Firefox | 130+ | Full support |
| Safari | 16.4+ | Full support |

All major browsers now support WebCodecs for hardware-accelerated video
encoding/decoding.

**Recommended:**
- 8GB+ RAM
- Dedicated GPU for 4K editing
- Modern multi-core CPU

---

## Architecture

### Monorepo Structure

```
kove-advanced/
├── apps/web/              # React frontend (Vite + Cloudflare Pages)
│   ├── src/
│   │   ├── components/    # UI components
│   │   │   └── editor/    # Editor panels (Timeline, Preview, Inspector)
│   │   ├── stores/        # Zustand state management
│   │   ├── services/      # Agent, LLM transport, analytics, storage
│   │   └── bridges/       # Engine coordination
│   └── functions/         # Server-side Pages Functions (LLM gateway)
│
├── apps/desktop/          # Electron desktop app
│
└── packages/              # Shared libraries
    ├── core/              # Video/audio/graphics engines (~59k lines)
    ├── agent/             # Director, tool registry, agent loop
    ├── creation-schema/   # Edit-plan schema + validation
    └── ...                # frame-worker, agent-runner, ui
```

### Key Technologies

- **React 18** + **TypeScript** - Type-safe UI
- **Zustand** - Lightweight state management
- **MediaBunny** - Video/audio processing
- **WebCodecs** - Hardware encoding/decoding
- **WebGPU** - GPU-accelerated rendering
- **Web Audio API** - Professional audio processing
- **THREE.js** - 3D transforms and effects
- **IndexedDB** - Local project storage

### Design Principles

- **Action-based editing** - Every edit is an undoable action
- **Immutable state** - Predictable updates with Zustand
- **Engine separation** - Video, audio, graphics engines are independent
- **Progressive enhancement** - Graceful fallbacks (WebGPU → Canvas2D)
- **Server-side credentials** - Provider tokens never ship in the client
  bundle; the browser talks to a same-origin gateway only

---

## Security Model

Provider credentials (LLM, etc.) are **never** part of the client bundle:

- **Browser (production):** requests go to the same-origin
  `/api/llm/*` Pages Function, which attaches Cloudflare Pages secrets.
- **Browser (dev):** the Vite dev proxy attaches credentials from `.dev.vars`,
  read by the Node dev server — never inlined as `VITE_*` variables.
- **Desktop:** the Electron main process attaches credentials from its runtime
  environment; the renderer relays through a local IPC bridge.

CI enforces this with two gates: `scripts/check-vite-secrets.mjs` (no
secret-looking `VITE_*` names in source) and `scripts/check-bundle-secrets.mjs`
(no credential-looking values or the direct provider host in the built bundle),
plus `gitleaks` over git history.

---

## Roadmap

### Completed
- Multi-track timeline with drag-and-drop
- Real-time video preview with GPU acceleration
- Full editing suite (cut, trim, split, transitions)
- Text editor with 20+ animations
- Graphics (shapes, SVG, stickers, backgrounds)
- Audio mixing with effects and beat detection
- Color grading with LUT support
- Keyframe animation system
- Export to MP4/WebM (4K supported)
- Screen recording
- Undo/redo with auto-save
- AI director (`plan_edit`) with validated, reproducible edit plans

### In Progress
- Nested sequences (timeline in timeline)
- Motion tracking
- More export formats (ProRes, GIF)
- Plugin system

### Planned
- Adjustment layers
- Advanced masking
- Audio spectral editing
- Collaborative editing
- Mobile optimization

---

## License

This repository is currently licensed under the terms in
[LICENSE](LICENSE) (Copyright (c) 2024-2026 Augustus Otu and Contributors).
The product is transitioning to a closed-source, subscription-based service;
the licensing and distribution terms for new releases are an open owner
decision and will be restated here when finalized.

---

## Acknowledgments

**Built with:**
- [MediaBunny](https://mediabunny.dev) - Media processing
- [React](https://react.dev) - UI framework
- [Zustand](https://zustand-demo.pmnd.rs/) - State management
- [THREE.js](https://threejs.org) - 3D rendering
- [TailwindCSS](https://tailwindcss.com) - Styling
