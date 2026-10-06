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
    // The tile is matched on the file that was actually imported, so a test
    // can record its own fixture instead of sharing one filename.
    const fileName = videoPath.split(/[\\/]/).pop() ?? "";
    const tile = page.locator(`img[alt$="${fileName}"]`).first();
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

  test("refines the matte edge per keyframe, and previews it", async ({ page }) => {
    const assetRequests = recordAssetRequests(page);
    const videoPath = outputPath("edge-clip.webm");
    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    await page.getByRole("button", { name: "Analyze Subject" }).click();
    const applyButton = page.getByRole("button", { name: /Apply matte \(\d+ keyframes?\)/ });
    await expect(applyButton).toBeVisible({ timeout: 150_000 });

    // The edge controls are live once a plan exists.
    const edgeList = page.getByTestId("matte-edge-keyframes");
    await expect(edgeList).toBeVisible();

    // The synthetic segmenter drifts, so the plan has motion and the planner
    // must widen the feather somewhere rather than write one flat value.
    const listed = await edgeList.locator("li").allInnerTexts();
    expect(listed.length).toBeGreaterThan(1);
    const feathers = listed.map((text) => Number(/([\d.]+)px/.exec(text)?.[1] ?? "0"));
    expect(feathers.every((value) => Number.isFinite(value))).toBe(true);
    expect(Math.max(...feathers) - Math.min(...feathers)).toBeGreaterThan(0.5);

    // Live preview: both canvases really draw, and the refined edge is softer
    // than the base one. Counting semi-transparent pixels is what makes this
    // more than "a canvas exists".
    const bands = await page.evaluate(() => {
      const read = (testId: string) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          `[data-testid="${testId}"]`,
        );
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let opaque = 0;
        let edge = 0;
        for (let index = 3; index < data.length; index += 4) {
          const alpha = data[index];
          if (alpha > 250) opaque += 1;
          else if (alpha > 4) edge += 1;
        }
        return { opaque, edge };
      };
      return { before: read("matte-edge-preview-before"), after: read("matte-edge-preview-after") };
    });
    await page.screenshot({ path: outputPath("06-edge-preview.png") });

    expect(bands.before).toBeTruthy();
    expect(bands.after).toBeTruthy();
    expect(bands.before!.opaque).toBeGreaterThan(0);
    // A wider feather spreads the same silhouette over more partial pixels.
    expect(bands.after!.edge).toBeGreaterThan(bands.before!.edge);

    await applyButton.click();
    await expect(page.getByText(/Wrote \d+ matte keyframe\(s\)/).first()).toBeVisible({ timeout: 120_000 });
    // The panel reports the range it wrote, not a generic confirmation.
    await expect(page.getByText(/Edge feather [\d.]+–[\d.]+px/)).toBeVisible();

    // The committed mask carries per-keyframe feather overrides: that is the
    // difference between this and the old single mask-wide feather.
    const written = await page.evaluate(async () => {
      const { useProjectStore } = await import("/src/stores/project-store.ts");
      const mask = (useProjectStore.getState().project.masks ?? [])[0];
      return {
        maskFeathering: mask?.feathering ?? null,
        feathers: (mask?.keyframes ?? []).map((keyframe) => keyframe.feathering ?? null),
      };
    });

    expect(written.feathers.length).toBeGreaterThan(1);
    expect(written.feathers.every((value) => typeof value === "number")).toBe(true);
    const values = written.feathers as number[];
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.5);
    // The mask-level value is the base those keyframes inherit.
    expect(written.maskFeathering).toBe(4);

    await page.screenshot({ path: outputPath("07-edge-applied.png") });
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

    // The visible surface reports what actually happened, including how closely
    // the emitted keyframes follow the fitted camera curve.
    await expect(page.getByText(/camera keyframe\(s\) from \d+ frame\(s\)/)).toBeVisible();
    await expect(page.getByText(/path fit [\d.]+px/)).toBeVisible();
    // Motion-adaptive sampling: the recorded clip pans and zooms, so the second
    // pass must have found somewhere worth decoding more densely than the base
    // grid — and say so, rather than leaving the sample count unexplained.
    await expect(page.getByText(/\d+ added where it moved/)).toBeVisible();

    expect(assetRequests.some((url) => url.endsWith("/models/face_landmarker.task"))).toBe(true);
    expectNoRemoteModels(assetRequests);
  });


  test("hand-edits one keyframe's edge on the mask timeline", async ({ page }) => {
    const videoPath = outputPath("handedit-clip.webm");
    await recordFixtureVideo(page, videoPath);
    await importClipAndOpenTools(page, videoPath);

    // Commit a rotoscoped matte first: the hand editor works on a real mask
    // with real planner-written keyframes, not a fixture.
    await page.getByRole("button", { name: "Analyze Subject" }).click();
    const applyButton = page.getByRole("button", { name: /Apply matte \(\d+ keyframes?\)/ });
    await expect(applyButton).toBeVisible({ timeout: 150_000 });
    await applyButton.click();
    await expect(page.getByText(/Wrote \d+ matte keyframe\(s\)/).first()).toBeVisible({
      timeout: 120_000,
    });

    const readMask = () =>
      page.evaluate(async () => {
        const { useProjectStore } = await import("/src/stores/project-store.ts");
        const mask = (useProjectStore.getState().project.masks ?? [])[0];
        return {
          maskFeathering: mask?.feathering ?? null,
          keyframes: (mask?.keyframes ?? []).map((keyframe) => ({
            time: keyframe.time,
            feathering: keyframe.feathering ?? null,
          })),
        };
      });

    const planned = await readMask();
    expect(planned.keyframes.length).toBeGreaterThan(1);

    const masking = page.getByRole("button", { name: /Masking section/i }).first();
    await expect(masking).toBeVisible();
    if (/Expand/i.test((await masking.getAttribute("aria-label")) ?? "")) await masking.click();
    await page.getByRole("button", { name: "Expand mask", exact: true }).click();
    await page.getByRole("button", { name: /Expand keyframe edges/i }).click();
    await expect(page.getByTestId("mask-keyframe-edges")).toBeVisible();
    await page.screenshot({ path: outputPath("08-keyframe-edges.png") });

    // One keyframe gets a hand-set feather; its neighbours must be untouched.
    await page.getByRole("button", { name: "Select keyframe 2" }).click();
    // Typed rather than filled: a controlled number input clamps on every
    // keystroke, and replacing the whole value in one event is not what a
    // user's hand does anyway.
    const featherInput = page.getByLabel("Keyframe 2 feather px");
    await featherInput.click();
    await featherInput.press("ControlOrMeta+a");
    await featherInput.pressSequentially("40");

    await expect
      .poll(async () => (await readMask()).keyframes[1]?.feathering, {
        message: "the hand-set feather should reach the committed mask",
        timeout: 30_000,
      })
      .toBe(40);

    const edited = await readMask();
    expect(edited.keyframes[0]?.feathering).toBe(planned.keyframes[0]?.feathering);
    expect(edited.keyframes[2]?.feathering).toBe(planned.keyframes[2]?.feathering);
    expect(edited.maskFeathering).toBe(planned.maskFeathering);

    // Scrubbing between keyframe 1 and 2 shows the blended edge, not either
    // keyframe's own value — the hand-set 40px has to interpolate, not jump.
    const midpoint = (edited.keyframes[0].time + edited.keyframes[1].time) / 2;
    // Driven through the native value setter: a range input's `fill` rejects any
    // value that is not exactly on its step grid.
    const scrubbed = await page
      .getByLabel("Scrub edge time")
      .evaluate((element, value) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, String(value));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return Number(input.value);
      }, midpoint);

    const caption = (await page.getByText(/· feather/i).first().textContent()) ?? "";
    const blended = Number(/([\d.]+)px/.exec(caption)?.[1] ?? "0");
    const span = edited.keyframes[1].time - edited.keyframes[0].time;
    const t = span > 0 ? (scrubbed - edited.keyframes[0].time) / span : 0;
    const firstFeather = edited.keyframes[0].feathering ?? planned.maskFeathering ?? 0;
    // Strictly between the two keyframes, and blended by exactly how far along
    // the scrub is — a step change at the keyframe would fail both.
    expect(t).toBeGreaterThan(0.2);
    expect(t).toBeLessThan(0.8);
    expect(Math.abs(blended - (firstFeather + (40 - firstFeather) * t))).toBeLessThan(1);
    await page.screenshot({ path: outputPath("09-keyframe-edge-scrubbed.png") });

    // Reset drops the override instead of pinning it to the current value.
    await page.getByRole("button", { name: "Reset keyframe 2 edge" }).click();
    await expect
      .poll(async () => (await readMask()).keyframes[1]?.feathering, {
        message: "reset should hand the keyframe back to the mask's own feather",
        timeout: 30_000,
      })
      .toBeNull();
  });
});
