import { describe, expect, it, vi } from "vitest";
import {
  logAIDiagnostic,
  sanitizeAIDiagnosticPayload,
} from "./console-diagnostics";

describe("AI console diagnostics", () => {
  it("keeps prompts while redacting credentials and image bytes", () => {
    const dataUrl = `data:image/png;base64,${"a".repeat(512)}`;
    expect(sanitizeAIDiagnosticPayload({
      apiKey: "should-not-appear",
      apiToken: "also-private",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `Make the opening tighter. data:image/png;base64,${"a".repeat(512)}`,
      }],
      image: dataUrl,
      base64: "encoded-frame",
    })).toEqual({
      apiKey: "[REDACTED]",
      apiToken: "[REDACTED]",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: `Make the opening tighter. data:image/png;base64,[base64 omitted: 512 characters]`,
      }],
      image: "data:image/png;base64,[base64 omitted: 512 characters]",
      base64: "[binary omitted: 13 characters]",
    });
  });

  it("writes structured diagnostics to the browser console", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      logAIDiagnostic("tool call", { name: "trim_clip", args: { clipId: "clip-1" } });
      expect(info).toHaveBeenCalledWith(
        "[KOVE AI] tool call",
        expect.objectContaining({
          name: "trim_clip",
          args: { clipId: "clip-1" },
          timestamp: expect.any(String),
        }),
      );
    } finally {
      info.mockRestore();
    }
  });
});
