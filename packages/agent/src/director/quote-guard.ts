/**
 * Quote-guard v1 — "stop inventing words".
 *
 * Edit v1 shipped captions that looked like verbatim quotes but were invented
 * by construction: single-source projects have no transcript, so any quoted
 * caption is fabricated speech. v1 scope is deliberately narrow — strip the
 * marks, keep the text, warn. Semantic verification (does this caption match
 * real speech?) arrives with ASR transcripts; this pass exists so nothing
 * quote-shaped reaches the timeline unverified.
 *
 * Standing rule 9: strip + warn, don't block. A stripped caption still ships.
 *
 * "Transcript available" is derived from the segment map itself: once ASR
 * fills `VideoSegment.transcript`, the guard automatically stands down for
 * those projects — no separate flag to remember to flip.
 */

import type { DirectorValidationIssue, EditPlan, SegmentMap, VideoSegment } from "@kove-advanced/creation-schema";

export const QUOTE_MARKS_STRIPPED_CODE = "quote_marks_stripped_unverified";

/**
 * Wrapped-quote detection: content whose first and last non-space characters
 * are a MATCHING quote pair. Straight and curly singles/doubles. An apostrophe
 * inside text ("don't") never matches because the opening char isn't a quote.
 */
const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "\u201c": "\u201d", // “ ”
  "'": "'",
  "\u2018": "\u2019", // ‘ ’
};

export function isWrappedInQuoteMarks(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0]!;
  const last = trimmed[trimmed.length - 1]!;
  return QUOTE_PAIRS[first] !== undefined && QUOTE_PAIRS[first] === last;
}

export function stripWrappedQuoteMarks(content: string): string {
  if (!isWrappedInQuoteMarks(content)) return content;
  return content.trim().slice(1, -1).trim();
}

/** True when ANY segment in the map carries transcript words. */
export function segmentMapHasTranscript(segmentMap: SegmentMap | undefined | null): boolean {
  const videos = Array.isArray(segmentMap?.videos) ? segmentMap!.videos : [];
  return videos.some((video) =>
    Array.isArray(video.segments)
      ? video.segments.some((segment: VideoSegment) => typeof segment.transcript === "string" && segment.transcript.trim().length > 0)
      : false,
  );
}

export interface QuoteGuardResult {
  /** The plan with quote marks stripped (same reference when untouched). */
  readonly plan: EditPlan;
  readonly warnings: readonly DirectorValidationIssue[];
}

/**
 * Strip wrapped quote marks from plan text content when no transcript source
 * backs the project. Returns one warning per stripped element, in the
 * DirectorValidationIssue shape validateEditPlan uses, so callers merge them
 * into the same warning channel.
 */
export function stripUnverifiedQuoteMarks(
  plan: EditPlan,
  options: { transcriptAvailable: boolean },
): QuoteGuardResult {
  if (options.transcriptAvailable || plan.textElements.length === 0) {
    return { plan, warnings: [] };
  }

  const warnings: DirectorValidationIssue[] = [];
  let changed = false;
  const textElements = plan.textElements.map((element, index) => {
    if (typeof element.content !== "string" || !isWrappedInQuoteMarks(element.content)) {
      return element;
    }
    changed = true;
    const stripped = stripWrappedQuoteMarks(element.content);
    warnings.push({
      code: QUOTE_MARKS_STRIPPED_CODE,
      severity: "warning",
      path: `textElements[${index}].content`,
      message:
        `Quote marks removed from caption "${element.content.slice(0, 60)}" — this project has no transcript, ` +
        `so quoted speech cannot be verified as real. Declarative caption kept: "${stripped.slice(0, 60)}".`,
    });
    return { ...element, content: stripped };
  });

  return { plan: changed ? { ...plan, textElements } : plan, warnings };
}
