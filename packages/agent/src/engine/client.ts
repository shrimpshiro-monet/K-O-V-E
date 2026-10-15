/**
 * The one HTTP client for the local python engine (packages/python-engine).
 *
 * Everything here is the hardening the frame-worker's polling loop lacked:
 *
 *   - `res.ok` is checked *before* `.json()`. A 500 with an HTML body used to
 *     surface as a JSON SyntaxError, which reads like a bug in the caller.
 *   - Non-OK responses carry the HTTP status and a truncated body.
 *   - The timeout error names the last observed job status, so "wedged at
 *     running" is distinguishable from "never started".
 */

const JOB_POLL_INTERVAL_MS = 500;
const JOB_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Base URL of the python engine. `KOVE_ENGINE_URL` wins; the default matches
 * the sidecar's `uvicorn.run(app, host="0.0.0.0", port=8000)`.
 */
export const ENGINE_BASE_URL: string =
  (typeof process !== "undefined" && process.env.KOVE_ENGINE_URL) ||
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_ENGINE_URL) ||
  "http://localhost:8000";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface EngineErrorOptions {
  readonly status?: number | null;
  readonly url?: string;
  readonly body?: string;
}

/** A structured engine failure. `status` is null for transport-level errors. */
export class EngineRequestError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly body: string | undefined;

  constructor(message: string, options: EngineErrorOptions = {}) {
    super(message);
    this.name = "EngineRequestError";
    this.status = options.status ?? null;
    this.url = options.url ?? "";
    this.body = options.body;
  }
}

export function engineUrl(path: string): string {
  return `${ENGINE_BASE_URL.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Best-effort body for an error message; never throws, never blocks long. */
async function safeText(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text ? text.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Throws a structured error for any non-OK response. The status is in the
 * message because callers surface `error.message` straight to the model.
 */
async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await safeText(response);
  const detail = body ? `: ${body}` : "";
  throw new EngineRequestError(
    `${action} failed: HTTP ${response.status}${detail}`,
    { status: response.status, url: response.url, body },
  );
}

export interface EngineHealth {
  readonly status: string;
  readonly engine?: string;
  readonly version?: string;
}

/** GET /health. Throws EngineRequestError when the sidecar is unreachable. */
export async function engineHealth(): Promise<EngineHealth> {
  const url = engineUrl("/health");
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new EngineRequestError(
      `Engine health check failed: ${error instanceof Error ? error.message : String(error)} (${url}). Is the python engine running?`,
      { status: null, url },
    );
  }
  await assertOk(response, "Engine health check");
  return (await response.json()) as EngineHealth;
}

export interface AnalysisUploadOptions {
  readonly baselineFps?: number;
  readonly burstFps?: number;
  readonly sceneThreshold?: number;
}

export interface EngineJobAccepted {
  readonly jobId: string;
  readonly status: string;
}

/**
 * POST /analyze-upload (multipart). Returns the job handle; poll it with
 * `pollEngineJob`. The engine decodes the file itself, so the whole clip is
 * analyzed rather than a handful of browser-sampled frames.
 */
export async function submitAnalysisUpload(
  file: Blob,
  videoId: string,
  role: "reference" | "source" = "source",
  options: AnalysisUploadOptions = {},
): Promise<EngineJobAccepted> {
  const url = engineUrl("/analyze-upload");
  const form = new FormData();
  form.set("file", file, videoId);
  form.set("video_id", videoId);
  form.set("role", role);
  if (options.baselineFps !== undefined) form.set("baseline_fps", String(options.baselineFps));
  if (options.burstFps !== undefined) form.set("burst_fps", String(options.burstFps));
  if (options.sceneThreshold !== undefined) form.set("scene_threshold", String(options.sceneThreshold));

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", body: form });
  } catch (error) {
    throw new EngineRequestError(
      `Analysis upload failed: ${error instanceof Error ? error.message : String(error)} (${url}). Is the python engine running?`,
      { status: null, url },
    );
  }
  await assertOk(response, "Analysis upload");
  const accepted = (await response.json()) as EngineJobAccepted;
  if (!accepted || typeof accepted.jobId !== "string") {
    throw new EngineRequestError("Analysis upload returned no jobId.", { status: response.status, url });
  }
  return accepted;
}

export interface EngineJobEnvelope<T> {
  readonly status: string;
  readonly result: T | null;
  readonly error?: string;
}

export interface PollOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /** Injected in tests so a 15-minute timeout is still testable. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function errorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : undefined;
}

/**
 * Polls GET /jobs/{jobId} until the job reaches a terminal status.
 *
 * Terminal statuses are `completed`, `failed` and `unknown` — the last one
 * means the job was swept, and retrying can never succeed, so it is an error
 * rather than another lap around the loop.
 */
export async function pollEngineJob<T = unknown>(
  jobId: string,
  options: PollOptions = {},
): Promise<T> {
  const interval = options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? JOB_POLL_TIMEOUT_MS;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const url = engineUrl(`/jobs/${jobId}`);
  const deadline = now() + timeoutMs;
  let lastStatus = "pending";

  while (now() < deadline) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new EngineRequestError(
        `Engine job poll failed: ${error instanceof Error ? error.message : String(error)} (${url})`,
        { status: null, url },
      );
    }
    await assertOk(response, "Engine job poll");
    const job = (await response.json()) as EngineJobEnvelope<T>;
    lastStatus = typeof job?.status === "string" ? job.status : "unknown";

    if (lastStatus === "completed") {
      if (!job.result) {
        throw new EngineRequestError(
          `Engine job ${jobId} completed without a result.`,
          { status: 200, url },
        );
      }
      return job.result;
    }
    if (lastStatus === "failed") {
      // The route stores the error object as the job *result*
      // (`{status, result}`), so both shapes are read before giving up.
      const detail = job.error ?? errorMessage(job.result);
      throw new EngineRequestError(
        `Engine job ${jobId} failed${detail ? `: ${detail}` : "."}`,
        { status: 200, url },
      );
    }
    if (lastStatus === "unknown") {
      throw new EngineRequestError(
        `Engine job ${jobId} not found (it may have expired).`,
        { status: 200, url },
      );
    }
    await wait(interval);
  }

  throw new EngineRequestError(
    `Engine job ${jobId} timed out after ${timeoutMs}ms (last status: ${lastStatus}).`,
    { status: 200, url },
  );
}

/** Upload + poll in one call — the shape every caller actually wants. */
export async function runAnalysisUpload<T = unknown>(
  file: Blob,
  videoId: string,
  role: "reference" | "source" = "source",
  options: AnalysisUploadOptions & PollOptions = {},
): Promise<T> {
  const accepted = await submitAnalysisUpload(file, videoId, role, options);
  return pollEngineJob<T>(accepted.jobId, options);
}
