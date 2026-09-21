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
} from "./validate";

export type { DirectorValidationIssue } from "./validate";

export {
  normalizeEffectType,
  normalizeTransitionType,
  getKnownEffectTypes,
  getKnownTransitionTypes,
  KNOWN_EFFECT_TYPES,
  isColorGradeType,
  KNOWN_TRANSITION_TYPES,
  MISPLACED_FEATURE_HINTS,
  getMisplacedFeatureHint,
  type KnownEffectType,
  type KnownTransitionType,
} from "./effect-types";

export type {
  PromptGap,
  PromptExpansion,
} from "./prompt-expansion";

export {
  scorePromptCompleteness,
  generateExpansionQuestions,
} from "./prompt-expansion";
