import { openIndexedVideoFrames } from "@kove-advanced/core/mirror/decoded-frames";
import { frameToSeconds, type FrameRate } from "@kove-advanced/core/mirror/timebase";
import type { GrayImage } from "@kove-advanced/agent/director/mirror/ssim";
const SIZE = 64;
function gray(canvas: HTMLCanvasElement): GrayImage {
  const pixels = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, SIZE, SIZE).data;
  return grayPixels(pixels);
}
function grayPixels(pixels: Uint8ClampedArray): GrayImage {
  const data = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(0.299 * pixels[i*4] + 0.587 * pixels[i*4+1] + 0.114 * pixels[i*4+2]);
  return { width: SIZE, height: SIZE, data };
}
export async function grayDataUrl(url: string): Promise<GrayImage> {
  const image = new Image(); image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = SIZE;
  canvas.getContext("2d")!.drawImage(image, 0, 0, SIZE, SIZE);
  return gray(canvas);
}
export async function sampleReferenceProxies(file: Blob, frames: readonly number[], fps: FrameRate): Promise<GrayImage[]> {
  const indexed = await openIndexedVideoFrames(file, SIZE, SIZE).catch(() => null);
  if (indexed) {
    try {
      const samples: GrayImage[] = [];
      for (const frame of frames) samples.push(grayPixels((await indexed.read(frame, fps)).data));
      return samples;
    } finally { indexed.close(); }
  }
  // Capability fallback only. HTML seeking is not guaranteed frame-accurate.
  const url = URL.createObjectURL(file), video = document.createElement("video");
  video.muted = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Reference decoder unavailable")); });
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = SIZE;
    const result: GrayImage[] = [];
    for (const frame of frames) {
      const time = Math.min(video.duration - 0.001, frameToSeconds(frame, fps) + fps.den / fps.num / 4);
      await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Reference proxy seek failed")); video.currentTime = Math.max(0.001, time); });
      canvas.getContext("2d")!.drawImage(video, 0, 0, SIZE, SIZE);
      result.push(gray(canvas));
    }
    return result;
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
