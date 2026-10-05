# Smoke: renderTimelineFrame (web host)

The agent sandbox cannot run a browser, so this verification is a runbook
for a human with the app open. It exercises the real compositor path:
`LiveEditorHost.renderTimelineFrame` → `RenderBridge` → `VideoEngine` →
scaled PNG/JPEG data URL.

## Prereqs

```sh
pnpm install
pnpm --filter @kove-advanced/web dev
```

Open the app, open (or create) a project that has at least one video clip
on the timeline. If `window.__koveSmoke` is undefined in the console, open
the AI chat panel once (it loads the host singleton), then continue.

## 1. Console smoke (no LLM involved)

In the browser DevTools console:

```js
// Render at 1s, longest edge 768px, PNG:
await __koveSmoke.renderTimelineFrame(1);

// Other checks:
await __koveSmoke.renderTimelineFrame(0);          // first frame
await __koveSmoke.renderTimelineFrame(2, 384);     // smaller
await __koveSmoke.renderTimelineFrame(1, 768, "jpeg");
```

Each call logs `[smoke] rendered WxH (web/canvas2d, image/png, N KiB)` and
overlays the frame bottom-right (click it to dismiss).

**Pass criteria**

- [ ] The overlay shows the composited frame (video content, not black),
      matching what the preview shows at that time.
- [ ] Dimensions respect `maxDimension` (768 → 768×432 for 16:9).
- [ ] No `[smoke] UNSUPPORTED_HOST` errors. If you see one, note the error
      text — it names the failing stage (compositor init vs. frame decode).

**Timed-effect check (pairs with the duration fix).** Add a short
`startOffset`/`duration` effect to a clip (e.g. a 0.3s look via plan_edit or
by editing clip effect params), then render a frame *inside* the window and
one *outside*: the look must appear on exactly one of the two frames.

## 2. Agent-tool smoke (LLM in the loop)

In the in-app agent chat, with the same project open:

> Render a timeline frame at 1 second and tell me what you see.

**Pass criteria**

- [ ] The agent calls `render_timeline_frame` (visible in the tool-call
      trace) and returns an image, not UNSUPPORTED_HOST.
- [ ] `get_capabilities → host.renderTimelineFrame` reports `true`.

## 3. Related QC (same machine, needs ffmpeg)

After exporting a file, the agent can call `measure_export({ path,
expectedDurationSec })` — on a host with ffmpeg/ffprobe it returns loudness,
true peak, black/silence/freeze events and duration drift. Sanity check:

> Measure the exported file at <path> against an expected duration of <N> seconds.

**Pass criteria**: a report with `I=… LUFS`, `TP=… dBTP`, `drift=…s`, not
UNSUPPORTED_HOST. (The sandbox that wrote this code only tested the parsers
against recorded ffmpeg output.)

## If something fails

- UNSUPPORTED_HOST from console smoke with "compositor unavailable" → the
  engine store was not initialized; load the editor view first.
- A rendered frame that is black where content should be → media decode
  issue, not the host wiring; check the browser console for VideoEngine
  warnings.
- Report results back with the exact `[smoke]` log line and, for failures,
  the console error text.
