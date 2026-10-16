import { frameToSeconds, type FrameRate } from "./timebase";

/** WebCodecs/Mediabunny decoder for indexed source frames. Unlike HTMLVideoElement
 * seeking, CanvasSink returns the decoded sample and its actual media timestamp.
 * This still requires CFR source timestamps matching the explicitly selected clock.
 */
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
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D unavailable");
    return {
      async read(frame, fps) {
        const framePeriod = fps.den / fps.num;
        const timestamp = frameToSeconds(frame, fps);
        // Request inside frame N, not exactly on a floating-point boundary.
        const sample = await sink.getCanvas(timestamp + framePeriod * 0.25);
        if (!sample || Math.abs(sample.timestamp - timestamp) > framePeriod * 0.1 || (sample.duration > 0 && Math.abs(sample.duration - framePeriod) > framePeriod * 0.05)) {
          throw new Error(`Source frame ${frame} does not match selected CFR clock ${fps.num}/${fps.den}; select the correct FPS or transcode VFR footage`);
        }
        ctx.drawImage(sample.canvas, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
      },
      close() { input.dispose(); },
    };
  } catch (error) { input.dispose(); throw error; }
}
