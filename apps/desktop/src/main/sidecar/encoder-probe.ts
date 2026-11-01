import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegPath } from "./ffmpeg-path";
import { isSoftwareEncoder, videoEncodeArgs, type EncodeMode, type ExportCodec } from "./encode-args";

const run = promisify(execFile);

export function parseEncoders(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[VAS]\S{5}\s/.test(line))
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean);
}

type Codec = "h264" | "h265" | "hevc" | "av1" | "prores" | "vp8" | "vp9";

const PREFERENCE: Partial<Record<Codec, Partial<Record<NodeJS.Platform | "any", string[]>>>> = {
  h264: {
    darwin: ["h264_videotoolbox"],
    win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
    linux: ["h264_nvenc", "h264_vaapi"],
    any: ["libx264"],
  },
  hevc: {
    darwin: ["hevc_videotoolbox"],
    win32: ["hevc_nvenc", "hevc_qsv", "hevc_amf"],
    linux: ["hevc_nvenc", "hevc_vaapi"],
    any: ["libx265"],
  },
  av1: {
    win32: ["av1_nvenc", "av1_qsv", "av1_amf"],
    linux: ["av1_nvenc", "av1_vaapi"],
    any: ["libsvtav1"],
  },
  prores: {
    darwin: ["prores_videotoolbox", "prores_ks"],
    any: ["prores_ks"],
  },
  vp8: { any: ["libvpx"] },
  vp9: { any: ["libvpx-vp9"] },
};

export function selectEncoder(
  codec: string,
  platform: NodeJS.Platform,
  available: string[],
  mode: "fast" | "balanced" | "smallest" = "balanced",
): string | null {
  const key = (codec === "h265" ? "hevc" : codec) as Codec;
  const pref = PREFERENCE[key];
  if (!pref) return null;
  const hardwareFirst = [...(pref[platform] ?? []), ...(pref.any ?? [])];
  const softwareFirst = [
    ...(pref.any ?? []),
    ...(pref[platform] ?? []),
  ];
  const ordered = mode === "smallest" ? softwareFirst : hardwareFirst;
  const pick = ordered.find((c) => available.includes(c));
  if (pick) return pick;
  return (
    [...hardwareFirst, ...softwareFirst].find(
      (c) => available.includes(c) && isSoftwareEncoder(c),
    ) ??
    [...hardwareFirst].find((c) => available.includes(c)) ??
    null
  );
}

type HardwareEncoderProbe = (encoder: string, codec: ExportCodec, mode: EncodeMode) => Promise<boolean>;

/**
 * Listing an encoder only means FFmpeg was compiled with it. Drivers, devices,
 * or the upload path required by our RGBA pipeline may still be unavailable.
 * Probe one frame using the same encode options before committing a long export.
 */
async function canEncodeHardwareFrame(encoder: string, codec: ExportCodec, mode: EncodeMode): Promise<boolean> {
  try {
    await run(resolveFfmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=128x128:r=1,format=rgba",
      "-frames:v", "1",
      ...videoEncodeArgs({ codec, encoder, mode, quality: 80, width: 128, height: 128, frameRate: 1 }),
      "-f", "null", "-",
    ], { timeout: 4_000, maxBuffer: 256 * 1024, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function selectUsableEncoder(
  codec: string,
  platform: NodeJS.Platform,
  available: string[],
  mode: EncodeMode = "balanced",
  probe: HardwareEncoderProbe = canEncodeHardwareFrame,
): Promise<string | null> {
  const normalized = (codec === "h265" ? "hevc" : codec) as ExportCodec;
  const first = selectEncoder(normalized, platform, available, mode);
  if (!first) return null;

  const hardware = [...new Set(PREFERENCE[normalized]?.[platform] ?? [])]
    .filter((encoder) => available.includes(encoder) && !isSoftwareEncoder(encoder));
  // "smallest" deliberately chooses software when it is available.
  if (!hardware.includes(first)) return first;

  // Probe candidates in parallel to keep startup bounded even when several
  // drivers are missing or stalled. Preserve the configured preference order.
  const results = await Promise.all(hardware.map(async (encoder) => {
    try { return await probe(encoder, normalized, mode); } catch { return false; }
  }));
  const unavailable = new Set(hardware.filter((_, index) => !results[index]));
  return selectEncoder(normalized, platform, available.filter((encoder) => !unavailable.has(encoder)), mode);
}

export async function probeEncoders(): Promise<string[]> {
  try {
    const { stdout } = await run(resolveFfmpegPath(), ["-hide_banner", "-encoders"], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    return parseEncoders(stdout);
  } catch {
    return [];
  }
}
