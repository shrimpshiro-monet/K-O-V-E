/**
 * Signature effects: named, renderer-backed shader looks a plan can request by
 * intent instead of by shader plumbing.
 *
 * `shader` is one effect type that only renders when `params.shaderId` names a
 * real effect shader. That shape fails silently — the effects engine resolves
 * no shader and draws nothing — and it is plumbing an LLM cannot be trusted to
 * remember (`vhs`? `paper-vhs`? `vhs-glitch`?). So every renderer-backed effect
 * shader gets a plan-facing name here, plus a default parameter set and an
 * intensity mapping, and a plan can write `{ type: "vhs", intensity: 0.8 }`.
 *
 * These are the effects a hand editor cannot rebuild with sliders: tape
 * emulation, ordered dithering, print screens, prism splits, edge glow. They
 * are mirrored (not imported) from
 * `packages/core/src/motion/shaders/effect-shaders.ts` because creation-schema
 * must not depend on @kove-advanced/core. `packages/agent` has a sync test that
 * asserts every `shaderId` below exists in core with matching param names and
 * ranges, so this table cannot rot.
 */

export interface SignatureEffectDef {
  /** Canonical plan effect type — what validation accepts. */
  readonly name: string;
  /** Human label, used in prompt blocks. */
  readonly label: string;
  /** Renderer shader id (`params.shaderId` after materialization). */
  readonly shaderId: string;
  /** What it does to the picture, in one line. */
  readonly feel: string;
  /** When a director should reach for it. */
  readonly useWhen: string;
  /** Renderer param defaults, applied before the intensity mapping. */
  readonly defaults: Readonly<Record<string, number | string>>;
  /**
   * Map a 0..1 intensity onto the shader's real params. Heavier intensity must
   * stay inside the shader's declared min/max — the sync test checks the range
   * endpoints.
   */
  readonly intensity: (intensity: number) => Record<string, number>;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const round = (value: number): number => Math.round(value);

export const SIGNATURE_EFFECT_DEFS: readonly SignatureEffectDef[] = [
  {
    name: "vhs",
    label: "VHS Tape",
    shaderId: "vhs",
    feel: "Camcorder tape: chroma bleed, rolling scanlines, horizontal jitter.",
    useWhen: "Nostalgia hooks, throwback compilations, a beat that should read as found footage.",
    defaults: { intensity: 0.75, scanlines: 0.4, jitter: 0.45 },
    intensity: (i) => ({ intensity: i, scanlines: i * 0.5, jitter: i * 0.6 }),
  },
  {
    name: "scanlines",
    label: "CRT Scanlines",
    shaderId: "scanlines",
    feel: "Raster lines crawling down the frame like a CRT.",
    useWhen: "Retro UI, arcade, early-internet or surveillance beats.",
    defaults: { density: 360, intensity: 0.3, speed: 0.2 },
    intensity: (i) => ({ intensity: i, density: round(200 + i * 600) }),
  },
  {
    name: "halftone",
    label: "Halftone Print",
    shaderId: "halftone",
    feel: "Print-screen dots: comic book, zine, newsprint.",
    useWhen: "Punchline frames, comic-cutaway jokes, a poster-style title card.",
    defaults: { dotSize: 8, angle: 15 },
    intensity: (i) => ({ dotSize: round(4 + i * 20) }),
  },
  {
    name: "dither",
    label: "Ordered Dither",
    shaderId: "dither",
    feel: "Bayer-ordered quantization — 8-bit console, risograph grain.",
    useWhen: "Glitch beats, lo-fi reveals, a frame that should look printed rather than filmed.",
    defaults: { levels: 4, scale: 1 },
    intensity: (i) => ({ levels: round(10 - i * 8), scale: 1 }),
  },
  {
    name: "posterize",
    label: "Posterize",
    shaderId: "posterize",
    feel: "Flattened colour bands — screen-print poster.",
    useWhen: "Graphic match cuts, hard style turns, a frame that should stop looking photographic.",
    defaults: { levels: 5, mix: 1 },
    intensity: (i) => ({ levels: round(12 - i * 9), mix: 1 }),
  },
  {
    name: "duotone",
    label: "Duotone",
    shaderId: "duotone",
    feel: "Two-colour remap with contrast boost — album-cover grade.",
    useWhen: "Moody chapter breaks, flashback frames, a colour signature for one section.",
    defaults: { shadowColor: "#11133f", highlightColor: "#ffca6b", mix: 0.9, contrast: 1.15 },
    intensity: (i) => ({ mix: clamp01(0.35 + i * 0.65), contrast: 1 + i * 0.5 }),
  },
  {
    name: "gradient-map",
    label: "Gradient Map",
    shaderId: "gradient-map",
    feel: "Luma remapped onto a dark-to-light colour ramp — thermal, false-colour.",
    useWhen: "Heat-check moments, night-vision reveals, a hard tonal flip on a drop.",
    defaults: { mix: 1 },
    intensity: (i) => ({ mix: clamp01(0.4 + i * 0.6) }),
  },
  {
    name: "prism",
    label: "Prism Split",
    shaderId: "prism",
    feel: "Channel offset along an angle — a heavier, animated sibling of chromatic aberration.",
    useWhen: "Impact frames, whip transitions, a hit that needs to feel optical rather than digital.",
    defaults: { amount: 8, angle: 0, mix: 1 },
    intensity: (i) => ({ amount: i * 22, angle: 0, mix: 1 }),
  },
  {
    name: "fisheye",
    label: "Fisheye",
    shaderId: "fisheye",
    feel: "Lens warp: barrel distortion out from the centre.",
    useWhen: "Action-cam inserts, skate/sport footage, comedy zooms into a face.",
    defaults: { strength: 0.55, radius: 0.8 },
    intensity: (i) => ({ strength: i * 0.9, radius: 0.8 }),
  },
  {
    name: "wave-warp",
    label: "Wave Warp",
    shaderId: "wave-warp",
    feel: "Animated liquid displacement — heat haze, underwater, wobble.",
    useWhen: "Dream sequences, drunk/comedic beats, a transition into memory.",
    defaults: { amplitude: 0.025, frequency: 5, speed: 1.5 },
    intensity: (i) => ({ amplitude: i * 0.08, frequency: 5, speed: 1.5 }),
  },
  {
    name: "edge-glow",
    label: "Edge Glow",
    shaderId: "edge-glow",
    feel: "Neon outline traced over every edge in the shot.",
    useWhen: "Neon/tech reveals, Tron-style titles, a silhouette beat that needs to read as a drawing.",
    defaults: { strength: 4, radius: 1.5, color: "#4de8ff" },
    intensity: (i) => ({ strength: i * 9, radius: 1.5 }),
  },
  {
    name: "speed-lines",
    label: "Speed Lines",
    shaderId: "speed-lines",
    feel: "Anime action lines bursting from the centre of the frame.",
    useWhen: "Impact moments, chases, a punchline reaction that needs the frame to explode.",
    defaults: { amount: 0.6, density: 48, speed: 2 },
    intensity: (i) => ({ amount: i, density: round(24 + i * 72), speed: 2 }),
  },
  {
    name: "glitch-blocks",
    label: "Glitch Blocks",
    shaderId: "glitch-blocks",
    feel: "Row-wise data corruption: shifted slices, RGB split, dropout flashes.",
    useWhen: "Hard transitions, freezing/rewinding a beat, a hard drive or signal-failure gag.",
    defaults: { amount: 0.5, blockSize: 24, rgbSplit: 0.5, speed: 3 },
    intensity: (i) => ({ amount: i, blockSize: round(56 - i * 44), rgbSplit: clamp01(0.3 + i * 0.6), speed: 3 }),
  },
  {
    name: "light-leak",
    label: "Light Leak",
    shaderId: "light-leak",
    feel: "A warm film-burn streak and bloom sweeping across the frame.",
    useWhen: "Scene changes, memory/romance beats, a reveal that should feel like exposed film.",
    defaults: { intensity: 0.5, warmth: 0.7, speed: 1 },
    intensity: (i) => ({ intensity: i, warmth: 0.7, speed: 1 }),
  },
  {
    name: "pixelate",
    label: "Pixelate",
    shaderId: "pixelate",
    feel: "Blocky low-resolution mosaic — censor gag or 8-bit reveal.",
    useWhen: "Blurred-out punchlines, countdown or censor beats, a hard degrade into a drop.",
    defaults: { size: 8 },
    intensity: (i) => ({ size: round(2 + i * 40) }),
  },
];

/** Canonical signature-effect names, in prompt order. */
export const SIGNATURE_EFFECT_NAMES: readonly string[] = SIGNATURE_EFFECT_DEFS.map(
  (def) => def.name,
);

const DEF_BY_NAME: ReadonlyMap<string, SignatureEffectDef> = new Map(
  SIGNATURE_EFFECT_DEFS.map((def) => [def.name, def]),
);

/**
 * Spellings that show up in prompts and LLM output. Mapped instead of rejected:
 * a plan that says "make it look like a VHS tape" should land on `vhs`.
 */
export const SIGNATURE_EFFECT_ALIASES: Readonly<Record<string, string>> = {
  "vhs-tape": "vhs",
  vhstape: "vhs",
  "vhs-glitch": "vhs",
  tape: "vhs",
  camcorder: "vhs",
  "home-video": "vhs",
  crt: "scanlines",
  scanline: "scanlines",
  "crt-scanlines": "scanlines",
  interlace: "scanlines",
  interlaced: "scanlines",
  "crt-lines": "scanlines",
  tv: "scanlines",
  comic: "halftone",
  "comic-book": "halftone",
  newsprint: "halftone",
  "dot-screen": "halftone",
  "print-halftone": "halftone",
  risograph: "dither",
  riso: "dither",
  "8-bit": "dither",
  "eight-bit": "dither",
  "retro-dither": "dither",
  bayer: "dither",
  poster: "posterize",
  posterized: "posterize",
  "flat-color": "posterize",
  "color-banding": "posterize",
  "two-tone": "duotone",
  "dual-tone": "duotone",
  twotone: "duotone",
  heatmap: "gradient-map",
  "heat-map": "gradient-map",
  thermal: "gradient-map",
  "false-color": "gradient-map",
  "thermal-camera": "gradient-map",
  "luminance-map": "gradient-map",
  "prism-split": "prism",
  prismsplit: "prism",
  "rgb-split": "prism",
  "lens-split": "prism",
  "channel-split": "prism",
  gopro: "fisheye",
  "go-pro": "fisheye",
  "action-cam": "fisheye",
  "wide-angle": "fisheye",
  "lens-warp": "fisheye",
  underwater: "wave-warp",
  "water-warp": "wave-warp",
  "heat-haze": "wave-warp",
  wobble: "wave-warp",
  wobblewarp: "wave-warp",
  liquid: "wave-warp",
  neon: "edge-glow",
  "neon-outline": "edge-glow",
  neonoutline: "edge-glow",
  tron: "edge-glow",
  "edge-neon": "edge-glow",
  speedlines: "speed-lines",
  "action-lines": "speed-lines",
  "impact-lines": "speed-lines",
  "manga-lines": "speed-lines",
  "anime-lines": "speed-lines",
  datamosh: "glitch-blocks",
  "data-mosh": "glitch-blocks",
  glitch: "glitch-blocks",
  "block-glitch": "glitch-blocks",
  corrupt: "glitch-blocks",
  "signal-failure": "glitch-blocks",
  "light-leak-transition": "light-leak",
  leak: "light-leak",
  "film-burn-leak": "light-leak",
  flare: "light-leak",
  "lens-flare": "light-leak",
  "sun-flare": "light-leak",
  "bokeh-leak": "light-leak",
  pixelated: "pixelate",
  pixelize: "pixelate",
  pixelized: "pixelate",
  "mosaic-pixel": "pixelate",
};

/**
 * Lookup key: lower-case, with spaces and underscores folded to hyphens so
 * "VHS tape", "vhs_tape" and "vhs-tape" all reach the same alias.
 */
function lookupKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/** Resolve a plan-facing effect name (or alias) to its definition. */
export function resolveSignatureEffect(raw: string | undefined | null): SignatureEffectDef | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const key = lookupKey(raw);
  if (!key) return undefined;
  const direct = DEF_BY_NAME.get(key);
  if (direct) return direct;
  const alias = SIGNATURE_EFFECT_ALIASES[key];
  return alias ? DEF_BY_NAME.get(alias) : undefined;
}

/** Canonical plan effect name for an alias, or undefined when unknown. */
export function resolveSignatureEffectName(raw: string | undefined | null): string | undefined {
  return resolveSignatureEffect(raw)?.name;
}

export function isSignatureEffectType(raw: string | undefined | null): boolean {
  return resolveSignatureEffect(raw) !== undefined;
}

/** Param names the underlying shader accepts. */
export function signatureEffectParamNames(def: SignatureEffectDef): readonly string[] {
  return Object.keys(def.defaults);
}

/**
 * Build the params object the effects engine will read: renderer defaults, then
 * the intensity mapping, then the plan's explicit overrides. Unknown override
 * keys are dropped — the engine ignores them anyway, and dropping keeps the
 * stored effect honest about what a signature effect can be tuned with.
 */
export function buildSignatureEffectParams(
  def: SignatureEffectDef,
  intensity: number | undefined,
  overrides: Record<string, unknown> | undefined,
): Record<string, number | string> {
  const params: Record<string, number | string> = { ...def.defaults };
  if (intensity !== undefined && Number.isFinite(intensity)) {
    Object.assign(params, def.intensity(clamp01(intensity)));
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in def.defaults)) continue;
      if (typeof value === "number" && Number.isFinite(value)) params[key] = value;
      else if (typeof value === "string") params[key] = value;
    }
  }
  return params;
}

/** One-line prompt catalogue entry, e.g. `vhs — VHS Tape (shaderId: vhs)`. */
export function formatSignatureEffectEntry(def: SignatureEffectDef): string {
  const params = Object.keys(def.defaults).join(", ");
  return `${def.name} — ${def.label} (shaderId: ${def.shaderId}; params: ${params}). ${def.feel} Use it when: ${def.useWhen}`;
}
