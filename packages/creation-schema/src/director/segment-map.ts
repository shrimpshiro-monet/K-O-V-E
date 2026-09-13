export type SceneType =
  | "talking"
  | "action"
  | "transition"
  | "b-roll"
  | "silence"
  | "music";

export type MotionLevel = "static" | "low" | "medium" | "high";
import type { SportsMomentEvent } from "./quality-signals";

export interface VideoSegment {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly description: string;
  readonly sceneType: SceneType;
  readonly motionLevel: MotionLevel;
  readonly hasDialogue: boolean;
  readonly visualContent: string;
  readonly confidence: number;
  readonly motionPeak?: number;
  readonly audioEnergy?: number;
  readonly audioBpm?: number;
  readonly beatTimestamps?: readonly number[];
  readonly facePresenceRatio?: number;
  readonly hasTalkingHead?: boolean;
  readonly shotBoundaryAtStart?: boolean;
  readonly importanceScore?: number;
  readonly sportsMomentScore?: number;
  readonly sportsMomentEvent?: SportsMomentEvent;
  readonly subjectIds?: readonly string[];
  readonly subjectContinuityScore?: number;
}

export interface VideoSegmentMap {
  readonly videoId: string;
  readonly duration: number;
  readonly segments: readonly VideoSegment[];
}

export interface SegmentMap {
  readonly videos: readonly VideoSegmentMap[];
}
