import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Scissors } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import {
  clipTimingLimitation,
  computeCutRanges,
  executeCutPlan,
  findMulticamGroupForClip,
  planClipCuts,
  segmentSpeechFromProbabilities,
  FILLER_LEXICON,
  type ProposedCut,
  type TranscriptWord,
} from "@kove-advanced/core/audio/silence-removal";
import { analyzeSileroVad, SILERO_VAD_SAMPLE_RATE } from "@kove-advanced/core/multicam/silero-vad";
import type { Action } from "@kove-advanced/core/types/actions";
import { useProjectStore } from "../../../stores/project-store";
import { loadAudioBuffer } from "../../../utils/load-audio-buffer";
import { audioBufferToWhisperSamples } from "../../../utils/whisper-audio";
import { transcribeSamplesWithWordTimestamps } from "../../../services/multicam-transcription";

type Phase = "idle" | "analyzing" | "ready" | "applying";

interface SilenceFillerPanelProps {
  clipId?: string;
}

const formatTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
};

/**
 * Detect long silences (VAD) and filler words (word-level Whisper) in the
 * selected clip, review the proposed cuts with strikethrough transcript,
 * and apply them as split + ripple-delete ops in ONE undo group.
 *
 * Explicit-trigger only (button) — VAD + transcription must be asked for.
 */
export const SilenceFillerPanel: React.FC<SilenceFillerPanelProps> = ({ clipId }) => {
  const getClip = useProjectStore((state) => state.getClip);
  const getMediaItem = useProjectStore((state) => state.getMediaItem);

  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cuts, setCuts] = useState<ProposedCut[]>([]);
  const [words, setWords] = useState<TranscriptWord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);

  const detect = useCallback(async () => {
    if (!clipId) return;
    const clip = getClip(clipId);
    if (!clip) {
      setError("Select a clip first.");
      return;
    }
    setError(null);
    setWarnings([]);
    setCuts([]);
    setWords([]);
    setAppliedMessage(null);

    const limitation = clipTimingLimitation(clip);
    if (limitation) {
      setError(`This clip can't be cut by timing: ${limitation}.`);
      return;
    }

    const collectWarnings: string[] = [];
    const project = useProjectStore.getState().project;
    const group = findMulticamGroupForClip(project, clip);
    if (group) {
      collectWarnings.push(
        `Synced multicam clips detected ("${group.name}") — cuts apply to this track only; sibling angles are not ripple-cut (v1 scope).`,
      );
    }

    const mediaItem = getMediaItem(clip.mediaId);
    if (!mediaItem) {
      setError("The clip's media item is missing.");
      return;
    }

    setPhase("analyzing");
    let audioContext: AudioContext | null = null;
    try {
      const sourceBlob =
        mediaItem.blob ??
        (mediaItem.fileHandle ? await mediaItem.fileHandle.getFile() : null);
      if (!sourceBlob) {
        throw new Error("Reconnect the source media before detecting silence.");
      }

      setStatusMessage("Extracting clip audio…");
      audioContext = new AudioContext();
      const audioBuffer = await loadAudioBuffer(audioContext, sourceBlob, {
        audioTrackIndex: clip.audioTrackIndex,
        onProgress: (next) => setStatusMessage(next.message),
      });
      if (!audioBuffer) throw new Error("The clip audio could not be decoded.");

      // Trimmed source region, exactly as AutoCaptionPanel computes it.
      const sourceStart = Math.max(0, clip.inPoint ?? 0);
      const sourceEnd = Math.min(
        audioBuffer.duration,
        clip.outPoint > sourceStart
          ? clip.outPoint
          : sourceStart + clip.duration * Math.max(clip.speed ?? 1, 0.01),
      );
      const samples = audioBufferToWhisperSamples(audioBuffer, sourceStart, sourceEnd);
      if (samples.length === 0) throw new Error("The clip has no audio samples.");
      const regionSeconds = samples.length / 16_000;

      setStatusMessage("Running voice-activity detection…");
      const vad = await analyzeSileroVad(samples, SILERO_VAD_SAMPLE_RATE);
      const speechSegments = segmentSpeechFromProbabilities(vad.probabilities, vad.windowMs);

      setStatusMessage("Transcribing words locally…");
      const transcribed = await transcribeSamplesWithWordTimestamps(samples, {
        onStatus: setStatusMessage,
      });

      const proposed = computeCutRanges({
        speechSegments,
        totalDurationSec: regionSeconds,
        words: transcribed,
      });

      setWords(transcribed);
      setCuts(proposed);
      setSelected(new Set(proposed.map((cut) => cut.id)));
      setWarnings(collectWarnings);
      setPhase("ready");
      if (proposed.length === 0) {
        setStatusMessage("No long silences or filler words found.");
      }
    } catch (reason) {
      setPhase("idle");
      setError(reason instanceof Error ? reason.message : "Detection failed.");
    } finally {
      void audioContext?.close().catch(() => undefined);
    }
  }, [clipId, getClip, getMediaItem]);

  const toggleCut = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAppliedMessage(null);
  }, []);

  const apply = useCallback(async () => {
    if (!clipId || cuts.length === 0 || selected.size === 0) return;
    const clip = getClip(clipId);
    if (!clip) return;

    setPhase("applying");
    setError(null);
    try {
      const plan = planClipCuts(clip, cuts, selected);
      const store = useProjectStore.getState();
      store.beginHistoryGroup("Silence & filler removal");
      let execution;
      try {
        execution = await executeCutPlan(
          {
            execute: (action: Action) =>
              useProjectStore.getState().executeAction(action),
          },
          useProjectStore.getState().project,
          clipId,
          plan,
        );
      } finally {
        useProjectStore.getState().endHistoryGroup();
      }
      if (!execution.ok) {
        throw new Error(execution.error ?? "Applying cuts failed.");
      }
      // Refresh the review against what actually landed.
      setCuts((current) => current.filter((cut) => !selected.has(cut.id)));
      setSelected(new Set());
      setAppliedMessage(
        `Removed ${execution.cutsDeleted} cut${execution.cutsDeleted === 1 ? "" : "s"} — one undo step reverts all of them.`,
      );
      setPhase("ready");
    } catch (reason) {
      setPhase("ready");
      setError(reason instanceof Error ? reason.message : "Applying cuts failed.");
    }
  }, [clipId, cuts, selected, getClip]);

  const isCutSelectedAt = useMemo(
    () => (word: TranscriptWord): boolean =>
      cuts.some(
        (cut) =>
          selected.has(cut.id) && word.start < cut.end - 1e-3 && word.end > cut.start + 1e-3,
      ),
    [cuts, selected],
  );

  const clip = clipId ? getClip(clipId) : undefined;
  const busy = phase === "analyzing" || phase === "applying";

  return (
    <div className="space-y-3">
      <Text type="supporting" color="secondary" className="text-fg-2">
        Finds silences over 0.6s and filler words ({FILLER_LEXICON.slice(0, 4).join(", ")}…)
        using local VAD + Whisper. Review, then remove as split + ripple-delete —
        everything lands as a single undo step.
      </Text>

      <Button
        label={cuts.length > 0 ? "Re-detect Silence & Fillers" : "Detect Silence & Fillers"}
        onClick={() => void detect()}
        disabled={busy || !clip}
        variant="secondary"
        size="sm"
        icon={busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Scissors size={13} aria-hidden />}
        className="w-full justify-center"
      />

      {busy && statusMessage && (
        <Text type="supporting" color="secondary" className="text-fg-2">
          {statusMessage}
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

      {phase === "ready" && cuts.length > 0 && (
        <>
          {words.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-md border border-border-subtle bg-bg-2 p-2 text-[12px] leading-relaxed text-fg">
              {words.map((word, index) => {
                const struck = isCutSelectedAt(word);
                return (
                  <span
                    key={`${word.start}-${index}`}
                    className={struck ? "text-fg-3 line-through" : undefined}
                  >
                    {word.text}{" "}
                  </span>
                );
              })}
            </div>
          )}

          <ul className="max-h-44 space-y-1 overflow-y-auto">
            {cuts.map((cut) => (
              <li key={cut.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle bg-bg-2 p-1.5 text-[12px]">
                  <input
                    type="checkbox"
                    checked={selected.has(cut.id)}
                    onChange={() => toggleCut(cut.id)}
                    className="accent-accent"
                  />
                  <span className="flex-1 truncate">{cut.label}</span>
                  <span className="tabular-nums text-fg-2">
                    {formatTime(cut.start)}–{formatTime(cut.end)}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <Button
            label={`Remove ${selected.size} cut${selected.size === 1 ? "" : "s"} (single undo)`}
            onClick={() => void apply()}
            disabled={busy || selected.size === 0 || !clip}
            variant="primary"
            size="sm"
            icon={<Scissors size={13} aria-hidden />}
            className="w-full justify-center"
          />
        </>
      )}

      {appliedMessage && (
        <Text type="supporting" className="text-emerald-500">
          {appliedMessage}
        </Text>
      )}

      {phase === "ready" && cuts.length === 0 && !error && (
        <Text type="supporting" color="secondary" className="text-fg-2">
          Nothing to remove — the clip's pauses and speech already look tight.
        </Text>
      )}
    </div>
  );
};
