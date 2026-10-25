#!/usr/bin/env node
import process from "node:process";
import { runWowEval } from "./wow-eval";

interface CliOptions {
  reportPath?: string;
  outputDirectory?: string;
  caseId?: string;
  run?: number;
  maxDimension?: number;
  skipVision: boolean;
  help: boolean;
}

const USAGE = `K.O.V.E. rendered watchability evaluation

Usage:
  pnpm --filter @kove-advanced/agent-runner wow-eval -- [options]

Options:
  --report <path>          Completed baseline JSON (default: evaluation-files/baseline-v0.json)
  --case <project/prompt>  Review one settled case from an in-progress baseline
  --run <index>            0-based repeat index (use with --case)
  --out <directory>        Review bundle directory (default: evaluation-files/wow-reviews)
  --max-dimension <pixels> Maximum render edge, 64-1920 (default: 720)
  --skip-vision            Export video and human review page without model scoring
  --help                   Show this help

Vision scoring sends sampled candidate/reference frames to the configured OmniRoute
model. The rendered MP4 and human review page remain local. Audio must be judged by
listening to the candidate; the still-frame vision screen does not score audio.`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { skipVision: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = (): string => argv[++index] ?? "";
    switch (arg) {
      case "--report":
        options.reportPath = next();
        break;
      case "--case":
        options.caseId = next();
        break;
      case "--run": {
        const value = Number(next());
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("--run must be a non-negative integer");
        options.run = value;
        break;
      }
      case "--out":
        options.outputDirectory = next();
        break;
      case "--max-dimension": {
        const value = Number(next());
        if (!Number.isSafeInteger(value)) throw new Error("--max-dimension must be an integer");
        options.maxDimension = value;
        break;
      }
      case "--skip-vision":
        options.skipVision = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const results = await runWowEval(options);
    for (const result of results) {
      const screen = result.vision
        ? `vision ${result.vision.visualScore.toFixed(1)}/10 (${result.vision.minimumVisualBarMet ? "screen pass; human confirmation required" : "below reference screen"})`
        : "vision not run";
      process.stdout.write(
        `${result.caseId} run ${result.run}: ${result.durationSeconds.toFixed(1)}s, ` +
        `${result.frameCount} frames, ${screen}\n` +
        `  review: ${result.candidateVideo.replace(/candidate\.mp4$/, "index.html")}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Watchability evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
