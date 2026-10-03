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
        // ── Monet design tokens (tokens.css) ──────────────────────
        // Surfaces. --surface-1/2/3 are translucent glass values and are
        // only for glass wrappers; solid content surfaces must use
        // surface-solid / surface-sunken per the legibility rule.
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          solid: "var(--surface-solid)",
          sunken: "var(--surface-sunken)",
          raised: "var(--surface-raised)",
        },
        line: {
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border-default)",
          strong: "var(--border-strong)",
          glow: "var(--border-glow)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          disabled: "var(--text-disabled)",
        },
        // Floral secondaries — clip/asset category coding, accents.
        bloom: {
          rose: "var(--bloom-rose)",
          amber: "var(--bloom-amber)",
          lilac: "var(--bloom-lilac)",
          teal: "var(--bloom-teal)",
          peach: "var(--bloom-peach)",
          sage: "var(--bloom-sage)",
          sky: "var(--bloom-sky)",
        },
        semantic: {
          success: "var(--success)",
          warning: "var(--warning)",
          danger: "var(--danger)",
          info: "var(--info)",
        },
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

        // ── v2 editor tokens (now re-pointed at Monet palette) ──
        //   These read raw values via CSS variables. Opacity modifiers
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
        status: {
          success: "var(--success)",
          warning: "var(--warning)",
          error: "var(--danger)",
          info: "var(--info)",
        },
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        glass: "var(--shadow-glass)",
        raised: "var(--shadow-raised)",
        modal: "var(--shadow-modal)",
        canvas: "var(--shadow-canvas)",
        glow: "0 2px 8px var(--accent-glow)",
        "glow-lg": "0 4px 14px var(--accent-glow)",
        panel: "var(--shadow-md)",
      },
      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        full: "var(--radius-full)",
      },
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        base: "var(--duration-base)",
        slow: "var(--duration-slow)",
      },
      transitionTimingFunction: {
        "ease-out-soft": "var(--easing-out)",
        "ease-inout-soft": "var(--easing-inout)",
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
