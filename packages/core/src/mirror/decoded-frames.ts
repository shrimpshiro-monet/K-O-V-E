import { frameToSeconds, secondsToFrame, type FrameRate } from "./timebase";

/** WebCodecs/Mediabunny decoder for indexed source frames. Unlike HTMLVideoElement
 * seeking, CanvasSink returns the decoded sample and its actual media timestamp.
 * This still requires CFR source timestamps matching the explicitly selected clock.
 *
 * Throughput contract: the sequential pass pulls from ONE forward-only
 * streaming iterator (`CanvasSink.canvases`), which decodes each packet at
 * most once. Per-read random access (`getCanvas`) restarts the decode
 * pipeline from the previous keyframe, which cost ~1s per frame on long-GOP
 * HEVC sources. A bounded recent-frame cache absorbs cut-refinement reads;
 * anything older falls back to an independent random-access sink. */
export async function openIndexedVideoFrames(file: Blob, width: number, height: number): Promise<{
  read(frame: number, fps: FrameRate): Promise<ImageData>;
  close(): void;
}> {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !await track.canDecode()) throw new Error("Indexed WebCodecs decoder unavailable");
    const sink = new CanvasSink(track, { width, height, fit: "fill", poolSize: 2 });
    // The sequential stream and random-access fallback must not share decode state.
    const randomSink = new CanvasSink(track, { width, height, fit: "fill", poolSize: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D unavailable");

    const CACHE_LIMIT = 256;
    const cache = new Map<number, { data: ImageData; fpsNum: number; fpsDen: number }>();
    let stream: AsyncIterator<{ canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number }> | null = null;
    let nextStreamFrame = Number.NaN;

    const grab = (sampleCanvas: HTMLCanvasElement | OffscreenCanvas, sampleTimestamp: number, sampleDuration: number, frame: number, fps: FrameRate): ImageData => {
      const framePeriod = fps.den / fps.num;
      const timestamp = frameToSeconds(frame, fps);
      if (Math.abs(sampleTimestamp - timestamp) > framePeriod * 0.1 || (sampleDuration > 0 && Math.abs(sampleDuration - framePeriod) > framePeriod * 0.05)) {
        throw new Error(`Source frame ${frame} does not match selected CFR clock ${fps.num}/${fps.den}; select the correct FPS or transcode VFR footage`);
      }
      ctx.drawImage(sampleCanvas, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    };
    const frameOf = (sampleTimestamp: number, fps: FrameRate): number =>
      secondsToFrame(sampleTimestamp + (fps.den / fps.num) * 0.25, fps);
    const put = (frame: number, data: ImageData, fps: FrameRate): void => {
      cache.delete(frame);
      cache.set(frame, { data, fpsNum: fps.num, fpsDen: fps.den });
      if (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    };
    const readRandom = async (frame: number, fps: FrameRate): Promise<ImageData> => {
      const framePeriod = fps.den / fps.num;
      const sample = await randomSink.getCanvas(frameToSeconds(frame, fps) + framePeriod * 0.25);
      if (!sample) throw new Error(`Source frame ${frame} is unavailable from the indexed decoder`);
      const data = grab(sample.canvas, sample.timestamp, sample.duration, frame, fps);
      put(frame, data, fps);
      return data;
    };
    const pullStream = async (target: number, fps: FrameRate): Promise<ImageData | null> => {
      let iterator = stream;
      if (!iterator) {
        const framePeriod = fps.den / fps.num;
        const startTimestamp = Math.max(0, frameToSeconds(target, fps) - framePeriod * 2);
        iterator = sink.canvases(startTimestamp, Infinity)[Symbol.asyncIterator]();
        stream = iterator;
      }
      while (!cache.has(target)) {
        const next = await iterator.next();
        if (next.done) return null;
        const frame = frameOf(next.value.timestamp, fps);
        nextStreamFrame = frame + 1;
        // The stream must never run past the target: that would mean misalignment.
        if (frame > target + 4) return null;
        put(frame, grab(next.value.canvas, next.value.timestamp, next.value.duration, frame, fps), fps);
      }
      return cache.get(target)!.data;
    };

    // Reads are strictly serialized: the stream iterator cannot be interleaved.
    let chain: Promise<unknown> = Promise.resolve();
    return {
      read(frame: number, fps: FrameRate): Promise<ImageData> {
        const run = async (): Promise<ImageData> => {
          const hit = cache.get(frame);
          if (hit && hit.fpsNum === fps.num && hit.fpsDen === fps.den) {
            put(frame, hit.data, fps);
            return hit.data;
          }
          if (!stream || frame >= nextStreamFrame) {
            const data = await pullStream(frame, fps);
            if (data) return data;
          }
          // Consumed backwards, or the stream ended/misaligned: random access.
          return readRandom(frame, fps);
        };
        const result = chain.then(run, run);
        chain = result.catch(() => undefined);
        return result;
      },
      close() { void stream?.return?.(); input.dispose(); },
    };
  } catch (error) { input.dispose(); throw error; }
}
