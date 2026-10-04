import { LiveEditorHost } from "./live-host";

let hostSingleton: LiveEditorHost | null = null;

/**
 * One shared LiveEditorHost for every in-renderer agent entry point (the BYOK
 * chat panel and the desktop MCP bridge) so their edits land in a single,
 * consistent undo history rather than fighting over transaction bookkeeping.
 */
export function getLiveEditorHost(): LiveEditorHost {
  return (hostSingleton ??= new LiveEditorHost());
}

let hostLock: Promise<unknown> = Promise.resolve();

/**
 * Serializes access to the shared host so a chat turn and an external MCP tool
 * call never interleave their undo transactions on the same project-store.
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = hostLock.then(fn, fn);
  hostLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Manual smoke hook: `__koveSmoke.renderTimelineFrame(time)` in the browser
 * console renders one composited timeline frame through the real host and
 * overlays the result, so a human can verify the compositor without an LLM
 * in the loop. See apps/web/scripts/smoke-render-timeline-frame.md.
 */
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  if (!("__koveSmoke" in w)) {
    w.__koveSmoke = {
      async renderTimelineFrame(
        time = 1,
        maxDimension = 768,
        format: "png" | "jpeg" = "png",
      ) {
        const host = getLiveEditorHost();
        const result = await runExclusive(() =>
          host.renderTimelineFrame({ time, maxDimension, format }),
        );
        if ("code" in result) {
          console.error(`[smoke] UNSUPPORTED_HOST: ${result.error}`);
          return result;
        }
        console.log(
          `[smoke] rendered ${result.width}x${result.height} (${result.renderer}, ${result.mimeType}, ${Math.round(result.dataUrl.length / 1024)} KiB)`,
        );
        const img = document.createElement("img");
        img.src = result.dataUrl;
        img.alt = `timeline frame @ ${time}s`;
        img.style.cssText =
          "position:fixed;right:16px;bottom:16px;z-index:99999;max-width:480px;" +
          "max-height:40vh;border:2px solid #22c55e;border-radius:8px;background:#000;cursor:pointer;";
        img.title = "Click to dismiss";
        img.onclick = () => img.remove();
        document.body.appendChild(img);
        return result;
      },
    };
  }
}
