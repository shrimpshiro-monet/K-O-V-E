import { spawn } from "node:child_process";
import { resolveFfmpegPath } from "./ffmpeg-path";

export function buildSceneDetectionArgs(
  srcPath: string,
  threshold: number,
  window?: { startTimeSeconds: number; durationSeconds: number },
): string[] {
  const sceneExpression = window
    ? `between(t,${window.startTimeSeconds},${window.startTimeSeconds + window.durationSeconds})*gt(scene,${threshold})`
    : `gt(scene,${threshold})`;
  return [
    "-hide_banner",
    "-loglevel", "info",
    "-copyts",
    ...(window ? ["-ss", String(window.startTimeSeconds)] : []),
    "-i", srcPath,
    ...(window
      ? ["-to", String(window.startTimeSeconds + window.durationSeconds)]
      : []),
    "-vf", `select='${sceneExpression}',showinfo`,
    "-an",
    "-f", "null",
    "-",
  ];
}

export function parseSceneDetectionTimes(stderr: string): number[] {
  const times = new Set<number>();
  for (const match of stderr.matchAll(/pts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)) {
    const time = Number(match[1]);
    if (Number.isFinite(time) && time >= 0) times.add(time);
  }
  return [...times].sort((a, b) => a - b).filter((time, index, sorted) =>
    index === 0 || time - sorted[index - 1]! > 1 / 120,
  );
}

export function detectSceneChanges(
  srcPath: string,
  threshold = 0.08,
  window?: { startTimeSeconds: number; durationSeconds: number },
): Promise<number[]> {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    return Promise.reject(new Error("Scene detection threshold must be greater than 0 and at most 1."));
  }
  if (
    window &&
    (!Number.isFinite(window.startTimeSeconds) || window.startTimeSeconds < 0 ||
      !Number.isFinite(window.durationSeconds) || window.durationSeconds <= 0)
  ) {
    return Promise.reject(new Error("Scene detection window must have a nonnegative start and positive duration."));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfmpegPath(), buildSceneDetectionArgs(srcPath, threshold, window), {
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-250_000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg scene detection exited with code ${code}: ${stderr.slice(-4_000)}`));
        return;
      }
      resolve(parseSceneDetectionTimes(stderr));
    });
  });
}
