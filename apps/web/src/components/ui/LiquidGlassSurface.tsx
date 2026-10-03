import React from "react";
import LiquidGlass from "liquid-glass-react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { useThemeStore } from "../../stores/theme-store";

/**
 * Monet's sanctioned wrapper around `liquid-glass-react` (Apple-style
 * refraction: edge bending, chromatic aberration, frost). Every glass
 * button in the chrome goes through this component so displacement/blur
 * tuning lives in one place — do not place <LiquidGlass> ad hoc.
 *
 * Rules baked in here:
 *  - `overLight` follows the theme store (the library dims its highlight
 *    on light backgrounds so contrast survives).
 *  - `prefers-reduced-motion` drops the elastic squash to 0 (glass stays,
 *    jiggle goes).
 *  - `disabled` renders a plain container — a button you can't press
 *    shouldn't invite you to press it.
 *
 * Children should render transparent/translucent backgrounds (tokens) so
 * the refraction reads; solid paint on the child hides the effect.
 */

export type LiquidGlassPreset = "chip" | "button" | "pill" | "island";

interface PresetSpec {
  displacementScale: number;
  blurAmount: number;
  saturation: number;
  aberrationIntensity: number;
  elasticity: number;
  cornerRadius: number;
}

const PRESETS: Record<LiquidGlassPreset, PresetSpec> = {
  // Small icon buttons / ⌘K-style triggers
  chip: {
    displacementScale: 28,
    blurAmount: 0.05,
    saturation: 125,
    aberrationIntensity: 1.1,
    elasticity: 0.16,
    cornerRadius: 10,
  },
  // Standard labelled buttons (Import, Add track, …)
  button: {
    displacementScale: 40,
    blurAmount: 0.07,
    saturation: 130,
    aberrationIntensity: 1.5,
    elasticity: 0.22,
    cornerRadius: 10,
  },
  // Fully-round controls (workspace mode tabs, Export split island)
  pill: {
    displacementScale: 36,
    blurAmount: 0.06,
    saturation: 132,
    aberrationIntensity: 1.6,
    elasticity: 0.26,
    cornerRadius: 999,
  },
  // Larger floating islands (tool clusters, transport bars)
  island: {
    displacementScale: 56,
    blurAmount: 0.09,
    saturation: 135,
    aberrationIntensity: 2,
    elasticity: 0.22,
    cornerRadius: 14,
  },
};

export interface LiquidGlassSurfaceProps {
  children: React.ReactNode;
  preset?: LiquidGlassPreset;
  className?: string;
  padding?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  /** Overrides the preset radius (px). */
  cornerRadius?: number;
  /** Renders a plain container instead of glass (disabled affordance). */
  disabled?: boolean;
}

export const LiquidGlassSurface: React.FC<LiquidGlassSurfaceProps> = ({
  children,
  preset = "button",
  className = "",
  padding,
  style,
  onClick,
  cornerRadius,
  disabled = false,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const isDark = useThemeStore((s) => s.isDark);
  const spec = PRESETS[preset];

  if (disabled) {
    return (
      <div className={`inline-flex items-stretch rounded-[10px] ${className}`} style={style} data-glass-disabled="true">
        {children}
      </div>
    );
  }

  return (
    <LiquidGlass
      className={className}
      padding={padding}
      style={style}
      onClick={onClick}
      overLight={!isDark}
      displacementScale={spec.displacementScale}
      blurAmount={spec.blurAmount}
      saturation={spec.saturation}
      aberrationIntensity={spec.aberrationIntensity}
      elasticity={reducedMotion ? 0 : spec.elasticity}
      cornerRadius={cornerRadius ?? spec.cornerRadius}
    >
      {children}
    </LiquidGlass>
  );
};

export default LiquidGlassSurface;
