import { CODEC_MAP, type VideoExportSettings, type AudioExportSettings, type ExportError } from "./types";
import type { Project } from "../types/project";
import type { EncoderBackend } from "./encoder-backend";
import { trackHasAudioItems } from "../timeline/timeline-items";

type MediaBunnyModule = typeof import("mediabunny");
type AudioBufferSourceInstance = InstanceType<MediaBunnyModule["AudioBufferSource"]>;
type VideoSampleSourceInstance = InstanceType<MediaBunnyModule["VideoSampleSource"]>;
type OutputInstance = InstanceType<MediaBunnyModule["Output"]>;
type HardwarePreference = "prefer-hardware" | "prefer-software" | "no-preference";
type VideoCodecName = Parameters<
  MediaBunnyModule["getFirstEncodableVideoCodec"]
>[0][number];

export interface WebCodecsBackendOptions {
  hardwareAcceleration?: HardwarePreference;
  videoCodecs?: VideoCodecName[];
  // The resolution clamp (export-engine) exists to bound browser-tab memory.
  // On desktop, frames stream to disk one at a time and the hardware encoder
  // handles high resolutions, so callers can opt out to export at full size.
  clampResolution?: boolean;
}

export class WebCodecsBackend implements EncoderBackend {
  readonly requiresWebCodecsClamping: boolean;
  readonly needsFrameThrottling = true;
  readonly normalizesProResToH264 = true;
  readonly audioBeforeVideo = true;

  private readonly mediabunny: MediaBunnyModule;
  private readonly hardwareAcceleration: HardwarePreference;
  private readonly videoCodecPreference?: VideoCodecName[];
  private output: OutputInstance | null = null;
  private videoSource: VideoSampleSourceInstance | null = null;
  private audioSource: AudioBufferSourceInstance | null = null;
  private writableStream: FileSystemWritableFileStream | null = null;
  private bytesWritten = 0;
  private aborted = false;
  private diagnostics = {
    videoAdds: 0,
    audioAdds: 0,
    writerOps: 0,
    pendingWriterOps: 0,
    lastWriterOpMs: 0,
    codec: null as string | null,
    hardwareAcceleration: null as string | null,
  };

  private throwIfAborted(): void {
    if (this.aborted) throw new DOMException("Export cancelled", "AbortError");
  }

  constructor(mediabunny: MediaBunnyModule, options?: WebCodecsBackendOptions) {
    this.mediabunny = mediabunny;
    this.hardwareAcceleration = options?.hardwareAcceleration ?? "prefer-hardware";
    this.videoCodecPreference = options?.videoCodecs;
    this.requiresWebCodecsClamping = options?.clampResolution ?? true;
  }

  getBytesWritten(): number {
    return this.bytesWritten;
  }

  getDiagnostics(): Record<string, unknown> {
    return { ...this.diagnostics, bytesWritten: this.bytesWritten };
  }

  /**
   * Report (non-fatally) when a pipeline step has been pending for too long.
   * The 120s watchdog still governs the failure; this log exists so a stalled
   * export tells us whether the encoder or the file writer is the choke point
   * (deterministic hangs have reproduced identically on hardware and
   * software encoders).
   */
  private instrumentStall(label: string, run: () => Promise<void>, thresholdMs = 20_000): Promise<void> {
    const startedAt = performance.now();
    const pending = run();
    const timer = setTimeout(() => {
      console.error(
        `[KOVE Export] ${label} has been pending for ${Math.round((performance.now() - startedAt) / 1000)}s — ` +
        `pipeline diagnostics: ${JSON.stringify(this.getDiagnostics())}`,
      );
    }, thresholdMs);
    void pending.catch(() => undefined).finally(() => clearTimeout(timer));
    return pending;
  }

  async start(
    settings: VideoExportSettings,
    project: Project,
    writableStream?: FileSystemWritableFileStream,
  ): Promise<void> {
    if (!writableStream) {
      throw new Error("No writable stream provided. Export requires a file destination.");
    }

    const {
      Output,
      StreamTarget,
      Mp4OutputFormat,
      WebMOutputFormat,
      MovOutputFormat,
      VideoSampleSource,
      AudioBufferSource,
      getFirstEncodableVideoCodec,
      getFirstEncodableAudioCodec,
      QUALITY_MEDIUM,
    } = this.mediabunny;

    this.writableStream = writableStream;
    const diskWriter = writableStream;
    const self = this;
    const chunkWriter = new WritableStream<{ data: Uint8Array; position: number }>({
      async write(chunk) {
        self.diagnostics.pendingWriterOps += 1;
        const startedAt = performance.now();
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          stallTimer = setTimeout(() => {
            console.error(
              `[KOVE Export] file writer stalled — a write has been pending for ${Math.round((performance.now() - startedAt) / 1000)}s ` +
              `at position ${chunk.position}. Pipeline diagnostics: ${JSON.stringify(self.getDiagnostics())}`,
            );
          }, 10_000);
          await diskWriter.seek(chunk.position);
          await diskWriter.write(chunk.data as unknown as FileSystemWriteChunkType);
          self.bytesWritten += chunk.data.byteLength;
        } finally {
          self.diagnostics.pendingWriterOps -= 1;
          self.diagnostics.writerOps += 1;
          self.diagnostics.lastWriterOpMs = Math.round(performance.now() - startedAt);
          if (stallTimer) clearTimeout(stallTimer);
        }
      },
    });

    let outputFormat;
    switch (settings.format) {
      case "webm":
        outputFormat = new WebMOutputFormat();
        break;
      case "mov":
        outputFormat = new MovOutputFormat();
        break;
      case "mp4":
      default:
        outputFormat = new Mp4OutputFormat({ fastStart: "fragmented" });
        break;
    }

    const target = new StreamTarget(chunkWriter, {
      chunked: true,
      chunkSize: 4 * 1024 * 1024,
    });
    const output = new Output({ format: outputFormat, target });
    // Retain it as soon as it exists, including while codec selection/start is
    // pending, so cancellation can release resources during initialization.
    this.output = output;

    const supportedVideoCodecs = outputFormat.getSupportedVideoCodecs();
    const requestedVideoCodec = CODEC_MAP[settings.codec] as VideoCodecName | undefined;
    const requestedVideoCodecs =
      this.videoCodecPreference ?? (requestedVideoCodec ? [requestedVideoCodec] : []);
    const preferredVideoCodecs = requestedVideoCodecs.filter((codec) =>
      supportedVideoCodecs.includes(codec),
    );
    if (requestedVideoCodecs.length > 0 && preferredVideoCodecs.length === 0) {
      const error: ExportError = {
        code: "UNSUPPORTED_CODEC",
        message: `${settings.codec.toUpperCase()} cannot be stored in ${settings.format.toUpperCase()}. Choose a compatible codec and container.`,
        phase: "preparing",
        recoverable: false,
      };
      throw error;
    }
    // Do not silently encode a different codec than the one the user chose.
    // Hardware can still fall back to software for this same codec.
    const videoCodecCandidates = requestedVideoCodecs.length > 0
      ? preferredVideoCodecs
      : supportedVideoCodecs;
    const targetVideoBitrate = settings.bitrate ? settings.bitrate * 1000 : QUALITY_MEDIUM;
    const hardwarePreferences: HardwarePreference[] =
      this.hardwareAcceleration === "no-preference"
        ? ["no-preference"]
        : [this.hardwareAcceleration, "no-preference"];
    let selectedHardwareAcceleration: HardwarePreference = "no-preference";
    let videoCodec: VideoCodecName | null = null;

    for (const hardwareAcceleration of hardwarePreferences) {
      const encodeOptions = {
        width: settings.width,
        height: settings.height,
        bitrate: targetVideoBitrate,
        hardwareAcceleration,
      } as unknown as Parameters<typeof getFirstEncodableVideoCodec>[1];
      videoCodec = await getFirstEncodableVideoCodec(videoCodecCandidates, encodeOptions);
      this.throwIfAborted();
      if (videoCodec) {
        selectedHardwareAcceleration = hardwareAcceleration;
        break;
      }
    }

    if (!videoCodec) {
      const error: ExportError = {
        code: "UNSUPPORTED_CODEC",
        message: `This browser cannot encode ${settings.codec.toUpperCase()} video. Choose a supported codec or use the desktop app.`,
        phase: "preparing",
        recoverable: false,
      };
      throw error;
    }

    const videoSource = new VideoSampleSource({
      codec: videoCodec,
      bitrate: targetVideoBitrate,
      keyFrameInterval: settings.keyframeInterval / settings.frameRate,
      hardwareAcceleration: selectedHardwareAcceleration,
    });
    output.addVideoTrack(videoSource);
    this.diagnostics.codec = videoCodec;
    this.diagnostics.hardwareAcceleration = selectedHardwareAcceleration;

    // A still-image or fully muted timeline needs no audio encoder or empty
    // muxer track. Some browsers cannot encode AAC at all; that must not prevent
    // a perfectly valid silent video from being exported.
    const hasAudio = project.timeline.tracks.some(
      (track) => !track.muted && trackHasAudioItems(project, track.id),
    );
    let audioSource: AudioBufferSourceInstance | null = null;
    if (hasAudio) {
      const audioCodecResult = await this.findSupportedAudioCodec(
        outputFormat,
        settings.audioSettings,
        getFirstEncodableAudioCodec,
      );
      this.throwIfAborted();
      audioSource = new AudioBufferSource({
        codec: audioCodecResult.codec as "aac" | "opus" | "mp3",
        bitrate: audioCodecResult.bitrate,
      });
      output.addAudioTrack(audioSource);
    }
    output.setMetadataTags({ title: project.name, date: new Date() });

    this.throwIfAborted();
    await output.start();
    this.throwIfAborted();
    this.videoSource = videoSource;
    this.audioSource = audioSource;
  }

  async addAudioBuffer(buffer: AudioBuffer): Promise<void> {
    if (!this.audioSource) {
      throw new Error("Encoder backend not started");
    }
    this.diagnostics.audioAdds += 1;
    await this.instrumentStall(`audio buffer add #${this.diagnostics.audioAdds}`, () => this.audioSource!.add(buffer));
  }

  async closeAudio(): Promise<void> {
    this.audioSource?.close();
  }

  async addVideoFrame(
    frame: ImageBitmap,
    timestampSec: number,
    durationSec: number,
  ): Promise<void> {
    let videoSample: InstanceType<MediaBunnyModule["VideoSample"]> | null = null;
    try {
      if (!this.videoSource) throw new Error("Encoder backend not started");
      const { VideoSample } = this.mediabunny;
      videoSample = new VideoSample(frame, { timestamp: timestampSec, duration: durationSec });
      this.diagnostics.videoAdds += 1;
      await this.instrumentStall(
        `video sample add #${this.diagnostics.videoAdds}`,
        () => this.videoSource!.add(videoSample!),
      );
    } finally {
      videoSample?.close();
      frame.close();
    }
  }

  async finalize(): Promise<void> {
    this.videoSource?.close();
    await this.instrumentStall("muxer finalize", async () => {
      await this.output?.finalize();
      await this.writableStream?.close();
    });
  }

  async abort(): Promise<void> {
    this.aborted = true;
    // Cancel the muxer/encoders as well as the file. Either operation can fail
    // independently (or the output may not have started yet).
    await Promise.allSettled([
      Promise.resolve().then(() => this.output?.cancel()),
      Promise.resolve().then(() => this.writableStream?.abort()),
    ]);
  }

  private async findSupportedAudioCodec(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputFormat: { getSupportedAudioCodecs: () => any[] },
    audioSettings: AudioExportSettings,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getFirstEncodableAudioCodec: (codecs: any[]) => Promise<string | null>,
  ): Promise<{ codec: string; bitrate: number }> {
    const supportedCodecs = outputFormat.getSupportedAudioCodecs();
    const requestedBitrate = audioSettings.bitrate * 1000;

    const bitrateFallbacks = [requestedBitrate, 192000, 128000, 96000].filter(
      (b, i, arr) => arr.indexOf(b) === i,
    );

    for (const bitrate of bitrateFallbacks) {
      const codec = await getFirstEncodableAudioCodec(supportedCodecs);
      if (codec) {
        const isSupported = await this.isAudioConfigSupported(
          codec,
          bitrate,
          audioSettings.channels,
          audioSettings.sampleRate,
        );
        if (isSupported) {
          return { codec, bitrate };
        }
      }
    }

    for (const fallbackCodec of ["aac", "mp3", "opus"]) {
      if (
        supportedCodecs.some((c: string) =>
          String(c).toLowerCase().includes(fallbackCodec) ||
          (fallbackCodec === "aac" && String(c).toLowerCase().includes("mp4a")),
        )
      ) {
        for (const bitrate of bitrateFallbacks) {
          const isSupported = await this.isAudioConfigSupported(
            fallbackCodec,
            bitrate,
            audioSettings.channels,
            audioSettings.sampleRate,
          );
          if (isSupported) {
            return { codec: fallbackCodec, bitrate };
          }
        }
      }
    }

    throw new Error(
      "No supported audio encoder is available for this export format. Try another format or browser.",
    );
  }

  private async isAudioConfigSupported(
    codec: string,
    bitrate: number,
    channels: number,
    sampleRate: number,
  ): Promise<boolean> {
    if (typeof AudioEncoder === "undefined") {
      return true;
    }

    try {
      let codecString: string;
      if (codec === "aac" || codec.includes("mp4a")) {
        codecString = "mp4a.40.2";
      } else if (codec === "opus") {
        codecString = "opus";
      } else if (codec === "mp3") {
        codecString = "mp3";
      } else {
        codecString = codec;
      }

      const config: AudioEncoderConfig = {
        codec: codecString,
        sampleRate,
        numberOfChannels: channels,
        bitrate,
      };

      const support = await AudioEncoder.isConfigSupported(config);
      return support.supported === true;
    } catch {
      return false;
    }
  }
}
