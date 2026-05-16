import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "var(--font-mono)",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        bg: "hsl(var(--color-bg) / <alpha-value>)",
        surface: {
          DEFAULT: "hsl(var(--color-surface) / <alpha-value>)",
          2: "hsl(var(--color-surface-2) / <alpha-value>)",
          3: "hsl(var(--color-surface-3) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "hsl(var(--color-fg) / <alpha-value>)",
          muted: "hsl(var(--color-fg-muted) / <alpha-value>)",
          subtle: "hsl(var(--color-fg-subtle) / <alpha-value>)",
          inverted: "hsl(var(--color-fg-inverted) / <alpha-value>)",
        },
        border: {
          DEFAULT: "hsl(var(--color-border) / <alpha-value>)",
          strong: "hsl(var(--color-border-strong) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "hsl(var(--color-primary) / <alpha-value>)",
          fg: "hsl(var(--color-primary-fg) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "hsl(var(--color-accent) / <alpha-value>)",
          soft: "hsl(var(--color-accent-soft) / <alpha-value>)",
          fg: "hsl(var(--color-accent-fg) / <alpha-value>)",
        },
        success: {
          DEFAULT: "hsl(var(--color-success) / <alpha-value>)",
          soft: "hsl(var(--color-success-soft) / <alpha-value>)",
          fg: "hsl(var(--color-success-fg) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "hsl(var(--color-warning) / <alpha-value>)",
          soft: "hsl(var(--color-warning-soft) / <alpha-value>)",
          fg: "hsl(var(--color-warning-fg) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "hsl(var(--color-danger) / <alpha-value>)",
          soft: "hsl(var(--color-danger-soft) / <alpha-value>)",
          fg: "hsl(var(--color-danger-fg) / <alpha-value>)",
        },
        info: {
          DEFAULT: "hsl(var(--color-info) / <alpha-value>)",
          soft: "hsl(var(--color-info-soft) / <alpha-value>)",
          fg: "hsl(var(--color-info-fg) / <alpha-value>)",
        },
        violet: {
          DEFAULT: "hsl(var(--color-violet) / <alpha-value>)",
          soft: "hsl(var(--color-violet-soft) / <alpha-value>)",
          fg: "hsl(var(--color-violet-fg) / <alpha-value>)",
        },
        ring: "hsl(var(--color-ring) / <alpha-value>)",
        overlay: "hsl(var(--color-overlay) / <alpha-value>)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        1: "var(--shadow-1)",
        2: "var(--shadow-2)",
      },
      transitionTimingFunction: {
        "swiss-out": "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
