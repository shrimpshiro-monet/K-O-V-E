import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasBrowser } from "../playwright.config";

/**
 * Real-browser verification of the vision pipeline (face detection → subject
 * matte → applied mask keyframes), driven through the editor UI.
 *
 * What is real here: Chromium, the app, project creation, media import, the
 * agent host, decoding of real recorded video, MediaPipe's runtime + the
 * official `face_landmarker.task` face model, the segmentation worker and its
 * protocol, the tracker, the rotoscope geometry and the mask write action.
 *
 * What is substituted: the person-segmentation *weights* only. Every offline
 * mirror of the official selfie-segmenter model is unreachable from CI (CDN or
 * git-lfs pointer), so the asset server swaps the MediaPipe bundle the worker
 * `importScripts` for a synthetic segmenter — see stub-segmenter-runtime.cjs
 * and e2e/README.md. The suite asserts the models were loaded from the local
 * asset server so a run can never silently fall back to the network.
 */

const ASSET_PORT = Number(process.env.KOVE_E2E_ASSET_PORT ?? 8788);
const FIXTURE_URL = `http://127.0.0.1:${ASSET_PORT}/subject-portrait.jpg`;

test.describe("vision pipeline in the real editor", () => {
  test.skip(
    !hasBrowser(),
    "No Chromium available: set KOVE_E2E_CHROMIUM=/path/to/chrome, or run `pnpm exec playwright install chromium`",
  );

  let pageErrors: string[];

  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
  });

  test.afterEach(() => {
    expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  /** Records a short panning/zooming clip from the portrait fixture. */
  async function recordFixtureVideo(page: Page, outputPath: string): Promise<void> {
    const base64 = await page.evaluate(async (fixtureUrl) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = fixtureUrl;
      await image.decode();

      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();

      // 30 fps for ~3 s: requestAnimationFrame is throttled in headless runs,
      // so pace the frames with a timer to get a clip with real motion.
      const startedAt = performance.now();
      await new Promise<void>((resolve) => {
        const paint = () => {
          const t = (performance.now() - startedAt) / 1000;
          const zoom = 1.32 + 0.05 * Math.sin(t * 1.3);
          const width = canvas.width * zoom;
          const height = canvas.height * zoom;
          context.fillStyle = "#0d1218";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(
            image,
            -(width - canvas.width) / 2 + Math.sin(t) * 24,
            -(height - canvas.height) / 2 + Math.cos(t * 0.8) * 10,
            width,
            height,
          );
          if (t >= 3) {
            clearInterval(timer);
            resolve();
          }
        };
        const timer = setInterval(paint, 33);
        paint();
      });

      recorder.stop();
      await stopped;
      const buffer = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = "";
      for (const byte of buffer) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, FIXTURE_URL);
    writeFileSync(outputPath, Buffer.from(base64, "base64"));
  }

  /**
   * First-run tours open a modal that swallows clicks. Mark them complete
   * before the app boots (same flag a user sets by finishing or skipping the
   * tour) so the run is deterministic.
   */
  async function dismissOnboarding(page: Page): Promise<void> {
    await page.addInitScript(() => {
      localStorage.setItem("kove-advanced-onboarding-complete", "true");
      localStorage.setItem("kove-advanced-mograph-tour-complete", "true");
    });
  }

  /** Imports the clip, puts it on the timeline and opens the vision panel. */
  async function importClipAndOpenTools(page: Page, videoPath: string): Promise<void> {
    await dismissOnboarding(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Import Media" }).first()).toBeVisible();

    // A fresh install has no project on disk. The editor opens a scratch
    // project by itself so that every write path works — the AI panels, the
    // agent host and undo all go through the store's action executor, which
    // refuses writes while no project is open.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const { useProjectStore } = await import("/src/stores/project-store.ts");
            return useProjectStore.getState().hasOpenProject;
          }),
        { message: "the editor should open a project on boot", timeout: 30_000 },
      )
      .toBe(true);

    await page.locator('input[type="file"]').first().setInputFiles(videoPath);

    // Import probes the file before it can be placed; wait for the duration to
    // land (a too-short clip would give the sampler almost nothing to work on).
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const { useProjectStore } = await import("/src/stores/project-store.ts");
            const item = useProjectStore.getState().project.mediaLibrary.items.at(-1);
            return item?.metadata?.duration ?? 0;
          }),
        { message: "recorded fixture clip should be at least a second long", timeout: 30_000 },
      )
      .toBeGreaterThan(1);

    // Hovering a media tile reveals its quick actions; "Add to timeline" runs
    // the same handler as double-clicking the thumbnail, without racing the
    // hover overlay that intercepts pointer events.
    const tile = page.locator('img[alt$="subject-clip.webm"]').first();
    await expect(tile).toBeVisible();
    await tile.hover();
    await page.getByRole("button", { name: "Add to timeline" }).first().click();

    // The first clip into an empty project asks whether to adopt the video's
    // dimensions; keep the project's own settings (16:9) like a user would.
    const keepCurrent = page.getByRole("button", { name: "Keep Current" });
    await expect(keepCurrent).toBeVisible();
    await keepCurrent.click();

    // Select the new clip so the clip inspector (and its AI tab) is showing.
    const clip = page.getByRole("button", { name: /Select clip/i }).first();
    await expect(clip).toBeVisible();
    await clip.click();

    // The clip inspector renders collapsible sections; open the vision one.
    const section = page.getByRole("button", { name: /Face & Subject Tools section/i }).first();
    await expect(section).toBeVisible();
    if (/Expand/i.test((await section.getAttribute("aria-label")) ?? "")) await section.click();
    await expect(page.getByRole("button", { name: "Detect Faces" })).toBeVisible();
  }

  /** Local asset-server URLs requested by the page (models, wasm, runtime). */
  function recordAssetRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith(`http://127.0.0.1:${ASSET_PORT}/`)) urls.push(request.url());
    });
    return urls;
  }

  /** Nothing may fetch vision weights from an external origin. */
  function expectNoRemoteModels(requests: string[]): void {
    expect(requests.filter((url) => url.includes("storage.googleapis.com"))).toEqual([]);
  }

  /**
   * Runs agent tools through the browser host — the same path the director
   * uses (registry → tool → host → store), minus the LLM.
   */
  async function runAgentTool(
    page: Page,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; summary: string }> {
    return page.evaluate(
      async ({ toolName, toolArgs }) => {
        const [{ executeTool }, { getLiveEditorHost }] = await Promise.all([
          import("/@id/@kove-advanced/agent"),
          import("/src/services/agent/host-singleton.ts"),
        ]);
        const host = getLiveEditorHost();
        const result = await executeTool(toolName, toolArgs, host);
        return { ok: result.ok, summary: result.summary };
      },
      { toolName: name, toolArgs: args },
    );
  }

  /** Moves the playhead and reads the preview canvas back as pixels. */
  async function samplePreview(
    page: Page,
    timeSeconds: number,
  ): Promise<{ contentPixels: number; leftEdge: number; width: number; height: number }> {
    return page.evaluate(async (time) => {
      const { useTimelineStore } = await import("/src/stores/timeline-store.ts");
      const settle = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Nudge off the time first so the preview always sees a playhead change:
      // reading the same instant twice must not hand back a stale composite.
      useTimelineStore.getState().setPlayheadPosition(time + 0.05);
      await settle();
      useTimelineStore.getState().setPlayheadPosition(time);
      await settle();

      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-preview-canvas]");
      if (!canvas) throw new Error("no preview canvas found");
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("preview canvas has no 2d context");

      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const lit = (x: number, y: number): boolean => {
        const i = (y * width + x) * 4;
        // Ignore the near-black backdrop: count pixels that are clearly lit.
        return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 40;
      };

      let content = 0;
      for (let y = 0; y < height; y += 3) {
        for (let x = 0; x < width; x += 3) {
          if (lit(x, y)) content += 1;
        }
      }

      // Where does the picture start on the horizontal axis? A clip translated
      // to the right leaves dark space on the left, which is what a keyframe
      // written by an agent must produce. Column-based, so it cannot saturate
      // the way a centroid does for a frame-filling clip.
      let leftEdge = 1;
      const sampledRows: number[] = [];
      for (let y = 0; y < height; y += 4) sampledRows.push(y);
      for (let x = 0; x < width; x += 2) {
        const hits = sampledRows.reduce((total, y) => total + (lit(x, y) ? 1 : 0), 0);
        if (hits / sampledRows.length >= 0.2) {
          leftEdge = x / width;
          break;
        }
      }

      return { contentPixels: content, leftEdge, width, height };
    }, timeSeconds);
  }

  /**
   * MediaPipe Tasks runs every delegate through a WebGL context (even the CPU
   * one), so a browser without WebGL cannot run the face model at all. Some
   * sandbox builds ship no SwiftShader libs and land here; a real machine never
   * does. Tests that need the model are skipped rather than failed for that.
   */
  async function hasWebgl(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    });
  }

  function outputPath(name: string): string {
    const dir = test.info().outputDir;
    mkdirSync(dir, { recursive: true });
    return join(dir, name);
  }

  test("detects faces in an imported clip with the local face model", async ({ page }) => {
    const assetRequests = recordAssetRequests(page);
    const videoPath = outputPath("subject-clip.webm");
    test.skip(
      !(await hasWebgl(page)),
      "this browser exposes no WebGL context, so MediaPipe Tasks cannot run",
    );

    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    await page.screenshot({ path: outputPath("01-panel-open.png") });

    await page.getByRole("button", { name: "Detect Faces" }).click();

    // The panel lists tracked faces once analysis completes.
    const tracks = page.getByText(/face track/i).first();
    await expect(tracks).toBeVisible({ timeout: 150_000 });
    await expect(page.getByText(/primary/i).first()).toBeVisible();

    // "0 face track(s)" would satisfy a loose /face track/ match, so read the
    // count the panel actually reports.
    const panel = await page.locator("body").innerText();
    const trackCount = Number(/(\d+)\s*face track/i.exec(panel)?.[1] ?? "0");
    expect(trackCount).toBeGreaterThan(0);
    expect(panel).toMatch(/face track\(s\); primary /);

    // Each listed track carries the span it was tracked over and its average
    // confidence ("640×480 · 2.9s · conf 0.71"). A duration spanning several
    // sampled frames is only produced when the real detector ran across the
    // whole clip *and* the tracker associated those detections into one track;
    // a single lucky frame, or a detector that failed on later frames, cannot.
    const detail = /([\d.]+)s\s*·\s*conf\s*([\d.]+)/.exec(panel);
    expect(detail, `face track detail line missing from panel: ${panel.slice(0, 400)}`).not.toBeNull();
    expect(Number(detail?.[1])).toBeGreaterThan(0.5);
    expect(Number(detail?.[2])).toBeGreaterThan(0.2);

    // The official face model came from the local asset server, not a CDN.
    expect(assetRequests.some((url) => url.endsWith("/models/face_landmarker.task"))).toBe(true);
    expectNoRemoteModels(assetRequests);
    await page.screenshot({ path: outputPath("02-faces-detected.png") });
  });

  test("writes a rotoscoped subject matte onto the clip as one mask", async ({ page }) => {
    const assetRequests = recordAssetRequests(page);
    const videoPath = outputPath("subject-clip.webm");
    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    // Segmentation inference is served by the synthetic model in
    // stub-segmenter-runtime.cjs (see e2e/README.md): the worker, engine,
    // rotoscope and mask write below are the real implementations.
    await page.getByRole("button", { name: "Analyze Subject" }).click();

    const applyButton = page.getByRole("button", { name: /Apply matte \(\d+ keyframes?\)/ });
    await expect(applyButton).toBeVisible({ timeout: 150_000 });
    const label = (await applyButton.textContent()) ?? "";
    const keyframes = Number(/Apply matte \((\d+)/.exec(label)?.[1] ?? "0");
    expect(keyframes).toBeGreaterThan(0);

    // Read the plan summary now: applying re-renders the panel and the
    // analysis text is replaced by the applied message.
    const planSummary = await page.locator("body").innerText();
    const coverage = Number(/average coverage ([\d.]+)%/.exec(planSummary)?.[1] ?? "0");
    expect(coverage).toBeGreaterThan(5);
    expect(coverage).toBeLessThan(80);
    await page.screenshot({ path: outputPath("03-matte-planned.png") });

    await applyButton.click();
    // Applying also spins up the mask engine and the separation preview model.
    await expect(page.getByText(/Wrote \d+ matte keyframe\(s\)/).first()).toBeVisible({ timeout: 120_000 });

    // The mask is real project state: keyframed paths on the selected clip.
    const masks = await page.evaluate(async () => {
      const stores = await import("/src/stores/project-store.ts");
      const project = stores.useProjectStore.getState().project;
      return (project.masks ?? []).map((mask) => ({
        clipId: mask.clipId as string,
        feathering: mask.feathering,
        keyframes: (mask.keyframes ?? []).map((keyframe) => {
          const points = keyframe.path?.points ?? [];
          const centroid = points.reduce(
            (sum, point) => ({
              x: sum.x + point.x / points.length,
              y: sum.y + point.y / points.length,
            }),
            { x: 0, y: 0 },
          );
          return {
            time: keyframe.time,
            anchors: points.length,
            closed: keyframe.path?.closed ?? false,
            centroid,
          };
        }),
      }));
    });
    await page.screenshot({ path: outputPath("04-matte-applied.png") });

    expect(masks).toHaveLength(1);
    expect(masks[0].feathering).toBeGreaterThan(0);
    const mattes = masks[0].keyframes;
    expect(mattes).toHaveLength(keyframes);

    for (const matte of mattes) {
      expect(matte.closed).toBe(true);
      expect(matte.anchors).toBeGreaterThan(2);
      // Paths live in normalized frame space; pixel coordinates here would mean
      // the matte was written in the wrong coordinate space.
      expect(Number.isFinite(matte.centroid.x)).toBe(true);
      expect(matte.centroid.x).toBeGreaterThan(0.1);
      expect(matte.centroid.x).toBeLessThan(0.9);
      expect(matte.centroid.y).toBeGreaterThan(0.1);
      expect(matte.centroid.y).toBeLessThan(0.9);
    }

    // Keyframe times ascend, are distinct, and span the clip: the analysis
    // really walked the video instead of sampling one frame repeatedly.
    const times = mattes.map((matte) => matte.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times.map((time) => time.toFixed(3))).size).toBe(times.length);
    expect(times[times.length - 1] - times[0]).toBeGreaterThan(1);

    // The traced matte moves with the subject (the fixture pans/zooms): a
    // frozen shape, or a plan whose frames and times got crossed, would sit
    // still. This is the difference between "keyframes exist" and "keyframes
    // follow the subject".
    const centroidsX = mattes.map((matte) => matte.centroid.x);
    const motionX = Math.max(...centroidsX) - Math.min(...centroidsX);
    expect(motionX).toBeGreaterThan(0.01);

    // The worker loaded its MediaPipe runtime from the local asset server.
    expect(assetRequests.some((url) => url.endsWith("/vision_bundle.cjs"))).toBe(true);
    expectNoRemoteModels(assetRequests);
  });

  test("auto-reframes the clip with a real tracked camera move", async ({ page }) => {
    const assetRequests = recordAssetRequests(page);
    const videoPath = outputPath("subject-clip.webm");
    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    // Open the Auto Reframe section (the same one ship users see).
    const section = page.getByRole("button", { name: /Auto Reframe section/i }).first();
    await expect(section).toBeVisible();
    if (/Expand/i.test((await section.getAttribute("aria-label")) ?? "")) await section.click();

    const analyze = page.getByRole("button", { name: "Analyze & Reframe" });
    await expect(analyze).toBeVisible();
    await analyze.click();

    // Real work: the canvas is resized to the vertical target...
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const { useProjectStore } = await import("/src/stores/project-store.ts");
            const settings = useProjectStore.getState().project.settings;
            return `${settings.width}x${settings.height}`;
          }),
        { message: "auto reframe should resize the canvas to the target", timeout: 150_000 },
      )
      .toBe("1080x1920");

    // ...and the camera move is written as clip transform keyframes.
    const camera = await page.evaluate(async () => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      const store = useProjectStore.getState();
      const clips = store.project.timeline.tracks.flatMap((track) => track.clips);
      const clip = clips[0];
      const cameraProperties = ["position.x", "position.y", "scale.x", "scale.y"];
      const keyframes = (clip?.keyframes ?? []).filter((kf) => cameraProperties.includes(kf.property));
      return {
        properties: [...new Set(keyframes.map((kf) => kf.property))].sort(),
        samples: new Set(keyframes.map((kf) => kf.time)).size,
        times: [...new Set(keyframes.map((kf) => kf.time))].sort((a, b) => a - b),
        maxScale: Math.max(
          ...keyframes.filter((kf) => kf.property === "scale.x").map((kf) => Number(kf.value)),
          0,
        ),
        undoLabel: store.actionHistory.undoStack?.[store.actionHistory.undoStack.length - 1]?.description ?? null,
      };
    });

    // All four animated properties are present (the renderer interpolates each).
    expect(camera.properties).toEqual(["position.x", "position.y", "scale.x", "scale.y"]);
    expect(camera.samples).toBeGreaterThan(0);
    expect(camera.times[0]).toBeGreaterThanOrEqual(0);
    // The clip is scaled up so the vertical crop fills the canvas: an identity
    // transform would mean the "reframe" did nothing.
    expect(camera.maxScale).toBeGreaterThan(1.05);

    await page.screenshot({ path: outputPath("05-auto-reframed.png") });

    // The visible surface reports what actually happened.
    await expect(page.getByText(/camera keyframe\(s\) from \d+ frame\(s\)/)).toBeVisible();

    expect(assetRequests.some((url) => url.endsWith("/models/face_landmarker.task"))).toBe(true);
    expectNoRemoteModels(assetRequests);
  });

  test("agent tools land on the timeline, in the preview and on the keyframe clock", async ({ page }) => {
    const videoPath = outputPath("subject-clip.webm");
    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    const clipId = await page.evaluate(async () => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      const clips = useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips);
      return clips.find((clip) => "mediaId" in clip)?.id ?? "";
    });
    expect(clipId).not.toBe("");

    // --- text pillar: a tool adds text; the store, timeline and preview all
    // --- agree about it, at a time where the video itself shows nothing.
    const emptyFrame = await samplePreview(page, 4.2);
    const text = await runAgentTool(page, "create_text_clip", {
      clip: { text: "PILLAR", startTime: 3.5, duration: 1.4 },
    });
    expect(text.ok, text.summary).toBe(true);

    await expect
      .poll(async () => (await samplePreview(page, 4.2)).contentPixels, {
        message: "the preview should render the text clip the tool created",
        timeout: 20_000,
      })
      .toBeGreaterThan(emptyFrame.contentPixels + 10);

    // The timeline pillar agrees with the store and the preview.
    await expect(page.getByRole("button", { name: /Select.*clip PILLAR/i }).first()).toBeVisible();
    const stored = await page.evaluate(async () => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      const project = useProjectStore.getState().project;
      const clips = project.timeline.tracks.flatMap((track) => track.clips);
      // Text overlays live in their own project collection; the timeline renders
      // them alongside the media clips.
      const textClips = project.textClips ?? [];
      return {
        mediaClips: clips.length,
        trackCount: project.timeline.tracks.length,
        texts: textClips.map((clip) => clip.text),
        textWindow: textClips.map((clip) => `${clip.startTime}-${clip.startTime + clip.duration}`),
      };
    });
    expect(stored.texts).toContain("PILLAR");
    expect(stored.mediaClips).toBeGreaterThanOrEqual(1);
    expect(stored.textWindow).toContain("3.5-4.9");

    // The timeline UI carries the same numbers the model does.
    const timeline = page.locator("[data-timeline-view]");
    await expect(timeline).toHaveAttribute("data-track-count", String(stored.trackCount));
    await expect(timeline).toHaveAttribute("data-playhead-sec", "4.200");

    // --- keyframe pillar: tool-written keyframes move the picture -----------
    // Precondition: the clip is actually on screen at this playhead (decoding a
    // recorded webm takes a moment; a placeholder frame carries no transform).
    await expect
      .poll(async () => (await samplePreview(page, 2.3)).contentPixels, {
        message: "the video clip should be rendered before the keyframes can move it",
        timeout: 30_000,
      })
      .toBeGreaterThan(50);
    const beforeKeyframes = await samplePreview(page, 2.3);
    // Transform keyframes are in project pixels (that is what auto-reframe
    // writes and what the renderer translates by), so ask the project how wide
    // it is and move the clip by 45% of that.
    const shiftPixels = await page.evaluate(async () => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      return useProjectStore.getState().project.settings.width * 0.45;
    });
    const keyframed = await runAgentTool(page, "set_clip_keyframes", {
      clipId,
      keyframes: [
        { id: "kf-a", time: 0, property: "position.x", value: 0, easing: "linear" },
        { id: "kf-b", time: 0.5, property: "position.x", value: shiftPixels, easing: "linear" },
      ],
    });
    expect(keyframed.ok, keyframed.summary).toBe(true);

    // The model pillar first: the tool's keyframes are on the clip.
    await expect
      .poll(
        async () =>
          page.evaluate(async (id) => {
            const { useProjectStore } = await import("/src/stores/project-store.ts");
            const clips = useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips);
            const clip = clips.find((entry) => entry.id === id) as
              | { keyframes?: { property: string; time: number; value?: unknown }[] }
              | undefined;
            return clip?.keyframes?.map((keyframe) => `${keyframe.property}@${keyframe.time}=${String(keyframe.value)}`) ?? [];
          }, clipId),
        { message: "the tool's keyframes should be on the clip in the project model" },
      )
      .toEqual(["position.x@0=0", `position.x@0.5=${shiftPixels}`]);

    // Same playhead, same frame: only the keyframes changed, so any movement is
    // the preview interpolating what the tool wrote.
    await expect
      .poll(async () => (await samplePreview(page, 2.3)).leftEdge, {
        message: "the preview should move the clip with the keyframes the tool wrote",
        timeout: 30_000,
      })
      .toBeGreaterThan(beforeKeyframes.leftEdge + 0.3);

    // ...and the interpolation is real: earlier in the clip the same clip sits
    // closer to its untransformed position.
    const late = await samplePreview(page, 2.3);
    const early = await samplePreview(page, 0.2);
    expect(late.leftEdge).toBeGreaterThan(early.leftEdge + 0.2);

    const storedKeyframes = await page.evaluate(async (id) => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      const clips = useProjectStore.getState().project.timeline.tracks.flatMap((track) => track.clips);
      const clip = clips.find((entry) => entry.id === id) as { keyframes?: { property: string }[] } | undefined;
      return clip?.keyframes?.map((keyframe) => keyframe.property) ?? [];
    }, clipId);
    expect(storedKeyframes).toEqual(["position.x", "position.x"]);

    // The timeline keeps showing the clip after the tool rewrote it.
    await expect(page.getByRole("button", { name: /Select clip.*subject-clip/i }).first()).toBeVisible();
    await page.screenshot({ path: outputPath("06-pillars-in-sync.png") });
  });
});
