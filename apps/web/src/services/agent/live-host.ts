import type {
  AudioSamples,
  EditingHost,
  JobKind,
  JobResult,
  JobRunner,
  TxnHandle,
  ProjectRef,
  ImportedMediaRef,
  RiggingBackendProbe,
  CreateProjectOptions,
  ModelInspectionReport,
  ModelInspectionRequest,
  HumanoidRigRequest,
  HumanoidRigResult,
  TextOverlayOptions,
  ShapeOverlayOptions,
  OverlayRef,
  OverlayKind,
  UpdateTextOverlayOptions,
  UpdateShapeOverlayOptions,
  StickerOverlayOptions,
  UpdateStickerOverlayOptions,
  SvgOverlayOptions,
  ExportMotionSceneOptions,
  ExportMotionSceneResult,
  ExportMotionSceneFormat,
  MotionRenderQueueBridge,
  MotionRenderQueueAddInput,
  MotionRenderQueueAddResult,
  MotionRenderQueueAddError,
  MotionRenderQueueRunResult,
  MulticamHostBridge,
  HostFeatures,
  TimelineFrame,
  TimelineFrameRequest,
  VisionSamplingRequest,
  FaceAnalysisResult,
  SubjectMatteRequest,
  SubjectMatteResult,
  ApplySubjectMatteRequest,
  ApplySubjectMatteResult,
} from "@kove-advanced/agent";
import type { TextStyle, TextAnimationPreset } from "@kove-advanced/core/text/types";
import type { ShapeStyle, ShapeType } from "@kove-advanced/core/graphics/types";
import type { Transform } from "@kove-advanced/core/types/timeline";
import { CAPABILITY_MANIFEST } from "@kove-advanced/core/capabilities/manifest";
import type { Action } from "@kove-advanced/core/types/actions";
import type { Project } from "@kove-advanced/core/types/project";
import type { CapabilityManifest } from "@kove-advanced/core/capabilities/manifest";
import { HistoryLedger, fingerprintProject } from "@kove-advanced/agent";
import type { HistoryBackend } from "@kove-advanced/agent";
import { useProjectStore } from "../../stores/project-store";
import { insertTimelineOverlay } from "../../stores/project/insert-timeline-overlay";
import { checkForRecovery } from "../auto-save";
import { inspectGltfModel } from "../../motion/model-inspection";
import {
  exportMotionCompositionScene,
  MOTION_EXPORT_FORMATS,
  type MotionExportFormat,
  type MotionExportRange,
  type MotionExportResolutionScale,
} from "../../motion/export-motion-frame";
import {
  useMotionStore,
  type MotionRenderQueueFormat,
} from "../../motion/stores/motion-store";
import { runMotionRenderQueue } from "../../motion/render-queue-runner";
import { createMulticamHostBridge } from "./multicam-bridge";

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    return dot >= 0 ? pathname.slice(dot + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

function inferName(url: string, mime: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (base && base.includes(".")) return decodeURIComponent(base);
  } catch {
    /* fall through */
  }
  const ext = (mime.split("/")[1] ?? "bin").replace("jpeg", "jpg");
  return `media-${Date.now()}.${ext}`;
}

function projectRef(project: Project): ProjectRef {
  return {
    id: project.id,
    name: project.name,
    width: project.settings.width,
    height: project.settings.height,
    frameRate: project.settings.frameRate,
    modifiedAt: project.modifiedAt,
  };
}

export interface LiveEditorHostOptions {
  readonly jobRunner?: JobRunner;
  /** Decodes a media item's audio. Defaults to the browser decode path (loadAudioBuffer). Injectable for tests. */
  readonly audioSource?: (mediaId: string, audioTrackIndex: number) => Promise<AudioSamples | null>;
}

/** Browser decode: media blob -> extract/decode audio track -> samples. Source audio, pre-effects. */
async function decodeMediaAudio(mediaId: string, audioTrackIndex: number): Promise<AudioSamples | null> {
  const item = useProjectStore.getState().getMediaItem(mediaId);
  if (!item?.blob) return null;
  const { loadAudioBuffer } = await import("../../utils/load-audio-buffer");
  const context = new AudioContext();
  try {
    const buffer = await loadAudioBuffer(context, item.blob, { audioTrackIndex });
    if (!buffer) return null;
    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    return { channels, sampleRate: buffer.sampleRate };
  } finally {
    void context.close();
  }
}

const RENDER_QUEUE_FORMATS: readonly MotionRenderQueueFormat[] = [
  "mp4",
  "webm-alpha",
  "mov-prores4444",
  "png-sequence",
];

const RENDER_QUEUE_RESOLUTION_SCALES: readonly MotionExportResolutionScale[] = [
  1, 0.5, 0.25,
];

function normalizeRenderQueueFormat(
  format: string | undefined,
): MotionRenderQueueFormat | undefined {
  if (format === undefined) return "mp4";
  return (RENDER_QUEUE_FORMATS as readonly string[]).includes(format)
    ? (format as MotionRenderQueueFormat)
    : undefined;
}

function normalizeRenderQueueScale(
  scale: number | undefined,
): MotionExportResolutionScale | undefined | null {
  if (scale === undefined) return undefined;
  return (RENDER_QUEUE_RESOLUTION_SCALES as readonly number[]).includes(scale)
    ? (scale as MotionExportResolutionScale)
    : null;
}

/**
 * EditingHost backed by the live web editor's Zustand store. Used by the
 * built-in chat (in-renderer) and by the desktop MCP server (forwarded over
 * IPC). Edits go through the same undoable action path the UI uses, so the chat
 * and the timeline stay in sync and the whole turn undoes as one history group.
 */
/** Stable small ids for object identity, used to notice a replaced undo/redo stack array. */
const identityIds = new WeakMap<object, number>();
let nextIdentityId = 0;
const identityId = (o: object): number => {
  let id = identityIds.get(o);
  if (id === undefined) {
    id = ++nextIdentityId;
    identityIds.set(o, id);
  }
  return id;
};

/**
 * Host methods through which the AGENT changes the project. Wrapped so the
 * history ledger can tell agent changes from the user's (anything that moves
 * the undo stacks outside these calls is attributed to the user).
 */
const AGENT_MUTATORS = [
  "importMediaFromUrl",
  "createTextOverlay",
  "createShapeOverlay",
  "updateTextOverlay",
  "updateShapeOverlay",
  "createStickerOverlay",
  "updateStickerOverlay",
  "createSvgOverlay",
  "updateSvgOverlay",
  "removeOverlay",
] as const;

export class LiveEditorHost implements EditingHost {
  /**
   * Wired by chat-store before a run so nested director calls (plan_edit)
   * share the session's LLM client. Matches EditingHost["llm"].
   */
  llm?: EditingHost["llm"];
  private jobRunner?: JobRunner;
  private appliedInTxn = 0;
  // exportFrame renders MOTION compositions only (it needs a compositionId), so the
  // multicam preview cannot be served by it. Report that explicitly rather than
  // returning a misleading generic failure — see features().renderMulticamPreview.
  readonly multicam: MulticamHostBridge = createMulticamHostBridge(async () => ({
    ok: false,
    code: "unsupported_host" as const,
    error: "Multicam preview rendering is not implemented in this host",
  }));

  private readonly audioSource?: LiveEditorHostOptions["audioSource"];
  private readonly ledger: HistoryLedger;
  readonly historyControl: HistoryLedger;

  constructor(options: LiveEditorHostOptions = {}) {
    this.jobRunner = options.jobRunner;
    this.audioSource = options.audioSource;
    this.ledger = new HistoryLedger(this.historyBackend());
    this.historyControl = this.ledger;
    for (const name of AGENT_MUTATORS) {
      const original = (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
        this.trackAgentMutation(() => original.apply(this, args));
    }
  }

  private async trackAgentMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.ledger.beforeAgentMutation();
    try {
      return await fn();
    } finally {
      this.ledger.afterAgentMutation();
    }
  }

  /**
   * The live store has three undo stacks (actions, overlay clips, editing
   * templates). Position/markers cover all three; undo/redo go through the
   * store's own undo()/redo() so engine syncing and the redo journal stay
   * correct — a wholesale project swap would desync the Title/Graphics engines.
   */
  private historyBackend(): HistoryBackend {
    const st = () => useProjectStore.getState();
    const clipMarker = (e: { type: string; clipId: string; op?: string }) => `clip:${e.type}:${e.clipId}:${e.op ?? "create"}`;
    const tplMarker = (e: { mode: string; description: string }) => `tpl:${e.mode}:${e.description}`;
    return {
      position: () => {
        const s = st();
        return {
          actions: s.actionHistory.getUndoStackSize(),
          aux: s.clipUndoStack.length + s.templateUndoStack.length,
          detail: { clips: s.clipUndoStack.length, templates: s.templateUndoStack.length },
        };
      },
      markersAt: (pos) => {
        const s = st();
        const d = (pos.detail ?? { clips: 0, templates: 0 }) as { clips: number; templates: number };
        const entries = s.actionHistory.getHistoryEntries();
        if (
          entries.length < pos.actions ||
          s.clipUndoStack.length < d.clips ||
          s.templateUndoStack.length < d.templates
        ) {
          return undefined;
        }
        return [
          pos.actions === 0 ? null : entries[pos.actions - 1]!.action,
          d.clips === 0 ? null : clipMarker(s.clipUndoStack[d.clips - 1]!),
          d.templates === 0 ? null : tplMarker(s.templateUndoStack[d.templates - 1]!),
        ];
      },
      token: () => {
        const s = st();
        return [
          s.project.id,
          identityId(s.actionHistory),
          s.actionHistory.getRevision(),
          identityId(s.clipUndoStack),
          identityId(s.clipRedoStack),
          identityId(s.templateUndoStack),
          identityId(s.templateRedoStack),
        ].join(":");
      },
      canUndo: () => st().canUndo(),
      canRedo: () => st().canRedo(),
      undoStep: () => st().undo(),
      redoStep: () => st().redo(),
      sealGroup: () => st().actionHistory.sealGroup(),
      // getFullProject() folds in engine-held overlay clips, like autosave does.
      fingerprint: () => fingerprintProject(st().getFullProject()),
    };
  }

  features(): HostFeatures {
    const hasRunner = this.jobRunner !== undefined;
    // Face detection and segmentation need a DOM video decoder + MediaPipe.
    const hasVision = typeof document !== "undefined" && typeof createImageBitmap === "function";
    return {
      renderMotionFrame: hasRunner,
      renderTimelineFrame: true,
      renderMulticamPreview: false,
      exportVideo: hasRunner,
      checkpoints: true,
      analyzeAudio: this.audioSource !== undefined || typeof AudioContext !== "undefined",
      analyzeFaces: hasVision,
      analyzeSubjectMatte: hasVision,
      applySubjectMatte: hasVision,
    };
  }

  /** Resolves a media item's decodable source. Mirrors the audio path. */
  private visionSource(mediaId: string): { blob: Blob; durationSeconds: number } | { error: string } {
    const media = this.getProject().mediaLibrary.items.find((item) => item.id === mediaId);
    if (!media) return { error: `Media not found: ${mediaId}` };
    const blob = (media.blob ?? null) as Blob | null;
    if (!blob) {
      return {
        error: `Media "${media.name}" has no local bytes (reconnect or re-import it before analysis).`,
      };
    }
    const duration = (media.metadata as { duration?: number } | undefined)?.duration ?? 0;
    return { blob, durationSeconds: duration > 0 ? duration : 0 };
  }

  async analyzeFaces(
    request: VisionSamplingRequest,
  ): Promise<FaceAnalysisResult | { readonly code: "unsupported_host"; readonly error: string }> {
    const source = this.visionSource(request.mediaId);
    if ("error" in source) return { code: "unsupported_host", error: source.error };
    const { analyzeFacesInMedia } = await import("./vision-analysis");
    return analyzeFacesInMedia({
      blob: source.blob,
      durationSeconds: this.effectiveDuration(source.durationSeconds, request),
      request,
    });
  }

  async analyzeSubjectMatte(
    request: SubjectMatteRequest,
  ): Promise<SubjectMatteResult | { readonly code: "unsupported_host"; readonly error: string }> {
    const source = this.visionSource(request.mediaId);
    if ("error" in source) return { code: "unsupported_host", error: source.error };
    const { analyzeSubjectMatte } = await import("./vision-analysis");
    const analysis = await analyzeSubjectMatte({
      blob: source.blob,
      durationSeconds: this.effectiveDuration(source.durationSeconds, request),
      streamId: `agent-matte:${request.mediaId}`,
      request,
    });
    return analysis.result;
  }

  async applySubjectMatte(
    request: ApplySubjectMatteRequest,
  ): Promise<ApplySubjectMatteResult | { readonly code: "unsupported_host"; readonly error: string }> {
    const source = this.visionSource(request.mediaId);
    if ("error" in source) return { code: "unsupported_host", error: source.error };
    const clip = this.getProject()
      .timeline.tracks.flatMap((track) => track.clips)
      .find((entry) => entry.id === request.clipId);
    if (!clip) return { code: "unsupported_host", error: `Clip not found: ${request.clipId}` };

    const { analyzeSubjectMatte, writeMatteToMasks } = await import("./vision-analysis");
    const analysis = await analyzeSubjectMatte({
      blob: source.blob,
      durationSeconds: this.effectiveDuration(source.durationSeconds, request),
      streamId: `agent-matte:${request.mediaId}`,
      request,
    });
    if (analysis.plan.keyframes.length === 0) {
      return {
        maskId: request.maskId ?? "",
        keyframeCount: 0,
        firstTimeSeconds: null,
        lastTimeSeconds: null,
        separationApplied: false,
        warnings: [...analysis.result.warnings],
      };
    }

    const createId = (): string => crypto.randomUUID();
    const written = writeMatteToMasks({
      masks: this.getProject().masks ?? [],
      clipId: request.clipId,
      ...(request.maskId ? { maskId: request.maskId } : {}),
      plan: analysis.plan,
      timeMapping: {
        startTime: clip.startTime,
        inPoint: clip.inPoint ?? 0,
        speed: Math.max(0.001, clip.speed ?? 1),
        ...(clip.outPoint !== undefined ? { outPoint: clip.outPoint } : {}),
        ...(clip.reversed ? { reversed: true } : {}),
      },
      ...(request.featherPx !== undefined ? { featherPx: request.featherPx } : {}),
      ...(request.expansionPx !== undefined ? { expansionPx: request.expansionPx } : {}),
      ...(request.invertMask !== undefined ? { invertMask: request.invertMask } : {}),
      createId,
    });

    // One undoable action for the whole matte, then keep the live MaskEngine
    // in sync so the inspector shows it immediately.
    const actionResult = await this.applyAction({
      type: "mask/setAll",
      id: createId(),
      timestamp: Date.now(),
      params: { masks: written.masks },
    } as Action);
    if (!actionResult.success) {
      return {
        maskId: written.maskId,
        keyframeCount: 0,
        firstTimeSeconds: null,
        lastTimeSeconds: null,
        separationApplied: false,
        warnings: [`Mask could not be saved: ${actionResult.error ?? "unknown error"}`],
      };
    }
    const { useEngineStore } = await import("../../stores/engine-store");
    const maskEngine = await useEngineStore.getState().getMaskEngine();
    maskEngine.loadMasks([...written.masks]);

    let separationApplied = false;
    const warnings = [...written.warnings];
    if (request.separation) {
      try {
        const {
          planSubjectSeparation,
          backgroundRemovalSettingsFromSeparation,
          initializeBackgroundRemovalEngine,
        } = await import("@kove-advanced/core");
        const plan = planSubjectSeparation(request.separation);
        warnings.push(...plan.warnings);
        const engine = initializeBackgroundRemovalEngine();
        engine.setSettings(
          request.clipId,
          backgroundRemovalSettingsFromSeparation(plan, engine.getSettings(request.clipId)),
        );
        // The compositor only applies separation once the engine is
        // initialized (it loads the local segmentation model). Do it here so
        // the preset is not a silent no-op, and say so if the model is
        // unavailable instead of pretending it rendered.
        if (!engine.isInitialized()) {
          try {
            await engine.initialize();
          } catch (error) {
            warnings.push(
              `Subject separation settings were saved, but the model did not initialize: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        separationApplied = true;
      } catch (error) {
        warnings.push(
          `Subject separation settings could not be applied: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      maskId: written.maskId,
      keyframeCount: written.keyframeCount,
      firstTimeSeconds: written.firstTimeSeconds,
      lastTimeSeconds: written.lastTimeSeconds,
      separationApplied,
      warnings,
    };
  }

  /** Falls back to the clip's own out-point when metadata has no duration. */
  private effectiveDuration(mediaDuration: number, request: { endTime?: number }): number {
    if (mediaDuration > 0) return mediaDuration;
    if (request.endTime !== undefined) return request.endTime;
    return 0;
  }

  loadAudioSamples(mediaId: string, audioTrackIndex = 0): Promise<AudioSamples | null> {
    return (this.audioSource ?? decodeMediaAudio)(mediaId, audioTrackIndex);
  }

  /**
   * Render one composited timeline frame through the app's RenderBridge
   * (VideoEngine → ImageBitmap → scaled PNG/JPEG data URL). Same pipeline
   * the preview uses, so the agent sees what the user sees.
   *
   * Compositor unavailability (engine store not initialized, no frame at the
   * requested time) resolves to UNSUPPORTED_HOST per the host contract;
   * encode failures throw, because that is a host bug, not a capability gap.
   */
  async renderTimelineFrame(
    request: TimelineFrameRequest,
  ): Promise<
    TimelineFrame | { readonly code: "unsupported_host"; readonly error: string }
  > {
    let frame: Awaited<ReturnType<import("../../bridges/render-bridge").RenderBridge["renderFrame"]>>;
    try {
      const { getRenderBridge } = await import("../../bridges/render-bridge");
      const bridge = getRenderBridge();
      await bridge.initialize();
      frame = await bridge.renderFrame(request.time);
    } catch (error) {
      return {
        code: "unsupported_host",
        error: `Timeline compositor unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!frame) {
      return {
        code: "unsupported_host",
        error: `The compositor produced no frame at ${request.time}s.`,
      };
    }
    const { encodeRenderedFrame } = await import("./timeline-frame");
    return encodeRenderedFrame(frame, request, "web/canvas2d");
  }

  setJobRunner(runner: JobRunner): void {
    this.jobRunner = runner;
  }

  getProject(): Project {
    this.requireOpenProject();
    return useProjectStore.getState().project;
  }

  async applyAction(action: Action) {
    this.requireOpenProject();
    this.ledger.beforeAgentMutation();
    try {
      const result = await useProjectStore.getState().executeAction(action);
      if (result.success) this.appliedInTxn++;
      return result;
    } finally {
      this.ledger.afterAgentMutation();
    }
  }

  beginTransaction(label?: string): TxnHandle {
    this.appliedInTxn = 0;
    useProjectStore.getState().beginHistoryGroup(label);
    return { id: label ?? "turn" };
  }

  commitTransaction(_handle: TxnHandle, _label: string): void {
    useProjectStore.getState().endHistoryGroup();
  }

  async rollbackTransaction(_handle: TxnHandle): Promise<void> {
    useProjectStore.getState().endHistoryGroup();
    // The turn's actions form one history group; a single undo reverts them all.
    if (this.appliedInTxn > 0) {
      await useProjectStore.getState().undo();
    }
    this.appliedInTxn = 0;
    this.ledger.afterAgentMutation("history");
  }

  async runJob(
    kind: JobKind,
    params: Record<string, unknown>,
  ): Promise<JobResult> {
    if (!this.jobRunner) {
      return { ok: false, error: `Job '${kind}' is not wired in the live host yet` };
    }
    return this.jobRunner(kind, params);
  }

  capabilities(): CapabilityManifest {
    return CAPABILITY_MANIFEST;
  }

  requireOpenProject(): void {
    if (!useProjectStore.getState().hasOpenProject) {
      throw new Error("No project is open");
    }
  }

  async createProject(options: CreateProjectOptions): Promise<ProjectRef> {
    const settings: Partial<Project["settings"]> = {
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.frameRate !== undefined ? { frameRate: options.frameRate } : {}),
    };
    useProjectStore.getState().createNewProject(options.name, settings);
    this.ledger.invalidateAll();
    return projectRef(useProjectStore.getState().project);
  }

  async listProjects(): Promise<readonly ProjectRef[]> {
    const saves = await checkForRecovery();
    const latest = new Map<string, ProjectRef>();
    for (const s of saves) {
      const existing = latest.get(s.projectId);
      if (!existing || (existing.modifiedAt ?? 0) < s.timestamp) {
        latest.set(s.projectId, { id: s.id, name: s.projectName, modifiedAt: s.timestamp });
      }
    }
    return [...latest.values()].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  }

  async openProject(id: string): Promise<ProjectRef> {
    const ok = await useProjectStore.getState().recoverFromAutoSave(id);
    if (!ok) throw new Error(`Could not open project (save id "${id}")`);
    this.ledger.invalidateAll();
    return projectRef(useProjectStore.getState().project);
  }

  async saveProject(): Promise<ProjectRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    await store.forceSave();
    return projectRef(store.getFullProject());
  }

  async importMediaFromUrl(
    url: string,
    options?: { name?: string },
  ): Promise<ImportedMediaRef> {
    this.requireOpenProject();
    const bridge = window["kove-advanced"]?.media?.fetchUrl;
    if (typeof bridge !== "function") {
      throw new Error("Media download is only available in the desktop app");
    }
    const res = await bridge({ url });
    if (!res.ok) {
      throw new Error(res.error ?? `Download failed: HTTP ${res.status}`);
    }
    const mime = (res.contentType.split(";")[0] ?? "").trim() || MIME_BY_EXT[extFromUrl(url)] || "application/octet-stream";
    const name = options?.name ?? inferName(url, mime);
    const file = new File([res.body], name, { type: mime });
    const result = await useProjectStore.getState().importMedia(file);
    if (!result.success || !result.actionId) {
      throw new Error(result.error?.message ?? "Media import failed");
    }
    const mediaId = result.actionId;
    const item = useProjectStore
      .getState()
      .project.mediaLibrary.items.find((m) => m.id === mediaId);
    return {
      mediaId,
      name,
      type: item?.type ?? "unknown",
      durationSec: item?.metadata?.duration ?? 0,
      width: item?.metadata?.width,
      height: item?.metadata?.height,
    };
  }

  async exportMotionScene(
    options: ExportMotionSceneOptions,
  ): Promise<ExportMotionSceneResult> {
    this.requireOpenProject();
    const project = useProjectStore.getState().project;
    const compositions = project.motionCompositions ?? [];
    const composition = compositions.find(
      (candidate) => candidate.id === options.compositionId,
    );
    if (!composition) {
      throw new Error(`Motion composition not found: ${options.compositionId}`);
    }
    const requestedFormat: ExportMotionSceneFormat = options.format ?? "mp4";
    const descriptor = MOTION_EXPORT_FORMATS.find(
      (entry) => entry.id === requestedFormat,
    );
    const requiresNative =
      descriptor !== undefined &&
      (descriptor.transparent || descriptor.extension === "mov");
    const nativeAvailable =
      typeof window !== "undefined" &&
      window["kove-advanced"]?.platform === "desktop";
    const willNormalize = requiresNative && !nativeAvailable;
    if (willNormalize && options.acknowledgeH264Fallback !== true) {
      throw new Error(
        "Web export can't produce ProRes or alpha — this will encode H.264 without transparency. Pass acknowledgeH264Fallback:true to consent, or use the desktop app for ProRes/alpha.",
      );
    }
    const encodedFormat: ExportMotionSceneFormat = willNormalize
      ? "mp4"
      : requestedFormat;
    const result = await exportMotionCompositionScene({
      project,
      composition,
      compositionLibrary: compositions.length > 0 ? compositions : [composition],
      format: encodedFormat as MotionExportFormat,
      ...(options.filename ? { filename: options.filename } : {}),
    });
    return {
      filename: result.filename,
      width: result.width,
      height: result.height,
      duration: result.duration,
      framesRendered: result.framesRendered,
      requestedFormat,
      encodedFormat,
      normalizedToH264: willNormalize,
      ...(willNormalize
        ? { note: "Encoded H.264 (ProRes/alpha unavailable on web)" }
        : {}),
    };
  }

  motionRenderQueue: MotionRenderQueueBridge = {
    add: (
      input: MotionRenderQueueAddInput,
    ): MotionRenderQueueAddResult | MotionRenderQueueAddError => {
      if (!useProjectStore.getState().hasOpenProject) {
        return { error: "No project is open" };
      }
      const format = normalizeRenderQueueFormat(input.format);
      if (format === undefined) {
        return { error: `Unsupported render queue format: ${input.format}` };
      }
      const scale = normalizeRenderQueueScale(input.resolutionScale);
      if (scale === null) {
        return {
          error: `resolutionScale must be one of ${RENDER_QUEUE_RESOLUTION_SCALES.join(", ")}`,
        };
      }
      const project = useProjectStore.getState().project;
      const compositions = project.motionCompositions ?? [];
      const scene = compositions.find(
        (candidate) => candidate.id === input.compositionId,
      );
      if (!scene) {
        return {
          error: `Motion composition not found: ${input.compositionId}`,
        };
      }
      let range: MotionExportRange | undefined;
      if (input.range !== undefined) {
        const { startTime, endTime } = input.range;
        if (
          !Number.isFinite(startTime) ||
          !Number.isFinite(endTime) ||
          !(startTime < endTime) ||
          startTime < 0 ||
          endTime > scene.duration
        ) {
          return {
            error: "range must satisfy 0 <= startTime < endTime <= duration",
          };
        }
        range = { startTime, endTime };
      }
      const itemId = useMotionStore.getState().addRenderQueueItem({
        compositionId: scene.id,
        name: scene.name,
        width: scene.width,
        height: scene.height,
        frameRate: scene.frameRate,
        duration: scene.duration,
        format,
        ...(range !== undefined ? { range } : {}),
        ...(scale !== undefined ? { resolutionScale: scale } : {}),
      });
      return { itemId };
    },
    run: async (): Promise<MotionRenderQueueRunResult> => {
      if (!useProjectStore.getState().hasOpenProject) {
        return { outcomes: [], alreadyRunning: false };
      }
      const project = useProjectStore.getState().project;
      const compositions = project.motionCompositions ?? [];
      const result = await runMotionRenderQueue({ project, compositions });
      if (result.alreadyRunning) {
        return { outcomes: [], alreadyRunning: true };
      }
      return {
        alreadyRunning: false,
        outcomes: result.outcomes.map((outcome) => ({
          itemId: outcome.itemId,
          status: outcome.status,
          ...(outcome.encodedFormat !== undefined
            ? { encodedFormat: outcome.encodedFormat }
            : {}),
          ...(outcome.filename !== undefined
            ? { filename: outcome.filename }
            : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        })),
      };
    },
    list: (): ReadonlyArray<Record<string, unknown>> =>
      useMotionStore.getState().renderQueue.map((item) => ({
        itemId: item.id,
        compositionId: item.compositionId,
        name: item.name,
        format: item.format,
        status: item.status,
        progress: item.progress,
        ...(item.range !== undefined ? { range: item.range } : {}),
        ...(item.resolutionScale !== undefined
          ? { resolutionScale: item.resolutionScale }
          : {}),
        ...(item.outputFilename !== undefined
          ? { filename: item.outputFilename }
          : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      })),
    cancel: (itemId: string): boolean => {
      const exists = useMotionStore
        .getState()
        .renderQueue.some((item) => item.id === itemId);
      if (!exists) return false;
      useMotionStore.getState().cancelRenderQueueItem(itemId);
      return true;
    },
  };

  async probeRiggingBackend(): Promise<RiggingBackendProbe> {
    const probeBackend = window["kove-advanced"]?.rigging?.probeBackend;
    if (typeof probeBackend !== "function") {
      return {
        available: false,
        provider: "blender",
        error: "Rigging backend is only available in the desktop app",
      };
    }
    return probeBackend();
  }

  async inspectModel(options: ModelInspectionRequest): Promise<ModelInspectionReport> {
    return inspectGltfModel(options.modelUrl, {
      ...(options.name ? { name: options.name } : {}),
      ...(options.source ? { source: options.source } : {}),
    });
  }

  async rigHumanoidModel(options: HumanoidRigRequest): Promise<HumanoidRigResult> {
    const rigHumanoidModel = window["kove-advanced"]?.rigging?.rigHumanoidModel;
    if (typeof rigHumanoidModel !== "function") {
      return {
        ok: false,
        provider: "blender",
        inputUrl: options.modelUrl,
        createdArmature: false,
        preservedExistingArmature: false,
        skinnedMeshCount: 0,
        meshCount: 0,
        boneCount: 0,
        warnings: [
          {
            code: "HOST_UNAVAILABLE",
            severity: "error",
            message: "Humanoid rigging is only available in the desktop app.",
          },
        ],
        error: "Humanoid rigging is only available in the desktop app",
      };
    }
    return rigHumanoidModel({
      modelUrl: options.modelUrl,
      ...(options.outputPath ? { outputPath: options.outputPath } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.heightMeters ? { heightMeters: options.heightMeters } : {}),
      ...(options.overwriteExisting !== undefined
        ? { overwriteExisting: options.overwriteExisting }
        : {}),
    });
  }

  async createTextOverlay(options: TextOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .createTextClip(
            trackId,
            options.startSec,
            options.text,
            options.durationSec,
            options.style as Partial<TextStyle> | undefined,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create text overlay");

    if (options.animation && options.animation !== "none") {
      useProjectStore
        .getState()
        .applyTextAnimationPreset(
          clip.id,
          options.animation as TextAnimationPreset,
          options.animationInSec ?? 0.3,
          options.animationOutSec ?? 0.25,
        );
    }
    if (options.position) {
      // Title-engine units are normalized 0-1 — pass through unmultiplied.
      useProjectStore.getState().updateTextTransform(clip.id, {
        position: { x: options.position.x, y: options.position.y },
      });
    }
    return { id: clip.id, trackId: clip.trackId };
  }

  async createShapeOverlay(options: ShapeOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const style: Partial<ShapeStyle> = {
      fill: { type: "solid", color: options.color ?? "#000000", opacity: options.opacity ?? 0.45 },
      stroke: { color: "#000000", width: 0, opacity: 0 },
    };
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .createShapeClip(
            trackId,
            options.startSec,
            (options.shapeType ?? "rectangle") as ShapeType,
            options.durationSec,
            style,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create shape overlay");

    if (options.fullFrame) {
      const { width, height } = useProjectStore.getState().project.settings;
      useProjectStore.getState().updateShapeTransform(clip.id, {
        position: { x: 0.5, y: 0.5 },
        scale: { x: width / 200, y: height / 200 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      });
    }
    return { id: clip.id, trackId: clip.trackId };
  }

  async updateTextOverlay(
    id: string,
    options: UpdateTextOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getTextClip(id)) {
      throw new Error(`Text overlay "${id}" not found`);
    }
    if (options.text !== undefined && !store.updateTextContent(id, options.text)) {
      throw new Error(`Failed to update text overlay "${id}" content`);
    }
    if (options.style !== undefined) {
      if (!store.updateTextStyle(id, options.style as Partial<TextStyle>)) {
        throw new Error(`Failed to update text overlay "${id}" style`);
      }
    }
    if (options.transform !== undefined) {
      if (!store.updateTextTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update text overlay "${id}" transform`);
      }
    }
    if (options.animation && options.animation !== "none") {
      const updated = store.applyTextAnimationPreset(
        id,
        options.animation as TextAnimationPreset,
        options.animationInSec ?? 0.3,
        options.animationOutSec ?? 0.25,
      );
      if (!updated) throw new Error(`Failed to update text overlay "${id}" animation`);
    }
    const clip = useProjectStore.getState().getTextClip(id);
    if (!clip) throw new Error(`Text overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async updateShapeOverlay(
    id: string,
    options: UpdateShapeOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getShapeClip(id)) {
      throw new Error(`Shape overlay "${id}" not found`);
    }
    if (
      options.style !== undefined ||
      options.color !== undefined ||
      options.opacity !== undefined
    ) {
      const style: Partial<ShapeStyle> =
        (options.style as Partial<ShapeStyle> | undefined) ?? {
          fill: {
            type: "solid",
            color: options.color ?? "#000000",
            opacity: options.opacity ?? 1,
          },
        };
      if (!store.updateShapeStyle(id, style)) {
        throw new Error(`Failed to update shape overlay "${id}" style`);
      }
    }
    if (options.transform !== undefined) {
      if (!store.updateShapeTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update shape overlay "${id}" transform`);
      }
    }
    if (options.fullFrame) {
      const { width, height } = useProjectStore.getState().project.settings;
      const updated = store.updateShapeTransform(id, {
        position: { x: 0.5, y: 0.5 },
        scale: { x: width / 200, y: height / 200 },
        anchor: { x: 0.5, y: 0.5 },
        rotation: 0,
        opacity: 1,
      });
      if (!updated) throw new Error(`Failed to resize shape overlay "${id}"`);
    }
    const clip = useProjectStore.getState().getShapeClip(id);
    if (!clip) throw new Error(`Shape overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async createStickerOverlay(
    options: StickerOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const { stickerLibrary } = await import("@kove-advanced/core");
    const created = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) => {
        const clip = options.imageUrl
          ? stickerLibrary.createStickerClip(
              {
                id: crypto.randomUUID(),
                name: options.name ?? "sticker",
                category: "custom",
                imageUrl: options.imageUrl,
              },
              trackId,
              options.startSec,
              options.durationSec,
            )
          : stickerLibrary.createEmojiClip(
              {
                id: crypto.randomUUID(),
                emoji: options.emoji ?? "⭐",
                name: options.name ?? options.emoji ?? "emoji",
                category: "emojis",
              },
              trackId,
              options.startSec,
              options.durationSec,
            );
        return useProjectStore.getState().createStickerClip(clip);
      },
      options.trackId,
    );
    if (!created) throw new Error("Failed to create sticker overlay");
    return { id: created.id, trackId: created.trackId };
  }

  async updateStickerOverlay(
    id: string,
    options: UpdateStickerOverlayOptions,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    if (!store.getStickerClip(id)) {
      throw new Error(`Sticker overlay "${id}" not found`);
    }
    if (options.transform !== undefined) {
      if (!store.updateShapeTransform(id, options.transform as Partial<Transform>)) {
        throw new Error(`Failed to update sticker overlay "${id}" transform`);
      }
    }
    const clip = useProjectStore.getState().getStickerClip(id);
    if (!clip) throw new Error(`Sticker overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async createSvgOverlay(options: SvgOverlayOptions): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = await insertTimelineOverlay(
      options.startSec,
      options.durationSec,
      (trackId) =>
        useProjectStore
          .getState()
          .importSVG(
            options.svg,
            trackId,
            options.startSec,
            options.durationSec,
          ),
      options.trackId,
    );
    if (!clip) throw new Error("Failed to create SVG overlay");
    return { id: clip.id, trackId: clip.trackId };
  }

  async updateSvgOverlay(
    id: string,
    updates: Record<string, unknown>,
  ): Promise<OverlayRef> {
    this.requireOpenProject();
    const clip = useProjectStore.getState().updateSVGClip(id, updates);
    if (!clip) throw new Error(`SVG overlay "${id}" not found`);
    return { id, trackId: clip.trackId };
  }

  async removeOverlay(kind: OverlayKind, id: string): Promise<boolean> {
    this.requireOpenProject();
    const store = useProjectStore.getState();
    switch (kind) {
      case "text":
        return store.deleteTextClip(id);
      case "shape":
        return store.deleteShapeClip(id);
      case "sticker":
        return store.deleteStickerClip(id);
      case "svg":
        return store.deleteSVGClip(id);
      default:
        return false;
    }
  }
}
