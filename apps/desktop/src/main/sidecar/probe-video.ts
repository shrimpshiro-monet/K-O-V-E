import { spawn } from "node:child_process";
import path from "node:path";
import { resolveFfmpegPath } from "./ffmpeg-path";

import { parseVideoProbe, type VideoStreamMetadata } from "./probe-video-parser";

export function probeVideoStream(srcPath: string): Promise<VideoStreamMetadata> {
  const binary = path.join(path.dirname(resolveFfmpegPath()), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  return new Promise((resolve, reject) => {
    let output = "", error = "", settled = false;
    const finish = (result?: VideoStreamMetadata, failure?: Error) => {
      if (settled) return;
      settled = true;
      if (failure) reject(failure); else if (result) resolve(result);
    };
    const proc = spawn(binary, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,avg_frame_rate,r_frame_rate,duration,width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation", "-of", "json", srcPath], { windowsHide: true });
    const timer = setTimeout(() => { proc.kill(); finish(undefined, new Error("ffprobe timed out")); }, 15_000);
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1_000_000) { proc.kill(); finish(undefined, new Error("ffprobe output too large")); } });
    proc.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
    proc.on("error", (cause: Error) => { clearTimeout(timer); finish(undefined, cause); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) { finish(undefined, new Error(`ffprobe failed: ${error || code}`)); return; }
      try { finish(parseVideoProbe(output)); } catch (cause) { finish(undefined, cause as Error); }
    });
  });
}
