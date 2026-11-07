import { describe, expect, it } from "vitest";
import { shouldSeekNativePlaybackSegment } from "./native-playback-sync";

describe("native preview segment synchronization", () => {
  it("does not seek again while a clip is playing", () => {
    expect(shouldSeekNativePlaybackSegment("clip:one", "clip:one")).toBe(false);
  });

  it("seeks once when playback enters a different clip", () => {
    expect(shouldSeekNativePlaybackSegment("clip:one", "clip:two")).toBe(true);
    expect(shouldSeekNativePlaybackSegment("clip:two", "clip:two")).toBe(false);
  });

  it("treats transitions as segments so each transition is synchronized once", () => {
    const transition = "transition:outgoing:incoming:crossfade";
    expect(shouldSeekNativePlaybackSegment("clip:outgoing", transition)).toBe(true);
    expect(shouldSeekNativePlaybackSegment(transition, transition)).toBe(false);
    expect(shouldSeekNativePlaybackSegment(transition, "clip:incoming")).toBe(true);
  });
});
