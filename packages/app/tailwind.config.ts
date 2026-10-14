import type { Config } from "tailwindcss";

const colorVar = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  important: "html",
  theme: {
    extend: {
      colors: {
        background: colorVar("--color-background"),
        "background-secondary": colorVar("--color-background-secondary"),
        surface: colorVar("--color-surface"),
        "surface-hover": colorVar("--color-surface-hover"),
        foreground: colorVar("--color-foreground"),
        "foreground-secondary": colorVar("--color-foreground-secondary"),
        "foreground-muted": colorVar("--color-foreground-muted"),
        accent: colorVar("--color-accent"),
        "accent-dim": colorVar("--color-accent-dim"),
        danger: colorVar("--color-danger"),
        warning: colorVar("--color-warning"),
        success: colorVar("--color-success"),
        border: colorVar("--color-border"),
        "border-active": colorVar("--color-border-active"),
        "on-accent": colorVar("--color-on-accent"),
        primary: colorVar("--color-primary"),
        "on-primary": colorVar("--color-on-primary"),
        "border-outline": colorVar("--color-line-soft"),
        white: "#ffffff",
      },
      fontFamily: {
        display: ["Geist Mono", "ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
        sans: [
          "Geist",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: ["Geist Mono", "JetBrains Mono", "Offdesk Terminal Symbols", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
