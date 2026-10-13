import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "@/icons/lucide-compat";
import { ToolcraftNumberInputControl as NumberInput } from "@kove-advanced/ui";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import type { Mask, MaskKeyframe } from "@kove-advanced/core";
import { resolveMaskEdgeAtTime } from "@kove-advanced/core";
import { MatteEdgePreview } from "./MatteEdgePreview";

/** The edge fields a keyframe may override, mirroring `MaskKeyframe`. */
export interface MaskKeyframeEdgeOverride {
  feathering?: number | undefined;
  expansion?: number | undefined;
  opacity?: number | undefined;
}

/**
 * Hand-editing the edge at individual mask keyframes.
 *
 * A rotoscoped matte arrives with a per-keyframe feather the *planner* chose
 * from how fast the subject was moving, and the mask-level sliders only move the
 * value every keyframe inherits. Until now nothing could retune one keyframe:
 * the fix for a halo on one frame was to re-run the whole analysis.
 *
 * This edits the same `MaskKeyframe` overrides the renderer already blends
 * (`resolveMaskEdgeAtTime`), so a hand-set value interpolates against its
 * neighbours exactly like a planned one, and a keyframe with no override keeps
 * inheriting the mask's own feather/expansion/opacity.
 */
export interface MaskKeyframeEdgesProps {
  mask: Mask;
  /**
   * Applies an override to one keyframe. A field set to `undefined` (or absent
   * from the object while present in the call) drops that override, so the
   * keyframe inherits the mask-level value again.
   */
  onEdgeChange: (keyframeId: string, edge: MaskKeyframeEdgeOverride) => void;
}

/** True when a keyframe carries any edge override of its own. */
export function hasEdgeOverride(keyframe: MaskKeyframe): boolean {
  return (
    keyframe.feathering !== undefined ||
    keyframe.expansion !== undefined ||
    keyframe.opacity !== undefined
  );
}

export const MaskKeyframeEdges: React.FC<MaskKeyframeEdgesProps> = ({ mask, onEdgeChange }) => {
  const keyframes = useMemo(
    () => [...(mask.keyframes ?? [])].sort((a, b) => a.time - b.time),
    [mask.keyframes],
  );
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(keyframes[0]?.id ?? null);
  const [previewTime, setPreviewTime] = useState(keyframes[0]?.time ?? 0);

  // A mask can gain, lose or be re-keyframed underneath us; keep the selection
  // and the scrub position inside whatever the list is now.
  useEffect(() => {
    setSelectedId((current) =>
      current && keyframes.some((keyframe) => keyframe.id === current)
        ? current
        : (keyframes[0]?.id ?? null),
    );
  }, [keyframes]);

  useEffect(() => {
    setPreviewTime((current) => {
      const first = keyframes[0]?.time ?? 0;
      const last = keyframes.at(-1)?.time ?? 0;
      return Math.min(Math.max(current, first), Math.max(first, last));
    });
  }, [keyframes]);

  if (keyframes.length === 0) return null;

  const selected = keyframes.find((keyframe) => keyframe.id === selectedId) ?? keyframes[0];
  const selectedIndex = keyframes.findIndex((keyframe) => keyframe.id === selected.id);
  const first = keyframes[0].time;
  const last = keyframes.at(-1)?.time ?? first;
  const span = Math.max(0, last - first);
  const resolved = resolveMaskEdgeAtTime(mask, previewTime);
  const overridden = hasEdgeOverride(selected);

  const set = (edge: MaskKeyframeEdgeOverride) => onEdgeChange(selected.id, edge);

  return (
    <div className="rounded border border-border bg-bg-1 p-2" data-testid="mask-keyframe-edges">
      <button
        type="button"
        aria-label={open ? "Collapse keyframe edges" : "Expand keyframe edges"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
        <Text type="supporting" color="primary" className="text-[9.5px] font-medium">
          Keyframe edges ({keyframes.length})
        </Text>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <MatteEdgePreview
            path={resolved.path}
            featherPx={resolved.feathering}
            expansionPx={resolved.expansion}
            opacity={resolved.opacity}
            baselineFeatherPx={mask.feathering}
            baselineExpansionPx={mask.expansion}
            caption={`${previewTime.toFixed(2)}s · feather ${resolved.feathering.toFixed(1)}px`}
            height={112}
          />

          {span > 0 && (
            <label className="block space-y-0.5">
              <Text type="supporting" color="secondary" className="text-[8.5px]">
                Scrub edge ({first.toFixed(2)}s – {last.toFixed(2)}s)
              </Text>
              <input
                type="range"
                aria-label="Scrub edge time"
                min={first}
                max={last}
                step={Math.max(0.001, span / 200)}
                value={previewTime}
                onChange={(event) => setPreviewTime(Number(event.target.value))}
                className="w-full accent-[color:var(--primary)]"
              />
            </label>
          )}

          <div className="flex flex-wrap gap-1">
            {keyframes.map((keyframe, index) => (
              <button
                key={keyframe.id}
                type="button"
                aria-label={`Select keyframe ${index + 1}`}
                aria-pressed={keyframe.id === selected.id}
                onClick={() => {
                  setSelectedId(keyframe.id);
                  setPreviewTime(keyframe.time);
                }}
                className={`rounded border px-1.5 py-0.5 text-[8.5px] tabular-nums ${
                  keyframe.id === selected.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-bg-2 text-fg-2 hover:border-primary/50"
                }`}
              >
                {keyframe.time.toFixed(2)}s{hasEdgeOverride(keyframe) ? " •" : ""}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-1">
            <NumberInput
              ariaLabel={`Keyframe ${selectedIndex + 1} feather px`}
              size="sm"
              value={Math.round(selected.feathering ?? mask.feathering)}
              min={0}
              max={100}
              step={1}
              onChange={(value) => set({ feathering: value })}
            />
            <NumberInput
              ariaLabel={`Keyframe ${selectedIndex + 1} expansion px`}
              size="sm"
              value={Math.round(selected.expansion ?? mask.expansion)}
              min={-100}
              max={100}
              step={1}
              onChange={(value) => set({ expansion: value })}
            />
            <NumberInput
              ariaLabel={`Keyframe ${selectedIndex + 1} opacity percent`}
              size="sm"
              value={Math.round((selected.opacity ?? mask.opacity) * 100)}
              min={0}
              max={100}
              step={5}
              onChange={(value) => set({ opacity: value / 100 })}
            />
            <button
              type="button"
              aria-label={`Reset keyframe ${selectedIndex + 1} edge`}
              title="Inherit the mask's own feather, expansion and opacity again"
              disabled={!overridden}
              onClick={() => set({ feathering: undefined, expansion: undefined, opacity: undefined })}
              className="rounded border border-border p-1 text-fg-3 enabled:hover:text-fg disabled:opacity-40"
            >
              <RotateCcw size={10} aria-hidden />
            </button>
          </div>
          <Text type="supporting" color="secondary" className="text-[8px] leading-tight">
            Feather · expansion · opacity for kf {selectedIndex + 1}
            {overridden ? "" : " (inherits the mask)"}. Values blend between keyframes; • marks a
            keyframe with its own override.
          </Text>
        </div>
      )}
    </div>
  );
};
