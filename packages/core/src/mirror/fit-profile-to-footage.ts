import type { ReferenceProfile, ShotProfile } from "./reference-profile";
import { validateReferenceProfile } from "./reference-profile";
import { frameRate } from "./timebase";

export interface FittedReference {
  readonly profile: ReferenceProfile;
  /** True when the structure had to be shortened to fit the footage. */
  readonly fitted: boolean;
  /** How many of the reference's shots did not fit. */
  readonly droppedShots: number;
}

/**
 * Fits a measured reference structure to the footage it will be rebuilt from.
 *
 * The reference's shot lengths are kept: the structure is cut where the
 * footage runs out and the last shot is trimmed to what is left. A shorter
 * edit of the reference's opening beats beats a rhythm stretched over footage
 * that was never long enough for it.
 */
export function fitProfileToFootage(
  profile: ReferenceProfile,
  availableSeconds: number,
): FittedReference {
  const fps = frameRate(profile.fps.num, profile.fps.den);
  const availableFrames = Math.floor((availableSeconds * fps.num) / fps.den);
  if (!Number.isFinite(availableFrames) || availableFrames <= 0) {
    throw new Error("There is no footage long enough to fit the reference to");
  }
  if (profile.durationFrames <= availableFrames) {
    return { profile, fitted: false, droppedShots: 0 };
  }

  const kept: ShotProfile[] = [];
  let used = 0;
  for (const shot of profile.shots) {
    const duration = shot.endFrame - shot.startFrame;
    if (used + duration > availableFrames) {
      const remaining = availableFrames - used;
      if (remaining > 0) {
        kept.push({ ...shot, endFrame: shot.startFrame + remaining });
      }
      break;
    }
    kept.push(shot);
    used += duration;
  }
  if (!kept.length) {
    throw new Error("There is no footage long enough to fit the reference to");
  }

  // Rebase the kept shots so they tile the new duration from frame zero.
  let cursor = 0;
  const shots = kept.map((shot) => {
    const duration = shot.endFrame - shot.startFrame;
    const startFrame = cursor;
    const endFrame = cursor + duration;
    cursor = endFrame;
    const shift = startFrame - shot.startFrame;
    return {
      ...shot,
      startFrame,
      endFrame,
      captionWindows: shot.captionWindows
        .filter((caption) => caption.startFrame >= shot.startFrame && caption.endFrame <= shot.endFrame)
        .map((caption) => ({
          ...caption,
          startFrame: caption.startFrame + shift,
          endFrame: caption.endFrame + shift,
        })),
      ...(shot.cameraMotion
        ? {
            cameraMotion: {
              ...shot.cameraMotion,
              samples: shot.cameraMotion.samples
                .filter((sample) => sample.frame >= shot.startFrame && sample.frame < shot.endFrame)
                .map((sample) => ({ ...sample, frame: sample.frame + shift })),
            },
          }
        : {}),
    } satisfies ShotProfile;
  });

  const durationFrames = shots.reduce((sum, shot) => sum + (shot.endFrame - shot.startFrame), 0);
  const fitted: ReferenceProfile = {
    ...profile,
    durationFrames,
    shots,
    rhythmCurve: shots.map((shot) => shot.endFrame - shot.startFrame),
    warnings: [
      ...(profile.warnings ?? []),
      `The reference is longer than the footage: the structure was fitted to ${(durationFrames * fps.den) / fps.num}s.`,
    ],
  };
  validateReferenceProfile(fitted);
  return { profile: fitted, fitted: true, droppedShots: profile.shots.length - shots.length };
}
