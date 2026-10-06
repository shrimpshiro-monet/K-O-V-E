import type { Action, ActionResult } from "@kove-advanced/core/types/actions";
import type { Project } from "@kove-advanced/core/types/project";
import type { CapabilityManifest } from "@kove-advanced/core/capabilities/manifest";
import type { ExportMeasureReport } from "@kove-advanced/core/qc/measure-export";
import type {
  MulticamActivityMap,
  MulticamManifest,
  MulticamShotPolicy,
  MulticamTranscriptSegment,
} from "@kove-advanced/core";
import type { LLMClient, LlmProviderName } from "./llm";

export type JobKind =
  | "exportVideo"
  | "exportAudio"
  | "exportFrame"
  | "extractVideoFrame";

export interface JobResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  /**
   * Machine-readable failure reason. "unsupported_host" means this host cannot
   * perform the job at all (as opposed to the job failing) — tools surface it as
   * UNSUPPORTED_HOST instead of a generic failure.
   */
  readonly code?: "unsupported_host";
}

/**
 * What this host can actually do, reported to the agent via get_capabilities
 * (`host`) so it never has to discover a missing capability by failing.
 */
export interface HostFeatures {
  /** Render a single frame of a motion composition (render_motion_frame). */
  readonly renderMotionFrame: boolean;
  /** Render a single composited frame of the main timeline (render_timeline_frame). Not implemented on any host yet. */
  readonly renderTimelineFrame: boolean;
  /** Render a multicam preview frame (preview_frame). */
  readonly renderMulticamPreview: boolean;
  /** Export the project to a video/audio file. */
  readonly exportVideo: boolean;
  /** create/restore_checkpoint, undo, redo. */
  readonly checkpoints: boolean;
  /** Decode a media item's audio to samples (measure_loudness). */
  readonly analyzeAudio: boolean;
  /** Sample video frames and run face detection/tracking (detect_faces). */
  readonly analyzeFaces: boolean;
  /** Segment subjects and extract matte contours (rotoscope_subject). */
  readonly analyzeSubjectMatte: boolean;
  /** Write a tracked matte + separation settings onto a clip (apply_subject_matte). */
  readonly applySubjectMatte: boolean;
  /** Reframe a clip for a target aspect ratio (auto_reframe_clip). */
  readonly autoReframe: boolean;
  /** Refine a matte's edge per keyframe (refine_matte_edges). */
  readonly refineMatteEdges: boolean;
}

/** How the auto-reframe camera should behave. Mirrors core `ReframeSettings`. */
export interface AutoReframeRequest {
  readonly clipId: string;
  /** Target aspect ratio preset, e.g. "9:16". Defaults to the session default. */
  readonly targetAspectRatio?: string;
  /** 0..1 — how fast the camera is allowed to catch up with the subject. */
  readonly trackingSpeed?: number;
  /** 0..0.4 — headroom kept around the tracked subject. */
  readonly padding?: number;
  /** 0..1 — temporal smoothing of the crop path. */
  readonly smoothing?: number;
  /** Steer the crop with the tracked subject rather than the frame centre. */
  readonly followSubject?: boolean;
  /** 0..1 — pull the crop towards the centre of the source. */
  readonly centerBias?: number;
  /** Also resize the project canvas to the target resolution. Default true. */
  readonly setCanvasSize?: boolean;
  /** Sampling window (source seconds) and density. */
  readonly startTime?: number;
  readonly endTime?: number;
  readonly intervalMs?: number;
  readonly maxFrames?: number;
  /**
   * Spend the spare frame budget where the picture moves instead of spreading
   * it evenly. Default true; `false` (or an explicit `intervalMs`/`maxFrames`)
   * forces the fixed grid. Reported back as `refinedFrames`.
   */
  readonly adaptive?: boolean;
}

export interface AutoReframeHostResult {
  /** Camera keyframes written (one per kept sample, per animated property). */
  readonly keyframesWritten: number;
  /** Distinct sample times the camera move is built from. */
  readonly keyframeSamples: number;
  readonly sampledFrames: number;
  /**
   * Samples added on top of the base grid because the picture moved there.
   * Present only when adaptive sampling ran and had something to add.
   */
  readonly refinedFrames?: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** True when the real face detector steered the crop. */
  readonly usedFaceBackend: boolean;
  /**
   * Largest gap between the fitted camera curve and the polyline the renderer
   * draws, in source pixels. Lower means the emitted keyframes hug the smooth
   * path more closely.
   */
  readonly pathDeviationPx?: number;
  /** Fastest camera motion, in crop-widths per second. */
  readonly peakSpeedCropRatios?: number;
  readonly warnings: string[];
}

/** Which part of a media item's source to analyze. Times are source seconds. */
export interface VisionSamplingRequest {
  /** Media item to analyze. Tools resolve clipId to a media item first. */
  readonly mediaId: string;
  /** Source seconds to start at. Default 0. */
  readonly startTime?: number;
  /** Source seconds to end at. Defaults to the media duration. */
  readonly endTime?: number;
  /** Preferred spacing between samples. Default 500 ms. */
  readonly intervalMs?: number;
  /** Hard cap on sampled frames. Default 60. */
  readonly maxFrames?: number;
  /**
   * Spend the spare frame budget where the picture moves instead of spreading
   * it evenly. Default true; `false` (or an explicit `intervalMs`/`maxFrames`)
   * forces the fixed grid.
   */
  readonly adaptive?: boolean;
}

export interface FaceTrackSummary {
  readonly id: string;
  readonly firstTimeMs: number;
  readonly lastTimeMs: number;
  readonly framesDetected: number;
  readonly averageConfidence: number;
  readonly averageBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly score: number;
}

export interface FaceAnalysisResult {
  readonly width: number;
  readonly height: number;
  readonly sampledFrames: number;
  readonly sampledTimesMs: readonly number[];
  readonly tracks: readonly FaceTrackSummary[];
  readonly primaryTrackId: string | null;
  readonly warnings: readonly string[];
}

export interface SubjectMatteRequest extends VisionSamplingRequest {
  /** Matte threshold 0..1. Default 0.5. */
  readonly threshold?: number;
  /** Contour simplification tolerance in normalized units. Default 0.008. */
  readonly simplifyTolerance?: number;
  /** Cap on emitted keyframes. Default 60. */
  readonly maxKeyframes?: number;
  /** Frames below this subject coverage are treated as "no subject". Default 0.004. */
  readonly minCoverage?: number;
}

export interface SubjectMatteKeyframeSummary {
  readonly timeMs: number;
  readonly coverage: number;
  readonly pointCount: number;
  readonly centroid: { readonly x: number; readonly y: number };
}

export interface SubjectMatteResult {
  readonly width: number;
  readonly height: number;
  readonly sampledFrames: number;
  readonly missedFrames: number;
  readonly keyframeCount: number;
  /** Capped preview of the plan; use keyframeCount for the true total. */
  readonly keyframes: readonly SubjectMatteKeyframeSummary[];
  readonly averageCoverage: number;
  readonly boundingBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly warnings: readonly string[];
}

/** Separation settings accepted by `apply_subject_matte`. */
export interface SubjectSeparationRequest {
  readonly preset:
    | "cutout"
    | "transparent"
    | "blur-background"
    | "color-background"
    | "image-background";
  readonly blurAmount?: number;
  readonly backgroundColor?: string;
  readonly backgroundImageUrl?: string;
  /** Matte threshold override, 0..1. */
  readonly threshold?: number;
  /** Soft edge width, 0..1. */
  readonly feather?: number;
  /** Grow (+) / shrink (−) the subject silhouette, −0.5..0.5. */
  readonly edgeShift?: number;
  readonly invert?: boolean;
  readonly opacity?: number;
}

/**
 * Edge refinement for a rotoscoped matte.
 *
 * `featherPx` is the edge softness where the subject is still;
 * `motionSensitivity` lets it widen where the subject moves, up to
 * `maxFeatherPx`. Set sensitivity to 0 for a uniform, pre-refinement edge.
 */
export interface MatteEdgeRequest {
  /** Base feather in pixels where the subject is still. */
  readonly featherPx: number;
  /** Grow (+) or shrink (−) the silhouette, in pixels. */
  readonly expansionPx?: number;
  /** 0..1 — how much motion widens the feather. Default 0.6. */
  readonly motionSensitivity?: number;
  /** Upper bound for the motion-widened feather, in pixels. Default 3× base. */
  readonly maxFeatherPx?: number;
  readonly invert?: boolean;
  /** Matte opacity, 0..1. Default 1. */
  readonly opacity?: number;
}

export interface MatteEdgeResult {
  /** Per-keyframe motion scores, 0..1. */
  readonly motion: readonly number[];
  readonly minFeatherPx: number;
  readonly maxFeatherPx: number;
}

export interface ApplySubjectMatteRequest extends SubjectMatteRequest {
  /** Clip the matte is attached to. */
  readonly clipId: string;
  /** Reuse an existing mask id; omitted creates a new mask. */
  readonly maskId?: string;
  /** Feathering in pixels written onto the mask. Default 4. */
  readonly featherPx?: number;
  /** Mask expansion in pixels (positive grows the mask). Default 0. */
  readonly expansionPx?: number;
  readonly invertMask?: boolean;
  /**
   * Refine the matte's edge per keyframe instead of using one mask-wide
   * feather. Overrides `featherPx`/`expansionPx`/`invertMask`.
   */
  readonly edge?: MatteEdgeRequest;
  /** Optionally also switch how the subject is composited. */
  readonly separation?: SubjectSeparationRequest;
}

export interface ApplySubjectMatteResult {
  readonly maskId: string;
  readonly keyframeCount: number;
  readonly firstTimeSeconds: number | null;
  readonly lastTimeSeconds: number | null;
  readonly separationApplied: boolean;
  readonly warnings: readonly string[];
  /** Present when the matte was written with per-keyframe edge refinement. */
  readonly edge?: MatteEdgeResult;
}

/** Refine the edge of a matte that already exists on a mask. */
export interface RefineMatteEdgesRequest {
  readonly clipId: string;
  /** Mask whose keyframes get the new edge. */
  readonly maskId: string;
  /** Edge settings; `motionSensitivity: 0` makes the feather uniform. */
  readonly edge: MatteEdgeRequest;
  /**
   * Restrict refinement to this timeline range (seconds). Omitted refines
   * every keyframe on the mask.
   */
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface RefineMatteEdgesResult {
  readonly maskId: string;
  /** Keyframes whose edge was rewritten. */
  readonly keyframeCount: number;
  readonly edge: MatteEdgeResult;
  readonly warnings: readonly string[];
}

/** Decoded audio handed to analysis tools. Source audio: before any clip effect, fader or mix. */
export interface AudioSamples {
  /** One array per channel, equal lengths. Channel order: L R C LFE Ls Rs (BS.775). */
  readonly channels: readonly ArrayLike<number>[];
  readonly sampleRate: number;
}

/** A request to render the main timeline at one instant, as the user would see it in the preview. */
export interface TimelineFrameRequest {
  /** Timeline seconds. */
  readonly time: number;
  /** Longest output edge in pixels (aspect ratio preserved). */
  readonly maxDimension: number;
  readonly format: "png" | "jpeg";
}

export interface TimelineFrame {
  /** `data:image/...;base64,...` */
  readonly dataUrl: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  /** Which compositor produced it (e.g. "webgpu", "canvas2d"), so callers know what fidelity to expect. */
  readonly renderer: string;
}

export interface TxnHandle {
  readonly id: string;
}

// ---- History / checkpoint contract -----------------------------------------
// One contract, implemented by every EditingHost through HistoryLedger
// (./checkpoints.ts) and verified by the shared suite in
// ./host-history-contract.ts.

export interface CheckpointInfo {
  readonly id: string;
  readonly label: string;
  /** ISO-8601 timestamp (metadata only; not an editor time value). */
  readonly createdAt: string;
  /** Host revision when the checkpoint was taken. */
  readonly revision: number;
  /** Number of undoable steps (across all undo stacks) at the checkpoint. */
  readonly undoDepth: number;
}

export type HistoryFailureCode =
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "HUMAN_EDITS_PRESENT"
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_STALE"
  | "RESTORE_INCOMPLETE"
  | "UNDO_FAILED"
  | "REDO_FAILED";

export interface HistoryOptions {
  /**
   * Proceed even though the operation would also revert (undo) or re-apply
   * (redo) work the human did. Default false.
   */
  readonly force?: boolean;
}

export interface HistoryOpResult {
  readonly ok: boolean;
  readonly code?: HistoryFailureCode;
  readonly message: string;
  readonly suggestedFix?: string;
  readonly warnings: readonly string[];
  /** Undoable steps remaining after the operation. */
  readonly undoDepth: number;
  readonly revision: number;
  /** Undo groups reverted (undo/restore) or re-applied (redo). */
  readonly steps?: number;
  /**
   * restore only: true when the resulting project fingerprint equals the
   * checkpoint's. false means the undo replay left a different state
   * (see warnings) and the caller must not assume an exact restore.
   */
  readonly verified?: boolean;
}

export interface HistoryControl {
  /**
   * Monotonic number that increases whenever editor state changed since it was
   * last read (observed lazily: several changes between two reads count once).
   * Safe for change detection, not a mutation counter.
   */
  revision(): number;
  /** Undo the agent's most recent step. Refuses to undo human edits unless force. */
  undo(options?: HistoryOptions): Promise<HistoryOpResult>;
  redo(options?: HistoryOptions): Promise<HistoryOpResult>;
  /** Mark the current state; also forces an undo-group boundary here. */
  createCheckpoint(label?: string): CheckpointInfo;
  /** Revert to a checkpoint. Refuses when human edits happened since, unless force. */
  restoreCheckpoint(id: string, options?: HistoryOptions): Promise<HistoryOpResult>;
  listCheckpoints(): readonly CheckpointInfo[];
}

export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly modifiedAt?: number;
}

export interface ImportedMediaRef {
  readonly mediaId: string;
  readonly name: string;
  readonly type: string;
  readonly durationSec: number;
  readonly width?: number;
  readonly height?: number;
}

export type RiggingBackendMode = "configured" | "bundled" | "system";

export interface RiggingBackendProbe {
  readonly available: boolean;
  readonly provider: "blender";
  readonly mode?: RiggingBackendMode;
  readonly path?: string;
  readonly version?: string;
  readonly error?: string;
}

export interface ModelInspectionVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ModelInspectionBounds {
  readonly min: ModelInspectionVec3;
  readonly max: ModelInspectionVec3;
  readonly size: ModelInspectionVec3;
  readonly center: ModelInspectionVec3;
}

export interface ModelInspectionMesh {
  readonly name: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly skinned: boolean;
  readonly materialNames: readonly string[];
}

export interface ModelInspectionTexture {
  readonly name: string;
  readonly slot: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ModelInspectionMaterial {
  readonly name: string;
  readonly type: string;
  readonly color?: string;
  readonly metalness?: number;
  readonly roughness?: number;
  readonly textureSlots: readonly string[];
}

export interface ModelInspectionAnimation {
  readonly name: string;
  readonly duration: number;
  readonly trackCount: number;
  readonly targetCount: number;
  readonly tracks: readonly string[];
}

export interface ModelInspectionArmature {
  readonly hasSkinnedMesh: boolean;
  readonly skinnedMeshCount: number;
  readonly boneCount: number;
  readonly rootBones: readonly string[];
  readonly sampleBones: readonly string[];
}

export interface ModelInspectionWarning {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
}

export interface ModelInspectionReport {
  readonly modelUrl: string;
  readonly name?: string;
  readonly source?: string;
  readonly meshCount: number;
  readonly materialCount: number;
  readonly textureCount: number;
  readonly animationCount: number;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly bounds?: ModelInspectionBounds;
  readonly meshes: readonly ModelInspectionMesh[];
  readonly materials: readonly ModelInspectionMaterial[];
  readonly textures: readonly ModelInspectionTexture[];
  readonly animations: readonly ModelInspectionAnimation[];
  readonly armature: ModelInspectionArmature;
  readonly warnings: readonly ModelInspectionWarning[];
  readonly suggestedNextTools: readonly string[];
}

export interface ModelInspectionRequest {
  readonly modelUrl: string;
  readonly name?: string;
  readonly source?: string;
}

export interface HumanoidRigRequest {
  readonly modelUrl: string;
  readonly outputPath?: string;
  readonly name?: string;
  readonly heightMeters?: number;
  readonly overwriteExisting?: boolean;
}

export interface HumanoidRigResult {
  readonly ok: boolean;
  readonly provider: "blender";
  readonly inputUrl: string;
  readonly outputUrl?: string;
  readonly outputPath?: string;
  readonly armatureName?: string;
  readonly createdArmature: boolean;
  readonly preservedExistingArmature: boolean;
  readonly skinnedMeshCount: number;
  readonly meshCount: number;
  readonly boneCount: number;
  readonly warnings: readonly ModelInspectionWarning[];
  readonly error?: string;
}

export interface MulticamHostBridge {
  getManifest(groupId?: string): Promise<{ groupId: string; manifest: MulticamManifest }>;
  getActivityMap(
    groupId?: string,
    range?: { startMs?: number; endMs?: number },
  ): Promise<{ groupId: string; activity: MulticamActivityMap; sampled: boolean }>;
  getTranscript(
    groupId?: string,
    range?: { startMs?: number; endMs?: number },
  ): Promise<{ groupId: string; transcripts: Record<string, MulticamTranscriptSegment[]> }>;
  setEditPolicy(
    groupId: string,
    policy: Partial<MulticamShotPolicy>,
  ): Promise<Record<string, unknown>>;
  annotateSegment(input: {
    groupId: string;
    startMs: number;
    endMs: number;
    note: string;
  }): Promise<Record<string, unknown>>;
  getEditSummary(groupId?: string): Promise<Record<string, unknown>>;
  overrideCut(input: {
    groupId: string;
    switchId: string;
    operation: "accept" | "reject" | "nudge" | "set-camera";
    deltaMs?: number;
    cameraId?: string;
  }): Promise<Record<string, unknown>>;
  previewFrame(groupId: string, timeMs: number): Promise<JobResult>;
}

export interface CreateProjectOptions {
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

export type ExportMotionSceneFormat = "mp4" | "webm-alpha" | "mov-prores4444";

export interface ExportMotionSceneOptions {
  readonly compositionId: string;
  readonly format?: ExportMotionSceneFormat;
  readonly filename?: string;
  readonly acknowledgeH264Fallback?: boolean;
}

export interface ExportMotionSceneResult {
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly framesRendered: number;
  readonly requestedFormat: ExportMotionSceneFormat;
  readonly encodedFormat: ExportMotionSceneFormat;
  readonly normalizedToH264: boolean;
  readonly note?: string;
}

/**
 * The single seam the tool layer executes through. Implemented by the live
 * renderer (LiveEditorHost) and by a headless Node host (HeadlessHost), so the
 * same registry, executor, and loop drive any environment.
 */
export interface EditingHost {
  /** The authoritative, serializable project. */
  getProject(): Project;
  /** Dispatch an action through the action system; records undo. */
  applyAction(action: Action): Promise<ActionResult>;
  /** Open an undoable transaction so a whole agent turn reverts as one unit. */
  beginTransaction(label?: string): TxnHandle;
  commitTransaction(handle: TxnHandle, label: string): void;
  rollbackTransaction(handle: TxnHandle): Promise<void>;
  /** Long-running GPU/analysis/export jobs. */
  runJob(kind: JobKind, params: Record<string, unknown>): Promise<JobResult>;
  /** Machine-readable enums + parameter ranges for the agent. */
  capabilities(): CapabilityManifest;
  /** Narrow multicam planning/review surface shared with local MCP clients. */
  multicam?: MulticamHostBridge;
  /** LLM client for nested director calls (e.g. plan_edit). Set by chat-store before runTurn. */
  llm?: { client: LLMClient; provider: LlmProviderName };
  /** Throws when no project is open (guard for mutating tools). */
  requireOpenProject(): void;
  /** Agent-safe undo/redo and named checkpoints (see HistoryControl). */
  readonly historyControl: HistoryControl;
  /** Honest capability report (optional so minimal test hosts need not implement it). */
  features?(): HostFeatures;
  /**
   * Decode a media item's audio track to samples. Optional: hosts without media access omit it
   * and report `features().analyzeAudio === false`.
   */
  loadAudioSamples?(mediaId: string, audioTrackIndex?: number): Promise<AudioSamples | null>;

  /**
   * Render one composited frame of the main timeline. Optional: hosts without a compositor omit it
   * and report `features().renderTimelineFrame === false`. A host may also resolve to
   * `{code:"unsupported_host"}`; it must never return a placeholder image.
   */
  renderTimelineFrame?(request: TimelineFrameRequest): Promise<TimelineFrame | { readonly code: "unsupported_host"; readonly error: string }>;

  /**
   * Sample a media item's frames and detect/track faces. Optional: hosts
   * without a video decoder omit it and report `features().analyzeFaces ===
   * false`. Boxes are in the analyzed frame's pixel space; times are
   * milliseconds on the source clock.
   */
  analyzeFaces?(request: VisionSamplingRequest): Promise<
    FaceAnalysisResult | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Segment the subject across sampled frames and reduce each matte to
   * normalized contours. Optional: hosts without segmentation omit it and
   * report `features().analyzeSubjectMatte === false`. This is the read-only
   * proposal path — nothing is written to the project.
   */
  analyzeSubjectMatte?(request: SubjectMatteRequest): Promise<
    SubjectMatteResult | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Analyze the subject and write the tracked matte onto a clip's mask
   * (creating or updating `mask/setAll`), optionally applying a separation
   * preset. Destructive: callers must have confirmation. Optional: hosts that
   * cannot write masks report `features().applySubjectMatte === false`.
   */
  applySubjectMatte?(request: ApplySubjectMatteRequest): Promise<
    ApplySubjectMatteResult | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Reframe a clip for a target aspect ratio: sample its frames, pick a crop
   * per frame (face-steered when a detector is available), and commit the
   * camera move as clip transform keyframes — one undo step, resizing the
   * canvas too when `setCanvasSize` is not false. Optional: hosts without a
   * decoder or keyframe writer omit it and report
   * `features().autoReframe === false`.
   */
  autoReframe?(request: AutoReframeRequest): Promise<
    AutoReframeHostResult | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Refine a matte's edge per keyframe: feather, expansion, invert and
   * opacity, with the feather widening where the subject moves. Destructive:
   * callers must have confirmation. Optional: hosts that cannot write masks
   * report `features().refineMatteEdges === false`.
   */
  refineMatteEdges?(request: RefineMatteEdgesRequest): Promise<
    RefineMatteEdgesResult | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Run ffmpeg/ffprobe QC on an exported file: loudness + true peak (EBU
   * R128), black/silence/freeze detection, and container-duration drift vs
   * the expected timeline length. Optional: only hosts with ffmpeg on PATH
   * (or an equivalent) implement it; others omit it or resolve to
   * `{code:"unsupported_host"}`.
   */
  measureExportFile?(request: {
    readonly path: string;
    readonly expectedDurationSec?: number;
  }): Promise<
    ExportMeasureReport | { readonly code: "unsupported_host"; readonly error: string }
  >;

  /**
   * Project lifecycle + media ingest. Optional because they require a real
   * editor environment (Zustand store, IndexedDB, a main-process URL fetcher)
   * that only the live/desktop host provides. Tools must feature-detect these
   * and fail clearly when undefined (e.g. on the headless cloud host).
   */
  createProject?(options: CreateProjectOptions): Promise<ProjectRef>;
  openProject?(id: string): Promise<ProjectRef>;
  listProjects?(): Promise<readonly ProjectRef[]>;
  saveProject?(): Promise<ProjectRef>;
  importMediaFromUrl?(url: string, options?: { name?: string }): Promise<ImportedMediaRef>;
  /**
   * Render a motion composition to a finished video file (mp4 / transparent
   * WebM / ProRes 4444 MOV). Optional because it needs the renderer-side motion
   * export pipeline that only the live/desktop web host provides — headless
   * hosts leave it undefined and the export tool fails clearly. On web the ProRes
   * and alpha formats normalize to H.264; the implementation enforces the
   * acknowledge-fallback guardrail and reports the format actually encoded.
   */
  exportMotionScene?(
    options: ExportMotionSceneOptions,
  ): Promise<ExportMotionSceneResult>;
  /**
   * Motion render queue bridge (add/run/list/cancel). Optional because it needs
   * the live editor's motion store + renderer-side export pipeline that only the
   * live/desktop web host provides — headless hosts leave it undefined and the
   * queue tools fail clearly.
   */
  motionRenderQueue?: MotionRenderQueueBridge;
  /** Desktop-only DCC backend discovery for character rigging/retarget jobs. */
  probeRiggingBackend?(): Promise<RiggingBackendProbe>;
  /** Inspect a GLB/glTF model so agents can choose animation, rigging, and cleanup tools. */
  inspectModel?(options: ModelInspectionRequest): Promise<ModelInspectionReport>;
  /** Run a desktop rigging backend job to create or repair a humanoid GLB rig. */
  rigHumanoidModel?(options: HumanoidRigRequest): Promise<HumanoidRigResult>;
  /**
   * Create a text overlay through the engine-aware store path so it actually
   * registers with the TitleEngine the preview + timeline read from. The raw
   * text/create action only appends to project.textClips and never reaches the
   * engine, so it renders nothing — this method is the live host's fix.
   */
  createTextOverlay?(options: TextOverlayOptions): Promise<OverlayRef>;
  /**
   * Create a graphic (shape) overlay through the engine-aware store path so it
   * registers with the GraphicsEngine the preview reads from — the raw
   * shape/create action only appends to project.shapeClips and renders nothing.
   */
  createShapeOverlay?(options: ShapeOverlayOptions): Promise<OverlayRef>;
  /**
   * Edit/remove overlays through the engine-aware store path. The raw
   * text/update, text/remove, shape/*, sticker/*, svg/* actions only mutate the
   * serialized project arrays and never reach the Title/Graphics engines the
   * preview + export read from, so they appear to succeed but render stale.
   * These methods are the live host's fix for that whole class of bug.
   */
  updateTextOverlay?(id: string, options: UpdateTextOverlayOptions): Promise<OverlayRef>;
  updateShapeOverlay?(id: string, options: UpdateShapeOverlayOptions): Promise<OverlayRef>;
  createStickerOverlay?(options: StickerOverlayOptions): Promise<OverlayRef>;
  updateStickerOverlay?(id: string, options: UpdateStickerOverlayOptions): Promise<OverlayRef>;
  createSvgOverlay?(options: SvgOverlayOptions): Promise<OverlayRef>;
  updateSvgOverlay?(id: string, updates: Record<string, unknown>): Promise<OverlayRef>;
  removeOverlay?(kind: OverlayKind, id: string): Promise<boolean>;
}

export type MotionRenderQueueAddFormat =
  | "mp4"
  | "webm-alpha"
  | "mov-prores4444"
  | "png-sequence";

export interface MotionRenderQueueAddInput {
  readonly compositionId: string;
  readonly format?: MotionRenderQueueAddFormat;
  readonly range?: { readonly startTime: number; readonly endTime: number };
  readonly resolutionScale?: number;
  readonly filename?: string;
}

export interface MotionRenderQueueAddResult {
  readonly itemId: string;
}

export interface MotionRenderQueueAddError {
  readonly error: string;
}

export interface MotionRenderQueueRunOutcome {
  readonly itemId: string;
  readonly status: string;
  readonly encodedFormat?: string;
  readonly filename?: string;
  readonly error?: string;
}

export interface MotionRenderQueueRunResult {
  readonly outcomes: ReadonlyArray<MotionRenderQueueRunOutcome>;
  readonly alreadyRunning: boolean;
}

export interface MotionRenderQueueBridge {
  add(
    input: MotionRenderQueueAddInput,
  ): MotionRenderQueueAddResult | MotionRenderQueueAddError;
  run(): Promise<MotionRenderQueueRunResult>;
  list(): ReadonlyArray<Record<string, unknown>>;
  cancel(itemId: string): boolean;
}

export type OverlayKind = "text" | "shape" | "sticker" | "svg";

export interface UpdateTextOverlayOptions {
  readonly text?: string;
  readonly style?: Record<string, unknown>;
  readonly transform?: Record<string, unknown>;
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export interface UpdateShapeOverlayOptions {
  readonly color?: string;
  readonly opacity?: number;
  readonly style?: Record<string, unknown>;
  readonly transform?: Record<string, unknown>;
  readonly fullFrame?: boolean;
}

export interface StickerOverlayOptions {
  readonly emoji?: string;
  readonly imageUrl?: string;
  readonly name?: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
}

export interface UpdateStickerOverlayOptions {
  readonly transform?: Record<string, unknown>;
}

export interface SvgOverlayOptions {
  readonly svg: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
}

export interface TextOverlayOptions {
  readonly text: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
  readonly style?: Record<string, unknown>;
  /**
   * Overlay center in NORMALIZED 0-1 canvas coordinates (0,0 = top-left,
   * 0.5,0.5 = center) — the title engine's native units. Do NOT pre-multiply
   * by canvas dimensions; the renderer multiplies on draw.
   */
  readonly position?: { readonly x: number; readonly y: number };
  /** Entrance/exit animation preset (e.g. "fade", "scale", "slide-up", "pop"). */
  readonly animation?: string;
  readonly animationInSec?: number;
  readonly animationOutSec?: number;
}

export interface ShapeOverlayOptions {
  readonly shapeType?: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly trackId?: string;
  readonly color?: string;
  readonly opacity?: number;
  /** Scale the shape to cover the whole canvas (e.g. a full-frame scrim). */
  readonly fullFrame?: boolean;
}

export interface OverlayRef {
  readonly id: string;
  readonly trackId: string;
}

export type JobRunner = (
  kind: JobKind,
  params: Record<string, unknown>,
) => Promise<JobResult>;
