export interface Env {
  CF_AI_MODEL: string;
  AI?: Ai;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Shared secret every request must present as `Authorization: Bearer <token>`.
   *
   * Required. Without it the worker refuses to serve rather than running open:
   * every request spends the account's AI neurons, so an unauthenticated
   * deployment is an open tab on the account's quota.
   */
  WORKER_AUTH_TOKEN?: string;
  /**
   * Comma-separated list of browser origins allowed to call this worker, or `*`
   * to allow any. Unset means no cross-origin access at all.
   *
   * This is what stopped the previous `Access-Control-Allow-Origin: *`, which let
   * any page on the internet spend this account's quota from a visitor's browser.
   */
  ALLOWED_ORIGINS?: string;
  /** Total frames accepted per request. Default 40. */
  MAX_FRAMES_PER_REQUEST?: string;
  /** Frames accepted in a single batch. Default 8. */
  MAX_FRAMES_PER_BATCH?: string;
  /** Maximum base64 length of one frame. Default 2000000 (~1.5MB decoded). */
  MAX_FRAME_BYTES?: string;
  /**
   * Best-effort per-caller request limit per minute, per worker isolate.
   * Default 20. Not a global limit — see `rateLimitAllows`.
   */
  MAX_REQUESTS_PER_MINUTE?: string;
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
  /** Frames whose model call failed. Present only when something failed. */
  readonly failedFrames?: number;
  readonly requestId?: string;
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

const DEFAULTS = {
  maxFramesPerRequest: 40,
  maxFramesPerBatch: 8,
  maxFrameBytes: 2_000_000,
  maxRequestsPerMinute: 20,
};

const RATE_WINDOW_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on a secret leaks its length and matching prefix through timing.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function resolveAllowedOrigins(env: Env): readonly string[] | "*" {
  const configured = env.ALLOWED_ORIGINS?.trim();
  if (!configured) return [];
  if (configured === "*") return "*";
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * CORS headers for this request.
 *
 * `Vary: Origin` is always sent so a cache can never serve one origin's
 * CORS header to another.
 */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  };
  const origin = request.headers.get("Origin");
  if (!origin) return headers;

  const allowed = resolveAllowedOrigins(env);
  if (allowed === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function isOriginAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  // No Origin header: not a browser cross-origin request (curl, server-side).
  // Authorization still applies.
  if (!origin) return true;
  const allowed = resolveAllowedOrigins(env);
  if (allowed === "*") return true;
  return allowed.includes(origin);
}

type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

export function authorize(request: Request, env: Env): AuthResult {
  if (!env.WORKER_AUTH_TOKEN) {
    return {
      ok: false,
      status: 503,
      message:
        "This worker is not configured: WORKER_AUTH_TOKEN is unset, so it refuses to serve unauthenticated requests.",
    };
  }

  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return { ok: false, status: 401, message: "Missing bearer token." };
  }
  const presented = header.slice(prefix.length);
  if (!timingSafeEqual(presented, env.WORKER_AUTH_TOKEN)) {
    return { ok: false, status: 401, message: "Invalid token." };
  }
  return { ok: true };
}

const requestLog = new Map<string, number[]>();

/**
 * Best-effort per-caller rate limit.
 *
 * Cloudflare runs an isolate per colo and recycles them, and this Map lives in
 * one isolate, so the real limit is `limit * isolates`. It stops a single client
 * hammering one isolate; it is not a global quota. A real one needs Cloudflare's
 * Rate Limiting rules, a KV/Durable Object counter, or the account's own AI
 * gateway limits. `limit <= 0` disables it.
 */
export function rateLimitAllows(
  key: string,
  limit: number,
  now: number = Date.now(),
): boolean {
  if (limit <= 0) return true;
  const recent = (requestLog.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= limit) {
    requestLog.set(key, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(key, recent);
  if (requestLog.size > 1000) {
    for (const [candidate, times] of requestLog) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) requestLog.delete(candidate);
    }
  }
  return true;
}

/** Test hook: the limiter is module state. */
export function resetRateLimiter(): void {
  requestLog.clear();
}

export function callerKey(request: Request): string {
  // cf-connecting-ip is set by Cloudflare and cannot be spoofed by the client.
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

interface ValidatedPayload {
  readonly body: VisionRequest;
}

function validatePayload(
  body: unknown,
  env: Env,
): { readonly ok: true; readonly value: ValidatedPayload } | { readonly ok: false; readonly status: number; readonly message: string } {
  if (body === null || typeof body !== "object") {
    return { ok: false, status: 400, message: "Body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const frames = record.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return { ok: false, status: 400, message: "frames array is required and must not be empty" };
  }
  if (typeof record.videoId !== "string" || record.videoId.length === 0) {
    return { ok: false, status: 400, message: "videoId is required" };
  }

  const maxPerBatch = positiveInt(env.MAX_FRAMES_PER_BATCH, DEFAULTS.maxFramesPerBatch);
  const maxPerRequest = positiveInt(env.MAX_FRAMES_PER_REQUEST, DEFAULTS.maxFramesPerRequest);
  const maxFrameBytes = positiveInt(env.MAX_FRAME_BYTES, DEFAULTS.maxFrameBytes);

  let total = 0;
  for (const batch of frames) {
    if (batch === null || typeof batch !== "object") {
      return { ok: false, status: 400, message: "Each batch must be an object." };
    }
    const batchFrames = (batch as Record<string, unknown>).frames;
    if (!Array.isArray(batchFrames)) {
      return { ok: false, status: 400, message: "Each batch must carry a frames array." };
    }
    if (batchFrames.length > maxPerBatch) {
      return {
        ok: false,
        status: 413,
        message: `Batch exceeds the ${maxPerBatch}-frame limit.`,
      };
    }
    for (const frame of batchFrames) {
      const data = (frame as Record<string, unknown> | null)?.imageData;
      if (typeof data !== "string") {
        return { ok: false, status: 400, message: "Every frame needs base64 imageData." };
      }
      if (data.length > maxFrameBytes) {
        return { ok: false, status: 413, message: `Frame exceeds the ${maxFrameBytes}-byte limit.` };
      }
    }
    total += batchFrames.length;
  }

  if (total > maxPerRequest) {
    return {
      ok: false,
      status: 413,
      message: `Request exceeds the ${maxPerRequest}-frame limit (${total} frames).`,
    };
  }

  return { ok: true, value: { body: record as unknown as VisionRequest } };
}

const VISION_PROMPT = `Analyze this single video frame as part of a reference video edit. Return a JSON object with these fields:
- "description": A concise description of what is happening in the frame (1-2 sentences)
- "sceneType": One of "talking", "action", "transition", "b-roll", "silence", "music"
- "motionLevel": One of "static", "low", "medium", "high"
- "hasDialogue": true if someone appears to be speaking, false otherwise
- "confidence": A number 0-1 indicating how confident you are in this analysis
- "editSignals": {"shotType":"wide|medium|close-up|unknown","transition":"unknown","overlayText":string|null,"effects":string[],"colorTreatment":string|null,"usedFor":string[]}

For usedFor, name the editorial purpose visible at this timestamp, such as dialogue, b-roll coverage, hook, reaction, pacing beat, or transition. Do not infer temporal transitions from one frame; use "unknown". Do not infer an effect unless there is visible evidence.

Return ONLY the JSON object, no other text.`;

/**
 * Describe one frame.
 *
 * Throws on failure. The caller decides what a failed frame means: previously one
 * bad frame aborted the entire request and discarded every description already
 * paid for.
 */
async function describeFrame(
  env: Env,
  frame: FrameData,
  requestId: string,
): Promise<FrameDescription> {
  const model = env.CF_AI_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error("Cloudflare credentials not configured");
  }

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
              { type: "text", text: VISION_PROMPT },
            ],
          },
        ],
        max_tokens: 256,
      }),
    },
  );

  if (!response.ok) {
    // The upstream body can carry account details; log a clipped copy, never
    // return it. The client gets a generic message with a correlation id.
    const detail = (await response.text()).slice(0, 500);
    console.error(`[${requestId}] vision upstream ${response.status}: ${detail}`);
    throw new Error(`vision upstream ${response.status}`);
  }

  const result = (await response.json()) as {
    result?: { response?: string };
    errors?: Array<{ message?: string }>;
  };

  if (result.errors && result.errors.length > 0) {
    console.error(`[${requestId}] vision upstream errors: ${JSON.stringify(result.errors).slice(0, 500)}`);
    throw new Error("vision upstream returned errors");
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
  return {
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
  };
}

export async function handleVisionRequest(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json", ...cors },
    });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!isOriginAllowed(request, env)) {
    return json({ error: "Origin not allowed." }, 403);
  }

  const auth = authorize(request, env);
  if (!auth.ok) return json({ error: auth.message }, auth.status);

  const limit = positiveInt(env.MAX_REQUESTS_PER_MINUTE, DEFAULTS.maxRequestsPerMinute);
  if (!rateLimitAllows(callerKey(request), limit)) {
    return json({ error: "Too many requests." }, 429);
  }

  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return json({ error: "Body is not valid JSON." }, 400);
  }

  const validated = validatePayload(parsedBody, env);
  if (!validated.ok) return json({ error: validated.message }, validated.status);

  const { body } = validated.value;
  const batchResults: BatchResult[] = [];
  let failedFrames = 0;

  try {
    for (const batch of body.frames) {
      const descriptions: FrameDescription[] = [];
      for (const frame of batch.frames) {
        try {
          descriptions.push(await describeFrame(env, frame, requestId));
        } catch (error) {
          // One frame's failure must not discard the frames that succeeded.
          failedFrames += 1;
          console.error(
            `[${requestId}] frame at ${frame.timestamp}s failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          );
        }
      }
      batchResults.push({ batchIndex: batch.batchIndex, descriptions });
    }
  } catch (error) {
    console.error(`[${requestId}] request failed: ${error instanceof Error ? error.message : "unknown"}`);
    return json({ error: "Frame analysis failed.", requestId }, 500);
  }

  const visionResult: VisionResult = {
    videoId: body.videoId,
    batches: batchResults,
    totalFrames: batchResults.reduce((sum, batch) => sum + batch.descriptions.length, 0),
    processingTimeMs: Date.now() - startTime,
    ...(failedFrames > 0 ? { failedFrames } : {}),
    requestId,
  };

  return json(visionResult);
}

export default {
  fetch: handleVisionRequest,
};
