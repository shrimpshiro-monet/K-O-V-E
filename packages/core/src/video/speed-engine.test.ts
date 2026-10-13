import { describe, it, expect, beforeEach } from "vitest";
import { SpeedEngine } from "./speed-engine";

describe("SpeedEngine", () => {
  let speedEngine: SpeedEngine;

  beforeEach(() => {
    speedEngine = new SpeedEngine();
  });

  describe("Basic Speed Operations", () => {
    it("should return default speed of 1 for uninitialized clips", () => {
      expect(speedEngine.getClipSpeed("unknown-clip")).toBe(1);
    });

    it("should set and get clip speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      expect(speedEngine.getClipSpeed("clip-1")).toBe(2);
    });

    it("should clamp speed to valid range", () => {
      speedEngine.setClipSpeed("clip-1", 0.01, 10);
      expect(speedEngine.getClipSpeed("clip-1")).toBe(0.1);

      speedEngine.setClipSpeed("clip-2", 100, 10);
      expect(speedEngine.getClipSpeed("clip-2")).toBe(20);
    });
  });

  describe("getSourceTimeAtPlaybackTime - Critical for Playback", () => {
    it("should return same time when speed is 1x", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(10);
    });

    it("should return doubled time when speed is 2x", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 2.5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(10);
    });

    it("should return halved time when speed is 0.5x", () => {
      speedEngine.setClipSpeed("clip-1", 0.5, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(0);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 20)).toBe(10);
    });

    it("should clamp source time to valid range", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      const sourceTime = speedEngine.getSourceTimeAtPlaybackTime("clip-1", 100);
      expect(sourceTime).toBeLessThanOrEqual(10);
    });

    it("should handle reverse playback", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);
      speedEngine.setReverse("clip-1", true, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(10);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 10)).toBe(0);
    });

    it("should handle reverse playback at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      speedEngine.setReverse("clip-1", true, 10);

      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 0)).toBe(10);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 2.5)).toBe(5);
      expect(speedEngine.getSourceTimeAtPlaybackTime("clip-1", 5)).toBe(0);
    });
  });

  describe("Effective Duration Calculation", () => {
    it("should calculate effective duration at 1x speed", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(10);
    });

    it("should calculate effective duration at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(5);
    });

    it("should calculate effective duration at 0.5x speed", () => {
      speedEngine.setClipSpeed("clip-1", 0.5, 10);
      expect(speedEngine.getEffectiveDuration("clip-1")).toBe(20);
    });
  });

  describe("Frame Index Calculations", () => {
    it("should get correct frame index at 1x speed", () => {
      speedEngine.setClipSpeed("clip-1", 1, 10);

      expect(speedEngine.getFrameIndexAtTime("clip-1", 0, 30)).toBe(0);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 1, 30)).toBe(30);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 2, 30)).toBe(60);
    });

    it("should get correct frame index at 2x speed", () => {
      speedEngine.setClipSpeed("clip-1", 2, 10);

      expect(speedEngine.getFrameIndexAtTime("clip-1", 0, 30)).toBe(0);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 1, 30)).toBe(60);
      expect(speedEngine.getFrameIndexAtTime("clip-1", 2, 30)).toBe(120);
    });
  });

  describe("Playback Timing Invariants", () => {
    it("clipLocalTime should be independent of speed for transforms", () => {
      const originalDuration = 10;
      const clipStartTime = 5;

      speedEngine.setClipSpeed("clip-1", 2, originalDuration);

      for (let playheadTime = clipStartTime; playheadTime < clipStartTime + 5; playheadTime += 0.5) {
        const clipLocalTime = playheadTime - clipStartTime;
        expect(clipLocalTime).toBeGreaterThanOrEqual(0);
        expect(clipLocalTime).toBeLessThanOrEqual(originalDuration / 2);
      }
    });

    it("mediaTime should advance at speed rate while playhead advances at 1x", () => {
      const speed = 2;
      const originalDuration = 10;
      speedEngine.setClipSpeed("clip-1", speed, originalDuration);

      const realTimeElapsed = 1;
      const expectedMediaTimeAdvance = realTimeElapsed * speed;

      const mediaTime = speedEngine.getSourceTimeAtPlaybackTime("clip-1", realTimeElapsed);
      expect(mediaTime).toBe(expectedMediaTimeAdvance);
    });
  });
});

describe("SpeedEngine - Playback Time vs Media Time", () => {
  let speedEngine: SpeedEngine;

  beforeEach(() => {
    speedEngine = new SpeedEngine();
  });

  it("should correctly separate playhead time from media time at various speeds", () => {
    const speeds = [0.5, 1, 1.5, 2, 3];
    const originalDuration = 60;

    for (const speed of speeds) {
      speedEngine.setClipSpeed(`clip-${speed}`, speed, originalDuration);

      const playbackDuration = originalDuration / speed;
      const testPoints = [0, 0.25, 0.5, 0.75, 1];

      for (const fraction of testPoints) {
        const playheadTime = playbackDuration * fraction;
        const expectedMediaTime = Math.min(originalDuration, playheadTime * speed);

        const actualMediaTime = speedEngine.getSourceTimeAtPlaybackTime(
          `clip-${speed}`,
          playheadTime
        );

        expect(actualMediaTime).toBeCloseTo(expectedMediaTime, 5);
      }
    }
  });
});

describe("syncFromClip (persisted clip fields -> engine)", () => {
  let engine: SpeedEngine;

  beforeEach(() => {
    engine = new SpeedEngine();
  });

  it("registers speed keyframes: playback time integrates the ramp, no-ramp math no longer holds", () => {
    // Linear 1x -> 2x ramp over source [0,4]. Playback time for source 4:
    // ∫0..4 ds/(1+0.25s) = 4·ln(2) ≈ 2.7726. A naive base-speed map would give 4.
    engine.syncFromClip(
      "c1",
      {
        speed: 1,
        speedKeyframes: [
          { id: "k0", time: 0, speed: 1, easing: "linear" },
          { id: "k1", time: 4, speed: 2, easing: "linear" },
        ],
      },
      8,
    );
    expect(engine.getSourceTimeAtPlaybackTime("c1", 4 * Math.LN2)).toBeCloseTo(4, 1);
    // and motion within the ramp is monotonic: same playback delta, second window is faster
    const a = engine.getSourceTimeAtPlaybackTime("c1", 0.5);
    const b = engine.getSourceTimeAtPlaybackTime("c1", 1.0);
    const c = engine.getSourceTimeAtPlaybackTime("c1", 1.5);
    const d = engine.getSourceTimeAtPlaybackTime("c1", 2.0);
    expect(b - a).toBeGreaterThan(0);
    expect(d - c).toBeGreaterThan(b - a);
  });

  it("registers freeze frames: a playback window maps to one source time, and time after the freeze shifts back", () => {
    engine.syncFromClip(
      "c2",
      {
        speed: 1,
        freezeFrames: [{ id: "f0", sourceTime: 2, startTime: 1, duration: 0.5 }],
      },
      8,
    );
    expect(engine.getSourceTimeAtPlaybackTime("c2", 0.9)).toBeCloseTo(0.9, 5);
    expect(engine.getSourceTimeAtPlaybackTime("c2", 1.0)).toBeCloseTo(2, 5);
    expect(engine.getSourceTimeAtPlaybackTime("c2", 1.4)).toBeCloseTo(2, 5);
    // engine semantics: a freeze steals source time — after the window,
    // playback resumes where the source left off (not where the freeze held).
    // adjustedTime = playback − summed prior freezes → 1.5 − 0.5 = 1.0.
    expect(engine.getSourceTimeAtPlaybackTime("c2", 1.5)).toBeCloseTo(1, 5);
  });

  it("is idempotent — re-syncs replace, never accumulate (the store syncs on every change)", () => {
    const clip = {
      speed: 1,
      speedKeyframes: [
        { id: "k0", time: 0, speed: 1, easing: "linear" as const },
        { id: "k1", time: 4, speed: 2, easing: "linear" as const },
      ],
      freezeFrames: [{ id: "f0", clipId: "c3", sourceTime: 2, startTime: 1, duration: 0.5 }],
    };
    engine.syncFromClip("c3", clip, 8);
    engine.syncFromClip("c3", clip, 8);
    expect(engine.getSpeedKeyframes("c3")).toHaveLength(2);
    expect(engine.getFreezeFrames("c3")).toHaveLength(1);
  });
});
