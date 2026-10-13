#!/usr/bin/env node
/**
 * Regenerates every synthetic asset referenced by `projects.json`.
 *
 * The eval corpus is fully synthetic on purpose: a clean clone can rebuild
 * byte-comparable media with nothing but a system ffmpeg (see
 * packages/agent/src/eval/corpus.test.ts for the contract these files must
 * satisfy).
 *
 * Usage:  node evaluation-files/generate-assets.mjs
 * Needs:  ffmpeg + ffprobe on PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;

/**
 * One entry per corpus file. `filter` is any lavfi video source,
 * `toneHz` gives the clip a distinct, quiet audio bed (omit for silence).
 */
// Chaotic generators (mandelbrot/life) encode to noise-heavy multi-MB files,
// so the pool sticks to structured sources; `srcOpts` and `crf` keep the two
// cellauto clips distinct and the whole corpus a few MB.
const VIDEO_SPECS = [
  // --- source footage -------------------------------------------------------
  { out: "media/gameplay-a.mp4", filter: "testsrc2", seconds: 12, toneHz: 330, crf: 32 },
  { out: "media/gameplay-b.mp4", filter: "cellauto", seconds: 14, toneHz: 392, crf: 32 },
  { out: "media/cam-a.mp4", filter: "smptebars", seconds: 20, toneHz: 220 },
  { out: "media/cam-b.mp4", filter: "smptehdbars", seconds: 18, toneHz: 247 },
  { out: "media/screen-cap.mp4", filter: "yuvtestsrc", seconds: 16, toneHz: 294 },
  { out: "media/talking-head.mp4", filter: "pal75bars", seconds: 24, toneHz: 262 },
  { out: "media/keynote.mp4", filter: "rgbtestsrc", seconds: 20, toneHz: 208 },
  { out: "media/sprint.mp4", filter: "pal100bars", seconds: 15, toneHz: 440 },
  { out: "media/stream-cam.mp4", filter: "cellauto", srcOpts: "rule=30:random_seed=7", seconds: 12, toneHz: 349, crf: 33 },
  { out: "media/stream-game.mp4", filter: "testsrc", seconds: 14, toneHz: 415 },

  // --- reference reels (models must imitate, never cut from) ----------------
  { out: "reference/ref-highlight.mp4", filter: "testsrc2", seconds: 8, width: 480, height: 270 },
  { out: "reference/ref-documentary.mp4", filter: "smptebars", seconds: 8, width: 480, height: 270 },
];

/** Music beds: layered detuned sines so spectrograms differ meaningfully. */
const MUSIC_SPECS = [
  {
    out: "music/synth-loop.mp3",
    seconds: 30,
    expr:
      "sin(2*PI*220*t)+0.5*sin(2*PI*277.18*t)+0.3*sin(2*PI*329.63*t)|" +
      "sin(2*PI*220*t)+0.5*sin(2*PI*277.18*t)+0.3*sin(2*PI*329.63*t)",
  },
  {
    out: "music/piano-bed.mp3",
    seconds: 30,
    expr:
      "sin(2*PI*196*t)+0.4*sin(2*PI*246.94*t)+0.2*sin(2*PI*146.83*t)|" +
      "sin(2*PI*196*t)+0.4*sin(2*PI*246.94*t)+0.2*sin(2*PI*146.83*t)",
  },
];

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function ensureFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("ffmpeg and ffprobe must be on PATH to generate the corpus assets");
  }
}

// Only `size`/`rate` go into the source spec (every generator supports them);
// length is always the output-side `-t`, which old ffmpeg builds honour for
// infinite sources like cellauto/mandelbrot too.
function buildVideo({ out, filter, srcOpts, seconds, toneHz, width = WIDTH, height = HEIGHT, crf = 30 }) {
  const target = join(HERE, out);
  mkdirSync(dirname(target), { recursive: true });
  const video = `${filter}=size=${width}x${height}:rate=${FPS}${srcOpts ? `:${srcOpts}` : ""}`;
  const args = ["-f", "lavfi", "-i", video];
  if (toneHz) {
    args.push(
      "-f", "lavfi", "-i", `sine=frequency=${toneHz}:sample_rate=44100`,
      "-filter:a", "volume=0.2",
      "-c:a", "aac", "-b:a", "64k", "-ac", "1",
    );
  }
  args.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", String(crf),
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-t", String(seconds),
    target,
  );
  ffmpeg(args);
}

function buildMusic({ out, seconds, expr }) {
  const target = join(HERE, out);
  mkdirSync(dirname(target), { recursive: true });
  ffmpeg([
    "-f", "lavfi", "-i", `aevalsrc=exprs='${expr}':sample_rate=44100`,
    "-filter:a", "volume=0.5",
    "-c:a", "libmp3lame", "-b:a", "96k",
    "-t", String(seconds),
    target,
  ]);
}

function probe(target) {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", target],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  const duration = Number(parsed.format?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`generated asset has no duration: ${target}`);
  return Number(parsed.format?.size ?? 0);
}

ensureFfmpeg();
let totalBytes = 0;
const specs = [...VIDEO_SPECS, ...MUSIC_SPECS];
for (const spec of specs) {
  if (spec.expr) buildMusic(spec);
  else buildVideo(spec);
  const size = probe(join(HERE, spec.out));
  totalBytes += size;
  console.log(`${spec.out}  ${(size / 1024).toFixed(1)} KiB`);
}
console.log(`Generated ${specs.length} assets, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB total.`);
