import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReferenceTextOverlay } from "@kove-advanced/core/mirror/reference-profile";
import {
  isPlatformChromeText,
  mergeTextObservations,
  normalizeTextObservations,
  type TextDetectorBlock,
  type TextObservation,
} from "../src/services/mirror/reference-text";

const run = promisify(execFile);

export interface HeadlessOcrOptions {
  readonly videoPath: string;
  readonly fps: number;
  readonly durationFrames: number;
  readonly sampleBudget?: number;
  readonly ffmpegPath?: string;
  readonly tesseractPath?: string;
  readonly cornerWidthRatio?: number;
  readonly cornerHeightRatio?: number;
}

export interface HeadlessOcrResult {
  readonly overlays: ReferenceTextOverlay[];
  readonly sampledFrames: number;
  readonly warnings: string[];
}

function pngDimensions(path: string): { width: number; height: number } {
  const header = readFileSync(path);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function parseTsv(tsv: string): TextDetectorBlock[] {
  const grouped = new Map<string, {
    left: number;
    top: number;
    right: number;
    bottom: number;
    words: string[];
    confidence: number;
  }>();
  for (const row of tsv.split("\n").slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12) continue;
    if (Number(columns[0]) !== 5) continue;
    const text = columns.slice(11).join("\t").trim();
    if (!text || isPlatformChromeText(text)) continue;
    const confidence = Number(columns[10]);
    if (!Number.isFinite(confidence) || confidence < 55) continue;
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (![left, top, width, height].every(Number.isFinite)) continue;
    const key = `${columns[2]}-${columns[3]}-${columns[4]}`;
    const line = grouped.get(key);
    if (line) {
      line.left = Math.min(line.left, left);
      line.top = Math.min(line.top, top);
      line.right = Math.max(line.right, left + width);
      line.bottom = Math.max(line.bottom, top + height);
      line.words.push(text);
      line.confidence += confidence;
    } else {
      grouped.set(key, {
        left,
        top,
        right: left + width,
        bottom: top + height,
        words: [text],
        confidence,
      });
    }
  }
  return [...grouped.values()].flatMap((line) => {
    const text = line.words.join(" ").trim();
    if (text.replace(/[^A-Za-z0-9]/g, "").length < 2) return [];
    const wordCount = line.words.length;
    return [{
      rawValue: text,
      boundingBox: {
        x: line.left,
        y: line.top,
        width: line.right - line.left,
        height: line.bottom - line.top,
      },
      confidence: line.confidence / wordCount / 100,
    }];
  });
}

/**
 * Headless OCR fallback for the baseline runner: samples frames with FFmpeg,
 * masks the same corner bands as the browser pipeline, then reads text with
 * the Tesseract CLI. Produces the same overlay shape as local browser OCR.
 */
export async function extractHeadlessTextOverlays(options: HeadlessOcrOptions): Promise<HeadlessOcrResult | null> {
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const tesseract = options.tesseractPath ?? process.env.TESSERACT_PATH ?? "tesseract";
  const widthRatio = options.cornerWidthRatio ?? 0.16;
  const heightRatio = options.cornerHeightRatio ?? 0.12;
  const sampleBudget = options.sampleBudget ?? 10;
  const stride = Math.max(1, Math.ceil(options.durationFrames / sampleBudget));
  const workDir = mkdtempSync(join(tmpdir(), "kove-headless-ocr-"));
  const observations: TextObservation[] = [];
  const warnings: string[] = [];
  let sampledFrames = 0;
  const filter = [
    `drawbox=x=0:y=0:w=iw*${widthRatio}:h=ih*${heightRatio}:color=black:t=fill`,
    `drawbox=x=iw-iw*${widthRatio}:y=0:w=iw*${widthRatio}:h=ih*${heightRatio}:color=black:t=fill`,
    `drawbox=x=0:y=ih-ih*${heightRatio}:w=iw*${widthRatio}:h=ih*${heightRatio}:color=black:t=fill`,
    `drawbox=x=iw-iw*${widthRatio}:y=ih-ih*${heightRatio}:w=iw*${widthRatio}:h=ih*${heightRatio}:color=black:t=fill`,
  ].join(",");
  try {
    await run(tesseract, ["--version"], { timeout: 10_000 });
  } catch {
    warnings.push("Headless OCR fallback is unavailable: tesseract is not installed.");
    rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  try {
    for (let frame = 0; frame < options.durationFrames; frame += stride) {
      const png = join(workDir, `frame-${frame}.png`);
      try {
        await run(ffmpeg, [
          "-v", "error",
          "-ss", (frame / options.fps).toFixed(3),
          "-i", options.videoPath,
          "-frames:v", "1",
          "-vf", filter,
          "-y", png,
        ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      } catch (error) {
        warnings.push(`Headless OCR could not sample frame ${frame}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!existsSync(png)) continue;
      let tsv: string;
      try {
        const result = await run(tesseract, [png, "stdout", "--psm", "11", "tsv"], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        tsv = result.stdout;
      } catch (error) {
        warnings.push(`Headless OCR failed at frame ${frame}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      sampledFrames++;
      const { width, height } = pngDimensions(png);
      const blocks = parseTsv(tsv);
      observations.push(...normalizeTextObservations(
        blocks,
        frame,
        Math.min(options.durationFrames, frame + stride),
        width,
        height,
      ));
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const overlays = mergeTextObservations(observations, options.durationFrames, Math.max(1, Math.ceil(options.fps)));
  warnings.push(`Headless OCR fallback sampled ${sampledFrames} frame(s) and measured ${overlays.length} text overlay(s).`);
  return { overlays, sampledFrames, warnings };
}
