import type { MulticamTranscriptSegment } from "@kove-advanced/core";
import { audioBufferToWhisperSamples } from "../utils/whisper-audio";
import type { WhisperModelKey } from "../workers/whisper-models";

interface WorkerChunk {
  text: string;
  timestamp: [number | null, number | null];
}

export function whisperChunksToMulticamTranscript(
  chunks: readonly WorkerChunk[],
): MulticamTranscriptSegment[] {
  return chunks.flatMap((chunk) => {
    const text = chunk.text.trim();
    if (!text) return [];
    const start = Math.max(0, chunk.timestamp[0] ?? 0);
    const end = Math.max(start, chunk.timestamp[1] ?? start + 3);
    return [{ startMs: Math.round(start * 1_000), endMs: Math.round(end * 1_000), text }];
  });
}

export interface WhisperWord {
  text: string;
  start: number;
  end: number;
}

export function whisperChunksToWords(chunks: readonly WorkerChunk[]): WhisperWord[] {
  return chunks.flatMap((chunk) => {
    const text = chunk.text.trim();
    if (!text) return [];
    const start = Math.max(0, chunk.timestamp[0] ?? 0);
    const end = Math.max(start, chunk.timestamp[1] ?? start);
    return [{ text, start, end }];
  });
}

export async function transcribeWithWordTimestamps(
  buffer: AudioBuffer,
  options: {
    model?: WhisperModelKey;
    language?: string;
    onStatus?: (message: string) => void;
  } = {},
): Promise<WhisperWord[]> {
  const worker = new Worker(
    new URL("../workers/whisper-worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const requestId = crypto.randomUUID();
    const chunks = await new Promise<WorkerChunk[]>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.requestId !== requestId) return;
        const kind = event.data.type;
        if (kind === "model-progress") {
          const progress = Number(event.data.progress ?? 0);
          options.onStatus?.(
            `Loading local Whisper model · ${Math.round((progress > 1 ? progress / 100 : progress) * 100)}%`,
          );
        } else if (kind === "transcription-progress") {
          options.onStatus?.("Transcribing locally…");
        } else if (kind === "result") {
          worker.removeEventListener("message", handleMessage);
          resolve((event.data.chunks as WorkerChunk[] | undefined) ?? []);
        } else if (kind === "error") {
          worker.removeEventListener("message", handleMessage);
          reject(new Error(String(event.data.message ?? "Local transcription failed.")));
        }
      };
      worker.addEventListener("message", handleMessage);
      worker.postMessage({
        requestId,
        type: "transcribe",
        audio: audioBufferToWhisperSamples(buffer),
        model: options.model ?? "fast",
        language: options.language,
        timestamps: "word",
      });
    });
    return whisperChunksToWords(chunks);
  } finally {
    worker.terminate();
  }
}

/**
 * Transcribes pre-extracted samples (e.g. one clip's trimmed source region)
 * with word timestamps. Returned word times are relative to the START OF THE
 * SAMPLES — pass clip-region samples and the times line up with the
 * silence-removal cut space directly.
 */
export async function transcribeSamplesWithWordTimestamps(
  samples: Float32Array,
  options: {
    model?: WhisperModelKey;
    language?: string;
    onStatus?: (message: string) => void;
  } = {},
): Promise<WhisperWord[]> {
  if (samples.length === 0) return [];
  const worker = new Worker(
    new URL("../workers/whisper-worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const requestId = crypto.randomUUID();
    const chunks = await new Promise<WorkerChunk[]>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<Record<string, unknown>>) => {
        if (event.data.requestId !== requestId) return;
        const kind = event.data.type;
        if (kind === "model-progress") {
          const progress = Number(event.data.progress ?? 0);
          options.onStatus?.(
            `Loading local Whisper model · ${Math.round((progress > 1 ? progress / 100 : progress) * 100)}%`,
          );
        } else if (kind === "transcription-progress") {
          options.onStatus?.("Transcribing locally…");
        } else if (kind === "result") {
          worker.removeEventListener("message", handleMessage);
          resolve((event.data.chunks as WorkerChunk[] | undefined) ?? []);
        } else if (kind === "error") {
          worker.removeEventListener("message", handleMessage);
          reject(new Error(String(event.data.message ?? "Local transcription failed.")));
        }
      };
      worker.addEventListener("message", handleMessage);
      worker.postMessage({
        requestId,
        type: "transcribe",
        audio: samples,
        model: options.model ?? "fast",
        language: options.language,
        timestamps: "word",
      });
    });
    return whisperChunksToWords(chunks);
  } finally {
    worker.terminate();
  }
}

export async function transcribeMulticamChannels(
  buffers: ReadonlyMap<string, AudioBuffer>,
  options: {
    model?: WhisperModelKey;
    language?: string;
    onStatus?: (angleId: string, message: string) => void;
  } = {},
): Promise<Record<string, MulticamTranscriptSegment[]>> {
  const worker = new Worker(
    new URL("../workers/whisper-worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const transcripts: Record<string, MulticamTranscriptSegment[]> = {};
    for (const [angleId, buffer] of buffers) {
      const requestId = crypto.randomUUID();
      options.onStatus?.(angleId, "Loading local Whisper model…");
      const result = await new Promise<{ chunks: WorkerChunk[] }>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.requestId !== requestId) return;
          const type = event.data.type;
          if (type === "model-progress") {
            const progress = Number(event.data.progress ?? 0);
            options.onStatus?.(
              angleId,
              `Loading local Whisper model · ${Math.round((progress > 1 ? progress / 100 : progress) * 100)}%`,
            );
          } else if (type === "transcription-progress") {
            options.onStatus?.(angleId, "Transcribing locally…");
          } else if (type === "result") {
            worker.removeEventListener("message", handleMessage);
            resolve({ chunks: (event.data.chunks as WorkerChunk[] | undefined) ?? [] });
          } else if (type === "error") {
            worker.removeEventListener("message", handleMessage);
            reject(new Error(String(event.data.message ?? "Local transcription failed.")));
          }
        };
        worker.addEventListener("message", handleMessage);
        worker.postMessage({
          requestId,
          type: "transcribe",
          audio: audioBufferToWhisperSamples(buffer),
          model: options.model ?? "fast",
          language: options.language,
        });
      });
      transcripts[angleId] = whisperChunksToMulticamTranscript(result.chunks);
    }
    return transcripts;
  } finally {
    worker.terminate();
  }
}
