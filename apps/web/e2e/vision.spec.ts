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

  function outputPath(name: string): string {
    const dir = test.info().outputDir;
    mkdirSync(dir, { recursive: true });
    return join(dir, name);
  }

  test("detects faces in an imported clip with the local face model", async ({ page }) => {
    const assetRequests = recordAssetRequests(page);
    const videoPath = outputPath("subject-clip.webm");
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
});
