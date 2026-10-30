import type { SegmentMap, TranscriptStatus, VideoSegmentMap } from "@kove-advanced/creation-schema";
import type { EditingHost, TranscriptWordEvidence } from "../host";

export const MONET_TRANSCRIPTION_MAX_DURATION_SECONDS = 120;
export const MONET_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_WORDS_PER_SEGMENT = 100;
const MAX_TRANSCRIPT_WORDS_PER_VIDEO = 600;
const MAX_TRANSCRIPT_WORDS_PER_RUN = 2_000;

export interface TranscriptEnrichmentResult {
  readonly segmentMap: SegmentMap;
  readonly warnings: readonly string[];
}

export async function enrichSegmentMapWithTranscripts(
  host: Pick<EditingHost, "transcribeMediaAudio">,
  segmentMap: SegmentMap,
  sourceVideoIds: readonly string[],
): Promise<TranscriptEnrichmentResult> {
  const warnings: string[] = [];
  const sourceIds = new Set(sourceVideoIds);
  const videos: VideoSegmentMap[] = [];
  let remainingRunWords = MAX_TRANSCRIPT_WORDS_PER_RUN;
  for (const video of segmentMap.videos) {
    if (!sourceIds.has(video.videoId)) {
      videos.push(video);
      continue;
    }

    if (remainingRunWords === 0) {
      const reason = `The ${MAX_TRANSCRIPT_WORDS_PER_RUN}-word transcript budget for this analysis was reached.`;
      warnings.push(`${video.videoId}: ${reason}`);
      videos.push({ ...video, transcriptStatus: { state: "skipped", reason } });
      continue;
    }

    if (!host.transcribeMediaAudio) {
      const reason = "This host does not support local audio transcription.";
      warnings.push(`${video.videoId}: ${reason}`);
      videos.push({ ...video, transcriptStatus: { state: "skipped", reason } satisfies TranscriptStatus });
      continue;
    }

    let result: Awaited<ReturnType<NonNullable<EditingHost["transcribeMediaAudio"]>>>;
    try {
      result = await host.transcribeMediaAudio(video.videoId, {
        maxDurationSeconds: MONET_TRANSCRIPTION_MAX_DURATION_SECONDS,
        timeoutMs: MONET_TRANSCRIPTION_TIMEOUT_MS,
      });
    } catch (error) {
      const reason = `Local transcription failed: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(`${video.videoId}: ${reason}`);
      videos.push({ ...video, transcriptStatus: { state: "skipped", reason } satisfies TranscriptStatus });
      continue;
    }

    if (result.status === "skipped") {
      warnings.push(`${video.videoId}: ${result.reason}`);
      videos.push({ ...video, transcriptStatus: { state: "skipped", reason: result.reason } satisfies TranscriptStatus });
      continue;
    }

    const validWords = result.words.filter(isValidWord).sort((a, b) => a.startTime - b.startTime);
    const malformedWords = result.words.length - validWords.length;
    const includedWords = validWords.slice(0, Math.min(MAX_TRANSCRIPT_WORDS_PER_VIDEO, remainingRunWords));
    const budgetDroppedWords = validWords.length - includedWords.length;
    remainingRunWords -= includedWords.length;
    const uncoveredWords = includedWords.filter((word) =>
      !video.segments.some((segment) => word.endTime > segment.startTime && word.startTime < segment.endTime),
    ).length;
    let truncatedWords = 0;
    const segments = video.segments.map((segment) => {
      const words = includedWords
        .filter((word) => word.endTime > segment.startTime && word.startTime < segment.endTime)
        .map((word) => ({
          startTime: Math.max(segment.startTime, word.startTime),
          endTime: Math.min(segment.endTime, word.endTime),
          text: word.text.trim(),
        }))
        .filter((word) => word.text.length > 0 && word.endTime > word.startTime)
        .sort((a, b) => a.startTime - b.startTime);

      if (words.length > MAX_TRANSCRIPT_WORDS_PER_SEGMENT) {
        truncatedWords += words.length - MAX_TRANSCRIPT_WORDS_PER_SEGMENT;
      }
      return {
        ...segment,
        transcript: words.slice(0, MAX_TRANSCRIPT_WORDS_PER_SEGMENT),
      };
    });
    const warningParts = [
      result.warning ?? "",
      malformedWords > 0 ? `${malformedWords} malformed transcript word(s) were omitted` : "",
      budgetDroppedWords > 0 ? `${budgetDroppedWords} word(s) were omitted by the transcript context budget` : "",
      uncoveredWords > 0 ? `${uncoveredWords} word(s) fell outside analyzed segment ranges` : "",
      truncatedWords > 0 ? `${truncatedWords} word(s) were omitted by the per-segment prompt budget` : "",
    ].filter(Boolean);
    const warning = warningParts.length > 0 ? `${warningParts.join("; ")}.` : undefined;
    if (warning) warnings.push(`${video.videoId}: ${warning}`);
    const transcriptStatus: TranscriptStatus = {
      state: "complete",
      wordCount: includedWords.length,
      ...(warning && { warning }),
    };
    videos.push({ ...video, segments, transcriptStatus });
  }

  return { segmentMap: { videos }, warnings };
}

function isValidWord(word: TranscriptWordEvidence): boolean {
  return typeof word.text === "string" &&
    word.text.trim().length > 0 &&
    Number.isFinite(word.startTime) &&
    Number.isFinite(word.endTime) &&
    word.startTime >= 0 &&
    word.endTime > word.startTime;
}
