export * from "./types";
export * from "./utils";
export * from "./actions";
export * from "./capabilities";
export * from "./storage";
export * from "./timeline";
export * from "./media";
export * from "./video";
export * from "./audio";
export * from "./playback";
export * from "./text";
export * from "./graphics";
export * from "./photo";
export * from "./editing-templates";
export * from "./template";
export * from "./motion";
export * from "./ai";
export * from "./animation";
export * from "./effects";
export * from "./device";
export * from "./multicam";
export {
  ExportEngine,
  getExportEngine,
  initializeExportEngine,
  downloadBlob,
  setEncoderBackendFactory,
  exportSettingsRequireNativeEncoder,
} from "./export/export-engine";

export type {
  EncoderBackend,
  EncoderBackendFactory,
} from "./export/encoder-backend";

export {
  WebCodecsBackend,
  type WebCodecsBackendOptions,
} from "./export/webcodecs-backend";

export {
  resolveWebCodecsExportLimits,
  type WebCodecsExportAdjustment,
} from "./export/webcodecs-limits";

export type {
  VideoExportSettings,
  AudioExportSettings,
  ImageExportSettings,
  SequenceExportSettings,
  ExportProgress as VideoExportProgressInfo,
  ExportPreset,
  ExportResult,
  ExportStats,
  ExportError,
  ExportErrorCode,
  UpscalingSettings,
  UpscaleQuality,
} from "./export/types";

export {
  DEFAULT_VIDEO_SETTINGS,
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_IMAGE_SETTINGS,
  VIDEO_QUALITY_PRESETS,
  CODEC_MAP,
  DEFAULT_UPSCALING_SETTINGS,
} from "./export/types";

export type {
  CompressionQuality,
  CompressionTarget,
  CompressionSource,
  CompressionPlan,
  SizePreset,
} from "./export/compression";

export {
  computeCompressionPlan,
  estimateCompressedBytes,
  compressionPlanToExportSettings,
  COMPRESSION_SIZE_PRESETS,
} from "./export/compression";

// Mirror Engine primitives (the OpenCV runtime itself remains lazy-loaded).
export { locateCutFrame } from "./mirror/cut-boundary";
export { frameRate, frameToSeconds, secondsToFrame, shotDurationFrames, shotSampleFrame } from "./mirror/timebase";
export type { FrameRate } from "./mirror/timebase";
export { parseReferenceProfile, createReferenceProfile, serializeReferenceProfile } from "./mirror/reference-profile";
export type { ReferenceProfile, ShotProfile } from "./mirror/reference-profile";
export { allocateSourceRanges } from "./mirror/allocate-shots";
export { dtwDistance, rhythmSimilarity } from "./rhythm/dtw";
export { computeLabStats, applyReinhardTransfer, createReinhardLut } from "./color/reinhard-transfer";
export type { LabStats } from "./color/reinhard-transfer";
export { classifyDominantMove } from "./vision/camera-motion-extractor";
export type { CameraMotionCurve, CameraMotionSample } from "./vision/camera-motion-extractor";
export { compilePresetToGraph, evaluateCraftGraph, validateCraftGraph, toGraph } from "./motion/craft-graph";
export type { CraftGraph, CraftNode } from "./motion/craft-graph";
