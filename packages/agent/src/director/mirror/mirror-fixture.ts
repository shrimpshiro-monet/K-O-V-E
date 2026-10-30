import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
export const fixture: ReferenceProfile = {
  version: "kove.mirror.v3", aspectRatio: { width: 1080, height: 1920 }, fps: { num: 30, den: 1 }, fpsSource: "user", durationFrames: 90,
  shots: [
    { startFrame: 0, endFrame: 30, captionWindows: [], cameraMotion: { dominantMove: "push", samples: [{ frame: 15, translateX: 1, translateY: 0, rotationRad: 0, scale: 1.02 }] } },
    { startFrame: 30, endFrame: 90, captionWindows: [] },
  ], beatGridMs: [], rhythmCurve: [30, 60],
  styleEvidence: { transitions: [], textOverlays: [], effects: [] },
};
