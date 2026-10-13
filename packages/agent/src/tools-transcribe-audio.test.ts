import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@kove-advanced/core/types/project";
import type { AudioSamples, EditingHost } from "./host";
import { executeTool } from "./executor";
import { encodeMonoWavBase64, engineBaseUrl } from "./tools-audio-analysis";
import { HeadlessHost } from "./headless-host";
import { MockLLMClient, type LLMClient } from "./llm";

// ---------------------------------------------------------------------------
// Harness: a host that can decode audio, a scripted engine behind a mocked
// fetch, and a project with one video media item carrying audio.
// ---------------------------------------------------------------------------

function makeProject(): Project {
  return {
    id: "transcribe-project",
    name: "Transcribe",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: { duration: 0, tracks: [], subtitles: [], markers: [] },
    mediaLibrary: {
      items: [{ id: "video-1", name: "speech.mp4", type: "video", metadata: { duration: 10 } }],
    },
  } as unknown as Project;
}

function makeHost(project: Project, samples: AudioSamples | null): EditingHost {
  const host = {
    requireOpenProject: () => undefined,
    getProject: () => project,
    features: () => ({}),
    loadAudioSamples: vi.fn(async () => samples),
  } as unknown as EditingHost & { loadAudioSamples: ReturnType<typeof vi.fn> };
  return host;
}

const COMPLETED_RESULT = {
  videoPath: "upload",
  start: 0,
  duration: 4,
  language: "en",
  model: "small",
  diarized: false,
  segments: [
    { start: 0, end: 1.5, text: "we went for it", speaker: null, words: [{ word: "we", start: 0, end: 0.3 }, { word: "went", start: 0.4, end: 1.5 }] },
    { start: 2, end: 3.5, text: "then we rested", speaker: null, words: [{ word: "then", start: 2, end: 3.5 }] },
  ],
  pauses: [{ start: 1.5, end: 2 }],
  processingTimeMs: 5,
};

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(responses: Array<Record<string, unknown>>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let step = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = responses[Math.min(step, responses.length - 1)]!;
      step += 1;
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
  return { calls };
}

beforeEach(() => {
  vi.stubGlobal("__KOVE_ENGINE_URL__", "http://engine.test");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribe_audio tool", () => {
  it("posts the media's audio to the engine and returns word-timestamped segments", async () => {
    const samples: AudioSamples = {
      channels: [new Float32Array(48000).fill(0.1), new Float32Array(48000).fill(0.1)],
      sampleRate: 48000,
    };
    const host = makeHost(makeProject(), samples);
    const { calls } = stubFetch([
      { jobId: "job-7", status: "pending" },
      { status: "completed", result: COMPLETED_RESULT },
    ]);

    const result = await executeTool("transcribe_audio", { mediaId: "video-1" }, host);
    expect(result.ok).toBe(true);

    const startCall = calls[0]!;
    expect(startCall.url).toBe("http://engine.test/transcribe");
    const payload = JSON.parse(String(startCall.init?.body)) as { audio_data: string; sample_rate: number };
    expect(payload.sample_rate).toBe(48000);
    // base64 WAV: RIFF header then PCM
    const head = atob(payload.audio_data.slice(0, 8));
    expect(head.slice(0, 4)).toBe("RIFF");
    expect(host.loadAudioSamples).toHaveBeenCalledWith("video-1", 0);

    const data = result.data as {
      segments: { text: string; words: unknown[] }[];
      pauses: unknown[];
      transcripts: Record<string, { start: number; end: number; text: string }[]>;
      transcriptText: string;
    };
    expect(data.segments).toHaveLength(2);
    expect(data.pauses).toHaveLength(1);
    expect(data.transcriptText).toBe("we went for it then we rested");
    // Exactly the shape plan_edit's transcripts argument expects.
    expect(data.transcripts["video-1"]).toEqual([
      { start: 0, end: 1.5, text: "we went for it" },
      { start: 2, end: 3.5, text: "then we rested" },
    ]);
  });

  it("reports an honest failure when the engine cannot transcribe", async () => {
    const samples: AudioSamples = { channels: [new Float32Array(4800)], sampleRate: 48000 };
    const host = makeHost(makeProject(), samples);
    stubFetch([
      { jobId: "job-8", status: "pending" },
      { status: "failed", result: { error: "ModuleNotFoundError: faster_whisper" } },
    ]);

    const result = await executeTool("transcribe_audio", { mediaId: "video-1" }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TRANSCRIPTION_FAILED");
    expect(result.error?.message).toContain("faster_whisper");
  });

  it("fails fast when the engine is unreachable", async () => {
    const samples: AudioSamples = { channels: [new Float32Array(4800)], sampleRate: 48000 };
    const host = makeHost(makeProject(), samples);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection refused"); }));

    const result = await executeTool("transcribe_audio", { mediaId: "video-1" }, host);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ENGINE_UNREACHABLE");
  });

  it("rejects media without audio and unknown media ids", async () => {
    const host = makeHost(makeProject(), null);
    const noAudio = await executeTool("transcribe_audio", { mediaId: "video-1" }, host);
    expect(noAudio.ok).toBe(false);
    expect(noAudio.error?.code).toBe("NO_AUDIO");

    const unknown = await executeTool("transcribe_audio", { mediaId: "nope" }, makeHost(makeProject(), null));
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("NOT_FOUND");
  });
});

describe("plan_edit transcripts merge", () => {
  it("attaches transcript lines to the segments the director reads", async () => {
    const project = makeProject();
    const host = new HeadlessHost(project) as unknown as EditingHost & {
      llm: { client: LLMClient; provider: string };
    };
    // The director READ the words: capture the prompt that carried them.
    let sentPrompt = "";
    const inner = new MockLLMClient([
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{
          id: "call-1",
          name: "submit_edit_plan",
          input: {
            segments: [{
              sourceVideoId: "video_0",
              sourceStartTime: 0,
              sourceEndTime: 4,
              trackIndex: 0,
              targetPosition: 0,
              effects: [],
              cameraMoves: [{ move: "slow-push", intensity: 0.5 }],
              rationale: "hook",
            }],
            textElements: [
              { content: '"we went for it"', style: "caption", startTime: 0.5, duration: 2, rationale: "verbatim quote" },
            ],
            effects: [{ type: "brightness", params: { value: 5 }, targetSegmentIndex: 0, rationale: "lift" }],
            transitions: [],
            audioDecisions: [{ type: "silence", startTime: 0, duration: 4, rationale: "no source" }],
            metadata: { targetDuration: 4, targetPlatform: "social", genre: "test", pacing: "fast", rationale: "t" },
          },
        }],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ]);
    const countingClient: LLMClient = {
      async complete(input) {
        if (input?.system) sentPrompt = input.system;
        return inner.complete();
      },
    };
    host.llm = { client: countingClient, provider: "openai" };

    const result = await executeTool(
      "plan_edit",
      {
        prompt: "cut the highlight",
        segmentMap: {
          videos: [
            {
              videoId: "video-1",
              duration: 4,
              segments: [
                { id: "video-1-seg-0", startTime: 0, endTime: 2, description: "open", sceneType: "b-roll", motionLevel: "medium", hasDialogue: true, visualContent: "open", confidence: 0.9 },
                { id: "video-1-seg-1", startTime: 2, endTime: 4, description: "payoff", sceneType: "b-roll", motionLevel: "medium", hasDialogue: true, visualContent: "payoff", confidence: 0.9 },
              ],
            },
          ],
        },
        transcripts: {
          "video-1": [
            { start: 0, end: 1.9, text: "we went for it" },
            { start: 2, end: 3.9, text: "then we rested" },
          ],
        },
      },
      host,
    );

    expect(result.ok).toBe(true);
    // The director READ the words: transcript text is in the prompt footage graph…
    expect(sentPrompt).toContain('transcript: "we went for it"');
    expect(sentPrompt).toContain('transcript: "then we rested"');
    // …and the quote-guard STOOD DOWN (transcript available → marks kept).
    const data = result.data as { editPlan: { textElements: { content: string }[] }; validationWarnings: { code: string }[] };
    expect(data.editPlan.textElements[0]!.content).toBe('"we went for it"');
    expect(data.validationWarnings.map((w) => w.code)).not.toContain("quote_marks_stripped_unverified");
  });
});

describe("encodeMonoWavBase64", () => {
  it("produces a valid mono 16-bit PCM WAV header and mixdown", () => {
    const samples: AudioSamples = {
      channels: [new Float32Array([0.5, -0.5]), new Float32Array([1, -1])],
      sampleRate: 16000,
    };
    const base64 = encodeMonoWavBase64(samples.channels, 0, 2, samples.sampleRate);
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(40, true)).toBe(4); // 2 samples × 2 bytes
    // Mixdown of (0.5, 1) → ~0.75 → int16 ≈ 24576; (−0.5, −1) → −24576
    expect(view.getInt16(44, true)).toBeGreaterThan(24000);
    expect(view.getInt16(46, true)).toBeLessThan(-24000);
  });
});

describe("engineBaseUrl", () => {
  it("honors the injected URL then falls back to terminal A's default", () => {
    expect(engineBaseUrl()).toBe("http://engine.test");
    vi.stubGlobal("__KOVE_ENGINE_URL__", undefined as unknown as string);
    expect(engineBaseUrl()).toBe("http://localhost:8000");
  });
});
