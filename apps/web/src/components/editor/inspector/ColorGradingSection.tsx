import { frameToSeconds } from "@kove-advanced/core/mirror/timebase";
import React, { useCallback, useMemo } from "react";
import { ToolcraftButton as Button } from "@kove-advanced/ui";
import { ToolcraftCard as Card } from "@kove-advanced/ui";
import { ToolcraftClickableCard as ClickableCard } from "@kove-advanced/ui";
import { ToolcraftIconButton as IconButton } from "@kove-advanced/ui";
import { ToolcraftText as Text } from "@kove-advanced/ui";
import { PropertySlider } from "./shell/PropertySlider";
import { ChevronDown, RotateCcw, Sun, Thermometer } from "@/icons/lucide-compat";
import { useProjectStore } from "../../../stores/project-store";
import type {
  ColorWheelValues,
  HSLValues,
  CurvesValues,
  LUTData,
} from "@kove-advanced/core";
import {
  DEFAULT_COLOR_WHEELS,
  DEFAULT_HSL,
  DEFAULT_CURVES,
} from "@kove-advanced/core";
import { ColorWheelsControl } from "./ColorWheelsControl";
import { CurvesEditor } from "./CurvesEditor";
import { LUTLoader } from "./LUTLoader";
import { createReinhardLut } from "@kove-advanced/core/color/reinhard-transfer";
import type { ReferenceProfile } from "@kove-advanced/core/mirror/reference-profile";
import { sampleVideoStats } from "../../../services/mirror/extract-reference";
import { getLiveEditorHost, runExclusive } from "../../../services/agent/host-singleton";
import { executeTool } from "@kove-advanced/agent";
import { toast } from "../../../stores/notification-store";
import { HSLControls } from "./HSLControls";

const WHITE_BALANCE_PRESETS: Array<{
  label: string;
  temperature: number;
  tint: number;
}> = [
  { label: "Tungsten", temperature: -40, tint: 8 },
  { label: "Fluorescent", temperature: -15, tint: -10 },
  { label: "Daylight", temperature: 0, tint: 0 },
  { label: "Cloudy", temperature: 15, tint: 0 },
  { label: "Shade", temperature: 30, tint: 5 },
];

const SubSection: React.FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, children }) => {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  return (
    <Card variant="muted" padding={0} className="overflow-hidden border border-border">
      <Button
        label={title}
        icon={
          <ChevronDown
            size={12}
            className={`transition-transform ${
              isOpen ? "" : "-rotate-90"
            } text-fg-3`}
          />
        }
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full p-2 bg-bg-2 hover:bg-bg-2/80 transition-colors"
      />
      {isOpen && <div className="p-3 space-y-3">{children}</div>}
    </Card>
  );
};

interface ColorGradingSectionProps {
  clipId: string;
}

export const ColorGradingSection: React.FC<ColorGradingSectionProps> = ({
  clipId,
}) => {
  const { getColorGrading, updateColorGrading, resetColorGrading } =
    useProjectStore();

  const [matching, setMatching] = React.useState(false);
  const modifiedAt = useProjectStore((state) => state.project.modifiedAt);

  const colorGrading = useMemo(
    () => getColorGrading(clipId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clipId, getColorGrading, modifiedAt],
  );

  const colorWheelValues: ColorWheelValues = useMemo(() => {
    return colorGrading.colorWheels || { ...DEFAULT_COLOR_WHEELS };
  }, [colorGrading.colorWheels]);

  const hslValues: HSLValues = useMemo(() => {
    return colorGrading.hsl || { ...DEFAULT_HSL };
  }, [colorGrading.hsl]);

  const curvesValues: CurvesValues = useMemo(() => {
    return colorGrading.curves || { ...DEFAULT_CURVES };
  }, [colorGrading.curves]);

  const temperatureValue = colorGrading.temperature ?? 0;
  const tintValue = colorGrading.tint ?? 0;

  const handleTemperatureChange = useCallback(
    (value: number) => {
      updateColorGrading(clipId, { temperature: value });
    },
    [clipId, updateColorGrading],
  );

  const handleTintChange = useCallback(
    (value: number) => {
      updateColorGrading(clipId, { tint: value });
    },
    [clipId, updateColorGrading],
  );

  const handleWhiteBalanceReset = useCallback(() => {
    updateColorGrading(clipId, { temperature: 0, tint: 0 });
  }, [clipId, updateColorGrading]);

  const handleWhiteBalancePreset = useCallback(
    (preset: { temperature: number; tint: number }) => {
      updateColorGrading(clipId, {
        temperature: preset.temperature,
        tint: preset.tint,
      });
    },
    [clipId, updateColorGrading],
  );

  const handleColorWheelsChange = useCallback(
    (values: ColorWheelValues) => {
      updateColorGrading(clipId, { colorWheels: values });
    },
    [clipId, updateColorGrading],
  );

  const handleColorWheelsReset = useCallback(() => {
    updateColorGrading(clipId, { colorWheels: { ...DEFAULT_COLOR_WHEELS } });
  }, [clipId, updateColorGrading]);

  const handleCurvesChange = useCallback(
    (values: CurvesValues) => {
      updateColorGrading(clipId, { curves: values });
    },
    [clipId, updateColorGrading],
  );

  const handleCurvesReset = useCallback(() => {
    updateColorGrading(clipId, { curves: { ...DEFAULT_CURVES } });
  }, [clipId, updateColorGrading]);

  const handleLUTChange = useCallback(
    (lutData: LUTData | null) => {
      updateColorGrading(clipId, { lut: lutData || undefined });
    },
    [clipId, updateColorGrading],
  );

  const handleHSLValuesChange = useCallback(
    (values: HSLValues) => {
      updateColorGrading(clipId, { hsl: values });
    },
    [clipId, updateColorGrading],
  );

  const handleHSLReset = useCallback(() => {
    updateColorGrading(clipId, { hsl: { ...DEFAULT_HSL } });
  }, [clipId, updateColorGrading]);

  const handleResetAll = useCallback(() => {
    resetColorGrading(clipId);
  }, [clipId, resetColorGrading]);

  const matchReference = async () => {
    setMatching(true);
    try {
      const project = useProjectStore.getState().project;
      let raw: string | null = null;
      try { raw = sessionStorage.getItem("kove.mirror.profile"); } catch { /* project DNA remains available */ }
      if (!project.mirrorProfile && !raw) throw new Error("Extract a reference in AI Tools first.");
      const profile = project.mirrorProfile ?? JSON.parse(raw!) as ReferenceProfile;
      const clip = project.timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
      const media = project.mediaLibrary.items.find((item) => item.id === clip?.mediaId);
      const blob = media?.blob ?? await media?.fileHandle?.getFile();
      if (!clip || !blob) throw new Error("Selected clip's source media is unavailable locally.");
      if (profile.version !== "kove.mirror.v2") throw new Error("Legacy EditDNA needs an explicit FPS selection before grading.");
      const origin = profile.shots[0]?.startFrame ?? 0;
      const shot = profile.shots.find((item) => clip.startTime >= frameToSeconds(item.startFrame - origin, profile.fps) && clip.startTime < frameToSeconds(item.endFrame - origin, profile.fps));
      if (!shot?.colorStats) throw new Error("No measured reference color for this shot.");
      const target = await sampleVideoStats(blob, clip.inPoint + Math.min(0.25, clip.duration / 2));
      const result = await runExclusive(() => executeTool("set_color_grading", {
        clipId, colorGrading: { ...clip.colorGrading, lut: createReinhardLut(shot.colorStats!, target) },
      }, getLiveEditorHost()));
      if (!result.ok) throw new Error(result.error?.message ?? result.summary);
      toast.success("Reference shot matched", "Applied measured Lab grade as an editable clip LUT.");
    } catch (error) { toast.error("Match Reference Shot", error instanceof Error ? error.message : "Unknown error"); }
    finally { setMatching(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        <Button label={matching ? "Matching…" : "Match Reference Shot"} disabled={matching} variant="ghost" size="sm" onClick={() => { void matchReference(); }} />
        <Button
          label="Reset All"
          icon={<RotateCcw size={10} />}
          variant="ghost"
          size="sm"
          onClick={handleResetAll}
          className="flex items-center gap-1 px-2 py-1 text-[10px] text-fg-3 hover:text-fg transition-colors"
        />
      </div>

      <SubSection title="White Balance" defaultOpen>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-2">
            <Text type="supporting" color="secondary" className="text-[10px] leading-snug">
              Warm up cool shots or cool down warm ones. Tint corrects green or
              magenta casts.
            </Text>
            <IconButton
              label="Reset white balance"
              icon={<RotateCcw size={10} />}
              variant="ghost"
              size="sm"
              onClick={handleWhiteBalanceReset}
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-fg-3 hover:text-fg transition-colors shrink-0"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Thermometer size={12} className="text-fg-3" />
              <PropertySlider
                label="Temperature"
                value={temperatureValue}
                onChange={handleTemperatureChange}
                min={-100}
                max={100}
                step={1}
                className="flex-1"
                formatValue={(value) =>
                  `${value > 0 ? "+" : ""}${Math.round(value)}`
                }
              />
            </div>
            <div
              className="h-1 rounded-full pointer-events-none mx-5"
              style={{
                background:
                  "linear-gradient(to right, #4aa8ff 0%, #cccccc 50%, #ff9a3c 100%)",
                opacity: 0.7,
              }}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Sun size={12} className="text-fg-3" />
              <PropertySlider
                label="Tint"
                value={tintValue}
                onChange={handleTintChange}
                min={-100}
                max={100}
                step={1}
                className="flex-1"
                formatValue={(value) =>
                  `${value > 0 ? "+" : ""}${Math.round(value)}`
                }
              />
            </div>
            <div
              className="h-1 rounded-full pointer-events-none mx-5"
              style={{
                background:
                  "linear-gradient(to right, #4ad17f 0%, #cccccc 50%, #d44ad1 100%)",
                opacity: 0.7,
              }}
            />
          </div>

          <div className="pt-1">
            <Text type="supporting" color="secondary" className="mb-1.5 block text-[10px]">
              Presets
            </Text>
            <div className="grid grid-cols-5 gap-1">
              {WHITE_BALANCE_PRESETS.map((preset) => {
                const isActive =
                  Math.abs(preset.temperature - temperatureValue) < 0.5 &&
                  Math.abs(preset.tint - tintValue) < 0.5;
                return (
                  <ClickableCard
                    key={preset.label}
                    label={`Apply ${preset.label} white balance`}
                    onClick={() => handleWhiteBalancePreset(preset)}
                    className={`py-1 rounded text-[9px] transition-colors ${
                      isActive
                        ? "bg-primary text-white"
                        : "bg-bg-2 border border-border text-fg-2 hover:text-fg"
                    }`}
                  >
                    {preset.label}
                  </ClickableCard>
                );
              })}
            </div>
          </div>
        </div>
      </SubSection>

      <SubSection title="Color Wheels" defaultOpen={false}>
        <ColorWheelsControl
          values={colorWheelValues}
          onChange={handleColorWheelsChange}
          onReset={handleColorWheelsReset}
        />
      </SubSection>

      <SubSection title="Curves">
        <CurvesEditor
          values={curvesValues}
          onChange={handleCurvesChange}
          onReset={handleCurvesReset}
        />
      </SubSection>

      <SubSection title="LUT">
        <LUTLoader
          lutData={colorGrading.lut as LUTData | null}
          onChange={handleLUTChange}
        />
      </SubSection>

      <SubSection title="HSL">
        <HSLControls
          values={hslValues}
          onChange={handleHSLValuesChange}
          onReset={handleHSLReset}
        />
      </SubSection>
    </div>
  );
};

export default ColorGradingSection;
