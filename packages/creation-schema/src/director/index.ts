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
  CameraMoveId,
  PlannedCameraMove,
  PlannedTransformKeyframe,
  PlannedKeyframeEasing,
} from "./edit-plan";

export {
  CAMERA_MOVE_IDS,
  CAMERA_MOVE_ATLAS,
  isCameraMoveId,
  normalizeCameraMove,
  normalizeCameraMoves,
  compileCameraMoves,
  segmentHasCameraMotion,
  collectCameraMoveIds,
  type CameraMoveAtlasEntry,
} from "./camera-moves";

export type {
  EditDensityProfile,
  EditDensityTarget,
  EditDensityReview,
  DensityBudget,
  DensityDeficiency,
  DensityDeficiencySeverity,
} from "./density";

export {
  DENSITY_PRESETS,
  planDensityBudget,
  resolveDensityTarget,
  measureEditDensity,
  compareEditDensity,
  summarizeDensityProfile,
  formatDensityBrief,
} from "./density";

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

export type { SignatureEffectDef } from "./shader-effects";

export {
  SIGNATURE_EFFECT_DEFS,
  SIGNATURE_EFFECT_NAMES,
  SIGNATURE_EFFECT_ALIASES,
  resolveSignatureEffect,
  resolveSignatureEffectName,
  isSignatureEffectType,
  signatureEffectParamNames,
  buildSignatureEffectParams,
  formatSignatureEffectEntry,
} from "./shader-effects";

export {
  SUPPORTED_TRANSITION_TYPES,
  SUPPORTED_CLIP_EFFECT_TYPES,
  SUPPORTED_EFFECT_TYPES,
  COLOR_GRADE_EFFECT_TYPES,
  CUT_TRANSITION_TYPES,
  TRANSITION_TYPE_ALIASES,
  MISPLACED_FEATURE_HINTS,
  canonicalizeTransitionType,
  isSupportedTransitionType,
  isSupportedEffectType,
  isColorGradeType,
  normalizeEffectType,
  getMisplacedFeatureHint,
  canonicalizeTargetEffects,
  canonicalizeTargetTransitions,
  canonicalizePlanTransitions,
  collectPlanEffectTypes,
  SUPPORTED_TEXT_ANIMATIONS,
  TEXT_ANIMATION_ALIASES,
  normalizeTextAnimation,
  isSupportedTextAnimation,
  type SupportedTextAnimation,
} from "./vocab";

export { pacingMatches } from "./style-profile";

export type {
  PromptGap,
  PromptExpansion,
} from "./prompt-expansion";

export {
  scorePromptCompleteness,
  generateExpansionQuestions,
} from "./prompt-expansion";
