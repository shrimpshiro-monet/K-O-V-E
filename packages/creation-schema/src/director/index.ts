export type {
  SceneType,
  MotionLevel,
  VideoSegment,
  VideoSegmentMap,
  SegmentMap,
} from "./segment-map";

export type {
  PlannedSegment,
  EditPlanLayout,
  EditPlanLayoutRegion,
  PlannedSpeedRamp,
  PlannedSpeedKeyframe,
  PlannedFreezeFrame,
  SpeedRampEasing,
  TextStyle,
  PlannedText,
  CaptionStyleTemplate,
  MotionMoveId,
  MotionMomentSpec,
  PlannedEffectSpec,
  PlannedEffect,
  PlannedTransition,
  AudioDecisionType,
  PlannedAudio,
  Pacing,
  EditPlanMetadata,
  EditPlan,
} from "./edit-plan";

export type {
  CutStyle,
  MusicRole,
  ColorMood,
  TextStyleDensity,
  GenreRules,
  Genre,
} from "./genre";

export type {
  StyleProfilePacing,
  StyleProfileCutStyle,
  StyleProfile,
  StyleProfileTarget,
  StyleProfileComparison,
} from "./style-profile";

export { compareStyleProfile } from "./style-profile";
export {
  scoreSportsMoment,
  snapTimeToBeat,
  reviewRenderedDraft,
  type SportsMomentEvent,
  type RenderedFrameObservation,
  type RenderedDraftReview,
} from "./quality-signals";

export {
  validateSegmentMap,
  validateEditPlan,
  normalizeEditPlan,
  summarizeSegmentMap,
  summarizeEditPlan,
  computePlanPlacement,
} from "./validate";

export type { DirectorValidationIssue } from "./validate";

export {
  SUPPORTED_TRANSITION_TYPES,
  SUPPORTED_CLIP_EFFECT_TYPES,
  COLOR_GRADE_EFFECT_TYPES,
  CUT_TRANSITION_TYPES,
  TRANSITION_TYPE_ALIASES,
  canonicalizeTransitionType,
  isSupportedTransitionType,
  isSupportedEffectType,
  canonicalizeTargetEffects,
  canonicalizeTargetTransitions,
  canonicalizePlanTransitions,
  collectPlanEffectTypes,
} from "./vocab";

export { pacingMatches } from "./style-profile";
