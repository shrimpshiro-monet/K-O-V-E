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
];
