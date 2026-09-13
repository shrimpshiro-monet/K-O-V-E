# K.O.V.E. — Design Language Files

These 5 files are the **complete design system**. Change them and every component in the app reshapes. All 191 UI components consume tokens from these files via Tailwind utilities and CSS variables.

---

## File 1: `apps/web/src/index.css` — Core Design Tokens

Controls: ALL colors, typography, shadows, spacing, layout constants for both light and dark themes. Every Tailwind utility (`bg-bg`, `text-fg-2`, `border-border`, `shadow-md`, etc.) reads from these variables.

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* ============================================================
   OpenReel Editor — v2 design tokens (cinematic dark, emerald)
   All values are CSS variables. Components use Tailwind utilities
   that map to these via tailwind.config.js.
   ============================================================ */
@layer base {
  :root {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
      system-ui, sans-serif;
    line-height: 1.5;
    font-weight: 400;
    letter-spacing: -0.005em;

    /* density */
    --d-text: 12.5px;
    --d-text-sm: 11px;

    /* timeline */
    --tl-height: 58vh;
    --tl-track: 56px;
    --tl-rail: 196px;

    /* layout */
    --media-w: 460px;
    --inspector-w: 360px;
    --topbar-h: 40px;
    --toolnav-h: 64px;

    color-scheme: dark;
  }

  /* light theme — Claude Design "Editor" mock (emerald brand accent, Inter) */
  :root,
  [data-theme="light"] {
    --bg: #f4f4f6;            /* window / app background */
    --bg-1: #ffffff;          /* cards & elevated surfaces */
    --bg-2: #f0f0f3;          /* recessed insets, pills, search fields */
    --bg-3: #ececed;          /* segmented-control track */
    --bg-elev: #ffffff;
    --border: #e7e7ea;        /* card / input borders */
    --border-strong: #d4d4d8;
    --fg: #1d1d1f;            /* primary text */
    --fg-2: #3a3a3c;          /* secondary text */
    --fg-3: #7c7c82;          /* tertiary / labels */
    --fg-muted: #9a9a9f;      /* muted / placeholder */
    --hover: #f0f0f3;
    --selected: #e6f9f1;      /* emerald-soft selected state */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
    --shadow-md: 0 6px 20px rgba(0, 0, 0, 0.08);
    --shadow-lg: 0 24px 60px rgba(0, 0, 0, 0.16);
    --track-bg: #f7f7f9;
    --tl-bg: #ffffff;
    --waveform: #8cc79a;
    /* preview stage: white so the area around the monitor matches the
       other white surfaces instead of a grey cinema stage */
    --stage-bg: #ffffff;
    --screen-bg: #ffffff;

    /* accent (brand emerald #10b981 — matches the OpenReel logo) */
    --accent: #10b981;
    --accent-strong: #059669;
    --accent-soft: #e6f9f1;
    --accent-fg: #ffffff;
    --accent-glow: rgba(16, 185, 129, 0.35);

    /* clip palette */
    --c-video: #6a9bd8;
    --c-text: #e8a44a;
    --c-audio: #8cc79a;
    --c-music: #14b8a6;
  }

  /* dark theme — cinematic, near-black like reference */
  [data-theme="dark"],
  .dark {
    --bg: oklch(0.12 0.005 240);
    --bg-1: oklch(0.16 0.006 240);
    --bg-2: oklch(0.2 0.007 240);
    --bg-3: oklch(0.24 0.008 240);
    --bg-elev: oklch(0.22 0.007 240);
    --border: oklch(0.26 0.008 240);
    --border-strong: oklch(0.34 0.01 240);
    --fg: oklch(0.97 0.003 240);
    --fg-2: oklch(0.78 0.008 240);
    --fg-3: oklch(0.6 0.012 240);
    --fg-muted: oklch(0.48 0.012 240);
    --hover: oklch(0.22 0.009 240);
    --selected: oklch(0.30 0.03 162);
    --shadow-sm: 0 1px 0 oklch(0 0 0 / 0.4), 0 1px 2px oklch(0 0 0 / 0.3);
    --shadow-md: 0 1px 0 oklch(0 0 0 / 0.5), 0 6px 24px oklch(0 0 0 / 0.4);
    --shadow-lg: 0 1px 0 oklch(0 0 0 / 0.6), 0 24px 60px oklch(0 0 0 / 0.5);
    --track-bg: oklch(0.12 0.006 240);
    --tl-bg: oklch(0.1 0.005 240);
    --waveform: oklch(0.78 0.16 162 / 0.85);
    --stage-bg: oklch(0.08 0.004 240);
    /* the preview "screen" itself (canvas + letterbox): black in dark */
    --screen-bg: oklch(0 0 0);

    /* accent (brand emerald — matches the OpenReel logo) */
    --accent: oklch(0.7 0.15 162);
    --accent-strong: oklch(0.63 0.16 162);
    --accent-soft: oklch(0.7 0.15 162 / 0.2);
    --accent-fg: oklch(0.99 0 0);
    --accent-glow: oklch(0.7 0.15 162 / 0.45);
  }

  [data-density="compact"] {
    --d-text: 12px;
    --d-text-sm: 10.5px;
    --tl-track: 46px;
    --tl-rail: 168px;
    --toolnav-h: 56px;
    --topbar-h: 36px;
  }

  /* Legacy shadcn/ui hsl tokens — kept so existing primitives
     (DropdownMenu, Tooltip, Dialog, etc.) keep working until they
     migrate to the new tokens. */
  :root,
  [data-theme="light"] {
    --background: 0 0% 100%;
    --foreground: 240 10% 4%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 4%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 4%;
    --primary: 160 84% 39%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 5% 96%;
    --secondary-foreground: 240 6% 10%;
    --muted: 240 5% 96%;
    --muted-foreground: 240 4% 46%;
    --accent-hsl: 240 5% 96%;
    --accent-foreground: 240 6% 10%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 98%;
    --input: 240 6% 90%;
    --ring: 160 84% 39%;
    --radius: 0.625rem;
  }

  [data-theme="dark"],
  .dark {
    --background: 220 12% 9%;
    --foreground: 0 0% 95%;
    --card: 220 10% 13%;
    --card-foreground: 0 0% 95%;
    --popover: 220 10% 13%;
    --popover-foreground: 0 0% 95%;
    --primary: 158 64% 52%;
    --primary-foreground: 0 0% 100%;
    --secondary: 220 8% 18%;
    --secondary-foreground: 0 0% 95%;
    --muted: 220 8% 18%;
    --muted-foreground: 220 8% 65%;
    --accent-hsl: 220 8% 22%;
    --accent-foreground: 0 0% 95%;
    --destructive: 0 62% 50%;
    --destructive-foreground: 0 0% 95%;
    --input: 220 8% 24%;
    --ring: 158 64% 52%;
  }

  html,
  body {
    margin: 0;
    padding: 0;
    height: 100%;
    overflow: hidden;
  }

  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: var(--d-text);
    color: var(--fg);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.005em;
  }

  button { cursor: pointer; }
}

/* ---------- helper utility classes (small, layout-only) ---------- */
.scrollbar-none {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}

/* ---------- scrollbar ---------- */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: 99px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--fg-muted);
  background-clip: padding-box;
  border: 3px solid transparent;
}

/* ---------- hover tooltip via [data-tip] ---------- */
[data-tip] { position: relative; }
[data-tip]:hover::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--fg);
  color: var(--bg-1);
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 10.5px;
  white-space: nowrap;
  z-index: 100;
  pointer-events: none;
  font-weight: 500;
}

/* Downward variant — for tools at a container's top edge where an upward
   tooltip would be clipped by the panel's overflow. */
[data-tip-bottom] { position: relative; }
[data-tip-bottom]:hover::after {
  content: attr(data-tip-bottom);
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--fg);
  color: var(--bg-1);
  padding: 3px 7px;
  border-radius: 4px;
  font-size: 10.5px;
  white-space: nowrap;
  z-index: 100;
  pointer-events: none;
  font-weight: 500;
}
```

### What each token controls

| Token group | Tokens | What changes |
|---|---|---|
| **Surfaces** | `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--bg-elev` | App background, card surfaces, recessed inputs, segmented tracks |
| **Text** | `--fg`, `--fg-2`, `--fg-3`, `--fg-muted` | All text color hierarchy |
| **Borders** | `--border`, `--border-strong` | Every panel, input, card border |
| **Accent** | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-fg`, `--accent-glow` | Buttons, links, active states, glows, selected highlights |
| **Timeline** | `--tl-bg`, `--track-bg`, `--tl-height`, `--tl-track`, `--tl-rail` | Timeline area, track rows, track sidebar width |
| **Stage** | `--stage-bg`, `--screen-bg` | Preview canvas area and the canvas itself |
| **Shadows** | `--shadow-sm/md/lg` | Elevation of all panels |
| **Clips** | `--c-video`, `--c-text`, `--c-audio`, `--c-music` | Timeline clip colors by type |
| **Waveform** | `--waveform` | Audio waveform color in timeline |
| **Shadcn compat** | `--background`, `--foreground`, `--primary`, `--secondary`, `--muted`, `--destructive`, `--input`, `--ring`, `--radius` | Legacy Radix primitives (Select, Dialog, DropdownMenu, Tooltip) |

---

## File 2: `apps/web/tailwind.config.js` — Token Bridge

Controls: How all CSS variables above map to Tailwind utility classes (`bg-bg`, `text-fg-2`, `border-border`, `shadow-glow`, `font-sans`, `rounded-lg`, etc.). Also defines the animation keyframes.

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ── v2 editor tokens (cinematic, emerald)
        //   These read raw oklch via CSS variables. Opacity modifiers
        //   are not supported on these — use the *-soft / *-glow
        //   companion tokens (or arbitrary values) when you need a tint.
        bg: {
          DEFAULT: "var(--bg)",
          1: "var(--bg-1)",
          2: "var(--bg-2)",
          3: "var(--bg-3)",
          elev: "var(--bg-elev)",
        },
        fg: {
          DEFAULT: "var(--fg)",
          2: "var(--fg-2)",
          3: "var(--fg-3)",
          muted: "var(--fg-muted)",
        },
        "border-strong": "var(--border-strong)",
        hover: "var(--hover)",
        selected: "var(--selected)",
        "stage-bg": "var(--stage-bg)",
        "tl-bg": "var(--tl-bg)",
        "track-bg": "var(--track-bg)",
        waveform: "var(--waveform)",
        accent: {
          DEFAULT: "var(--accent)",
          strong: "var(--accent-strong)",
          soft: "var(--accent-soft)",
          fg: "var(--accent-fg)",
          // shadcn primitives (Select/DropdownMenu/ContextMenu/Button) hover
          // with `bg-accent text-accent-foreground`; without this mapping the
          // text color resolved to nothing and disappeared on the emerald
          // hover background. Maps to the on-accent text token.
          foreground: "var(--accent-fg)",
          glow: "var(--accent-glow)",
        },
        clip: {
          video: "var(--c-video)",
          text: "var(--c-text)",
          audio: "var(--c-audio)",
          music: "var(--c-music)",
        },

        // ── shadcn / existing components (HSL with <alpha-value>) ──
        background: {
          DEFAULT: "hsl(var(--background))",
          secondary: "var(--bg-1)",
          tertiary: "var(--bg-2)",
          elevated: "var(--bg-elev)",
        },
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "var(--accent-strong)",
          active: "var(--accent-strong)",
          glow: "var(--accent-glow)",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: {
          DEFAULT: "var(--border)",
          hover: "var(--border-strong)",
          active: "var(--border-strong)",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        text: {
          primary: "var(--fg)",
          secondary: "var(--fg-2)",
          muted: "var(--fg-3)",
        },
        status: {
          success: "var(--accent)",
          warning: "#eab308",
          error: "#ef4444",
          info: "#3b82f6",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "monospace"],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        glow: "0 2px 8px var(--accent-glow)",
        "glow-lg": "0 4px 14px var(--accent-glow)",
        panel: "var(--shadow-md)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "0.75rem",
        "2xl": "1rem",
      },
      spacing: {
        topbar: "var(--topbar-h)",
        toolnav: "var(--toolnav-h)",
        "tl-track": "var(--tl-track)",
        "tl-rail": "var(--tl-rail)",
      },
      fontSize: {
        "2xs": ["10px", { lineHeight: "1.3" }],
        "xs+": ["10.5px", { lineHeight: "1.35" }],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
```

### Key mappings to know

| Tailwind class | Reads from | Controls |
|---|---|---|
| `bg-bg` | `--bg` | App background |
| `bg-bg-1` | `--bg-1` | Card/panel surface |
| `bg-bg-2` | `--bg-2` | Recessed inputs, pills |
| `text-fg` | `--fg` | Primary text |
| `text-fg-2` | `--fg-2` | Secondary text |
| `text-fg-3` | `--fg-3` | Muted labels |
| `border-border` | `--border` | All panel borders |
| `border-border-strong` | `--border-strong` | Stronger borders |
| `bg-accent` | `--accent` | Primary action buttons |
| `text-accent-fg` | `--accent-fg` | Text on accent |
| `shadow-glow` | `--accent-glow` | Accent glow shadow |
| `bg-clip-video` | `--c-video` | Video clips |
| `bg-clip-audio` | `--c-audio` | Audio clips |
| `bg-clip-text` | `--c-text` | Text clips |
| `bg-clip-music` | `--c-music` | Music clips |
| `rounded-lg` | `--radius` | Panel border radius |
| `font-sans` | Inter stack | Body font |
| `font-mono` | Geist Mono | Code/monospace |

---

## File 3: `apps/web/src/components/astryx/kove-advanced-astryx-theme.css` — Astryx Override

Controls: The Astryx component library's accent color and fonts. Astryx provides ~90 branded components (Button, Card, Dialog, etc.) that use its own token system. This file overrides the default blue accent with the K.O.V.E. emerald.

```css
/* OpenReel brand overrides layered after the prebuilt Astryx Neutral theme. */
[data-astryx-theme="neutral"] {
  --color-accent: light-dark(#10b981, #34d399);
  --color-accent-muted: light-dark(#e6f9f1, #064e3b);
  --color-text-accent: light-dark(#059669, #6ee7b7);
  --color-icon-accent: light-dark(#059669, #6ee7b7);
  --color-on-accent: #ffffff;
  --font-family-body: "Inter", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
  --font-family-heading: "Inter", -apple-system, BlinkMacSystemFont, system-ui,
    sans-serif;
}
```

---

## File 4: `apps/web/src/desktop/theme/desktop-theme.css` — Desktop App Theme

Controls: The Electron desktop variant. Slightly different surface colors (charcoal hue 250 vs web's hue 240) but same emerald accent. Scoped under `.openreel-desktop`.

```css
/* ============================================================
   OpenReel Desktop — DaVinci-Resolve-style charcoal/emerald tokens
   Scoped under .openreel-desktop. Overrides the same CSS variable
   names index.css defines so desktop components reuse the existing
   Tailwind utilities and inherit the Resolve look.
   Surfaces: charcoal-neutral (hue ~250, low chroma).
   Accent: emerald (hue ~162).
   ============================================================ */
.openreel-desktop {
  color-scheme: dark;

  --bg: oklch(0.16 0.004 250);
  --bg-1: oklch(0.185 0.004 250);
  --bg-2: oklch(0.21 0.004 250);
  --bg-3: oklch(0.25 0.004 250);
  --bg-elev: oklch(0.235 0.004 250);
  --border: oklch(0.3 0.004 250);
  --border-strong: oklch(0.38 0.005 250);

  --fg: oklch(0.93 0.004 250);
  --fg-2: oklch(0.72 0.006 250);
  --fg-3: oklch(0.58 0.006 250);
  --fg-muted: oklch(0.46 0.006 250);

  --hover: oklch(0.27 0.004 250);
  --selected: oklch(0.3 0.03 162);

  --accent: oklch(0.7 0.15 162);
  --accent-strong: oklch(0.63 0.16 162);
  --accent-soft: oklch(0.3 0.05 162);
  --accent-fg: oklch(0.16 0.004 250);
  --accent-glow: oklch(0.7 0.15 162 / 0.35);

  --track-bg: oklch(0.2 0.004 250);
  --tl-bg: oklch(0.15 0.004 250);
  --waveform: oklch(0.7 0.15 162 / 0.55);
  --stage-bg: oklch(0.12 0.003 250);
  --screen-bg: oklch(0 0 0);

  --shadow-sm: 0 1px 0 oklch(0 0 0 / 0.4), 0 1px 2px oklch(0 0 0 / 0.3);
  --shadow-md: 0 1px 0 oklch(0 0 0 / 0.5), 0 6px 24px oklch(0 0 0 / 0.4);
  --shadow-lg: 0 1px 0 oklch(0 0 0 / 0.6), 0 24px 60px oklch(0 0 0 / 0.5);

  --c-video: oklch(0.6 0.11 200);
  --c-text: oklch(0.78 0.13 80);
  --c-audio: oklch(0.7 0.1 195);
  --c-music: oklch(0.7 0.14 295);

  --background: 220 8% 10%;
  --foreground: 0 0% 93%;
  --card: 220 7% 14%;
  --card-foreground: 0 0% 93%;
  --popover: 220 7% 14%;
  --popover-foreground: 0 0% 93%;
  --primary: 158 64% 52%;
  --primary-foreground: 220 8% 10%;
  --secondary: 220 6% 19%;
  --secondary-foreground: 0 0% 93%;
  --muted: 220 6% 19%;
  --muted-foreground: 220 6% 64%;
  --accent-hsl: 220 6% 23%;
  --accent-foreground: 0 0% 93%;
  --destructive: 0 62% 50%;
  --destructive-foreground: 0 0% 95%;
  --input: 220 6% 25%;
  --ring: 158 64% 52%;
}
```

---

## File 5: `packages/ui/src/styles/globals.css` — Shared UI Primitives

Controls: The Radix-based shared component library's tokens. These are used by `@kove-advanced/ui` components (Button, Card, Dialog, Tabs, etc.) across both web and desktop.

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: 142 71% 45%;
    --primary-foreground: 0 0% 0%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 142 71% 45%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 240 6% 6%;
    --foreground: 0 0% 95%;
    --card: 240 6% 10%;
    --card-foreground: 0 0% 95%;
    --popover: 240 6% 10%;
    --popover-foreground: 0 0% 95%;
    --primary: 142 71% 45%;
    --primary-foreground: 0 0% 0%;
    --secondary: 240 4% 16%;
    --secondary-foreground: 0 0% 95%;
    --muted: 240 4% 16%;
    --muted-foreground: 240 5% 65%;
    --accent: 240 4% 16%;
    --accent-foreground: 0 0% 95%;
    --destructive: 0 62% 50%;
    --destructive-foreground: 0 0% 95%;
    --border: 240 4% 20%;
    --input: 240 4% 20%;
    --ring: 142 71% 45%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

---

## Quick Reference: What to change for each design goal

| If you want to... | Change in |
|---|---|
| **New accent color** | File 1 (both themes), File 3, File 4 |
| **New font** | File 1 (`font-family`), File 2 (`fontFamily.sans`), File 3 (`--font-family-*`) |
| **Darker/lighter surfaces** | File 1 (`--bg`, `--bg-1` through `--bg-3`, `--bg-elev`) |
| **More/less contrast** | File 1 (`--fg` vs `--bg`, `--border` vs `--bg-1`) |
| **Different border radius** | File 2 (`borderRadius.lg/md/sm`) and/or File 1 (`--radius`) |
| **Different shadows** | File 1 (`--shadow-sm/md/lg`) |
| **Timeline look** | File 1 (`--tl-bg`, `--track-bg`, `--tl-height`, `--tl-track`, `--tl-rail`, `--c-*`, `--waveform`) |
| **Preview stage look** | File 1 (`--stage-bg`, `--screen-bg`) |
| **Desktop variant** | File 4 (all tokens under `.openreel-desktop`) |
| **Shared UI components** | File 5 (Radix primitives tokens) |
| **Legacy shadcn compat** | File 1 (bottom HSL section) |
| **Layout dimensions** | File 1 (`--media-w`, `--inspector-w`, `--topbar-h`, `--toolnav-h`) |
