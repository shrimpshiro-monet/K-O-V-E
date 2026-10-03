import React, { useMemo } from "react";
import { useAmbientBackdropStore } from "../../stores/backdrop-store";

const FLORAL_URL = `${import.meta.env.BASE_URL ?? "/"}backdrop/bloom.jpg`;

interface AmbientBackdropProps {
  className?: string;
}

/**
 * Monet ambient environment: three stacked layers pinned behind the app.
 *
 *  1. Mesh gradient wash built from the theme accents (animated transform, 80s).
 *  2. Blurred floral photograph, masked so it is strongest at the viewport
 *     edges and near-zero in the center third where the canvas lives.
 *  3. Film grain + vignette.
 *
 * Rendered once at the app root, `pointer-events: none`, z-index 0. Cost is
 * transform/opacity-only; "Off" removes the layer entirely (see backdrop-store).
 */
export const AmbientBackdrop: React.FC<AmbientBackdropProps> = ({ className }) => {
  const mode = useAmbientBackdropStore((s) => s.mode);

  const style = useMemo(
    () => ({ "--ambient-floral-url": `url("${FLORAL_URL}")` }) as React.CSSProperties,
    [],
  );

  if (mode === "off") {
    return (
      <div
        aria-hidden
        className="ambient-root"
        style={{ background: "var(--surface-0)" }}
      />
    );
  }

  return (
    <div
      aria-hidden
      data-ambient-mode={mode}
      className={`ambient-root${className ? ` ${className}` : ""}`}
      style={style}
    >
      <div className="ambient-layer ambient-mesh" />
      <div className="ambient-layer ambient-floral" />
      <div className="ambient-layer ambient-grain" />
      <div className="ambient-layer ambient-vignette" />
    </div>
  );
};

interface PetalsHintProps {
  className?: string;
  opacity?: number;
}

/**
 * The sharper (non-blurred) floral variant reserved for large empty
 * negative-space zones — a hint of petals, never a photo.
 */
export const PetalsHint: React.FC<PetalsHintProps> = ({
  className = "",
  opacity = 0.06,
}) => {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 bg-cover bg-center ${className}`}
      style={{
        backgroundImage: `url("${FLORAL_URL}")`,
        opacity,
        filter: "saturate(1.05)",
        maskImage: "radial-gradient(70% 70% at 50% 50%, black 0%, transparent 78%)",
        WebkitMaskImage: "radial-gradient(70% 70% at 50% 50%, black 0%, transparent 78%)",
      }}
    />
  );
};

export default AmbientBackdrop;
