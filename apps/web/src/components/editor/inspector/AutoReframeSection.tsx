import React, { useState, useCallback } from "react";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { ToolcraftCard as Card } from "@kove-advanced/ui";
import { ToolcraftClickableCard as ClickableCard } from "@kove-advanced/ui";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import { PropertySlider } from "./shell/PropertySlider";
import { MockToggle } from "./shell/InspectorControls";
import {
  Smartphone,
  Monitor,
  Square,
  Loader2,
  Play,
  CheckCircle,
} from "@/icons/lucide-compat";
import {
  type ReframeSettings,
  type AspectRatioPreset,
  type PlatformPreset,
  type ReframeResult,
  type ClipTimeMapping,
  ASPECT_RATIO_PRESETS,
  PLATFORM_PRESETS,
  DEFAULT_REFRAME_SETTINGS,
} from "@kove-advanced/core";
import type { Action } from "@kove-advanced/core/types/actions";
import { toast } from "../../../stores/notification-store";
import { useProjectStore } from "../../../stores/project-store";
import {
  analyzeAutoReframe,
  probeVideoSize,
  type AutoReframeAnalysis,
} from "../../../services/agent/vision-analysis";

interface AutoReframeSectionProps {
  clipId: string;
  onReframeComplete?: (result: ReframeResult) => void;
}

const PLATFORM_ICONS: Record<PlatformPreset, React.ElementType> = {
  youtube: Monitor,
  tiktok: Smartphone,
  "instagram-reels": Smartphone,
  "instagram-feed": Square,
  "instagram-stories": Smartphone,
  "youtube-shorts": Smartphone,
  facebook: Monitor,
  twitter: Monitor,
  linkedin: Monitor,
};

export const AutoReframeSection: React.FC<AutoReframeSectionProps> = ({
  clipId,
  onReframeComplete,
}) => {
  const [reframeSettings, setReframeSettings] = useState<ReframeSettings>(
    DEFAULT_REFRAME_SETTINGS,
  );
  const [isProcessing, setIsProcessing] = useState(false);
  const [isApplied, setIsApplied] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [selectedPlatform, setSelectedPlatform] =
    useState<PlatformPreset | null>("tiktok");

  const [result, setResult] = useState<AutoReframeAnalysis | null>(null);

  const updateLocalSettings = useCallback(
    (updates: Partial<ReframeSettings>) => {
      setReframeSettings((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  const handleSelectPlatform = useCallback(
    (platform: PlatformPreset) => {
      setSelectedPlatform(platform);
      const config = PLATFORM_PRESETS[platform];
      const aspectRatio = Object.entries(ASPECT_RATIO_PRESETS).find(
        ([, v]) => Math.abs(v.ratio - config.ratio) < 0.01,
      );
      if (aspectRatio) {
        updateLocalSettings({
          targetAspectRatio: aspectRatio[0] as AspectRatioPreset,
        });
      }
    },
    [updateLocalSettings],
  );

  const handleSelectAspectRatio = useCallback(
    (ratio: AspectRatioPreset) => {
      setSelectedPlatform(null);
      updateLocalSettings({ targetAspectRatio: ratio });
    },
    [updateLocalSettings],
  );

  /**
   * Reframe for real: decode frames across the clip, let the auto-reframe
   * engine pick a crop per frame (steered by the face detector when available),
   * then commit the resulting camera move as clip transform keyframes.
   *
   * The canvas resize and the keyframes belong to the same user action, so they
   * share one undo step.
   */
  const handleAnalyze = useCallback(async () => {
    const store = useProjectStore.getState();
    const clip = store.getClip(clipId);
    if (!clip) {
      toast.error("Auto Reframe Failed", "Select a clip on the timeline first.");
      return;
    }
    const mediaItem = store.getMediaItem(clip.mediaId);
    const blob =
      mediaItem?.blob ??
      (mediaItem?.fileHandle ? await mediaItem.fileHandle.getFile() : null);
    if (!blob) {
      toast.error("Auto Reframe Failed", "Reconnect the source media and try again.");
      return;
    }

    setIsProcessing(true);
    setResult(null);
    setProgress(0);
    setProgressMessage("Decoding frames...");
    setIsApplied(false);

    try {
      const targetConfig = ASPECT_RATIO_PRESETS[reframeSettings.targetAspectRatio];
      const metadata = mediaItem?.metadata as { width?: number; height?: number } | undefined;
      const durationSeconds =
        (mediaItem?.metadata as { duration?: number } | undefined)?.duration ??
        Math.max(clip.outPoint, clip.duration);
      const timeMapping: ClipTimeMapping = {
        startTime: clip.startTime,
        inPoint: clip.inPoint,
        speed: Math.max(0.001, clip.speed ?? 1),
        outPoint: clip.outPoint,
        ...(clip.reversed ? { reversed: true } : {}),
      };

      const size =
        metadata?.width && metadata?.height
          ? { width: metadata.width, height: metadata.height }
          : await probeVideoSize(blob);

      const analysis = await analyzeAutoReframe({
        blob,
        durationSeconds,
        request: {
          mediaId: clip.mediaId,
          startTime: clip.inPoint,
          endTime: clip.outPoint > clip.inPoint ? clip.outPoint : undefined,
          intervalMs: 400,
          maxFrames: 90,
        },
        settings: reframeSettings,
        mediaWidth: size.width,
        mediaHeight: size.height,
        canvasWidth: targetConfig.width,
        canvasHeight: targetConfig.height,
        ...(clip.transform.fitMode ? { fitMode: clip.transform.fitMode } : {}),
        timeMapping,
        onProgress: (value, message) => {
          setProgress(value);
          setProgressMessage(message);
        },
      });

      setProgressMessage("Writing camera keyframes...");
      store.beginHistoryGroup("AI auto reframe");
      try {
        const resized = await useProjectStore.getState().executeAction({
          type: "project/updateSettings",
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          params: { width: targetConfig.width, height: targetConfig.height },
        } as Action);
        if (!resized.success) {
          throw new Error(resized.error?.message ?? "Resizing the canvas failed.");
        }

        const written = await useProjectStore.getState().executeAction({
          type: "keyframe/setAll",
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          params: {
            clipId,
            keyframes: [
              ...(clip.keyframes ?? []).filter(
                (existing) =>
                  !["position.x", "position.y", "scale.x", "scale.y"].includes(
                    existing.property,
                  ),
              ),
              ...analysis.keyframes,
            ],
          },
        } as Action);
        if (!written.success) {
          throw new Error(written.error?.message ?? "Writing camera keyframes failed.");
        }
      } finally {
        useProjectStore.getState().endHistoryGroup();
      }

      setProgress(100);
      setProgressMessage("Complete!");
      setIsApplied(true);
      setResult(analysis);

      const reframeResult: ReframeResult = {
        keyframes: [],
        outputWidth: analysis.outputWidth,
        outputHeight: analysis.outputHeight,
        success: true,
        message: `Wrote ${analysis.keyframeSamples} camera keyframe(s) from ${analysis.sampledFrames} analyzed frame(s)`,
      };
      onReframeComplete?.(reframeResult);

      const platformName = selectedPlatform
        ? PLATFORM_PRESETS[selectedPlatform].name
        : reframeSettings.targetAspectRatio;
      toast.success(
        "Auto Reframe Applied",
        `${platformName} (${targetConfig.width}x${targetConfig.height}) — ${analysis.keyframeSamples} camera keyframe(s)${analysis.usedFaceBackend ? " tracking faces" : ""}.`,
      );
      for (const warning of analysis.warnings) toast.warning("Auto Reframe", warning);
    } catch (error) {
      console.error("Auto-reframe failed:", error);
      toast.error(
        "Auto Reframe Failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      setIsApplied(false);
    } finally {
      setIsProcessing(false);
    }
  }, [clipId, onReframeComplete, reframeSettings, selectedPlatform]);

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        <div>
          <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
            Platform Presets
          </Text>
            <div className="grid grid-cols-3 gap-1">
              {(Object.keys(PLATFORM_PRESETS) as PlatformPreset[]).map(
                (platform) => {
                  const PlatformIcon = PLATFORM_ICONS[platform];
                  return (
                    <ClickableCard
                      key={platform}
                      label={`${PLATFORM_PRESETS[platform].name} platform preset`}
                      onClick={() => handleSelectPlatform(platform)}
                      className={`flex items-center gap-1 p-2 rounded text-[9px] transition-colors ${
                        selectedPlatform === platform
                          ? "bg-primary/20 border border-primary text-fg"
                          : "bg-bg-1 hover:bg-background-primary border border-transparent text-fg-2"
                      }`}
                    >
                      <PlatformIcon size={14} />
                      <Text type="supporting" className="truncate text-[9px]">
                        {PLATFORM_PRESETS[platform].name}
                      </Text>
                    </ClickableCard>
                  );
                },
            )}
          </div>
        </div>

        <div>
          <Text type="supporting" color="secondary" className="mb-2 block text-[10px]">
            Aspect Ratio
          </Text>
          <div className="grid grid-cols-3 gap-1">
            {(Object.keys(ASPECT_RATIO_PRESETS) as AspectRatioPreset[])
              .filter((r) => r !== "custom")
              .map((ratio) => (
                <ClickableCard
                  key={ratio}
                  label={`${ratio} aspect ratio`}
                  onClick={() => handleSelectAspectRatio(ratio)}
                  className={`p-2 rounded text-[9px] transition-colors ${
                    reframeSettings.targetAspectRatio === ratio &&
                    !selectedPlatform
                      ? "bg-primary/20 border border-primary text-fg"
                      : "bg-bg-1 hover:bg-background-primary border border-transparent text-fg-2"
                  }`}
                >
                  {ratio}
                </ClickableCard>
              ))}
          </div>
        </div>

        <PropertySlider
          label="Tracking Speed"
          min={0}
          max={100}
          step={1}
          value={reframeSettings.trackingSpeed * 100}
          onChange={(value: number) =>
            updateLocalSettings({
              trackingSpeed: value / 100,
            })
          }
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <PropertySlider
          label="Smoothing"
          min={0}
          max={100}
          step={1}
          value={reframeSettings.smoothing * 100}
          onChange={(value: number) => updateLocalSettings({ smoothing: value / 100 })}
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <PropertySlider
          label="Center Bias"
          min={0}
          max={100}
          step={1}
          value={reframeSettings.centerBias * 100}
          onChange={(value: number) =>
            updateLocalSettings({
              centerBias: value / 100,
            })
          }
          formatValue={(value) => `${Math.round(value)}%`}
        />

        <div className="flex items-center justify-between">
          <Text type="supporting" color="secondary" className="text-[10px]">
            Follow Subject
          </Text>
          <MockToggle
            ariaLabel="Follow Subject"
            checked={reframeSettings.followSubject}
            onChange={() =>
              updateLocalSettings({
                followSubject: !reframeSettings.followSubject,
              })
            }
          />
        </div>

        {isProcessing && (
          <Card variant="muted" padding={2} className="space-y-1">
            <div className="flex items-center justify-between">
              <Text type="supporting" color="secondary" className="text-[9px]">
                {progressMessage}
              </Text>
              <Text type="supporting" color="secondary" className="text-[9px]">
                {progress}%
              </Text>
            </div>
            <div className="h-1 bg-bg-1 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </Card>
        )}

        <Button
          label={
            isProcessing
              ? "Analyzing..."
              : isApplied
                ? "Applied - Click to Reanalyze"
                : "Analyze & Reframe"
          }
          icon={
            isProcessing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : isApplied ? (
              <CheckCircle size={14} />
            ) : (
              <Play size={14} />
            )
          }
          variant="primary"
          size="sm"
          onClick={handleAnalyze}
          isDisabled={isProcessing}
          className="w-full justify-center"
        />

        {result && !isProcessing && (
          <Text type="supporting" color="secondary" className="text-center text-[9px]">
            {result.keyframeSamples} camera keyframe(s) from {result.sampledFrames} frame(s)
            {result.refinedFrames
              ? ` · ${result.refinedFrames} added where it moved`
              : ""}
            {result.usedFaceBackend ? " · face tracking" : " · subject fallback"}
            {result.pathDeviationPx !== undefined
              ? ` · path fit ${result.pathDeviationPx.toFixed(1)}px`
              : ""}
            {result.peakSpeedCropRatios !== undefined
              ? ` · peak ${result.peakSpeedCropRatios.toFixed(2)} crop-widths/s`
              : ""}
          </Text>
        )}

        <Text type="supporting" color="secondary" className="text-center text-[9px]">
          Output:{" "}
          {ASPECT_RATIO_PRESETS[reframeSettings.targetAspectRatio].width} x{" "}
          {ASPECT_RATIO_PRESETS[reframeSettings.targetAspectRatio].height}
        </Text>
      </div>
    </div>
  );
};

export default AutoReframeSection;
