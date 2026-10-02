# Timeline frame rendering (`render_timeline_frame`)

Status: **host contract and tool are built and unit-tested. No host renders yet. The compositor and the
browser golden-image test are NOT built, so nothing here is verified visually.**

## What exists

- `EditingHost.renderTimelineFrame?(request)` and `HostFeatures.renderTimelineFrame` (`packages/agent/src/host.ts`).
- Tool `render_timeline_frame` (`tools-render.ts`; strict, read-only): `time` (required, seconds), `maxDimension` (64–2048, default 768), `format` (`png`|`jpeg`).
- Behaviour, unit-tested (`tools-render.test.ts`, 9 tests):
  - `HeadlessHost` and `LiveEditorHost` report `renderTimelineFrame:false`; the tool returns `UNSUPPORTED_HOST` with a `suggestedFix` and **no image**. `get_capabilities` reports the flag.
  - A false flag wins even if a host defines the method.
  - Bad arguments and `time` past the timeline end are rejected before the host is called.
  - A host answer of `unsupported_host`, or a malformed frame (wrong MIME, bad data URL, zero size), is refused; a placeholder is never passed on.

## What does not exist (and why)

- A live implementation. The compositor (`packages/core/src/video`, WebGPU with a canvas2d fallback, WebCodecs decode) runs only in a browser with real media.
  `exportFrame` renders motion compositions only, so it cannot back this tool.
- Golden-image verification. The sandbox has no browser, `apps/web` dependencies were not installed, and `.github/workflows/ci.yml` has no Playwright job (Playwright exists only in `apps/studio`).

## Plan to finish (agreed approach)

1. Implement `LiveEditorHost.renderTimelineFrame` on the existing preview compositor; flip the flag only when it is present.
2. Playwright test: load a fixture project, render fixed times, compare against committed goldens with per-pixel tolerance. Generate goldens in CI's browser (software renderer), not on a developer GPU.
3. Add a CI job. **Until that job is green, treat the renderer as unverified.** Run it on your own machine too.
