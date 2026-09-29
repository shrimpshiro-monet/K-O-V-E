export {};

export interface KoveAdvancedHardwareInfo {
  cpu: { model: string; physicalCores: number; logicalCores: number };
  memory: { totalBytes: number; freeBytes: number };
  gpus: string[];
  encoders: string[];
  platform: "darwin" | "win32" | "linux";
  arch: string;
}

export interface KoveAdvancedExportStartArgs {
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  format: string;
  bitrateKbps: number;
  outputPath: string;
  totalFrames: number;
  audioSampleRate: number;
  audioChannels: number;
  encodeMode?: "fast" | "balanced" | "smallest";
  quality?: number;
  proresProfile?: "proxy" | "lt" | "standard" | "hq" | "4444" | "4444xq";
}

export interface KoveAdvancedExportSession {
  jobId: string;
}

export interface KoveAdvancedAuroraRenderPreviewArgs {
  scene: unknown;
  assets: unknown[];
  width: number;
  height: number;
  background?: string;
  timeSeconds?: number;
  quality?: "preview" | "final";
}

export interface KoveAdvancedAuroraPreviewSessionStartArgs
  extends KoveAdvancedAuroraRenderPreviewArgs {
  sessionId?: string;
}

export interface KoveAdvancedAuroraPreviewSessionStartResult {
  sessionId: string;
}

export interface KoveAdvancedAuroraSequenceSessionStartArgs
  extends Omit<KoveAdvancedAuroraRenderPreviewArgs, "timeSeconds"> {
  sessionId?: string;
  frameRate: number;
  durationSeconds: number;
}

export interface KoveAdvancedAuroraSequenceSessionStartResult {
  sessionId: string;
}

export interface KoveAdvancedAuroraRenderPreviewResult {
  backend: "native" | "cpu";
  pngBase64: string;
  dataUri: string;
  width: number;
  height: number;
  coveredPixels: number;
  shadowedPixels: number;
  renderMs: number;
}

export type KoveAdvancedAuroraPreviewSessionEvent =
  | {
      kind: "update";
      sessionId: string;
      stage: "draft" | "refine" | "final";
      progress: number;
      done: boolean;
      targetWidth: number;
      targetHeight: number;
      result: KoveAdvancedAuroraRenderPreviewResult;
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export type KoveAdvancedAuroraSequenceSessionEvent =
  | {
      kind: "frame";
      sessionId: string;
      frameIndex: number;
      totalFrames: number;
      timeSeconds: number;
      progress: number;
      done: boolean;
      result: {
        backend: "native" | "cpu";
        rgba: Uint8Array;
        width: number;
        height: number;
        coveredPixels: number;
        shadowedPixels: number;
        renderMs: number;
      };
    }
  | {
      kind: "error";
      sessionId: string;
      done: true;
      error: string;
    };

export interface KoveAdvancedMcpStatus {
  running: boolean;
  url: string;
  port: number;
  token: string;
  shimPath: string;
  endpointFile: string;
}

export interface KoveAdvancedRiggingBackendProbe {
  available: boolean;
  provider: "blender";
  mode?: "configured" | "bundled" | "system";
  path?: string;
  version?: string;
  error?: string;
}

export interface KoveAdvancedRiggingWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface KoveAdvancedRigHumanoidModelArgs {
  modelUrl: string;
  outputPath?: string;
  name?: string;
  heightMeters?: number;
  overwriteExisting?: boolean;
}

export interface KoveAdvancedRigHumanoidModelResult {
  ok: boolean;
  provider: "blender";
  inputUrl: string;
  outputUrl?: string;
  outputPath?: string;
  armatureName?: string;
  createdArmature: boolean;
  preservedExistingArmature: boolean;
  skinnedMeshCount: number;
  meshCount: number;
  boneCount: number;
  warnings: KoveAdvancedRiggingWarning[];
  error?: string;
}

export type KoveAdvancedUpdaterStatus =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export interface KoveAdvancedBridge {
  platform: "desktop";
  publicOrigin: string;
  probeHardware(): Promise<KoveAdvancedHardwareInfo>;
  onMenuAction(cb: (id: string) => void): () => void;
  fs: {
    showSaveDialog(opts: {
      defaultPath: string;
      filters: { name: string; extensions: string[] }[];
    }): Promise<string | null>;
    showOpenDialog(opts: {
      filters: { name: string; extensions: string[] }[];
    }): Promise<string | null>;
    readFile(path: string): Promise<string>;
    readFileBytes(path: string): Promise<ArrayBuffer>;
    tempFilePath(ext: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    openWrite(path: string): Promise<string>;
    writeChunk(handleId: string, data: ArrayBuffer | Uint8Array, position: number): Promise<void>;
    closeWrite(handleId: string): Promise<void>;
    abortWrite(handleId: string): Promise<void>;
    revealInFolder(path: string): Promise<void>;
  };
  keychain: {
    get(id: string): Promise<string | null>;
    set(id: string, value: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  export: {
    start(args: KoveAdvancedExportStartArgs): Promise<KoveAdvancedExportSession>;
    writeAudioWav(jobId: string, wav: ArrayBuffer): Promise<void>;
    writeAudioChunk(jobId: string, chunk: ArrayBuffer, position: number): Promise<void>;
    finishAudio(jobId: string): Promise<void>;
    cancel(jobId: string): Promise<void>;
  };
  aurora?: {
    renderPreview(
      args: KoveAdvancedAuroraRenderPreviewArgs,
    ): Promise<KoveAdvancedAuroraRenderPreviewResult>;
    startPreviewSession(
      args: KoveAdvancedAuroraPreviewSessionStartArgs,
    ): Promise<KoveAdvancedAuroraPreviewSessionStartResult>;
    cancelPreviewSession(sessionId: string): Promise<void>;
    onPreviewEvent(
      cb: (event: KoveAdvancedAuroraPreviewSessionEvent) => void,
    ): () => void;
    startSequenceSession(
      args: KoveAdvancedAuroraSequenceSessionStartArgs,
    ): Promise<KoveAdvancedAuroraSequenceSessionStartResult>;
    cancelSequenceSession(sessionId: string): Promise<void>;
    onSequenceEvent(
      cb: (event: KoveAdvancedAuroraSequenceSessionEvent) => void,
    ): () => void;
  };
  cloud: {
    fetch(
      service:
        | "elevenlabs"
        | "openai"
        | "anthropic"
        | "openai-compatible"
        | "anthropic-compatible"
        | "cloudflare",
      path: string,
      options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        baseUrl?: string;
      },
    ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer }>;
  };
  win: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  lifecycle: {
    onQueryUnsaved(handler: () => boolean): () => void;
    onFlush(handler: () => Promise<void>): () => void;
  };
  updater: {
    onStatus(cb: (status: KoveAdvancedUpdaterStatus) => void): () => void;
    download(): Promise<void>;
    install(): Promise<void>;
  };
  crash: {
    report(payload: { message: string; stack?: string; type?: string; context?: unknown }): void;
  };
  mcp?: {
    onRequest(
      handler: (req: {
        callId: string;
        kind: "listTools" | "callTool";
        name?: string;
        args?: Record<string, unknown>;
      }) => Promise<{ ok: boolean; result?: unknown; error?: string }>,
    ): () => void;
    getStatus(): Promise<KoveAdvancedMcpStatus>;
    rotateToken(): Promise<KoveAdvancedMcpStatus>;
    testConnection(): Promise<{ ok: boolean; message?: string; toolCount?: number }>;
  };
  media: {
    generateProxy(args: { srcPath: string; preset: "low" | "medium" | "high" }): Promise<{ outPath: string }>;
    transcode(args: {
      srcPath: string;
      container?: "mp4" | "webm" | "mov";
      videoBitrateKbps?: number;
      audioBitrateKbps?: number;
    }): Promise<{ outPath: string }>;
    extractAudioWav(args: { srcPath: string; streamIndex?: number }): Promise<{ outPath: string }>;
    probeAudioStreams(args: { srcPath: string }): Promise<{
      streams: { index: number; codec: string; channels: number; sampleRate: number; language?: string }[];
    }>;
    fetchUrl(args: { url: string; maxBytes?: number }): Promise<{
      ok: boolean;
      status: number;
      statusText: string;
      contentType: string;
      body: ArrayBuffer;
      error?: string;
    }>;
  };
  rigging?: {
    probeBackend(): Promise<KoveAdvancedRiggingBackendProbe>;
    rigHumanoidModel(
      args: KoveAdvancedRigHumanoidModelArgs,
    ): Promise<KoveAdvancedRigHumanoidModelResult>;
  };
}

declare global {
  interface Window {
    ["kove-advanced"]?: KoveAdvancedBridge;
  }
}
