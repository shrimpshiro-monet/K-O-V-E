import type { TransitionType, TransitionParams } from "../types/effects";
import type { Transition, Clip, Track, TransitionEdge } from "../types/timeline";

export interface TransitionRenderResult {
  frame: ImageBitmap;
  processingTime: number;
  gpuAccelerated: boolean;
}

export interface TransitionValidationResult {
  valid: boolean;
  error?: string;
  maxDuration?: number;
  warning?: string;
}

export interface TransitionEngineConfig {
  width: number;
  height: number;
  useGPU?: boolean;
}

type EasingFunction = (t: number) => number;

export class TransitionEngine {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private width: number;
  private height: number;
  private initialized = false;
  // Two reusable letterbox scratch canvases (outgoing + incoming are both live
  // during a blend, so they cannot share one). Kept as canvases — not
  // ImageBitmaps — so fitting costs zero createImageBitmap per frame.
  private scratchA: OffscreenCanvas | null = null;
  private scratchACtx: OffscreenCanvasRenderingContext2D | null = null;
  private scratchB: OffscreenCanvas | null = null;
  private scratchBCtx: OffscreenCanvasRenderingContext2D | null = null;
  private pixelScratch: OffscreenCanvas | null = null;
  private pixelScratchCtx: OffscreenCanvasRenderingContext2D | null = null;
  // Reduced-resolution mask canvas for keyed reveals (luma wipe, pixel sort).
  // The key is computed at ~1/8 resolution and upscaled with smoothing, which
  // is where the soft edge comes from — and it keeps per-pixel work off the
  // full-resolution frame.
  private maskScratch: OffscreenCanvas | null = null;
  private maskScratchCtx: OffscreenCanvasRenderingContext2D | null = null;
  // Full-size layer canvas used to composite a masked copy of a frame.
  private layerScratch: OffscreenCanvas | null = null;
  private layerScratchCtx: OffscreenCanvasRenderingContext2D | null = null;

  constructor(config: TransitionEngineConfig) {
    this.width = config.width;
    this.height = config.height;
    // Lazy initialization for environments without OffscreenCanvas (e.g., Node.js tests)
    this.initializeCanvas();
  }

  private initializeCanvas(): void {
    if (this.initialized) return;

    try {
      if (typeof OffscreenCanvas !== "undefined") {
        this.canvas = new OffscreenCanvas(this.width, this.height);
        this.ctx = this.canvas.getContext("2d");
      }
    } catch {
      // OffscreenCanvas not available (Node.js environment)
      this.canvas = null;
      this.ctx = null;
    }

    this.initialized = true;
  }

  private getContext(): OffscreenCanvasRenderingContext2D {
    if (!this.ctx) {
      throw new Error("Canvas context not available");
    }
    return this.ctx;
  }

  private sourceDimensions(source: CanvasImageSource): {
    width: number;
    height: number;
  } {
    if (
      typeof HTMLVideoElement !== "undefined" &&
      source instanceof HTMLVideoElement
    ) {
      return { width: source.videoWidth, height: source.videoHeight };
    }
    const dims = source as { width?: number; height?: number };
    return { width: dims.width ?? 0, height: dims.height ?? 0 };
  }

  // Letterbox (contain) a source frame into an engine-sized scratch canvas so
  // the per-transition geometry — which assumes inputs already fill the canvas
  // — preserves the source aspect ratio instead of stretching it. Returns the
  // original frame untouched when it is already engine-sized (e.g. the scrub
  // path pre-letterboxes). Uses a reusable scratch canvas (no createImageBitmap)
  // so it is cheap to run every frame during playback/export.
  private fitToCanvas(
    source: CanvasImageSource,
    slot: "A" | "B",
  ): CanvasImageSource {
    const { width: sourceWidth, height: sourceHeight } =
      this.sourceDimensions(source);
    if (sourceWidth === this.width && sourceHeight === this.height) {
      return source;
    }
    if (typeof OffscreenCanvas === "undefined") {
      return source;
    }
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return source;
    }

    let scratch = slot === "A" ? this.scratchA : this.scratchB;
    let scratchCtx = slot === "A" ? this.scratchACtx : this.scratchBCtx;
    if (!scratch || scratch.width !== this.width || scratch.height !== this.height) {
      scratch = new OffscreenCanvas(this.width, this.height);
      scratchCtx = scratch.getContext("2d");
      if (slot === "A") {
        this.scratchA = scratch;
        this.scratchACtx = scratchCtx;
      } else {
        this.scratchB = scratch;
        this.scratchBCtx = scratchCtx;
      }
    }
    if (!scratchCtx) {
      return source;
    }

    const sourceAspect = sourceWidth / sourceHeight;
    const canvasAspect = this.width / this.height;
    let drawWidth: number;
    let drawHeight: number;
    if (sourceAspect > canvasAspect) {
      drawWidth = this.width;
      drawHeight = this.width / sourceAspect;
    } else {
      drawHeight = this.height;
      drawWidth = this.height * sourceAspect;
    }
    const drawX = (this.width - drawWidth) / 2;
    const drawY = (this.height - drawHeight) / 2;

    scratchCtx.clearRect(0, 0, this.width, this.height);
    scratchCtx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
    return scratch;
  }

  async renderTransition(
    outgoingFrame: CanvasImageSource,
    incomingFrame: CanvasImageSource,
    transition: Transition,
    progress: number,
  ): Promise<TransitionRenderResult> {
    const startTime = performance.now();
    const canvas = await this.renderTransitionToCanvas(
      outgoingFrame,
      incomingFrame,
      transition,
      progress,
    );
    const frame = await createImageBitmap(canvas);

    return {
      frame,
      processingTime: performance.now() - startTime,
      gpuAccelerated: false, // Canvas 2D is not GPU accelerated
    };
  }

  async renderTransitionToCanvas(
    outgoingFrame: CanvasImageSource,
    incomingFrame: CanvasImageSource,
    transition: Transition,
    progress: number,
  ): Promise<OffscreenCanvas> {
    if (!this.canvas || !this.ctx) {
      throw new Error(
        "Canvas not available. Rendering requires a browser environment.",
      );
    }
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const easedProgress = this.applyEasing(
      clampedProgress,
      transition.params.curve as string,
    );

    // Letterbox both inputs to the engine canvas first so a clip whose aspect
    // differs from the project (e.g. a portrait clip in a landscape project)
    // keeps its orientation through the transition instead of being stretched
    // to fill. The scrub path already passes engine-sized frames, so this is a
    // no-op there; the multitrack-preview and export paths pass native frames.
    const outgoing = this.fitToCanvas(outgoingFrame, "A");
    const incoming = this.fitToCanvas(incomingFrame, "B");

    this.ctx.clearRect(0, 0, this.width, this.height);
    switch (transition.type) {
      case "crossfade":
        await this.renderCrossfade(outgoing, incoming, easedProgress);
        break;
      case "dipToBlack":
        await this.renderDipToColor(
          outgoing,
          incoming,
          easedProgress,
          "black",
          (transition.params.holdDuration as number) || 0,
        );
        break;
      case "dipToWhite":
        await this.renderDipToColor(
          outgoing,
          incoming,
          easedProgress,
          "white",
          (transition.params.holdDuration as number) || 0,
        );
        break;
      case "wipe":
        await this.renderWipe(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) || "left",
          (transition.params.softness as number) || 0,
        );
        break;
      case "slide":
        await this.renderSlide(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) || "left",
          (transition.params.pushOut as boolean) || false,
        );
        break;
      case "zoom":
        await this.renderZoom(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.scale as number) || 2,
          (transition.params.center as { x: number; y: number }) || {
            x: 0.5,
            y: 0.5,
          },
        );
        break;
      case "push":
        await this.renderPush(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) || "left",
        );
        break;
      case "circleReveal":
        await this.renderCircleReveal(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.center as { x: number; y: number }) || {
            x: 0.5,
            y: 0.5,
          },
        );
        break;
      case "blur":
        await this.renderBlur(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) ?? 1,
        );
        break;
      case "whipPan":
        await this.renderWhipPan(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) || "left",
          (transition.params.blurIntensity as number) ?? 1,
        );
        break;
      case "radialWipe":
        await this.renderRadialWipe(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.startAngle as number) ?? -90,
          (transition.params.clockwise as boolean) ?? true,
        );
        break;
      case "pixelate":
        await this.renderPixelate(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.maxPixelSize as number) || 48,
        );
        break;
      case "glitch":
        await this.renderGlitch(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) || 0.08,
          (transition.params.slices as number) || 12,
        );
        break;
      case "blinds":
        await this.renderBlinds(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.count as number) || 8,
          (transition.params.direction as string) || "vertical",
        );
        break;
      case "diamondReveal":
        await this.renderDiamondReveal(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.center as { x: number; y: number }) || {
            x: 0.5,
            y: 0.5,
          },
        );
        break;
      case "spin":
        await this.renderSpin(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.rotations as number) ?? 1,
        );
        break;
      case "flip":
        await this.renderFlip(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.axis as string) || "horizontal",
        );
        break;
      case "splitReveal":
        await this.renderSplitReveal(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.orientation as string) || "horizontal",
        );
        break;
      case "flash":
        await this.renderFlash(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) ?? 1,
        );
        break;
      case "filmBurn":
        await this.renderFilmBurn(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) ?? 1,
          (transition.params.warmth as number) ?? 0.75,
        );
        break;
      case "mosaic":
        await this.renderMosaic(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.tiles as number) ?? 8,
          (transition.params.randomness as number) ?? 0.85,
        );
        break;
      case "ripple":
        await this.renderRipple(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.amplitude as number) ?? 0.04,
          (transition.params.waves as number) ?? 3,
        );
        break;
      case "pageTurn":
        await this.renderPageTurn(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) || "left",
          (transition.params.shadow as number) ?? 0.55,
        );
        break;
      case "crossZoom":
        await this.renderCrossZoom(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.strength as number) ?? 2.2,
          (transition.params.center as { x: number; y: number }) ?? { x: 0.5, y: 0.5 },
        );
        break;
      case "zoomBlur":
        await this.renderZoomBlur(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.streaks as number) ?? 12,
          (transition.params.strength as number) ?? 0.35,
        );
        break;
      case "motionSmear":
        await this.renderMotionSmear(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) ?? "left",
          (transition.params.distance as number) ?? 0.25,
        );
        break;
      case "strobeCut":
        await this.renderStrobeCut(
          outgoing,
          incoming,
          clampedProgress,
          (transition.params.strobes as number) ?? 6,
        );
        break;
      case "impactShake":
        await this.renderImpactShake(
          outgoing,
          incoming,
          clampedProgress,
          (transition.params.intensity as number) ?? 1,
          (transition.params.flash as number) ?? 0.55,
        );
        break;
      case "lumaWipe":
        await this.renderLumaWipe(
          outgoing,
          incoming,
          clampedProgress,
          (transition.params.softness as number) ?? 0.25,
          (transition.params.invert as boolean) ?? false,
        );
        break;
      case "inkBleed":
        await this.renderInkBleed(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.lobes as number) ?? 7,
          (transition.params.softness as number) ?? 0.35,
          (transition.params.center as { x: number; y: number }) ?? { x: 0.5, y: 0.5 },
        );
        break;
      case "tileFlip":
        await this.renderTileFlip(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.columns as number) ?? 6,
          (transition.params.stagger as number) ?? 0.6,
          (transition.params.axis as string) ?? "horizontal",
        );
        break;
      case "sliceSlide":
        await this.renderSliceSlide(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.slices as number) ?? 9,
          (transition.params.direction as string) ?? "left",
          (transition.params.gap as number) ?? 0,
        );
        break;
      case "lightLeak":
        await this.renderLightLeak(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) ?? 1,
          (transition.params.warmth as number) ?? 0.7,
          (transition.params.direction as string) ?? "right",
        );
        break;
      case "vhsScan":
        await this.renderVhsScan(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.intensity as number) ?? 0.8,
          (transition.params.slices as number) ?? 14,
        );
        break;
      case "paperBurn":
        await this.renderPaperBurn(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.softness as number) ?? 0.3,
          (transition.params.center as { x: number; y: number }) ?? { x: 0.5, y: 0.5 },
        );
        break;
      case "pixelSort":
        await this.renderPixelSort(
          outgoing,
          incoming,
          clampedProgress,
          (transition.params.amount as number) ?? 1,
          (transition.params.threshold as number) ?? 0.55,
          (transition.params.direction as string) ?? "right",
        );
        break;
      case "filmRoll":
        await this.renderFilmRoll(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.direction as string) ?? "up",
          (transition.params.barWidth as number) ?? 0.06,
        );
        break;
      case "colorSplit":
        await this.renderColorSplit(
          outgoing,
          incoming,
          easedProgress,
          (transition.params.maxOffset as number) ?? 18,
          (transition.params.angle as number) ?? 0,
        );
        break;
      default:
        await this.renderCrossfade(outgoing, incoming, easedProgress);
    }

    return this.canvas;
  }

  private async renderCrossfade(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
  ): Promise<void> {
    const ctx = this.getContext();
    // Draw outgoing frame with decreasing opacity
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(outgoing, 0, 0, this.width, this.height);

    // Draw incoming frame with increasing opacity
    ctx.globalAlpha = progress;
    ctx.drawImage(incoming, 0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
  }

  private async renderDipToColor(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    color: "black" | "white",
    holdDuration: number,
  ): Promise<void> {
    // Total transition: fade out -> hold -> fade in
    const totalPhases = 2 + holdDuration;
    const fadeOutEnd = 1 / totalPhases;
    const holdEnd = (1 + holdDuration) / totalPhases;

    const ctx = this.getContext();
    if (progress < fadeOutEnd) {
      // Fade out phase
      const fadeProgress = progress / fadeOutEnd;
      ctx.drawImage(outgoing, 0, 0, this.width, this.height);
      ctx.fillStyle = color;
      ctx.globalAlpha = fadeProgress;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    } else if (progress < holdEnd) {
      // Hold phase - solid color
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, this.width, this.height);
    } else {
      // Fade in phase
      const fadeProgress = (progress - holdEnd) / (1 - holdEnd);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = fadeProgress;
      ctx.drawImage(incoming, 0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
  }

  private async renderWipe(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    softness: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;

    // Outgoing is the base; the incoming frame is revealed inside a region
    // that grows from nothing (progress 0 → outgoing fully visible) to the
    // whole canvas (progress 1 → incoming fully visible). Each direction is the
    // edge the incoming frame wipes in from.
    ctx.drawImage(outgoing, 0, 0, w, h);
    const feather = Math.max(0, Math.min(1, softness));
    if (
      feather > 0 &&
      direction !== "diagonal" &&
      progress > 0 &&
      progress < 1
    ) {
      this.drawFeatheredWipe(incoming, progress, direction, feather);
      return;
    }
    if (progress >= 1) {
      ctx.drawImage(incoming, 0, 0, w, h);
      return;
    }
    ctx.save();
    ctx.beginPath();
    switch (direction) {
      case "right":
        ctx.rect(w * (1 - progress), 0, w * progress, h);
        break;
      case "up":
        ctx.rect(0, 0, w, h * progress);
        break;
      case "down":
        ctx.rect(0, h * (1 - progress), w, h * progress);
        break;
      case "diagonal": {
        const offset = (w + h) * progress;
        ctx.moveTo(0, 0);
        ctx.lineTo(offset, 0);
        ctx.lineTo(0, offset);
        ctx.closePath();
        break;
      }
      case "left":
      default:
        ctx.rect(0, 0, w * progress, h);
        break;
    }
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private drawFeatheredWipe(
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    softness: number,
  ): void {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const horizontal = direction === "left" || direction === "right";
    const length = horizontal ? w : h;
    const edge =
      direction === "right" || direction === "down"
        ? length * (1 - progress)
        : length * progress;
    const featherSize = Math.max(1, length * softness * 0.25);
    const slices = 20;

    const drawRegion = (
      start: number,
      end: number,
      alpha: number,
    ): void => {
      const clampedStart = Math.max(0, Math.min(length, start));
      const clampedEnd = Math.max(0, Math.min(length, end));
      if (clampedEnd <= clampedStart || alpha <= 0) return;
      ctx.save();
      ctx.beginPath();
      if (horizontal) {
        ctx.rect(clampedStart, 0, clampedEnd - clampedStart, h);
      } else {
        ctx.rect(0, clampedStart, w, clampedEnd - clampedStart);
      }
      ctx.clip();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(incoming, 0, 0, w, h);
      ctx.restore();
    };

    if (direction === "left" || direction === "up") {
      const featherStart = Math.max(0, edge - featherSize);
      drawRegion(0, featherStart, 1);
      for (let index = 0; index < slices; index += 1) {
        const start = featherStart + (edge - featherStart) * (index / slices);
        const end = featherStart + (edge - featherStart) * ((index + 1) / slices);
        drawRegion(start, end, 1 - (index + 0.5) / slices);
      }
      return;
    }

    const featherEnd = Math.min(length, edge + featherSize);
    for (let index = 0; index < slices; index += 1) {
      const start = edge + (featherEnd - edge) * (index / slices);
      const end = edge + (featherEnd - edge) * ((index + 1) / slices);
      drawRegion(start, end, (index + 0.5) / slices);
    }
    drawRegion(featherEnd, length, 1);
  }

  private async renderSlide(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    pushOut: boolean,
  ): Promise<void> {
    const ctx = this.getContext();
    let outX = 0,
      outY = 0,
      inX = 0,
      inY = 0;

    switch (direction) {
      case "left":
        inX = this.width * (1 - progress);
        if (pushOut) outX = -this.width * progress;
        break;
      case "right":
        inX = -this.width * (1 - progress);
        if (pushOut) outX = this.width * progress;
        break;
      case "up":
        inY = this.height * (1 - progress);
        if (pushOut) outY = -this.height * progress;
        break;
      case "down":
        inY = -this.height * (1 - progress);
        if (pushOut) outY = this.height * progress;
        break;
    }

    // Draw outgoing frame (possibly sliding out)
    if (pushOut || progress < 1) {
      ctx.drawImage(outgoing, outX, outY, this.width, this.height);
    }

    // Draw incoming frame sliding in
    ctx.drawImage(incoming, inX, inY, this.width, this.height);
  }

  private async renderZoom(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    scale: number,
    center: { x: number; y: number },
  ): Promise<void> {
    // Outgoing frame zooms in and fades out
    const outScale = 1 + (scale - 1) * progress;
    const outAlpha = 1 - progress;

    // Incoming frame zooms from small to normal
    const inScale = 1 / scale + (1 - 1 / scale) * progress;
    const inAlpha = progress;
    const centerX = this.width * center.x;
    const centerY = this.height * center.y;

    const ctx = this.getContext();
    // Draw outgoing with zoom
    ctx.save();
    ctx.globalAlpha = outAlpha;
    ctx.translate(centerX, centerY);
    ctx.scale(outScale, outScale);
    ctx.translate(-centerX, -centerY);
    ctx.drawImage(outgoing, 0, 0, this.width, this.height);
    ctx.restore();

    // Draw incoming with zoom
    ctx.save();
    ctx.globalAlpha = inAlpha;
    ctx.translate(centerX, centerY);
    ctx.scale(inScale, inScale);
    ctx.translate(-centerX, -centerY);
    ctx.drawImage(incoming, 0, 0, this.width, this.height);
    ctx.restore();
  }

  private async renderPush(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
  ): Promise<void> {
    // Push is like slide but both frames always move together
    await this.renderSlide(outgoing, incoming, progress, direction, true);
  }

  private async renderCircleReveal(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    center: { x: number; y: number },
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    const cx = w * Math.max(0, Math.min(1, center.x));
    const cy = h * Math.max(0, Math.min(1, center.y));
    const maxRadius = Math.max(
      Math.hypot(cx, cy),
      Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy),
      Math.hypot(w - cx, h - cy),
    );
    ctx.arc(cx, cy, maxRadius * progress, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private async renderBlur(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const maxBlur = Math.max(w, h) * 0.04 * Math.max(0, Math.min(2, intensity));
    const blurAmount = Math.sin(progress * Math.PI) * maxBlur;
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${blurAmount}px)`;
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.globalAlpha = progress;
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.filter = "none";
    ctx.globalAlpha = 1;
  }

  private async renderWhipPan(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    blurIntensity: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "right" || direction === "down" ? 1 : -1;
    const span = horizontal ? w : h;
    const outOffset = sign * span * progress;
    const inOffset = sign * span * (progress - 1);
    const blurAmount =
      Math.sin(progress * Math.PI) *
      (span * 0.06) *
      Math.max(0, Math.min(2, blurIntensity));

    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${blurAmount}px)`;
    if (horizontal) {
      ctx.drawImage(outgoing, outOffset, 0, w, h);
      ctx.drawImage(incoming, inOffset, 0, w, h);
    } else {
      ctx.drawImage(outgoing, 0, outOffset, w, h);
      ctx.drawImage(incoming, 0, inOffset, w, h);
    }
    ctx.filter = "none";
  }

  private async renderRadialWipe(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    startAngle: number,
    clockwise: boolean,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.hypot(w, h);
    const start = (startAngle * Math.PI) / 180;
    const direction = clockwise ? 1 : -1;
    ctx.moveTo(cx, cy);
    ctx.arc(
      cx,
      cy,
      radius,
      start,
      start + direction * Math.PI * 2 * progress,
      !clockwise,
    );
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private async renderPixelate(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    maxPixelSize: number,
  ): Promise<void> {
    if (typeof OffscreenCanvas === "undefined") {
      await this.renderCrossfade(outgoing, incoming, progress);
      return;
    }
    const pixelSize = Math.max(
      1,
      Math.round(1 + Math.sin(progress * Math.PI) * Math.max(1, maxPixelSize)),
    );
    const smallWidth = Math.max(1, Math.ceil(this.width / pixelSize));
    const smallHeight = Math.max(1, Math.ceil(this.height / pixelSize));
    if (!this.pixelScratch) {
      this.pixelScratch = new OffscreenCanvas(smallWidth, smallHeight);
      this.pixelScratchCtx = this.pixelScratch.getContext("2d");
    } else {
      this.pixelScratch.width = smallWidth;
      this.pixelScratch.height = smallHeight;
      this.pixelScratchCtx = this.pixelScratch.getContext("2d");
    }
    const pixelCtx = this.pixelScratchCtx;
    if (!pixelCtx) {
      await this.renderCrossfade(outgoing, incoming, progress);
      return;
    }
    pixelCtx.clearRect(0, 0, smallWidth, smallHeight);
    pixelCtx.globalAlpha = 1 - progress;
    pixelCtx.drawImage(outgoing, 0, 0, smallWidth, smallHeight);
    pixelCtx.globalAlpha = progress;
    pixelCtx.drawImage(incoming, 0, 0, smallWidth, smallHeight);
    pixelCtx.globalAlpha = 1;

    const ctx = this.getContext();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.pixelScratch, 0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = true;
  }

  private async renderGlitch(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
    slices: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    await this.renderCrossfade(outgoing, incoming, progress);
    const strength = Math.sin(progress * Math.PI) * Math.max(0, intensity) * w;
    const sliceCount = Math.max(4, Math.min(40, Math.round(slices)));
    ctx.globalAlpha = Math.min(0.8, 0.25 + Math.sin(progress * Math.PI) * 0.45);
    for (let index = 0; index < sliceCount; index += 1) {
      const y = Math.floor((index / sliceCount) * h);
      const nextY = Math.ceil(((index + 1) / sliceCount) * h);
      const sliceHeight = Math.max(1, nextY - y);
      const wave = Math.sin(index * 12.9898 + progress * 31.7);
      const offset = wave * strength;
      const source = (index + Math.floor(progress * 10)) % 2 === 0
        ? outgoing
        : incoming;
      ctx.drawImage(source, 0, y, w, sliceHeight, offset, y, w, sliceHeight);
    }
    ctx.globalAlpha = 1;
  }

  private async renderBlinds(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    count: number,
    direction: string,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const blindCount = Math.max(2, Math.min(32, Math.round(count)));
    const horizontal = direction === "horizontal";
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    if (horizontal) {
      const strip = h / blindCount;
      for (let index = 0; index < blindCount; index += 1) {
        ctx.rect(0, index * strip, w, strip * progress);
      }
    } else {
      const strip = w / blindCount;
      for (let index = 0; index < blindCount; index += 1) {
        ctx.rect(index * strip, 0, strip * progress, h);
      }
    }
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private async renderDiamondReveal(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    center: { x: number; y: number },
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const cx = w * Math.max(0, Math.min(1, center.x));
    const cy = h * Math.max(0, Math.min(1, center.y));
    const radius =
      Math.max(cx + cy, w - cx + cy, cx + h - cy, w - cx + h - cy) *
      progress;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx + radius, cy);
    ctx.lineTo(cx, cy + radius);
    ctx.lineTo(cx - radius, cy);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private async renderSpin(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    rotations: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const cx = this.width / 2;
    const cy = this.height / 2;
    const turn = Math.PI * 2 * rotations;
    const draw = (
      source: CanvasImageSource,
      alpha: number,
      scale: number,
      rotation: number,
    ) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      ctx.drawImage(source, 0, 0, this.width, this.height);
      ctx.restore();
    };
    draw(outgoing, 1 - progress, Math.max(0.05, 1 - progress * 0.75), turn * progress);
    draw(
      incoming,
      progress,
      0.25 + progress * 0.75,
      turn * (progress - 1),
    );
  }

  private async renderFlip(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    axis: string,
  ): Promise<void> {
    const ctx = this.getContext();
    const horizontal = axis !== "vertical";
    const firstHalf = progress < 0.5;
    const phase = firstHalf ? 1 - progress * 2 : (progress - 0.5) * 2;
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(horizontal ? Math.max(0.001, phase) : 1, horizontal ? 1 : Math.max(0.001, phase));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.drawImage(firstHalf ? outgoing : incoming, 0, 0, this.width, this.height);
    ctx.restore();
  }

  private async renderSplitReveal(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    orientation: string,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    if (orientation === "vertical") {
      const halfHeight = (h * progress) / 2;
      ctx.rect(0, h / 2 - halfHeight, w, halfHeight);
      ctx.rect(0, h / 2, w, halfHeight);
    } else {
      const halfWidth = (w * progress) / 2;
      ctx.rect(w / 2 - halfWidth, 0, halfWidth, h);
      ctx.rect(w / 2, 0, halfWidth, h);
    }
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  private async renderFlash(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
  ): Promise<void> {
    await this.renderCrossfade(outgoing, incoming, progress);
    const ctx = this.getContext();
    ctx.save();
    ctx.fillStyle = "white";
    ctx.globalAlpha = Math.min(1, Math.max(0, intensity) * Math.sin(progress * Math.PI));
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private async renderFilmBurn(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
    warmth: number,
  ): Promise<void> {
    await this.renderCrossfade(outgoing, incoming, progress);
    const ctx = this.getContext();
    const peak = Math.sin(progress * Math.PI);
    const clampedIntensity = Math.max(0, Math.min(2, intensity));
    const clampedWarmth = Math.max(0, Math.min(1, warmth));
    const burnRed = Math.round(70 + clampedWarmth * 185);
    const burnGreen = Math.round(180 - clampedWarmth * 105);
    const burnBlue = Math.round(255 - clampedWarmth * 240);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = `rgb(${burnRed}, ${burnGreen}, ${burnBlue})`;
    ctx.globalAlpha = Math.min(1, peak * clampedIntensity * 0.9);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = "white";
    ctx.globalAlpha = Math.min(0.8, peak * peak * clampedIntensity * 0.55);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private async renderMosaic(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    tiles: number,
    randomness: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    ctx.drawImage(outgoing, 0, 0, w, h);
    if (progress <= 0) return;
    if (progress >= 1) {
      ctx.drawImage(incoming, 0, 0, w, h);
      return;
    }

    const columns = Math.max(2, Math.min(24, Math.round(tiles)));
    const rows = Math.max(2, Math.round(columns * (h / w)));
    const tileWidth = w / columns;
    const tileHeight = h / rows;
    const randomMix = Math.max(0, Math.min(1, randomness));

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const order =
          (row * columns + column) / Math.max(1, rows * columns - 1);
        const random = Math.abs(
          Math.sin((column + 1) * 12.9898 + (row + 1) * 78.233) * 43758.5453,
        ) % 1;
        const threshold = order * (1 - randomMix) + random * randomMix;
        if (progress < threshold) continue;
        const x = column * tileWidth;
        const y = row * tileHeight;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, Math.ceil(tileWidth) + 1, Math.ceil(tileHeight) + 1);
        ctx.clip();
        ctx.drawImage(incoming, 0, 0, w, h);
        ctx.restore();
      }
    }
  }

  private async renderRipple(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    amplitude: number,
    waves: number,
  ): Promise<void> {
    if (progress <= 0) {
      this.getContext().drawImage(outgoing, 0, 0, this.width, this.height);
      return;
    }
    if (progress >= 1) {
      this.getContext().drawImage(incoming, 0, 0, this.width, this.height);
      return;
    }

    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const slices = 32;
    const sliceHeight = h / slices;
    const displacement = Math.max(0, Math.min(0.2, amplitude)) * w;
    const waveCount = Math.max(0.5, Math.min(12, waves));
    ctx.clearRect(0, 0, w, h);
    for (let index = 0; index < slices; index += 1) {
      const y = index * sliceHeight;
      const phase = (index / slices) * Math.PI * 2 * waveCount;
      const offset =
        Math.sin(phase + progress * Math.PI * 2) *
        displacement *
        Math.sin(progress * Math.PI);
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(
        outgoing,
        0,
        y,
        w,
        sliceHeight + 1,
        offset,
        y,
        w,
        sliceHeight + 1,
      );
      ctx.globalAlpha = progress;
      ctx.drawImage(
        incoming,
        0,
        y,
        w,
        sliceHeight + 1,
        -offset,
        y,
        w,
        sliceHeight + 1,
      );
    }
    ctx.globalAlpha = 1;
  }

  private async renderPageTurn(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    shadow: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    if (progress <= 0) {
      ctx.drawImage(outgoing, 0, 0, w, h);
      return;
    }
    if (progress >= 1) {
      ctx.drawImage(incoming, 0, 0, w, h);
      return;
    }
    const remaining = Math.max(0.001, 1 - progress);
    const turnLeft = direction !== "right";
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.save();
    if (turnLeft) {
      ctx.scale(remaining, 1);
    } else {
      ctx.translate(w, 0);
      ctx.scale(remaining, 1);
      ctx.translate(-w, 0);
    }
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.restore();

    const foldX = turnLeft ? w * remaining : w * progress;
    const shadowWidth = Math.max(2, w * 0.035);
    ctx.save();
    ctx.fillStyle = "black";
    ctx.globalAlpha =
      Math.max(0, Math.min(1, shadow)) *
      Math.sin(progress * Math.PI) *
      0.65;
    ctx.fillRect(
      turnLeft ? foldX - shadowWidth : foldX,
      0,
      shadowWidth,
      h,
    );
    ctx.restore();
  }

  private async renderColorSplit(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    maxOffset: number,
    angle: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const peak = Math.sin(progress * Math.PI);
    const offset = Math.max(0, Math.min(80, maxOffset)) * peak;
    const radians = (angle * Math.PI) / 180;
    const dx = Math.cos(radians) * offset;
    const dy = Math.sin(radians) * offset;

    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.globalAlpha = progress;
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = peak * 0.24;
    ctx.drawImage(outgoing, -dx, -dy, w, h);
    ctx.drawImage(incoming, dx, dy, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Reduced-resolution mask canvas (default 1/8 of the engine size, capped at
   * 320px wide). Returns null when OffscreenCanvas or ImageData is unavailable
   * so callers can fall back to a non-keyed path instead of throwing.
   */
  private getMaskContext(
    scale: number = 8,
    width: number = this.width,
    height: number = this.height,
  ): { ctx: OffscreenCanvasRenderingContext2D; width: number; height: number } | null {
    if (typeof OffscreenCanvas === "undefined") return null;
    const maskWidth = Math.max(2, Math.min(320, Math.ceil(width / scale)));
    const maskHeight = Math.max(2, Math.ceil((maskWidth * height) / Math.max(1, width)));
    let canvas = this.maskScratch;
    let ctx = this.maskScratchCtx;
    if (!canvas || canvas.width !== maskWidth || canvas.height !== maskHeight) {
      canvas = new OffscreenCanvas(maskWidth, maskHeight);
      ctx = canvas.getContext("2d");
      this.maskScratch = canvas;
      this.maskScratchCtx = ctx;
    }
    if (!ctx || typeof ctx.getImageData !== "function") return null;
    return { ctx, width: maskWidth, height: maskHeight };
  }

  /** Engine-sized scratch canvas for compositing a masked copy of a frame. */
  private getLayerContext(): OffscreenCanvasRenderingContext2D | null {
    if (typeof OffscreenCanvas === "undefined") return null;
    if (
      !this.layerScratch ||
      this.layerScratch.width !== this.width ||
      this.layerScratch.height !== this.height
    ) {
      this.layerScratch = new OffscreenCanvas(this.width, this.height);
      this.layerScratchCtx = this.layerScratch.getContext("2d");
    }
    return this.layerScratchCtx;
  }

  /** Draw the incoming frame through a mask, leaving the outgoing frame visible beneath. */
  private compositeMaskedIncoming(
    incoming: CanvasImageSource,
    mask: CanvasImageSource,
  ): void {
    const layer = this.getLayerContext();
    const ctx = this.getContext();
    if (!layer) {
      ctx.drawImage(incoming, 0, 0, this.width, this.height);
      return;
    }
    layer.save();
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "copy";
    layer.filter = "none";
    layer.globalAlpha = 1;
    layer.drawImage(incoming, 0, 0, this.width, this.height);
    layer.globalCompositeOperation = "destination-in";
    layer.drawImage(mask, 0, 0, this.width, this.height);
    layer.globalCompositeOperation = "source-over";
    layer.restore();
    ctx.drawImage(this.layerScratch as unknown as CanvasImageSource, 0, 0, this.width, this.height);
  }

  /**
   * Punchy cross-zoom: the outgoing frame accelerates into the lens while the
   * incoming frame rushes out of it, then both settle. The signature "whip
   * zoom" of high-retention short-form edits.
   */
  private async renderCrossZoom(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    strength: number,
    center: { x: number; y: number },
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const cx = w * Math.max(0, Math.min(1, center.x));
    const cy = h * Math.max(0, Math.min(1, center.y));
    const punch = Math.max(1.05, Math.min(4, strength));
    const eased = progress * progress * (3 - 2 * progress);
    const outScale = 1 + (punch - 1) * eased;
    const inScale = 1 - (1 - 1 / punch) * (1 - eased);
    // A touch of blur at the peak sells the acceleration.
    const blur = Math.sin(progress * Math.PI) * (w * 0.012) * (punch - 1);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - progress * 1.35);
    ctx.filter = blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : "none";
    ctx.translate(cx, cy);
    ctx.scale(outScale, outScale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, (progress - 0.12) * 1.35));
    ctx.filter = blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : "none";
    ctx.translate(cx, cy);
    ctx.scale(inScale, inScale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
    ctx.filter = "none";
    ctx.globalAlpha = 1;
  }

  /**
   * Zoom blur: the same frame drawn in concentric steps while scaling, which
   * reads as a radial streak towards (or away from) the centre.
   */
  private async renderZoomBlur(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    streaks: number,
    strength: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const steps = Math.max(4, Math.min(24, Math.round(streaks)));
    const reach = Math.max(0.02, Math.min(0.6, strength)) * Math.sin(progress * Math.PI);
    const cx = w / 2;
    const cy = h / 2;
    // Fade at the midpoint, then streak the incoming frame back in.
    const crossAt = 0.5;
    const drawStreaked = (source: CanvasImageSource, baseAlpha: number, direction: number) => {
      for (let index = 0; index < steps; index += 1) {
        const t = index / (steps - 1);
        const scale = 1 + reach * t * direction;
        ctx.save();
        ctx.globalAlpha = baseAlpha / steps;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
        ctx.drawImage(source, 0, 0, w, h);
        ctx.restore();
      }
    };
    ctx.clearRect(0, 0, w, h);
    if (progress < crossAt) {
      const local = progress / crossAt;
      drawStreaked(outgoing, 1 - local * 0.35, 1);
      if (local > 0.5) {
        drawStreaked(incoming, (local - 0.5) * 2 * 0.5, -1);
      }
      return;
    }
    const local = (progress - crossAt) / (1 - crossAt);
    drawStreaked(incoming, 0.35 + local * 0.65, 1);
  }

  /**
   * Motion smear: both frames hold position while a directional smear ramps up
   * and back down. This is the "whip" look without the travel of a whip pan.
   */
  private async renderMotionSmear(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    distance: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "right" || direction === "down" ? 1 : -1;
    const span = horizontal ? w : h;
    const travel = Math.max(0, Math.min(0.6, distance)) * span * Math.sin(progress * Math.PI);
    const steps = 9;
    const crossAt = 0.5;
    const incomingAlpha = Math.max(0, (progress - crossAt) * 2);
    const outgoingAlpha = Math.max(0, 1 - (progress - crossAt) * 2);
    ctx.clearRect(0, 0, w, h);
    const drawSmear = (source: CanvasImageSource, alpha: number) => {
      if (alpha <= 0) return;
      for (let index = 0; index < steps; index += 1) {
        const offset = sign * travel * (index / (steps - 1) - 0.5);
        ctx.save();
        ctx.globalAlpha = (alpha / steps) * 1.6;
        if (horizontal) ctx.drawImage(source, offset, 0, w, h);
        else ctx.drawImage(source, 0, offset, w, h);
        ctx.restore();
      }
    };
    drawSmear(outgoing, outgoingAlpha);
    drawSmear(incoming, incomingAlpha);
    ctx.globalAlpha = 1;
  }

  /**
   * Strobe cut: the two frames alternate in a rapid strobe whose rate decays,
   * so the cut lands like a machine-gun flicker instead of a blend.
   */
  private async renderStrobeCut(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    strobes: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const count = Math.max(2, Math.min(24, Math.round(strobes)));
    // Front-load the flicker: by ~70% the alternation has resolved.
    const settled = progress >= 0.7;
    if (settled) {
      ctx.drawImage(incoming, 0, 0, this.width, this.height);
      return;
    }
    const phase = Math.floor((progress / 0.7) * count);
    const showIncoming = phase % 2 === 1;
    const hardCutAt = 0.42;
    const source = showIncoming || progress > hardCutAt ? incoming : outgoing;
    ctx.drawImage(source, 0, 0, this.width, this.height);
    // A sliver of the other frame keeps the strobe legible at low frame rates.
    ctx.save();
    ctx.globalAlpha = 0.35 * Math.sin(progress * Math.PI);
    ctx.drawImage(showIncoming ? outgoing : incoming, 0, 0, this.width, this.height);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Impact shake: a decaying camera shake plus a light flash on the cut. */
  private async renderImpactShake(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
    flash: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const power = Math.pow(1 - progress, 2) * Math.max(0, Math.min(2, intensity));
    const amplitude = w * 0.035 * power;
    const dx = Math.sin(progress * 46.1) * amplitude;
    const dy = Math.cos(progress * 38.7) * amplitude * (h / Math.max(1, w)) * 2;
    const zoom = 1 + 0.04 * power;
    await this.renderCrossfade(outgoing, incoming, progress);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, flash) * Math.pow(1 - progress, 3));
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    // Re-draw the blended pair shaken, so the shake reads on the pixels rather
    // than on a black background.
    ctx.save();
    ctx.globalAlpha = 0.55 * power;
    ctx.translate(dx, dy);
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-w / 2, -h / 2);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Luma wipe: the incoming frame is revealed wherever the outgoing frame is
   * darker than a rising threshold, so the cut follows the brightness of the
   * footage instead of a geometric edge.
   */
  private async renderLumaWipe(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    softness: number,
    invert: boolean,
  ): Promise<void> {
    const ctx = this.getContext();
    const mask = this.getMaskContext();
    if (!mask) {
      await this.renderWipe(outgoing, incoming, progress, "left", softness);
      return;
    }
    ctx.drawImage(outgoing, 0, 0, this.width, this.height);
    mask.ctx.save();
    mask.ctx.globalCompositeOperation = "copy";
    mask.ctx.filter = "none";
    mask.ctx.drawImage(outgoing, 0, 0, mask.width, mask.height);
    mask.ctx.restore();
    let image: ImageData;
    try {
      image = mask.ctx.getImageData(0, 0, mask.width, mask.height);
    } catch {
      await this.renderWipe(outgoing, incoming, progress, "left", softness);
      return;
    }
    const data = image.data;
    const feather = Math.max(0.02, Math.min(0.8, softness));
    const threshold = invert
      ? Math.max(0, Math.min(1, progress)) * (1 + feather) - feather
      : 1 - Math.max(0, Math.min(1, progress)) * (1 + feather) + feather;
    for (let index = 0; index < data.length; index += 4) {
      const luma = (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
      const reveal = invert ? luma : 1 - luma;
      const alpha = Math.max(0, Math.min(1, (reveal - threshold) / feather + 0.5));
      const value = Math.round(alpha * 255);
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = value;
    }
    mask.ctx.putImageData(image, 0, 0);
    this.compositeMaskedIncoming(incoming, this.maskScratch as unknown as CanvasImageSource);
  }

  /**
   * Ink bleed: overlapping irregular lobes grow from a point like ink soaking
   * through paper, so the reveal has an organic, hand-drawn edge.
   */
  private async renderInkBleed(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    lobes: number,
    softness: number,
    center: { x: number; y: number },
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const cx = w * Math.max(0, Math.min(1, center.x));
    const cy = h * Math.max(0, Math.min(1, center.y));
    const count = Math.max(3, Math.min(16, Math.round(lobes)));
    const reach = Math.hypot(w, h) * 1.15 * progress;
    const feather = Math.max(0.05, Math.min(0.9, softness));
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.75 + feather * 0.25);
    ctx.beginPath();
    for (let index = 0; index < count; index += 1) {
      const jitterX = Math.sin(index * 91.7) * 0.5;
      const jitterY = Math.cos(index * 47.3) * 0.5;
      const radius = reach * (0.55 + 0.45 * Math.abs(Math.sin(index * 13.3))) * (1 - feather * 0.25);
      ctx.moveTo(cx + jitterX * reach + radius, cy + jitterY * reach);
      ctx.arc(cx + jitterX * reach, cy + jitterY * reach, Math.max(1, radius), 0, Math.PI * 2);
    }
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
  }

  /**
   * Tile flip: a grid of tiles flips about its own axis with a staggered
   * start, so the incoming frame assembles like a wall of flipping cards.
   */
  private async renderTileFlip(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    columns: number,
    stagger: number,
    axis: string,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const cols = Math.max(2, Math.min(16, Math.round(columns)));
    const rows = Math.max(2, Math.round(cols * (h / w)));
    const tileW = w / cols;
    const tileH = h / rows;
    const spread = Math.max(0, Math.min(0.9, stagger));
    const horizontal = axis !== "vertical";

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < cols; column += 1) {
        const order = (row * cols + column) / Math.max(1, rows * cols - 1);
        // Stagger widens the window each tile flips in.
        const start = order * spread;
        const local = Math.max(0, Math.min(1, (progress - start) / Math.max(0.001, 1 - spread)));
        const phase = Math.abs(1 - local * 2);
        const squeeze = Math.max(0.02, phase);
        const front = local < 0.5 ? outgoing : incoming;
        const x = column * tileW;
        const y = row * tileH;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, Math.ceil(tileW) + 1, Math.ceil(tileH) + 1);
        ctx.clip();
        ctx.translate(x + tileW / 2, y + tileH / 2);
        ctx.scale(horizontal ? squeeze : 1, horizontal ? 1 : squeeze);
        ctx.translate(-(x + tileW / 2), -(y + tileH / 2));
        ctx.drawImage(front, 0, 0, w, h);
        ctx.restore();
      }
    }
  }

  /**
   * Slice slide: alternating horizontal or vertical bands of the incoming
   * frame slide in from opposite edges — the "shutter" wipe.
   */
  private async renderSliceSlide(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    slices: number,
    direction: string,
    gap: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const count = Math.max(3, Math.min(24, Math.round(slices)));
    const horizontal = direction === "left" || direction === "right";
    ctx.drawImage(outgoing, 0, 0, w, h);
    const band = (horizontal ? h : w) / count;
    const eased = progress * progress * (3 - 2 * progress);
    for (let index = 0; index < count; index += 1) {
      const even = index % 2 === 0;
      const travel = even ? eased : eased;
      const sign = even ? 1 : -1;
      const offset = sign * (1 - travel) * (horizontal ? w : h);
      const cross = (horizontal ? w : h) * sign * travel;
      ctx.save();
      ctx.beginPath();
      if (horizontal) ctx.rect(0, index * band, w, Math.ceil(band) + 1);
      else ctx.rect(index * band, 0, Math.ceil(band) + 1, h);
      ctx.clip();
      ctx.translate(horizontal ? cross : 0, horizontal ? 0 : cross);
      ctx.drawImage(incoming, horizontal ? offset - cross : 0, horizontal ? 0 : offset - cross, w, h);
      ctx.restore();
      if (gap > 0) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, gap);
        ctx.fillStyle = "black";
        if (horizontal) ctx.fillRect(0, index * band, w, 1);
        else ctx.fillRect(index * band, 0, 1, h);
        ctx.restore();
      }
    }
  }

  /** Light leak: a warm streak sweeps across the cut, screening the frames warm. */
  private async renderLightLeak(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
    warmth: number,
    direction: string,
  ): Promise<void> {
    await this.renderCrossfade(outgoing, incoming, progress);
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const power = Math.max(0, Math.min(2, intensity));
    const warm = Math.max(0, Math.min(1, warmth));
    const leftToRight = direction !== "left";
    const sweep = leftToRight ? progress : 1 - progress;
    const peak = Math.sin(progress * Math.PI);
    const red = Math.round(210 + warm * 45);
    const green = Math.round(120 + warm * 60);
    const blue = Math.round(255 - warm * 205);
    const gradient = ctx.createLinearGradient(
      leftToRight ? 0 : w,
      0,
      leftToRight ? w : 0,
      h,
    );
    gradient.addColorStop(Math.max(0, sweep - 0.35), "rgba(0,0,0,0)");
    gradient.addColorStop(Math.max(0, Math.min(1, sweep)), `rgba(${red}, ${green}, ${blue}, ${(0.85 * power * peak).toFixed(3)})`);
    gradient.addColorStop(Math.min(1, sweep + 0.35), "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = Math.min(1, peak * power * 0.35);
    ctx.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * VHS scan: a bright scanline sweep with horizontal jitter and chroma
   * fringing, like a tape spitting through the deck.
   */
  private async renderVhsScan(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    intensity: number,
    slices: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const power = Math.max(0, Math.min(2, intensity));
    await this.renderCrossfade(outgoing, incoming, progress);
    const sliceCount = Math.max(6, Math.min(32, Math.round(slices)));
    const sliceHeight = h / sliceCount;
    ctx.save();
    for (let index = 0; index < sliceCount; index += 1) {
      const y = index * sliceHeight;
      const wave = Math.sin(index * 12.9898 + progress * 24.0);
      const offset = wave * power * w * 0.02 * Math.sin(progress * Math.PI);
      const source = index % 2 === 0 ? outgoing : incoming;
      ctx.globalAlpha = 0.5;
      ctx.drawImage(source, 0, y, w, sliceHeight + 1, offset, y, w, sliceHeight + 1);
    }
    // Chroma fringe: the outgoing frame tinted red, the incoming tinted cyan.
    ctx.globalAlpha = Math.min(0.4, 0.18 * power) * Math.sin(progress * Math.PI);
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(outgoing, 2, 0, w, h);
    ctx.drawImage(incoming, -2, 0, w, h);
    // Scanline sweep.
    const sweepY = (1 - progress) * h;
    const gradient = ctx.createLinearGradient(0, sweepY - h * 0.12, 0, sweepY + h * 0.12);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.5, `rgba(255,255,255,${(0.22 * power).toFixed(3)})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Paper burn: a ragged ember-edged hole burns through the outgoing frame,
   * revealing the incoming frame inside it.
   */
  private async renderPaperBurn(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    softness: number,
    center: { x: number; y: number },
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const cx = w * Math.max(0, Math.min(1, center.x));
    const cy = h * Math.max(0, Math.min(1, center.y));
    const feather = Math.max(0.05, Math.min(0.9, softness));
    const reach = Math.hypot(w, h) * 1.2 * progress;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, reach * (1 - feather * 0.2)), 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(incoming, 0, 0, w, h);
    ctx.restore();
    // Charred, glowing edge.
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const ember = Math.sin(progress * Math.PI);
    ctx.strokeStyle = `rgba(255, ${Math.round(120 + 80 * (1 - progress))}, 40, ${(0.75 * ember).toFixed(3)})`;
    ctx.lineWidth = Math.max(2, h * 0.012 * (0.5 + feather));
    ctx.beginPath();
    for (let index = 0; index <= 48; index += 1) {
      const angle = (index / 48) * Math.PI * 2;
      const wobble = 1 + Math.sin(angle * 7 + progress * 9) * 0.05 + Math.sin(angle * 13) * 0.03;
      const radius = Math.max(1, reach * (1 - feather * 0.2) * wobble);
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(40, 12, 4, ${(0.45 * ember).toFixed(3)})`;
    ctx.lineWidth = Math.max(3, h * 0.02 * (0.5 + feather));
    ctx.stroke();
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Pixel sort: bright pixels are smeared along an axis, sorted-looking
   * streaking computed over a reduced-resolution copy so it stays cheap.
   */
  private async renderPixelSort(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    amount: number,
    threshold: number,
    direction: string,
  ): Promise<void> {
    const ctx = this.getContext();
    const mask = this.getMaskContext(6);
    if (!mask) {
      await this.renderCrossfade(outgoing, incoming, progress);
      return;
    }
    // Sort the outgoing frame first, then the incoming one, so the streaks
    // carry the cut instead of the cut erasing the streaks.
    const source = progress < 0.5 ? outgoing : incoming;
    mask.ctx.save();
    mask.ctx.globalCompositeOperation = "copy";
    mask.ctx.drawImage(source, 0, 0, mask.width, mask.height);
    mask.ctx.restore();
    let image: ImageData;
    try {
      image = mask.ctx.getImageData(0, 0, mask.width, mask.height);
    } catch {
      await this.renderCrossfade(outgoing, incoming, progress);
      return;
    }
    const data = image.data;
    const { width: mw, height: mh } = mask;
    const horizontal = direction === "left" || direction === "right";
    // `direction` is the direction the streaks TRAIL in: "right" drags each
    // bright pixel's colour to the right of it.
    const forward = direction === "right" || direction === "down" ? 1 : -1;
    const cutoff = Math.max(0.05, Math.min(0.95, threshold)) * 255;
    const reach = Math.max(0, Math.min(1, amount)) * 0.85;
    // Brightness is read from the ORIGINAL pixels: a pixel that only became
    // bright because a neighbouring streak dragged colour onto it must not
    // start its own streak (it has no bright colour of its own to drag).
    const copy = new Uint8ClampedArray(data);
    const sortable = (index: number): number =>
      copy[index] * 0.2126 + copy[index + 1] * 0.7152 + copy[index + 2] * 0.0722;
    const lines = horizontal ? mh : mw;
    const length = horizontal ? mw : mh;
    for (let line = 0; line < lines; line += 1) {
      const streak = Math.max(2, Math.round(reach * length * (0.35 + 0.65 * Math.abs(Math.sin(line * 7.13)))));
      for (let step = 0; step < length; step += 1) {
        const position = forward === 1 ? step : length - 1 - step;
        const sampleIndex = horizontal
          ? (line * mw + position) * 4
          : (position * mw + line) * 4;
        if (sortable(sampleIndex) < cutoff) continue;
        // Drag the bright colour along the axis until the streak budget runs
        // out or the axis ends.
        for (let offset = 1; offset < streak; offset += 1) {
          const targetStep = position + forward * offset;
          if (targetStep < 0 || targetStep >= length) break;
          const targetIndex = horizontal
            ? (line * mw + targetStep) * 4
            : (targetStep * mw + line) * 4;
          const falloff = 1 - offset / streak;
          data[targetIndex] = Math.round(copy[sampleIndex] * falloff + copy[targetIndex] * (1 - falloff));
          data[targetIndex + 1] = Math.round(copy[sampleIndex + 1] * falloff + copy[targetIndex + 1] * (1 - falloff));
          data[targetIndex + 2] = Math.round(copy[sampleIndex + 2] * falloff + copy[targetIndex + 2] * (1 - falloff));
        }
      }
    }
    mask.ctx.putImageData(image, 0, 0);
    // Both frames stay in the composite: the sorted streaks are drawn over a
    // fading crossfade, so the cut lands under the smear.
    await this.renderCrossfade(outgoing, incoming, progress);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.maskScratch as unknown as CanvasImageSource, 0, 0, this.width, this.height);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Film roll: the incoming frame rolls in through a projector gate while
   * sprocket bars run down the edges.
   */
  private async renderFilmRoll(
    outgoing: CanvasImageSource,
    incoming: CanvasImageSource,
    progress: number,
    direction: string,
    barWidth: number,
  ): Promise<void> {
    const ctx = this.getContext();
    const w = this.width;
    const h = this.height;
    const downwards = direction === "down";
    const travel = (downwards ? 1 : -1) * h * progress;
    ctx.drawImage(outgoing, 0, 0, w, h);
    ctx.drawImage(incoming, 0, downwards ? travel - h : h + travel, w, h);
    const bar = Math.max(0.02, Math.min(0.2, barWidth)) * w;
    const margin = Math.max(4, bar / 2);
    ctx.save();
    ctx.fillStyle = "rgba(8, 8, 10, 0.92)";
    ctx.fillRect(0, 0, margin, h);
    ctx.fillRect(w - margin, 0, margin, h);
    // Sprocket holes scrolling with the roll.
    const holeHeight = Math.max(8, h * 0.045);
    const holeWidth = margin * 0.6;
    const spacing = holeHeight * 2.1;
    const phase = ((progress * spacing * 2) % spacing) - spacing;
    ctx.fillStyle = "rgba(240, 240, 240, 0.85)";
    for (let y = phase; y < h + spacing; y += spacing) {
      ctx.fillRect(margin / 2 - holeWidth / 2, y, holeWidth, holeHeight);
      ctx.fillRect(w - margin / 2 - holeWidth / 2, y, holeWidth, holeHeight);
    }
    ctx.restore();
  }

  private applyEasing(progress: number, curve?: string): number {
    const easingFunctions: Record<string, EasingFunction> = {
      linear: (t) => t,
      ease: (t) => t * t * (3 - 2 * t), // Smoothstep
      "ease-in": (t) => t * t,
      "ease-out": (t) => t * (2 - t),
      "ease-in-out": (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    };

    const easing = easingFunctions[curve || "linear"] || easingFunctions.linear;
    return easing(progress);
  }

  validateTransition(
    clipA: Clip,
    clipB: Clip,
    duration: number,
  ): TransitionValidationResult {
    const clipAEnd = clipA.startTime + clipA.duration;
    const gap = Math.abs(clipB.startTime - clipAEnd);

    // Allow small tolerance for floating point errors
    if (gap > 0.001) {
      return {
        valid: false,
        error: "Clips must be adjacent to add a transition",
      };
    }
    if (clipA.trackId !== clipB.trackId) {
      return {
        valid: false,
        error: "Clips must be on the same track",
      };
    }

    // For a center-on-cut transition the window extends ±duration/2 around
    // the cut, so duration cannot exceed twice either clip's visible length.
    // We can't validate source-media handles without media metadata, so we
    // bound by the visible ranges and let the decoder clamp to edge frames
    // when the transition extends past a clip's range.
    const maxDuration = Math.min(clipA.duration, clipB.duration) * 2;

    if (duration > maxDuration) {
      return {
        valid: true,
        warning: `Insufficient handle frames. Maximum transition duration is ${maxDuration.toFixed(
          2,
        )}s`,
        maxDuration,
      };
    }

    if (duration <= 0) {
      return {
        valid: false,
        error: "Transition duration must be positive",
      };
    }

    return {
      valid: true,
      maxDuration,
    };
  }

  validateClipEdgeTransition(
    clip: Clip,
    duration: number,
  ): TransitionValidationResult {
    if (duration <= 0) {
      return {
        valid: false,
        error: "Transition duration must be positive",
      };
    }

    const maxDuration = Math.max(0, clip.duration);
    if (maxDuration <= 0) {
      return {
        valid: false,
        error: "Clip must have a positive duration",
      };
    }

    if (duration > maxDuration) {
      return {
        valid: true,
        warning: `Transition duration exceeds clip length. Maximum duration is ${maxDuration.toFixed(
          2,
        )}s`,
        maxDuration,
      };
    }

    return {
      valid: true,
      maxDuration,
    };
  }

  areClipsAdjacent(clipA: Clip, clipB: Clip): boolean {
    if (clipA.trackId !== clipB.trackId) {
      return false;
    }

    const clipAEnd = clipA.startTime + clipA.duration;
    const gap = Math.abs(clipB.startTime - clipAEnd);

    // Allow small tolerance for floating point errors
    return gap < 0.001;
  }

  findAdjacentClipPairs(track: Track): Array<{ clipA: Clip; clipB: Clip }> {
    const pairs: Array<{ clipA: Clip; clipB: Clip }> = [];
    const sortedClips = [...track.clips].sort(
      (a, b) => a.startTime - b.startTime,
    );

    for (let i = 0; i < sortedClips.length - 1; i++) {
      const clipA = sortedClips[i];
      const clipB = sortedClips[i + 1];

      if (this.areClipsAdjacent(clipA, clipB)) {
        pairs.push({ clipA, clipB });
      }
    }

    return pairs;
  }

  createTransition(
    clipA: Clip,
    clipB: Clip,
    type: TransitionType,
    duration: number,
    params?: Partial<TransitionParams[typeof type]>,
  ): Transition | null {
    const validation = this.validateTransition(clipA, clipB, duration);
    if (!validation.valid && !validation.warning) {
      return null;
    }

    // Use max duration if requested duration exceeds it
    const actualDuration = validation.maxDuration
      ? Math.min(duration, validation.maxDuration)
      : duration;

    const defaultParams = this.getDefaultParams(type);

    return {
      id: `transition-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      clipAId: clipA.id,
      clipBId: clipB.id,
      type,
      duration: actualDuration,
      params: { ...defaultParams, ...params },
    };
  }

  createClipEdgeTransition(
    clip: Clip,
    edge: TransitionEdge,
    type: TransitionType,
    duration: number,
    params?: Partial<TransitionParams[typeof type]>,
  ): Transition | null {
    const validation = this.validateClipEdgeTransition(clip, duration);
    if (!validation.valid && !validation.warning) {
      return null;
    }

    const actualDuration = validation.maxDuration
      ? Math.min(duration, validation.maxDuration)
      : duration;

    const defaultParams = this.getDefaultParams(type);

    return {
      id: `transition-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      clipAId: clip.id,
      edge,
      type,
      duration: actualDuration,
      params: { ...defaultParams, ...params },
    };
  }

  getDefaultParams(type: TransitionType): Record<string, unknown> {
    switch (type) {
      case "crossfade":
        return { curve: "ease" };
      case "dipToBlack":
        return { holdDuration: 0.1 };
      case "dipToWhite":
        return { holdDuration: 0.1 };
      case "wipe":
        return { direction: "left", softness: 0 };
      case "slide":
        return { direction: "left", pushOut: false };
      case "zoom":
        return { scale: 2, center: { x: 0.5, y: 0.5 } };
      case "push":
        return { direction: "left" };
      case "circleReveal":
        return { center: { x: 0.5, y: 0.5 } };
      case "blur":
        return { intensity: 1 };
      case "whipPan":
        return { direction: "left", blurIntensity: 1 };
      case "radialWipe":
        return { startAngle: -90, clockwise: true };
      case "pixelate":
        return { maxPixelSize: 48 };
      case "glitch":
        return { intensity: 0.08, slices: 12 };
      case "blinds":
        return { count: 8, direction: "vertical" };
      case "diamondReveal":
        return { center: { x: 0.5, y: 0.5 } };
      case "spin":
        return { rotations: 1 };
      case "flip":
        return { axis: "horizontal" };
      case "splitReveal":
        return { orientation: "horizontal" };
      case "flash":
        return { intensity: 1 };
      case "filmBurn":
        return { intensity: 1, warmth: 0.75 };
      case "mosaic":
        return { tiles: 8, randomness: 0.85 };
      case "ripple":
        return { amplitude: 0.04, waves: 3 };
      case "pageTurn":
        return { direction: "left", shadow: 0.55 };
      case "colorSplit":
        return { maxOffset: 18, angle: 0 };
      case "crossZoom":
        return { strength: 2.2, center: { x: 0.5, y: 0.5 } };
      case "zoomBlur":
        return { streaks: 12, strength: 0.35 };
      case "motionSmear":
        return { direction: "left", distance: 0.25 };
      case "strobeCut":
        return { strobes: 6 };
      case "impactShake":
        return { intensity: 1, flash: 0.55 };
      case "lumaWipe":
        return { softness: 0.25, invert: false };
      case "inkBleed":
        return { lobes: 7, softness: 0.35, center: { x: 0.5, y: 0.5 } };
      case "tileFlip":
        return { columns: 6, stagger: 0.6, axis: "horizontal" };
      case "sliceSlide":
        return { slices: 9, direction: "left", gap: 0 };
      case "lightLeak":
        return { intensity: 1, warmth: 0.7, direction: "right" };
      case "vhsScan":
        return { intensity: 0.8, slices: 14 };
      case "paperBurn":
        return { softness: 0.3, center: { x: 0.5, y: 0.5 } };
      case "pixelSort":
        return { amount: 1, threshold: 0.55, direction: "right" };
      case "filmRoll":
        return { direction: "up", barWidth: 0.06 };
      default:
        return {};
    }
  }

  updateTransitionDuration(
    transition: Transition,
    clipA: Clip,
    clipB: Clip,
    newDuration: number,
  ): Transition {
    const validation = this.validateTransition(clipA, clipB, newDuration);
    const actualDuration = validation.maxDuration
      ? Math.min(newDuration, validation.maxDuration)
      : newDuration;

    return {
      ...transition,
      duration: actualDuration,
    };
  }

  removeTransition(track: Track, transitionId: string): Track {
    return {
      ...track,
      transitions: track.transitions.filter((t) => t.id !== transitionId),
    };
  }

  calculateTransitionProgress(
    transition: Transition,
    clipA: Clip,
    currentTime: number,
  ): number {
    const { start, end } = this.getTransitionWindow(transition, clipA);
    const duration = Math.max(0.000001, end - start);

    if (currentTime <= start) {
      return 0;
    }
    if (currentTime >= end) {
      return 1;
    }

    return (currentTime - start) / duration;
  }

  isTimeInTransition(
    transition: Transition,
    clipA: Clip,
    currentTime: number,
  ): boolean {
    const { start, end } = this.getTransitionWindow(transition, clipA);

    return currentTime >= start && currentTime <= end;
  }

  getTransitionWindow(
    transition: Transition,
    clipA: Clip,
  ): { start: number; end: number } {
    const duration = Math.max(0, transition.duration);
    const clipStart = clipA.startTime;
    const clipEnd = clipA.startTime + clipA.duration;

    if (transition.edge === "in") {
      return {
        start: clipStart,
        end: Math.min(clipEnd, clipStart + duration),
      };
    }

    if (transition.edge === "out" || !transition.clipBId) {
      return {
        start: Math.max(clipStart, clipEnd - duration),
        end: clipEnd,
      };
    }

    const start = clipEnd - duration / 2;
    return {
      start,
      end: start + duration,
    };
  }

  getEngineDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    if (typeof OffscreenCanvas !== "undefined") {
      try {
        this.canvas = new OffscreenCanvas(width, height);
        this.ctx = this.canvas.getContext("2d");
      } catch {
        // Ignore errors in non-browser environments
      }
    }
  }

  getAvailableTransitionTypes(): TransitionType[] {
    return [
      "crossfade",
      "dipToBlack",
      "dipToWhite",
      "wipe",
      "slide",
      "zoom",
      "push",
      "circleReveal",
      "blur",
      "whipPan",
      "radialWipe",
      "pixelate",
      "glitch",
      "blinds",
      "diamondReveal",
      "spin",
      "flip",
      "splitReveal",
      "flash",
      "filmBurn",
      "mosaic",
      "ripple",
      "pageTurn",
      "colorSplit",
      "crossZoom",
      "zoomBlur",
      "motionSmear",
      "strobeCut",
      "impactShake",
      "lumaWipe",
      "inkBleed",
      "tileFlip",
      "sliceSlide",
      "lightLeak",
      "vhsScan",
      "paperBurn",
      "pixelSort",
      "filmRoll",
    ];
  }

  dispose(): void {
    // OffscreenCanvas doesn't need explicit disposal
    // but we can clear references
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.width, this.height);
    }
    this.canvas = null;
    this.ctx = null;
    this.pixelScratch = null;
    this.pixelScratchCtx = null;
    this.maskScratch = null;
    this.maskScratchCtx = null;
    this.layerScratch = null;
    this.layerScratchCtx = null;
  }
}

export function createTransitionEngine(
  width: number = 1920,
  height: number = 1080,
): TransitionEngine {
  return new TransitionEngine({ width, height });
}
