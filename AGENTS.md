K.O.V.E - KREATE. ORKESTRATE. VISUALIZE. EXPORT.

Browser-based professional video editor. MIT licensed. Monorepo managed with pnpm workspaces.

## Product vision

K.O.V.E. is not a timeline editor with an AI bolted on. It is a chat-first AI director (**Monet**) that can fully author an edit on its own, sitting on top of a real, full-power timeline editor (**Kove-Advanced**) the user can take over at any point. Build toward that split — a fast, low-friction "just make it" path, and a real editor underneath it, not a toy preview.

**Full flow, login to export:** see `monet-kove-flow-spec.md` (shipped alongside this file) for the complete stage-by-stage breakdown, the flowchart, and data-object shapes. Summary:

1. User logs in → dashboard's center element is a chat box: `"Ready to kreate, {Username}?"`. This is the single entry point — no separate "new project" wizard.
2. User uploads ≥1 video (required; can be one long-form VOD/podcast/stream, or multiple mixed-length clips — bloopers, cuts, vlog moments) plus optional music, images, and brief/spec files.
3. User gives a prompt. Detailed prompt, or a genre picked (custom or pre-baked) → Monet proceeds straight to directing. Vague prompt with no genre → Monet asks targeted clarifying questions first (see Product decisions below for the exact rubric).
4. A frame-extraction worker (Python) samples the footage and batches frames into carousels for vision analysis — this service is not yet reflected in the package map below; treat it as an external/planned component until it's added to the monorepo.
5. Monet chops long-form input into feasible sections (preserving the source's topic intent and the user's prompt intent), then authors an EDL: cuts, placement of user-supplied extra files, overlays, effects/transitions (via the typed effect system), and text elements with independently tweakable properties (font, size, position, timing).
6. The draft renders in Kove-Advanced. User can accept and export as-is, ask Monet to refine via chat, or hit **"Jump to Advanced"** to take manual control of the same project/EDL state — no re-import.
7. Handoff is two-way: mostly one-way in practice, but there's a "Back to Simple" path where Monet resumes directing from the current EDL state rather than starting over.
8. Export renders through the existing render pipeline.

Where this maps onto the package map: Monet's AI-director logic belongs in `packages/agent` / `packages/creation-agent` (tool definitions) and `packages/agent-runner` (headless/automated execution), authoring against `packages/creation-schema`. The editor itself — cuts, effects, text, export — is `packages/core` plus `apps/web`.

### Product decisions (resolved — build to these, don't re-litigate)

- **Prompt-detail rubric**: a prompt skips clarifying Q&A only if it specifies (a) tone/vibe, (b) target length or platform, and (c) what to keep vs cut. Missing one → Monet asks about just that gap, not a full interview. A selected genre (custom or pre-baked) also skips Q&A regardless of prompt detail.
- **Frame sampling**: adaptive, not fixed-fps. Baseline ~1-2fps; burst to 8-12fps for a few seconds around a detected scene cut or high motion delta. Budget per video against the shared vision-model quota (`min(baseline_frames + burst_frames, daily_quota / expected_concurrent_uploads)`) and degrade to baseline-only once a video hits its share.
- **Post-handoff targeted AI edits** reuse the existing per-video `SegmentMap` from the initial frame analysis — no re-run unless the user adds new source material in that request.
- **Handoff direction**: two-way. "Jump to Advanced" is the common path; a "Back to Simple" path also exists, and Monet resumes directing from the current EDL state, not from scratch.
- **Genres**: pre-baked genres live in config; user-created custom genres save to the user's account for reuse across projects, not re-entered each time.

## Essential commands

```bash
# Full verification (run in this order)
pnpm typecheck
pnpm test
pnpm lint

# Single test run (not watch)
pnpm test:run

# Single-package verification
pnpm --filter @kove-advanced/core typecheck
pnpm --filter @kove-advanced/core test:run

# Dev server (web app)
pnpm dev            # starts Vite dev server on http://localhost:5173

# Build (requires WASM first)
pnpm build:wasm     # builds AssemblyScript WASM modules
pnpm build          # builds web app

# Desktop app
pnpm --filter @kove-advanced/desktop build:renderer
pnpm --filter @kove-advanced/desktop build:main
pnpm --filter @kove-advanced/desktop dev
```

## Package map

- **`apps/web`** — Main React frontend (Vite, deployed to Cloudflare Pages)
- **`apps/desktop`** — Electron desktop app (CJS main process, builds renderer from web)
- **`apps/studio`** — Separate React app (Vite + Playwright E2E)
- **`apps/image`** — Image editing app (Vite, deployed to Cloudflare Pages)
- **`packages/core`** — All processing engines: video, audio, graphics, text, export, WASM
- **`packages/agent`** — AI agent tool definitions (depends on core + creation-schema)
- **`packages/agent-runner`** — Headless CLI for automated edits (`kove-advanced-agent` binary)
- **`packages/ui`** — Shared Radix-based component library (no tests, typecheck only)
- **`packages/creation-schema`** — Zod schemas for creation engine
- **`packages/creation-bindings`** — Native addon / WASM bindings with CPU fallback
- **`packages/creation-agent`** — Agent-native creation tool definitions
- **`packages/creation-core`** — C++20 native core (CMake, separate build)
- **`packages/fxpkg`** — Effect preset packages
- **`packages/image-core`** — Image processing core

## Gotchas

- **WASM build required before full build**: `pnpm build:wasm` runs AssemblyScript compiler for FFT, WAV, and beat-detection modules. Output goes to `packages/core/src/wasm/*/build/`.
- **Desktop is CommonJS**: `apps/desktop` uses `"type": "commonjs"` while every other package is `"type": "module"`. The main process is bundled via tsup.
- **Desktop renderer build is a prerequisite**: `apps/desktop/build:renderer` runs `KOVE_ADVANCED_DESKTOP=1 pnpm --filter @kove-advanced/web build`, which activates desktop-specific Vite plugins.
- **Vite dev server needs COOP/COEP headers**: SharedArrayBuffer (used by FFmpeg.wasm) requires `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Configured in `apps/web/vite.config.ts`.
- **Patched dependencies**: `@ffmpeg/core` and `@ffmpeg/core-mt` are patched via `patches/` (pnpm `patchedDependencies`).
- **`@kove-advanced/ui` has no lint/test scripts**: Only `typecheck`. Don't expect `pnpm --filter @kove-advanced/ui test` to work.
- **Astryx design system**: `apps/web` uses `@astryxdesign/core`. Import reset CSS + theme CSS in the app entry. See `ASTRYX.md` for component workflow.
- **`KOVE_ADVANCED_DESKTOP=1`**: Env var that toggles desktop-specific behavior in the web Vite config.

## Path aliases

Defined in `tsconfig.base.json` and mirrored in `apps/web/vite.config.ts`:
- `@kove-advanced/core` → `packages/core/src`
- `@kove-advanced/agent` → `packages/agent/src`
- `@kove-advanced/ui` → `packages/ui/src`
- `@/*` → `apps/web/src` (web app only)

## Testing

- **Framework**: Vitest across the monorepo. `apps/studio` also has Playwright for E2E.
- **Run all tests**: `pnpm test:run` (uses `vitest run` in each package).
- **Run in watch mode**: `pnpm test` (uses `vitest` without `run`).
- **Golden tests**: Desktop Aurora goldens at `apps/desktop/test/goldens/`. Refresh with `UPDATE_AURORA_GOLDENS=1 vitest run test/aurora-golden.test.ts`.

## Deployment

- **Web**: Cloudflare Pages via Wrangler (`pnpm --filter @kove-advanced/web deploy`). Project: `kove-advanced`.
- **Image app**: Cloudflare Pages. Project: `kove-advanced-image`.
- **Desktop**: Electron-builder (`pnpm --filter @kove-advanced/desktop dist`). Fetches platform FFmpeg binaries first.

## Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `perf:`
- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters` enabled
- No `any` — use `unknown` or proper types
- React 19, Zustand for state, Three.js for 3D, GSAP for animation
- Engine separation: video, audio, graphics engines are independent in `packages/core`