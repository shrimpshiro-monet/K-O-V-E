import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import type { LabStats } from "@kove-advanced/core/color/reinhard-transfer";
import type { EditingHost } from "../../host";
import { applyEditDNA } from "./apply-editdna";
import { secondsToFrame } from "@kove-advanced/core/mirror/timebase";
import { rhythmSimilarity } from "@kove-advanced/core/rhythm/dtw";
/** The browser extracts the DNA before calling this tool. The host cannot read arbitrary local file bytes.
 * Scores only measured axes; no fake perceptual score or iterative render is reported. */
export async function mirrorReference1to1(host: EditingHost, profile: ReferenceProfile, userMediaIds: string[], targetStats?: LabStats[]) {
  const ids = await applyEditDNA(host, profile, userMediaIds, targetStats);
  const durations = ids.map((id) => host.getProject().timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.duration ?? 0);
  return { profile, projectId: host.getProject().id, shotItemIds: ids, rhythmScore: rhythmSimilarity(profile.rhythmCurve, durations.map((value) => secondsToFrame(value, profile.fps))), colorApplied: Boolean(targetStats?.some((stat, i) => stat && profile.shots[i]?.colorStats)) };
}
