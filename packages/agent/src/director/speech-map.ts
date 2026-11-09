/**
 * Transcript-first ranking evidence.
 *
 * The 2026 best practice is that the model should read structure, not raw
 * pixels: for talk-driven edits the best moment may be audible, not visible.
 * This module distills word-timed TranscriptEvidence into a tiny speech map
 * that the moment-ranking pass reads BEFORE it looks at frames — hook
 * candidates, payoff lines and landing breaths with exact source windows.
 * It never returns raw filler-heavy text: lines are scored and capped.
 */
import type { SegmentMap, TranscriptEvidence, VideoSegment, VideoSegmentMap } from "@kove-advanced/creation-schema";

export type SpeechSpotlightRole = "hook" | "payoff" | "landing";

export interface SpeechSpotlight {
  readonly videoId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly quote: string;
  readonly role: SpeechSpotlightRole;
  /** One short evidence clause: pause span, audio energy, or a marker. */
  readonly why: string;
}

const HOOK_MARKERS = [
  "here's why",
  "im gonna",
  "i'm gonna",
  "watch this",
  "wait for",
  "wait till",
  "wait until",
  "hold on",
  "oh my",
  "get ready",
  "you won't believe",
  "check this",
  "look at this",
  "this is the",
];
const PAYOFF_MARKERS = [
  "best",
  "insane",
  "unbelievable",
  "crazy",
  "never seen",
  "everyone",
  "epic",
  "the real",
  "the trick",
  "the secret",
  "the whole",
  "absolutely",
  "actually",
];
const FILLERS = ["um", "uh", "you know", "i mean", "sort of", "kind of", "like"];

function scoreLine(quote: string): {
  hook: number;
  payoff: number;
  fillerPenalty: number;
  markers: string[];
} {
  const text = quote.toLowerCase();
  const hookMarkers =
    (text.includes("?") ? 2 : 0) +
    HOOK_MARKERS.filter((marker) => text.includes(marker)).length;
  const payoffMarkers = PAYOFF_MARKERS.filter((marker) => text.includes(marker));
  const words = text.split(/\s+/).filter(Boolean);
  const allCaps = words.filter((word) => /^[A-Z]{3,}[!.]?$/.test(word)).length;
  const fillers = words.filter((word) => FILLERS.includes(word)).length;
  const exclamations = (quote.match(/!/g) ?? []).length;
  return {
    hook: hookMarkers,
    payoff: payoffMarkers.length + exclamations * 1.5 + allCaps,
    fillerPenalty: fillers,
    markers: payoffMarkers,
  };
}

function padRange(line: TranscriptEvidence, video: VideoSegmentMap): { startTime: number; endTime: number } {
  const horizon = Number.isFinite(video.duration) ? video.duration : line.endTime;
  return {
    startTime: Math.max(0, line.startTime - 0.3),
    endTime: Math.max(line.startTime + 0.4, Math.min(horizon, line.endTime + 0.3)),
  };
}

function spotlight(line: TranscriptEvidence, role: SpeechSpotlightRole, markers: string[], video: VideoSegmentMap, trailingGapSeconds?: number): SpeechSpotlight {
  const range = padRange(line, video);
  let why: string;
  if (trailingGapSeconds !== undefined) {
    why = `goes quiet for ${trailingGapSeconds.toFixed(1)}s after it`;
  } else if (markers.length > 0) {
    why = `contains "${markers[markers.length - 1]!}"`;
  } else {
    why = role === "hook" ? "question addressed to the viewer" : "emphatic delivery";
  }
  return {
    videoId: video.videoId,
    ...range,
    quote: line.text.replace(/\s+/g, " ").trim(),
    role,
    why,
  };
}

/** Build the per-video speech spotlights that pre-arm the ranking pass. */
export function buildSpeechSpotlights(segmentMap: SegmentMap, maxPerVideo = 4): readonly SpeechSpotlight[] {
  const videos = Array.isArray(segmentMap?.videos) ? segmentMap.videos : [];
  const spotlights: SpeechSpotlight[] = [];

  for (const video of videos) {
    const lines: TranscriptEvidence[] = (
      video.segments ?? []
    ).flatMap(
      (segment: VideoSegment) => segment.transcript ?? [],
    );
    if (lines.length === 0) continue;

    const candidates: Array<{ line: TranscriptEvidence; role: SpeechSpotlightRole; order: number; whyPick: string; markers: string[]; gap?: number }> = [];

    lines.forEach((line, index) => {
      const scores = scoreLine(line.text);
      if (scores.fillerPenalty >= 2) return;

      // Landing: meaningful line that is followed by real silence (or is the
      // final line of the video).
      const next = lines[index + 1];
      const gap = next ? next.startTime - line.endTime : video.duration - line.endTime;
      if (gap >= 2.5) {
        candidates.push({
          line,
          role: "landing",
          order: index,
          whyPick: "landing",
          markers: [],
          gap,
        });
      }

      if (scores.hook > 0) {
        candidates.push({ line, role: "hook", order: index, whyPick: "hook", markers: [] });
      }
      if (scores.payoff > 0) {
        candidates.push({ line, role: "payoff", order: index, whyPick: "payoff", markers: scores.markers });
      }
    });

    // One candidate per (line, role), keep the earliest.
    const best = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const key = `${candidate.role}:${candidate.line.startTime}`;
      const existing = best.get(key);
      const better =
        !existing ||
        (existing.role === candidate.role &&
          meaningfulScore(candidate.markers) > meaningfulScore(existing.markers));
      if (better) best.set(key, candidate);
    }

    const ranked = [...best.values()].sort((a, b) => {
      // Landing gaps are the strongest editorial signal (nothing after it).
      const bias = (entry: (typeof candidates)[number]) =>
        entry.role === "landing" ? 10 : entry.role === "payoff"
          ? meaningfulScore(entry.markers) + 2
          : entry.role === "hook"
            ? 4
            : 0;
      return bias(b) - bias(a) || a.order - b.order;
    });

    const perRole = new Set<SpeechSpotlightRole>();
    for (const candidate of ranked) {
      if (spotlights.length >= maxPerVideo) break;
      if (perRole.has(candidate.role)) continue;
      perRole.add(candidate.role);
      spotlights.push(
        spotlight(
          candidate.line,
          candidate.role,
          candidate.markers,
          video,
          candidate.gap,
        ),
      );
    }
  }

  return spotlights;
}

function meaningfulScore(markers: readonly string[]): number {
  return markers.length;
}

/** Render the speech map as a compact prompt section, or "" when silent. */
export function formatSpeechMap(spotlights: readonly SpeechSpotlight[]): string {
  if (spotlights.length === 0) return "";
  return [
    "## Speech map (transcript-first evidence — read BEFORE ranking)",
    ...spotlights.map(
      (line) =>
        `- [${line.videoId} ${line.startTime.toFixed(2)}s-${line.endTime.toFixed(2)}s] "${line.quote}" — ${line.role}: ${line.why}`,
    ),
    "These lines are spoken AUDIO, ranked evidence with exact source windows — treat them as candidates the same way as motion/beat peaks on quiet footage. They are NOT copy for text elements: never quote speech on screen.",
  ].join("\n");
}
