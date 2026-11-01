/** Bound individual export operations, not the total duration of a long export. */
export const EXPORT_STAGE_TIMEOUT_MS = 120_000;

export async function waitForExportStage<T>(
  operation: Promise<T>,
  stage: string,
  signal?: AbortSignal,
  timeoutMs = EXPORT_STAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(new DOMException("Export cancelled", "AbortError"));
      // Always observe the operation, even when already cancelled, so a late
      // rejection from a browser codec cannot become an unhandled rejection.
      operation.then(resolve, reject);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new Error(
          `Export stalled while ${stage} for ${Math.round(timeoutMs / 1000)} seconds. ` +
            "Try again, reduce the export resolution, or use a different browser.",
        );
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
