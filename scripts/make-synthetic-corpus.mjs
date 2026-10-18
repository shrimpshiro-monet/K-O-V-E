#!/usr/bin/env node
/**
 * Generates the SYNTHETIC evaluation corpus under evaluation-files/.
 *
 * Every asset produced here is algorithmic (ffmpeg color/testsrc/sine) and is
 * labeled "SYNTHETIC TEST FOOTAGE" both in the frame (drawtext) and in
 * projects.json (notes + "synthetic": true per-asset is impossible in the
 * corpus schema, so the top-level notes carry the flag). These clips exist so
 * the pipeline (ffprobe metadata, frame sampling, scene-boundary detection,
 * plan_edit end-to-end with a mock LLM) can run without real footage or
 * third-party content. They say NOTHING about edit quality.
 *
 * The owner's real corpus (9 projects, real media) replaces this in live runs:
 * put projects.json + media in a local directory and pass it to
 * `pnpm eval:live --media <dir>` (see evaluation-files/README.md).
 *
 * Usage: pnpm eval:media:synthetic
 *   env KOVE_FFMPEG=/path/to/ffmpeg (default: "ffmpeg" on PATH)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
const OUT = path.resolve(REPO_ROOT, "evaluation-files");
const MEDIA = path.join(OUT, "media");
const TMP = path.join(OUT, ".synthetic-tmp");

const FFMPEG = process.env.KOVE_FFMPEG || "ffmpeg";
const W = 320;
const H = 180;
const FPS = 10;

function run(args) {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { stdio: "pipe" });
}

/** Render one scene part: { kind: "color"|"testsrc"|"smptebars", color, seconds }. */
function renderPart(part, file) {
  const source =
    part.kind === "testsrc"
      ? `testsrc=d=${part.seconds}:s=${W}x${H}:r=${FPS}`
      : part.kind === "smptebars"
        ? `smptehdbars=d=${part.seconds}:s=${W}x${H}:r=${FPS}`
        : `color=c=${part.color}:d=${part.seconds}:s=${W}x${H}:r=${FPS}`;
  // The red border is the in-frame synthetic marker (this ffmpeg build has no
  // drawtext). W/H above are the inner content size.
  run([
    "-f", "lavfi", "-i", source,
    "-vf", `pad=iw+16:ih+16:8:8:color=red`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", "-y", file,
  ]);
}

/**
 * Assemble a clip from scene parts. audioFreq, when set, adds a sine-wave
 * audio track (placeholder for dialogue/ambience — labeled synthetic).
 */
function makeClip(file, parts, audioFreq) {
  const partFiles = parts.map((part, i) => {
    const partFile = path.join(TMP, `${path.basename(file, ".mp4")}-${i}.mp4`);
    renderPart(part, partFile);
    return partFile;
  });
  const listFile = path.join(TMP, `${path.basename(file, ".mp4")}-list.txt`);
  writeFileSync(listFile, partFiles.map((p) => `file '${p}'`).join("\n") + "\n");
  const videoOnly = path.join(TMP, `${path.basename(file, ".mp4")}-vonly.mp4`);
  run(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-y", videoOnly]);

  if (audioFreq) {
    const duration = parts.reduce((sum, part) => sum + part.seconds, 0);
    run([
      "-i", videoOnly,
      "-f", "lavfi", "-i", `sine=frequency=${audioFreq}:duration=${duration}`,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", "-y", file,
    ]);
  } else {
    run(["-i", videoOnly, "-c", "copy", "-y", file]);
  }
}

const clipSpecs = [
  // game-01: source with clear scene cuts + audio; separate "reference" clip
  { file: "game-01-source.mp4", audioFreq: 660, parts: [
    { kind: "color", color: "red", seconds: 2.5 },
    { kind: "testsrc", seconds: 2.5 },
    { kind: "color", color: "lime", seconds: 2.5 },
    { kind: "smptebars", seconds: 2.5 },
  ]},
  { file: "game-01-reference.mp4", parts: [
    { kind: "color", color: "red", seconds: 1.5 },
    { kind: "color", color: "blue", seconds: 1.5 },
    { kind: "testsrc", seconds: 1.5 },
    { kind: "color", color: "yellow", seconds: 1.5 },
    { kind: "color", color: "black", seconds: 1.5 },
    { kind: "smptebars", seconds: 1.5 },
  ]},
  { file: "game-02-source.mp4", parts: [
    { kind: "testsrc", seconds: 5 },
    { kind: "color", color: "orange", seconds: 5 },
  ]},
  // sport-01: fast cuts (1s each), no audio
  { file: "sport-01-source.mp4", parts: Array.from({ length: 6 }, (_, i) => ({
    kind: i % 2 === 0 ? "testsrc" : "color",
    color: ["white", "black", "cyan", "magenta", "yellow", "red"][i],
    seconds: 1,
  }))},
  // sport-02: two "angle" clips
  { file: "sport-02-a.mp4", parts: [
    { kind: "color", color: "cyan", seconds: 2 },
    { kind: "testsrc", seconds: 2 },
    { kind: "color", color: "black", seconds: 2 },
  ]},
  { file: "sport-02-b.mp4", parts: [
    { kind: "color", color: "magenta", seconds: 2 },
    { kind: "smptebars", seconds: 2 },
    { kind: "color", color: "white", seconds: 2 },
  ]},
  // stream-01: one long scene + audio (talking placeholder)
  { file: "stream-01-source.mp4", audioFreq: 220, parts: [
    { kind: "testsrc", seconds: 12 },
  ]},
  // speech / podcast: long scenes + audio (speech placeholder tones)
  { file: "speech-01-source.mp4", audioFreq: 330, parts: [
    { kind: "color", color: "white", seconds: 6 },
    { kind: "testsrc", seconds: 6 },
  ]},
  { file: "pod-02-source.mp4", audioFreq: 180, parts: [
    { kind: "testsrc", seconds: 12 },
  ]},
  // multi-03: two sources + music bed + reference (4 assets total)
  { file: "multi-03-a.mp4", parts: [
    { kind: "color", color: "gold", seconds: 4 },
    { kind: "testsrc", seconds: 4 },
  ]},
  { file: "multi-03-b.mp4", parts: [
    { kind: "smptebars", seconds: 4 },
    { kind: "color", color: "darkslateblue", seconds: 4 },
  ]},
  { file: "multi-03-reference.mp4", parts: [
    { kind: "color", color: "red", seconds: 1.5 },
    { kind: "color", color: "green", seconds: 1.5 },
    { kind: "testsrc", seconds: 1.5 },
    { kind: "color", color: "blue", seconds: 1.5 },
  ]},
  // multi-04: two sources + shared music bed
  { file: "multi-04-a.mp4", parts: [{ kind: "testsrc", seconds: 8 }]},
  { file: "multi-04-b.mp4", parts: [{ kind: "color", color: "teal", seconds: 8 }]},
];

function makeMusicBed(file, seconds = 30) {
  // Two alternating tones give the (synthetic) bed a 1 Hz "beat" for
  // downstream beat-detection plumbing tests.
  run([
    "-f", "lavfi", "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-af", "tremolo=f=1:d=0.6,volume=0.6",
    "-ar", "44100", "-ac", "2", "-y", file,
  ]);
}

const CORPUS = [
  {
    id: "game-01",
    category: "game",
    media: ["media/game-01-source.mp4"],
    music: null,
    reference: "media/game-01-reference.mp4",
    notes: "SYNTHETIC. Gameplay placeholder: 4 hard-cut scenes (color/testsrc/bars) + sine audio. Reference clip is a synthetic stand-in for an owner-supplied human edit.",
    prompts: [
      { id: "game-01-detailed", type: "detailed", text: "Make a 15 second hype highlight, fast hard cuts on the action, punchy zoom punches on the biggest moments, bold title at the end, for YouTube Shorts. Keep the energy high and no slow parts." },
      { id: "game-01-vague", type: "vague", text: "make something cool with this" },
      { id: "game-01-genre", type: "genre", text: "edit this as a gaming montage" },
    ],
  },
  {
    id: "game-02",
    category: "game",
    media: ["media/game-02-source.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. Single take with one mid-take scene change, no audio.",
    prompts: [
      { id: "game-02-detailed", type: "detailed", text: "Cut a 10 second recap that keeps the first scene as the hook, speed ramp through the middle, and land on a freeze at the end with a short title card. Instagram, vertical." },
      { id: "game-02-vague", type: "vague", text: "shorten this" },
      { id: "game-02-genre", type: "genre", text: "turn it into a vlog clip" },
    ],
  },
  {
    id: "sport-01",
    category: "sport",
    media: ["media/sport-01-source.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. Six 1-second scene changes, no audio — fast-cut material for beat/shot-density plumbing.",
    prompts: [
      { id: "sport-01-detailed", type: "detailed", text: "Build a 12 second sports highlight with hard cuts every second, a slow-mo ramp on the biggest play, SFX on each impact, and a closing caption. TikTok vertical." },
      { id: "sport-01-vague", type: "vague", text: "highlight reel" },
      { id: "sport-01-genre", type: "genre", text: "make it a sports highlight edit" },
    ],
  },
  {
    id: "sport-02",
    category: "sport",
    media: ["media/sport-02-a.mp4", "media/sport-02-b.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. Two angles of the same synthetic event (different color blocks), no audio. Tests multi-source shot selection.",
    prompts: [
      { id: "sport-02-detailed", type: "detailed", text: "Alternate between the two angles every 2 seconds for a 10 second sports recap, crossfade only once at the halfway point, add a lower-third name tag and a final title. YouTube." },
      { id: "sport-02-vague", type: "vague", text: "use both clips" },
      { id: "sport-02-genre", type: "genre", text: "multicam recap style" },
    ],
  },
  {
    id: "stream-01",
    category: "stream",
    media: ["media/stream-01-source.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. One 12-second talking-head-style scene (testsrc + 220 Hz tone as speech placeholder).",
    prompts: [
      { id: "stream-01-detailed", type: "detailed", text: "Make a 15 second streaming highlight: open on the strongest moment, keep the speaker on screen for the middle with subtle push-ins, caption the key line, soft music under, outro tag. Twitch clips vertical." },
      { id: "stream-01-vague", type: "vague", text: "clip the best part" },
      { id: "stream-01-genre", type: "genre", text: "make it a vlog" },
    ],
  },
  {
    id: "speech-01",
    category: "speech",
    media: ["media/speech-01-source.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. Two 6-second scenes with a 330 Hz tone standing in for speech. Tests dialogue-span plumbing.",
    prompts: [
      { id: "speech-01-detailed", type: "detailed", text: "Cut a 30 second talking piece: keep both scenes in order, add lower-third captions for the first 8 seconds, gentle zooms, no flashy effects, and a plain end card. Documentary tone." },
      { id: "speech-01-vague", type: "vague", text: "make it shorter" },
      { id: "speech-01-genre", type: "genre", text: "documentary style" },
    ],
  },
  {
    id: "pod-02",
    category: "speech",
    media: ["media/pod-02-source.mp4"],
    music: null,
    reference: null,
    notes: "SYNTHETIC. Single 12-second scene with an 180 Hz tone (podcast speech placeholder).",
    prompts: [
      { id: "pod-02-detailed", type: "detailed", text: "Create a 15 second podcast teaser: hook with the loudest line, caption it, slow zoom in, end on a title card with the show name. Keep it calm." },
      { id: "pod-02-vague", type: "vague", text: "teaser" },
      { id: "pod-02-genre", type: "genre", text: "podcast clip style" },
    ],
  },
  {
    id: "multi-03",
    category: "multi",
    media: ["media/multi-03-a.mp4", "media/multi-03-b.mp4"],
    music: "media/music-bed.wav",
    reference: "media/multi-03-reference.mp4",
    notes: "SYNTHETIC. Two sources + synthetic music bed (440/330 Hz beat placeholder) + synthetic reference clip. Four assets: tests music + reference wiring.",
    prompts: [
      { id: "multi-03-detailed", type: "detailed", text: "Make a 20 second travel-style montage from both clips, matched to the music bed's beat, split-screen them once in the middle, 3 text callouts, and close with a title. Match the reference's pacing if it looks good." },
      { id: "multi-03-vague", type: "vague", text: "montage with the music" },
      { id: "multi-03-genre", type: "genre", text: "social travel reel" },
    ],
  },
  {
    id: "multi-04",
    category: "multi",
    media: ["media/multi-04-a.mp4", "media/multi-04-b.mp4"],
    music: "media/music-bed.wav",
    reference: null,
    notes: "SYNTHETIC. Two 8-second sources + shared music bed. Tests beat-aligned cutting with a music track and no reference.",
    prompts: [
      { id: "multi-04-detailed", type: "detailed", text: "Build a 16 second edit that cuts on the music bed's beats, alternates the two sources, one speed ramp at the midpoint, and a single bold end title. Vertical short." },
      { id: "multi-04-vague", type: "vague", text: "cut to the beat" },
      { id: "multi-04-genre", type: "genre", text: "music video style" },
    ],
  },
];

function main() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });

  for (const spec of clipSpecs) {
    makeClip(path.join(MEDIA, spec.file), spec.parts, spec.audioFreq);
    console.log(`[synthetic-corpus] ${spec.file}`);
  }
  makeMusicBed(path.join(MEDIA, "music-bed.wav"), 30);
  console.log("[synthetic-corpus] music-bed.wav");

  writeFileSync(path.join(OUT, "projects.json"), JSON.stringify(CORPUS, null, 2) + "\n");
  rmSync(TMP, { recursive: true, force: true });
  console.log(`[synthetic-corpus] wrote projects.json (${CORPUS.length} projects, ${CORPUS.reduce((n, p) => n + p.prompts.length, 0)} prompts)`);
  if (!existsSync(path.join(OUT, "INVENTORY.md"))) {
    console.log("[synthetic-corpus] INVENTORY.md not present — run the inventory step to (re)generate it.");
  }
}

main();
