/**
 * TEMP calibration — Anton cap height and line-middle offset at a known size.
 * Renders "H" twice (no stroke / with stroke) on a flat page, then measures the
 * ink bbox offline. Not part of any pass criteria.
 *
 * KOVE_TEST_B2_CAL=1 pnpm --filter @kove-advanced/agent-runner test:run \
 *   src/test-b2-calibrate.tmp.test.ts
 */
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import type { Project, MediaItem } from "@kove-advanced/core/types/project";
import type { TextClip } from "@kove-advanced/core/text/types";
import { createMirrorSnapshot, MirrorCompositor } from "./mirror-compositor";
import { createEmptyProject } from "./project-io";

const execFileAsync = promisify(execFile);
const WIDTH = 1024;
const HEIGHT = 576;
const FPS = 30;
const OUT = resolve("../../evaluation-files/test-b/general/cal");
const PAGE = resolve("../../evaluation-files/test-b/general/photos/page-C.png");
const RUN = process.env.KOVE_TEST_B2_CAL === "1";

function mediaItem(): MediaItem {
  return {
    id: "page",
    name: "page",
    type: "image",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 10, width: WIDTH, height: HEIGHT, frameRate: 0, codec: "png",
      sampleRate: 0, channels: 0, fileSize: 1, hasVideo: true, hasAudio: false,
      audioTrackCount: 0,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
}

function textClip(id: string, size: number, stroke: number): TextClip {
  return {
    id,
    trackId: "t-type",
    startTime: 0,
    duration: 0.5,
    text: "H",
    style: {
      fontFamily: "Anton",
      fontSize: size,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#000000",
      backgroundColor: "rgba(0,0,0,0)",
      strokeColor: "#000000",
      strokeWidth: stroke,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1,
      letterSpacing: 0,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  };
}

function build(size: number, stroke: number): Project {
  return {
    ...createEmptyProject(`cal ${size}/${stroke}`, { width: WIDTH, height: HEIGHT, frameRate: FPS }),
    mediaLibrary: { items: [mediaItem()] },
    timeline: {
      tracks: [
        { id: "t-type", type: "text", name: "Type", clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false },
        { id: "t-page", type: "video", name: "Page", clips: [{
          id: "page", mediaId: "page", trackId: "t-page", startTime: 0, duration: 0.5,
          inPoint: 0, outPoint: 0.5, effects: [], audioEffects: [],
          transform: {
            position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0,
            anchor: { x: 0.5, y: 0.5 }, opacity: 1, fitMode: "contain",
          },
          volume: 0, keyframes: [],
        }], transitions: [], locked: false, hidden: false, muted: false, solo: false },
      ],
      subtitles: [], duration: 0.5, markers: [],
    },
    textClips: [textClip("h", size, stroke)],
  };
}

describe.skipIf(!RUN)("Anton calibration", () => {
  it("renders H at 200px, no stroke / stroke 12", async () => {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    const compositor = new MirrorCompositor(process.env.CHROMIUM_EXECUTABLE_PATH);
    try {
      for (const [name, stroke] of [["plain", 0], ["stroke", 12]] as const) {
        const project = build(200, stroke);
        const snapshot = await createMirrorSnapshot(project, { page: PAGE });
        const mp4 = resolve(OUT, `${name}.mp4`);
        await compositor.exportVideo(snapshot, mp4, {
          format: "mp4", codec: "h264", width: WIDTH, height: HEIGHT, frameRate: FPS,
          bitrate: 20_000, bitrateMode: "vbr", quality: 98, keyframeInterval: 30,
          audioSettings: { format: "aac", sampleRate: 48000, bitDepth: 16, bitrate: 128, channels: 2 },
        });
        await execFileAsync("ffmpeg", [
          "-y", "-ss", "0.4", "-i", mp4, "-frames:v", "1", resolve(OUT, `${name}.png`), "-loglevel", "error",
        ]);
        console.log(`cal ${name}: ${mp4}`);
      }
    } finally {
      await compositor.close();
    }
  }, 300_000);
});
