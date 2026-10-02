import type { EditingHost } from "./host";
import type { RegisteredTool } from "./registry";
import type { JSONSchema, ToolResult } from "./types";

const fail = (code: string, message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code, message, suggestedFix },
});

const properties: Record<string, JSONSchema> = {
  time: { type: "number", minimum: 0, description: "Timeline time in seconds." },
  maxDimension: {
    type: "integer",
    minimum: 64,
    maximum: 2048,
    description: "Longest output edge in pixels. Default 768 (enough to judge framing and text, cheap to send).",
  },
  format: { type: "string", enum: ["png", "jpeg"], description: "Default png." },
};

/**
 * Timeline frame rendering. The tool is the host-independent half: validation, capability gating and result shape.
 * The compositor lives in the host; a host that cannot render says so (UNSUPPORTED_HOST) and never returns a stand-in image.
 */
export const RENDER_TOOLS: RegisteredTool[] = [
  {
    name: "render_timeline_frame",
    domain: "read",
    title: "Render timeline frame",
    description:
      "Render the composited main timeline (all tracks, effects, text, transitions) at one instant and return it as an image you can look at. Use it to verify an edit visually. Different from render_motion_frame, which renders one motion composition in isolation. Check get_capabilities → host.renderTimelineFrame first: a false flag means this returns UNSUPPORTED_HOST and you should not retry.",
    inputSchema: { type: "object", properties, required: ["time"], additionalProperties: false },
    readOnly: true,
    destructive: false,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      const time = args.time as number;
      const maxDimension = (args.maxDimension as number | undefined) ?? 768;
      const format = (args.format as "png" | "jpeg" | undefined) ?? "png";

      if (host.features?.().renderTimelineFrame !== true || typeof host.renderTimelineFrame !== "function") {
        return fail(
          "UNSUPPORTED_HOST",
          "render_timeline_frame is not available on this host (no timeline compositor).",
          "Do not retry. Check get_capabilities → host.renderTimelineFrame. Use get_timeline to inspect the edit structurally instead.",
        );
      }
      const duration = host.getProject().timeline.duration;
      if (time > duration) {
        return fail(
          "INVALID_PARAMS",
          `time ${time}s is past the end of the timeline (${duration}s).`,
          `Pass a time between 0 and ${duration}.`,
        );
      }

      const frame = await host.renderTimelineFrame({ time, maxDimension, format });
      if ("code" in frame) {
        return fail("UNSUPPORTED_HOST", frame.error, "Do not retry on this host.");
      }
      const expected = format === "png" ? "image/png" : "image/jpeg";
      if (frame.mimeType !== expected || !frame.dataUrl.startsWith(`data:${expected};base64,`) || frame.width < 1 || frame.height < 1) {
        return fail(
          "RENDER_FAILED",
          "The host returned a malformed frame.",
          "This is a host bug, not a problem with the arguments. Report it; do not retry with the same arguments.",
        );
      }
      return {
        ok: true,
        summary: `Rendered timeline at ${time.toFixed(2)}s (${frame.width}x${frame.height}, ${frame.renderer})`,
        data: { time, width: frame.width, height: frame.height, renderer: frame.renderer, mimeType: frame.mimeType },
        image: { dataUrl: frame.dataUrl, mimeType: frame.mimeType },
      };
    },
  },
];
