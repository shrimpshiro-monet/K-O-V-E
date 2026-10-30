#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "apps/web/package.json"));
const { chromium } = require("@playwright/test");
const vars = readDevVars(join(repoRoot, ".dev.vars"));
const omniBaseUrl =
  process.env.OMNIROUTE_BASE_URL || vars.OMNIROUTE_BASE_URL || "http://localhost:20128/v1";
const omniApiKey = process.env.OMNIROUTE_KEY ?? vars.OMNIROUTE_KEY ?? "";
const omniModel = process.env.OMNIROUTE_MODEL ?? vars.OMNIROUTE_MODEL ?? "";
const nimBaseUrl =
  process.env.NVIDIA_NIM_BASE_URL ?? vars.NVIDIA_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const nimApiKey = process.env.NVIDIA_NIM_API_KEY ?? vars.NVIDIA_NIM_API_KEY ?? "";
const nimModel = process.env.NVIDIA_NIM_MODEL ?? vars.NVIDIA_NIM_MODEL ?? "";

const sourcePath = resolve(
  process.env.KOVE_SOURCE_VIDEO ??
    join(
      repoRoot,
      "evaluation-files/Steph Curry IGNITES For 56 PTS In Orlando | February 27, 2025.mp4",
    ),
);
const referencePath = resolve(
  process.env.KOVE_STYLE_REFERENCE ??
    join(repoRoot, "captain price (2nd priority).MP4"),
);
const outputDir = resolve(
  process.env.KOVE_E2E_OUT ??
    join(repoRoot, "run-outputs", `captain-price-emulation-${new Date().toISOString().replaceAll(":", "-")}`),
);
const prompt =
  "/reference Create an energetic, punchy Steph Curry highlight edit following the attached reference's pacing and visual style. Keep Curry's scoring plays, dribbles, celebrations, and crowd reactions; cut dead air, slow setup, and repetition. Use only the source footage, and aim for roughly 20 seconds to match the reference length.";
const turnTimeoutMs = Number(process.env.KOVE_TURN_TIMEOUT_MS ?? 45 * 60_000);
const exportTimeoutMs = Number(process.env.KOVE_EXPORT_TIMEOUT_MS ?? 15 * 60_000);
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const startedAt = Date.now();
const log = (...parts) =>
  console.log(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s]`, ...parts);

const services = [];
let browser;
let context;
let page;
let browserClosed = false;
let finishedSuccessfully = false;

function readDevVars(path) {
  if (!existsSync(path)) return {};
  const parsed = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function redactServiceLine(label, line) {
  if (/Cloudflare proxy token:/i.test(line)) {
    const state = /MISSING/i.test(line) ? "missing" : "configured";
    log(`[${label}] Cloudflare proxy token: ${state} (redacted)`);
    return;
  }
  log(`[${label}] ${line}`);
}

function startService(label, command, args, cwd, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (stream, name) => {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => redactServiceLine(name, line));
  };
  forward(child.stdout, label);
  forward(child.stderr, label);
  child.once("error", (error) => log(`[${label}] failed to start: ${error.message}`));
  services.push(child);
  return child;
}

async function stopService(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(5000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function cleanup() {
  if (browser && !browserClosed) {
    browserClosed = true;
    await browser.close().catch(() => {});
  }
  await context?.close().catch(() => {});
  if (visionProxy) {
    await new Promise((resolvePromise) => visionProxy.close(() => resolvePromise()));
    visionProxy = null;
  }
  for (const child of [...services].reverse()) await stopService(child);
}

async function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolvePromise(port)));
    });
  });
}

async function startVisionProxy(primaryVision, frameBudget) {
  const server = createHttpServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/analyze-frames") {
      response.writeHead(404).end();
      return;
    }

    try {
      const chunks = [];
      let byteCount = 0;
      for await (const chunk of request) {
        byteCount += chunk.length;
        if (byteCount > 128 * 1024 * 1024) {
          response.writeHead(413, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "Frame request exceeds the 128 MB limit." }));
          return;
        }
        chunks.push(chunk);
      }

      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(payload.frames)) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "frames array is required" }));
        return;
      }
      const entries = payload.frames.flatMap((batch, batchIndex) =>
        (Array.isArray(batch.frames) ? batch.frames : []).map((frame, frameIndex) => ({
          batchIndex,
          frameIndex,
          frame,
        })),
      );
      const picked = new Set();
      if (entries.length <= frameBudget) {
        entries.forEach((_, index) => picked.add(index));
      } else {
        for (let index = 0; index < frameBudget; index += 1) {
          picked.add(Math.floor((index * (entries.length - 1)) / (frameBudget - 1)));
        }
      }
      let globalIndex = 0;
      const trimmedBatches = payload.frames
        .map((batch) => {
          const batchFrames = Array.isArray(batch.frames) ? batch.frames : [];
          const selectedFrames = batchFrames.filter(() => {
            const selected = picked.has(globalIndex);
            globalIndex += 1;
            return selected;
          });
          return { ...batch, frames: selectedFrames };
        })
        .filter((batch) => batch.frames.length > 0);
      const trimmed = { ...payload, frames: trimmedBatches };
      const forwardedCount = trimmed.frames.reduce((sum, batch) => sum + batch.frames.length, 0);
      visionProxyStats.requests += 1;
      visionProxyStats.inputFrames += entries.length;
      visionProxyStats.forwardedFrames += forwardedCount;
      log(
        `[vision] ${payload.videoId ?? "video"}: forwarding ${forwardedCount}/${entries.length} frames to the configured vision worker.`,
      );

      let upstreamError;
      try {
        if (primaryVision.kind === "cloudflare") {
          const result = await analyzeWithWorkersAI(trimmed, primaryVision);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(result));
          return;
        }
        const upstreamResponse = await fetch(primaryVision.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(trimmed),
          signal: AbortSignal.timeout(15 * 60_000),
        });
        if (upstreamResponse.ok) {
          response.writeHead(upstreamResponse.status, {
            "Content-Type": upstreamResponse.headers.get("content-type") ?? "application/json",
          });
          response.end(await upstreamResponse.text());
          return;
        }
        upstreamError = await upstreamResponse.text();
        log(`[vision] primary worker returned HTTP ${upstreamResponse.status}.`);
      } catch (error) {
        upstreamError = error instanceof Error ? error.message : String(error);
        log(`[vision] primary worker unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (omniApiKey && omniModel) {
        try {
          const fallback = await analyzeWithOmniRoute(trimmed);
          visionProxyStats.omniFallbackBatches += fallback.batches.length;
          visionProxyStats.omniFallbackFrames += fallback.totalFrames;
          log(`[vision] OmniRoute fallback analyzed ${fallback.totalFrames} frame(s).`);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(fallback));
          return;
        } catch (error) {
          log(`[vision] OmniRoute fallback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (nimApiKey && nimModel) {
        try {
          const fallback = await analyzeWithNvidiaNim(trimmed);
          visionProxyStats.nimFallbackBatches += fallback.batches.length;
          visionProxyStats.nimFallbackFrames += fallback.totalFrames;
          log(`[vision] NVIDIA NIM fallback analyzed ${fallback.totalFrames} frame(s).`);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(fallback));
          return;
        } catch (error) {
          log(`[vision] NVIDIA NIM fallback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: `Primary vision failed; OmniRoute/NVIDIA NIM fallback unavailable or failed: ${upstreamError ?? "unknown error"}`,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: `Vision proxy failed: ${message}` }));
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error("Could not start the local vision budget proxy.");
  }
  visionProxy = server;
  return `http://127.0.0.1:${address.port}/analyze-frames`;
}

const FRAME_VISION_PROMPT =
  "Analyze this video frame. Return only a JSON object with description " +
  "(concise visible content), sceneType (talking/action/transition/b-roll/" +
  "silence/music), motionLevel (static/low/medium/high), hasDialogue (boolean), " +
  "and confidence (number from 0 to 1). Do not infer transitions from one still.";

function mosaicInstruction(meta) {
  const timestamps = Array.isArray(meta?.timestamps) ? meta.timestamps : [];
  const count = timestamps.length;
  return (
    `This image is a ${meta.rows}x${meta.cols} contact sheet of video frames, ordered left to ` +
    `right, then top to bottom. Only the first ${count} cell(s) are valid; each cell has its ` +
    `timestamp in seconds drawn on it. Valid timestamps in order: ${timestamps.join(", ")}.\n\n` +
    `Return ONLY a JSON object {"descriptions":[...]} with exactly ${count} item(s) in the same ` +
    `order. Each item must contain "timestamp" (the number shown on that cell), "description" ` +
    `(concise visible content), "sceneType" (talking/action/transition/b-roll/silence/music), ` +
    `"motionLevel" (static/low/medium/high), "hasDialogue" (boolean), and "confidence" (number ` +
    `from 0 to 1). Do not infer transitions between cells; use "unknown".`
  );
}

function isMosaicBatch(batch) {
  return Boolean(
    batch &&
      batch.mosaic &&
      Array.isArray(batch.mosaic.timestamps) &&
      Array.isArray(batch.frames) &&
      batch.frames.length === 1,
  );
}

function parseJsonValue(text) {
  if (typeof text !== "string") return null;
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const start =
    arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) return null;
  const end = text.lastIndexOf(text[start] === "{" ? "}" : "]");
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function mosaicItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.descriptions)) {
    return parsed.descriptions;
  }
  return [];
}

function describeFromItem(timestamp, item, label = "Vision") {
  if (
    !item ||
    typeof item.description !== "string" ||
    typeof item.sceneType !== "string" ||
    typeof item.motionLevel !== "string" ||
    typeof item.hasDialogue !== "boolean" ||
    typeof item.confidence !== "number" ||
    !Number.isFinite(item.confidence)
  ) {
    throw new Error(`${label} returned incomplete frame data.`);
  }
  return {
    timestamp,
    description: item.description,
    sceneType: item.sceneType,
    motionLevel: item.motionLevel,
    hasDialogue: item.hasDialogue,
    confidence: item.confidence,
    ...(item.editSignals && typeof item.editSignals === "object"
      ? { editSignals: item.editSignals }
      : {}),
  };
}

async function workersAiContent(config, imageData, prompt, maxTokens) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageData}` } },
              { type: "text", text: prompt },
            ],
          },
        ],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Workers AI returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error("Workers AI returned an inference error.");
  }
  const message = result.choices?.[0]?.message;
  const content = message?.content ?? message?.reasoning_content ?? result.result?.response;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Workers AI returned no frame description.");
  }
  return content;
}

async function analyzeWithWorkersAI(payload, config) {
  const started = Date.now();
  const batches = [];
  let totalFrames = 0;
  for (const batch of payload.frames) {
    const descriptions = [];
    if (isMosaicBatch(batch)) {
      visionProxyStats.cloudflareRequests += 1;
      const content = await workersAiContent(
        config,
        batch.frames[0].imageData,
        mosaicInstruction(batch.mosaic),
        4096,
      );
      const items = mosaicItems(parseJsonValue(content));
      if (items.length !== batch.mosaic.timestamps.length) {
        throw new Error(
          `Workers AI returned ${items.length} mosaic descriptions for ${batch.mosaic.timestamps.length} cells.`,
        );
      }
      items.forEach((item, index) => {
        descriptions.push(
          describeFromItem(batch.mosaic.timestamps[index], item, "Workers AI"),
        );
      });
    } else {
      for (const frame of batch.frames) {
        visionProxyStats.cloudflareRequests += 1;
        const content = await workersAiContent(
          config,
          frame.imageData,
          FRAME_VISION_PROMPT,
          1024,
        );
        descriptions.push(
          describeFromItem(frame.timestamp, parseJsonValue(content), "Workers AI"),
        );
      }
    }
    totalFrames += descriptions.length;
    batches.push({ batchIndex: batch.batchIndex, descriptions });
  }
  return {
    videoId: payload.videoId,
    batches,
    totalFrames,
    processingTimeMs: Date.now() - started,
  };
}

async function analyzeWithOmniRoute(payload) {
  const started = Date.now();
  const batches = [];
  let totalFrames = 0;
  for (const batch of payload.frames) {
    const mosaic = isMosaicBatch(batch);
    const imageParts = mosaic
      ? [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${batch.frames[0].imageData}` },
          },
        ]
      : batch.frames.flatMap((frame) => [
          { type: "text", text: `Frame timestamp: ${frame.timestamp} seconds.` },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${frame.imageData}` },
          },
        ]);
    const response = await fetch(
      `${omniBaseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${omniApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: omniModel,
          max_tokens: 3072,
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: mosaic
                    ? mosaicInstruction(batch.mosaic)
                    : "Analyze each attached video frame independently. Return only a JSON object with a " +
                      '"descriptions" array in the same order, one item per frame. Each item must have ' +
                      '"description" (concise visible content), "sceneType" ' +
                      "(talking/action/transition/b-roll/silence/music), " +
                      '"motionLevel" (static/low/medium/high), "hasDialogue" (boolean), and "confidence" ' +
                      "(number from 0 to 1). Do not infer transitions from a still image.",
                },
                ...imageParts,
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    if (!response.ok) {
      throw new Error(`OmniRoute returned HTTP ${response.status}.`);
    }
    const content = await readOmniRouteContent(response);
    const parsed = parseJsonValue(content);
    const items = mosaic
      ? mosaicItems(parsed)
      : parsed && typeof parsed === "object" && Array.isArray(parsed.descriptions)
        ? parsed.descriptions
        : [];
    const timestamps = mosaic
      ? batch.mosaic.timestamps
      : batch.frames.map((frame) => frame.timestamp);
    if (items.length !== timestamps.length) {
      throw new Error(
        `OmniRoute returned an incomplete frame description batch (${items.length}/${timestamps.length}).`,
      );
    }
    const descriptions = items.map((item, index) =>
      describeFromItem(timestamps[index], item, "OmniRoute"),
    );
    totalFrames += descriptions.length;
    batches.push({ batchIndex: batch.batchIndex, descriptions });
  }
  return {
    videoId: payload.videoId,
    batches,
    totalFrames,
    processingTimeMs: Date.now() - started,
  };
}

async function readOmniRouteContent(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    }
  } catch {
    const content = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === "string") content.push(delta);
        else if (Array.isArray(delta)) {
          content.push(delta.map((part) => part?.text ?? "").join(""));
        }
      } catch {
        continue;
      }
    }
    if (content.length > 0) return content.join("");
  }
  throw new Error("OmniRoute response did not contain assistant text.");
}

async function analyzeWithNvidiaNim(payload) {
  const started = Date.now();
  const batches = [];
  let totalFrames = 0;
  for (const batch of payload.frames) {
    const mosaic = isMosaicBatch(batch);
    const imageParts = mosaic
      ? [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${batch.frames[0].imageData}` },
          },
        ]
      : batch.frames.flatMap((frame) => [
          { type: "text", text: `Frame timestamp: ${frame.timestamp} seconds.` },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${frame.imageData}` },
          },
        ]);
    const response = await fetch(`${nimBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nimApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: nimModel,
        max_tokens: 3072,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: mosaic
                  ? mosaicInstruction(batch.mosaic)
                  : "Analyze each attached video frame independently. Return only a JSON object with a " +
                    '"descriptions" array in the same order, one item per frame. Each item must have ' +
                    '"description" (concise visible content), "sceneType" ' +
                    "(talking/action/transition/b-roll/silence/music), " +
                    '"motionLevel" (static/low/medium/high), "hasDialogue" (boolean), and "confidence" ' +
                    "(number from 0 to 1). Do not infer transitions from a still image.",
              },
              ...imageParts,
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok) {
      throw new Error(`NVIDIA NIM returned HTTP ${response.status}.`);
    }
    const content = await readOmniRouteContent(response);
    const parsed = parseJsonValue(content);
    const items = mosaic
      ? mosaicItems(parsed)
      : parsed && typeof parsed === "object" && Array.isArray(parsed.descriptions)
        ? parsed.descriptions
        : [];
    const timestamps = mosaic
      ? batch.mosaic.timestamps
      : batch.frames.map((frame) => frame.timestamp);
    if (items.length !== timestamps.length) {
      throw new Error(
        `NVIDIA NIM returned an incomplete frame description batch (${items.length}/${timestamps.length}).`,
      );
    }
    const descriptions = items.map((item, index) =>
      describeFromItem(timestamps[index], item, "NVIDIA NIM"),
    );
    totalFrames += descriptions.length;
    batches.push({ batchIndex: batch.batchIndex, descriptions });
  }
  return {
    videoId: payload.videoId,
    batches,
    totalFrames,
    processingTimeMs: Date.now() - started,
  };
}

async function probePython() {
  try {
    const response = await fetch("http://127.0.0.1:8000/health", {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body.engine === "python" && body.status === "ok";
  } catch {
    return false;
  }
}

async function waitFor(label, check, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`${label} exited early with code ${child.exitCode}.`);
    }
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`${label} did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function getProjectSnapshot(targetPage) {
  return targetPage.evaluate(async () => {
    const { useProjectStore } = await import("/src/stores/project-store.ts");
    const project = useProjectStore.getState().project;
    const media = project.mediaLibrary.items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      analysisRole: item.analysisRole ?? null,
      duration: item.metadata?.duration ?? null,
    }));
    const mediaById = new Map(media.map((item) => [item.id, item]));
    const tracks = project.timeline.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        mediaId: clip.mediaId,
        mediaName: mediaById.get(clip.mediaId)?.name ?? null,
        startTime: clip.startTime,
        duration: clip.duration,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        effects: clip.effects?.map((effect) => effect.type) ?? [],
      })),
      clipCount: track.clips.length,
    }));
    return {
      id: project.id,
      name: project.name,
      settings: project.settings,
      duration: project.timeline.duration,
      media,
      tracks,
      clips: tracks.flatMap((track) => track.clips),
      mirrorProfile: Boolean(project.mirrorProfile),
    };
  });
}

async function getChatSnapshot(targetPage) {
  return targetPage.evaluate(async () => {
    const { useChatStore } = await import("/src/stores/chat-store.ts");
    const state = useChatStore.getState();
    return {
      status: state.status,
      analysisMode: state.analysisMode,
      error: state.error ?? null,
      pendingConfirm: state.pendingConfirm?.call?.name ?? null,
      reference: state.reference ? { name: state.reference.name } : null,
      usage: state.usage,
      messages: state.messages.map((message) => ({
        role: message.role,
        text: message.text ?? "",
        notice: message.notice ?? null,
        toolCalls: (message.toolCalls ?? []).map((tool) => ({
          name: tool.name,
          status: tool.status,
          ok: typeof tool.result?.ok === "boolean" ? tool.result.ok : null,
          summary: tool.result?.summary ?? null,
          error: tool.result?.error?.message ?? null,
        })),
      })),
    };
  });
}

async function saveJson(name, value) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function waitForFileInProject(namePattern, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getProjectSnapshot(page);
    if (
      snapshot.media.some(
        (media) => namePattern.test(media.name) && Number(media.duration) > 0,
      )
    ) {
      return snapshot;
    }
    await sleep(1500);
  }
  throw new Error(`Timed out importing ${namePattern}.`);
}

async function dismissTour() {
  const skipTour = page.getByRole("button", { name: "Skip Tour", exact: true }).first();
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.click();
    await sleep(500);
  }
  await page.keyboard.press("Escape").catch(() => {});
}

async function openComposer() {
  const composer = page.getByRole("textbox", { name: "AI edit request" });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await composer.isVisible().catch(() => false)) return;
    await dismissTour();
    await page
      .getByRole("button", { name: "AI Editor chat" })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await sleep(1200);
  }
  if (!(await composer.isVisible().catch(() => false))) {
    throw new Error("The AI edit composer did not become visible.");
  }
}

async function approvePendingTool(chat) {
  if (!chat.pendingConfirm) return false;
  const approveAll = page.getByRole("button", { name: "Approve all this turn", exact: true }).first();
  if (await approveAll.isVisible().catch(() => false)) {
    await approveAll.click();
    log(`Approved ${chat.pendingConfirm} for this turn.`);
    return true;
  }
  const approve = page.getByRole("button", { name: "Approve", exact: true }).first();
  if (await approve.isVisible().catch(() => false)) {
    await approve.click();
    log(`Approved ${chat.pendingConfirm}.`);
    return true;
  }
  return false;
}

async function driveDirectorTurn() {
  const deadline = Date.now() + turnTimeoutMs;
  let observedRunning = false;
  let stableSince = Date.now();
  let previousState = "";
  let previousHeartbeat = 0;
  let lastSnapshot = await getChatSnapshot(page);

  while (Date.now() < deadline) {
    const chat = await getChatSnapshot(page);
    lastSnapshot = chat;
    const project = await getProjectSnapshot(page);
    if (chat.status === "running" || chat.status === "awaiting_confirm") observedRunning = true;
    const fingerprint = JSON.stringify({
      status: chat.status,
      messages: chat.messages.slice(-2),
      clipCount: project.clips.length,
    });
    if (fingerprint !== previousState) {
      previousState = fingerprint;
      stableSince = Date.now();
      const latest = chat.messages.at(-1);
      const tools = latest?.toolCalls.map((tool) => `${tool.name}:${tool.status}`) ?? [];
      log(
        `Monet ${chat.status}; ${project.clips.length} timeline clip(s)` +
          (tools.length ? `; tools: ${tools.slice(-4).join(", ")}` : ""),
      );
      if (latest?.notice) log(`Notice: ${latest.notice}`);
      if (latest?.text) log(`Monet: ${latest.text.replace(/\s+/g, " ").slice(-240)}`);
    }

    await approvePendingTool(chat);

    if (Date.now() - previousHeartbeat > 15_000) {
      previousHeartbeat = Date.now();
      log(
        `Progress: vision=${networkCounts.visionWorker} frame-worker request(s), ` +
          `Python=${networkCounts.python} request(s), OmniRoute=${networkCounts.omni} response(s).`,
      );
    }

    const stopVisible = await page
      .getByRole("button", { name: "Stop", exact: true })
      .first()
      .isVisible()
      .catch(() => false);
    const lastUserIndex = chat.messages.findLastIndex((message) => message.role === "user");
    const hasAssistantReply =
      lastUserIndex >= 0 &&
      chat.messages.slice(lastUserIndex + 1).some((message) => message.role === "assistant");
    if (
      (observedRunning || hasAssistantReply) &&
      chat.status === "idle" &&
      !stopVisible &&
      Date.now() - stableSince > 12_000
    ) {
      return chat;
    }
    if (chat.status === "error") {
      throw new Error(`Monet stopped with an error: ${chat.error ?? "unknown error"}`);
    }
    await sleep(1800);
  }
  throw new Error(
    `Monet did not finish in ${Math.round(turnTimeoutMs / 60_000)} minutes. ` +
      `Last state: ${lastSnapshot.status}.`,
  );
}

async function getExportState() {
  return page.evaluate(async () => {
    const { useUIStore } = await import("/src/stores/ui-store.ts");
    const state = useUIStore.getState().exportState;
    if (!state) return null;
    return {
      isExporting: Boolean(state.isExporting),
      progress: Number(state.progress ?? 0),
      phase: String(state.phase ?? ""),
      error: state.error ?? null,
      complete: Boolean(state.complete),
    };
  });
}

async function exportTimeline() {
  await installExportDiagnostics();
  const pickerPresent = await page.evaluate(() => "showSaveFilePicker" in window);
  if (pickerPresent) {
    await page.evaluate(() => {
      try {
        delete window.showSaveFilePicker;
      } catch {
        window.showSaveFilePicker = () =>
          Promise.reject(new DOMException("File picker unavailable", "NotSupportedError"));
      }
    });
  }

  const downloadPromise = page.waitForEvent("download", { timeout: exportTimeoutMs }).catch(() => null);
  const button = page.getByRole("button", { name: "Export", exact: true }).first();
  await button.click({ timeout: 20_000 });
  log("Export started; waiting for the real browser render/download.");

  const deadline = Date.now() + exportTimeoutMs;
  let lastProgress = -1;
  let lastPhase = "";
  while (Date.now() < deadline) {
    const result = await Promise.race([
      downloadPromise.then((download) => ({ download })),
      sleep(3000).then(() => null),
    ]);
    if (result?.download) {
      const filename = result.download.suggestedFilename() || "curry-captain-edit.mp4";
      const destination = join(outputDir, filename);
      await result.download.saveAs(destination);
      const bytes = statSync(destination).size;
      if (bytes <= 0) throw new Error("The export completed but produced an empty file.");
      return { ok: true, file: destination, bytes, pickerPresent };
    }
    const state = await getExportState();
    if (state?.error) throw new Error(`Export failed: ${state.error}`);
    if (
      state &&
      (state.phase !== lastPhase ||
        Math.floor(state.progress / 10) !== Math.floor(lastProgress / 10))
    ) {
      lastProgress = state.progress;
      lastPhase = state.phase;
      log(`Export: ${state.progress.toFixed(0)}% ${state.phase}`);
    }
    if (state?.complete) {
      throw new Error("The editor reports export complete but Chrome produced no download.");
    }
  }
  throw new Error(`Export did not finish within ${Math.round(exportTimeoutMs / 60_000)} minutes.`);
}

async function installExportDiagnostics() {
  const moduleUrls = {
    exportEngine: `/@fs${resolve(repoRoot, "packages/core/src/export/export-engine.ts")}`,
    videoEngine: `/@fs${resolve(repoRoot, "packages/core/src/video/video-engine.ts")}`,
    audioEngine: `/@fs${resolve(repoRoot, "packages/core/src/audio/audio-engine.ts")}`,
    rendererFactory: `/@fs${resolve(repoRoot, "packages/core/src/video/renderer-factory.ts")}`,
  };
  await page.evaluate(async (urls) => {
    const wrap = (prototype, method, label) => {
      const original = prototype[method];
      if (typeof original !== "function" || original.__emulationWrapped) return;
      const wrapped = async function (...args) {
        console.info(`[emulation-export] ${label} started`);
        try {
          const result = await original.apply(this, args);
          console.info(`[emulation-export] ${label} completed`);
          return result;
        } catch (error) {
          console.error(
            `[emulation-export] ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      };
      wrapped.__emulationWrapped = true;
      prototype[method] = wrapped;
    };

    const [{ ExportEngine }, { VideoEngine }, { AudioEngine }, { RendererFactory }] =
      await Promise.all([
        import(urls.exportEngine),
        import(urls.videoEngine),
        import(urls.audioEngine),
        import(urls.rendererFactory),
      ]);
    wrap(ExportEngine.prototype, "initialize", "ExportEngine.initialize");
    wrap(ExportEngine.prototype, "initializeGPUForExport", "ExportEngine.initializeGPUForExport");
    wrap(VideoEngine.prototype, "initialize", "VideoEngine.initialize");
    wrap(VideoEngine.prototype, "initializeGPUCompositor", "VideoEngine.initializeGPUCompositor");
    wrap(AudioEngine.prototype, "initialize", "AudioEngine.initialize");
    wrap(RendererFactory.prototype, "createRenderer", "RendererFactory.createRenderer");
    console.info("[emulation-export] diagnostics installed");
  }, moduleUrls);
}

const networkCounts = {
  visionWorker: 0,
  python: 0,
  omni: 0,
  cloudflareApi: 0,
  responses: [],
};
const visionProxyStats = {
  requests: 0,
  inputFrames: 0,
  forwardedFrames: 0,
  cloudflareRequests: 0,
  omniFallbackBatches: 0,
  omniFallbackFrames: 0,
  nimFallbackBatches: 0,
  nimFallbackFrames: 0,
};
let visionProxy;
let activeVisionFrameBudget = 60;

function attachNetworkLogging(targetPage) {
  targetPage.on("response", (response) => {
    const url = new URL(response.url());
    const entry = {
      time: Date.now(),
      status: response.status(),
      path: url.pathname,
    };
    if (url.pathname === "/analyze-frames") {
      if (url.port === "8000") networkCounts.python += 1;
      else networkCounts.visionWorker += 1;
    }
    if (url.pathname.startsWith("/api/omni/")) networkCounts.omni += 1;
    if (url.pathname.startsWith("/api/cf-ai/")) networkCounts.cloudflareApi += 1;
    if (
      url.pathname === "/analyze-frames" ||
      url.pathname.startsWith("/api/omni/") ||
      url.pathname.startsWith("/api/cf-ai/")
    ) {
      networkCounts.responses.push(entry);
      log(`[network] ${response.status()} ${url.pathname}`);
    }
  });
  targetPage.on("console", (message) => {
    if (message.text().startsWith("[emulation]") || message.text().startsWith("[emulation-export]")) {
      log(message.text());
    }
  });
  targetPage.on("pageerror", (error) => log(`[browser error] ${error.message.slice(0, 300)}`));
}

async function recoverTimelineWithLocalAgentAndMeasuredReference() {
  log("Monet left the timeline empty. Running the real source-analysis tool and reference compiler as recovery.");
  const agentModuleUrl = `/@fs${resolve(repoRoot, "packages/agent/src/index.ts")}`;
  return page.evaluate(async ({ agentEntryUrl, promptText }) => {
    const projectModule = await import("/src/stores/project-store.ts");
    const chatModule = await import("/src/stores/chat-store.ts");
    const hostModule = await import("/src/services/agent/host-singleton.ts");
    const referenceFlow = await import("/src/services/mirror/reference-flow.ts");
    const agent = await import(agentEntryUrl);
    const store = projectModule.useProjectStore.getState();
    const project = store.project;
    const referenceAttachment = chatModule.useChatStore.getState().reference;
    const source = project.mediaLibrary.items.find(
      (item) => item.type === "video" && item.analysisRole !== "reference",
    );
    const referenceItem = referenceAttachment
      ? project.mediaLibrary.items.find((item) => item.id === referenceAttachment.mediaId)
      : project.mediaLibrary.items.find(
          (item) => item.type === "video" && item.analysisRole === "reference",
        );
    if (!source) throw new Error("Recovery could not find source footage.");
    if (!referenceItem) throw new Error("Recovery could not find the attached style reference.");

    const resolveBlob = async (item) =>
      item.blob ?? (await item.fileHandle?.getFile()) ?? null;
    const sourceBlob = await resolveBlob(source);
    const referenceBlob =
      referenceAttachment?.file ?? (await resolveBlob(referenceItem));
    if (!sourceBlob) throw new Error(`Recovery could not read source footage: ${source.name}`);
    if (!referenceBlob) throw new Error(`Recovery could not read the style reference: ${referenceItem.name}`);

    agent.setAnalysisMode("ai");
    let vision;
    let segmentMap = null;
    try {
      const result = await agent.executeTool(
        "extract_segments",
        { videoMediaIds: [source.id] },
        hostModule.getLiveEditorHost(),
      );
      vision = {
        ok: result.ok,
        summary: result.summary,
        error: result.error?.message ?? null,
        frameCount:
          typeof result.data?.frameCount === "number" ? result.data.frameCount : null,
        segmentCount:
          typeof result.data?.totalSegments === "number" ? result.data.totalSegments : null,
      };
      segmentMap = result.data?.segmentMap ?? null;
      if (!result.ok) console.error(`[emulation] source analysis failed: ${result.summary}`);
      else console.info(`[emulation] source analysis: ${result.summary}`);
    } catch (error) {
      vision = {
        ok: false,
        summary: null,
        error: error instanceof Error ? error.message : String(error),
        frameCount: null,
        segmentCount: null,
      };
      console.error(`[emulation] source analysis failed: ${vision.error}`);
    }

    console.info("[emulation] measuring the Captain Price reference in the browser");
    const measured = await referenceFlow.measureReferenceVideo(referenceBlob, {
      onProgress: (done, total) => {
        if (done === total || done % 10 === 0) {
          console.info(`[emulation] reference frames ${done}/${total}`);
        }
      },
    });
    const profile = await referenceFlow.enrichReferenceVideo(referenceBlob, measured.profile);
    console.info(`[emulation] measured ${profile.shots.length} reference shot(s)`);

    const referenceAnalysis = {
      version: profile.version,
      shotCount: profile.shots.length,
      shots: profile.shots.map((shot) => ({
        durationSeconds: (shot.endFrame - shot.startFrame) * profile.fps.den / profile.fps.num,
        dominantMove: shot.cameraMotion?.dominantMove ?? "unknown",
      })),
      rhythmCurve: profile.rhythmCurve.map((frames) => frames * profile.fps.den / profile.fps.num),
      styleEvidence: profile.styleEvidence,
      aspectRatio: profile.aspectRatio,
      dominantMoves: profile.shots.map((shot) => shot.cameraMotion?.dominantMove ?? "unknown"),
    };

    await referenceFlow.attachReferenceProfile(profile);
    let directorPlan = null;
    let clipCount = 0;
    const countClips = () =>
      projectModule.useProjectStore.getState().project.timeline.tracks.reduce(
        (sum, track) => sum + track.clips.length,
        0,
      );

    if (segmentMap && Array.isArray(segmentMap.videos)) {
      try {
        const result = await agent.executeTool(
          "plan_edit",
          { prompt: promptText, segmentMap, referenceAnalysis },
          hostModule.getLiveEditorHost(),
        );
        directorPlan = {
          ok: result.ok,
          summary: result.summary,
          error: result.error?.message ?? null,
        };
        console.info(`[emulation] director plan: ${result.summary}`);
      } catch (error) {
        directorPlan = {
          ok: false,
          summary: null,
          error: error instanceof Error ? error.message : String(error),
        };
        console.error(`[emulation] director plan failed: ${directorPlan.error}`);
      }
      clipCount = countClips();
    }

    let applied = null;
    if (clipCount === 0) {
      console.warn("[emulation] director did not populate the timeline; applying the measured reference structure.");
      applied = await referenceFlow.applyReferenceStructure(profile, [
        {
          id: source.id,
          name: source.name,
          duration: source.metadata.duration,
          blob: sourceBlob,
        },
      ]);
      clipCount = countClips();
    }
    if (clipCount === 0) throw new Error("Timeline recovery completed without adding timeline clips.");
    return {
      vision,
      directorPlan,
      reference: {
        fps: measured.clock.fps,
        shotCount: profile.shots.length,
        warnings: profile.warnings ?? [],
      },
      applied: applied ? { summary: applied.summary, warnings: applied.warnings } : null,
      clipCount,
    };
  }, { agentEntryUrl: agentModuleUrl, promptText: prompt });
}

async function main() {
  activeVisionFrameBudget = Number(process.env.KOVE_VISION_FRAME_BUDGET ?? 60);
  if (!Number.isInteger(activeVisionFrameBudget) || activeVisionFrameBudget < 2) {
    throw new Error("KOVE_VISION_FRAME_BUDGET must be an integer greater than or equal to 2.");
  }
  for (const [label, path] of [
    ["source", sourcePath],
    ["style reference", referencePath],
  ]) {
    if (!existsSync(path)) throw new Error(`Missing ${label} file: ${path}`);
  }
  mkdirSync(join(outputDir, "screens"), { recursive: true });

  log(`Source: ${sourcePath}`);
  log(`Style reference: ${referencePath}`);
  log(`Evidence directory: ${outputDir}`);

  const pythonExecutable = join(repoRoot, "packages/python-engine/.venv/bin/python");
  const pythonServer = join(repoRoot, "packages/python-engine/server.py");
  if (!(await probePython())) {
    if (!existsSync(pythonExecutable) || !existsSync(pythonServer)) {
      throw new Error(
        "Python analysis is unavailable. Create packages/python-engine/.venv and install its project dependencies.",
      );
    }
    const python = startService(
      "python",
      pythonExecutable,
      [pythonServer],
      join(repoRoot, "packages/python-engine"),
    );
    await waitFor("Python analysis engine", probePython, python);
  } else {
    log("Reusing the healthy Python analysis engine on port 8000.");
  }

  const cloudflareAccount =
    process.env.CLOUDFLARE_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const cloudflareToken =
    process.env.CLOUDFLARE_API_TOKEN ?? vars.CLOUDFLARE_API_TOKEN ?? "";
  const configuredVisionUrl =
    process.env.KOVE_VISION_WORKER_URL ??
    process.env.VITE_VISION_WORKER_URL ??
    vars.KOVE_VISION_WORKER_URL ??
    "";

  const primaryVision = configuredVisionUrl
    ? { kind: "remote", url: configuredVisionUrl }
    : cloudflareAccount && cloudflareToken
      ? {
          kind: "cloudflare",
          accountId: cloudflareAccount,
          apiToken: cloudflareToken,
          model:
            process.env.CLOUDFLARE_AI_MODEL ??
            vars.CLOUDFLARE_AI_MODEL ??
            "@cf/meta/llama-3.2-11b-vision-instruct",
        }
      : null;
  let visionWorkerUrl = "";

  if (!primaryVision) {
    log("Cloudflare Workers AI credentials are not configured; using local Python vision.");
  }

  if (primaryVision) {
    visionWorkerUrl = await startVisionProxy(primaryVision, activeVisionFrameBudget);
    log(
      `Vision worker enabled with a ${activeVisionFrameBudget}-frame-per-video budget; failed requests fall back to OmniRoute, then Python.`,
    );
    if (!omniApiKey || !omniModel) {
      log("OmniRoute vision fallback is not configured; Python will be the final vision fallback.");
    }
    if (primaryVision.kind !== "cloudflare") {
      log("Configured vision-worker frames may be sent to its remote provider.");
    } else {
      log("Sampled source frames will be sent to Cloudflare Workers AI.");
    }
  }

  const appPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const viteCli = join(repoRoot, "apps/web/node_modules/.bin/vite");
  const vite = startService(
    "vite",
    viteCli,
    ["--host", "127.0.0.1", "--port", String(appPort), "--strictPort"],
    join(repoRoot, "apps/web"),
    { ...process.env, VITE_VISION_WORKER_URL: visionWorkerUrl },
  );
  await waitFor(
    "K.O.V.E. web app",
    async () => {
      try {
        const response = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
        return response.ok;
      } catch {
        return false;
      }
    },
    vite,
    120_000,
  );

  const chromePath =
    process.env.KOVE_E2E_CHROMIUM ??
    (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined);
  browser = await chromium.launch({
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  browser.on("disconnected", () => {
    browserClosed = true;
  });
  context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1680, height: 1000 },
  });
  page = await context.newPage();
  attachNetworkLogging(page);

  log(`Opening Chrome at ${baseUrl}`);
  await page.addInitScript(() => {
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
  });
  await page.goto(`${baseUrl}/#new`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    localStorage.setItem("kove-advanced-onboarding-complete", "true");
  });
  await page.waitForTimeout(3500);
  await dismissTour();
  await openComposer();

  const mode = await getChatSnapshot(page);
  if (mode.analysisMode !== "ai") {
    await page.evaluate(async () => {
      const { useChatStore } = await import("/src/stores/chat-store.ts");
      useChatStore.getState().setAnalysisMode("ai");
    });
    await waitFor(
      "AI analysis mode",
      async () => (await getChatSnapshot(page)).analysisMode === "ai",
      null,
      10_000,
    );
  }
  await page.screenshot({ path: join(outputDir, "screens", "01-ai-mode.png") });

  log("Importing the Curry source video into the editor.");
  await page.locator('input[aria-label="Import media"]').setInputFiles(sourcePath);
  let project = await waitForFileInProject(/Steph Curry IGNITES/i);
  log(`Source imported (${project.media.find((item) => /Steph Curry IGNITES/i.test(item.name))?.duration ?? "duration unknown"}s).`);
  await page.screenshot({ path: join(outputDir, "screens", "02-source-imported.png") });

  log("Attaching Captain Price as a style reference (not source footage).");
  await page.locator('input[aria-label="Attach reference video"]').setInputFiles(referencePath);
  await waitFor(
    "Captain Price reference attachment",
    async () => (await getChatSnapshot(page)).reference?.name === "captain price (2nd priority).MP4",
    null,
    300_000,
  );
  const intent = page.getByRole("group", { name: "Reference intent" });
  await intent.getByRole("button", { name: "Reference", exact: true }).click();
  await page.screenshot({ path: join(outputDir, "screens", "03-reference-attached.png") });

  const before = await getProjectSnapshot(page);
  await saveJson("before.json", before);
  log(`Project ready: ${before.media.length} media item(s), ${before.clips.length} timeline clips.`);

  const composer = page.getByRole("textbox", { name: "AI edit request" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  log("Prompt sent to Monet.");
  await page.screenshot({ path: join(outputDir, "screens", "04-prompt-sent.png") });

  const chat = await driveDirectorTurn();
  project = await getProjectSnapshot(page);
  let recovery = null;
  if (project.clips.length === 0) {
    recovery = await recoverTimelineWithLocalAgentAndMeasuredReference();
    project = await getProjectSnapshot(page);
  }
  await saveJson("chat.json", chat);
  await saveJson("timeline.json", project);
  await page.screenshot({ path: join(outputDir, "screens", "05-timeline-populated.png") });

  const toolCalls = chat.messages.flatMap((message) => message.toolCalls);
  const extract = toolCalls.find((tool) => tool.name === "extract_segments") ?? null;
  const report = {
    verdict: project.clips.length > 0 ? "TIMELINE_POPULATED" : "EMPTY_TIMELINE",
    prompt,
    source: sourcePath,
    styleReference: referencePath,
    analysisMode: chat.analysisMode,
    vision: {
      summary: extract?.summary ?? null,
      status: extract?.status ?? null,
      localPythonRequests: networkCounts.python,
      workersAIRequests: networkCounts.visionWorker,
      omniRouteResponses: networkCounts.omni,
      cloudflareAiProxyResponses: networkCounts.cloudflareApi,
      workerFrameBudget: activeVisionFrameBudget,
      visionProxy: visionProxyStats,
      recovery: recovery?.vision ?? null,
      responses: networkCounts.responses,
    },
    timeline: {
      clipCount: project.clips.length,
      duration: project.duration,
      media: project.media,
      tracks: project.tracks.map(({ id, name, type, clipCount }) => ({
        id,
        name,
        type,
        clipCount,
      })),
      clips: project.clips,
      styleProfileAttached: project.mirrorProfile,
    },
    recovery: recovery
      ? {
          vision: recovery.vision,
          reference: recovery.reference,
          directorPlan: recovery.directorPlan,
          applied: recovery.applied,
          clipCount: recovery.clipCount,
        }
      : null,
    export: null,
  };
  await saveJson("report.json", report);
  log(`Timeline now has ${project.clips.length} clip(s) across ${project.tracks.length} track(s).`);
  log(
    `Vision result: ${extract?.summary ?? recovery?.vision?.summary ?? "No source analysis result was recorded."}`,
  );

  if (project.clips.length === 0) {
    throw new Error("Timeline recovery did not populate the timeline. See report.json and the browser screenshots.");
  }
  if (
    project.clips.some(
      (clip) => clip.mediaName?.toLowerCase() === "captain price (2nd priority).mp4",
    )
  ) {
    throw new Error("The style reference was placed on the timeline as source footage.");
  }
  if (!project.mirrorProfile) {
    throw new Error("The reference's measured style profile was not attached to the edit.");
  }

  const exportResult = await exportTimeline();
  report.export = exportResult;
  report.verdict = "EXPORTED";
  await saveJson("report.json", report);
  await page.screenshot({ path: join(outputDir, "screens", "06-exported.png") });
  log(`Export saved (${exportResult.bytes} bytes): ${exportResult.file}`);
  log(`Evidence saved to ${outputDir}`);
  log("Chrome will stay open for inspection. Close the Chrome window or press Ctrl+C to stop the local services.");
  finishedSuccessfully = true;
  await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
}

process.once("SIGINT", () => {
  log("Stopping emulation services.");
  void cleanup().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`EMULATION FAILED: ${message}`);
  if (page && !browserClosed) {
    await page.screenshot({ path: join(outputDir, "screens", "failure.png") }).catch(() => {});
    await saveJson("failure.json", {
      error: message,
      network: networkCounts,
      at: new Date().toISOString(),
    }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (!finishedSuccessfully || browserClosed) await cleanup();
}
