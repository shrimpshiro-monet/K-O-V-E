import { measureLoudness } from "@kove-advanced/core/audio/loudness/meter";
import type { EditingHost } from "./host";
import type { RegisteredTool } from "./registry";
import type { JSONSchema, ToolResult } from "./types";

/**
 * Audio analysis tools. New-tool conventions: strict schema, errors carry
 * {code, message, suggestedFix}, results never contain fabricated numbers.
 */

const strictObject = (
  properties: Record<string, JSONSchema>,
  required: string[] = [],
): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

const fail = (code: string, message: string, suggestedFix: string): ToolResult => ({
  ok: false,
  summary: message,
  error: { code, message, suggestedFix },
});

const slice = (channel: ArrayLike<number>, from: number, to: number): ArrayLike<number> => {
  const c = channel as { subarray?: (a: number, b: number) => ArrayLike<number> };
  return typeof c.subarray === "function" ? c.subarray(from, to) : Array.prototype.slice.call(channel, from, to);
};

const round = (value: number | null, digits: number): number | null =>
  value === null ? null : Number(value.toFixed(digits));

export const AUDIO_ANALYSIS_TOOLS: RegisteredTool[] = [
  {
    name: "measure_loudness",
    domain: "audio",
    title: "Measure loudness",
    description:
      "Measure programme loudness of a clip's or media item's SOURCE audio per ITU-R BS.1770-4 / EBU R128: integrated LUFS (gated), loudness range (LU, EBU Tech 3342), momentary and short-term maxima, and 4x-oversampled true peak (dBTP). Measures the source before clip effects, faders and the timeline mix, and ignores clip speed/reverse. Pass exactly one of clipId or mediaId; optional startTime/endTime are source seconds. Pass targetLufs (e.g. -23 EBU R128, -14 streaming) to also get the gain needed. Values that cannot be measured (silence, under 0.4 s for integrated / 3 s for range) are null, never estimated. Check get_capabilities → host.analyzeAudio first.",
    inputSchema: strictObject(
      {
        clipId: { type: "string", description: "Measure the part of the source this clip uses (inPoint..outPoint)." },
        mediaId: { type: "string", description: "Measure this media item's audio." },
        startTime: { type: "number", minimum: 0, description: "Range start in source seconds." },
        endTime: { type: "number", minimum: 0, description: "Range end in source seconds (> startTime)." },
        audioTrackIndex: { type: "integer", minimum: 0, description: "Audio track within the file. Default 0." },
        targetLufs: { type: "number", minimum: -70, maximum: 0, description: "Optional target integrated loudness in LUFS." },
      },
      [],
    ),
    readOnly: true,
    destructive: false,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      const clipId = args.clipId as string | undefined;
      const mediaId = args.mediaId as string | undefined;
      if ((clipId === undefined) === (mediaId === undefined)) {
        return fail(
          "INVALID_PARAMS",
          "Pass exactly one of clipId or mediaId.",
          "Use clipId to measure what a clip uses, or mediaId to measure a whole media item.",
        );
      }
      if (host.features?.().analyzeAudio === false || typeof host.loadAudioSamples !== "function") {
        return fail(
          "UNSUPPORTED_HOST",
          "measure_loudness is not available on this host (no audio decoding).",
          "Do not retry. Check get_capabilities → host.analyzeAudio; use a host that can decode media audio.",
        );
      }

      const warnings: string[] = [];
      const project = host.getProject();
      let resolvedMediaId = mediaId;
      let start = args.startTime as number | undefined;
      let end = args.endTime as number | undefined;
      if (clipId !== undefined) {
        const clip = project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        if (!clip) {
          return fail("NOT_FOUND", `Clip not found: ${clipId}`, "Call get_timeline or list_clips for valid clip ids.");
        }
        resolvedMediaId = clip.mediaId;
        start ??= clip.inPoint;
        end ??= clip.outPoint;
        if ((clip.speed ?? 1) !== 1 || clip.reversed) {
          warnings.push("Clip speed/reverse are not applied: this is the loudness of the source audio between inPoint and outPoint.");
        }
      } else if (!project.mediaLibrary.items.some((m) => m.id === mediaId)) {
        return fail("NOT_FOUND", `Media not found: ${mediaId}`, "Call list_media for valid media ids.");
      }
      if (start !== undefined && end !== undefined && end <= start) {
        return fail("INVALID_PARAMS", "endTime must be greater than startTime.", "Both are source seconds; check the order.");
      }

      const audioTrackIndex = (args.audioTrackIndex as number | undefined) ?? 0;
      const samples = await host.loadAudioSamples(resolvedMediaId!, audioTrackIndex);
      if (!samples || samples.channels.length === 0) {
        return fail(
          "NO_AUDIO",
          `No decodable audio in media ${resolvedMediaId} (track ${audioTrackIndex}).`,
          audioTrackIndex === 0
            ? "The file may have no audio track. Check list_media, or try audioTrackIndex 1."
            : "Try audioTrackIndex 0.",
        );
      }

      const total = samples.channels[0]!.length;
      const from = Math.min(total, Math.max(0, Math.round((start ?? 0) * samples.sampleRate)));
      const to = Math.min(total, Math.max(from, Math.round((end ?? total / samples.sampleRate) * samples.sampleRate)));
      if (to - from <= 0) {
        return fail("INVALID_PARAMS", "The requested range contains no audio.", `The source is ${(total / samples.sampleRate).toFixed(2)} s long.`);
      }
      if (samples.channels.length > 6) warnings.push(`${samples.channels.length} channels: measured the first six (L R C LFE Ls Rs).`);
      const channels = samples.channels.slice(0, 6).map((c) => slice(c, from, to));
      const loudness = measureLoudness(channels as ArrayLike<number>[], samples.sampleRate);

      const targetLufs = args.targetLufs as number | undefined;
      let target: Record<string, number | boolean | null> | null = null;
      if (targetLufs !== undefined) {
        if (loudness.integratedLufs === null) {
          warnings.push("Integrated loudness is not measurable for this range, so no gain to target can be computed.");
        } else {
          const gain = targetLufs - loudness.integratedLufs;
          const peakAfter = loudness.truePeakDbtp === null ? null : loudness.truePeakDbtp + gain;
          target = {
            targetLufs,
            gainToTargetDb: round(gain, 2),
            truePeakAfterGainDbtp: round(peakAfter, 2),
            // -1 dBTP is the EBU R128 permitted maximum true-peak level.
            exceedsMinus1Dbtp: peakAfter !== null && peakAfter > -1,
          };
        }
      }

      const fmt = (v: number | null, unit: string) => (v === null ? "n/a" : `${v.toFixed(1)} ${unit}`);
      const result: ToolResult = {
        ok: true,
        summary: `Loudness ${fmt(loudness.integratedLufs, "LUFS")}, LRA ${fmt(loudness.loudnessRangeLu, "LU")}, true peak ${fmt(loudness.truePeakDbtp, "dBTP")}`,
        data: {
          source: {
            kind: clipId !== undefined ? "clip" : "media",
            clipId: clipId ?? null,
            mediaId: resolvedMediaId,
            audioTrackIndex,
            startTime: from / samples.sampleRate,
            endTime: to / samples.sampleRate,
            scope: "source audio, before clip effects, faders and the timeline mix",
          },
          loudness,
          target,
        },
      };
      return warnings.length > 0 ? { ...result, warnings } : result;
    },
  },
  {
    name: "transcribe_audio",
    domain: "audio",
    title: "Transcribe media audio (ASR)",
    description:
      "Transcribe a media item's SOURCE audio with local faster-whisper (word timestamps) via the python analysis engine, and get its VAD pauses for the same window. This is how single-source projects get the words multicam projects read from their Whisper artifact: the returned segments ride into plan_edit as `transcripts` (mediaId → [{start, end, text}]) so quotes, chapters and captions ground in real speech. Requires the local engine on the analysis host (default http://localhost:8000, override KOVE_ENGINE_URL) with the optional `asr` extra installed (`pip install -e \".[asr]\"`); the whisper model downloads on first use. Pass exactly one of clipId or mediaId.",
    inputSchema: strictObject(
      {
        clipId: { type: "string", description: "Transcribe the part of the source this clip uses (inPoint..outPoint)." },
        mediaId: { type: "string", description: "Transcribe this media item's audio." },
        startTime: { type: "number", minimum: 0, description: "Range start in source seconds." },
        endTime: { type: "number", minimum: 0, description: "Range end in source seconds (> startTime)." },
        audioTrackIndex: { type: "integer", minimum: 0, description: "Audio track within the file. Default 0." },
        model: { type: "string", description: "Whisper model size override (tiny/base/small/medium/large-v3). Default $KOVE_WHISPER_MODEL (small)." },
      },
      [],
    ),
    readOnly: true,
    destructive: false,
    expensive: true,
    strict: true,
    handler: async (args, host: EditingHost): Promise<ToolResult> => {
      host.requireOpenProject();
      const clipId = args.clipId as string | undefined;
      const mediaId = args.mediaId as string | undefined;
      if ((clipId === undefined) === (mediaId === undefined)) {
        return fail(
          "INVALID_PARAMS",
          "Pass exactly one of clipId or mediaId.",
          "Use clipId to transcribe what a clip uses, or mediaId to transcribe a whole media item.",
        );
      }
      if (host.features?.().analyzeAudio === false || typeof host.loadAudioSamples !== "function") {
        return fail(
          "UNSUPPORTED_HOST",
          "transcribe_audio is not available on this host (no audio decoding).",
          "Do not retry. Check get_capabilities → host.analyzeAudio.",
        );
      }

      const project = host.getProject();
      let resolvedMediaId = mediaId;
      let start = args.startTime as number | undefined;
      let end = args.endTime as number | undefined;
      if (clipId !== undefined) {
        const clip = project.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
        if (!clip) {
          return fail("NOT_FOUND", `Clip not found: ${clipId}`, "Call get_timeline or list_clips for valid clip ids.");
        }
        resolvedMediaId = clip.mediaId;
        start ??= clip.inPoint;
        end ??= clip.outPoint;
      } else if (!project.mediaLibrary.items.some((m) => m.id === mediaId)) {
        return fail("NOT_FOUND", `Media not found: ${mediaId}`, "Call list_media for valid media ids.");
      }
      if (start !== undefined && end !== undefined && end <= start) {
        return fail("INVALID_PARAMS", "endTime must be greater than startTime.", "Both are source seconds; check the order.");
      }

      const audioTrackIndex = (args.audioTrackIndex as number | undefined) ?? 0;
      const samples = await host.loadAudioSamples(resolvedMediaId!, audioTrackIndex);
      if (!samples || samples.channels.length === 0) {
        return fail(
          "NO_AUDIO",
          `No decodable audio in media ${resolvedMediaId} (track ${audioTrackIndex}).`,
          audioTrackIndex === 0
            ? "The file may have no audio track. Check list_media."
            : "Try audioTrackIndex 0.",
        );
      }

      const total = samples.channels[0]!.length;
      const from = Math.min(total, Math.max(0, Math.round((start ?? 0) * samples.sampleRate)));
      const to = Math.min(total, Math.max(from, Math.round((end ?? total / samples.sampleRate) * samples.sampleRate)));
      if (to - from <= 0) {
        return fail("INVALID_PARAMS", "The requested range contains no audio.", `The source is ${(total / samples.sampleRate).toFixed(2)} s long.`);
      }

      // Mono mixdown of the requested range → 16-bit PCM WAV → base64.
      const wavBase64 = encodeMonoWavBase64(samples.channels, from, to, samples.sampleRate);
      if (wavBase64.length > MAX_UPLOAD_BASE64_CHARS) {
        return fail(
          "RANGE_TOO_LARGE",
          `Requested range encodes to ${(wavBase64.length / 1e6).toFixed(1)} MB, above the ${(MAX_UPLOAD_BASE64_CHARS / 1e6).toFixed(0)} MB engine upload limit.`,
          "Transcribe in smaller ranges (startTime/endTime), e.g. chapter by chapter.",
        );
      }

      const engineUrl = engineBaseUrl();
      let jobId: string;
      try {
        const startResponse = await fetch(`${engineUrl}/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            audio_data: wavBase64,
            sample_rate: samples.sampleRate,
            model: args.model as string | undefined,
          }),
        });
        const started = (await startResponse.json()) as { jobId?: string; error?: string };
        if (!startResponse.ok || !started.jobId) {
          return fail(
            "ENGINE_ERROR",
            `Engine /transcribe did not accept the job: ${started.error ?? startResponse.status}`,
            "Check that terminal A (python engine) is running and the engine venv has the asr extra: pip install -e \".[asr]\".",
          );
        }
        jobId = started.jobId;
      } catch (error) {
        return fail(
          "ENGINE_UNREACHABLE",
          `Could not reach the analysis engine at ${engineUrl}: ${error instanceof Error ? error.message : String(error)}`,
          "Start terminal A (uvicorn for the python engine) first; single-source ASR runs there, not in the browser.",
        );
      }

      const transcript = await pollTranscription(engineUrl, jobId);
      if (!transcript.ok) {
        return fail(transcript.code, transcript.error, transcript.suggestedFix ?? "Check the engine logs in terminal A.");
      }

      const result = transcript.result;
      const transcriptText = result.segments.map((segment) => segment.text).join(" ").trim();
      const toolResult: ToolResult = {
        ok: true,
        summary: `Transcribed ${result.segments.length} segment(s), ${result.wordsCount} word(s)${result.diarized ? ", diarized" : ""}, ${result.pauses.length} pause(s) — pass these segments into plan_edit as transcripts["${resolvedMediaId}"]`,
        data: {
          mediaId: resolvedMediaId,
          model: result.model,
          language: result.language,
          diarized: result.diarized,
          segments: result.segments,
          pauses: result.pauses,
          transcriptText,
          // Convenience for the director: exactly the shape plan_edit's
          // `transcripts` argument expects, keyed by this media id.
          transcripts: Object.fromEntries([
            [resolvedMediaId, result.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }))],
          ]),
        },
      };
      return toolResult;
    },
  },
];

/** Upload ceiling: ~100 MB of WAV ≈ 50 min of 48 kHz mono, base64-inflated 4/3. */
const MAX_UPLOAD_BASE64_CHARS = 100_000_000;

/** Engine base URL — same analysis host extract_segments' eco mode posts frames to. */
export function engineBaseUrl(): string {
  const injected = (globalThis as { __KOVE_ENGINE_URL__?: string }).__KOVE_ENGINE_URL__;
  if (injected) return injected;
  // Node (tests/CLI) honors the env override; the browser agent uses terminal
  // A's default port, matching the established localhost:8000 convention.
  const env = typeof process !== "undefined" ? process.env?.KOVE_ENGINE_URL : undefined;
  return env ?? "http://localhost:8000";
}

/** Mix channels to mono over [from,to), encode 16-bit PCM WAV, return base64. */
export function encodeMonoWavBase64(
  channels: readonly ArrayLike<number>[],
  from: number,
  to: number,
  sampleRate: number,
): string {
  const length = to - from;
  const mono = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) sum += channels[c]![from + i]!;
    const avg = sum / channels.length;
    mono[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
  }
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const dataSize = mono.length * 2;
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate: mono, 16-bit
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  const bytes = new Uint8Array(header.byteLength + dataSize);
  bytes.set(new Uint8Array(header), 0);
  bytes.set(new Uint8Array(mono.buffer), header.byteLength);
  return bytesToBase64(bytes);
}

/** Base64 in both runtimes: btoa in the browser, Buffer in Node tests. */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

interface EngineTranscribeSegment {
  start: number;
  end: number;
  text: string;
  words: { word: string; start: number; end: number }[];
  speaker: string | null;
}

interface EngineTranscription {
  model: string;
  language: string | null;
  diarized: boolean;
  segments: EngineTranscribeSegment[];
  pauses: { start: number; end: number }[];
  wordsCount?: number;
}

type PollOutcome =
  | { ok: true; result: EngineTranscription & { wordsCount: number } }
  | { ok: false; code: string; error: string; suggestedFix?: string };

const TRANSCRIBE_POLL_INTERVAL_MS = 1_500;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1_000; // CPU whisper of long clips is slow; the tool is async anyway.

async function pollTranscription(engineUrl: string, jobId: string): Promise<PollOutcome> {
  const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_POLL_INTERVAL_MS));
    let body: { status?: string; result?: { error?: string } & EngineTranscription };
    try {
      const response = await fetch(`${engineUrl}/jobs/${jobId}`);
      body = (await response.json()) as typeof body;
    } catch (error) {
      return { ok: false, code: "ENGINE_UNREACHABLE", error: `Lost the engine while polling job ${jobId}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (body.status === "completed" && body.result) {
      const { error: _error, ...result } = body.result;
      const wordsCount = result.segments.reduce((sum, segment) => sum + segment.words.length, 0);
      return { ok: true, result: { ...result, wordsCount } };
    }
    if (body.status === "failed") {
      return { ok: false, code: "TRANSCRIPTION_FAILED", error: body.result?.error ?? "transcription job failed" };
    }
    // pending/running: keep polling.
  }
  return { ok: false, code: "TRANSCRIPTION_TIMEOUT", error: `Transcription job ${jobId} did not finish in ${TRANSCRIBE_TIMEOUT_MS / 60000} minutes.`, suggestedFix: "Retry with a shorter range or a smaller model." };
}
