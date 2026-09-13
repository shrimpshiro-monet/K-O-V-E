export interface Env {
  CF_AI_MODEL: string;
  AI?: Ai;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface VisionRequest {
  readonly frames: readonly FrameBatch[];
  readonly videoId: string;
  readonly totalDuration: number;
}

export interface FrameBatch {
  readonly batchIndex: number;
  readonly frames: readonly FrameData[];
}

export interface FrameData {
  readonly timestamp: number;
  readonly imageData: string; // base64 encoded
  readonly width: number;
  readonly height: number;
}

export interface VisionResult {
  readonly videoId: string;
  readonly batches: readonly BatchResult[];
  readonly totalFrames: number;
  readonly processingTimeMs: number;
}

export interface BatchResult {
  readonly batchIndex: number;
  readonly descriptions: readonly FrameDescription[];
}

export interface FrameDescription {
  readonly timestamp: number;
  readonly description: string;
  readonly sceneType: string;
  readonly motionLevel: string;
  readonly hasDialogue: boolean;
  readonly confidence: number;
  readonly editSignals: EditSignals;
}

export interface EditSignals {
  readonly shotType: "wide" | "medium" | "close-up" | "unknown";
  readonly transition: "hard-cut" | "dissolve" | "wipe" | "none" | "unknown";
  readonly overlayText: string | null;
  readonly effects: readonly string[];
  readonly colorTreatment: string | null;
  readonly usedFor: readonly string[];
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function analyzeBatch(
  env: Env,
  batch: FrameBatch,
  _videoId: string,
): Promise<BatchResult> {
  const model = env.CF_AI_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error("Cloudflare credentials not configured");
  }

  const descriptions: FrameDescription[] = [];

  for (const frame of batch.frames) {
    const prompt = `Analyze this single video frame as part of a reference video edit. Return a JSON object with these fields:
- "description": A concise description of what is happening in the frame (1-2 sentences)
- "sceneType": One of "talking", "action", "transition", "b-roll", "silence", "music"
- "motionLevel": One of "static", "low", "medium", "high"
- "hasDialogue": true if someone appears to be speaking, false otherwise
- "confidence": A number 0-1 indicating how confident you are in this analysis
- "editSignals": {"shotType":"wide|medium|close-up|unknown","transition":"unknown","overlayText":string|null,"effects":string[],"colorTreatment":string|null,"usedFor":string[]}

For usedFor, name the editorial purpose visible at this timestamp, such as dialogue, b-roll coverage, hook, reaction, pacing beat, or transition. Do not infer temporal transitions from one frame; use "unknown". Do not infer an effect unless there is visible evidence.

Return ONLY the JSON object, no other text.`;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.imageData}` } },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: 256,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vision API error: ${response.status} ${errorText}`);
    }

    const result = (await response.json()) as {
      result?: { response?: string };
      errors?: Array<{ message?: string }>;
    };

    if (result.errors && result.errors.length > 0) {
      throw new Error(`Vision API errors: ${result.errors.map((e) => e.message).join(", ")}`);
    }

    const rawText = result.result?.response ?? "";

    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }

    const signals = parsed.editSignals as Record<string, unknown> | undefined;
    descriptions.push({
      timestamp: frame.timestamp,
      description: String(parsed.description ?? "No description available"),
      sceneType: String(parsed.sceneType ?? "b-roll"),
      motionLevel: String(parsed.motionLevel ?? "medium"),
      hasDialogue: Boolean(parsed.hasDialogue),
      confidence: Number(parsed.confidence ?? 0.5),
      editSignals: {
        shotType: String(signals?.shotType ?? "unknown") as EditSignals["shotType"],
        transition: String(signals?.transition ?? "unknown") as EditSignals["transition"],
        overlayText: typeof signals?.overlayText === "string" ? signals.overlayText : null,
        effects: Array.isArray(signals?.effects) ? signals.effects.map(String) : [],
        colorTreatment: typeof signals?.colorTreatment === "string" ? signals.colorTreatment : null,
        usedFor: Array.isArray(signals?.usedFor) ? signals.usedFor.map(String) : [],
      },
    });
  }

  return { batchIndex: batch.batchIndex, descriptions };
}

async function handleVisionRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const startTime = Date.now();

  try {
    const body = (await request.json()) as VisionRequest;
    const { frames, videoId, totalDuration: _totalDuration } = body;

    if (!frames || !Array.isArray(frames) || frames.length === 0) {
      return json({ error: "frames array is required and must not be empty" }, 400);
    }

    if (!videoId) {
      return json({ error: "videoId is required" }, 400);
    }

    const batchResults: BatchResult[] = [];
    for (const batch of frames) {
      const result = await analyzeBatch(env, batch, videoId);
      batchResults.push(result);
    }

    const totalFrames = batchResults.reduce(
      (sum, b) => sum + b.descriptions.length,
      0,
    );

    const visionResult: VisionResult = {
      videoId,
      batches: batchResults,
      totalFrames,
      processingTimeMs: Date.now() - startTime,
    };

    return json(visionResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
}

export default {
  fetch: handleVisionRequest,
};
