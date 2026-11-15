import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import type { EditingHost } from "../../host";
import { applyEditDNA, compileReferenceText } from "./apply-editdna";
import { secondsToFrame } from "@kove-advanced/core/mirror/timebase";
import { rhythmSimilarity } from "@kove-advanced/core/rhythm/dtw";
/** The browser extracts the DNA before calling this tool. The host cannot read arbitrary local file bytes.
 * Scores only measured axes; no fake perceptual score or iterative render is reported. */
export async function mirrorReference1to1(host: EditingHost, profile: ReferenceProfile, userMediaIds: string[], targetStats?: LabStats[]) {
  const ids = await applyEditDNA(host, profile, userMediaIds, targetStats);
  const text = await compileReferenceText(host, profile);
  const durations = ids.map((id) => host.getProject().timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.duration ?? 0);
  const colorApplied = Boolean(targetStats?.some((stat, i) => stat && profile.shots[i]?.colorStats));
  const cameraShots = profile.shots.filter((shot) => (shot.cameraMotion?.samples.length ?? 0) > 0).length;
  const transitions = profile.styleEvidence?.transitions.length ?? 0;
  const textEvidence = (profile.styleEvidence?.textOverlays ?? []).filter((overlay) => Boolean(overlay.text?.trim())).length;
  const masking = profile.textMasking;
  const coverage = {
    measured: {
      shots: profile.shots.length,
      cuts: Math.max(0, profile.shots.length - 1),
      cameraShots,
      transitions,
      textEvidence,
      textCompiled: text.clipIds.length,
      color: colorApplied,
    },
    notAttempted: [
      "Layered scenes and simultaneous elements",
      "Font identification (family and weight are estimates)",
      "Semantic effect classification",
    ],
    watermarkMasking: masking?.applied ? "applied" : "unknown",
    ...(masking?.endCardTrimmedFrames !== undefined && { endCardTrimmedFrames: masking.endCardTrimmedFrames }),
    summary: `Measured ${profile.shots.length} shots (${Math.max(0, profile.shots.length - 1)} cuts), ${cameraShots} shots with camera motion, ${transitions} transitions and ${textEvidence} text windows; compiled ${text.clipIds.length} text clip(s)${colorApplied ? " with color grading" : ""}. Not attempted: layered scenes, font identification, semantic effect classification. Watermark masking ${masking?.applied ? "was applied" : "is unknown for this profile"}.`,
  };
  return { profile: withoutReferenceText(profile), projectId: host.getProject().id, shotItemIds: ids, rhythmScore: rhythmSimilarity(profile.rhythmCurve, durations.map((value) => secondsToFrame(value, profile.fps))), colorApplied, text, coverage };
}

function withoutReferenceText(profile: ReferenceProfile): ReferenceProfile {
  return {
    ...profile,
    shots: profile.shots.map((shot) => ({
      ...shot,
      captionWindows: shot.captionWindows.map(({ text: _text, ...window }) => window),
    })),
    ...(profile.styleEvidence && {
      styleEvidence: {
        ...profile.styleEvidence,
        textOverlays: profile.styleEvidence.textOverlays.map(({ text: _text, ...overlay }) => overlay),
      },
    }),
  };
}
