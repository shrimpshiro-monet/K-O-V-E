export interface PlannedSegment {
  readonly sourceVideoId: string;
  readonly sourceStartTime: number;
  readonly sourceEndTime: number;
  readonly trackIndex?: number;
  readonly targetPosition?: number;
  readonly speed?: number;
  readonly speedRamp?: PlannedSpeedRamp;
  readonly effects: readonly string[];
  readonly effectSpecs?: readonly PlannedEffectSpec[];
  readonly layout?: EditPlanLayout;
  /**
   * Camera motion inside the shot (slow push, punch-in, handheld drift, …).
   * Compiled into clip transform keyframes by `compileCameraMoves`, so the
   * footage moves the way an editor would move it — a static shot is the
   * single loudest tell of a machine-made edit.
   */
  readonly cameraMoves?: readonly PlannedCameraMove[];
  readonly rationale: string;
}

/**
 * Named camera moves. Each id is a closed, renderer-backed recipe: the move is
 * compiled into transform keyframes on the clip (`scale.x`/`scale.y`,
 * `position.x`/`position.y`, `rotation`) that the preview and exporter already
 * animate. There is intentionally no free-form keyframe escape hatch — the
 * director picks from this vocabulary and tunes `intensity`.
 */
export type CameraMoveId =
  | "punch-in"
  | "punch-out"
  | "slow-push"
  | "pull-back"
  | "drift-left"
  | "drift-right"
  | "tilt-up"
  | "tilt-down"
  | "handheld"
  | "whip-shake"
  | "snap-zoom"
  | "breathe"
  | "wobble"
  | "sway";

export interface PlannedCameraMove {
  readonly move: CameraMoveId;
  /** 0..1 — scales the move's amplitude. Omitted means 0.6 (clearly visible, not seasick). */
  readonly intensity?: number;
  /** Seconds into the segment where the move starts. Omitted means 0. */
  readonly startTime?: number;
  /** How long the move takes. Omitted means "rest of the shot". */
  readonly duration?: number;
}

/** A transform keyframe the materializer can write verbatim. */
export interface PlannedTransformKeyframe {
  readonly property: "scale.x" | "scale.y" | "position.x" | "position.y" | "rotation" | "opacity";
  readonly time: number;
  readonly value: number;
  readonly easing: PlannedKeyframeEasing;
}

export type PlannedKeyframeEasing =
  | "linear"
  | "easeOutQuad"
  | "easeOutCubic"
  | "easeOutQuart"
  | "easeInOutQuad"
  | "easeInOutSine"
  | "easeOutBack"
  | "easeOutElastic";

export type EditPlanLayoutRegion =
  | "fullscreen"
  | "split-left"
  | "split-right"
  | "split-top"
  | "split-bottom"
  | "pip-corner"
  | "custom";

export interface EditPlanLayout {
  readonly region: EditPlanLayoutRegion;
  readonly pipCorner?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  readonly customRect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly fit?: "cover" | "contain";
}

export type SpeedRampEasing =
  | "linear"
  | "ease"
  | "ease-in"
  | "ease-out"
  | "ease-in-out"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuart"
  | "easeOutQuart"
  | "easeInOutQuart"
  | "smoothstep"
  | "smootherstep"
  | "snappy"
  | "smooth";

export interface PlannedSpeedKeyframe {
  readonly time: number;
  readonly speed: number;
  readonly easing?: SpeedRampEasing;
}

export interface PlannedFreezeFrame {
  readonly sourceTime: number;
  readonly startTime: number;
  readonly duration: number;
}

export interface PlannedSpeedRamp {
  readonly keyframes: readonly PlannedSpeedKeyframe[];
  readonly freezeFrames?: readonly PlannedFreezeFrame[];
  readonly pitchCorrection?: boolean;
}

export type TextStyle =
  | "title"
  | "subtitle"
  | "lower-third"
  | "caption"
  | "callout";

export interface PlannedText {
  readonly content: string;
  readonly style: TextStyle;
  readonly startTime: number;
  readonly duration: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
  readonly templateOverride?: Partial<CaptionStyleTemplate>;
  readonly rationale: string;
}

export interface CaptionStyleTemplate {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: number;
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly backgroundPadding?: number;
  readonly backgroundRadius?: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly align?: "left" | "center" | "right";
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export type MotionMoveId =
  | "particle-burst-on-cut"
  | "glitch-transition"
  | "3d-title-card";

export interface MotionMomentSpec {
  readonly move: MotionMoveId;
  readonly segmentIndex?: number;
  readonly atTime?: number;
  readonly duration?: number;
  readonly insertIntoEditor?: boolean;
  readonly rationale?: string;
}

export interface PlannedEffectSpec {
  readonly type: string;
  readonly params: Record<string, unknown>;
  readonly intensity?: number;
  readonly startOffset?: number;
  readonly duration?: number;
  readonly easing?: string;
  readonly rationale: string;
}

export interface PlannedEffect extends PlannedEffectSpec {
  readonly targetSegmentIndex?: number;
}

export interface PlannedTransition {
  readonly afterSegmentIndex: number;
  readonly type: string;
  readonly duration: number;
  readonly rationale: string;
}

export type AudioDecisionType = "music" | "sfx" | "silence";

export interface PlannedAudio {
  readonly type: AudioDecisionType;
  readonly sourceVideoId?: string;
  readonly sourceStartTime?: number;
  readonly sourceEndTime?: number;
  readonly startTime: number;
  readonly duration: number;
  readonly volume?: number;
  readonly rationale: string;
}

export type Pacing = "fast" | "medium" | "slow";

export interface EditPlanMetadata {
  readonly targetDuration: number;
  readonly targetPlatform: string;
  readonly genre: string;
  readonly pacing: Pacing;
  readonly rationale: string;
}

export interface EditPlan {
  readonly segments: readonly PlannedSegment[];
  readonly textElements: readonly PlannedText[];
  readonly effects: readonly PlannedEffect[];
  readonly transitions: readonly PlannedTransition[];
  readonly audioDecisions: readonly PlannedAudio[];
  readonly metadata: EditPlanMetadata;
  readonly captionTemplate?: CaptionStyleTemplate;
  readonly motionMoments?: readonly MotionMomentSpec[];
}
