import type { GrayImage } from "@kove-advanced/agent/director/mirror/ssim";
const SIZE = 64;
function gray(canvas: HTMLCanvasElement): GrayImage {
  const pixels = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, SIZE, SIZE).data;
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
export async function sampleReferenceProxies(file: Blob, times: readonly number[]): Promise<GrayImage[]> {
  const url = URL.createObjectURL(file), video = document.createElement("video");
  video.muted = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("Reference decoder unavailable")); });
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = SIZE;
    const result: GrayImage[] = [];
    for (const time of times) {
      await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Reference proxy seek failed")); video.currentTime = Math.min(video.duration - 0.001, Math.max(0.001, time)); });
      canvas.getContext("2d")!.drawImage(video, 0, 0, SIZE, SIZE);
      result.push(gray(canvas));
    }
    return result;
  } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
