import type { JSX } from "react";
import { useState } from "react";
import { ToolcraftIconButton as IconButton } from "@kove-advanced/ui";
import { X } from "@/icons/lucide-compat";
import type { AIInputTraceUpdate } from "@kove-advanced/agent";

type InspectorTab = "frames" | "planner" | "analysis";

function InspectorTabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded px-2 py-1 text-[11px] ${
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-hover"
      }`}
    >
      {children}
    </button>
  );
}

export function AIInputInspector({
  trace,
  onClose,
}: {
  trace: AIInputTraceUpdate | null;
  onClose: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<InspectorTab>("frames");
  const vision = trace?.vision;
  const director = trace?.director;

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="What Monet sees"
      className="absolute inset-x-2 top-11 bottom-3 z-30 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-bg-1 shadow-xl"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-fg">What Monet sees</div>
          <div className="text-[10px] text-fg-muted">
            Current turn only · kept locally in memory
          </div>
        </div>
        <IconButton
          label="Close AI input inspector"
          icon={<X size={14} aria-hidden />}
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-md text-fg-2 hover:bg-hover"
        />
      </header>

      <div className="flex gap-1 border-b border-border px-2 py-1.5" role="group" aria-label="AI input details">
        <InspectorTabButton active={tab === "frames"} onClick={() => setTab("frames")}>
          Vision frames
        </InspectorTabButton>
        <InspectorTabButton active={tab === "planner"} onClick={() => setTab("planner")}>
          Planner request
        </InspectorTabButton>
        <InspectorTabButton active={tab === "analysis"} onClick={() => setTab("analysis")}>
          Analysis map
        </InspectorTabButton>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px] leading-relaxed text-fg-2">
        {trace?.progress && (
          <div className="rounded border border-accent/30 bg-accent-soft/40 p-2" role="status">
            {trace.progress}
          </div>
        )}
        <div className="rounded border border-accent/30 bg-accent-soft/40 p-2 text-[10px]">
          The vision analyzer receives the sampled frame images. The director planner itself receives
          the text segment map and prompt below — it does not receive video pixels.
        </div>

        {tab === "frames" && (
          <>
            {!vision ? (
              <p>No vision-analysis input was captured for this turn.</p>
            ) : (
              <>
                <p>
                  Analyzer: <strong>{vision.worker}</strong> · {vision.frameCount} selected frame(s)
                  {vision.note ? ` · ${vision.note}` : ""}
                </p>
                {vision.videos.map((video) => (
                  <section key={video.videoId} className="space-y-2 rounded border border-border p-2">
                    <div className="font-medium text-fg">
                      {video.name} · {video.duration.toFixed(1)}s · {video.frameCount} frame(s)
                    </div>
                    {video.batches.map((batch) => (
                      <div key={batch.batchIndex} className="space-y-1">
                        <div className="text-[10px] text-fg-muted">
                          Batch {batch.batchIndex + 1}: {batch.imageCount} image(s)
                          {batch.mosaic
                            ? ` · ${batch.mosaic.rows}x${batch.mosaic.cols} contact sheet`
                            : " · individual frames"}
                          {" · source "}
                          {batch.sourceTimestamps.map((time) => `${time.toFixed(2)}s`).join(", ")}
                          {batch.images.length < batch.imageCount
                            ? ` · showing ${batch.images.length} inspector preview(s)`
                            : ""}
                        </div>
                        {batch.images.length > 0 && (
                          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                            {batch.images.map((image, index) => (
                              <figure key={`${image.timestamp}-${index}`} className="overflow-hidden rounded border border-border bg-bg-2">
                                <img
                                  src={`data:image/jpeg;base64,${image.imageDataBase64}`}
                                  alt={`Vision input frame at ${image.timestamp.toFixed(2)} seconds`}
                                  className="aspect-video w-full object-contain"
                                />
                                <figcaption className="px-1.5 py-1 text-[9px] text-fg-muted">
                                  {image.timestamp.toFixed(2)}s · {image.width}×{image.height}
                                </figcaption>
                              </figure>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {video.batches.length === 0 && (
                      <p className="text-[10px] text-fg-muted">
                        No frames were sent; the analysis used metadata only.
                      </p>
                    )}
                  </section>
                ))}
              </>
            )}
          </>
        )}

        {tab === "planner" && (
          <>
            {!director?.requests.length ? (
              <p>The director planning request has not been captured yet.</p>
            ) : (
              <>
                <p>Request passed to the LLM client · {director.provider} schema</p>
                {director.requests.map((item, index) => (
                  <details key={index} open={index === director.requests.length - 1}>
                    <summary className="cursor-pointer font-medium text-fg">
                      Request {index + 1} · max output {item.maxTokens} tokens
                    </summary>
                    <div className="mt-2 space-y-2">
                      <details open>
                        <summary className="cursor-pointer text-fg">System prompt</summary>
                        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-[10px]">
                          {item.system}
                        </pre>
                      </details>
                      <details open>
                        <summary className="cursor-pointer text-fg">Messages</summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-[10px]">
                          {JSON.stringify(item.messages, null, 2)}
                        </pre>
                      </details>
                      <details>
                        <summary className="cursor-pointer text-fg">Tool definitions</summary>
                        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-[10px]">
                          {JSON.stringify(item.tools, null, 2)}
                        </pre>
                      </details>
                    </div>
                  </details>
                ))}
              </>
            )}
          </>
        )}

        {tab === "analysis" && (
          <>
            <section>
              <h3 className="mb-1 font-medium text-fg">Segment map sent to the director</h3>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-[10px]">
                {trace?.director
                  ? JSON.stringify(trace.director.segmentMap, null, 2)
                  : vision
                    ? JSON.stringify(vision.segmentMap, null, 2)
                    : "No segment map captured."}
              </pre>
            </section>
            {vision?.referenceAnalysis !== undefined && (
              <details>
                <summary className="cursor-pointer font-medium text-fg">Vision worker analysis output</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-[10px]">
                  {JSON.stringify(vision.referenceAnalysis, null, 2)}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
