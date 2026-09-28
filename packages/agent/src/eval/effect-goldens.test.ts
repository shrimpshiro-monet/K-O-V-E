/**
 * Render goldens for the director's effect and transition palette.
 *
 * Every effect/transition id in the creation-schema registries (the exact sets
 * the director prompt may emit) is rendered through the real
 * `videoEngine.renderFrame` in a real headless Chrome, and compared against a
 * baseline frame rendered from the same timeline with no effect. An id whose
 * frame is indistinguishable from the baseline renders nothing and fails.
 *
 * Constraints honoured here:
 *  - no LLM, no network, no API keys (all assets are generated locally);
 *  - the existing render path only — no stubbed engine;
 *  - golden frames never touch disk: comparison happens in memory;
 *  - ids come from the registries, so new effects/transitions are covered
 *    automatically.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KNOWN_EFFECT_TYPES, KNOWN_TRANSITION_TYPES } from "../../../creation-schema/src/director/effect-types";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const CORE_SRC = join(REPO_ROOT, "packages/core/src");
const CREATION_SCHEMA_SRC = join(REPO_ROOT, "packages/creation-schema/src");
const FXPKG_SRC = join(REPO_ROOT, "packages/fxpkg/src");
const STUDIO_PKG = join(REPO_ROOT, "apps/studio/package.json");

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 30;

/**
 * A pixel counts as changed when any channel moves by more than 4/255 (~1.6%).
 * Frames are decoded twice from the same file at the same timestamp, so the
 * only legitimate noise is integer rounding inside the effect kernels; 4/255 is
 * comfortably above one LSB of rounding while staying far below what any real
 * filter (a 6px blur, a 90% vignette) produces on a structured source. 1% of
 * all pixels must move by that much for the effect to count as visible — a
 * filter that only perturbs sub-1% of the frame cannot be seen in the edit.
 */
const CHANNEL_EPSILON = 4;
const EPS = 0.01;

// `shadow` and `glow` are drop-shadow based: on a clip that fills the frame the
// shadow/glow lands entirely outside the canvas, so the stimulus must leave an
// alpha border (the clip is drawn at 60% scale).
function effectClip(effects: unknown[]) {
  return clip({
    id: "clip",
    mediaId: "media-a",
    effects,
    transform: { ...transform(), scale: { x: 0.6, y: 0.6 } },
  });
}

const EFFECT_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  // brightness is a percentage: the filter is `brightness(1 + value/100)`, so a
  // 0..1 value (the natural reading of "intensity") moves pixels by <2/255.
  brightness: { value: 60, amount: 60 },
  contrast: { value: 2.2, amount: 60 },
  saturation: { value: 0, amount: 80 },
  hue: { rotation: 90, value: 90, angle: 90 },
  blur: { radius: 6, amount: 6, size: 6 },
  sharpen: { amount: 90, value: 90 },
  vignette: { amount: 90 },
  grain: { amount: 70, size: 2 },
  chromaKey: {
    keyColor: { r: 0, g: 1, b: 0 },
    tolerance: 0.35,
    edgeSoftness: 0.15,
    softness: 0.15,
  },
  temperature: { value: 80 },
  tint: { value: 80 },
  tonal: { value: 0.7, shadows: 0.7, midtones: 0.7, highlights: 0.7 },
  shadow: { offsetX: 12, offsetY: 12, blur: 8, color: "#FF00FF", opacity: 1, value: 0.8, amount: 80 },
  glow: { radius: 20, intensity: 1.5, color: "#00FFFF", value: 0.8, amount: 70 },
  "motion-blur": { distance: 14, angle: 45, amount: 14 },
  "radial-blur": { amount: 45, centerX: 50, centerY: 50 },
  "chromatic-aberration": { amount: 15 },
};

const TRANSITION_DURATION = 0.4;
// Transition window for these clips is [clipA.end - d/2, clipA.end + d/2] =
// [1.0, 1.4]; sampling at t=1.0 gives progress 0, where every transition type
// renders the same outgoing frame. Sample at 0.25 progress instead.
const TRANSITION_SAMPLE_TIME = 1.1;
const TRANSITION_PARAMS: Record<string, unknown> = {
  duration: TRANSITION_DURATION,
  curve: "linear",
  direction: "left",
  softness: 0.5,
  holdDuration: 0,
};

interface RenderedPixels {
  w: number;
  h: number;
  rgba: Uint8Array;
}

type Platform = {
  __kove: {
    render: (project: unknown, time: number) => Promise<{ w: number; h: number; rgba: string }>;
  };
};

// esbuild and Playwright are resolved from apps/studio at runtime (the agent
// package does not depend on them), so only their used surface is typed here.
type EsbuildBuildLike = {
  onResolve: (opts: { filter: RegExp }, fn: (args: { path: string }) => unknown) => void;
  onLoad: (
    opts: { filter: RegExp; namespace?: string },
    fn: (args: { path: string }) => { contents: string; loader: string },
  ) => void;
};
type EsbuildLike = {
  build: (options: {
    entryPoints: string[];
    bundle: boolean;
    format: string;
    platform: string;
    target: string;
    outfile: string;
    logLevel: string;
    alias: Record<string, string>;
    loader: Record<string, string>;
    plugins: { name: string; setup: (build: EsbuildBuildLike) => void }[];
  }) => Promise<unknown>;
};
type PageLike = {
  evaluate: (fn: (...args: never[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  addScriptTag: (opts: { url: string }) => Promise<unknown>;
  goto: (url: string) => Promise<unknown>;
  on: (event: string, handler: (arg: { type: () => string; text: () => string }) => void) => void;
  close: () => Promise<void>;
};
type BrowserLike = {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
};
type PlaywrightLike = {
  chromium: { launch: (options: Record<string, unknown>) => Promise<BrowserLike> };
};

let workDir = "";
let server: Server | null = null;
let browser: BrowserLike | null = null;
let page: PageLike | null = null;
let baseUrl = "";
let baseline: RenderedPixels | null = null;
let transitionBaseline: RenderedPixels | null = null;

function ffmpeg(output: string, filter: string): void {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=2`,
    "-f", "lavfi",
    "-i", filter,
    "-filter_complex",
    `[0:v][1:v]overlay=${WIDTH / 2}:0[v]`,
    "-map", "[v]",
    "-pix_fmt", "yuv420p",
    "-t", "2",
    output,
  ]);
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pixelDiff(a: RenderedPixels, b: RenderedPixels): number {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let changed = 0;
  const pixels = a.w * a.h;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    if (
      Math.abs(a.rgba[i] - b.rgba[i]) > CHANNEL_EPSILON ||
      Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) > CHANNEL_EPSILON ||
      Math.abs(a.rgba[i + 2] - b.rgba[i + 2]) > CHANNEL_EPSILON ||
      Math.abs(a.rgba[i + 3] - b.rgba[i + 3]) > CHANNEL_EPSILON
    ) {
      changed++;
    }
  }
  return changed / pixels;
}

function transform() {
  return {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

function mediaItem(id: string, name: string, sourceUrl: string) {
  return {
    id,
    name,
    type: "video",
    fileHandle: null,
    blob: null,
    sourceUrl,
    metadata: {
      duration: 2,
      width: WIDTH,
      height: HEIGHT,
      frameRate: FPS,
      codec: "h264",
      sampleRate: 0,
      channels: 0,
      fileSize: 1,
      hasVideo: true,
      hasAudio: false,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
}

function clip(overrides: Record<string, unknown>) {
  return {
    id: "clip",
    mediaId: "media-a",
    trackId: "v1",
    startTime: 0,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    effects: [],
    audioEffects: [],
    transform: transform(),
    volume: 1,
    keyframes: [],
    ...overrides,
  };
}

function track(overrides: Record<string, unknown>) {
  return {
    id: "v1",
    type: "video",
    name: "Video 1",
    clips: [],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    ...overrides,
  };
}

function project(clips: unknown[], transitions: unknown[]) {
  return {
    id: "eval-project",
    name: "effect goldens",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: WIDTH, height: HEIGHT, frameRate: FPS, sampleRate: 48000, channels: 2 },
    mediaLibrary: {
      items: [
        mediaItem("media-a", "source-a.mp4", `${baseUrl}/source-a.mp4`),
        mediaItem("media-b", "source-b.mp4", `${baseUrl}/source-b.mp4`),
      ],
    },
    timeline: {
      tracks: [track({ clips, transitions })],
      subtitles: [],
      duration: 2,
      markers: [],
    },
  };
}

const ENTRY_SOURCE = `
import { VideoEngine } from ${JSON.stringify(join(CORE_SRC, "video/video-engine"))};

const engine = new VideoEngine();
let ready = null;

async function ensure() {
  if (!ready) ready = engine.initialize();
  await ready;
}

async function hydrate(project) {
  const items = project.mediaLibrary.items;
  for (const item of items) {
    if (!item.blob && item.sourceUrl) {
      const response = await fetch(item.sourceUrl);
      item.blob = await response.blob();
      delete item.sourceUrl;
    }
  }
}

async function render(project, time) {
  await ensure();
  await hydrate(project);
  const frame = await engine.renderFrame(project, time, project.settings.width, project.settings.height);
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(frame.image, 0, 0);
  const data = ctx.getImageData(0, 0, frame.width, frame.height).data;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + chunk)));
  }
  return { w: frame.width, h: frame.height, rgba: btoa(binary) };
}

window.__kove = { render };
`;

async function renderInBrowser(target: unknown, time: number): Promise<RenderedPixels> {
  const result = (await page!.evaluate(
    (payload: { project: unknown; time: number }) =>
      (window as unknown as Platform).__kove.render(payload.project, payload.time),
    { project: target, time },
  )) as { w: number; h: number; rgba: string };
  return { w: result.w, h: result.h, rgba: decode(result.rgba) };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "kove-effect-goldens-"));

  ffmpeg(
    join(workDir, "source-a.mp4"),
    `color=c=0x00FF00:size=${WIDTH / 2}x${HEIGHT}:rate=${FPS}:duration=2`,
  );
  ffmpeg(
    join(workDir, "source-b.mp4"),
    `color=c=0x2040FF:size=${WIDTH / 2}x${HEIGHT}:rate=${FPS}:duration=2`,
  );

  const entryPath = join(workDir, "entry.ts");
  const bundlePath = join(workDir, "bundle.js");
  writeFileSync(entryPath, ENTRY_SOURCE);

  const requireFromStudio = createRequire(STUDIO_PKG);
  const esbuild = requireFromStudio("esbuild") as EsbuildLike;
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome110",
    outfile: bundlePath,
    logLevel: "silent",
    alias: {
      "@kove-advanced/core": CORE_SRC,
      "@kove-advanced/creation-schema": CREATION_SCHEMA_SRC,
      "@kove-advanced/fxpkg": FXPKG_SRC,
    },
    loader: { ".glsl": "text", ".wgsl": "text", ".svg": "text" },
    plugins: [
      {
        name: "wasm-stub",
        setup(build) {
          build.onResolve({ filter: /\.wasm$/ }, args => ({ path: args.path, namespace: "wasm-stub" }));
          build.onLoad({ filter: /.*/, namespace: "wasm-stub" }, () => ({
            contents: "export default new Uint8Array(0);",
            loader: "js",
          }));
        },
      },
    ],
  });

  writeFileSync(
    join(workDir, "index.html"),
    '<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>',
  );

  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").replace(/^\//, ""));
    const file = join(workDir, name === "" ? "index.html" : name);
    try {
      const body = require("node:fs").readFileSync(file);
      res.writeHead(200, {
        "content-type": name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".mp4")
            ? "video/mp4"
            : "text/html",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
  const address = server!.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const studioRequire = createRequire(STUDIO_PKG);
  const playwright = studioRequire("@playwright/test") as PlaywrightLike;
  const launchOptions = {
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"],
  };
  try {
    // System Chrome: the bundled Playwright build may not match the cached
    // browser revision, and this test must never reach the network.
    browser = await playwright.chromium.launch({ ...launchOptions, channel: "chrome" });
  } catch {
    browser = await playwright.chromium.launch(launchOptions);
  }
  page = await browser.newPage();
  page!.on("console", msg => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  await page!.goto(`${baseUrl}/index.html`);
  await page!.addScriptTag({ url: `${baseUrl}/bundle.js` });
  await page!.evaluate(async () => {
    await Promise.resolve();
    if (!(window as unknown as { __kove?: unknown }).__kove) {
      throw new Error("render bundle did not load (__kove missing)");
    }
  });

  const effectBaseline = project([effectClip([])], []);
  baseline = await renderInBrowser(effectBaseline, 1);

  const transitionClipA = clip({ id: "clip-a", mediaId: "media-a", startTime: 0, duration: 1.2, outPoint: 1.2 });
  const transitionClipB = clip({ id: "clip-b", mediaId: "media-b", startTime: 0.8, duration: 1.2, inPoint: 0.2, outPoint: 1.4 });
  transitionBaseline = await renderInBrowser(
    project([transitionClipA, transitionClipB], []),
    TRANSITION_SAMPLE_TIME,
  );
}, 300_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await new Promise<void>(done => {
    if (!server) return done();
    server.close(() => done());
  });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("effect render goldens", () => {
  it("baseline frame is non-empty", () => {
    expect(baseline).not.toBeNull();
    expect(baseline!.rgba).toHaveLength(WIDTH * HEIGHT * 4);
    const distinct = new Set<number>();
    for (let i = 0; i < baseline!.rgba.length; i += 4) {
      distinct.add((baseline!.rgba[i] << 16) | (baseline!.rgba[i + 1] << 8) | baseline!.rgba[i + 2]);
    }
    expect(distinct.size).toBeGreaterThan(8);
  });

  it.each(KNOWN_EFFECT_TYPES)('effect "%s" renders pixels', async effectId => {
    const params = EFFECT_PARAMS[effectId] ?? { value: 1, amount: 50 };
    const projectWithEffect = project(
      [
        effectClip([
          { id: `effect-${effectId}`, type: effectId, enabled: true, params },
        ]),
      ],
      [],
    );

    const rendered = await renderInBrowser(projectWithEffect, 1);
    const diff = pixelDiff(baseline!, rendered);
    console.log(`[golden] effect ${effectId}: ${(diff * 100).toFixed(2)}% pixels changed`);
    expect(
      diff,
      `effect "${effectId}" changed ${(diff * 100).toFixed(2)}% of pixels (need > ${(EPS * 100).toFixed(0)}%)`,
    ).toBeGreaterThan(EPS);
  }, 60_000);
});

describe("transition render goldens", () => {
  it("transition baseline frame is non-empty", () => {
    expect(transitionBaseline).not.toBeNull();
    expect(transitionBaseline!.rgba).toHaveLength(WIDTH * HEIGHT * 4);
  });

  it.each(KNOWN_TRANSITION_TYPES)('transition "%s" renders pixels', async transitionId => {
    const clipA = clip({ id: "clip-a", mediaId: "media-a", startTime: 0, duration: 1.2, outPoint: 1.2 });
    const clipB = clip({ id: "clip-b", mediaId: "media-b", startTime: 0.8, duration: 1.2, inPoint: 0.2, outPoint: 1.4 });
    const projectWithTransition = project(
      [clipA, clipB],
      [
        {
          id: `transition-${transitionId}`,
          clipAId: "clip-a",
          clipBId: "clip-b",
          type: transitionId,
          duration: TRANSITION_DURATION,
          params: TRANSITION_PARAMS,
        },
      ],
    );

    const rendered = await renderInBrowser(projectWithTransition, TRANSITION_SAMPLE_TIME);
    const diff = pixelDiff(transitionBaseline!, rendered);
    console.log(`[golden] transition ${transitionId}: ${(diff * 100).toFixed(2)}% pixels changed`);
    expect(
      diff,
      `transition "${transitionId}" changed ${(diff * 100).toFixed(2)}% of pixels (need > ${(EPS * 100).toFixed(0)}%)`,
    ).toBeGreaterThan(EPS);
  }, 60_000);

  it("every transition type renders a distinct frame", async () => {
    const frames = new Map<string, RenderedPixels>();
    for (const transitionId of KNOWN_TRANSITION_TYPES) {
      const target = project(
        [
          clip({ id: "clip-a", mediaId: "media-a", startTime: 0, duration: 1.2, outPoint: 1.2 }),
          clip({ id: "clip-b", mediaId: "media-b", startTime: 0.8, duration: 1.2, inPoint: 0.2, outPoint: 1.4 }),
        ],
        [
          {
            id: `transition-${transitionId}`,
            clipAId: "clip-a",
            clipBId: "clip-b",
            type: transitionId,
            duration: TRANSITION_DURATION,
            params: TRANSITION_PARAMS,
          },
        ],
      );
      frames.set(transitionId, await renderInBrowser(target, TRANSITION_SAMPLE_TIME));
    }

    const ids = [...frames.keys()];
    const collisions: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (pixelDiff(frames.get(a)!, frames.get(b)!) <= EPS) collisions.push(`${a} == ${b}`);
      }
    }
    console.log(`[golden] transition collisions: ${collisions.length ? collisions.join(", ") : "none"}`);
    expect(collisions, `transition types rendering identical frames: ${collisions.join(", ")}`).toEqual([]);
  }, 240_000);

  it("source fixtures are distinguishable", async () => {
    const onlyA = await renderInBrowser(project([clip({ id: "c", mediaId: "media-a" })], []), 1);
    const onlyB = await renderInBrowser(project([clip({ id: "c", mediaId: "media-b" })], []), 1);
    expect(
      pixelDiff(onlyA, onlyB),
      "media-a and media-b rendered identical frames (transition checks would be vacuous)",
    ).toBeGreaterThan(EPS);
  }, 60_000);
});
