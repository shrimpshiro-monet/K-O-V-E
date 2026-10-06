import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2, ScanFace, UserSquare2 } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import {
  SUBJECT_SEPARATION_PRESETS,
  backgroundRemovalSettingsFromSeparation,
  initializeBackgroundRemovalEngine,
  planSubjectSeparation,
  type SubjectSeparationPreset,
} from "@kove-advanced/core";
import type { FaceAnalysisResult } from "@kove-advanced/agent";
import { useProjectStore } from "../../../stores/project-store";
import { useEngineStore } from "../../../stores/engine-store";
import {
  analyzeFacesInMedia,
  analyzeSubjectMatte,
  writeMatteToMasks,
  type SubjectMatteAnalysis,
} from "../../../services/agent/vision-analysis";
import type { Action } from "@kove-advanced/core/types/actions";
import { PropertySlider } from "./shell/PropertySlider";

type Phase = "idle" | "faces" | "matte" | "applying";

interface SubjectToolsPanelProps {
  clipId?: string;
}

/**
 * Face detection, subject rotoscoping and separation for the selected clip.
 *
 * Review-first, matching the Silence & Filler panel: analysis is explicit
 * (button), the proposal is shown before anything is written, and applying the
 * matte lands as a single undo step. All inference runs locally.
 */
export const SubjectToolsPanel: React.FC<SubjectToolsPanelProps> = ({ clipId }) => {
  const getClip = useProjectStore((state) => state.getClip);
  const getMediaItem = useProjectStore((state) => state.getMediaItem);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [faces, setFaces] = useState<FaceAnalysisResult | null>(null);
  const [matte, setMatte] = useState<SubjectMatteAnalysis | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);
  const [preset, setPreset] = useState<SubjectSeparationPreset>("cutout");
  const [featherPx, setFeatherPx] = useState(4);
  /** Matte created by this panel, so re-applying updates it instead of stacking masks. */
  const [appliedMaskId, setAppliedMaskId] = useState<string | null>(null);

  const clip = clipId ? getClip(clipId) : undefined;
  const mediaItem = clip ? getMediaItem(clip.mediaId) : undefined;
  const busy = phase !== "idle";
  const canAnalyze = Boolean(clip && mediaItem);

  const resolveSource = useCallback(async () => {
    if (!clip || !mediaItem) throw new Error("Select a video clip on the timeline first.");
    const blob =
      mediaItem.blob ?? (mediaItem.fileHandle ? await mediaItem.fileHandle.getFile() : null);
    if (!blob) throw new Error("Reconnect the source media before analysis.");
    const duration =
      (mediaItem.metadata as { duration?: number } | undefined)?.duration ??
      (clip.outPoint > clip.inPoint ? clip.outPoint : clip.duration);
    return { blob, duration };
  }, [clip, mediaItem]);

  const resetResults = useCallback(() => {
    setError(null);
    setWarnings([]);
    setFaces(null);
    setMatte(null);
    setAppliedMessage(null);
    setAppliedMaskId(null);
  }, []);

  const detectFaces = useCallback(async () => {
    if (!clip) return;
    resetResults();
    setPhase("faces");
    setStatus("Decoding frames…");
    try {
      const { blob, duration } = await resolveSource();
      const result = await analyzeFacesInMedia({
        blob,
        durationSeconds: duration,
        request: {
          mediaId: clip.mediaId,
          startTime: clip.inPoint ?? 0,
          endTime: clip.outPoint,
          intervalMs: 500,
          maxFrames: 48,
        },
        onProgress: (done, total) => setStatus(`Detecting faces… ${done}/${total}`),
      });
      setFaces(result);
      setWarnings([...result.warnings]);
      setStatus(
        result.tracks.length === 0
          ? "No faces found in the sampled frames."
          : `${result.tracks.length} face track(s); primary ${result.primaryTrackId}.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Face detection failed.");
    } finally {
      setPhase("idle");
    }
  }, [clip, resetResults, resolveSource]);

  const planMatte = useCallback(async () => {
    if (!clip) return;
    resetResults();
    setPhase("matte");
    setStatus("Segmenting subject…");
    try {
      const { blob, duration } = await resolveSource();
      const analysis = await analyzeSubjectMatte({
        blob,
        durationSeconds: duration,
        streamId: `inspector:${clip.id}`,
        request: {
          mediaId: clip.mediaId,
          startTime: clip.inPoint ?? 0,
          endTime: clip.outPoint,
          intervalMs: 400,
          maxFrames: 48,
          maxKeyframes: 48,
        },
        onProgress: (done, total) => setStatus(`Segmenting subject… ${done}/${total}`),
      });
      setMatte(analysis);
      setWarnings([...analysis.result.warnings]);
      setStatus(
        analysis.result.keyframeCount === 0
          ? "No usable subject found in this range."
          : `${analysis.result.keyframeCount} matte keyframe(s), average coverage ${(
              analysis.result.averageCoverage * 100
            ).toFixed(1)}%.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Subject segmentation failed.");
    } finally {
      setPhase("idle");
    }
  }, [clip, resetResults, resolveSource]);

  const applyMatte = useCallback(async () => {
    if (!clip || !matte || matte.plan.keyframes.length === 0) return;
    setPhase("applying");
    setError(null);
    try {
      const store = useProjectStore.getState();
      const masks = store.project.masks ?? [];
      const existingMask = appliedMaskId
        ? masks.find((mask) => mask.id === appliedMaskId)
        : undefined;
      const written = writeMatteToMasks({
        masks,
        clipId: clip.id,
        ...(existingMask ? { maskId: existingMask.id } : {}),
        plan: matte.plan,
        timeMapping: {
          startTime: clip.startTime,
          inPoint: clip.inPoint ?? 0,
          speed: Math.max(0.001, clip.speed ?? 1),
          ...(clip.outPoint !== undefined ? { outPoint: clip.outPoint } : {}),
          ...(clip.reversed ? { reversed: true } : {}),
        },
        featherPx,
        createId: () => crypto.randomUUID(),
      });

      store.beginHistoryGroup("AI subject matte");
      try {
        const result = await useProjectStore.getState().executeAction({
          type: "mask/setAll",
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          params: { masks: written.masks },
        } as Action);
        if (!result.success) {
          throw new Error(result.error?.message ?? "Saving the mask failed.");
        }
      } finally {
        useProjectStore.getState().endHistoryGroup();
      }

      // Keep the live MaskEngine in sync so the inspector shows the matte now.
      const maskEngine = await useEngineStore.getState().getMaskEngine();
      maskEngine.loadMasks([...written.masks]);

      // Optional separation settings ride along with the same user action.
      const plan = planSubjectSeparation({ preset, feather: featherPx / 100 });
      const engine = initializeBackgroundRemovalEngine();
      engine.setSettings(clip.id, backgroundRemovalSettingsFromSeparation(plan, engine.getSettings(clip.id)));
      // The preview only composites separation once the engine has loaded its
      // local model; without this the preset would look like a no-op.
      if (!engine.isInitialized()) {
        setStatus("Loading the subject model for preview…");
        try {
          await engine.initialize();
        } catch (modelError) {
          setWarnings((current) => [
            ...current,
            `Separation settings were saved, but the subject model did not load: ${
              modelError instanceof Error ? modelError.message : String(modelError)
            }`,
          ]);
        }
      }

      setAppliedMaskId(written.maskId);
      setWarnings((current) => [...current, ...written.warnings, ...plan.warnings]);
      setAppliedMessage(
        `Wrote ${written.keyframeCount} matte keyframe(s) to ${written.maskId} — one undo step. ${plan.summary}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Applying the matte failed.");
    } finally {
      setPhase("idle");
    }
  }, [appliedMaskId, clip, featherPx, matte, preset]);

  const faceSummary = useMemo(() => {
    if (!faces) return null;
    return faces.tracks.slice(0, 6).map((track) => ({
      id: track.id,
      label:
        track.id === faces.primaryTrackId
          ? `${track.id} (primary)`
          : track.id,
      detail: `${Math.round(track.averageBox.width)}×${Math.round(track.averageBox.height)} · ${(
        (track.lastTimeMs - track.firstTimeMs) / 1000
      ).toFixed(1)}s · conf ${track.averageConfidence.toFixed(2)}`,
    }));
  }, [faces]);

  return (
    <div className="space-y-3">
      <Text type="supporting" color="secondary" className="text-fg-2">
        Detects faces and tracks the main subject locally (no upload), then writes a
        rotoscoped mask you can review before applying. Matte keyframes land as a single
        undo step.
      </Text>

      <div className="flex gap-2">
        <Button
          label="Detect Faces"
          onClick={() => void detectFaces()}
          disabled={busy || !canAnalyze}
          variant="secondary"
          size="sm"
          icon={phase === "faces" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ScanFace size={13} aria-hidden />}
          className="flex-1 justify-center"
        />
        <Button
          label="Analyze Subject"
          onClick={() => void planMatte()}
          disabled={busy || !canAnalyze}
          variant="secondary"
          size="sm"
          icon={phase === "matte" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <UserSquare2 size={13} aria-hidden />}
          className="flex-1 justify-center"
        />
      </div>

      {status && (
        <Text type="supporting" color="secondary" className="text-fg-2">
          {status}
        </Text>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2">
          <Text type="supporting" className="text-red-500">
            {error}
          </Text>
        </div>
      )}

      {warnings.map((warning) => (
        <div
          key={warning}
          className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
          <Text type="supporting" className="text-amber-600 dark:text-amber-400">
            {warning}
          </Text>
        </div>
      ))}

      {faceSummary && faceSummary.length > 0 && (
        <ul className="space-y-1">
          {faceSummary.map((face) => (
            <li
              key={face.id}
              className="flex items-center justify-between rounded-md border border-border-subtle bg-bg-2 p-1.5 text-[12px]"
            >
              <span className="truncate">{face.label}</span>
              <span className="tabular-nums text-fg-2">{face.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {matte && matte.plan.keyframes.length > 0 && (
        <>
          <PropertySlider
            label="Mask feather"
            value={featherPx}
            onChange={setFeatherPx}
            min={0}
            max={40}
            step={1}
            formatValue={(value) => `${value}px`}
          />
          <div className="space-y-1">
            <Text type="supporting" color="secondary" className="text-fg-2">
              Separation preset
            </Text>
            <div className="grid grid-cols-2 gap-1.5">
              {SUBJECT_SEPARATION_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setPreset(option.id)}
                  title={option.description}
                  className={`rounded-md border p-1.5 text-[11px] ${
                    preset === option.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border-subtle bg-bg-2 text-fg-2 hover:border-primary/50"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <Button
            label={
              phase === "applying"
                ? "Applying matte…"
                : `Apply matte (${matte.result.keyframeCount} keyframes)`
            }
            onClick={() => void applyMatte()}
            disabled={busy}
            variant="primary"
            size="sm"
            icon={
              phase === "applying" ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : undefined
            }
            className="w-full justify-center"
          />
        </>
      )}

      {appliedMessage && (
        <Text type="supporting" className="text-green-500">
          {appliedMessage}
        </Text>
      )}
    </div>
  );
};
