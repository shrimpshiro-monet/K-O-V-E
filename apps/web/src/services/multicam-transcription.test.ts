import { describe, expect, it } from "vitest";
import {
  transcribeWithWordTimestamps,
  whisperChunksToMulticamTranscript,
  whisperChunksToWords,
} from "./multicam-transcription";

describe("multicam transcription", () => {
  it("normalizes Whisper timestamps and removes empty chunks", () => {
    expect(whisperChunksToMulticamTranscript([
      { text: " Hello ", timestamp: [0.25, 1.5] },
      { text: "  ", timestamp: [1.5, 2] },
      { text: "world", timestamp: [2, null] },
    ])).toEqual([
      { text: "Hello", startMs: 250, endMs: 1_500 },
      { text: "world", startMs: 2_000, endMs: 5_000 },
    ]);
  });

  it("maps word-granularity chunks to start/end seconds", () => {
    expect(whisperChunksToWords([
      { text: " Wasn't ", timestamp: [0.0, 0.7] },
      { text: " ", timestamp: [0.7, 0.7] },
      { text: "that", timestamp: [0.7, 1.02] },
    ])).toEqual([
      { text: "Wasn't", start: 0, end: 0.7 },
      { text: "that", start: 0.7, end: 1.02 },
    ]);
  });

  it("rejects and terminates the worker when the model never answers", async () => {
    const originalWorker = globalThis.Worker;
    let terminated = false;
    class SilentWorker {
      addEventListener(): void {}
      removeEventListener(): void {}
      postMessage(): void {}
      terminate(): void {
        terminated = true;
      }
    }
    globalThis.Worker = SilentWorker as unknown as typeof Worker;
    try {
      await expect(
        transcribeWithWordTimestamps({} as AudioBuffer, { timeoutMs: 20 }),
      ).rejects.toThrow(/timed out/i);
      expect(terminated).toBe(true);
    } finally {
      globalThis.Worker = originalWorker;
    }
  });
});
